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
  buildBillingCategoryPage,
  buildBillingCategorySummary,
  categoryLabelOf,
  BILLING_CATEGORY_CATALOG,
  BILLING_CATEGORY_ANALYSIS_ROUTE,
  BILLING_CATEGORY_SUMMARY_ROUTE,
  fixedMoney,
  minutesFromMs,
  percentageOf,
  parseBillingCategoryAnalysisQuery,
  sumDurationMs,
  sumMoney,
  subtractMoney,
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

test('KPI money gaps and shares use deterministic integer arithmetic', () => {
  assert.equal(subtractMoney('19.00000000', '9.50000000'), '9.50000000')
  assert.equal(percentageOf(1, 3), '33.33')
  assert.equal(percentageOf(0, 0), '0.00')
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
    category: 'TIME_DURATION',
    auditedCallCount: 2,
    issueFoundCount: 1,
    noIssueFoundCount: 1,
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
    category: 'TIME_DURATION',
    kserveChargeTimeMs: 180_000,
    kserveChargeInr: '19.00000000',
    aiAuditedDurationMs: 121_000,
    auditorFinalChargeInr: '19.00000000',
    aiConfidence: '0.95000000',
    aiAuditResult: 'Issue found',
    aiAuditRemark: 'Synthetic category rationale.',
    gapMs: 59_000,
    recordingAvailable: true,
    ...overrides,
  }
}

/**
 * A read model that records WHICH reads a builder made, so the split between
 * the month summary and the table page is proven rather than assumed: a page
 * request that touched a month aggregate would show up here.
 */
function port(
  scopes: BillingCategoryPageScope[],
  totals: BillingCategoryTotalsRow[] = [
    totalsRow(),
    totalsRow({
      category: 'AGENT_FAILURE',
      auditedCallCount: 1,
      issueFoundCount: 1,
      noIssueFoundCount: 0,
    }),
  ],
  reads: string[] = [],
): BillingCategoryAnalysisPort {
  return {
    async listCategoryTotals() {
      reads.push('listCategoryTotals')
      return totals
    },
    async listNoRecordingTotals() {
      reads.push('listNoRecordingTotals')
      return totalsRow({
        category: 'NO_RECORDING',
        auditedCallCount: 0,
        issueFoundCount: 0,
        noIssueFoundCount: 0,
        kservePricedCalls: 0,
        kserveChargeInr: '0',
        auditorFinalPricedCalls: 0,
        auditorUnfinalizedCalls: 0,
        auditorFinalChargeInr: '0',
        kserveChargeTimeMs: 0,
        aiAuditedDurationMs: 0,
        aiAuditedDurationCalls: 0,
        comparableCalls: 0,
        gapMs: 0,
      })
    },
    async listCalls(scope) {
      reads.push('listCalls')
      scopes.push(scope)
      return [callRow()]
    },
  }
}

const AUGUST = parseBillingMonth('2026-08')

const FIRST_PAGE = { page: 1, pageSize: 25, category: null }

function deepKeys(value: unknown, keys = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const entry of value) deepKeys(entry, keys)
  } else if (value && typeof value === 'object') {
    for (const [key, entry] of Object.entries(value)) {
      keys.add(key)
      deepKeys(entry, keys)
    }
  }
  return keys
}

// ---------------------------------------------------------------------------
// The month summary
// ---------------------------------------------------------------------------

test('the KPI list always contains all management categories', async () => {
  const dto = await buildBillingCategorySummary(port([]), AUGUST)
  assert.deepEqual(
    dto.categories.map((kpi) => kpi.category),
    [
      'all',
      ...BILLING_CATEGORY_CATALOG.map(({ category }) => category),
      'NO_RECORDING',
    ],
  )
  assert.equal(dto.categories.length, 10)
  assert.deepEqual(dto.summary, {
    totalAuditedCalls: 3,
    issueFoundCalls: 2,
    noIssueFoundCalls: 1,
  })
  const empty = dto.categories.find(
    ({ category }) => category === 'VOICEMAIL',
  )!
  assert.equal(empty.auditedCallCount, 0)
  assert.equal(empty.sharePercent, '0.00')
  assert.equal(empty.kserveChargeInr, '0.00000000')
  assert.equal(empty.auditorFinalChargeInr, '0.00000000')
  assert.equal(empty.chargeGapInr, '0.00000000')
  assert.equal(dto.scope.month, '2026-08')
  assert.equal(dto.title, 'Category analysis')
})

/**
 * The KPI a tile shows and the total the table footer shows are ONE object.
 * Stating the basis on every KPI is what lets the page display the selected one
 * as its scope total instead of deriving a second total from the rows on hand.
 */
test('every KPI declares itself a whole-scope total, not a page total', async () => {
  const dto = await buildBillingCategorySummary(port([]), AUGUST)
  for (const kpi of dto.categories) {
    assert.equal(kpi.basis, 'entire_selected_scope', kpi.category)
  }
  const selected = dto.categories.find(
    ({ category }) => category === 'TIME_DURATION',
  )!
  assert.equal(selected.auditedCallCount, 2)
  assert.equal(selected.kserveChargeTimeMinutes, '4.00')
  assert.equal(selected.gapMinutes, '0.98')
})

test('the month summary never reads a page of calls', async () => {
  const reads: string[] = []
  await buildBillingCategorySummary(port([], undefined, reads), AUGUST)
  assert.deepEqual(reads.sort(), [
    'listCategoryTotals',
    'listNoRecordingTotals',
  ])
})

test('no-recording charges are a ninth KPI and part of Grand Total only', async () => {
  const repository = port([])
  repository.listNoRecordingTotals = async () =>
    totalsRow({
      category: 'NO_RECORDING',
      auditedCallCount: 2,
      issueFoundCount: 0,
      noIssueFoundCount: 0,
      kservePricedCalls: 2,
      kserveChargeInr: '14.25000000',
      auditorFinalPricedCalls: 0,
      auditorUnfinalizedCalls: 0,
      auditorFinalChargeInr: '0',
      kserveChargeTimeMs: 90_000,
      aiAuditedDurationMs: 0,
      aiAuditedDurationCalls: 0,
      comparableCalls: 0,
      gapMs: 90_000,
    })
  const dto = await buildBillingCategorySummary(repository, AUGUST)
  const noRecording = dto.categories.find(
    ({ category }) => category === 'NO_RECORDING',
  )!
  assert.equal(dto.summary.totalAuditedCalls, 3)
  assert.equal(noRecording.auditedCallCount, 2)
  assert.equal(noRecording.kserveChargeTimeMinutes, '1.50')
  assert.equal(noRecording.aiAuditedDurationMinutes, '0.00')
  assert.equal(noRecording.kserveChargeInr, '14.25000000')
  assert.equal(noRecording.auditorFinalChargeInr, '0.00000000')
  assert.equal(noRecording.gapMinutes, '1.50')
  assert.equal(noRecording.chargeGapInr, '14.25000000')
  assert.equal(dto.grandTotal.auditedCallCount, 5)
  assert.equal(dto.grandTotal.kserveChargeInr, '52.25000000')
})

test('missing-duration audited calls are reported, never counted as money', async () => {
  const dto = await buildBillingCategorySummary(port([]), AUGUST)
  const all = dto.categories[0]
  assert.equal(all.auditorFinalChargeInr, '19.00000000')
  assert.equal(all.auditorFinalPricedCalls, 2)
  assert.equal(all.auditorUnfinalizedCalls, 2)
  assert.equal(all.auditorMoneyComplete, false)
  // The vendor figure keeps its own authority and is never blended in.
  assert.equal(all.kserveChargeInr, '38.00000000')
})

// ---------------------------------------------------------------------------
// The table page
// ---------------------------------------------------------------------------

test('the page scope is bounded and offset from the requested page', async () => {
  const scopes: BillingCategoryPageScope[] = []
  await buildBillingCategoryPage(
    port(scopes),
    { page: 3, pageSize: 25, category: 'TIME_DURATION' },
    AUGUST,
  )
  assert.deepEqual(scopes, [
    {
      periodStart: '2026-08-01',
      periodEnd: '2026-08-31',
      category: 'TIME_DURATION',
      limit: 25,
      offset: 50,
    },
  ])
})

/**
 * The point of the split: a selection performs exactly one bounded row read.
 * A regression that adds a count or folds the KPIs back into this response
 * shows up here as another repository call.
 */
test('a table page never reads a month aggregate', async () => {
  const reads: string[] = []
  await buildBillingCategoryPage(
    port([], undefined, reads),
    { ...FIRST_PAGE, category: 'TIME_DURATION' },
    AUGUST,
  )
  assert.deepEqual(reads, ['listCalls'])
})

test('the page response states only the bounded page it returned', async () => {
  const dto = await buildBillingCategoryPage(
    port([]),
    { page: 1, pageSize: 25, category: 'TIME_DURATION' },
    AUGUST,
  )
  assert.equal(dto.rows.length, 1)
  assert.equal(dto.pagination.page, 1)
  assert.equal(dto.pagination.pageSize, 25)
  assert.equal(dto.scope.category, 'TIME_DURATION')
  assert.equal(dto.scope.categoryLabel, 'Time duration')
  assert.equal(dto.scope.pageSize, 25)
  assert.equal(dto.rows[0].auditorFinalChargeInr, '19.00000000')
})

test('the all-categories selection is labelled and never filtered', async () => {
  const scopes: BillingCategoryPageScope[] = []
  const dto = await buildBillingCategoryPage(port(scopes), FIRST_PAGE, AUGUST)
  assert.equal(dto.scope.category, 'all')
  assert.equal(dto.scope.categoryLabel, 'All categories')
  assert.equal(scopes[0].category, null)
  assert.deepEqual(dto.pagination, { page: 1, pageSize: 25 })
})

test('a category that is empty this month reports an empty page', async () => {
  const dto = await buildBillingCategoryPage(
    port([]),
    { page: 4, pageSize: 25, category: 'NOT_A_STORED_CATEGORY' },
    AUGUST,
  )
  assert.equal(dto.scope.category, 'NOT_A_STORED_CATEGORY')
  // A code outside the catalog is displayed as itself, never guessed at.
  assert.equal(dto.scope.categoryLabel, 'NOT_A_STORED_CATEGORY')
  assert.deepEqual(dto.pagination, { page: 4, pageSize: 25 })
})

test('every selectable label comes from the catalog without a query', () => {
  assert.equal(categoryLabelOf('all'), 'All categories')
  assert.equal(categoryLabelOf('NO_RECORDING'), 'No Recording')
  for (const { category, label } of BILLING_CATEGORY_CATALOG) {
    assert.equal(categoryLabelOf(category), label)
  }
})

test('the two routes are distinct and both live under billing', () => {
  assert.equal(BILLING_CATEGORY_ANALYSIS_ROUTE, '/api/v1/billing/categories')
  assert.equal(
    BILLING_CATEGORY_SUMMARY_ROUTE,
    '/api/v1/billing/categories/summary',
  )
  assert.notEqual(
    BILLING_CATEGORY_ANALYSIS_ROUTE,
    BILLING_CATEGORY_SUMMARY_ROUTE,
  )
})

// ---------------------------------------------------------------------------
// Shared scope and privacy
// ---------------------------------------------------------------------------

test('no month means every stored period, stated as such', async () => {
  const scopes: BillingCategoryPageScope[] = []
  const page = await buildBillingCategoryPage(port(scopes), FIRST_PAGE, null)
  assert.equal(page.scope.month, null)
  assert.equal(page.scope.monthLabel, 'All periods')
  assert.equal(scopes[0].periodStart, null)
  assert.equal(scopes[0].periodEnd, null)
  const summary = await buildBillingCategorySummary(port([]), null)
  assert.equal(summary.scope.month, null)
  assert.equal(summary.scope.monthLabel, 'All periods')
})

test('neither response carries an evidence, identity, or raw content field', async () => {
  const responses = [
    await buildBillingCategorySummary(port([]), AUGUST),
    await buildBillingCategoryPage(port([]), FIRST_PAGE, AUGUST),
  ]
  for (const dto of responses) {
    const keys = deepKeys(dto)
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
      assert.equal(
        keys.has(forbidden),
        false,
        `${forbidden} must not be returned`,
      )
    }
  }
  // The month summary carries no per-call row at all, so an admin-only KPI read
  // cannot become a second way to reach call references.
  assert.equal(deepKeys(responses[0]).has('callReference'), false)
  assert.equal(deepKeys(responses[0]).has('rows'), false)
})
