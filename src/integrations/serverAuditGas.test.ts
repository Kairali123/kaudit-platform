import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const source = readFileSync(
  new URL(
    '../../integrations/google-apps-script/server-audit-batches.gs',
    import.meta.url,
  ),
  'utf8',
)

test('the Sheet dispatcher sends bounded batches in parallel', () => {
  assert.match(source, /batchSize:\s*3/)
  assert.match(source, /UrlFetchApp\.fetchAll/)
  assert.match(source, /maxParallelBatches:\s*8/)
  assert.match(source, /batches\.length < limit/)
})

test('new-month rows wait for their durable base-data import', () => {
  assert.match(source, /imported !== 'submitted'/)
  assert.match(source, /KAUDIT_BASE_DATA_ALREADY_IMPORTED/)
  assert.match(source, /mode === 'new_month'/)
})

test('late recording and stored-transcript re-audit are explicit modes', () => {
  assert.match(source, /'late_recording'/)
  assert.match(source, /'transcript_reaudit'/)
  assert.match(source, /item\.recording_url/)
})

test('every row records a bounded server lifecycle and one final retry', () => {
  for (const header of [
    'Kaudit Audit Status',
    'Kaudit Audit Stage',
    'Kaudit Audit Error',
    'Kaudit Audit Batch ID',
    'Kaudit Audit Attempt',
  ]) {
    assert.match(source, new RegExp(header))
  }
  assert.match(source, /pass = 'final_retry'/)
  assert.match(source, /attempt < 2/)
  assert.match(source, /\['RETRYABLE', 'RUNNING', 'FAILED'\]/)
})

test('requests bind the exact body, month, route, and idempotency key', () => {
  assert.match(source, /X-Kaudit-Audit-Sync-Signature/)
  assert.match(source, /X-Kaudit-Content-Sha256/)
  assert.match(source, /X-Kaudit-Bill-Month/)
  assert.match(source, /X-Kaudit-Batch-Id/)
  assert.match(source, /\/api\/v1\/reconciliation\/batch/)
})

test('the unified intake is set up safely and never falls back to another tab', () => {
  assert.match(source, /function setupKauditUnifiedIntake\(\)/)
  assert.match(source, /intakeSheetName: 'Audit Intake'/)
  assert.match(source, /Nothing was changed/)
  assert.doesNotMatch(source, /clear(Contents)?\(/)
  assert.doesNotMatch(source, /getActiveSheet\(\)\]/)
  assert.match(source, /'BILL_MONTH_MISSING'/)
})
