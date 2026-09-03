import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import type { Pool } from 'mysql2/promise'
import {
  auditedFinancialSummarySql,
  collectAuditMonitor,
  durationVarianceMs,
  type AuditMonitorQuery,
} from './mysqlAuditMonitor.ts'

/**
 * Audit-monitor financial-summary contract.
 *
 * Two layers are covered without contacting any real database:
 *
 *   1. the aggregation SQL itself, executed by the in-process SQLite engine
 *      over synthetic tables, so the per-call cap and missing-duration case
 *      are proven rather than asserted as text; and
 *   2. the DTO the adapter maps back, through a recording fake pool.
 *
 * Every fixture here is SYNTHETIC. No real call, transcript, task id, amount,
 * invoice, or secret appears in this file. The synthetic tables exist only in
 * memory for the lifetime of a test; no external source table is created,
 * written, or locked.
 */

// ---------------------------------------------------------------------------
// Synthetic in-memory evaluation of the aggregation SQL
// ---------------------------------------------------------------------------

interface SyntheticCalculation {
  id: string
  callId: string
  status: string
  totalAmount: string
  calculatedAt: string
  supersedesCalculationId?: string | null
}

interface SyntheticProviderCost {
  callId: string
  providerSku: string
  minutesDecimal?: string | null
  quantityDecimal?: string | null
  isFinal?: number
}

interface SummaryTotals {
  auditedCalls: number
  kservePricedCalls: number
  kserveCharge: number
  auditorFinalPricedCalls: number
  auditorUnfinalizedCalls: number
  auditorFinalCharge: number
}

interface ScopedCall {
  id: string
  graceAdjustedDurationMs: number | null
}

/**
 * Runs the production summary SQL over synthetic tables.
 *
 * The scoped relation is supplied as literal rows, standing in for the audited
 * calls the monitor filter selected, so this exercises the money aggregation
 * without reproducing the audited-call join.
 */
function summarize(fixture: {
  scopedCallIds: (string | ScopedCall)[]
  calculations?: SyntheticCalculation[]
  providerCosts?: SyntheticProviderCost[]
}): SummaryTotals {
  const db = new DatabaseSync(':memory:')
  try {
    db.exec(`
      CREATE TABLE kaudit_billing_calculation (
        id TEXT PRIMARY KEY,
        call_id TEXT NOT NULL,
        status TEXT NOT NULL,
        total_amount TEXT,
        calculated_at TEXT,
        supersedes_calculation_id TEXT
      );
      CREATE TABLE kaudit_provider_cost (
        call_id TEXT NOT NULL,
        provider_sku TEXT NOT NULL,
        minutes_decimal TEXT,
        quantity_decimal TEXT,
        is_final INTEGER NOT NULL DEFAULT 1
      );
    `)
    const insertCalculation = db.prepare(
      `INSERT INTO kaudit_billing_calculation
         (id, call_id, status, total_amount, calculated_at,
          supersedes_calculation_id)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    for (const calculation of fixture.calculations ?? []) {
      insertCalculation.run(
        calculation.id,
        calculation.callId,
        calculation.status,
        calculation.totalAmount,
        calculation.calculatedAt,
        calculation.supersedesCalculationId ?? null,
      )
    }
    const insertCost = db.prepare(
      `INSERT INTO kaudit_provider_cost
         (call_id, provider_sku, minutes_decimal, quantity_decimal, is_final)
       VALUES (?, ?, ?, ?, ?)`,
    )
    for (const cost of fixture.providerCosts ?? []) {
      insertCost.run(
        cost.callId,
        cost.providerSku,
        cost.minutesDecimal ?? null,
        cost.quantityDecimal ?? null,
        cost.isFinal ?? 1,
      )
    }
    const scoped = fixture.scopedCallIds
      .map((call) => {
        const scopedCall =
          typeof call === 'string'
            ? { id: call, graceAdjustedDurationMs: 121_000 }
            : call
        return `SELECT '${scopedCall.id}' AS id, ${
          scopedCall.graceAdjustedDurationMs == null
            ? 'NULL'
            : scopedCall.graceAdjustedDurationMs
        } AS grace_adjusted_duration_ms`
      })
      .join(' UNION ALL ')
    const row = db
      .prepare(auditedFinancialSummarySql(scoped))
      .get() as Record<string, number | string | null>
    return {
      auditedCalls: Number(row.audited_calls),
      kservePricedCalls: Number(row.kserve_priced_calls),
      kserveCharge: Number(row.kserve_charge),
      auditorFinalPricedCalls: Number(row.auditor_final_priced_calls),
      auditorUnfinalizedCalls: Number(row.auditor_unfinalized_calls),
      auditorFinalCharge: Number(row.auditor_final_charge),
    }
  } finally {
    db.close()
  }
}

const VENDOR_MINUTES: SyntheticProviderCost = {
  callId: 'call-synthetic-1',
  providerSku: 'vendor_asserted_billed_minutes',
  minutesDecimal: '2.00000000',
}

test('an audited amount is capped at KServe charge when AI duration is higher', () => {
  const totals = summarize({
    scopedCallIds: ['call-synthetic-1'],
    providerCosts: [VENDOR_MINUTES],
  })
  assert.equal(totals.auditedCalls, 1)
  assert.equal(totals.kserveCharge, 19)
  assert.equal(totals.auditorFinalPricedCalls, 1)
  assert.equal(totals.auditorUnfinalizedCalls, 0)
  // 121s rounds to 3 minutes (₹28.50), then caps at KServe's 2 minutes.
  assert.equal(totals.auditorFinalCharge, 19)
})

test('an audited amount stays below KServe when AI duration is lower', () => {
  const totals = summarize({
    scopedCallIds: [
      { id: 'call-synthetic-1', graceAdjustedDurationMs: 61_000 },
    ],
    providerCosts: [
      { ...VENDOR_MINUTES, minutesDecimal: '3.00000000' },
    ],
  })
  assert.equal(totals.kserveCharge, 28.5)
  // 61s rounds to 2 minutes, below KServe's 3 billed minutes.
  assert.equal(totals.auditorFinalCharge, 19)
})

test('billing calculations do not change the capped auditor amount', () => {
  const totals = summarize({
    scopedCallIds: ['call-synthetic-1'],
    providerCosts: [VENDOR_MINUTES],
    calculations: [
      {
        id: 'calc-current',
        callId: 'call-synthetic-1',
        status: 'final',
        totalAmount: '999.50000000',
        calculatedAt: '2026-08-01 00:00:00',
      },
    ],
  })
  assert.equal(totals.auditorFinalPricedCalls, 1)
  assert.equal(totals.auditorUnfinalizedCalls, 0)
  assert.equal(totals.auditorFinalCharge, 19)
})

test('missing audited duration is counted separately from priced calls', () => {
  const totals = summarize({
    scopedCallIds: [
      'call-synthetic-1',
      { id: 'call-synthetic-2', graceAdjustedDurationMs: null },
    ],
    providerCosts: [VENDOR_MINUTES],
  })
  assert.equal(totals.auditorFinalPricedCalls, 1)
  assert.equal(totals.auditorUnfinalizedCalls, 1)
  assert.equal(totals.auditorFinalCharge, 19)
})

test('priced and missing-duration calls are reported distinctly in one scope', () => {
  const totals = summarize({
    scopedCallIds: [
      'call-synthetic-1',
      'call-synthetic-2',
      { id: 'call-synthetic-3', graceAdjustedDurationMs: null },
    ],
  })
  assert.equal(totals.auditedCalls, 3)
  assert.equal(totals.auditorFinalPricedCalls, 2)
  assert.equal(totals.auditorUnfinalizedCalls, 1)
  assert.equal(totals.auditorFinalCharge, 57)
})

test('the KServe charge aggregates independently of the capped auditor amount', () => {
  const vendorOnly = summarize({
    scopedCallIds: ['call-synthetic-1'],
    providerCosts: [VENDOR_MINUTES],
  })
  assert.equal(vendorOnly.kservePricedCalls, 1)
  assert.equal(vendorOnly.kserveCharge, 19)
  assert.equal(vendorOnly.auditorFinalCharge, 19)

  const withFinalCalculation = summarize({
    scopedCallIds: ['call-synthetic-1'],
    providerCosts: [VENDOR_MINUTES],
    calculations: [
      {
        id: 'calc-current',
        callId: 'call-synthetic-1',
        status: 'final',
        totalAmount: '9.50000000',
        calculatedAt: '2026-08-01 00:00:00',
      },
    ],
  })
  // The vendor total is unchanged by the auditor's own money, and vice versa:
  // the two are never merged into one authoritative figure.
  assert.equal(withFinalCalculation.kserveCharge, 19)
  assert.equal(withFinalCalculation.auditorFinalCharge, 19)
})

test('a non-final provider cost row is not vendor-priced evidence', () => {
  const totals = summarize({
    scopedCallIds: ['call-synthetic-1'],
    providerCosts: [{ ...VENDOR_MINUTES, isFinal: 0 }],
  })
  assert.equal(totals.kservePricedCalls, 0)
  assert.equal(totals.kserveCharge, 0)
})

test('the summary SQL caps audited money before summing', () => {
  const sql = auditedFinancialSummarySql(
    'SELECT 1 AS id, 121000 AS grace_adjusted_duration_ms',
  )
  assert.match(sql, /CEIL\(scoped\.grace_adjusted_duration_ms/)
  assert.match(sql, /vendor\.minutes_decimal \* 9\.5/)
  assert.equal(/final_calculation/.test(sql), false)
})

// ---------------------------------------------------------------------------
// Non-monetary duration metadata
// ---------------------------------------------------------------------------

test('duration variance is metadata that stays null when either side is missing', () => {
  assert.equal(durationVarianceMs(180_000, 121_000), 59_000)
  assert.equal(durationVarianceMs(null, 121_000), null)
  assert.equal(durationVarianceMs(180_000, null), null)
})

// ---------------------------------------------------------------------------
// Recording fake pool: the DTO the monitor returns
// ---------------------------------------------------------------------------

interface RowRule {
  match: string
  rows: unknown[]
}

function fakePool(rules: RowRule[], failing: string[] = []) {
  const statements: string[] = []
  const calls: Array<{ sql: string; params: unknown[] }> = []
  const pool = {
    async query(sql: string, params: unknown[] = []) {
      statements.push(sql)
      calls.push({ sql, params })
      if (failing.some((match) => sql.includes(match))) {
        throw Object.assign(new Error('synthetic unavailable relation'), {
          code: 'ER_NO_SUCH_TABLE',
        })
      }
      const rule = rules.find((candidate) => sql.includes(candidate.match))
      return [rule ? rule.rows : []]
    },
  } as unknown as Pool
  return {
    pool,
    statements,
    calls,
    find(match: string) {
      return statements.find((sql) => sql.includes(match))
    },
  }
}

const QUERY: AuditMonitorQuery = {
  page: 1,
  pendingPage: 1,
  noRecordingPage: 1,
  pageSize: 25,
  category: null,
  taskId: null,
  periodStart: '2026-08-01',
  periodEnd: '2026-08-31',
}

const FINANCIAL_ROW = {
  audited_calls: 3,
  kserve_priced_calls: 3,
  kserve_charge: '28.50000000',
  auditor_final_priced_calls: 1,
  auditor_unfinalized_calls: 2,
  auditor_final_charge: '9.50000000',
}

const AUDITED_ROW = {
  internal_call_id: 'call-synthetic-1',
  call_reference: 'synthetic-task-1',
  billing_period_date: '2026-08-01',
  category: 'TIME_DURATION',
  outcome_taxonomy_version: 'v2',
  confidence: '0.95000000',
  confirmation_status: 'model_output',
  language: 'english',
  provider_name: 'synthetic-asr',
  model_name: 'synthetic-model',
  model_version: '1',
  engine_version: 'kairali-independent-reaudit/2.0.0',
  decoded_duration_ms: 190_000,
  speech_ms: 80_000,
  conversation_end_ms: 61_000,
  grace_adjusted_duration_ms: 121_000,
  vendor_connected_duration_ms: 180_000,
  evidence_sha256: 'f'.repeat(64),
  last_verified_at: '2026-08-02 00:00:00',
  audited_at: '2026-08-02 00:00:00',
  ai_input_tokens: 100,
  ai_output_tokens: 50,
  ai_total_tokens: 150,
  ai_audio_seconds: 190,
}

test('rows mode omits aggregate usage and financial scans', async () => {
  const fake = fakePool([
    { match: 'grace_adjusted_duration_ms', rows: [AUDITED_ROW] },
  ])

  const data = await collectAuditMonitor(fake.pool, QUERY, 'rows')

  assert.equal(data.rows.length, 1)
  assert.equal(data.totalsFinal, false)
  assert.equal('summary' in data, false)
  assert.equal('filters' in data, false)
  const sql = fake.statements.join('\n')
  assert.doesNotMatch(sql, /COUNT\(DISTINCT usage_event\.audit_run_id\)/)
  assert.doesNotMatch(sql, /GROUP BY usage_event\.model_name/)
  assert.doesNotMatch(sql, /auditor_final_charge/)
  assert.doesNotMatch(sql, /SELECT DISTINCT c\.canonical_outcome_code AS value/)
  assert.doesNotMatch(sql, /engine_version = 'kairali-independent-reaudit/)
  assert.doesNotMatch(sql, /COUNT\(\*\) AS total_calls/)
  assert.doesNotMatch(sql, /SELECT COUNT\(DISTINCT c\.id\) AS n/)
})

test('rows mode fetches one lookahead row without exposing it', async () => {
  const fetched = Array.from({ length: 26 }, (_, index) => ({
    ...AUDITED_ROW,
    internal_call_id: `call-synthetic-${index}`,
    call_reference: `synthetic-task-${index}`,
  }))
  const fake = fakePool([
    { match: 'grace_adjusted_duration_ms', rows: fetched },
  ])

  const data = await collectAuditMonitor(fake.pool, QUERY, 'rows')

  assert.equal(data.rows.length, 25)
  assert.equal(data.pagination.totalRows, 26)
  assert.equal(data.pagination.totalPages, 2)
  const auditedPage = fake.calls.find(({ sql }) =>
    sql.includes('c.id AS internal_call_id'),
  )
  assert.deepEqual(auditedPage?.params.slice(-2), [26, 0])
  assert.match(
    auditedPage?.sql ?? '',
    /\) audited_page[\s\S]*ORDER BY audited_page\.billing_period_date DESC/,
  )
  assert.doesNotMatch(auditedPage?.sql ?? '', /ORDER BY audited_at/)
})

test('default audited paging limits candidates before display joins', async () => {
  const fake = fakePool([])
  await collectAuditMonitor(fake.pool, QUERY, 'rows', 'audited')

  const auditedPage = fake.calls.find(({ sql }) =>
    sql.includes('c.id AS internal_call_id'),
  )?.sql ?? ''
  const pageLimit = auditedPage.indexOf('LIMIT ? OFFSET ?')
  const displayJoin = auditedPage.indexOf('JOIN kaudit_media_analysis ma\n')
  assert.ok(pageLimit > 0)
  assert.ok(displayJoin > pageLimit)
  assert.match(auditedPage, /ca_candidate\.id = \(\s*SELECT latest_artifact\.id/)
  assert.match(auditedPage, /EXISTS \(\s*SELECT 1\s*FROM kaudit_transcript/)
})

test('rows mode can isolate each monitor table to one page query', async () => {
  const cases = [
    ['audited', 'c.id AS internal_call_id'],
    ['pending', 'pending.processing_status'],
    ['no-recording', "COALESCE(ca.audio_processing_status, 'no_recording')"],
  ] as const

  for (const [table, expectedSql] of cases) {
    const fake = fakePool([])
    await collectAuditMonitor(fake.pool, QUERY, 'rows', table)
    const pageQueries = fake.statements.filter((sql) =>
      sql.includes('LIMIT ? OFFSET ?'),
    )
    assert.equal(pageQueries.length, 1, table)
    assert.ok(pageQueries[0]?.includes(expectedSql), table)
  }
})

test('no queue row carries a recording URL, and none is selected', async () => {
  const queueRow = {
    call_reference: 'synthetic-task-pending',
    // Present on the row shape a driver could hand back; it must still be
    // dropped rather than mapped into the DTO.
    recording_url:
      'https://recordings.example.test/exact%20object.ogg?stored=yes&part=1',
    billing_period_date: '2026-08-01',
    processing_status: 'fetch_failed',
    attempt_count: 2,
    evidence_sha256: null,
    last_verified_at: null,
    vendor_billed_minutes: '1.00',
    vendor_connected_duration_ms: 60_000,
    auditor_amount: null,
    billing_status: null,
    billing_basis: null,
    audit_remark: null,
    last_activity_at: '2026-08-02 00:00:00',
  }
  const fake = fakePool([
    { match: 'pending.processing_status', rows: [queueRow] },
  ])

  const data = await collectAuditMonitor(fake.pool, QUERY, 'rows', 'pending')

  assert.equal(data.pendingRows.length, 1)
  assert.equal('recordingUrl' in (data.pendingRows[0] ?? {}), false)
  assert.equal('recordingUrl' in (data.noRecordingRows[0] ?? {}), false)
  // The column is not even read: source evidence stays server-side, and the
  // pending page read stays one column narrower.
  const pendingSql = fake.find('pending.processing_status') ?? ''
  assert.doesNotMatch(pendingSql, /source_url AS recording_url/)
  assert.doesNotMatch(pendingSql, /pending\.recording_url/)
  // The recording-backed scope itself is unchanged.
  assert.match(pendingSql, /ca\.source_url IS NOT NULL/)
})

test('pending and no-recording pages use the existing period/id index order', async () => {
  for (const table of ['pending', 'no-recording'] as const) {
    const fake = fakePool([])
    await collectAuditMonitor(fake.pool, QUERY, 'rows', table)
    const pageQuery = fake.calls.find(({ sql }) =>
      sql.includes('LIMIT ? OFFSET ?'),
    )?.sql ?? ''
    assert.match(
      pageQuery,
      /ORDER BY c\.billing_period_date DESC, c\.id DESC\s*LIMIT \? OFFSET \?/,
      table,
    )
    assert.doesNotMatch(
      pageQuery,
      /ORDER BY c\.billing_period_date DESC, c\.id\s*LIMIT/,
      table,
    )
  }
})

test('summary mode omits all paginated row queries', async () => {
  const fake = fakePool([
    { match: 'auditor_final_charge', rows: [FINANCIAL_ROW] },
  ])

  const data = await collectAuditMonitor(fake.pool, QUERY, 'summary')

  assert.equal(data.summary.auditedFinancials.scopedAuditedCalls, 3)
  assert.equal('rows' in data, false)
  const sql = fake.statements.join('\n')
  assert.doesNotMatch(sql, /LIMIT \? OFFSET \?/)
  assert.doesNotMatch(sql, /c\.id AS internal_call_id/)
  assert.doesNotMatch(sql, /kaudit_billing_reaudit_item/)
})

test('split summary modes isolate core, usage, and financial work', async () => {
  const core = fakePool([])
  const coreData = await collectAuditMonitor(core.pool, QUERY, 'summary-core')
  assert.equal(coreData.summary.totalCalls, 0)
  assert.equal('aiUsage' in coreData.summary, false)
  assert.doesNotMatch(core.statements.join('\n'), /kaudit_ai_usage_event/)
  assert.doesNotMatch(core.statements.join('\n'), /auditor_final_charge/)

  const usage = fakePool([])
  const usageData = await collectAuditMonitor(
    usage.pool,
    QUERY,
    'summary-usage',
  )
  assert.equal(usageData.aiUsage.trackedAuditRuns, 0)
  assert.equal(usage.statements.length, 1)
  assert.match(usage.statements[0] ?? '', /kaudit_ai_usage_event/)

  const financial = fakePool([
    { match: 'auditor_final_charge', rows: [FINANCIAL_ROW] },
  ])
  const financialData = await collectAuditMonitor(
    financial.pool,
    QUERY,
    'summary-financial',
  )
  assert.equal(financialData.auditedFinancials.scopedAuditedCalls, 3)
  assert.equal(financial.statements.length, 1)
  assert.match(
    financial.statements[0] ?? '',
    /kaudit_call c FORCE INDEX \(idx_call_period_category_started\)/,
  )
  assert.match(
    financial.statements[0] ?? '',
    /STRAIGHT_JOIN kaudit_call_artifact ca/,
  )
  assert.doesNotMatch(financial.statements[0] ?? '', /JOIN kaudit_transcript t/)
})

test('summary usage totals and per-model costs share one rollup scan', async () => {
  const fake = fakePool([
    { match: 'auditor_final_charge', rows: [FINANCIAL_ROW] },
    {
      match: 'COUNT(DISTINCT usage_event.audit_run_id)',
      rows: [
        {
          model_name: 'gpt-4o-mini',
          tracked_audit_runs: 2,
          input_tokens: 120,
          output_tokens: 30,
          total_tokens: 150,
          audio_seconds: 0,
        },
        {
          model_name: 'whisper-1',
          tracked_audit_runs: 2,
          input_tokens: 0,
          output_tokens: 0,
          total_tokens: 0,
          audio_seconds: 45,
        },
        {
          model_name: null,
          tracked_audit_runs: 2,
          input_tokens: 120,
          output_tokens: 30,
          total_tokens: 150,
          audio_seconds: 45,
        },
      ],
    },
  ])

  const data = await collectAuditMonitor(fake.pool, QUERY, 'summary')

  assert.equal(data.summary.aiUsage.trackedAuditRuns, 2)
  assert.equal(data.summary.aiUsage.gptTotalTokens, 150)
  assert.equal(data.summary.aiUsage.whisperAudioSeconds, '45.000')
  const usageQueries = fake.statements.filter((sql) =>
    sql.includes('kaudit_ai_usage_event'),
  )
  assert.equal(usageQueries.length, 1)
  assert.match(usageQueries[0], /WITH ROLLUP/)
})

test('the response separates capped auditor money from missing-duration audited calls', async () => {
  const fake = fakePool([
    { match: 'auditor_final_charge', rows: [FINANCIAL_ROW] },
    { match: 'grace_adjusted_duration_ms', rows: [AUDITED_ROW] },
  ])
  const data = await collectAuditMonitor(fake.pool, QUERY)
  const financials = data.summary.auditedFinancials

  assert.equal(financials.scopedAuditedCalls, 3)
  assert.equal(financials.auditorFinalPricedCalls, 1)
  assert.equal(financials.auditorUnfinalizedCalls, 2)
  assert.equal(financials.auditorFinalChargeInr, '9.50000000')
  // The vendor aggregate keeps its own independent total.
  assert.equal(financials.kservePricedCalls, 3)
  assert.equal(financials.kserveChargeInr, '28.50000000')
  // Nothing in the released figures blends the two authorities.
  assert.equal('auditorChargeInr' in financials, false)
  assert.equal('auditorCalculatedCalls' in financials, false)
})

test('duration facts stay on the row as metadata, derived without a second lookup', async () => {
  const fake = fakePool([
    { match: 'auditor_final_charge', rows: [FINANCIAL_ROW] },
    { match: 'grace_adjusted_duration_ms', rows: [AUDITED_ROW] },
  ])
  const data = await collectAuditMonitor(fake.pool, QUERY)
  const row = data.rows[0]

  assert.equal(row.recordedDurationMs, 190_000)
  assert.equal(row.conversationEndMs, 61_000)
  assert.equal(row.graceAdjustedDurationMs, 121_000)
  assert.equal(row.vendorConnectedDurationMs, 180_000)
  assert.equal(row.varianceDurationMs, 59_000)
  // No money is attached to an individual audited row.
  assert.equal('auditorAmount' in row, false)

  const listing = fake.find('duration_without_ringing_sec') ?? ''
  const connectedLookups = listing.match(
    /duration_without_ringing_sec/g,
  )
  assert.equal(connectedLookups?.length, 1)
})

test('a call the monitor cannot price reports zero auditor money, not a projection', async () => {
  const fake = fakePool([
    {
      match: 'auditor_final_charge',
      rows: [
        {
          ...FINANCIAL_ROW,
          auditor_final_priced_calls: 0,
          auditor_unfinalized_calls: 3,
          auditor_final_charge: '0.00000000',
        },
      ],
    },
    { match: 'grace_adjusted_duration_ms', rows: [AUDITED_ROW] },
  ])
  const data = await collectAuditMonitor(fake.pool, QUERY)
  const financials = data.summary.auditedFinancials

  assert.equal(financials.auditorFinalChargeInr, '0.00000000')
  assert.equal(financials.auditorUnfinalizedCalls, 3)
  // The row still carries its audited duration facts.
  assert.equal(data.rows[0].graceAdjustedDurationMs, 121_000)
})

// ---------------------------------------------------------------------------
// Per-row re-audit state
// ---------------------------------------------------------------------------

test('a row carries only safe re-audit lifecycle fields, never a queue internal', async () => {
  const fake = fakePool([
    { match: 'auditor_final_charge', rows: [FINANCIAL_ROW] },
    { match: 'grace_adjusted_duration_ms', rows: [AUDITED_ROW] },
    {
      match: 'kaudit_billing_reaudit_item',
      rows: [
        {
          call_id: 'call-synthetic-1',
          status: 'failed',
          created_at: '2026-08-20 09:00:00',
          completed_at: '2026-08-20 09:05:00',
          last_error_code: 'CLASSIFICATION_FAILED',
        },
      ],
    },
  ])
  const data = await collectAuditMonitor(fake.pool, QUERY)
  const row = data.rows[0]

  assert.equal(row.reAuditStatus, 'failed')
  assert.equal(row.reAuditFailureCode, 'CLASSIFICATION_FAILED')
  assert.match(row.reAuditCompletedAt ?? '', /^2026-08-20T/)
  // The internal key used to join the queue never reaches the DTO.
  assert.equal('internal_call_id' in row, false)
  assert.equal('internalCallId' in row, false)
  const body = JSON.stringify(data)
  assert.equal(body.includes('call-synthetic-1'), false)
  for (const internal of [
    'requestId',
    'itemId',
    'baselineAuditRunId',
    'lastErrorCode',
    'brr_',
    'bri_',
  ]) {
    assert.equal(body.includes(internal), false)
  }
})

test('a row with no re-audit lifecycle reports null rather than a stale word', async () => {
  const fake = fakePool([
    { match: 'auditor_final_charge', rows: [FINANCIAL_ROW] },
    { match: 'grace_adjusted_duration_ms', rows: [AUDITED_ROW] },
    { match: 'kaudit_billing_reaudit_item', rows: [] },
  ])
  const data = await collectAuditMonitor(fake.pool, QUERY)
  assert.equal(data.rows[0].reAuditStatus, null)
  assert.equal(data.rows[0].reAuditCompletedAt, null)
  // Only the calls actually on screen are asked about.
  const lookup = fake.find('kaudit_billing_reaudit_item') ?? ''
  assert.match(lookup, /item.status IN \('queued','processing','completed','failed'\)/)
  assert.match(lookup, /NOT EXISTS \(/)
})

test('no-recording pagination happens before optional metadata joins', async () => {
  const fake = fakePool([
    { match: 'auditor_final_charge', rows: [FINANCIAL_ROW] },
    { match: 'grace_adjusted_duration_ms', rows: [AUDITED_ROW] },
  ])
  await collectAuditMonitor(fake.pool, QUERY)

  const noRecordingQuery = fake.find("'no_recording'") ?? ''
  assert.match(
    noRecordingQuery,
    /FROM \(\s*SELECT[\s\S]*?FROM kaudit_call c[\s\S]*?LIMIT \? OFFSET \?\s*\) c\s*LEFT JOIN kaudit_call_artifact/,
  )
  assert.doesNotMatch(
    noRecordingQuery,
    /LEFT JOIN kaudit_billing_calculation[\s\S]*?LIMIT \? OFFSET \?/,
  )
  assert.match(
    noRecordingQuery,
    /WHEN calculation\.id IS NULL THEN '0\.00000000'/,
  )
  assert.match(
    noRecordingQuery,
    /'No Recording Found' AS audit_remark/,
  )
})

test('pending pagination probes indexed completion without materializing tables', async () => {
  const fake = fakePool([
    { match: 'auditor_final_charge', rows: [FINANCIAL_ROW] },
    { match: 'grace_adjusted_duration_ms', rows: [AUDITED_ROW] },
  ])
  await collectAuditMonitor(fake.pool, QUERY, 'rows')

  const pendingQuery = fake.find('pending.processing_status') ?? ''
  assert.match(pendingQuery, /AND EXISTS \(\s*SELECT 1\s*FROM kaudit_media_analysis/)
  assert.match(pendingQuery, /AND EXISTS \(\s*SELECT 1\s*FROM kaudit_transcript/)
  assert.doesNotMatch(pendingQuery, /SELECT DISTINCT call_artifact_id/)
})

test('an unapplied re-audit migration still renders the audited rows', async () => {
  const fake = fakePool(
    [
      { match: 'auditor_final_charge', rows: [FINANCIAL_ROW] },
      { match: 'grace_adjusted_duration_ms', rows: [AUDITED_ROW] },
    ],
    ['kaudit_billing_reaudit_item'],
  )
  const data = await collectAuditMonitor(fake.pool, QUERY)

  assert.equal(data.rows.length, 1)
  assert.equal(data.rows[0].reAuditStatus, null)
  assert.equal(data.rows[0].reAuditCompletedAt, null)
  assert.equal(data.rows[0].category, 'TIME_DURATION')
})

test('an exact Task ID scopes every status table without entering SQL text', async () => {
  const fake = fakePool([
    {
      match: 'COUNT(*) AS total_calls',
      rows: [{
        total_calls: 12,
        audited_calls: 3,
        recording_available: 7,
        pending_calls: 4,
        no_recording_calls: 5,
        processing_failures: 0,
      }],
    },
  ])
  const taskId = 'synthetic-task-search'
  const data = await collectAuditMonitor(fake.pool, {
    ...QUERY,
    taskId,
  })

  assert.equal(data.filters.taskId, taskId)
  assert.equal(data.pagination.totalRows, 0)
  assert.equal(data.pendingPagination.totalRows, 0)
  assert.equal(data.noRecordingPagination.totalRows, 0)
  assert.equal(data.summary.billAuditedCalls, 8)
  assert.equal(data.summary.aiAuditedCalls, 3)
  assert.equal(data.summary.auditCoveragePercent, '66.67')
  assert.equal(data.summary.pendingEligibleCalls, 4)
  assert.equal(data.summary.noRecordingCalls, 5)
  const scoped = fake.calls.filter(({ sql }) =>
    sql.includes('task_ref.external_id = ?'),
  )
  // Usage totals and model costs share one rollup query, so the task scope is
  // applied to eight independent reads rather than two duplicate usage scans.
  assert.ok(scoped.length >= 8)
  for (const call of scoped) {
    assert.equal(call.sql.includes(taskId), false)
    assert.doesNotMatch(call.sql, /\bLIKE\b/i)
    assert.ok(call.params.filter((value) => value === taskId).length >= 2)
  }
  assert.ok(scoped.some(({ sql }) => sql.includes(') pending')))
  assert.ok(scoped.some(({ sql }) => sql.includes("'no_recording'")))
  assert.ok(scoped.some(({ sql }) => sql.includes('grace_adjusted_duration_ms')))
})

test('bill-audit coverage resolves missing recordings and accepted KServe fallbacks', async () => {
  const fake = fakePool([
    {
      match: 'COUNT(*) AS total_calls',
      rows: [{
        total_calls: 12,
        audited_calls: 3,
        recording_available: 7,
        pending_calls: 4,
        no_recording_calls: 5,
        processing_failures: 4,
      }],
    },
    {
      match: 'AS accepted_fallback_calls',
      rows: [{
        accepted_fallback_calls: 2,
        accepted_failure_calls: 2,
      }],
    },
  ])

  const data = await collectAuditMonitor(fake.pool, QUERY, 'summary-core')
  const overallSql = fake.find('COUNT(*) AS total_calls') ?? ''
  const fallbackSql = fake.find('AS accepted_fallback_calls') ?? ''

  assert.equal(data.summary.billAuditedCalls, 10)
  assert.equal(data.summary.aiAuditedCalls, 3)
  assert.equal(data.summary.auditCoveragePercent, '83.33')
  assert.equal(data.summary.pendingEligibleCalls, 2)
  assert.equal(data.summary.processingFailureCalls, 2)
  assert.doesNotMatch(overallSql, /kaudit_billing_calculation/)
  assert.match(fallbackSql, /accepted_as_billed_unverified/)
  assert.equal(
    fallbackSql.match(/accepted_as_billed_unverified/g)?.length,
    1,
  )
  assert.match(fallbackSql, /idx_billing_calc_authority|calculation_basis/)
  assert.match(overallSql, /recording_available, 0\) = 0/)
})

test('accepted KServe fallbacks do not remain in the pending queue', async () => {
  const fake = fakePool([
    { match: 'auditor_final_charge', rows: [FINANCIAL_ROW] },
    { match: 'grace_adjusted_duration_ms', rows: [AUDITED_ROW] },
  ])

  await collectAuditMonitor(fake.pool, QUERY, 'rows')

  const pendingSql = fake.find('pending.processing_status') ?? ''
  assert.match(pendingSql, /accepted_as_billed_unverified/)
  assert.match(pendingSql, /resolved_calculation\.status = 'final'/)
})
