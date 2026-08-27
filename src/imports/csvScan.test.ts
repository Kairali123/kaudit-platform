import { test } from 'node:test'
import assert from 'node:assert/strict'
import { scanUsageCsv } from './csv.ts'
import {
  prevalidateUsageRows,
  usageProviderCostClaims,
} from '../adapters/mysqlCycleImport.ts'
import { UsageImportValidationError } from './types.ts'

const HEADER =
  'Task ID,Destination Number,Call Start Time,Call Connected Time,' +
  'Call End Time,Duration (Seconds) With Ringing,' +
  'Duration (Seconds) Without Ringing,' +
  'Duration (Minutes) - Actual Billing Mins,Actual Billing Amount,' +
  'Recording URL'

const csvRow = (
  taskId: string,
  overrides: Partial<Record<number, string>> = {},
): string => {
  const cells = [
    taskId,
    '+910000000000',
    '2026-06-01 10:00:00',
    '2026-06-01 10:00:04',
    '2026-06-01 10:00:34',
    '34',
    '30',
    '0.5',
    '4.75',
    '',
  ]
  for (const [position, value] of Object.entries(overrides)) {
    cells[Number(position)] = value as string
  }
  return cells.join(',')
}

const ALLOWED_HOSTS = ['s3.example.test']

test('scan collects every invalid row instead of failing at the first one', () => {
  const csv = [
    HEADER,
    csvRow('task-ok'),
    csvRow('', { 0: '' }),
    csvRow('task-bad-duration', { 5: 'nonsense' }),
    csvRow('task-bad-amount', { 8: '-1.5' }),
    csvRow('task-ok-two'),
  ].join('\n')
  const { issues } = scanUsageCsv(Buffer.from(csv))
  assert.deepEqual(issues, [
    { rowIndex: 1, field: 'taskId', code: 'TASK_ID_REQUIRED' },
    { rowIndex: 2, field: 'durationWithRingingSec', code: 'DURATION_INVALID' },
    { rowIndex: 3, field: 'billedAmount', code: 'AMOUNT_INVALID' },
  ])
})

test('a duplicate Task ID inside a batch flags the repeat, not the first', () => {
  const csv = [
    HEADER,
    csvRow('task-dup'),
    csvRow('task-other'),
    csvRow('task-dup'),
  ].join('\n')
  const { issues } = scanUsageCsv(Buffer.from(csv))
  assert.deepEqual(issues, [
    { rowIndex: 2, field: 'taskId', code: 'TASK_ID_DUPLICATE' },
  ])
})

test('prevalidation rejects the batch atomically with bounded descriptors', () => {
  const csv = [
    HEADER,
    csvRow('task-good'),
    csvRow('task-bad-url', { 9: 'https://blocked.example.test/x.ogg' }),
    csvRow('task-bad-time', { 4: 'whenever' }),
  ].join('\n')
  try {
    prevalidateUsageRows(Buffer.from(csv), ALLOWED_HOSTS)
    assert.fail('expected refusal')
  } catch (error) {
    assert.ok(error instanceof UsageImportValidationError)
    assert.deepEqual(error.issues, [
      {
        rowIndex: 1,
        field: 'recordingUrl',
        code: 'RECORDING_URL_INVALID',
      },
      { rowIndex: 2, field: 'callEndTime', code: 'DATETIME_INVALID' },
    ])
    // The response carries descriptors only — never a cell value.
    const serialized = JSON.stringify(error.issues)
    assert.ok(!serialized.includes('blocked.example.test'))
    assert.ok(!serialized.includes('whenever'))
  }
})

test('prevalidation rejects impossible calendar datetimes before preservation', () => {
  const csv = [
    HEADER,
    csvRow('task-bad-calendar', { 2: '2026-02-31 10:00:00' }),
  ].join('\n')
  assert.throws(
    () => prevalidateUsageRows(Buffer.from(csv), ALLOWED_HOSTS),
    (error: unknown) =>
      error instanceof UsageImportValidationError &&
      error.issues[0]?.field === 'callStartTime' &&
      error.issues[0]?.code === 'DATETIME_INVALID',
  )
})

test('a fully valid batch passes prevalidation unchanged', () => {
  const csv = [HEADER, csvRow('task-one'), csvRow('task-two')].join('\n')
  const rows = prevalidateUsageRows(Buffer.from(csv), ALLOWED_HOSTS)
  assert.equal(rows.length, 2)
  assert.equal(rows[0].taskId, 'task-one')
})

test('blank recording URLs stay valid and are reported as missing, not invalid', () => {
  const csv = [HEADER, csvRow('task-no-recording')].join('\n')
  const rows = prevalidateUsageRows(Buffer.from(csv), ALLOWED_HOSTS)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].recordingUrl, null)
})
