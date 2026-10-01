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
  assert.match(source, /pass: 'final_retry'/)
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

test('NEEDS_REVIEW rows can be retried on request, never by the trigger', () => {
  assert.match(source, /\['FAILED', 'RETRYABLE', 'NEEDS_REVIEW'\]\.indexOf\(status\)/)
  assert.match(source, /\['RETRYABLE', 'RUNNING', 'FAILED'\]/)
})

test('an operator-requested retry runs before new rows; automatic retries still wait', () => {
  const context = vm.createContext({ console })
  new vm.Script(source).runInContext(context)
  const dispatcher = context as unknown as {
    kauditAuditPlanBatches_: (contexts: unknown[], limit: number) => {
      pass: string
      batches: Array<{ batchId: string; rows: unknown[] }>
    }
  }
  const sheet = tab('Re-audit', [
    ['re-new-1', '2026-06'], ['re-new-2', '2026-06'], ['re-new-3', '2026-06'],
    ['re-new-4', '2026-06'], ['re-asked', '2026-06'], ['re-auto', '2026-06'],
  ])
  sheet.rows[4]![4] = 'RETRY_REQUESTED'
  sheet.rows[4]![7] = 'gas-asked'
  sheet.rows[4]![8] = '1'
  sheet.rows[5]![4] = 'RETRYABLE'
  sheet.rows[5]![7] = 'gas-auto'
  sheet.rows[5]![8] = '1'
  const plan = dispatcher.kauditAuditPlanBatches_([sheet], 2)
  assert.equal(plan.pass, 'requested_retry')
  assert.deepEqual([...plan.batches].map((batch) => batch.batchId), ['gas-asked', ''])
  // The automatic retry is not in this run: first attempts still drain first.
  assert.ok([...plan.batches].every((batch) => batch.batchId !== 'gas-auto'))
})

test('a run writes back only the rows it changed, in contiguous blocks', () => {
  const context = vm.createContext({ console })
  new vm.Script(source).runInContext(context)
  const dispatcher = context as unknown as {
    kauditAuditSet_: (ref: unknown, key: string, value: unknown) => void
    kauditAuditFlush_: (contexts: unknown[]) => void
  }
  const writes: Array<[number, number, number]> = []
  const sheet = tab('Re-audit', Array.from({ length: 6 }, (_, n) =>
    [`re-${n}`, '2026-06'] as [string, string]))
  ;(sheet.sheet as unknown as { getRange: unknown }).getRange =
    (row: number, column: number, rows: number) => ({
      setValues: () => writes.push([row, column, rows]),
    })
  for (const index of [1, 2, 4]) {
    dispatcher.kauditAuditSet_({ context: sheet, index }, 'status', 'RUNNING')
  }
  dispatcher.kauditAuditFlush_([sheet])
  // Two blocks (rows 1-2 and row 4) x seven output columns; rows 0, 3, 5
  // are never rewritten, so edits made meanwhile survive.
  assert.equal(writes.length, 14)
  assert.deepEqual([...new Set(writes.map(([row, , rows]) => `${row}:${rows}`))], ['3:2', '6:1'])
})

test('a run reads only the columns it uses, as raw values', () => {
  const reads: number[] = []
  const context = vm.createContext({
    console,
    SpreadsheetApp: { getActive: () => ({ getSpreadsheetTimeZone: () => 'Asia/Kolkata' }) },
    Utilities: {
      formatDate: (date: Date) =>
        `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`,
    },
  })
  new vm.Script(source).runInContext(context)
  const read = (context as unknown as {
    kauditAuditReadColumns_: (
      sheet: unknown, headerRow: number, rowCount: number, columns: Record<string, number>,
    ) => unknown[][]
  }).kauditAuditReadColumns_
  const cells: Record<number, unknown[]> = {
    0: ['T-1', 'T-2'],
    1: [new Date(Date.UTC(2026, 5, 1)), '2026-07'],
    4: [2, ''],
  }
  const sheet = {
    getRange: (_row: number, column: number, rows: number, width: number) => {
      assert.equal(width, 1)
      reads.push(column - 1)
      return {
        getValues: () => Array.from({ length: rows }, (_, n) => [cells[column - 1]?.[n] ?? '']),
      }
    },
  }
  const rows = read(sheet, 1, 2, { taskId: 0, billMonth: 1, attempt: 4, mode: -1 })
  // Only the three mapped columns; the unmapped mode (-1) and every other
  // column of a wide, month-sized tab are never read.
  assert.deepEqual([...reads].sort(), [0, 1, 4])
  assert.equal(rows[0]?.[1], '2026-06')
  assert.equal(rows[0]?.[4], '2')
  assert.equal(rows[1]?.[1], '2026-07')
})

test('with the Sheets API enabled, one call reads and one call writes', () => {
  const calls: Array<{ kind: string; body: Record<string, unknown> }> = []
  const context = vm.createContext({
    console,
    SpreadsheetApp: {
      getActive: () => ({ getId: () => 'sheet-id', getSpreadsheetTimeZone: () => 'Asia/Kolkata' }),
    },
    Utilities: { formatDate: () => 'unused' },
    Sheets: {
      Spreadsheets: {
        Values: {
          batchGet: (_id: string, body: Record<string, unknown>) => {
            calls.push({ kind: 'get', body })
            // Trailing empty cells are omitted by the API.
            return { valueRanges: [
              { values: [['T-1'], ['T-2']] },
              { values: [['2026-06-01']] },
            ] }
          },
          batchUpdate: (body: Record<string, unknown>) => {
            calls.push({ kind: 'update', body })
            return {}
          },
        },
      },
    },
  })
  new vm.Script(source).runInContext(context)
  const script = context as unknown as {
    kauditAuditReadColumns_: (sheet: unknown, headerRow: number, rowCount: number,
      columns: Record<string, number>) => unknown[][]
    kauditAuditColumnLetter_: (column: number) => string
    kauditAuditSet_: (ref: unknown, key: string, value: unknown) => void
    kauditAuditFlush_: (contexts: unknown[]) => void
  }
  assert.deepEqual(
    [1, 26, 27, 52, 53].map((n) => String(script.kauditAuditColumnLetter_(n))),
    ['A', 'Z', 'AA', 'AZ', 'BA'],
  )
  const sheet = {
    getName: () => "Re-audit",
    getRange: () => { throw new Error('SpreadsheetApp must not be used') },
  }
  const rows = script.kauditAuditReadColumns_(sheet, 1, 2, { taskId: 0, billMonth: 27 })
  assert.equal(calls.length, 1)
  assert.deepEqual([...(calls[0]?.body.ranges as string[])], ["'Re-audit'!A2:A3", "'Re-audit'!AB2:AB3"])
  assert.equal(rows[0]?.[27], '2026-06')
  assert.equal(rows[1]?.[27], '')

  const tabContext = {
    sheet, headerRow: 1, rows: [[], []],
    columns: { status: 4, stage: 5, error: 6, batchId: 7, attempt: 8, updatedAt: 9, amount: 10 },
  }
  script.kauditAuditSet_({ context: tabContext, index: 1 }, 'status', 'RUNNING')
  script.kauditAuditFlush_([tabContext])
  assert.equal(calls.length, 2)
  const update = calls[1]!.body as { valueInputOption: string; data: Array<{ range: string }> }
  assert.equal(update.valueInputOption, 'RAW')
  assert.equal(update.data.length, 7)
  assert.equal(update.data[0]?.range, "'Re-audit'!E3:E3")
})

test('through the API, amounts and attempts are written as numbers, not text', () => {
  const updates: Array<{ data: Array<{ range: string; values: unknown[][] }> }> = []
  const context = vm.createContext({
    console,
    SpreadsheetApp: { getActive: () => ({ getId: () => 'sheet-id' }) },
    Sheets: { Spreadsheets: { Values: {
      batchGet: () => ({ valueRanges: [] }),
      batchUpdate: (body: never) => { updates.push(body); return {} },
    } } },
  })
  new vm.Script(source).runInContext(context)
  const script = context as unknown as {
    kauditAuditSet_: (ref: unknown, key: string, value: unknown) => void
    kauditAuditFlush_: (contexts: unknown[]) => void
  }
  const tabContext = {
    sheet: { getName: () => 'Re-audit' }, headerRow: 1, rows: [[]],
    columns: { status: 0, stage: 1, error: 2, batchId: 3, attempt: 4, updatedAt: 5, amount: 6 },
  }
  const ref = { context: tabContext, index: 0 }
  script.kauditAuditSet_(ref, 'amount', '9.50000000')
  script.kauditAuditSet_(ref, 'attempt', '1')
  script.kauditAuditSet_(ref, 'status', 'COMPLETED')
  script.kauditAuditFlush_([tabContext])
  const byRange = Object.fromEntries(updates[0]!.data.map((entry) => [entry.range, entry.values[0]![0]]))
  assert.equal(byRange["'Re-audit'!G2:G2"], 9.5)
  assert.equal(byRange["'Re-audit'!E2:E2"], 1)
  assert.equal(byRange["'Re-audit'!A2:A2"], 'COMPLETED')
})

function runLoop(roundResults: Array<{ sent: boolean; ms: number }>) {
  let clock = 0
  let rounds = 0
  const context = vm.createContext({
    console: { log: () => undefined },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock: () => undefined }) },
  })
  new vm.Script(source).runInContext(context)
  const script = context as unknown as Record<string, unknown>
  ;(context as unknown as { Date: unknown }).Date = { now: () => clock }
  script.kauditAuditConfig_ = () => ({ parallelBatches: 6 })
  script.kauditAuditContexts_ = () => [{}]
  script.kauditAuditRound_ = () => {
    const next = roundResults[rounds++] ?? { sent: false, ms: 0 }
    clock += next.ms
    return { sent: next.sent, log: {} }
  }
  ;(script.runKauditServerAuditBatches as () => void)()
  return rounds
}

test('a run keeps doing rounds while there is work and time', () => {
  // Three 60 s rounds fit (60+120 < 330, 120+120 < 330), then no work.
  assert.equal(runLoop([
    { sent: true, ms: 60_000 }, { sent: true, ms: 60_000 },
    { sent: true, ms: 60_000 }, { sent: false, ms: 1_000 },
  ]), 4)
})

test('a slow round stops the run before the 6-minute limit', () => {
  // After a 120 s round at t=120, another would need 120+240 > 330.
  assert.equal(runLoop([{ sent: true, ms: 120_000 }, { sent: true, ms: 120_000 }]), 1)
})

test('the Retry Audit tab sends retry_audit rows with Task ID only', () => {
  const context = vm.createContext({ console })
  new vm.Script(source).runInContext(context)
  const dispatcher = context as unknown as {
    kauditAuditInitialBatches_: (contexts: unknown[], limit: number) => Array<{ mode: string }>
  }
  const sheet = tab('Retry Audit', [['T-retry', '2026-07']])
  const batches = dispatcher.kauditAuditInitialBatches_([sheet], 4)
  assert.equal(batches[0]?.mode, 'retry_audit')
  assert.match(source, /retryAudit: 'Retry Audit'/)
  assert.match(source, /layouts\[tabs\.retryAudit\] = \[h\.taskId, h\.billMonth\]/)
})

test('the Accept KServe Claim tab sends accept_kserve_claim rows with Task ID only', () => {
  const context = vm.createContext({ console })
  new vm.Script(source).runInContext(context)
  const dispatcher = context as unknown as {
    kauditAuditInitialBatches_: (contexts: unknown[], limit: number) => Array<{ mode: string }>
  }
  const sheet = tab('Accept KServe Claim', [['T-accept', '2026-06']])
  assert.equal(dispatcher.kauditAuditInitialBatches_([sheet], 4)[0]?.mode, 'accept_kserve_claim')
  assert.match(source, /layouts\[tabs\.acceptClaim\] = \[h\.taskId, h\.billMonth\]/)
})
