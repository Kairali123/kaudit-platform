import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

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

test('the audit tabs are set up safely and never fall back to another tab', () => {
  assert.match(source, /function setupKauditAuditTabs\(\)/)
  assert.match(source, /newMonth: 'New Month'/)
  assert.match(source, /lateRecording: 'Late Recording'/)
  assert.match(source, /reaudit: 'Re-audit'/)
  assert.match(source, /Nothing was changed on that tab/)
  assert.doesNotMatch(source, /clear(Contents)?\(/)
  assert.doesNotMatch(source, /getActiveSheet\(\)\]/)
})

function loadDispatcher() {
  const context = vm.createContext({ console })
  new vm.Script(source, { filename: 'server-audit-batches.gs' }).runInContext(context)
  return context as unknown as {
    kauditAuditInitialBatches_: (contexts: unknown[], limit: number) => Array<{
      mode: string
      billMonth: string
      rows: Array<{ index: number }>
    }>
  }
}

// Synthetic tab: Task ID, Kaudit Bill Month, Recording URL, Import Status,
// then the output columns the dispatcher writes.
function tab(name: string, rows: Array<[string, string]>, defaultMode = '') {
  const columns = {
    taskId: 0, billMonth: 1, recordingUrl: 2, importStatus: 3, mode: -1,
    status: 4, stage: 5, error: 6, batchId: 7, attempt: 8, updatedAt: 9, amount: 10,
  }
  return {
    sheet: { getName: () => name, getSheetId: () => 1 },
    headerRow: 1,
    columns,
    config: { defaultMode, billMonth: '', auditYear: '', allowPreimported: false },
    rows: rows.map(([taskId, month]) => [
      taskId, month, 'https://recordings.example.test/x.ogg', 'Submitted',
      '', '', '', '', '', '', '',
    ]),
  }
}

test('one run takes turns between tabs and each tab keeps its own mode', () => {
  const dispatcher = loadDispatcher()
  const late = tab('Late Recording', Array.from({ length: 12 }, (_, n) =>
    [`late-${n}`, '2026-06'] as [string, string]), 'new_month')
  const reaudit = tab('Re-audit', [['re-1', '2026-07'], ['re-2', '2026-07']], 'new_month')
  const fresh = tab('New Month', [['new-1', '2026-08'], ['new-2', ''], ['new-3', '2026-08']])
  const batches = dispatcher.kauditAuditInitialBatches_([late, reaudit, fresh], 4)
  assert.deepEqual(
    [...batches].map((batch) => `${batch.mode}:${batch.billMonth}:${batch.rows.length}`),
    [
      'late_recording:2026-06:3',
      'new_month:2026-08:2',
      'transcript_reaudit:2026-07:2',
      'late_recording:2026-06:3',
    ],
  )
  // A row without a month fails alone; the rest of its tab still runs.
  assert.equal(fresh.rows[1]?.[4], 'FAILED')
  assert.equal(fresh.rows[1]?.[6], 'BILL_MONTH_MISSING')
})

test('a busy refusal hands rows back without spending an attempt', () => {
  const context = vm.createContext({ console })
  new vm.Script(source).runInContext(context)
  const dispatcher = context as unknown as {
    kauditAuditApplyResponse_: (batch: unknown, response: unknown) => void
    kauditAuditInitialBatches_: (contexts: unknown[], limit: number) => unknown[]
  }
  const sheet = tab('Late Recording', [['late-1', '2026-06'], ['late-2', '2026-06']])
  sheet.rows[0]![4] = 'RUNNING'
  sheet.rows[0]![7] = 'gas-first'
  sheet.rows[0]![8] = '1'
  sheet.rows[1]![4] = 'RUNNING'
  sheet.rows[1]![7] = 'gas-retry'
  sheet.rows[1]![8] = '2'
  const busy = {
    getResponseCode: () => 409,
    getContentText: () => JSON.stringify({ code: 'LATE_RECORDING_BUSY' }),
  }
  dispatcher.kauditAuditApplyResponse_({ rows: [{ context: sheet, index: 0 }] }, busy)
  dispatcher.kauditAuditApplyResponse_({ rows: [{ context: sheet, index: 1 }] }, busy)
  assert.deepEqual([sheet.rows[0]?.[4], sheet.rows[0]?.[8]], ['PENDING', 0])
  assert.deepEqual([sheet.rows[1]?.[4], sheet.rows[1]?.[8]], ['RETRYABLE', 1])
  assert.equal(sheet.rows[0]?.[6], 'LATE_RECORDING_BUSY')
  // The first-attempt row is queued again on the next run.
  assert.equal(dispatcher.kauditAuditInitialBatches_([sheet], 4).length, 1)
})

test('a low-confidence billing refusal is parked for review, not retried', () => {
  const context = vm.createContext({ console })
  new vm.Script(source).runInContext(context)
  const dispatcher = context as unknown as {
    kauditAuditApplyResponse_: (batch: unknown, response: unknown) => void
    kauditAuditRetryBatches_: (contexts: unknown[], limit: number) => unknown[]
  }
  const sheet = tab('Re-audit', [['re-1', '2026-06'], ['re-2', '2026-06']])
  for (const row of sheet.rows) {
    row[4] = 'RUNNING'
    row[7] = 'gas-batch-1'
    row[8] = '1'
  }
  dispatcher.kauditAuditApplyResponse_(
    { rows: [{ context: sheet, index: 0 }, { context: sheet, index: 1 }] },
    {
      getResponseCode: () => 200,
      getContentText: () => JSON.stringify({ items: [
        { taskId: 're-1', stage: 'billing', status: 'failed',
          code: 'WINNING_CONSENSUS_CONFIDENCE_BELOW_FLOOR' },
        { taskId: 're-2', stage: 'billing', status: 'failed',
          code: 'AUDIT_RESULT_NOT_READY' },
      ] }),
    },
  )
  assert.equal(sheet.rows[0]?.[4], 'NEEDS_REVIEW')
  assert.equal(sheet.rows[1]?.[4], 'FAILED')
  // Only the not-ready row keeps the batch eligible for its final retry.
  sheet.rows[1]![4] = 'COMPLETED'
  assert.equal(dispatcher.kauditAuditRetryBatches_([sheet], 4).length, 0)
})
