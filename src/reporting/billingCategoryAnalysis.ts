import type {
  BillingCategoryCallRow,
  BillingCategoryPagePort,
  BillingCategorySummaryPort,
  BillingCategoryTotalsRow,
} from '../adapters/mysqlBillingCategoryAnalysis.ts'
import type { BillingMonthScope } from './billingMonth.ts'

/**
 * Presentation layer for the Billing Audit CATEGORY ANALYSIS page.
 *
 * It parses a narrow request, asks the dedicated read model for already-scoped
 * aggregates, and folds them into DTOs for the admin page. It is pure apart
 * from the repository calls: no SQL, no worker, no model call, no write.
 *
 * TWO responses, because they change on two different rhythms:
 *
 *   * the MONTH SUMMARY — the nine KPIs, the issue/no-issue counts and the
 *     Grand Total — describes a whole bill month and does not move when a
 *     reader picks a category or turns a page; and
 *   * the TABLE PAGE — one bounded page of audited calls — changes on every
 *     selection, and costs exactly ONE repository read.
 *
 * Folding them into one response made every KPI click re-derive a month of
 * per-category money, durations and shares to render twenty-five rows. Splitting
 * them keeps each read proportional to what actually changed; nothing about the
 * figures themselves differs, because both halves are still folded from the same
 * scoped aggregates by the same fixed-precision arithmetic below.
 *
 * The split is only worth having if the cheap half stays cheap, so the page
 * response does NOT restate the size of the scope it pages over. That figure is
 * the selected KPI's `auditedCallCount`, already on the month summary and
 * counted over the same population, so a second per-page count would buy a
 * number the reader is holding at the price of doubling every table request.
 *
 * Boundaries restated here because this is the layer that faces a browser:
 *
 *   * ADMINISTRATOR-ONLY. The rows carry per-call task references and drive the
 *     restricted admin review action, so the API and the page take the same
 *     `audit:inspect` gate and every read is access-logged by the server.
 *   * The DTO is assembled by explicit field copy. There is no recording URL,
 *     evidence hash, internal call id, transcript, source-row id, prompt, or
 *     provider prose field on any shape below, and none is derivable from one.
 *   * Money is fixed-precision TEXT throughout, summed in integer arithmetic.
 *     No amount is ever produced by JavaScript floating point, and the only
 *     auditor money is the capped audit projection produced by the read model:
 *     audited duration priced by the locked rule and capped per call at KServe.
 *     Audited calls without a priceable duration are reported separately rather
 *     than as a verified zero.
 *   * Durations are metadata. They are never formatted, summed, or labelled as
 *     money, and the locked billing ruleset is not reproduced or altered here.
 */

export const BILLING_CATEGORY_ANALYSIS_TITLE = 'Category analysis'

/**
 * The TABLE route: one bounded page of audited calls for one selection, served
 * by ONE repository read. It carries no month aggregate and no scope count —
 * the count is the KPI the summary route already reported.
 */
export const BILLING_CATEGORY_ANALYSIS_ROUTE = '/api/v1/billing/categories'

/**
 * The MONTH SUMMARY route: the KPIs, the issue/no-issue counts and the Grand
 * Total for one bill month. Scoped by month alone — no category, no page — so
 * one read serves every selection a reader makes while the month is open. It
 * carries the same per-call-free aggregates the page already displayed and
 * takes the SAME administrator-only gate as the table route.
 */
export const BILLING_CATEGORY_SUMMARY_ROUTE =
  '/api/v1/billing/categories/summary'

/**
 * The browser page that renders it. Named beside its API route because the two
 * carry the SAME administrator-only gate: hiding the nav item is presentation,
 * and a pasted URL has to be refused by the server as well.
 */
export const BILLING_CATEGORY_ANALYSIS_PAGE_ROUTE = '/billing/categories'

export const BILLING_CATEGORY_CONTENT_BOUNDARY =
  'Admin-only category analysis. Task references, stored call times, duration ' +
  'metadata, and bounded AI category remarks only — recordings, transcripts, ' +
  'evidence hashes, and ' +
  'internal identifiers stay server-side behind the restricted review route.'

/** The selection that means "every category in the month". */
export const ALL_CATEGORIES = 'all'

export const BILLING_CATEGORY_CATALOG = [
  {
    category: 'INCORRECT_CALL_DURATION',
    label: 'Incorrect call duration recording',
  },
  { category: 'AGENT_FAILURE', label: 'Agent failure' },
  {
    category: 'INACTIVE_CALL',
    label: 'Inactive call detection failure',
  },
  {
    category: 'AI_CONVERSATION_HANDLING',
    label: 'AI conversation handling failure',
  },
  { category: 'VOICEMAIL', label: 'Voicemail call' },
  { category: 'TIME_DURATION', label: 'Time duration' },
  { category: 'AI_TO_AI', label: 'AI to AI conversation' },
  {
    category: 'CONNECT_NOT_FRUITFUL',
    label: 'Connect but not fruitful',
  },
] as const

export const DEFAULT_PAGE_SIZE = 25
export const MIN_PAGE_SIZE = 10
export const MAX_PAGE_SIZE = 100
export const MAX_PAGE = 100_000

/** Canonical outcome codes are machine codes; anything else is not a category. */
const CATEGORY_PATTERN = /^[A-Za-z0-9_-]{1,80}$/

// ---------------------------------------------------------------------------
// Request parsing
// ---------------------------------------------------------------------------

/** A rejected request. Carries an HTTP status so the server can shape it. */
export class BillingCategoryRequestError extends Error {
  readonly code = 'INVALID_BILLING_CATEGORY_QUERY'
  readonly status = 400
  readonly field: string

  constructor(field: string, reason: string) {
    super(`${field}: ${reason}`)
    this.field = field
  }
}

export interface BillingCategoryAnalysisQuery {
  page: number
  pageSize: number
  /** Null means every category; a value is always a validated code. */
  category: string | null
}

function parseInteger(
  raw: string | null,
  field: string,
  fallback: number,
  min: number,
  max: number,
): number {
  if (raw === null || raw.trim() === '') return fallback
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new BillingCategoryRequestError(
      field,
      `must be an integer between ${min} and ${max}`,
    )
  }
  return value
}

/**
 * Parses and BOUNDS the whole request. An out-of-range page or an unrecognizable
 * category is refused with a 400 rather than silently coerced: a page that shows
 * a different scope from the one that was asked for is a reporting error.
 */
export function parseBillingCategoryAnalysisQuery(
  params: URLSearchParams,
): BillingCategoryAnalysisQuery {
  const rawCategory = params.get('category')?.trim() ?? ''
  const category =
    rawCategory === '' || rawCategory === ALL_CATEGORIES
      ? null
      : rawCategory
  if (category !== null && !CATEGORY_PATTERN.test(category)) {
    throw new BillingCategoryRequestError(
      'category',
      'must be an outcome category code',
    )
  }
  return {
    page: parseInteger(params.get('page'), 'page', 1, 1, MAX_PAGE),
    pageSize: parseInteger(
      params.get('pageSize'),
      'pageSize',
      DEFAULT_PAGE_SIZE,
      MIN_PAGE_SIZE,
      MAX_PAGE_SIZE,
    ),
    category,
  }
}

// ---------------------------------------------------------------------------
// Fixed-precision arithmetic. Integer only — never a binary float.
// ---------------------------------------------------------------------------

const MONEY_DECIMALS = 8
const MINUTE_DECIMALS = 2
const MILLISECONDS_PER_MINUTE = 60_000n
/** Scaling divisor for two-decimal minutes: 60000 / 100. */
const MINUTE_SCALE_DIVISOR =
  MILLISECONDS_PER_MINUTE / 10n ** BigInt(MINUTE_DECIMALS)

const DECIMAL_TEXT = /^(-?)(\d+)(?:\.(\d+))?$/

/**
 * A database decimal as a fixed-precision string with exactly eight places.
 *
 * The text is re-cut, never parsed into a number: a rupee amount that survived
 * DECIMAL(20,8) storage must not lose its last places to a float on the way to a
 * browser. Anything that is not a plain decimal is a bug, not a display case.
 */
export function fixedMoney(value: unknown): string {
  const raw = value == null ? '0' : String(value).trim()
  const match = DECIMAL_TEXT.exec(raw)
  if (!match) throw new TypeError('Database money value is invalid')
  return `${match[1]}${match[2]}.${(match[3] || '')
    .padEnd(MONEY_DECIMALS, '0')
    .slice(0, MONEY_DECIMALS)}`
}

function scaledMoney(value: string): bigint {
  const fixed = fixedMoney(value)
  const [whole, fraction] = fixed.replace('-', '').split('.')
  const magnitude = BigInt(`${whole}${fraction}`)
  return fixed.startsWith('-') ? -magnitude : magnitude
}

function unscaledMoney(value: bigint): string {
  const negative = value < 0n
  const digits = (negative ? -value : value)
    .toString()
    .padStart(MONEY_DECIMALS + 1, '0')
  const whole = digits.slice(0, -MONEY_DECIMALS)
  const fraction = digits.slice(-MONEY_DECIMALS)
  return `${negative ? '-' : ''}${whole}.${fraction}`
}

/**
 * Exact sum of fixed-precision money. Scaled integers throughout, so summing a
 * month of amounts cannot drift by a paisa the way repeated float addition can.
 */
export function sumMoney(values: readonly string[]): string {
  return unscaledMoney(
    values.reduce((total, value) => total + scaledMoney(value), 0n),
  )
}

/** Exact fixed-precision subtraction for a displayed monetary gap. */
export function subtractMoney(minuend: string, subtrahend: string): string {
  return unscaledMoney(scaledMoney(minuend) - scaledMoney(subtrahend))
}

/** A count's share of the month, rounded to two decimal places. */
export function percentageOf(count: number, total: number): string {
  if (total === 0) return '0.00'
  const scaled = (BigInt(count) * 10_000n + BigInt(total) / 2n) / BigInt(total)
  const digits = scaled.toString().padStart(3, '0')
  return `${digits.slice(0, -2)}.${digits.slice(-2)}`
}

/**
 * Milliseconds as minutes with two places, half away from zero, in integer
 * arithmetic. The sign is preserved so a negative gap still reads as negative,
 * and null stays null: an absent duration is unknown, never 0.00.
 */
export function minutesFromMs(value: number | null): string | null {
  if (value == null) return null
  if (!Number.isFinite(value)) {
    throw new TypeError('Duration must be a finite millisecond count')
  }
  const total = BigInt(Math.trunc(value))
  const negative = total < 0n
  const magnitude = negative ? -total : total
  const quotient = magnitude / MINUTE_SCALE_DIVISOR
  const remainder = magnitude % MINUTE_SCALE_DIVISOR
  const scaled =
    remainder * 2n >= MINUTE_SCALE_DIVISOR ? quotient + 1n : quotient
  const digits = scaled.toString().padStart(MINUTE_DECIMALS + 1, '0')
  const whole = digits.slice(0, -MINUTE_DECIMALS)
  const fraction = digits.slice(-MINUTE_DECIMALS)
  return `${negative && scaled !== 0n ? '-' : ''}${whole}.${fraction}`
}

/** Sum of the durations that exist. Null when none of them did. */
export function sumDurationMs(
  values: readonly (number | null)[],
): number | null {
  const present = values.filter(
    (value): value is number => value != null,
  )
  return present.length === 0
    ? null
    : present.reduce((total, value) => total + value, 0)
}

// ---------------------------------------------------------------------------
// DTO
// ---------------------------------------------------------------------------

/**
 * One selectable category KPI, reported over the WHOLE selected month rather
 * than over a page.
 */
export interface BillingCategoryKpi {
  /** Canonical outcome code, or `all` for the aggregate selection. */
  category: string
  label: string
  isAllCategories: boolean
  auditedCallCount: number
  /** Share of all KPI calls in the selected month. */
  sharePercent: string
  /** Vendor-asserted money from final billed-minute evidence. */
  kserveChargeInr: string
  kservePricedCalls: number
  /** Capped auditor amount: never greater than KServe for the same call. */
  auditorFinalChargeInr: string
  /** Vendor charge minus capped auditor charge. */
  chargeGapInr: string
  auditorFinalPricedCalls: number
  /** Audited calls with no priceable audited duration: no auditor money. */
  auditorUnfinalizedCalls: number
  /** False while any audited call in the category still lacks an auditor amount. */
  auditorMoneyComplete: boolean
  kserveChargeTimeMs: number | null
  kserveChargeTimeMinutes: string | null
  kserveChargeTimeCalls: number
  aiAuditedDurationMs: number | null
  aiAuditedDurationMinutes: string | null
  aiAuditedDurationCalls: number
  /** Aggregate KServe billed total minus aggregate AI-audited total. Signed. */
  gapMs: number | null
  gapMinutes: string | null
  comparableCalls: number
}

export interface BillingCategoryCall {
  callReference: string
  callDate: string | null
  callStartAt: string | null
  callEndAt: string | null
  category: string
  kserveChargeTimeMs: number | null
  kserveChargeTimeMinutes: string | null
  kserveChargeInr: string
  aiAuditedDurationMs: number | null
  aiAuditedDurationMinutes: string | null
  auditorFinalChargeInr: string | null
  aiConfidence: string | null
  aiAuditResult: 'Issue found' | 'No issue found'
  aiAuditRemark: string | null
  gapMs: number | null
  gapMinutes: string | null
  /** Presence signal for the review action. Never a URL. */
  recordingAvailable: boolean
}

/**
 * Which page this response IS — not how many exist.
 *
 * The size of the selected scope is the KPI's `auditedCallCount` on the month
 * summary, so it is not restated here and not counted again per page. What the
 * page must state is which slice it actually returned, so a reader that asked
 * for one page and is still holding another can say which one is on screen.
 */
export interface BillingCategoryPagination {
  page: number
  pageSize: number
}

/**
 * Duration vocabulary, stated on the response so a reader never has to guess
 * which clock a column is on.
 */
export interface BillingCategoryDurationBasis {
  kserveChargeTime: 'final_vendor_billed_minutes'
  kserveChargeTimeLabel: string
  aiAuditedDuration: 'grace_adjusted_audited_duration'
  aiAuditedDurationLabel: string
  gap: 'kserve_billed_minus_ai_audited'
  gapLabel: string
}

export const BILLING_CATEGORY_DURATION_BASIS: BillingCategoryDurationBasis = {
  kserveChargeTime: 'final_vendor_billed_minutes',
  kserveChargeTimeLabel:
    'KServe charge time is the final vendor-asserted billed minutes for the ' +
    'call — the time the vendor charges for.',
  aiAuditedDuration: 'grace_adjusted_audited_duration',
  aiAuditedDurationLabel:
    'AI-audited duration is the grace-adjusted audited duration: audit ' +
    'metadata used for the capped auditor amount; the amount is capped per ' +
    'call at KServe charge.',
  gap: 'kserve_billed_minus_ai_audited',
  gapLabel:
    'Gap is KServe billed duration minus AI-audited duration. The sign is ' +
    'preserved: negative means the audit measured more time than was billed.',
}

/**
 * The month-level response: everything on the page that describes the WHOLE
 * bill month and is therefore identical for every category a reader selects.
 *
 * It carries no rows, no page and no category selection, so a reader who clicks
 * through all nine KPIs reads it once. Each KPI already reports the totals for
 * its entire category, which is what the table footer displays for the selected
 * scope — the footer and the tile are literally the same server-computed object,
 * so they cannot disagree, and no total is ever re-derived in a browser. The
 * same KPI's `auditedCallCount` is what sizes the table's pager, which is why
 * the page response does not count its own scope again.
 */
export interface BillingCategorySummaryDto {
  generatedAt: string
  title: typeof BILLING_CATEGORY_ANALYSIS_TITLE
  contentBoundary: typeof BILLING_CATEGORY_CONTENT_BOUNDARY
  scope: {
    month: string | null
    monthLabel: string
  }
  durationBasis: BillingCategoryDurationBasis
  summary: {
    totalAuditedCalls: number
    issueFoundCalls: number
    noIssueFoundCalls: number
  }
  /**
   * The management KPIs, plus the audited all-categories selection. Each is
   * `basis: 'entire_selected_scope'`: a KPI is a whole-category total, never a
   * page total, whether it is read as a tile or as the table footer.
   */
  categories: BillingCategoryScopeKpi[]
  /** Audited categories plus KServe-charged calls with no recording. */
  grandTotal: BillingCategoryKpi
  authority: 'automated'
}

/** A KPI stated as what it is: the totals for an entire category in the month. */
export type BillingCategoryScopeKpi = BillingCategoryKpi & {
  basis: 'entire_selected_scope'
}

/**
 * The page-level response: one bounded page of audited calls for one selection.
 *
 * Deliberately narrow. It does not restate the KPIs, the summary or the Grand
 * Total, because those belong to the month and not to a page — restating them
 * is what forced a month-wide recomputation on every click.
 */
export interface BillingCategoryPageDto {
  generatedAt: string
  title: typeof BILLING_CATEGORY_ANALYSIS_TITLE
  contentBoundary: typeof BILLING_CATEGORY_CONTENT_BOUNDARY
  scope: {
    month: string | null
    monthLabel: string
    category: string
    categoryLabel: string
    pageSize: number
  }
  durationBasis: BillingCategoryDurationBasis
  rows: BillingCategoryCall[]
  /** Which page these rows are. The scope's size is the KPI's call count. */
  pagination: BillingCategoryPagination
  authority: 'automated'
}

// ---------------------------------------------------------------------------
// Folding
// ---------------------------------------------------------------------------

const ALL_CATEGORIES_LABEL = 'All categories'
export const NO_RECORDING_CATEGORY = 'NO_RECORDING'
const NO_RECORDING_LABEL = 'No Recording'

/**
 * Display labels for every selection the page can make, resolved without a
 * query. The table response needs the label of the selection it is describing,
 * and reading it from the catalog keeps that heading identical to the KPI tile's
 * without making a page read the month's aggregates to learn its own name.
 */
const CATEGORY_LABELS = new Map<string, string>([
  [ALL_CATEGORIES, ALL_CATEGORIES_LABEL],
  ...BILLING_CATEGORY_CATALOG.map(
    ({ category, label }) => [category, label] as [string, string],
  ),
  [NO_RECORDING_CATEGORY, NO_RECORDING_LABEL],
])

/** A category not in the catalog is displayed as its own code, never guessed. */
export function categoryLabelOf(category: string): string {
  return CATEGORY_LABELS.get(category) ?? category
}

function kpiFrom(
  category: string,
  label: string,
  isAllCategories: boolean,
  allAuditedCallCount: number,
  totals: {
    auditedCallCount: number
    kserveChargeInr: string
    kservePricedCalls: number
    auditorFinalChargeInr: string
    auditorFinalPricedCalls: number
    auditorUnfinalizedCalls: number
    kserveChargeTimeMs: number | null
    aiAuditedDurationMs: number | null
    aiAuditedDurationCalls: number
    comparableCalls: number
    gapMs: number | null
  },
): BillingCategoryKpi {
  return {
    category,
    label,
    isAllCategories,
    auditedCallCount: totals.auditedCallCount,
    sharePercent: percentageOf(
      totals.auditedCallCount,
      allAuditedCallCount,
    ),
    kserveChargeInr: fixedMoney(totals.kserveChargeInr),
    kservePricedCalls: totals.kservePricedCalls,
    auditorFinalChargeInr: fixedMoney(totals.auditorFinalChargeInr),
    chargeGapInr: subtractMoney(
      totals.kserveChargeInr,
      totals.auditorFinalChargeInr,
    ),
    auditorFinalPricedCalls: totals.auditorFinalPricedCalls,
    auditorUnfinalizedCalls: totals.auditorUnfinalizedCalls,
    auditorMoneyComplete: totals.auditorUnfinalizedCalls === 0,
    kserveChargeTimeMs: totals.kserveChargeTimeMs,
    kserveChargeTimeMinutes: minutesFromMs(totals.kserveChargeTimeMs),
    kserveChargeTimeCalls: totals.kservePricedCalls,
    aiAuditedDurationMs: totals.aiAuditedDurationMs,
    aiAuditedDurationMinutes: minutesFromMs(totals.aiAuditedDurationMs),
    aiAuditedDurationCalls: totals.aiAuditedDurationCalls,
    gapMs: totals.gapMs,
    gapMinutes: minutesFromMs(totals.gapMs),
    comparableCalls: totals.comparableCalls,
  }
}

export function toCategoryKpi(
  row: BillingCategoryTotalsRow,
  allAuditedCallCount: number = row.auditedCallCount,
  label: string = row.category,
): BillingCategoryKpi {
  return kpiFrom(row.category, label, false, allAuditedCallCount, row)
}

/**
 * The all-categories selection, folded from the per-category rows rather than
 * read again, so the aggregate is exactly the sum of what the page displays.
 * Money is summed in scaled integers; durations are summed only where present.
 */
export function toAllCategoriesKpi(
  rows: readonly BillingCategoryTotalsRow[],
): BillingCategoryKpi {
  const sum = (pick: (row: BillingCategoryTotalsRow) => number): number =>
    rows.reduce((total, row) => total + pick(row), 0)
  const auditedCallCount = sum((row) => row.auditedCallCount)
  return kpiFrom(ALL_CATEGORIES, ALL_CATEGORIES_LABEL, true, auditedCallCount, {
    auditedCallCount,
    kserveChargeInr: sumMoney(rows.map((row) => row.kserveChargeInr)),
    kservePricedCalls: sum((row) => row.kservePricedCalls),
    auditorFinalChargeInr: sumMoney(
      rows.map((row) => row.auditorFinalChargeInr),
    ),
    auditorFinalPricedCalls: sum((row) => row.auditorFinalPricedCalls),
    auditorUnfinalizedCalls: sum((row) => row.auditorUnfinalizedCalls),
    kserveChargeTimeMs: sumDurationMs(
      rows.map((row) => row.kserveChargeTimeMs),
    ),
    aiAuditedDurationMs: sumDurationMs(
      rows.map((row) => row.aiAuditedDurationMs),
    ),
    aiAuditedDurationCalls: sum((row) => row.aiAuditedDurationCalls),
    comparableCalls: sum((row) => row.comparableCalls),
    gapMs: sumDurationMs(rows.map((row) => row.gapMs)),
  })
}

/** An empty selection: real zero counts, but no invented durations or money. */
function emptyKpi(
  category: string,
  label: string,
  allAuditedCallCount = 0,
): BillingCategoryKpi {
  return kpiFrom(category, label, category === ALL_CATEGORIES, allAuditedCallCount, {
    auditedCallCount: 0,
    kserveChargeInr: '0',
    kservePricedCalls: 0,
    auditorFinalChargeInr: '0',
    auditorFinalPricedCalls: 0,
    auditorUnfinalizedCalls: 0,
    kserveChargeTimeMs: null,
    aiAuditedDurationMs: null,
    aiAuditedDurationCalls: 0,
    comparableCalls: 0,
    gapMs: null,
  })
}

export function toCategoryCall(
  row: BillingCategoryCallRow,
): BillingCategoryCall {
  return {
    callReference: row.callReference,
    callDate: row.callDate,
    callStartAt: row.callStartAt,
    callEndAt: row.callEndAt,
    category: row.category,
    kserveChargeTimeMs: row.kserveChargeTimeMs,
    kserveChargeTimeMinutes: minutesFromMs(row.kserveChargeTimeMs),
    kserveChargeInr: fixedMoney(row.kserveChargeInr),
    aiAuditedDurationMs: row.aiAuditedDurationMs,
    aiAuditedDurationMinutes: minutesFromMs(row.aiAuditedDurationMs),
    auditorFinalChargeInr:
      row.auditorFinalChargeInr == null
        ? null
        : fixedMoney(row.auditorFinalChargeInr),
    aiConfidence: row.aiConfidence,
    aiAuditResult: row.aiAuditResult,
    aiAuditRemark: row.aiAuditRemark,
    gapMs: row.gapMs,
    gapMinutes: minutesFromMs(row.gapMs),
    recordingAvailable: row.recordingAvailable,
  }
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

function monthScope(month: BillingMonthScope | null): {
  periodStart: string | null
  periodEnd: string | null
} {
  return {
    periodStart: month?.start ?? null,
    periodEnd: month?.end ?? null,
  }
}

/**
 * Builds the MONTH SUMMARY DTO: the nine KPIs, the issue/no-issue summary and
 * the Grand Total for one bill month.
 *
 * Two reads only — audited per-category totals and the no-recording aggregate —
 * and neither depends on a category or a page, so this is the read a reader
 * makes once per month rather than once per click. Every KPI reports the totals
 * for its whole category, which is why the table footer can display the selected
 * KPI directly instead of asking for a second, separately-derived total.
 */
export async function buildBillingCategorySummary(
  repository: BillingCategorySummaryPort,
  month: BillingMonthScope | null,
  now: Date = new Date(),
): Promise<BillingCategorySummaryDto> {
  const scope = monthScope(month)
  const [totalsRows, noRecordingRow] = await Promise.all([
    repository.listCategoryTotals(scope),
    repository.listNoRecordingTotals(scope),
  ])
  const allCategories = toAllCategoriesKpi(totalsRows)
  const populationCount =
    allCategories.auditedCallCount + noRecordingRow.auditedCallCount
  const totalsByCategory = new Map(
    totalsRows.map((row) => [row.category, row] as const),
  )
  const categories = [
    allCategories,
    ...BILLING_CATEGORY_CATALOG.map(({ category, label }) => {
      const row = totalsByCategory.get(category)
      return row
        ? toCategoryKpi(row, populationCount, label)
        : emptyKpi(category, label, populationCount)
    }),
    toCategoryKpi(noRecordingRow, populationCount, NO_RECORDING_LABEL),
  ]
  return {
    generatedAt: now.toISOString(),
    title: BILLING_CATEGORY_ANALYSIS_TITLE,
    contentBoundary: BILLING_CATEGORY_CONTENT_BOUNDARY,
    scope: {
      month: month?.month ?? null,
      monthLabel: month?.label ?? 'All periods',
    },
    durationBasis: BILLING_CATEGORY_DURATION_BASIS,
    summary: {
      totalAuditedCalls: allCategories.auditedCallCount,
      issueFoundCalls: totalsRows.reduce(
        (total, row) => total + row.issueFoundCount,
        0,
      ),
      noIssueFoundCalls: totalsRows.reduce(
        (total, row) => total + row.noIssueFoundCount,
        0,
      ),
    },
    categories: categories.map((kpi) => ({
      ...kpi,
      basis: 'entire_selected_scope' as const,
    })),
    grandTotal: toAllCategoriesKpi([...totalsRows, noRecordingRow]),
    authority: 'automated',
  }
}

/**
 * Builds the TABLE PAGE DTO: one bounded page of audited calls.
 *
 * ONE read — the bounded page itself — and it is proportional to the page, not
 * to the month. There is no companion count: the size of the selected scope is
 * the KPI's `auditedCallCount`, which the month summary already reported for
 * every category and which counts the same population this page reads from.
 * Counting it again here would double every table request for a figure the
 * reader is already holding.
 */
export async function buildBillingCategoryPage(
  repository: BillingCategoryPagePort,
  query: BillingCategoryAnalysisQuery,
  month: BillingMonthScope | null,
  now: Date = new Date(),
): Promise<BillingCategoryPageDto> {
  const callRows = await repository.listCalls({
    ...monthScope(month),
    category: query.category,
    limit: query.pageSize,
    offset: (query.page - 1) * query.pageSize,
  })
  const category = query.category ?? ALL_CATEGORIES
  return {
    generatedAt: now.toISOString(),
    title: BILLING_CATEGORY_ANALYSIS_TITLE,
    contentBoundary: BILLING_CATEGORY_CONTENT_BOUNDARY,
    scope: {
      month: month?.month ?? null,
      monthLabel: month?.label ?? 'All periods',
      category,
      categoryLabel: categoryLabelOf(category),
      pageSize: query.pageSize,
    },
    durationBasis: BILLING_CATEGORY_DURATION_BASIS,
    rows: callRows.map(toCategoryCall),
    pagination: { page: query.page, pageSize: query.pageSize },
    authority: 'automated',
  }
}
