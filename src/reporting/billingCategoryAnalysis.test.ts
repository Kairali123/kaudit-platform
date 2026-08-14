import { test } from 'node:test'
import assert from 'node:assert/strict'
import type {
  BillingCategoryAnalysisPort,
  BillingCategoryCallRow,
  BillingCategoryPageScope,
  BillingCategoryTotalsRow,
} from '../adapters/mysqlBillingCategoryAnalysis.ts'
import { parseBillingMonth } from './billingMonth.ts'
import {
  buildBillingCategoryAnalysis,
  fixedMoney,
  minutesFromMs,
  parseBillingCategoryAnalysisQuery,
  sumDurationMs,
  sumMoney,
  toAllCategoriesKpi,
  BillingCategoryRequestError,
  MAX_PAGE_SIZE,
} from './billingCategoryAnalysis.ts'

/**
 * Category-analysis presentation contract.
 *
 * All fixtures are SYNTHETIC: no real call, task id, amount, or period appears
 * here. The money assertions are the point of the file — every total is proven
 * in fixed precision, including values a binary float would round.
 */

// ---------------------------------------------------------------------------
// Request bounds
// ---------------------------------------------------------------------------

function query(search: string): URLSearchParams {
  return new URLSearchParams(search)
}

test('an empty request is the first page of every category', () => {
  const parsed = parseBillingCategoryAnalysisQuery(query(''))
  assert.deepEqual(parsed, { page: 1, pageSize: 25, category: null })
})

test('the all-categories selection is not a category filter', () => {
  assert.equal(
    parseBillingCategoryAnalysisQuery(query('category=all')).category,
    null,
  )
  assert.equal(
    parseBillingCategoryAnalysisQuery(query('category=  ')).category,
    null,
  )
})

test('page and page size are bounded rather than silently coerced', () => {
  for (const search of [
    'page=0',
    'page=-3',
    'page=1.5',
    'page=nonsense',
    'page=100001',
    'pageSize=9',
    `pageSize=${MAX_PAGE_SIZE + 1}`,
  ]) {
    assert.throws(
      () => parseBillingCategoryAnalysisQuery(query(search)),
      (error: unknown) => {
        assert.ok(error instanceof BillingCategoryRequestError)
        assert.equal(error.status, 400)
        assert.equal(error.code, 'INVALID_BILLING_CATEGORY_QUERY')
        return true
      },
      search,
    )
  }
  assert.equal(
    parseBillingCategoryAnalysisQuery(query('page=7&pageSize=100')).page,
    7,
  )
})

test('a category that is not an outcome code is refused', () => {
  for (const search of [
    'category=DROP TABLE kaudit_call',
    "category=a'b",
    `category=${'x'.repeat(81)}`,
    'category=%20%3B',
  ]) {
    assert.throws(
      () => parseBillingCategoryAnalysisQuery(query(search)),
      BillingCategoryRequestError,
      search,
    )
  }
  assert.equal(
    parseBillingCategoryAnalysisQuery(query('category=PRODUCT_ENQUIRY'))
      .category,
    'PRODUCT_ENQUIRY',
  )
})

// ---------------------------------------------------------------------------
// Fixed-precision money
// ---------------------------------------------------------------------------

test('database decimals keep all eight places', () => {
  assert.equal(fixedMoney('9.5'), '9.50000000')
  assert.equal(fixedMoney('0'), '0.00000000')
  assert.equal(fixedMoney(null), '0.00000000')
  assert.equal(fixedMoney('-4.75'), '-4.75000000')
  assert.equal(fixedMoney('12.123456789'), '12.12345678')
  assert.throws(() => fixedMoney('nine rupees'), TypeError)
})

test('money is summed exactly, including places a float would lose', () => {
  assert.equal(sumMoney(['9.50000000', '4.75000000']), '14.25000000')
  assert.equal(
    sumMoney(['0.00000001', '0.00000001', '0.00000001']),
    '0.00000003',
  )
  // 0.1 + 0.2 is the canonical float failure; in scaled integers it is exact.
  assert.equal(sumMoney(['0.1', '0.2']), '0.30000000')
  // Beyond Number.MAX_SAFE_INTEGER once scaled by 1e8.
  assert.equal(
    sumMoney(['99999999.99999999', '0.00000001']),
    '100000000.00000000',
  )
  assert.equal(sumMoney(['-9.50000000', '9.50000000']), '0.00000000')
  assert.equal(sumMoney([]), '0.00000000')
})

// ---------------------------------------------------------------------------
// Durations
// ---------------------------------------------------------------------------

test('minutes are integer arithmetic, signed, and never invented', () => {
  assert.equal(minutesFromMs(180_000), '3.00')
  assert.equal(minutesFromMs(121_000), '2.02')
  assert.equal(minutesFromMs(59_000), '0.98')
  assert.equal(minutesFromMs(0), '0.00')
  // Half away from zero, symmetrically.
  assert.equal(minutesFromMs(300), '0.01')
  assert.equal(minutesFromMs(-300), '-0.01')
  assert.equal(minutesFromMs(299), '0.00')
  // A negative gap keeps its direction: the audit measured more than was billed.
  assert.equal(minutesFromMs(-61_000), '-1.02')
  // Absent is unknown, never 0.00.
  assert.equal(minutesFromMs(null), null)
})

test('a duration total sums only what exists', () => {
  assert.equal(sumDurationMs([180_000, null, 121_000]), 301_000)
  assert.equal(sumDurationMs([null, null]), null)
  assert.equal(sumDurationMs([]), null)
})

// ---------------------------------------------------------------------------
// Folding
// ---------------------------------------------------------------------------

function totalsRow(
  overrides: Partial<BillingCategoryTotalsRow> = {},
): BillingCategoryTotalsRow {
  return {
    category: 'PRODUCT_ENQUIRY',
    auditedCallCount: 2,
    kservePricedCalls: 2,
    kserveChargeInr: '19.00000000',
    auditorFinalPricedCalls: 1,
    auditorUnfinalizedCalls: 1,
    auditorFinalChargeInr: '9.50000000',
    kserveChargeTimeMs: 240_000,
    aiAuditedDurationMs: 181_000,
    aiAuditedDurationCalls: 2,
    comparableCalls: 2,
    gapMs: 59_000,
    ...overrides,
  }
}

test('the all-categories item is the exact sum of the categories shown', () => {
  const all = toAllCategoriesKpi([
    totalsRow(),
    totalsRow({
      category: 'NOT_CONNECTED',
      auditedCallCount: 1,
      kservePricedCalls: 1,
      kserveChargeInr: '4.75000000',
      auditorFinalPricedCalls: 0,
      auditorUnfinalizedCalls: 1,
      auditorFinalChargeInr: '0.00000000',
      kserveChargeTimeMs: 30_000,
      aiAuditedDurationMs: 61_000,
      aiAuditedDurationCalls: 1,
      comparableCalls: 1,
      gapMs: -31_000,
    }),
  ])
  assert.equal(all.category, 'all')
  assert.equal(all.isAllCategories, true)
  assert.equal(all.auditedCallCount, 3)
  assert.equal(all.kserveChargeInr, '23.75000000')
  assert.equal(all.auditorFinalChargeInr, '9.50000000')
  assert.equal(all.auditorFinalPricedCalls, 1)
  assert.equal(all.auditorUnfinalizedCalls, 2)
  // Two of three audited calls still have no final calculation.
  assert.equal(all.auditorMoneyComplete, false)
  assert.equal(all.kserveChargeTimeMs, 270_000)
  assert.equal(all.gapMs, 28_000)
  assert.equal(all.gapMinutes, '0.47')
})

test('a category with nothing recorded reports null durations, not zero', () => {
  const all = toAllCategoriesKpi([
    totalsRow({
      kserveChargeTimeMs: null,
      aiAuditedDurationMs: null,
      gapMs: null,
      comparableCalls: 0,
      kservePricedCalls: 0,
      aiAuditedDurationCalls: 0,
    }),
  ])
  assert.equal(all.kserveChargeTimeMinutes, null)
  assert.equal(all.aiAuditedDurationMinutes, null)
  assert.equal(all.gapMinutes, null)
  assert.equal(all.comparableCalls, 0)
})

// ---------------------------------------------------------------------------
// The DTO
// ---------------------------------------------------------------------------

function callRow(
  overrides: Partial<BillingCategoryCallRow> = {},
): BillingCategoryCallRow {
  return {
    callReference: 'SYNTHETIC-TASK-1',
    callDate: '2026-08-04',
    callStartAt: '2026-08-04 09:15:00',
    callEndAt: '2026-08-04 09:18:10',
    category: 'PRODUCT_ENQUIRY',
    kserveChargeTimeMs: 180_000,
    aiAuditedDurationMs: 121_000,
    gapMs: 59_000,
    recordingAvailable: true,
    ...overrides,
  }
}

function port(
  scopes: BillingCategoryPageScope[],
  totals: BillingCategoryTotalsRow[] = [
    totalsRow(),
    totalsRow({ category: 'NOT_CONNECTED', auditedCallCount: 1 }),
  ],
): BillingCategoryAnalysisPort {
  return {
    async listCategoryTotals() {
      return totals
    },
    async listCalls(scope) {
      scopes.push(scope)
      return [callRow()]
    },
  }
}

const AUGUST = parseBillingMonth('2026-08')

test('the KPI list leads with the all-categories selection', async () => {
  const dto = await buildBillingCategoryAnalysis(
    port([]),
    { page: 1, pageSize: 25, category: null },
    AUGUST,
  )
  assert.deepEqual(
    dto.categories.map((kpi) => kpi.category),
    ['all', 'PRODUCT_ENQUIRY', 'NOT_CONNECTED'],
  )
  assert.equal(dto.scope.category, 'all')
  assert.equal(dto.scope.month, '2026-08')
  assert.equal(dto.title, 'Category analysis')
  assert.equal(dto.rows.length, 1)
})

test('the page scope is bounded and offset from the requested page', async () => {
  const scopes: BillingCategoryPageScope[] = []
  await buildBillingCategoryAnalysis(
    port(scopes),
    { page: 3, pageSize: 25, category: 'PRODUCT_ENQUIRY' },
    AUGUST,
  )
  assert.deepEqual(scopes, [
    {
      periodStart: '2026-08-01',
      periodEnd: '2026-08-31',
      category: 'PRODUCT_ENQUIRY',
      limit: 25,
      offset: 50,
    },
  ])
})

test('totals describe the whole selected scope, not the page', async () => {
  const dto = await buildBillingCategoryAnalysis(
    port([]),
    { page: 1, pageSize: 25, category: 'PRODUCT_ENQUIRY' },
    AUGUST,
  )
  assert.equal(dto.totals.basis, 'entire_selected_scope')
  // One row is on the page; the totals still cover both audited calls.
  assert.equal(dto.rows.length, 1)
  assert.equal(dto.totals.auditedCallCount, 2)
  assert.equal(dto.totals.kserveChargeTimeMinutes, '4.00')
  assert.equal(dto.totals.gapMinutes, '0.98')
  assert.equal(dto.pagination.totalRows, 2)
  assert.equal(dto.pagination.totalPages, 1)
})

test('missing-duration audited calls are reported, never counted as money', async () => {
  const dto = await buildBillingCategoryAnalysis(
    port([]),
    { page: 1, pageSize: 25, category: null },
    AUGUST,
  )
  const all = dto.categories[0]
  assert.equal(all.auditorFinalChargeInr, '19.00000000')
  assert.equal(all.auditorFinalPricedCalls, 2)
  assert.equal(all.auditorUnfinalizedCalls, 2)
  assert.equal(all.auditorMoneyComplete, false)
  // The vendor figure keeps its own authority and is never blended in.
  assert.equal(all.kserveChargeInr, '38.00000000')
})

test('a category that is empty this month reports an empty scope', async () => {
  const dto = await buildBillingCategoryAnalysis(
    port([]),
    { page: 4, pageSize: 25, category: 'NOT_A_STORED_CATEGORY' },
    AUGUST,
  )
  assert.equal(dto.scope.category, 'NOT_A_STORED_CATEGORY')
  assert.equal(dto.totals.auditedCallCount, 0)
  assert.equal(dto.totals.kserveChargeInr, '0.00000000')
  assert.equal(dto.totals.gapMinutes, null)
  assert.equal(dto.pagination.totalRows, 0)
  assert.equal(dto.pagination.totalPages, 1)
})

test('no month means every stored period, stated as such', async () => {
  const scopes: BillingCategoryPageScope[] = []
  const dto = await buildBillingCategoryAnalysis(
    port(scopes),
    { page: 1, pageSize: 25, category: null },
    null,
  )
  assert.equal(dto.scope.month, null)
  assert.equal(dto.scope.monthLabel, 'All periods')
  assert.equal(scopes[0].periodStart, null)
  assert.equal(scopes[0].periodEnd, null)
})

test('the response carries no evidence, identity, or raw content field', async () => {
  const dto = await buildBillingCategoryAnalysis(
    port([]),
    { page: 1, pageSize: 25, category: null },
    AUGUST,
  )
  const keys = new Set<string>()
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) value.forEach(walk)
    else if (value && typeof value === 'object') {
      for (const [key, entry] of Object.entries(value)) {
        keys.add(key)
        walk(entry)
      }
    }
  }
  walk(dto)
  for (const forbidden of [
    'callId',
    'sourceUrl',
    'recordingUrl',
    'evidenceSha256',
    'sha256',
    'transcript',
    'segments',
    'sourceRowId',
    'leadId',
    'prompt',
    'rawResponse',
  ]) {
    assert.equal(keys.has(forbidden), false, `${forbidden} must not be returned`)
  }
})
