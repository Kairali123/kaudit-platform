import {
  CALL_AUDIT_REPORT_CADENCES,
  ELIGIBILITIES,
  KSERVE_COMPARISON_LABELS,
  MISMATCH_SEVERITIES,
  PROCESSING_STATUSES,
  UNDETERMINED_BUCKET,
  validateReportPeriod,
  CallAuditReportingError,
  type CallAuditMetricScoreAggregate,
  type CallAuditPeriodSummary,
  type CallAuditReportCadence,
  type CallAuditReportPeriod,
  type CallAuditReportingRepository,
  type CallAuditResultReportRow,
  type CallAuditRunProgress,
  type CallAuditTally,
  type CallAuditUsageAggregate,
} from '../adapters/mysqlCallAuditReporting.ts'
import {
  CALL_AUDIT_RUBRIC,
  type CallAuditMetricCode,
} from '../callaudit/rubric.ts'
import { OUTCOME_GROUPS } from '../callaudit/outcomes.ts'
import {
  ISSUE_FLAGS,
  NEXT_ACTION_CODES,
  QUALIFICATIONS,
  type IssueFlag,
} from '../callaudit/modelOutput.ts'
import { CALL_INTENTS, KSERVE_AI_CALLER_NAME } from '../callaudit/types.ts'
import type {
  CallAuditRunStatus,
  CallAuditRunType,
} from '../adapters/mysqlCallAuditControl.ts'

/**
 * Read-only presentation layer for the Kserve Call Audit Report.
 *
 * This module parses a narrow report request, asks the accepted Task 13
 * reporting repository for already-sanitized aggregates, and folds them into a
 * DTO shaped for the operational UI. It is pure apart from the repository calls
 * it delegates to: no SQL, no worker, no scheduler, no model call, no email, no
 * export, and no migration behaviour lives here.
 *
 * Boundaries it keeps, restated because this is the layer that finally faces a
 * browser:
 *
 *   * Anonymous only. The Task ID is the approved display identifier; the DTO
 *     is assembled by copying named fields one at a time — never by spreading a
 *     repository row — so a future column cannot reach a browser by default.
 *   * No transcript, raw model response, prompt, scoring configuration, model
 *     provider/name/version, provider error prose, lead id, hash, URL, source
 *     row id, or source PII appears on any shape below. The reliability block
 *     deliberately drops the provider and model identity the repository
 *     returns: model settings are an admin surface, and a normal user's
 *     reliability view needs attempts, tokens, and latency, not model identity.
 *   * No money. Call Audit never chooses, derives, calculates, stores, or
 *     reports billing money, so there is no price, rate, amount, currency, or
 *     cost field here and none is derivable from what is returned.
 *
 * Absent is never zero: an undetermined bucket, an unscored metric, and an
 * empty period each render as their own state, never as a successful zero.
 */

export const CALL_AUDIT_REPORT_TITLE = 'Kserve Call Audit Report'

export const CALL_AUDIT_REPORT_ROUTE = '/api/v1/call-audit/report'

/** Sanitized-reporting boundary, restated to the reader of every report. */
export const CALL_AUDIT_CONTENT_BOUNDARY =
  'Anonymous Task IDs and sanitized audit results only. Raw transcripts, ' +
  'source records, prompts, and model settings stay server-internal.'

export const DEFAULT_RESULT_LIMIT = 25

/** A modest drilldown page. The repository would allow 500; a report needs far less. */
export const MAX_RESULT_LIMIT = 100

/** Runs listed alongside the report. Bounded so one page cannot walk history. */
export const RUN_LIST_LIMIT = 12

/** Longest window a single request may claim, so a report cannot scan years. */
export const MAX_PERIOD_DAYS = 400

const MILLISECONDS_PER_DAY = 86_400_000

// ---------------------------------------------------------------------------
// Request parsing
// ---------------------------------------------------------------------------

/** A rejected report request. Carries an HTTP status so the server can shape it. */
export class CallAuditReportRequestError extends Error {
  readonly code = 'INVALID_CALL_AUDIT_REPORT_QUERY'
  readonly status = 400
  readonly field: string

  constructor(field: string, reason: string) {
    super(`${field}: ${reason}`)
    this.field = field
  }
}

export interface CallAuditReportQuery {
  cadence: CallAuditReportCadence
  period: CallAuditReportPeriod
  limit: number
  /** True when the period was defaulted rather than requested. */
  periodDefaulted: boolean
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/

function pad(value: number, width: number): string {
  return String(value).padStart(width, '0')
}

/**
 * Accepts a calendar date or a full UTC-naive datetime and hands it to the
 * repository's own validator, which checks the Gregorian calendar and REJECTS a
 * trailing Z or numeric offset rather than converting it. A date-only value is
 * expanded to midnight; that is a completion of a UTC-naive literal, not a
 * timezone conversion, so no boundary can silently shift.
 */
function boundaryText(raw: string, field: string): string {
  const value = raw.trim()
  if (!value) {
    throw new CallAuditReportRequestError(field, 'must not be blank')
  }
  return DATE_ONLY.test(value) ? `${value} 00:00:00` : value
}

function requestPeriod(
  start: string,
  end: string,
): CallAuditReportPeriod {
  try {
    return validateReportPeriod({
      periodStart: boundaryText(start, 'start'),
      periodEndExclusive: boundaryText(end, 'end'),
    })
  } catch (error) {
    if (error instanceof CallAuditReportingError) {
      throw new CallAuditReportRequestError(
        error.field === 'period.periodStart' ? 'start' : 'end',
        error.message.slice(error.field.length + 2),
      )
    }
    throw error
  }
}

const NAIVE_PARTS =
  /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})/

/** Epoch milliseconds of a UTC-naive literal, read as UTC. Never a local read. */
function naiveUtcMillis(value: string): number {
  const match = NAIVE_PARTS.exec(value)
  if (!match) {
    throw new CallAuditReportRequestError('period', 'is not readable')
  }
  return Date.UTC(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    Number(match[4]),
    Number(match[5]),
    Number(match[6]),
  )
}

function midnight(year: number, monthIndex: number, day: number): string {
  const date = new Date(Date.UTC(year, monthIndex, day))
  return (
    `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1, 2)}-` +
    `${pad(date.getUTCDate(), 2)} 00:00:00`
  )
}

/**
 * The current UTC calendar period for a cadence, used only when a caller asks
 * for no dates at all. A scheduled run computes its own period in its own
 * timezone; this is a convenience default for an interactive first load, and
 * the response states that it was defaulted.
 */
export function defaultPeriodFor(
  cadence: CallAuditReportCadence,
  now: Date,
): CallAuditReportPeriod {
  const year = now.getUTCFullYear()
  const month = now.getUTCMonth()
  const day = now.getUTCDate()
  if (cadence === 'daily') {
    return {
      periodStart: midnight(year, month, day),
      periodEndExclusive: midnight(year, month, day + 1),
    }
  }
  if (cadence === 'monthly') {
    return {
      periodStart: midnight(year, month, 1),
      periodEndExclusive: midnight(year, month + 1, 1),
    }
  }
  if (cadence === 'quarterly') {
    const quarterStart = month - (month % 3)
    return {
      periodStart: midnight(year, quarterStart, 1),
      periodEndExclusive: midnight(year, quarterStart + 3, 1),
    }
  }
  return {
    periodStart: midnight(year, 0, 1),
    periodEndExclusive: midnight(year + 1, 0, 1),
  }
}

function parseCadence(raw: string | null): CallAuditReportCadence {
  if (raw === null || raw.trim() === '') return 'monthly'
  const value = raw.trim()
  if (
    !(CALL_AUDIT_REPORT_CADENCES as readonly string[]).includes(value)
  ) {
    throw new CallAuditReportRequestError(
      'cadence',
      `must be one of ${CALL_AUDIT_REPORT_CADENCES.join(', ')}`,
    )
  }
  return value as CallAuditReportCadence
}

function parseLimit(raw: string | null): number {
  if (raw === null || raw.trim() === '') return DEFAULT_RESULT_LIMIT
  const value = Number(raw)
  if (
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > MAX_RESULT_LIMIT
  ) {
    throw new CallAuditReportRequestError(
      'limit',
      `must be an integer between 1 and ${MAX_RESULT_LIMIT}`,
    )
  }
  return value
}

/**
 * Parses the narrow report query. Both boundaries are supplied together or not
 * at all: one alone would silently pair a requested edge with a defaulted one
 * and report a window nobody asked for.
 */
export function parseCallAuditReportQuery(
  params: URLSearchParams,
  now: Date = new Date(),
): CallAuditReportQuery {
  const cadence = parseCadence(params.get('cadence'))
  const limit = parseLimit(params.get('limit'))
  const start = params.get('start')?.trim() ?? ''
  const end = params.get('end')?.trim() ?? ''
  if (!start && !end) {
    return {
      cadence,
      period: defaultPeriodFor(cadence, now),
      limit,
      periodDefaulted: true,
    }
  }
  if (!start || !end) {
    throw new CallAuditReportRequestError(
      start ? 'end' : 'start',
      'is required when the other period boundary is given',
    )
  }
  const period = requestPeriod(start, end)
  const days =
    (naiveUtcMillis(period.periodEndExclusive) -
      naiveUtcMillis(period.periodStart)) /
    MILLISECONDS_PER_DAY
  if (days > MAX_PERIOD_DAYS) {
    throw new CallAuditReportRequestError(
      'end',
      `must be at most ${MAX_PERIOD_DAYS} days after start`,
    )
  }
  return { cadence, period, limit, periodDefaulted: false }
}

// ---------------------------------------------------------------------------
// Display vocabulary. Codes stay machine-exact; labels are report language.
// ---------------------------------------------------------------------------

const MONTH_NAMES = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
] as const

/** Deterministic, locale-independent period label for the report header. */
export function periodLabel(period: CallAuditReportPeriod): string {
  const day = (value: string): string => {
    const match = NAIVE_PARTS.exec(value)
    if (!match) return value
    const time =
      match[4] === '00' && match[5] === '00' && match[6] === '00'
        ? ''
        : ` ${match[4]}:${match[5]}`
    return `${Number(match[3])} ${MONTH_NAMES[Number(match[2]) - 1]} ${match[1]}${time}`
  }
  return `${day(period.periodStart)} → ${day(period.periodEndExclusive)} (UTC, end exclusive)`
}

const UNDETERMINED_LABEL = 'Not determined'

const CADENCE_LABELS: Record<CallAuditReportCadence, string> = {
  daily: 'Daily',
  monthly: 'Monthly',
  quarterly: 'Quarterly',
  yearly: 'Yearly',
}

const PROCESSING_STATUS_LABELS: Record<string, string> = {
  pending: 'Pending',
  succeeded: 'Succeeded',
  failed: 'Failed',
  skipped: 'Skipped',
}

const ELIGIBILITY_LABELS: Record<string, string> = {
  content_auditable: 'Content-auditable',
  operational_only: 'Operational only',
}

const INTENT_LABELS: Record<string, string> = {
  HIGH: 'High intent',
  WARM: 'Warm intent',
  LOW: 'Low intent',
  NONE: 'No intent',
}

const COMPARISON_LABELS: Record<string, string> = {
  match: 'Matches KServe',
  mismatch: 'Differs from KServe',
  not_comparable: 'Not comparable',
}

const SEVERITY_LABELS: Record<string, string> = {
  none: 'No mismatch',
  low: 'Low severity',
  medium: 'Medium severity',
  high: 'High severity',
}

const QUALIFICATION_LABELS: Record<string, string> = {
  QUALIFIED: 'Qualified',
  NON_QUALIFIED: 'Not qualified',
  UNCERTAIN: 'Uncertain',
  NOT_APPLICABLE: 'Not applicable',
}

const OUTCOME_GROUP_LABELS: Record<string, string> = {
  PRODUCTS_COMMERCE: 'Products & commerce',
  RESORT_HEALING: 'Resort & healing',
  CONSULTATION_TREATMENT: 'Consultation & treatment',
  TRAINING: 'Training',
  PARTNERSHIP_B2B: 'Partnership & B2B',
  FOLLOW_UP_ACTION: 'Follow-up action',
  NOT_CONNECTED: 'Not connected',
  NOT_INTERESTED_NO_ENQUIRY: 'Not interested / no enquiry',
  EXISTING_DUPLICATE_DNC: 'Existing, duplicate or do-not-call',
  TECHNICAL_LANGUAGE: 'Technical or language barrier',
  EMPLOYMENT_MISC: 'Employment & miscellaneous',
  OTHER: 'Other',
}

const NEXT_ACTION_LABELS: Record<string, string> = {
  NONE: 'No action needed',
  CALLBACK: 'Callback',
  SEND_DETAILS_EMAIL: 'Send details by email',
  ASSIGN_TO_MR: 'Assign to MR',
  EXPERT_FOLLOWUP: 'Expert follow-up',
  DOCTOR_CONSULTATION: 'Doctor consultation',
  SCHEDULE_BOOKING: 'Schedule booking',
  DO_NOT_CALL: 'Do not call',
  REVERIFY: 'Re-verify',
  TECHNICAL_RETRY: 'Technical retry',
  LANGUAGE_CALLBACK: 'Language callback',
  OTHER: 'Other',
}

const ISSUE_FLAG_LABELS: Record<string, string> = {
  TECHNICAL_ISSUE: 'Technical issue',
  LANGUAGE_ISSUE: 'Language issue',
  NO_CUSTOMER_SPEECH: 'No customer speech',
  MISSED_REQUIREMENT: 'Missed requirement',
  INCORRECT_CLASSIFICATION: 'Incorrect classification',
  WEAK_DISCOVERY: 'Weak discovery',
  WEAK_OBJECTION_HANDLING: 'Weak objection handling',
  WEAK_NEXT_STEP: 'Weak next step',
  UNSUPPORTED_CLAIM: 'Unsupported claim',
  PRIVACY_COMPLIANCE_RISK: 'Privacy or compliance risk',
  DNC_RISK: 'Do-not-call risk',
  DUPLICATE_LEAD: 'Duplicate lead',
  POOR_TRANSCRIPT_QUALITY: 'Poor transcript quality',
  REPEATED_QUESTION: 'Repeated question',
  PREMATURE_END: 'Premature end',
  CUSTOMER_FRUSTRATION: 'Customer frustration',
}

const METRIC_LABELS: Record<CallAuditMetricCode, string> = {
  PRODUCT_SERVICE_KNOWLEDGE: 'Product & service knowledge',
  CUSTOMER_UNDERSTANDING: 'Customer understanding',
  COMMUNICATION_CLARITY: 'Communication clarity',
  OBJECTION_CALLBACK_HANDLING: 'Objection & callback handling',
  CLOSING_NEXT_STEP: 'Closing & next step',
  PROFESSIONALISM: 'Professionalism',
  QUALIFICATION_COMPLETENESS: 'Qualification completeness',
  COMPLIANCE_PRIVACY: 'Compliance & privacy',
}

const RUN_STATUS_LABELS: Record<CallAuditRunStatus, string> = {
  pending: 'Pending',
  running: 'Running',
  completed: 'Completed',
  failed: 'Failed',
  cancelled: 'Cancelled',
}

const ATTEMPT_OUTCOME_LABELS: Record<string, string> = {
  succeeded: 'Succeeded',
  refused: 'Refused by model',
  failed: 'Failed',
}

function labelOf(labels: Record<string, string>, code: string): string {
  if (code === UNDETERMINED_BUCKET) return UNDETERMINED_LABEL
  return labels[code] ?? code
}

// ---------------------------------------------------------------------------
// DTO
// ---------------------------------------------------------------------------

export type CallAuditTileStatus = 'good' | 'warn' | 'neutral' | 'pending'

export interface CallAuditReportTile {
  label: string
  value: string
  sub: string
  status: CallAuditTileStatus
}

export interface CallAuditBreakdownRow {
  code: string
  label: string
  count: number
  /** One-decimal share of the section total, or null when nothing was counted. */
  sharePercent: string | null
}

export interface CallAuditReportSection {
  key: string
  title: string
  caption: string
  total: number
  rows: CallAuditBreakdownRow[]
  /** Buckets with no rows that were left out of a compacted section. */
  emptyBucketCount: number
}

export interface CallAuditReportMetricRow {
  metricCode: CallAuditMetricCode
  label: string
  weight: number
  scoredCount: number
  notApplicableCount: number
  /** Null when nothing was scored. An unscored metric is never reported as 0. */
  averageScore: string | null
  distribution: Record<1 | 2 | 3 | 4 | 5, number>
}

export interface CallAuditReportResultRow {
  resultId: string
  runId: string
  /** Approved anonymous display identifier. Null when none could be derived. */
  taskId: string | null
  effectiveCallAt: string
  callDurationSeconds: number | null
  /** Presence signal only; the transcript itself never leaves the server. */
  hasTranscript: boolean
  company: string | null
  companyByKserve: string | null
  serviceCategory: string | null
  callType: string | null
  callStatus: string | null
  finalCallStatus: string | null
  aiCallCategory: string | null
  customerEngagementLevel: string | null
  interestLevel: string | null
  callOutcome: string | null
  leadStatus: string | null
  finalLeadOutcome: string | null
  calculatedQualificationStatus: string | null
  followupRequired: string | null
  processingStatus: string
  processingStatusLabel: string
  eligibility: string
  eligibilityLabel: string
  ineligibilityReason: string | null
  /** Null is "not determined" and is never rendered as false. */
  callConnected: boolean | null
  customerSpoke: boolean | null
  meaningfulConversation: boolean | null
  intent: string | null
  intentLabel: string | null
  intentConfidence: string | null
  /** Byte-exact KServe taxonomy label, exactly as stored. */
  detailedOutcome: string | null
  groupedOutcome: string | null
  groupedOutcomeLabel: string | null
  qualificationLabel: string | null
  nextActionCode: string | null
  nextActionLabel: string | null
  overallScore: string | null
  overallScoreMethod: string | null
  kserveReportedOutcome: string | null
  kserveComparisonLabel: string | null
  kserveComparisonText: string | null
  mismatchSeverity: string | null
  mismatchSeverityText: string | null
  managementFeedback: string | null
  kserveFeedback: string | null
  improvementFeedback: string | null
  issueFlags: Array<{ code: string; label: string }>
  auditedAt: string | null
}

/**
 * Volume and reliability of the audit itself. Money-free by construction, and
 * model identity is deliberately dropped: it is an admin surface.
 */
export interface CallAuditReliabilityRow {
  attemptOutcome: string
  label: string
  attemptCount: number
  resultCount: number
  erroredCount: number
  totalTokens: string
  averageLatencyMs: string | null
}

export interface CallAuditReliability {
  attemptCount: number
  resultCount: number
  erroredCount: number
  maxAttemptNumber: number
  inputTokens: string
  outputTokens: string
  totalTokens: string
  averageLatencyMs: string | null
  maxLatencyMs: string | null
  byAttemptOutcome: CallAuditReliabilityRow[]
}

export interface CallAuditReportRunRow {
  runId: string
  runType: CallAuditRunType
  ruleVersionLabel: string
  status: CallAuditRunStatus
  statusLabel: string
  periodStart: string
  periodEndExclusive: string
  periodTimezone: string
  totalCandidates: number
  processedCount: number
  succeededCount: number
  failedCount: number
  skippedCount: number
  contentAuditableCount: number
  operationalOnlyCount: number
  /** Null when the run has no candidates yet: unknown is never 100%. */
  progressPercent: string | null
  /** Safe machine code only; provider prose is never reported. */
  errorCode: string | null
  startedAt: string | null
  finishedAt: string | null
}

export interface CallAuditReportBasis {
  cadence: CallAuditReportCadence
  cadenceLabel: string
  runTypes: CallAuditRunType[]
  periodStart: string
  periodEndExclusive: string
  periodLabel: string
  boundaryBasis: 'utc_naive_half_open'
  periodDefaulted: boolean
  resultLimit: number
}

export interface CallAuditReportSummary {
  resultCount: number
  auditedCallCount: number
  byProcessingStatus: Record<string, number>
  byEligibility: Record<string, number>
  byIntent: Record<string, number>
  byGroupedOutcome: Record<string, number>
  byKserveComparison: Record<string, number>
  byMismatchSeverity: Record<string, number>
  byQualification: Record<string, number>
  byNextAction: Record<string, number>
  byIssueFlag: Record<string, number>
}

export interface CallAuditReportDto {
  generatedAt: string
  title: typeof CALL_AUDIT_REPORT_TITLE
  aiCaller: typeof KSERVE_AI_CALLER_NAME
  contentBoundary: typeof CALL_AUDIT_CONTENT_BOUNDARY
  reportBasis: CallAuditReportBasis
  /** False when the period produced no result rows — an empty period, not a zero. */
  hasResults: boolean
  headline: CallAuditReportTile[]
  summary: CallAuditReportSummary
  sections: CallAuditReportSection[]
  metrics: CallAuditReportMetricRow[]
  results: CallAuditReportResultRow[]
  /** True when more rows exist in the period than the requested limit. */
  resultsTruncated: boolean
  reliability: CallAuditReliability
  runs: CallAuditReportRunRow[]
}

// ---------------------------------------------------------------------------
// Folding helpers
// ---------------------------------------------------------------------------

/** One-decimal share, half-up, in integer arithmetic. Null when nothing counted. */
export function sharePercent(count: number, total: number): string | null {
  if (total <= 0) return null
  const scaled = Math.round((count * 1000) / total)
  return `${Math.trunc(scaled / 10)}.${scaled % 10}`
}

function breakdown(
  tally: CallAuditTally<string>,
  vocabulary: readonly string[],
  labels: Record<string, string>,
  total: number,
  compact: boolean,
): Pick<CallAuditReportSection, 'rows' | 'emptyBucketCount'> {
  const buckets = [...vocabulary, UNDETERMINED_BUCKET]
  const rows = buckets.map((code) => ({
    code,
    label: labelOf(labels, code),
    count: tally[code] ?? 0,
    sharePercent: sharePercent(tally[code] ?? 0, total),
  }))
  if (!compact) return { rows, emptyBucketCount: 0 }
  const populated = rows
    .filter((row) => row.count > 0)
    .sort((left, right) => right.count - left.count)
  return {
    rows: populated,
    emptyBucketCount: rows.length - populated.length,
  }
}

function plain(tally: CallAuditTally<string>): Record<string, number> {
  return { ...tally }
}

function count(tally: CallAuditTally<string>, bucket: string): number {
  return tally[bucket] ?? 0
}

function formatCount(value: number): string {
  return value.toLocaleString('en-IN')
}

/**
 * Mean of a BIGINT total over a count, half-up, in BigInt arithmetic so a large
 * token or latency total is never rounded through a binary float.
 */
export function averageOf(total: string, divisor: number): string | null {
  if (divisor <= 0) return null
  const numerator = BigInt(total)
  const denominator = BigInt(divisor)
  const quotient = numerator / denominator
  const remainder = numerator % denominator
  return String(
    remainder * 2n >= denominator ? quotient + 1n : quotient,
  )
}

function sumDecimals(values: readonly string[]): string {
  return String(
    values.reduce((total, value) => total + BigInt(value), 0n),
  )
}

function maxDecimal(values: readonly string[]): string | null {
  let largest: bigint | null = null
  for (const value of values) {
    const candidate = BigInt(value)
    if (largest === null || candidate > largest) largest = candidate
  }
  return largest === null ? null : String(largest)
}

// ---------------------------------------------------------------------------
// Tiles
// ---------------------------------------------------------------------------

/**
 * Headline tiles. When the period produced nothing, every tile reports the
 * pending state with an em dash: a period with no audited calls is unknown, and
 * rendering it as a clean zero would read as a perfect result.
 */
export function buildHeadlineTiles(
  summary: CallAuditPeriodSummary,
): CallAuditReportTile[] {
  const empty = summary.resultCount === 0
  const status = (
    warn: boolean,
    good: CallAuditTileStatus = 'good',
  ): CallAuditTileStatus =>
    empty ? 'pending' : warn ? 'warn' : good
  const value = (amount: number): string =>
    empty ? '—' : formatCount(amount)

  const failed = count(summary.byProcessingStatus, 'failed')
  const skipped = count(summary.byProcessingStatus, 'skipped')
  const pendingRows = count(summary.byProcessingStatus, 'pending')
  const mismatch = count(summary.byKserveComparison, 'mismatch')
  const highSeverity = count(summary.byMismatchSeverity, 'high')
  const flagEntries = Object.entries(summary.byIssueFlag)
    .filter(([, amount]) => amount > 0)
    .sort((left, right) => right[1] - left[1])
  const flagTotal = flagEntries.reduce(
    (total, [, amount]) => total + amount,
    0,
  )

  return [
    {
      label: 'Calls audited',
      value: value(summary.auditedCallCount),
      sub: empty
        ? 'No audited calls in this period'
        : `${formatCount(summary.resultCount)} result rows in scope`,
      status: empty ? 'pending' : 'neutral',
    },
    {
      label: 'Content-auditable',
      value: value(count(summary.byEligibility, 'content_auditable')),
      sub: empty
        ? 'Eligibility not determined'
        : `${formatCount(
            count(summary.byEligibility, 'operational_only'),
          )} operational only`,
      status: empty ? 'pending' : 'neutral',
    },
    {
      label: 'Audits succeeded',
      value: value(count(summary.byProcessingStatus, 'succeeded')),
      sub: empty
        ? 'Nothing processed'
        : `${formatCount(failed)} failed · ${formatCount(
            skipped,
          )} skipped · ${formatCount(pendingRows)} pending`,
      status: status(failed > 0),
    },
    {
      label: 'High intent',
      value: value(count(summary.byIntent, 'HIGH')),
      sub: empty
        ? 'Intent not determined'
        : `${formatCount(count(summary.byIntent, 'WARM'))} warm · ${formatCount(
            count(summary.byIntent, 'LOW'),
          )} low · ${formatCount(count(summary.byIntent, 'NONE'))} none`,
      status: empty ? 'pending' : 'neutral',
    },
    {
      label: 'Qualified leads',
      value: value(count(summary.byQualification, 'QUALIFIED')),
      sub: empty
        ? 'Qualification not determined'
        : `${formatCount(
            count(summary.byQualification, 'NON_QUALIFIED'),
          )} not qualified · ${formatCount(
            count(summary.byQualification, 'UNCERTAIN'),
          )} uncertain`,
      status: empty ? 'pending' : 'neutral',
    },
    {
      label: 'Agrees with KServe',
      value: value(count(summary.byKserveComparison, 'match')),
      sub: empty
        ? 'No comparison available'
        : `${formatCount(mismatch)} differ · ${formatCount(
            count(summary.byKserveComparison, 'not_comparable'),
          )} not comparable`,
      status: status(mismatch > 0),
    },
    {
      label: 'High-severity mismatches',
      value: value(highSeverity),
      sub: empty
        ? 'Severity not determined'
        : `${formatCount(
            count(summary.byMismatchSeverity, 'medium'),
          )} medium · ${formatCount(
            count(summary.byMismatchSeverity, 'low'),
          )} low`,
      status: status(highSeverity > 0),
    },
    {
      label: 'Issue flags raised',
      value: value(flagTotal),
      sub: empty
        ? 'No audited calls to flag'
        : flagEntries.length === 0
          ? 'No coded issue flag was raised'
          : `Most frequent: ${labelOf(
              ISSUE_FLAG_LABELS,
              flagEntries[0][0],
            )} (${formatCount(flagEntries[0][1])})`,
      status: status(flagTotal > 0, 'neutral'),
    },
  ]
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

export function buildSections(
  summary: CallAuditPeriodSummary,
): CallAuditReportSection[] {
  const rowTotal = summary.resultCount
  const section = (
    key: string,
    title: string,
    caption: string,
    tally: CallAuditTally<string>,
    vocabulary: readonly string[],
    labels: Record<string, string>,
    compact: boolean,
    total = rowTotal,
  ): CallAuditReportSection => ({
    key,
    title,
    caption,
    total,
    ...breakdown(tally, vocabulary, labels, total, compact),
  })

  const flagTotal = Object.values(summary.byIssueFlag).reduce(
    (sum, amount) => sum + amount,
    0,
  )
  const flagRows = ISSUE_FLAGS.map((flag: IssueFlag) => ({
    code: flag,
    label: labelOf(ISSUE_FLAG_LABELS, flag),
    count: summary.byIssueFlag[flag] ?? 0,
    sharePercent: sharePercent(
      summary.byIssueFlag[flag] ?? 0,
      flagTotal,
    ),
  }))
  const populatedFlags = flagRows
    .filter((row) => row.count > 0)
    .sort((left, right) => right.count - left.count)

  return [
    section(
      'grouped_outcome',
      'Grouped outcome',
      'Management grouping of the KServe outcome taxonomy.',
      summary.byGroupedOutcome,
      OUTCOME_GROUPS,
      OUTCOME_GROUP_LABELS,
      true,
    ),
    section(
      'kserve_comparison',
      'KServe comparison',
      'How the audited outcome compares with the label KServe reported.',
      summary.byKserveComparison,
      KSERVE_COMPARISON_LABELS,
      COMPARISON_LABELS,
      false,
    ),
    section(
      'mismatch_severity',
      'Mismatch severity',
      'Severity recorded when the audited outcome differs.',
      summary.byMismatchSeverity,
      MISMATCH_SEVERITIES,
      SEVERITY_LABELS,
      false,
    ),
    {
      key: 'issue_flags',
      title: 'Issue flags',
      caption:
        'Coded flags only. A result may carry several, so flags do not sum to result rows.',
      total: flagTotal,
      rows: populatedFlags,
      emptyBucketCount: flagRows.length - populatedFlags.length,
    },
    section(
      'intent',
      'Customer intent',
      `Intent read from the conversation ${KSERVE_AI_CALLER_NAME} held.`,
      summary.byIntent,
      CALL_INTENTS,
      INTENT_LABELS,
      false,
    ),
    section(
      'qualification',
      'Qualification',
      'Lead qualification recorded by the audit.',
      summary.byQualification,
      QUALIFICATIONS,
      QUALIFICATION_LABELS,
      false,
    ),
    section(
      'next_action',
      'Next action',
      'Recommended next action per audited result.',
      summary.byNextAction,
      NEXT_ACTION_CODES,
      NEXT_ACTION_LABELS,
      true,
    ),
    section(
      'processing_status',
      'Processing status',
      'Outcome of the audit run itself, not of the call.',
      summary.byProcessingStatus,
      PROCESSING_STATUSES,
      PROCESSING_STATUS_LABELS,
      false,
    ),
    section(
      'eligibility',
      'Audit eligibility',
      'Whether a usable transcript existed for content scoring.',
      summary.byEligibility,
      ELIGIBILITIES,
      ELIGIBILITY_LABELS,
      false,
    ),
  ]
}

// ---------------------------------------------------------------------------
// Row, metric, reliability, and run mapping
// ---------------------------------------------------------------------------

const METRIC_WEIGHTS = new Map<CallAuditMetricCode, number>(
  CALL_AUDIT_RUBRIC.map((metric) => [metric.code, metric.weight]),
)

export function toMetricRow(
  aggregate: CallAuditMetricScoreAggregate,
): CallAuditReportMetricRow {
  return {
    metricCode: aggregate.metricCode,
    label: METRIC_LABELS[aggregate.metricCode] ?? aggregate.metricCode,
    weight: METRIC_WEIGHTS.get(aggregate.metricCode) ?? 0,
    scoredCount: aggregate.scoredCount,
    notApplicableCount: aggregate.notApplicableCount,
    averageScore: aggregate.averageScore,
    distribution: { ...aggregate.distribution },
  }
}

/**
 * Copies the sanitized repository row field by field. Never a spread: a column
 * added to the repository shape later must be reviewed here before it can be
 * rendered in a browser.
 */
export function toResultRow(
  row: CallAuditResultReportRow,
): CallAuditReportResultRow {
  return {
    resultId: row.resultId,
    runId: row.runId,
    taskId: row.taskId,
    effectiveCallAt: row.effectiveCallAt,
    callDurationSeconds: row.callDurationSeconds,
    hasTranscript: row.hasTranscript,
    company: row.company,
    companyByKserve: row.companyByKserve,
    serviceCategory: row.serviceCategory,
    callType: row.callType,
    callStatus: row.callStatus,
    finalCallStatus: row.finalCallStatus,
    aiCallCategory: row.aiCallCategory,
    customerEngagementLevel: row.customerEngagementLevel,
    interestLevel: row.interestLevel,
    callOutcome: row.callOutcome,
    leadStatus: row.leadStatus,
    finalLeadOutcome: row.finalLeadOutcome,
    calculatedQualificationStatus: row.calculatedQualificationStatus,
    followupRequired: row.followupRequired,
    processingStatus: row.processingStatus,
    processingStatusLabel: labelOf(
      PROCESSING_STATUS_LABELS,
      row.processingStatus,
    ),
    eligibility: row.eligibility,
    eligibilityLabel: labelOf(ELIGIBILITY_LABELS, row.eligibility),
    ineligibilityReason: row.ineligibilityReason,
    callConnected: row.callConnected,
    customerSpoke: row.customerSpoke,
    meaningfulConversation: row.meaningfulConversation,
    intent: row.intent,
    intentLabel:
      row.intent === null ? null : labelOf(INTENT_LABELS, row.intent),
    intentConfidence: row.intentConfidence,
    detailedOutcome: row.detailedOutcome,
    groupedOutcome: row.groupedOutcome,
    groupedOutcomeLabel:
      row.groupedOutcome === null
        ? null
        : labelOf(OUTCOME_GROUP_LABELS, row.groupedOutcome),
    qualificationLabel:
      row.qualificationLabel === null
        ? null
        : labelOf(QUALIFICATION_LABELS, row.qualificationLabel),
    nextActionCode: row.nextActionCode,
    nextActionLabel:
      row.nextActionCode === null
        ? null
        : labelOf(NEXT_ACTION_LABELS, row.nextActionCode),
    overallScore: row.overallScore,
    overallScoreMethod: row.overallScoreMethod,
    kserveReportedOutcome: row.kserveReportedOutcome,
    kserveComparisonLabel: row.kserveComparisonLabel,
    kserveComparisonText:
      row.kserveComparisonLabel === null
        ? null
        : labelOf(COMPARISON_LABELS, row.kserveComparisonLabel),
    mismatchSeverity: row.mismatchSeverity,
    mismatchSeverityText:
      row.mismatchSeverity === null
        ? null
        : labelOf(SEVERITY_LABELS, row.mismatchSeverity),
    managementFeedback: row.managementFeedback,
    kserveFeedback: row.kserveFeedback,
    improvementFeedback: row.improvementFeedback,
    issueFlags: row.issueFlags.map((flag) => ({
      code: flag,
      label: labelOf(ISSUE_FLAG_LABELS, flag),
    })),
    auditedAt: row.auditedAt,
  }
}

/**
 * Folds per-model usage rows into a single reliability block, dropping provider,
 * model, and version: those are admin-only model settings, and a sanitized
 * report needs attempts, tokens, and latency.
 */
export function buildReliability(
  aggregates: readonly CallAuditUsageAggregate[],
): CallAuditReliability {
  const attemptCount = aggregates.reduce(
    (sum, row) => sum + row.attemptCount,
    0,
  )
  const latencyTotal = sumDecimals(
    aggregates.map((row) => row.latencyMsTotal),
  )
  const byOutcome = new Map<string, CallAuditUsageAggregate[]>()
  for (const row of aggregates) {
    const bucket = byOutcome.get(row.attemptOutcome) ?? []
    bucket.push(row)
    byOutcome.set(row.attemptOutcome, bucket)
  }
  return {
    attemptCount,
    resultCount: aggregates.reduce(
      (sum, row) => sum + row.resultCount,
      0,
    ),
    erroredCount: aggregates.reduce(
      (sum, row) => sum + row.erroredCount,
      0,
    ),
    maxAttemptNumber: aggregates.reduce(
      (largest, row) => Math.max(largest, row.maxAttemptNumber),
      0,
    ),
    inputTokens: sumDecimals(
      aggregates.map((row) => row.inputTokensTotal),
    ),
    outputTokens: sumDecimals(
      aggregates.map((row) => row.outputTokensTotal),
    ),
    totalTokens: sumDecimals(
      aggregates.map((row) => row.totalTokensTotal),
    ),
    averageLatencyMs: averageOf(latencyTotal, attemptCount),
    maxLatencyMs: maxDecimal(
      aggregates
        .map((row) => row.latencyMsMax)
        .filter((value): value is string => value !== null),
    ),
    byAttemptOutcome: [...byOutcome.entries()].map(
      ([attemptOutcome, rows]) => {
        const attempts = rows.reduce(
          (sum, row) => sum + row.attemptCount,
          0,
        )
        return {
          attemptOutcome,
          label: labelOf(ATTEMPT_OUTCOME_LABELS, attemptOutcome),
          attemptCount: attempts,
          resultCount: rows.reduce(
            (sum, row) => sum + row.resultCount,
            0,
          ),
          erroredCount: rows.reduce(
            (sum, row) => sum + row.erroredCount,
            0,
          ),
          totalTokens: sumDecimals(
            rows.map((row) => row.totalTokensTotal),
          ),
          averageLatencyMs: averageOf(
            sumDecimals(rows.map((row) => row.latencyMsTotal)),
            attempts,
          ),
        }
      },
    ),
  }
}

export function toRunRow(
  run: CallAuditRunProgress,
): CallAuditReportRunRow {
  return {
    runId: run.runId,
    runType: run.runType,
    ruleVersionLabel: run.ruleVersionLabel,
    status: run.status,
    statusLabel: RUN_STATUS_LABELS[run.status] ?? run.status,
    periodStart: run.periodStart,
    periodEndExclusive: run.periodEndExclusive,
    periodTimezone: run.periodTimezone,
    totalCandidates: run.counters.totalCandidates,
    processedCount: run.counters.processedCount,
    succeededCount: run.counters.succeededCount,
    failedCount: run.counters.failedCount,
    skippedCount: run.counters.skippedCount,
    contentAuditableCount: run.counters.contentAuditableCount,
    operationalOnlyCount: run.counters.operationalOnlyCount,
    // A run with no candidates has unknown progress, never complete progress.
    progressPercent: sharePercent(
      run.counters.processedCount,
      run.counters.totalCandidates,
    ),
    errorCode: run.errorCode,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
  }
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

/**
 * Builds the report DTO from the sanitized reporting repository.
 *
 * Reads are issued together because they are independent; the repository itself
 * runs its statements sequentially. One extra result row is requested so the UI
 * can honestly say the drilldown is truncated instead of implying the period
 * ended there.
 */
export async function buildCallAuditReport(
  repository: CallAuditReportingRepository,
  query: CallAuditReportQuery,
  now: Date = new Date(),
): Promise<CallAuditReportDto> {
  const scope = {
    period: query.period,
    runTypes: [query.cadence] as CallAuditRunType[],
  }
  const [summary, metrics, results, usage, runs] = await Promise.all([
    repository.getPeriodSummary(scope),
    repository.listMetricScoreAggregates(scope),
    repository.listResults({
      ...scope,
      limit: Math.min(query.limit + 1, MAX_RESULT_LIMIT + 1),
    }),
    repository.listUsageAggregates(scope),
    repository.listRuns({
      period: query.period,
      runTypes: scope.runTypes,
      limit: RUN_LIST_LIMIT,
    }),
  ])

  const page = results.slice(0, query.limit)
  return {
    generatedAt: now.toISOString(),
    title: CALL_AUDIT_REPORT_TITLE,
    aiCaller: KSERVE_AI_CALLER_NAME,
    contentBoundary: CALL_AUDIT_CONTENT_BOUNDARY,
    reportBasis: {
      cadence: query.cadence,
      cadenceLabel: CADENCE_LABELS[query.cadence],
      runTypes: scope.runTypes,
      periodStart: query.period.periodStart,
      periodEndExclusive: query.period.periodEndExclusive,
      periodLabel: periodLabel(query.period),
      boundaryBasis: 'utc_naive_half_open',
      periodDefaulted: query.periodDefaulted,
      resultLimit: query.limit,
    },
    hasResults: summary.resultCount > 0,
    headline: buildHeadlineTiles(summary),
    summary: {
      resultCount: summary.resultCount,
      auditedCallCount: summary.auditedCallCount,
      byProcessingStatus: plain(summary.byProcessingStatus),
      byEligibility: plain(summary.byEligibility),
      byIntent: plain(summary.byIntent),
      byGroupedOutcome: plain(summary.byGroupedOutcome),
      byKserveComparison: plain(summary.byKserveComparison),
      byMismatchSeverity: plain(summary.byMismatchSeverity),
      byQualification: plain(summary.byQualification),
      byNextAction: plain(summary.byNextAction),
      byIssueFlag: { ...summary.byIssueFlag },
    },
    sections: buildSections(summary),
    metrics: metrics.map(toMetricRow),
    results: page.map(toResultRow),
    resultsTruncated: results.length > query.limit,
    reliability: buildReliability(usage),
    runs: runs.map(toRunRow),
  }
}

/** Exposed so a test can assert every tally is folded, not silently dropped. */
export const CALL_AUDIT_REPORT_SECTION_KEYS = [
  'grouped_outcome',
  'kserve_comparison',
  'mismatch_severity',
  'issue_flags',
  'intent',
  'qualification',
  'next_action',
  'processing_status',
  'eligibility',
] as const
