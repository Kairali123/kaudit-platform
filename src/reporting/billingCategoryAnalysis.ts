import type {
  BillingCategoryAnalysisPort,
  BillingCategoryCallRow,
  BillingCategoryTotalsRow,
} from '../adapters/mysqlBillingCategoryAnalysis.ts'
import type { BillingMonthScope } from './billingMonth.ts'

/**
 * Presentation layer for the Billing Audit CATEGORY ANALYSIS page.
 *
 * It parses a narrow request, asks the dedicated read model for already-scoped
 * aggregates, and folds them into a DTO for the admin page. It is pure apart
 * from the two repository calls: no SQL, no worker, no model call, no write.
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

export const BILLING_CATEGORY_ANALYSIS_ROUTE = '/api/v1/billing/categories'

/**
 * The browser page that renders it. Named beside its API route because the two
 * carry the SAME administrator-only gate: hiding the nav item is presentation,
 * and a pasted URL has to be refused by the server as well.
 */
export const BILLING_CATEGORY_ANALYSIS_PAGE_ROUTE = '/billing/categories'

export const BILLING_CATEGORY_CONTENT_BOUNDARY =
  'Admin-only category analysis. Task references, stored call times, and ' +
  'duration metadata only — recordings, transcripts, evidence hashes, and ' +
  'internal identifiers stay server-side behind the restricted review route.'

/** The selection that means "every category in the month". */
export const ALL_CATEGORIES = 'all'

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
  /** Vendor-asserted money from final billed-minute evidence. */
  kserveChargeInr: string
  kservePricedCalls: number
  /** Capped auditor amount: never greater than KServe for the same call. */
  auditorFinalChargeInr: string
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
  /** KServe billed minus AI-audited, over comparable calls only. Signed. */
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
  aiAuditedDurationMs: number | null
  aiAuditedDurationMinutes: string | null
  gapMs: number | null
  gapMinutes: string | null
  /** Presence signal for the review action. Never a URL. */
  recordingAvailable: boolean
}

export interface BillingCategoryPagination {
  page: number
  pageSize: number
  totalRows: number
  totalPages: number
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

export interface BillingCategoryAnalysisDto {
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
  /** One KPI per available category, plus the all-categories selection. */
  categories: BillingCategoryKpi[]
  rows: BillingCategoryCall[]
  /**
   * Totals for the ENTIRE selected scope, not for the current page. It is the
   * selected KPI itself, so a footer can never disagree with the tile above it.
   */
  totals: BillingCategoryKpi & { basis: 'entire_selected_scope' }
  pagination: BillingCategoryPagination
  authority: 'automated'
}

// ---------------------------------------------------------------------------
// Folding
// ---------------------------------------------------------------------------

const ALL_CATEGORIES_LABEL = 'All categories'

function kpiFrom(
  category: string,
  label: string,
  isAllCategories: boolean,
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
    kserveChargeInr: fixedMoney(totals.kserveChargeInr),
    kservePricedCalls: totals.kservePricedCalls,
    auditorFinalChargeInr: fixedMoney(totals.auditorFinalChargeInr),
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
): BillingCategoryKpi {
  return kpiFrom(row.category, row.category, false, row)
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
  return kpiFrom(ALL_CATEGORIES, ALL_CATEGORIES_LABEL, true, {
    auditedCallCount: sum((row) => row.auditedCallCount),
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
function emptyKpi(category: string, label: string): BillingCategoryKpi {
  return kpiFrom(category, label, category === ALL_CATEGORIES, {
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
    aiAuditedDurationMs: row.aiAuditedDurationMs,
    aiAuditedDurationMinutes: minutesFromMs(row.aiAuditedDurationMs),
    gapMs: row.gapMs,
    gapMinutes: minutesFromMs(row.gapMs),
    recordingAvailable: row.recordingAvailable,
  }
}

export function paginationOf(
  page: number,
  pageSize: number,
  totalRows: number,
): BillingCategoryPagination {
  return {
    page,
    pageSize,
    totalRows,
    totalPages: Math.max(1, Math.ceil(totalRows / pageSize)),
  }
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

/**
 * Builds the category-analysis DTO.
 *
 * Two reads only: the month's per-category totals, and one page of calls. The
 * page's total row count is taken from the selected category's own totals rather
 * than from a third count query, so the footer, the tile and the pager can never
 * describe three different scopes.
 */
export async function buildBillingCategoryAnalysis(
  repository: BillingCategoryAnalysisPort,
  query: BillingCategoryAnalysisQuery,
  month: BillingMonthScope | null,
  now: Date = new Date(),
): Promise<BillingCategoryAnalysisDto> {
  const scope = {
    periodStart: month?.start ?? null,
    periodEnd: month?.end ?? null,
  }
  const [totalsRows, callRows] = await Promise.all([
    repository.listCategoryTotals(scope),
    repository.listCalls({
      ...scope,
      category: query.category,
      limit: query.pageSize,
      offset: (query.page - 1) * query.pageSize,
    }),
  ])
  const categories = [
    toAllCategoriesKpi(totalsRows),
    ...totalsRows.map(toCategoryKpi),
  ]
  const selectedCategory = query.category ?? ALL_CATEGORIES
  const selected =
    categories.find(
      (candidate) => candidate.category === selectedCategory,
    ) ??
    // A category that holds nothing this month is still a legitimate
    // selection; it reports an empty scope rather than another category's.
    emptyKpi(selectedCategory, selectedCategory)
  return {
    generatedAt: now.toISOString(),
    title: BILLING_CATEGORY_ANALYSIS_TITLE,
    contentBoundary: BILLING_CATEGORY_CONTENT_BOUNDARY,
    scope: {
      month: month?.month ?? null,
      monthLabel: month?.label ?? 'All periods',
      category: selected.category,
      categoryLabel: selected.label,
      pageSize: query.pageSize,
    },
    durationBasis: BILLING_CATEGORY_DURATION_BASIS,
    categories,
    rows: callRows.map(toCategoryCall),
    totals: { ...selected, basis: 'entire_selected_scope' },
    pagination: paginationOf(
      query.page,
      query.pageSize,
      selected.auditedCallCount,
    ),
    authority: 'automated',
  }
}
