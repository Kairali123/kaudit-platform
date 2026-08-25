import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Pool, PoolConnection } from 'mysql2/promise'
import {
  createMysqlCycleImportService,
  USAGE_IMPORT_WRITE_BATCH_SIZE,
  usageProviderCostClaims,
} from './mysqlCycleImport.ts'

const HEADERS = [
  'Task ID',
  'Destination Number',
  'Call Start Time',
  'Call Connected Time',
  'Call End Time',
  'Duration (Seconds) With Ringing',
  'Duration (Seconds) Without Ringing',
  'Duration (Minutes) - Actual Billing Mins',
  'Actual Billing Amount',
  'Recording URL',
].join(',')

function usageCsv(rowCount: number): Buffer {
  const rows = Array.from({ length: rowCount }, (_, index) => [
    `synthetic-task-${index}`,
    '0000000000',
    '2026-06-01 10:00:00',
    '2026-06-01 10:00:01',
    '2026-06-01 10:01:00',
    '60',
    '59',
    '1',
    '1.00000000',
    `https://recordings.example.test/synthetic-${index}.ogg`,
  ].join(','))
  return Buffer.from([HEADERS, ...rows].join('\n'))
}

test('usage imports write canonical tables in bounded 500-row bulk statements', async () => {
  const statements: Array<{ sql: string; values: unknown[] }> = []
  let committed = 0
  const connection = {
    async beginTransaction() {},
    async commit() { committed += 1 },
    async rollback() { assert.fail('successful import must not roll back') },
    release() {},
    async execute(sql: string, values: unknown[] = []) {
      statements.push({ sql, values })
      if (sql.includes('FROM kaudit_source_envelope')) return [[], []]
      if (sql.includes('FROM kaudit_call_external_reference')) return [[], []]
      return [{ affectedRows: 1 }, []]
    },
  } as unknown as PoolConnection
  const pool = {
    async execute() {
      return [[{ id: 'source-synthetic', vendor_account_id: 'vendor-synthetic' }], []]
    },
    async getConnection() { return connection },
  } as unknown as Pool
  const service = createMysqlCycleImportService(pool, {
    objectStore: {
      storageBoundary: 'synthetic-store',
      async preserve() {
        return {
          objectBucket: 'synthetic-bucket',
          objectKey: 'synthetic-key',
          sha256: 'a'.repeat(64),
        }
      },
    },
    sourceConnectionId: 'source-synthetic',
    allowedRecordingHosts: ['recordings.example.test'],
  })

  const result = await service.importUsage({
    bytes: usageCsv(1_001),
    filename: 'synthetic-usage.csv',
    periodStart: '2026-06-01',
    periodEnd: '2026-06-30',
    correlationId: 'synthetic-correlation',
  })

  assert.equal(USAGE_IMPORT_WRITE_BATCH_SIZE, 500)
  assert.equal(result.accepted, 1_001)
  assert.equal(result.auditJobsQueued, 1_001)
  assert.equal(committed, 1)
  assert.equal(statements.length, 27)

  const duplicateReads = statements.filter((item) =>
    item.sql.includes('FROM kaudit_call_external_reference'))
  assert.deepEqual(duplicateReads.map((item) => item.values.length), [500, 500, 1])

  for (const table of [
    'kaudit_call\n',
    'kaudit_call_external_reference',
    'kaudit_call_leg',
    'kaudit_provider_cost',
    'kaudit_call_artifact',
    'kaudit_outbox_message',
  ]) {
    assert.equal(
      statements.filter((item) => item.sql.includes(`INSERT INTO ${table}`)).length,
      3,
      table,
    )
  }
})

test('normalizes the vendor billed amount as a distinct fixed-precision claim', () => {
  const claims = usageProviderCostClaims({
    taskId: 'synthetic-task',
    destinationNumber: '+910000000000',
    callStartTime: '2026-06-01 10:00:00',
    callConnectedTime: '2026-06-01 10:00:04',
    callEndTime: '2026-06-01 10:00:34',
    durationWithRingingSec: '34',
    durationWithoutRingingSec: '30',
    durationMinutes: '0.5',
    billedAmount: '4.75000000',
    recordingUrl: null,
  })

  assert.deepEqual(claims.at(-1), {
    providerSku: 'vendor_asserted_billed_amount',
    quantity: '4.75000000',
    quantityUnit: 'currency',
    minutes: null,
  })
})

test('does not create a vendor amount claim for a blank amount', () => {
  const claims = usageProviderCostClaims({
    taskId: 'synthetic-task',
    destinationNumber: '+910000000000',
    callStartTime: '2026-06-01 10:00:00',
    callConnectedTime: '2026-06-01 10:00:04',
    callEndTime: '2026-06-01 10:00:34',
    durationWithRingingSec: '34',
    durationWithoutRingingSec: '30',
    durationMinutes: '0.5',
    billedAmount: null,
    recordingUrl: null,
  })

  assert.equal(
    claims.some(
      (claim) => claim.providerSku === 'vendor_asserted_billed_amount',
    ),
    false,
  )
})
