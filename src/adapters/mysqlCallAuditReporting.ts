import type { Pool, RowDataPacket } from 'mysql2/promise'
import {
  CALL_INTENTS,
  type CallAuditEligibility,
  type CallIntent,
} from '../callaudit/types.ts'
import {
  CALL_AUDIT_METRIC_CODES,
  type CallAuditMetricCode,
} from '../callaudit/rubric.ts'
import { OUTCOME_GROUPS, type OutcomeGroup } from '../callaudit/outcomes.ts'
import {
  ISSUE_FLAGS,
  NEXT_ACTION_CODES,
  QUALIFICATIONS,
  type IssueFlag,
  type NextActionCode,
  type Qualification,
} from '../callaudit/modelOutput.ts'
import {
  MAX_ID_LENGTH,
  type KserveComparisonLabel,
  type MismatchSeverity,
  type ProcessingStatus,
  type UsageAttemptOutcome,
} from '../callaudit/resultRecords.ts'
import {
  RUN_STATUSES,
  RUN_TYPES,
  type CallAuditRunCounters,
  type CallAuditRunStatus,
  type CallAuditRunType,
} from './mysqlCallAuditControl.ts'

/**
 * SANITIZED, READ-ONLY reporting repository for the Kserve Call Audit Report.
 *
 * Scope: reads only, over the six `kaudit_call_audit_*` tables from migration
 * 0008 and nothing else. This module contains no INSERT, UPDATE, DELETE,
 * REPLACE, ALTER, CREATE, DROP, TRUNCATE, LOCK, `FOR UPDATE`, or transaction
 * statement, and no API route, UI, CLI, scheduler, worker, model call, report
 * renderer, or email path. It is the data source a future reporting API layer
 * reads; it decides nothing.
 *
 * Source-table safety: `ai_voice_leads_received` is EXTERNAL and READ-ONLY and
 * is never named here at all — not even in a SELECT. Every categorical value a
 * report needs was already snapshotted into `kaudit_call_audit_source_ref` by
 * the accepted import path, so reporting never re-reads the vendor's table.
 *
 * Billing separation: Call Audit and Billing Audit are separate modules. No
 * billing table is queried, no price, rate, amount, currency, or cost is
 * selected or derived, and the usage aggregates below deliberately stop at
 * attempt counts, token counts, and latency. Spend is a Billing concern.
 *
 * Privacy — what this module will NOT return:
 *   * no raw transcript, and no `transcript_sha256`;
 *   * no `lead_id` and no `lead_id_sha256`. The only call identity surfaced is
 *     the approved anonymous Task ID, already extracted upstream;
 *   * no `business_prompt`, `scoring_config_json`, model provider/name/version,
 *     or temperature — the prompt lab and model settings are admin-only, and
 *     the only rule provenance here is an opaque id and its version label;
 *   * no `result_json` and no `result_sha256` wholesale payloads: every
 *     reportable value is read from an explicit, individually reviewed column;
 *   * no `error_detail`, no provider error prose, and no usage `error_code`
 *     text — a reliability report gets counts, not messages;
 *   * no URL, phone, email, name, or source free text, none of which the
 *     migration stores in these tables in the first place;
 *   * no money.
 *
 * Taxonomy fidelity: `detailed_outcome` and `kserve_reported_outcome` are
 * returned BYTE-EXACT as stored. There is no alias table, no case folding, and
 * no normalization anywhere in this file — a report column is only comparable
 * with KServe's own if the text matches theirs exactly.
 *
 * Timezone: every period boundary is an ALREADY COMPUTED UTC-naive literal,
 * validated and passed through as a placeholder. Nothing here converts a zone
 * or derives a calendar period; that is a scheduling concern.
 */

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Invalid caller input, or a stored value this module refuses to type, rejected
 * before or during mapping. Names a FIELD or COLUMN, never a value, so a
 * reporting failure can be logged without echoing audited content.
 */
export class CallAuditReportingError extends Error {
  readonly code = 'CALL_AUDIT_REPORTING_ERROR'
  readonly field: string

  constructor(field: string, reason: string) {
    super(`${field}: ${reason}`)
    this.field = field
  }
}

// ---------------------------------------------------------------------------
// Closed vocabularies
// ---------------------------------------------------------------------------

/**
 * The four required report cadences. `manual`, `test`, and `backfill` are valid
 * run types but are never a cadence, so a caller must ask for them explicitly.
 */
export const CALL_AUDIT_REPORT_CADENCES = [
  'daily',
  'monthly',
  'quarterly',
  'yearly',
] as const satisfies readonly CallAuditRunType[]

export type CallAuditReportCadence =
  (typeof CALL_AUDIT_REPORT_CADENCES)[number]

/** `kaudit_call_audit_result.processing_status`, per chk_..._result_status. */
export const PROCESSING_STATUSES = [
  'pending',
  'succeeded',
  'failed',
  'skipped',
] as const satisfies readonly ProcessingStatus[]

/** `kaudit_call_audit_result.eligibility`. */
export const ELIGIBILITIES = [
  'content_auditable',
  'operational_only',
] as const satisfies readonly CallAuditEligibility[]

export const KSERVE_COMPARISON_LABELS = [
  'match',
  'mismatch',
  'not_comparable',
] as const satisfies readonly KserveComparisonLabel[]

export const MISMATCH_SEVERITIES = [
  'none',
  'low',
  'medium',
  'high',
] as const satisfies readonly MismatchSeverity[]

export const USAGE_ATTEMPT_OUTCOMES = [
  'succeeded',
  'refused',
  'failed',
] as const satisfies readonly UsageAttemptOutcome[]

/**
 * The bucket a summary tally uses for a row whose coded value is NULL — a fact
 * the audit did not determine. It is a state of its own: an undetermined intent
 * is never counted as WARM, and an unscored result is never counted as zero.
 */
export const UNDETERMINED_BUCKET = 'undetermined'

/** Largest page a single listing may claim, so one query cannot scan a table. */
export const MAX_RUN_PAGE_SIZE = 200
export const MAX_RESULT_PAGE_SIZE = 500

/** Decimal places of a reported average metric score. */
export const AVERAGE_SCORE_DECIMALS = 3

/** The 1-5 score values a metric distribution reports. NA is counted separately. */
export const METRIC_SCORE_VALUES = [1, 2, 3, 4, 5] as const

export type MetricScoreValue = (typeof METRIC_SCORE_VALUES)[number]

// ---------------------------------------------------------------------------
// Public query shapes
// ---------------------------------------------------------------------------

/** Half-open, UTC-naive, already computed by the caller. Never converted here. */
export interface CallAuditReportPeriod {
  /** Inclusive start. */
  periodStart: string
  /** EXCLUSIVE end; a call at exactly this instant is out of the period. */
  periodEndExclusive: string
}

/**
 * Scope of a period read.
 *
 * `runTypes` and `runId` are both optional and both narrow the same way. They
 * matter because these reads count RESULT ROWS: a re-audited call legitimately
 * owns a result under every run that audited it, and this repository never
 * silently de-duplicates history. A caller that needs one row per call scopes
 * to a single run, or to a single cadence run type.
 */
export interface CallAuditPeriodQuery {
  period: CallAuditReportPeriod
  runTypes?: readonly CallAuditRunType[] | null
  runId?: string | null
}

export interface CallAuditRunListQuery {
  period: CallAuditReportPeriod
  runTypes?: readonly CallAuditRunType[] | null
  statuses?: readonly CallAuditRunStatus[] | null
  limit: number
}

/** Keyset position: the last drilldown row already consumed. */
export interface CallAuditResultCursor {
  effectiveCallAt: string
  resultId: string
}

export interface CallAuditResultListQuery extends CallAuditPeriodQuery {
  limit: number
  cursor?: CallAuditResultCursor | null
}

// ---------------------------------------------------------------------------
// Public reporting DTOs. Named and shaped for the future API layer.
// ---------------------------------------------------------------------------

/**
 * One run and its progress. Rule provenance is limited to the opaque id and the
 * approved version label: no prompt, model, or scoring configuration.
 */
export interface CallAuditRunProgress {
  runId: string
  ruleVersionId: string
  ruleVersionLabel: string
  runType: CallAuditRunType
  /** The CALENDAR period the run covers, in `periodTimezone`. */
  periodStart: string
  periodEndExclusive: string
  periodTimezone: string
  status: CallAuditRunStatus
  counters: CallAuditRunCounters
  /** Safe machine code, or null. Never provider prose. */
  errorCode: string | null
  scheduledAt: string | null
  startedAt: string | null
  finishedAt: string | null
}

/** A tally over a closed vocabulary, plus the explicit undetermined bucket. */
export type CallAuditTally<Bucket extends string> = Record<
  Bucket | typeof UNDETERMINED_BUCKET,
  number
>

export interface CallAuditPeriodSummary {
  /** Echo of the validated scope, so a rendered report can state its own basis. */
  period: CallAuditReportPeriod
  runTypes: readonly CallAuditRunType[]
  runId: string | null
  /** Result rows in scope. NOT distinct calls; see {@link CallAuditPeriodQuery}. */
  resultCount: number
  /** Distinct audited source references in scope. */
  auditedCallCount: number
  byProcessingStatus: CallAuditTally<ProcessingStatus>
  byEligibility: CallAuditTally<CallAuditEligibility>
  byIntent: CallAuditTally<CallIntent>
  byGroupedOutcome: CallAuditTally<OutcomeGroup>
  byKserveComparison: CallAuditTally<KserveComparisonLabel>
  byMismatchSeverity: CallAuditTally<MismatchSeverity>
  byQualification: CallAuditTally<Qualification>
  byNextAction: CallAuditTally<NextActionCode>
  /** Coded flags only. A result may carry several, so these do not sum to a total. */
  byIssueFlag: Record<IssueFlag, number>
}

export interface CallAuditMetricScoreAggregate {
  metricCode: CallAuditMetricCode
  /** Rows carrying a 1-5 score. */
  scoredCount: number
  /** Rows explicitly marked NA. NA is never folded into a score of zero. */
  notApplicableCount: number
  /**
   * Mean of the scored rows as a stable fixed-precision string, half-up to
   * {@link AVERAGE_SCORE_DECIMALS} places. Null when nothing was scored —
   * absent is never reported as '0.000'.
   */
  averageScore: string | null
  distribution: Record<MetricScoreValue, number>
}

/**
 * One sanitized drilldown / report row. Explicitly anonymous: the only call
 * identity is `taskId`, and there is no transcript, lead id, hash, URL, PII, or
 * money on this shape at all.
 */
export interface CallAuditResultReportRow {
  resultId: string
  runId: string
  sourceRefId: string
  /** Approved anonymous display identifier; null when none could be derived. */
  taskId: string | null
  /** UTC-naive deterministic source event time the period selection used. */
  effectiveCallAt: string
  callDurationSeconds: number | null
  /** Presence signal only. The transcript itself is server-internal. */
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
  processingStatus: ProcessingStatus
  eligibility: CallAuditEligibility
  ineligibilityReason: string | null
  /** NULL means not determined, and is never read as false. */
  callConnected: boolean | null
  customerSpoke: boolean | null
  meaningfulConversation: boolean | null
  intent: CallIntent | null
  /** Fixed-precision decimal string; never a binary float. */
  intentConfidence: string | null
  /** BYTE-EXACT approved KServe label, exactly as stored. Never aliased. */
  detailedOutcome: string | null
  /** Application-derived management group, exactly as stored. */
  groupedOutcome: string | null
  qualificationLabel: Qualification | null
  nextActionCode: NextActionCode | null
  /** Weighted percentage as a fixed-precision string. Null is never 0.000. */
  overallScore: string | null
  /** Stable identity of the scoring method, for report provenance. */
  overallScoreMethod: string | null
  /** BYTE-EXACT label KServe reported for the same call. Never aliased. */
  kserveReportedOutcome: string | null
  kserveComparisonLabel: KserveComparisonLabel | null
  mismatchSeverity: MismatchSeverity | null
  /** Sanitized by the application validator before storage. */
  managementFeedback: string | null
  kserveFeedback: string | null
  improvementFeedback: string | null
  /** Approved coded flags only, never prose. */
  issueFlags: readonly IssueFlag[]
  auditedAt: string | null
}

/**
 * Reliability and volume per provider, model, and attempt outcome. Deliberately
 * money-free: there is no price, rate, amount, currency, or cost field here and
 * none is derivable from it without a Billing price table this module does not
 * import.
 */
export interface CallAuditUsageAggregate {
  providerName: string
  modelName: string
  modelVersion: string
  attemptOutcome: UsageAttemptOutcome
  /** Attempts, including retries, refusals, and failures. */
  attemptCount: number
  /** Distinct results those attempts covered. */
  resultCount: number
  maxAttemptNumber: number
  /**
   * BIGINT sums as canonical decimal STRINGS. A token total can exceed the
   * safe-integer range, so it never passes through a JS number.
   */
  inputTokensTotal: string
  outputTokensTotal: string
  totalTokensTotal: string
  latencyMsTotal: string
  latencyMsMax: string | null
  /** Attempts carrying a coded error. The code itself is not reported. */
  erroredCount: number
}

// ---------------------------------------------------------------------------
// Validation primitives
// ---------------------------------------------------------------------------

/** Every value bound to a placeholder is one of these primitives. */
type SqlValue = string | number

/**
 * UTC-naive datetime literal. A trailing Z or a numeric offset is REJECTED
 * rather than converted: a silent conversion would shift every boundary and
 * quietly change which calls a period contains.
 */
const NAIVE_DATETIME =
  /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?$/

const CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/

/** Canonical non-negative decimal, as MySQL renders an integer cast to CHAR. */
const CANONICAL_DECIMAL = /^(?:0|[1-9]\d*)$/

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeapYear(year) ? 29 : 28
  return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31
}

/**
 * Normalizes to 'YYYY-MM-DD HH:MM:SS.ffffff' so comparison is lexicographic,
 * checking every component against the Gregorian calendar. Date parsing is
 * deliberately NOT used: JavaScript rolls impossible dates forward, so
 * '2026-02-30' would silently become 2 March and shift the reported period.
 */
function requireNaiveDatetime(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new CallAuditReportingError(field, 'must be a string')
  }
  const match = NAIVE_DATETIME.exec(value.trim())
  if (!match) {
    throw new CallAuditReportingError(
      field,
      "must be a UTC-naive 'YYYY-MM-DD HH:MM:SS' datetime",
    )
  }
  const [, yearText, monthText, dayText, hourText, minuteText, secondText] =
    match
  const fraction = match[7] ?? ''
  const year = Number(yearText)
  const month = Number(monthText)
  const day = Number(dayText)

  if (year < 1) {
    throw new CallAuditReportingError(field, 'has an invalid year')
  }
  if (month < 1 || month > 12) {
    throw new CallAuditReportingError(field, 'has an invalid month')
  }
  if (day < 1 || day > daysInMonth(year, month)) {
    throw new CallAuditReportingError(field, 'has an invalid day for that month')
  }
  if (Number(hourText) > 23) {
    throw new CallAuditReportingError(field, 'has an invalid hour')
  }
  if (Number(minuteText) > 59) {
    throw new CallAuditReportingError(field, 'has an invalid minute')
  }
  if (Number(secondText) > 59) {
    throw new CallAuditReportingError(field, 'has an invalid second')
  }
  return (
    `${yearText}-${monthText}-${dayText} ` +
    `${hourText}:${minuteText}:${secondText}.${fraction.padEnd(6, '0')}`
  )
}

/**
 * Validates the half-open period BEFORE any SQL runs. An empty or inverted
 * window is a caller bug, not a legitimate zero-row report.
 */
export function validateReportPeriod(
  period: CallAuditReportPeriod,
  field = 'period',
): CallAuditReportPeriod {
  if (!period || typeof period !== 'object') {
    throw new CallAuditReportingError(field, 'must be an object')
  }
  const periodStart = requireNaiveDatetime(
    period.periodStart,
    `${field}.periodStart`,
  )
  const periodEndExclusive = requireNaiveDatetime(
    period.periodEndExclusive,
    `${field}.periodEndExclusive`,
  )
  if (periodEndExclusive <= periodStart) {
    throw new CallAuditReportingError(
      `${field}.periodEndExclusive`,
      'must be strictly after periodStart',
    )
  }
  return { periodStart, periodEndExclusive }
}

/**
 * Validates an optional enum filter and returns it de-duplicated in vocabulary
 * order, so the same request always produces the same SQL and the same echo.
 */
function validateEnumFilter<T extends string>(
  values: readonly string[] | null | undefined,
  vocabulary: readonly T[],
  field: string,
): readonly T[] {
  if (values === null || values === undefined) return []
  if (!Array.isArray(values)) {
    throw new CallAuditReportingError(field, 'must be an array or null')
  }
  const requested = new Set<string>()
  for (const value of values) {
    if (!(vocabulary as readonly string[]).includes(value)) {
      throw new CallAuditReportingError(
        field,
        `must contain only ${vocabulary.join(', ')}`,
      )
    }
    requested.add(value)
  }
  return vocabulary.filter((value) => requested.has(value))
}

function validateLimit(value: unknown, maximum: number, field: string): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > maximum
  ) {
    throw new CallAuditReportingError(
      field,
      `must be an integer between 1 and ${maximum}`,
    )
  }
  return value
}

function requireId(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new CallAuditReportingError(field, 'must be a string')
  }
  const text = value.trim()
  if (!text) {
    throw new CallAuditReportingError(field, 'must not be blank')
  }
  if (text.length > MAX_ID_LENGTH) {
    throw new CallAuditReportingError(
      field,
      `must be at most ${MAX_ID_LENGTH} characters`,
    )
  }
  if (CONTROL_CHARACTER.test(text)) {
    throw new CallAuditReportingError(
      field,
      'must not contain control characters',
    )
  }
  return text
}

function optionalId(value: unknown, field: string): string | null {
  if (value === null || value === undefined) return null
  return requireId(value, field)
}

interface ValidatedPeriodScope {
  period: CallAuditReportPeriod
  runTypes: readonly CallAuditRunType[]
  runId: string | null
}

export function validatePeriodQuery(
  query: CallAuditPeriodQuery,
): ValidatedPeriodScope {
  if (!query || typeof query !== 'object') {
    throw new CallAuditReportingError('query', 'must be an object')
  }
  return {
    period: validateReportPeriod(query.period),
    runTypes: validateEnumFilter(query.runTypes, RUN_TYPES, 'runTypes'),
    runId: optionalId(query.runId, 'runId'),
  }
}

/**
 * Cursor for the next drilldown page, or null when the page was empty. Callers
 * page by passing this back — never by an OFFSET, which would repeat or skip
 * rows as later runs append results underneath a long report walk.
 */
export function nextCallAuditResultCursor(
  rows: readonly CallAuditResultReportRow[],
): CallAuditResultCursor | null {
  const last = rows[rows.length - 1]
  if (!last) return null
  return { effectiveCallAt: last.effectiveCallAt, resultId: last.resultId }
}

function validateResultCursor(
  cursor: CallAuditResultCursor | null | undefined,
  period: CallAuditReportPeriod,
): CallAuditResultCursor | null {
  if (cursor === null || cursor === undefined) return null
  if (typeof cursor !== 'object') {
    throw new CallAuditReportingError('cursor', 'must be an object or null')
  }
  const effectiveCallAt = requireNaiveDatetime(
    cursor.effectiveCallAt,
    'cursor.effectiveCallAt',
  )
  // A cursor outside the period would either repeat rows already rendered or
  // skip the head of the period entirely.
  if (effectiveCallAt < period.periodStart) {
    throw new CallAuditReportingError(
      'cursor.effectiveCallAt',
      'must not precede periodStart',
    )
  }
  if (effectiveCallAt >= period.periodEndExclusive) {
    throw new CallAuditReportingError(
      'cursor.effectiveCallAt',
      'must be before periodEndExclusive',
    )
  }
  return {
    effectiveCallAt,
    resultId: requireId(cursor.resultId, 'cursor.resultId'),
  }
}

// ---------------------------------------------------------------------------
// Row-value mapping helpers. Small and pure.
// ---------------------------------------------------------------------------

function pad(value: number, width: number): string {
  return String(value).padStart(width, '0')
}

/**
 * Normalizes a datetime to a UTC-naive 'YYYY-MM-DD HH:MM:SS.ffffff' literal.
 *
 * Every datetime is selected as CHAR, so a string is the normal case. A driver
 * Date is still handled: mysql2 builds it from a DATETIME using the process
 * timezone, so formatting it back with local getters is the exact inverse and
 * returns the stored wall-clock digits unchanged. Converting to a UTC ISO
 * string instead would shift every value by the process offset.
 */
function naiveDatetimeText(value: unknown): string | null {
  if (value === null || value === undefined) return null
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null
    return (
      `${value.getFullYear()}-${pad(value.getMonth() + 1, 2)}-` +
      `${pad(value.getDate(), 2)} ${pad(value.getHours(), 2)}:` +
      `${pad(value.getMinutes(), 2)}:${pad(value.getSeconds(), 2)}.` +
      `${pad(value.getMilliseconds(), 3)}000`
    )
  }
  const match = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?/.exec(
    String(value).trim(),
  )
  if (!match) return null
  return `${match[1]} ${match[2]}.${(match[3] ?? '').padEnd(6, '0')}`
}

function requireDatetime(value: unknown, column: string): string {
  const text = naiveDatetimeText(value)
  if (text === null) {
    throw new CallAuditReportingError(column, 'is not a readable datetime')
  }
  return text
}

function textOrNull(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value)
}

function requireText(value: unknown, column: string): string {
  const text = textOrNull(value)
  if (text === null || text === '') {
    throw new CallAuditReportingError(column, 'must not be null or blank')
  }
  return text
}

/** MySQL has no boolean; tinyint(1) is 0/1. NULL stays NULL, never false. */
function booleanOrNull(value: unknown): boolean | null {
  if (value === null || value === undefined) return null
  return Number(value) === 1
}

function requireBoolean(value: unknown, column: string): boolean {
  const flag = booleanOrNull(value)
  if (flag === null) {
    throw new CallAuditReportingError(column, 'must not be null')
  }
  return flag
}

/**
 * Reads a BIGINT-ish aggregate as its canonical decimal STRING. Every count,
 * token, and latency column is selected as CHAR precisely so a large value can
 * be reported without ever being rounded by a JS number.
 */
function decimalText(value: unknown, column: string): string {
  if (value === null || value === undefined) return '0'
  const text = String(value).trim()
  if (!CANONICAL_DECIMAL.test(text)) {
    throw new CallAuditReportingError(
      column,
      'is not a canonical non-negative decimal',
    )
  }
  return text
}

function optionalDecimalText(value: unknown, column: string): string | null {
  if (value === null || value === undefined) return null
  return decimalText(value, column)
}

/** A counter small enough to be a JS number, proven rather than assumed. */
function countOf(value: unknown, column: string): number {
  const text = decimalText(value, column)
  const count = Number(text)
  if (!Number.isSafeInteger(count)) {
    throw new CallAuditReportingError(
      column,
      'is outside the safe integer range',
    )
  }
  return count
}

function optionalCount(value: unknown, column: string): number | null {
  if (value === null || value === undefined) return null
  return countOf(value, column)
}

/**
 * Types a stored coded value against its closed vocabulary. A value outside it
 * means the database drifted from migration 0008's CHECK constraints, and a
 * report will not render a code it cannot type. Only the COLUMN is named.
 */
function requireMember<T extends string>(
  value: unknown,
  vocabulary: readonly T[],
  column: string,
): T {
  const text = requireText(value, column)
  if (!(vocabulary as readonly string[]).includes(text)) {
    throw new CallAuditReportingError(
      column,
      'holds a value outside its approved vocabulary',
    )
  }
  return text as T
}

function optionalMember<T extends string>(
  value: unknown,
  vocabulary: readonly T[],
  column: string,
): T | null {
  if (value === null || value === undefined) return null
  return requireMember(value, vocabulary, column)
}

/**
 * Reads the coded issue flags of a result.
 *
 * Only approved codes survive, sorted for a stable report order. Malformed JSON
 * yields no flags rather than propagating the stored text: whatever an
 * unparseable payload contains, it is not something a sanitized report shows.
 */
export function parseIssueFlags(value: unknown): readonly IssueFlag[] {
  if (typeof value !== 'string' || !value.trim()) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  const approved = new Set<IssueFlag>()
  for (const entry of parsed) {
    if (
      typeof entry === 'string' &&
      (ISSUE_FLAGS as readonly string[]).includes(entry)
    ) {
      approved.add(entry as IssueFlag)
    }
  }
  return ISSUE_FLAGS.filter((flag) => approved.has(flag))
}

const AVERAGE_SCALE = 10n ** BigInt(AVERAGE_SCORE_DECIMALS)

/**
 * Mean of the scored metric rows as a fixed-precision string, half-up, in
 * integer (BigInt) arithmetic only.
 *
 * Binary floating point is never involved: an IEEE double cannot hold a value
 * like 3.667 exactly, and the same period must re-render the same string. Both
 * inputs are non-negative, so half-up and half-away-from-zero coincide.
 */
export function averageMetricScore(
  scoreTotal: string,
  scoredCount: number,
): string | null {
  // Absent is not zero: nothing scored means there is no average to report.
  if (scoredCount <= 0) return null
  const total = BigInt(scoreTotal) * AVERAGE_SCALE
  const count = BigInt(scoredCount)
  const quotient = total / count
  const remainder = total % count
  const scaled = remainder * 2n >= count ? quotient + 1n : quotient
  const whole = scaled / AVERAGE_SCALE
  const fraction = scaled % AVERAGE_SCALE
  return `${whole}.${fraction.toString().padStart(AVERAGE_SCORE_DECIMALS, '0')}`
}

/**
 * Folds GROUP BY rows into a zero-filled tally over a closed vocabulary.
 *
 * A NULL bucket is counted as {@link UNDETERMINED_BUCKET}. So is any value
 * outside the vocabulary: a period tally must not fail because one row drifted,
 * and a foreign label must never appear in a report, so it is counted without
 * being surfaced.
 */
export function tallyBuckets<Bucket extends string>(
  rows: readonly BucketRow[],
  vocabulary: readonly Bucket[],
  column: string,
): CallAuditTally<Bucket> {
  const tally = Object.fromEntries(
    [...vocabulary, UNDETERMINED_BUCKET].map((bucket) => [bucket, 0]),
  ) as CallAuditTally<Bucket>
  for (const row of rows) {
    const bucket = textOrNull(row.bucket)
    const key =
      bucket !== null && (vocabulary as readonly string[]).includes(bucket)
        ? (bucket as Bucket)
        : UNDETERMINED_BUCKET
    tally[key] += countOf(row.bucket_count, column)
  }
  return tally
}

// ---------------------------------------------------------------------------
// SQL — the only six tables named in this file
// ---------------------------------------------------------------------------

const RESULT_TABLE = 'kaudit_call_audit_result'
const SOURCE_REF_TABLE = 'kaudit_call_audit_source_ref'
const RUN_TABLE = 'kaudit_call_audit_run'
const RULE_VERSION_TABLE = 'kaudit_call_audit_rule_version'
const METRIC_SCORE_TABLE = 'kaudit_call_audit_metric_score'
const USAGE_EVENT_TABLE = 'kaudit_call_audit_usage_event'

/**
 * Period axis of every result-based read: the deterministic source event time,
 * which migration 0008 makes the leading column of its period and report
 * indexes precisely because `call_started_at` is null for many real calls.
 */
const EFFECTIVE_CALL_AT = 'src.`effective_call_at`'

const PERIOD_PREDICATE = `${EFFECTIVE_CALL_AT} >= ? AND ${EFFECTIVE_CALL_AT} < ?`

/** Joined only when a run-type filter is asked for; results carry their own ids. */
const RUN_FILTER_JOIN =
  `JOIN \`${RUN_TABLE}\` \`run\` ON \`run\`.\`id\` = res.\`run_id\``

const RESULT_FROM = `FROM \`${RESULT_TABLE}\` res
   JOIN \`${SOURCE_REF_TABLE}\` src ON src.\`id\` = res.\`source_ref_id\``

const METRIC_FROM = `FROM \`${METRIC_SCORE_TABLE}\` ms
   JOIN \`${RESULT_TABLE}\` res ON res.\`id\` = ms.\`result_id\`
   JOIN \`${SOURCE_REF_TABLE}\` src ON src.\`id\` = res.\`source_ref_id\``

const USAGE_FROM = `FROM \`${USAGE_EVENT_TABLE}\` ue
   JOIN \`${RESULT_TABLE}\` res ON res.\`id\` = ue.\`result_id\`
   JOIN \`${SOURCE_REF_TABLE}\` src ON src.\`id\` = res.\`source_ref_id\``

interface ScopedSql {
  from: string
  where: string
  parameters: SqlValue[]
}

/**
 * Builds the FROM/WHERE of a scoped period read. Every caller value is a
 * placeholder; the only text assembled is a fixed module fragment, so there is
 * no injection surface even though the statement shape varies with the filters.
 */
function buildScopedSql(base: string, scope: ValidatedPeriodScope): ScopedSql {
  const parameters: SqlValue[] = [
    scope.period.periodStart,
    scope.period.periodEndExclusive,
  ]
  const conditions = [PERIOD_PREDICATE]
  let from = base
  if (scope.runTypes.length > 0) {
    from = `${base}\n   ${RUN_FILTER_JOIN}`
    conditions.push(
      `\`run\`.\`run_type\` IN (${scope.runTypes.map(() => '?').join(', ')})`,
    )
    parameters.push(...scope.runTypes)
  }
  if (scope.runId !== null) {
    conditions.push('res.`run_id` = ?')
    parameters.push(scope.runId)
  }
  return { from, where: conditions.join('\n     AND '), parameters }
}

// --- Runs -------------------------------------------------------------------

/**
 * Rule provenance is limited to the opaque id and the approved version label.
 * `business_prompt` and `scoring_config_json` are NEVER selected here, and
 * neither are the model provider, name, version, or temperature: the prompt lab
 * and model settings are admin-only surfaces, not report data.
 */
const RUN_PROGRESS_PROJECTION = `\`run\`.\`id\` AS run_id,
          \`run\`.\`rule_version_id\` AS rule_version_id,
          rv.\`version_label\` AS rule_version_label,
          \`run\`.\`run_type\` AS run_type,
          CAST(\`run\`.\`period_start\` AS CHAR) AS period_start,
          CAST(\`run\`.\`period_end_exclusive\` AS CHAR) AS period_end_exclusive,
          \`run\`.\`period_timezone\` AS period_timezone,
          \`run\`.\`status\` AS status,
          CAST(\`run\`.\`total_candidates\` AS CHAR) AS total_candidates,
          CAST(\`run\`.\`processed_count\` AS CHAR) AS processed_count,
          CAST(\`run\`.\`succeeded_count\` AS CHAR) AS succeeded_count,
          CAST(\`run\`.\`failed_count\` AS CHAR) AS failed_count,
          CAST(\`run\`.\`skipped_count\` AS CHAR) AS skipped_count,
          CAST(\`run\`.\`content_auditable_count\` AS CHAR) AS content_auditable_count,
          CAST(\`run\`.\`operational_only_count\` AS CHAR) AS operational_only_count,
          \`run\`.\`error_code\` AS error_code,
          CAST(\`run\`.\`scheduled_at\` AS CHAR) AS scheduled_at,
          CAST(\`run\`.\`started_at\` AS CHAR) AS started_at,
          CAST(\`run\`.\`finished_at\` AS CHAR) AS finished_at`

const RUN_PROGRESS_FROM = `FROM \`${RUN_TABLE}\` \`run\`
   JOIN \`${RULE_VERSION_TABLE}\` rv ON rv.\`id\` = \`run\`.\`rule_version_id\``

const SELECT_RUN_BY_ID_SQL = `SELECT ${RUN_PROGRESS_PROJECTION}
   ${RUN_PROGRESS_FROM}
   WHERE \`run\`.\`id\` = ?`

/**
 * Run listing over a bounded half-open window on the run's own CALENDAR period
 * start. Most recent period first, with the id as a deterministic tiebreak so
 * two runs covering the same period never swap places between reads.
 */
function buildRunListSql(filters: string[]): string {
  return `SELECT ${RUN_PROGRESS_PROJECTION}
   ${RUN_PROGRESS_FROM}
   WHERE ${filters.join('\n     AND ')}
   ORDER BY \`run\`.\`period_start\` DESC, \`run\`.\`id\` ASC
   LIMIT ?`
}

interface RunProgressRow extends RowDataPacket {
  [column: string]: unknown
}

function mapRunProgress(row: RunProgressRow): CallAuditRunProgress {
  return {
    runId: requireText(row.run_id, 'run.id'),
    ruleVersionId: requireText(row.rule_version_id, 'run.rule_version_id'),
    ruleVersionLabel: requireText(
      row.rule_version_label,
      'rule_version.version_label',
    ),
    runType: requireMember(row.run_type, RUN_TYPES, 'run.run_type'),
    periodStart: requireDatetime(row.period_start, 'run.period_start'),
    periodEndExclusive: requireDatetime(
      row.period_end_exclusive,
      'run.period_end_exclusive',
    ),
    periodTimezone: requireText(row.period_timezone, 'run.period_timezone'),
    status: requireMember(row.status, RUN_STATUSES, 'run.status'),
    counters: {
      totalCandidates: countOf(row.total_candidates, 'run.total_candidates'),
      processedCount: countOf(row.processed_count, 'run.processed_count'),
      succeededCount: countOf(row.succeeded_count, 'run.succeeded_count'),
      failedCount: countOf(row.failed_count, 'run.failed_count'),
      skippedCount: countOf(row.skipped_count, 'run.skipped_count'),
      contentAuditableCount: countOf(
        row.content_auditable_count,
        'run.content_auditable_count',
      ),
      operationalOnlyCount: countOf(
        row.operational_only_count,
        'run.operational_only_count',
      ),
    },
    errorCode: textOrNull(row.error_code),
    scheduledAt: naiveDatetimeText(row.scheduled_at),
    startedAt: naiveDatetimeText(row.started_at),
    finishedAt: naiveDatetimeText(row.finished_at),
  }
}

// --- Period summary ---------------------------------------------------------

const SELECT_SUMMARY_TOTALS = `SELECT CAST(COUNT(*) AS CHAR) AS result_count,
          CAST(COUNT(DISTINCT res.\`source_ref_id\`) AS CHAR) AS audited_call_count`

/**
 * The summary dimensions. Every column here is a FIXED fragment from this
 * allowlist and never caller input, so a dimension can be added only by
 * editing this table.
 */
const SUMMARY_DIMENSIONS = [
  {
    key: 'byProcessingStatus',
    column: 'res.`processing_status`',
    vocabulary: PROCESSING_STATUSES,
  },
  {
    key: 'byEligibility',
    column: 'res.`eligibility`',
    vocabulary: ELIGIBILITIES,
  },
  { key: 'byIntent', column: 'res.`intent`', vocabulary: CALL_INTENTS },
  {
    key: 'byGroupedOutcome',
    column: 'res.`grouped_outcome`',
    vocabulary: OUTCOME_GROUPS,
  },
  {
    key: 'byKserveComparison',
    column: 'res.`kserve_comparison_label`',
    vocabulary: KSERVE_COMPARISON_LABELS,
  },
  {
    key: 'byMismatchSeverity',
    column: 'res.`mismatch_severity`',
    vocabulary: MISMATCH_SEVERITIES,
  },
  {
    key: 'byQualification',
    column: 'res.`qualification_label`',
    vocabulary: QUALIFICATIONS,
  },
  {
    key: 'byNextAction',
    column: 'res.`next_action_code`',
    vocabulary: NEXT_ACTION_CODES,
  },
] as const

type SummaryDimension = (typeof SUMMARY_DIMENSIONS)[number]

export interface BucketRow extends RowDataPacket {
  bucket: unknown
  bucket_count: unknown
}

function buildDimensionSql(dimension: SummaryDimension, scoped: ScopedSql) {
  return `SELECT ${dimension.column} AS bucket,
          CAST(COUNT(*) AS CHAR) AS bucket_count
   ${scoped.from}
   WHERE ${scoped.where}
   GROUP BY ${dimension.column}
   ORDER BY ${dimension.column} ASC`
}

/**
 * Needle for one coded issue flag: the quoted code as it appears in the
 * canonical JSON array the persistence layer writes.
 *
 * `INSTR` is used rather than `LIKE` because every approved flag code contains
 * an underscore, which `LIKE` would treat as a single-character wildcard, and
 * rather than a JSON function because the column is a LONGTEXT whose JSON
 * support differs between MySQL and MariaDB. The column's utf8mb4_bin collation
 * makes the search byte-exact, which is exactly right for a closed code set.
 */
export function issueFlagNeedle(flag: IssueFlag): string {
  return `"${flag}"`
}

function buildIssueFlagSql(scoped: ScopedSql): string {
  const columns = ISSUE_FLAGS.map(
    (flag) =>
      `CAST(COALESCE(SUM(CASE WHEN INSTR(res.\`issue_flags_json\`, ?) > 0 ` +
      `THEN 1 ELSE 0 END), 0) AS CHAR) AS \`flag_${flag}\``,
  ).join(',\n          ')
  return `SELECT ${columns}
   ${scoped.from}
   WHERE ${scoped.where}`
}

// --- Metric aggregates ------------------------------------------------------

const METRIC_DISTRIBUTION_COLUMNS = METRIC_SCORE_VALUES.map(
  (value) =>
    `CAST(COALESCE(SUM(CASE WHEN ms.\`score_value\` = ${value} ` +
    `THEN 1 ELSE 0 END), 0) AS CHAR) AS score_${value}`,
).join(',\n          ')

/**
 * Aggregates per metric code. `COUNT(score_value)` counts scored rows only, so
 * an explicit NA never contributes to the average, and the score total is cast
 * to CHAR so the sum is read as an exact decimal string.
 */
function buildMetricAggregateSql(scoped: ScopedSql): string {
  return `SELECT ms.\`metric_code\` AS metric_code,
          CAST(COUNT(ms.\`score_value\`) AS CHAR) AS scored_count,
          CAST(COALESCE(SUM(CASE WHEN ms.\`is_not_applicable\` = 1 THEN 1 ELSE 0 END), 0) AS CHAR) AS na_count,
          CAST(COALESCE(SUM(ms.\`score_value\`), 0) AS CHAR) AS score_total,
          ${METRIC_DISTRIBUTION_COLUMNS}
   ${scoped.from}
   WHERE ${scoped.where}
   GROUP BY ms.\`metric_code\`
   ORDER BY ms.\`metric_code\` ASC`
}

interface MetricAggregateRow extends RowDataPacket {
  [column: string]: unknown
}

const EMPTY_METRIC_DISTRIBUTION: Record<MetricScoreValue, number> = Object.freeze(
  { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 },
)

function emptyMetricAggregate(
  metricCode: CallAuditMetricCode,
): CallAuditMetricScoreAggregate {
  return {
    metricCode,
    scoredCount: 0,
    notApplicableCount: 0,
    averageScore: null,
    distribution: { ...EMPTY_METRIC_DISTRIBUTION },
  }
}

function mapMetricAggregate(
  row: MetricAggregateRow,
  metricCode: CallAuditMetricCode,
): CallAuditMetricScoreAggregate {
  const scoredCount = countOf(row.scored_count, 'metric_score.score_value')
  const distribution = { ...EMPTY_METRIC_DISTRIBUTION }
  for (const value of METRIC_SCORE_VALUES) {
    distribution[value] = countOf(
      row[`score_${value}`],
      `metric_score.score_value=${value}`,
    )
  }
  return {
    metricCode,
    scoredCount,
    notApplicableCount: countOf(
      row.na_count,
      'metric_score.is_not_applicable',
    ),
    averageScore: averageMetricScore(
      decimalText(row.score_total, 'metric_score.score_value'),
      scoredCount,
    ),
    distribution,
  }
}

// --- Sanitized result rows --------------------------------------------------

/**
 * The explicit sanitized projection. Every column was reviewed individually.
 *
 * Deliberately ABSENT: `lead_id_sha256`, `transcript_sha256`,
 * `source_revision_sha256`, `source_row_id`, `data_source`, `verified_source`,
 * `result_json`, `result_sha256`, `error_detail`, `rule_version_id`'s prompt
 * and configuration, and every column of the external source table.
 */
const RESULT_ROW_PROJECTION = `res.\`id\` AS result_id,
          res.\`run_id\` AS run_id,
          res.\`source_ref_id\` AS source_ref_id,
          src.\`task_id\` AS task_id,
          CAST(src.\`effective_call_at\` AS CHAR) AS effective_call_at,
          CAST(src.\`call_duration_seconds\` AS CHAR) AS call_duration_seconds,
          src.\`has_transcript\` AS has_transcript,
          src.\`company\` AS company,
          src.\`company_by_kserve\` AS company_by_kserve,
          src.\`service_category\` AS service_category,
          src.\`call_type\` AS call_type,
          src.\`call_status\` AS call_status,
          src.\`final_call_status\` AS final_call_status,
          src.\`ai_call_category\` AS ai_call_category,
          src.\`customer_engagement_level\` AS customer_engagement_level,
          src.\`interest_level\` AS interest_level,
          src.\`call_outcome\` AS call_outcome,
          src.\`lead_status\` AS lead_status,
          src.\`final_lead_outcome\` AS final_lead_outcome,
          src.\`calculated_qualification_status\` AS calculated_qualification_status,
          src.\`followup_required\` AS followup_required,
          res.\`processing_status\` AS processing_status,
          res.\`eligibility\` AS eligibility,
          res.\`ineligibility_reason\` AS ineligibility_reason,
          res.\`call_connected\` AS call_connected,
          res.\`customer_spoke\` AS customer_spoke,
          res.\`meaningful_conversation\` AS meaningful_conversation,
          res.\`intent\` AS intent,
          CAST(res.\`intent_confidence\` AS CHAR) AS intent_confidence,
          res.\`detailed_outcome\` AS detailed_outcome,
          res.\`grouped_outcome\` AS grouped_outcome,
          res.\`qualification_label\` AS qualification_label,
          res.\`next_action_code\` AS next_action_code,
          CAST(res.\`overall_score\` AS CHAR) AS overall_score,
          res.\`overall_score_method\` AS overall_score_method,
          res.\`kserve_reported_outcome\` AS kserve_reported_outcome,
          res.\`kserve_comparison_label\` AS kserve_comparison_label,
          res.\`mismatch_severity\` AS mismatch_severity,
          res.\`management_feedback\` AS management_feedback,
          res.\`kserve_feedback\` AS kserve_feedback,
          res.\`improvement_feedback\` AS improvement_feedback,
          res.\`issue_flags_json\` AS issue_flags_json,
          CAST(res.\`audited_at\` AS CHAR) AS audited_at`

/**
 * Keyset pagination, never OFFSET: strictly after the last row consumed, on the
 * same (effective_call_at, id) order the listing is sorted by.
 */
const RESULT_CURSOR_PREDICATE = `(
       ${EFFECTIVE_CALL_AT} > ?
       OR (${EFFECTIVE_CALL_AT} = ? AND res.\`id\` > ?)
     )`

function buildResultListSql(scoped: ScopedSql, cursor: boolean): string {
  const where = cursor
    ? `${scoped.where}\n     AND ${RESULT_CURSOR_PREDICATE}`
    : scoped.where
  return `SELECT ${RESULT_ROW_PROJECTION}
   ${scoped.from}
   WHERE ${where}
   ORDER BY ${EFFECTIVE_CALL_AT} ASC, res.\`id\` ASC
   LIMIT ?`
}

interface ResultReportRowData extends RowDataPacket {
  [column: string]: unknown
}

function mapResultRow(row: ResultReportRowData): CallAuditResultReportRow {
  return {
    resultId: requireText(row.result_id, 'result.id'),
    runId: requireText(row.run_id, 'result.run_id'),
    sourceRefId: requireText(row.source_ref_id, 'result.source_ref_id'),
    taskId: textOrNull(row.task_id),
    effectiveCallAt: requireDatetime(
      row.effective_call_at,
      'source_ref.effective_call_at',
    ),
    callDurationSeconds: optionalCount(
      row.call_duration_seconds,
      'source_ref.call_duration_seconds',
    ),
    hasTranscript: requireBoolean(
      row.has_transcript,
      'source_ref.has_transcript',
    ),
    company: textOrNull(row.company),
    companyByKserve: textOrNull(row.company_by_kserve),
    serviceCategory: textOrNull(row.service_category),
    callType: textOrNull(row.call_type),
    callStatus: textOrNull(row.call_status),
    finalCallStatus: textOrNull(row.final_call_status),
    aiCallCategory: textOrNull(row.ai_call_category),
    customerEngagementLevel: textOrNull(row.customer_engagement_level),
    interestLevel: textOrNull(row.interest_level),
    callOutcome: textOrNull(row.call_outcome),
    leadStatus: textOrNull(row.lead_status),
    finalLeadOutcome: textOrNull(row.final_lead_outcome),
    calculatedQualificationStatus: textOrNull(
      row.calculated_qualification_status,
    ),
    followupRequired: textOrNull(row.followup_required),
    processingStatus: requireMember(
      row.processing_status,
      PROCESSING_STATUSES,
      'result.processing_status',
    ),
    eligibility: requireMember(
      row.eligibility,
      ELIGIBILITIES,
      'result.eligibility',
    ),
    ineligibilityReason: textOrNull(row.ineligibility_reason),
    callConnected: booleanOrNull(row.call_connected),
    customerSpoke: booleanOrNull(row.customer_spoke),
    meaningfulConversation: booleanOrNull(row.meaningful_conversation),
    intent: optionalMember(row.intent, CALL_INTENTS, 'result.intent'),
    intentConfidence: textOrNull(row.intent_confidence),
    // Byte-exact vendor taxonomy: kept as stored, never aliased or normalized.
    detailedOutcome: textOrNull(row.detailed_outcome),
    groupedOutcome: textOrNull(row.grouped_outcome),
    qualificationLabel: optionalMember(
      row.qualification_label,
      QUALIFICATIONS,
      'result.qualification_label',
    ),
    nextActionCode: optionalMember(
      row.next_action_code,
      NEXT_ACTION_CODES,
      'result.next_action_code',
    ),
    overallScore: textOrNull(row.overall_score),
    overallScoreMethod: textOrNull(row.overall_score_method),
    kserveReportedOutcome: textOrNull(row.kserve_reported_outcome),
    kserveComparisonLabel: optionalMember(
      row.kserve_comparison_label,
      KSERVE_COMPARISON_LABELS,
      'result.kserve_comparison_label',
    ),
    mismatchSeverity: optionalMember(
      row.mismatch_severity,
      MISMATCH_SEVERITIES,
      'result.mismatch_severity',
    ),
    managementFeedback: textOrNull(row.management_feedback),
    kserveFeedback: textOrNull(row.kserve_feedback),
    improvementFeedback: textOrNull(row.improvement_feedback),
    issueFlags: parseIssueFlags(row.issue_flags_json),
    auditedAt: naiveDatetimeText(row.audited_at),
  }
}

// --- Usage aggregates -------------------------------------------------------

/**
 * Volume and reliability per provider, model, and attempt outcome.
 *
 * NO cost, price, rate, amount, or currency column appears here or in the DTO,
 * and no usage `error_code` text is selected — a coded reason is a Billing- and
 * ops-side concern, and a sanitized reliability report needs only how many
 * attempts carried one.
 */
function buildUsageAggregateSql(scoped: ScopedSql): string {
  return `SELECT ue.\`provider_name\` AS provider_name,
          ue.\`model_name\` AS model_name,
          ue.\`model_version\` AS model_version,
          ue.\`attempt_outcome\` AS attempt_outcome,
          CAST(COUNT(*) AS CHAR) AS attempt_count,
          CAST(COUNT(DISTINCT ue.\`result_id\`) AS CHAR) AS result_count,
          CAST(COALESCE(MAX(ue.\`attempt_number\`), 0) AS CHAR) AS max_attempt_number,
          CAST(COALESCE(SUM(ue.\`input_tokens\`), 0) AS CHAR) AS input_tokens_total,
          CAST(COALESCE(SUM(ue.\`output_tokens\`), 0) AS CHAR) AS output_tokens_total,
          CAST(COALESCE(SUM(ue.\`total_tokens\`), 0) AS CHAR) AS total_tokens_total,
          CAST(COALESCE(SUM(ue.\`latency_ms\`), 0) AS CHAR) AS latency_ms_total,
          CAST(MAX(ue.\`latency_ms\`) AS CHAR) AS latency_ms_max,
          CAST(COALESCE(SUM(CASE WHEN ue.\`error_code\` IS NOT NULL THEN 1 ELSE 0 END), 0) AS CHAR) AS errored_count
   ${scoped.from}
   WHERE ${scoped.where}
   GROUP BY ue.\`provider_name\`, ue.\`model_name\`, ue.\`model_version\`, ue.\`attempt_outcome\`
   ORDER BY ue.\`provider_name\` ASC, ue.\`model_name\` ASC, ue.\`model_version\` ASC, ue.\`attempt_outcome\` ASC`
}

interface UsageAggregateRow extends RowDataPacket {
  [column: string]: unknown
}

function mapUsageAggregate(row: UsageAggregateRow): CallAuditUsageAggregate {
  return {
    providerName: requireText(row.provider_name, 'usage_event.provider_name'),
    modelName: requireText(row.model_name, 'usage_event.model_name'),
    modelVersion: requireText(row.model_version, 'usage_event.model_version'),
    attemptOutcome: requireMember(
      row.attempt_outcome,
      USAGE_ATTEMPT_OUTCOMES,
      'usage_event.attempt_outcome',
    ),
    attemptCount: countOf(row.attempt_count, 'usage_event.attempt_count'),
    resultCount: countOf(row.result_count, 'usage_event.result_id'),
    maxAttemptNumber: countOf(
      row.max_attempt_number,
      'usage_event.attempt_number',
    ),
    // Token and latency sums stay STRINGS: a BIGINT total must never be rounded.
    inputTokensTotal: decimalText(
      row.input_tokens_total,
      'usage_event.input_tokens',
    ),
    outputTokensTotal: decimalText(
      row.output_tokens_total,
      'usage_event.output_tokens',
    ),
    totalTokensTotal: decimalText(
      row.total_tokens_total,
      'usage_event.total_tokens',
    ),
    latencyMsTotal: decimalText(
      row.latency_ms_total,
      'usage_event.latency_ms',
    ),
    latencyMsMax: optionalDecimalText(
      row.latency_ms_max,
      'usage_event.latency_ms',
    ),
    erroredCount: countOf(row.errored_count, 'usage_event.error_code'),
  }
}

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

export interface CallAuditReportingRepository {
  /** One run's progress, or null when no such run exists. */
  getRunProgress(runId: string): Promise<CallAuditRunProgress | null>
  /** Runs whose calendar period starts inside the window, newest period first. */
  listRuns(query: CallAuditRunListQuery): Promise<CallAuditRunProgress[]>
  getPeriodSummary(query: CallAuditPeriodQuery): Promise<CallAuditPeriodSummary>
  /** All eight rubric metrics, in rubric order, zero-filled when unscored. */
  listMetricScoreAggregates(
    query: CallAuditPeriodQuery,
  ): Promise<CallAuditMetricScoreAggregate[]>
  listResults(
    query: CallAuditResultListQuery,
  ): Promise<CallAuditResultReportRow[]>
  listUsageAggregates(
    query: CallAuditPeriodQuery,
  ): Promise<CallAuditUsageAggregate[]>
}

export function createMysqlCallAuditReportingRepository(
  pool: Pool,
): CallAuditReportingRepository {
  return {
    async getRunProgress(runId) {
      const id = requireId(runId, 'runId')
      const [rows] = await pool.execute<RunProgressRow[]>(
        SELECT_RUN_BY_ID_SQL,
        [id],
      )
      const row = rows[0]
      return row ? mapRunProgress(row) : null
    },

    async listRuns(query) {
      if (!query || typeof query !== 'object') {
        throw new CallAuditReportingError('query', 'must be an object')
      }
      const period = validateReportPeriod(query.period)
      const runTypes = validateEnumFilter(query.runTypes, RUN_TYPES, 'runTypes')
      const statuses = validateEnumFilter(
        query.statuses,
        RUN_STATUSES,
        'statuses',
      )
      const limit = validateLimit(query.limit, MAX_RUN_PAGE_SIZE, 'limit')

      const filters = [
        '`run`.`period_start` >= ? AND `run`.`period_start` < ?',
      ]
      const parameters: SqlValue[] = [
        period.periodStart,
        period.periodEndExclusive,
      ]
      if (runTypes.length > 0) {
        filters.push(
          `\`run\`.\`run_type\` IN (${runTypes.map(() => '?').join(', ')})`,
        )
        parameters.push(...runTypes)
      }
      if (statuses.length > 0) {
        filters.push(
          `\`run\`.\`status\` IN (${statuses.map(() => '?').join(', ')})`,
        )
        parameters.push(...statuses)
      }
      parameters.push(limit)

      const [rows] = await pool.execute<RunProgressRow[]>(
        buildRunListSql(filters),
        parameters,
      )
      return rows.map(mapRunProgress)
    },

    /**
     * One totals read, one GROUP BY read per coded dimension, and one coded
     * issue-flag read. Statements run sequentially so a report never holds
     * several pooled connections at once for a single page.
     */
    async getPeriodSummary(query) {
      const scope = validatePeriodQuery(query)
      const scoped = buildScopedSql(RESULT_FROM, scope)

      const [totalsRows] = await pool.execute<RowDataPacket[]>(
        `${SELECT_SUMMARY_TOTALS}
   ${scoped.from}
   WHERE ${scoped.where}`,
        scoped.parameters,
      )
      const totals = totalsRows[0] ?? {}

      const tallies = {} as Record<
        SummaryDimension['key'],
        CallAuditTally<string>
      >
      for (const dimension of SUMMARY_DIMENSIONS) {
        const [rows] = await pool.execute<BucketRow[]>(
          buildDimensionSql(dimension, scoped),
          scoped.parameters,
        )
        tallies[dimension.key] = tallyBuckets(
          rows,
          dimension.vocabulary,
          dimension.column,
        )
      }

      const [flagRows] = await pool.execute<RowDataPacket[]>(
        buildIssueFlagSql(scoped),
        [...ISSUE_FLAGS.map(issueFlagNeedle), ...scoped.parameters],
      )
      const flagRow = flagRows[0] ?? {}
      const byIssueFlag = Object.fromEntries(
        ISSUE_FLAGS.map((flag) => [
          flag,
          countOf(flagRow[`flag_${flag}`], 'result.issue_flags_json'),
        ]),
      ) as Record<IssueFlag, number>

      return {
        period: scope.period,
        runTypes: scope.runTypes,
        runId: scope.runId,
        resultCount: countOf(totals.result_count, 'result.id'),
        auditedCallCount: countOf(
          totals.audited_call_count,
          'result.source_ref_id',
        ),
        byProcessingStatus: tallies.byProcessingStatus as CallAuditTally<ProcessingStatus>,
        byEligibility: tallies.byEligibility as CallAuditTally<CallAuditEligibility>,
        byIntent: tallies.byIntent as CallAuditTally<CallIntent>,
        byGroupedOutcome: tallies.byGroupedOutcome as CallAuditTally<OutcomeGroup>,
        byKserveComparison:
          tallies.byKserveComparison as CallAuditTally<KserveComparisonLabel>,
        byMismatchSeverity:
          tallies.byMismatchSeverity as CallAuditTally<MismatchSeverity>,
        byQualification: tallies.byQualification as CallAuditTally<Qualification>,
        byNextAction: tallies.byNextAction as CallAuditTally<NextActionCode>,
        byIssueFlag,
      }
    },

    /**
     * Returns exactly the eight rubric metrics, in rubric order, zero-filled
     * when a metric has no rows in scope — a report column that is missing
     * because nothing was scored still has to render. A stored metric_code
     * outside the locked rubric is not reportable and is skipped; surfacing one
     * would put an unapproved metric into a report.
     */
    async listMetricScoreAggregates(query) {
      const scope = validatePeriodQuery(query)
      const scoped = buildScopedSql(METRIC_FROM, scope)
      const [rows] = await pool.execute<MetricAggregateRow[]>(
        buildMetricAggregateSql(scoped),
        scoped.parameters,
      )
      const byCode = new Map<string, MetricAggregateRow>()
      for (const row of rows) {
        const code = textOrNull(row.metric_code)
        if (code !== null) {
          byCode.set(code, row)
        }
      }
      return CALL_AUDIT_METRIC_CODES.map((metricCode) => {
        const row = byCode.get(metricCode)
        return row
          ? mapMetricAggregate(row, metricCode)
          : emptyMetricAggregate(metricCode)
      })
    },

    async listResults(query) {
      const scope = validatePeriodQuery(query)
      const limit = validateLimit(query.limit, MAX_RESULT_PAGE_SIZE, 'limit')
      const cursor = validateResultCursor(query.cursor, scope.period)
      const scoped = buildScopedSql(RESULT_FROM, scope)
      const parameters: SqlValue[] = [...scoped.parameters]
      if (cursor) {
        parameters.push(
          cursor.effectiveCallAt,
          cursor.effectiveCallAt,
          cursor.resultId,
        )
      }
      parameters.push(limit)
      const [rows] = await pool.execute<ResultReportRowData[]>(
        buildResultListSql(scoped, cursor !== null),
        parameters,
      )
      return rows.map(mapResultRow)
    },

    async listUsageAggregates(query) {
      const scope = validatePeriodQuery(query)
      const scoped = buildScopedSql(USAGE_FROM, scope)
      const [rows] = await pool.execute<UsageAggregateRow[]>(
        buildUsageAggregateSql(scoped),
        scoped.parameters,
      )
      return rows.map(mapUsageAggregate)
    },
  }
}

/**
 * Exposed so tests can pin the read-only SQL contract without a database. Every
 * entry is a SELECT; the builders take only validated scope objects, never raw
 * caller text.
 */
export const CALL_AUDIT_REPORTING_SQL = {
  selectRunById: SELECT_RUN_BY_ID_SQL,
  summaryTotalsProjection: SELECT_SUMMARY_TOTALS,
  resultRowProjection: RESULT_ROW_PROJECTION,
  runProgressProjection: RUN_PROGRESS_PROJECTION,
  buildRunListSql,
  buildScopedSql,
  buildDimensionSql,
  buildIssueFlagSql,
  buildMetricAggregateSql,
  buildResultListSql,
  buildUsageAggregateSql,
  dimensions: SUMMARY_DIMENSIONS,
  tables: [
    RESULT_TABLE,
    SOURCE_REF_TABLE,
    RUN_TABLE,
    RULE_VERSION_TABLE,
    METRIC_SCORE_TABLE,
    USAGE_EVENT_TABLE,
  ] as const,
} as const
