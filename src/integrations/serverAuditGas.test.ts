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
    sheet: { getName: () => name },
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
