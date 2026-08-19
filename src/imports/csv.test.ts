import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseUsageCsv, UsageCsvError } from './csv.ts'

const header =
  'Task ID,Destination Number,Call Start Time,Call Connected Time,Call End Time,Duration (Seconds) With Ringing,Duration (Seconds) Without Ringing,Duration (Minutes) - Actual Billing Mins,Actual Billing Amount,Recording URL'

test('parses the locked KServe usage contract with an optional recording URL', () => {
  const rows = parseUsageCsv(
    Buffer.from(
      `${header}\nsynthetic-task,+910000000000,2026-06-01 10:00:00,2026-06-01 10:00:04,2026-06-01 10:00:34,34,30,0.5,4.75000000,https://recordings.example.test/synthetic.ogg`,
    ),
  )
  assert.equal(rows.length, 1)
  assert.equal(rows[0]?.taskId, 'synthetic-task')
  assert.equal(rows[0]?.durationMinutes, '0.5')
  assert.equal(rows[0]?.billedAmount, '4.75000000')
  assert.equal(rows[0]?.recordingUrl, 'https://recordings.example.test/synthetic.ogg')
})

test('rejects duplicate task IDs before any database write', () => {
  assert.throws(
    () =>
      parseUsageCsv(
        Buffer.from(
          `${header}\nsynthetic-task,x,a,b,c,1,1,0.5,4.75,\nsynthetic-task,x,a,b,c,1,1,0.5,4.75,`,
        ),
      ),
    UsageCsvError,
  )
})

test('rejects the superseded usage template', () => {
  assert.throws(
    () =>
      parseUsageCsv(
        Buffer.from(
          'Task ID,Destination Number,Call Start Time,Call Connected Time,Call End Time,Duration (seconds) With Ringing,Duration (seconds) Without Ringing,Duration (minutes),Recording URL\nsynthetic-task,x,a,b,c,1,1,0.5,',
        ),
      ),
    /Missing required columns:.*Actual Billing Amount/,
  )
})

test('rejects a billed amount that is not fixed-precision numeric data', () => {
  assert.throws(
    () =>
      parseUsageCsv(
        Buffer.from(
          `${header}\nsynthetic-task,x,a,b,c,1,1,0.5,4.123456789,`,
        ),
      ),
    /Actual Billing Amount must be a non-negative decimal with at most 8 decimal places/,
  )
})

test('allows a blank billed amount for deterministic rate fallback', () => {
  const rows = parseUsageCsv(
    Buffer.from(
      `${header}\nsynthetic-task,x,a,b,c,1,1,0.5,,`,
    ),
  )
  assert.equal(rows[0]?.billedAmount, null)
})
