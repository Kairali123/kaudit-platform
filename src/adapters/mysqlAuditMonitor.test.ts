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
 *      over synthetic tables, so supersession and the "no final calculation"
 *      case are proven rather than asserted as text; and
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

/**
 * Runs the production summary SQL over synthetic tables.
 *
 * The scoped relation is supplied as literal rows, standing in for the audited
 * calls the monitor filter selected, so this exercises the money aggregation
 * without reproducing the audited-call join.
 */
function summarize(fixture: {
  scopedCallIds: string[]
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
      .map((id) => `SELECT '${id}' AS id`)
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

test('an audited call with no final calculation releases no auditor money', () => {
  const totals = summarize({
    scopedCallIds: ['call-synthetic-1'],
    providerCosts: [VENDOR_MINUTES],
  })
  assert.equal(totals.auditedCalls, 1)
  assert.equal(totals.auditorFinalPricedCalls, 0)
  assert.equal(totals.auditorUnfinalizedCalls, 1)
  assert.equal(totals.auditorFinalCharge, 0)
})

test('a draft calculation is not final money either', () => {
  const totals = summarize({
    scopedCallIds: ['call-synthetic-1'],
    calculations: [
      {
        id: 'calc-draft',
        callId: 'call-synthetic-1',
        status: 'draft',
        totalAmount: '9.50000000',
        calculatedAt: '2026-08-01 00:00:00',
      },
    ],
  })
  assert.equal(totals.auditorFinalPricedCalls, 0)
  assert.equal(totals.auditorUnfinalizedCalls, 1)
  assert.equal(totals.auditorFinalCharge, 0)
})

test('a current final calculation is counted exactly once', () => {
  const totals = summarize({
    scopedCallIds: ['call-synthetic-1'],
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
  assert.equal(totals.auditorFinalPricedCalls, 1)
  assert.equal(totals.auditorUnfinalizedCalls, 0)
  assert.equal(totals.auditorFinalCharge, 9.5)
})

test('a superseded final calculation is excluded and its replacement counted once', () => {
  const totals = summarize({
    scopedCallIds: ['call-synthetic-1'],
    calculations: [
      {
        id: 'calc-superseded',
        callId: 'call-synthetic-1',
        status: 'final',
        totalAmount: '19.00000000',
        calculatedAt: '2026-08-01 00:00:00',
      },
      {
        id: 'calc-replacement',
        callId: 'call-synthetic-1',
        status: 'final',
        totalAmount: '9.50000000',
        calculatedAt: '2026-08-02 00:00:00',
        supersedesCalculationId: 'calc-superseded',
      },
    ],
  })
  assert.equal(totals.auditorFinalPricedCalls, 1)
  assert.equal(totals.auditorUnfinalizedCalls, 0)
  assert.equal(totals.auditorFinalCharge, 9.5)
})

test('two unsuperseded final rows on one call still release one amount', () => {
  const totals = summarize({
    scopedCallIds: ['call-synthetic-1'],
    calculations: [
      {
        id: 'calc-older',
        callId: 'call-synthetic-1',
        status: 'final',
        totalAmount: '19.00000000',
        calculatedAt: '2026-08-01 00:00:00',
      },
      {
        id: 'calc-newer',
        callId: 'call-synthetic-1',
        status: 'final',
        totalAmount: '9.50000000',
        calculatedAt: '2026-08-02 00:00:00',
      },
    ],
  })
  assert.equal(totals.auditorFinalPricedCalls, 1)
  assert.equal(totals.auditorFinalCharge, 9.5)
})

test('finalized and unfinalized calls are reported distinctly in one scope', () => {
  const totals = summarize({
    scopedCallIds: ['call-synthetic-1', 'call-synthetic-2', 'call-synthetic-3'],
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
  assert.equal(totals.auditedCalls, 3)
  assert.equal(totals.auditorFinalPricedCalls, 1)
  assert.equal(totals.auditorUnfinalizedCalls, 2)
  // Only the finalized call contributes; the two audited-but-unpriced calls
  // are never projected into money.
  assert.equal(totals.auditorFinalCharge, 9.5)
})

test('the KServe charge aggregates independently of any auditor calculation', () => {
  const vendorOnly = summarize({
    scopedCallIds: ['call-synthetic-1'],
    providerCosts: [VENDOR_MINUTES],
  })
  assert.equal(vendorOnly.kservePricedCalls, 1)
  assert.equal(vendorOnly.kserveCharge, 19)
  assert.equal(vendorOnly.auditorFinalCharge, 0)

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
  assert.equal(withFinalCalculation.auditorFinalCharge, 9.5)
})

test('a non-final provider cost row is not vendor-priced evidence', () => {
  const totals = summarize({
    scopedCallIds: ['call-synthetic-1'],
    providerCosts: [{ ...VENDOR_MINUTES, isFinal: 0 }],
  })
  assert.equal(totals.kservePricedCalls, 0)
  assert.equal(totals.kserveCharge, 0)
})

test('the summary SQL never synthesizes money from duration facts', () => {
  const sql = auditedFinancialSummarySql('SELECT 1 AS id')
  assert.equal(/conversation_end_ms/.test(sql), false)
  assert.equal(/adjusted_chargeable/.test(sql), false)
  assert.equal(/CEIL\(/.test(sql), false)
  assert.equal(/4\.75/.test(sql), false)
  // The only auditor money in the statement is the stored final amount.
  assert.match(sql, /SUM\(final_calculation\.total_amount\)/)
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

function fakePool(rules: RowRule[]) {
  const statements: string[] = []
  const pool = {
    async query(sql: string) {
      statements.push(sql)
      const rule = rules.find((candidate) => sql.includes(candidate.match))
      return [rule ? rule.rows : []]
    },
  } as unknown as Pool
  return {
    pool,
    statements,
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

test('the response separates final auditor money from unfinalized audited calls', async () => {
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

  const listing = fake.find('grace_adjusted_duration_ms') ?? ''
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
