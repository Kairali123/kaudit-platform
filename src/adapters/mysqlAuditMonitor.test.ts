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
  language: null,
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
        },
      ],
    },
  ])
  const data = await collectAuditMonitor(fake.pool, QUERY)
  const row = data.rows[0]

  assert.equal(row.reAuditStatus, 'failed')
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
  assert.equal(data.summary.pendingEligibleCalls, 4)
  assert.equal(data.summary.noRecordingCalls, 5)
  const scoped = fake.calls.filter(({ sql }) =>
    sql.includes('task_ref.external_id = ?'),
  )
  assert.ok(scoped.length >= 9)
  for (const call of scoped) {
    assert.equal(call.sql.includes(taskId), false)
    assert.doesNotMatch(call.sql, /\bLIKE\b/i)
    assert.ok(call.params.filter((value) => value === taskId).length >= 2)
  }
  assert.ok(scoped.some(({ sql }) => sql.includes(') pending')))
  assert.ok(scoped.some(({ sql }) => sql.includes("'no_recording'")))
  assert.ok(scoped.some(({ sql }) => sql.includes('grace_adjusted_duration_ms')))
})
