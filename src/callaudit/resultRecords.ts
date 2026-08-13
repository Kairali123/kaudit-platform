import {
  canonicalJson,
  canonicalJsonSha256,
  type JsonValue,
} from '../messaging/canonicalJson.ts'
import { sha256Hex } from '../lib/hash.ts'
import type {
  IssueFlag,
  NextActionCode,
  Qualification,
  ValidatedContentAuditOutput,
} from './modelOutput.ts'
import {
  DETAILED_OUTCOME_GROUP,
  isDetailedOutcome,
  isNoContactOutcome,
  NO_CONTACT_OUTCOMES,
  type DetailedOutcome,
  type OutcomeGroup,
} from './outcomes.ts'
import { OVERALL_SCORE_METHOD } from './overallScore.ts'
import {
  CALL_AUDIT_RUBRIC,
  isCallAuditMetricCode,
  type CallAuditMetricCode,
} from './rubric.ts'
import {
  METRIC_SCORE_NOT_APPLICABLE,
  type CallAuditEligibility,
  type CallIntent,
} from './types.ts'

/**
 * Persistence-ready records for one Call Audit result and its AI usage
 * attempts, mapped column-for-column onto migration 0008.
 *
 * Everything here is PURE: no clock, no randomness, no database, no
 * environment, no locale-dependent formatting, and no mutation of inputs. The
 * same logical input always replays to the same ids, keys, canonical JSON, and
 * hashes, so a retried write is a no-op rather than a duplicate.
 *
 * Privacy: these records never carry a transcript, transcript excerpt, lead ID,
 * Task ID, phone, email, URL, source free text, prompt, raw model response,
 * refusal text, provider error payload, or any money value. The only free text
 * persisted is the three ALREADY-SANITIZED feedback strings, and even those are
 * bound into the canonical document by hash rather than copied into it.
 *
 * This module is independent of billing: no rate, quantity, amount, or cost.
 */

export class CallAuditRecordError extends Error {
  readonly code = 'INVALID_CALL_AUDIT_RECORD'
  readonly field: string

  constructor(field: string, reason: string) {
    // The reason names the rule, never the submitted value.
    super(`${field}: ${reason}`)
    this.field = field
  }
}

/** Identity of the canonical result document format. */
export const RESULT_DOCUMENT_VERSION = 'call-audit-result-document/1.0.0'

/** Column widths from migration 0008. */
export const MAX_ID_LENGTH = 40
export const MAX_IDEMPOTENCY_KEY_LENGTH = 191
export const MAX_ERROR_CODE_LENGTH = 80
export const MAX_REQUEST_ID_LENGTH = 120
export const MAX_PROVIDER_NAME_LENGTH = 80
export const MAX_MODEL_NAME_LENGTH = 100
export const MAX_MODEL_VERSION_LENGTH = 100
export const MAX_FEEDBACK_LENGTH = 2000

/** `intent_confidence` is decimal(9,8): exactly eight fractional digits. */
export const CONFIDENCE_DECIMALS = 8

/**
 * Ceiling for every signed BIGINT column in migration 0008 — input_tokens,
 * output_tokens, total_tokens, and latency_ms. A larger value would overflow
 * silently or be clamped by the server, so it is rejected here instead.
 */
export const MAX_SIGNED_BIGINT = '9223372036854775807'
const MAX_SIGNED_BIGINT_VALUE = 9223372036854775807n

/** Ceiling for `attempt_number`, which is a signed INT in migration 0008. */
export const MAX_ATTEMPT_NUMBER = 2147483647

/** Stable id prefixes, so a raw id is self-describing in a log or a join. */
const RESULT_ID_PREFIX = 'car_'
const METRIC_ID_PREFIX = 'cam_'
const USAGE_ID_PREFIX = 'cau_'
/** prefix (4) + truncated hash (36) = the varchar(40) column exactly. */
const ID_HASH_LENGTH = MAX_ID_LENGTH - RESULT_ID_PREFIX.length

const IDEMPOTENCY_PREFIX = 'call-audit-result:'

const CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/
/** Conservative machine code grammar: uppercase, digits, underscore only. */
const SAFE_ERROR_CODE = /^[A-Z][A-Z0-9_]*$/
/** Canonical non-negative decimal: no sign, no exponent, no leading zeros. */
const CANONICAL_UNSIGNED = /^(0|[1-9][0-9]*)$/
/** UTC-naive datetime literal, matching the datetime(6) columns. */
const NAIVE_DATETIME =
  /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?$/

export type ProcessingStatus = 'pending' | 'succeeded' | 'failed' | 'skipped'
export type KserveComparisonLabel = 'match' | 'mismatch' | 'not_comparable'
export type MismatchSeverity = 'none' | 'low' | 'medium' | 'high'
export type UsageAttemptOutcome = 'succeeded' | 'refused' | 'failed'

/** The tuple that identifies one result. Also the composite FK provenance. */
export interface CallAuditResultIdentity {
  runId: string
  sourceRefId: string
  ruleVersionId: string
}

/** One row of `kaudit_call_audit_result`. DB-defaulted timestamps are absent. */
export interface CallAuditResultRecord {
  /** result.id */
  id: string
  /** result.run_id */
  runId: string
  /** result.source_ref_id */
  sourceRefId: string
  /** result.rule_version_id */
  ruleVersionId: string
  /** result.processing_status */
  processingStatus: ProcessingStatus
  /** result.eligibility */
  eligibility: CallAuditEligibility
  /** result.ineligibility_reason */
  ineligibilityReason: 'missing_transcript' | null
  /** result.call_connected */
  callConnected: boolean | null
  /** result.customer_spoke */
  customerSpoke: boolean | null
  /** result.meaningful_conversation */
  meaningfulConversation: boolean | null
  /** result.intent */
  intent: CallIntent | null
  /** result.intent_confidence, decimal(9,8) as an exact string */
  intentConfidence: string | null
  /** result.detailed_outcome */
  detailedOutcome: DetailedOutcome | null
  /** result.grouped_outcome, application-derived */
  groupedOutcome: OutcomeGroup | null
  /** result.qualification_label */
  qualificationLabel: Qualification | null
  /** result.next_action_code */
  nextActionCode: NextActionCode | null
  /** result.overall_score, decimal(6,3) as an exact string */
  overallScore: string | null
  /** result.overall_score_method */
  overallScoreMethod: string | null
  /** result.kserve_reported_outcome */
  kserveReportedOutcome: DetailedOutcome | null
  /** result.kserve_comparison_label */
  kserveComparisonLabel: KserveComparisonLabel
  /** result.mismatch_severity */
  mismatchSeverity: MismatchSeverity
  /** result.management_feedback, already sanitized upstream */
  managementFeedback: string | null
  /** result.kserve_feedback, already sanitized upstream */
  kserveFeedback: string | null
  /** result.improvement_feedback, already sanitized upstream */
  improvementFeedback: string | null
  /** result.issue_flags_json, canonical JSON of approved codes only */
  issueFlagsJson: string | null
  /** result.result_json, canonical coded document */
  resultJson: string | null
  /** result.result_sha256 */
  resultSha256: string | null
  /** result.error_code, safe machine code only */
  errorCode: string | null
  /** result.error_detail. Always null: no provider prose is ever persisted. */
  errorDetail: null
  /** result.idempotency_key */
  idempotencyKey: string
  /**
   * result.audited_at. NULL for a failed result: no audit completed, so
   * there is no audit time. The attempt time lives on the usage event, and
   * the database created_at records when the row appeared.
   */
  auditedAt: string | null
}

/** One row of `kaudit_call_audit_metric_score`. */
export interface CallAuditMetricScoreRecord {
  /** metric_score.id */
  id: string
  /** metric_score.result_id */
  resultId: string
  /** metric_score.metric_code */
  metricCode: CallAuditMetricCode
  /** metric_score.score_value; NULL only when NA. Never 0. */
  scoreValue: number | null
  /** metric_score.is_not_applicable */
  isNotApplicable: boolean
}

export interface CallAuditResultBundle {
  result: CallAuditResultRecord
  metricScores: readonly CallAuditMetricScoreRecord[]
}

/** One row of `kaudit_call_audit_usage_event`. */
export interface CallAuditUsageEventRecord {
  /** usage_event.id */
  id: string
  /** usage_event.result_id */
  resultId: string
  /** usage_event.run_id */
  runId: string
  /** usage_event.rule_version_id */
  ruleVersionId: string
  /** usage_event.attempt_number */
  attemptNumber: number
  /** usage_event.attempt_outcome */
  attemptOutcome: UsageAttemptOutcome
  /** usage_event.provider_name */
  providerName: string
  /** usage_event.model_name */
  modelName: string
  /** usage_event.model_version */
  modelVersion: string
  /** usage_event.input_tokens, canonical decimal string to keep BIGINT exact */
  inputTokens: string | null
  /** usage_event.output_tokens */
  outputTokens: string | null
  /** usage_event.total_tokens, provider-reported and NEVER recomputed */
  totalTokens: string | null
  /** usage_event.request_id */
  requestId: string | null
  /** usage_event.latency_ms */
  latencyMs: string | null
  /** usage_event.error_code, safe machine code only */
  errorCode: string | null
  /** usage_event.recorded_at */
  recordedAt: string
}

// ---------------------------------------------------------------------------
// Validation primitives
// ---------------------------------------------------------------------------

function requireIdentifier(
  value: unknown,
  field: string,
  maxLength: number,
): string {
  if (typeof value !== 'string') {
    throw new CallAuditRecordError(field, 'must be a string')
  }
  const text = value.trim()
  if (!text) {
    throw new CallAuditRecordError(field, 'must not be blank')
  }
  if (text.length > maxLength) {
    throw new CallAuditRecordError(
      field,
      `must be at most ${maxLength} characters`,
    )
  }
  if (CONTROL_CHARACTER.test(text)) {
    throw new CallAuditRecordError(field, 'must not contain control characters')
  }
  return text
}

function requireIdentity(value: unknown): CallAuditResultIdentity {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new CallAuditRecordError('identity', 'must be an object')
  }
  const record = value as Record<string, unknown>
  return {
    runId: requireIdentifier(record.runId, 'identity.runId', MAX_ID_LENGTH),
    sourceRefId: requireIdentifier(
      record.sourceRefId,
      'identity.sourceRefId',
      MAX_ID_LENGTH,
    ),
    ruleVersionId: requireIdentifier(
      record.ruleVersionId,
      'identity.ruleVersionId',
      MAX_ID_LENGTH,
    ),
  }
}

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeapYear(year) ? 29 : 28
  return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31
}

/**
 * Validates a supplied UTC-naive timestamp and passes it through unchanged.
 * Timestamps are NEVER generated here — a pure builder that read a clock would
 * not replay. Components are checked explicitly rather than by Date parsing,
 * which silently rolls impossible dates forward.
 */
function requireTimestamp(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new CallAuditRecordError(field, 'must be a string')
  }
  const match = NAIVE_DATETIME.exec(value.trim())
  if (!match) {
    throw new CallAuditRecordError(
      field,
      "must be a UTC-naive 'YYYY-MM-DD HH:MM:SS' timestamp",
    )
  }
  const [, yearText, monthText, dayText, hourText, minuteText, secondText] =
    match
  const fraction = match[7] ?? ''
  const year = Number(yearText)
  const month = Number(monthText)
  const day = Number(dayText)
  if (year < 1 || month < 1 || month > 12) {
    throw new CallAuditRecordError(field, 'has an invalid year or month')
  }
  if (day < 1 || day > daysInMonth(year, month)) {
    throw new CallAuditRecordError(field, 'has an invalid day for that month')
  }
  if (Number(hourText) > 23) {
    throw new CallAuditRecordError(field, 'has an invalid hour')
  }
  if (Number(minuteText) > 59) {
    throw new CallAuditRecordError(field, 'has an invalid minute')
  }
  if (Number(secondText) > 59) {
    throw new CallAuditRecordError(field, 'has an invalid second')
  }
  return (
    `${yearText}-${monthText}-${dayText} ` +
    `${hourText}:${minuteText}:${secondText}` +
    (fraction ? `.${fraction}` : '')
  )
}

/**
 * The exact supplied-timestamp rule the record builders apply, exposed so a
 * caller can reject an invalid timestamp BEFORE it writes anything.
 *
 * It delegates to the same private function the builders use rather than
 * restating the grammar: a second copy could drift from the datetime(6)
 * columns, and then a value would pass the pre-write check and fail the write.
 * Returns the canonical form; throws {@link CallAuditRecordError} otherwise.
 */
export function validateCallAuditTimestamp(
  value: unknown,
  field: string,
): string {
  return requireTimestamp(value, field)
}

/**
 * Normalizes a provider-reported count into a canonical non-negative decimal
 * STRING. The columns are BIGINT, which a JavaScript number cannot hold
 * exactly, so an unsafe number is rejected rather than silently rounded.
 */
function requireWithinBigint(text: string, field: string): string {
  if (BigInt(text) > MAX_SIGNED_BIGINT_VALUE) {
    throw new CallAuditRecordError(
      field,
      `must be at most ${MAX_SIGNED_BIGINT}, the signed BIGINT maximum`,
    )
  }
  return text
}

function normalizeUnsignedCount(
  value: unknown,
  field: string,
): string | null {
  if (value === null || value === undefined) {
    return null
  }
  if (typeof value === 'bigint') {
    if (value < 0n) {
      throw new CallAuditRecordError(field, 'must not be negative')
    }
    return requireWithinBigint(value.toString(), field)
  }
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) {
      throw new CallAuditRecordError(
        field,
        'must be a safe integer; use a decimal string for larger counts',
      )
    }
    if (value < 0) {
      throw new CallAuditRecordError(field, 'must not be negative')
    }
    // A safe integer is always below the BIGINT ceiling, but the check is kept
    // uniform so no representation can bypass it.
    return requireWithinBigint(String(value), field)
  }
  if (typeof value !== 'string') {
    throw new CallAuditRecordError(
      field,
      'must be a canonical decimal string, a safe integer, or null',
    )
  }
  const text = value.trim()
  if (!CANONICAL_UNSIGNED.test(text)) {
    throw new CallAuditRecordError(
      field,
      'must be a canonical non-negative decimal without sign, exponent, or leading zeros',
    )
  }
  return requireWithinBigint(text, field)
}

/**
 * Validates an attempt ordinal against the signed INT column. Shared by the
 * record builder and the public id helper so neither can accept a value the
 * other would reject.
 */
function requireAttemptNumber(value: unknown): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > MAX_ATTEMPT_NUMBER
  ) {
    throw new CallAuditRecordError(
      'attemptNumber',
      `must be an integer between 1 and ${MAX_ATTEMPT_NUMBER}`,
    )
  }
  return value
}

/** Safe machine code only. Arbitrary prose is rejected, never truncated. */
function requireSafeErrorCode(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new CallAuditRecordError(field, 'must be a string')
  }
  const text = value.trim()
  if (!text) {
    throw new CallAuditRecordError(field, 'must not be blank')
  }
  if (text.length > MAX_ERROR_CODE_LENGTH) {
    throw new CallAuditRecordError(
      field,
      `must be at most ${MAX_ERROR_CODE_LENGTH} characters`,
    )
  }
  if (!SAFE_ERROR_CODE.test(text)) {
    throw new CallAuditRecordError(
      field,
      'must be an uppercase machine code of letters, digits, and underscores',
    )
  }
  return text
}

function requireSanitizedFeedback(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new CallAuditRecordError(field, 'must be a string')
  }
  if (value.length > MAX_FEEDBACK_LENGTH) {
    throw new CallAuditRecordError(
      field,
      `must be at most ${MAX_FEEDBACK_LENGTH} characters`,
    )
  }
  return value
}

/**
 * Normalizes a validated confidence into the exact decimal(9,8) string.
 *
 * The rule is `Number.prototype.toFixed(8)`: ECMAScript-specified, locale
 * independent, and for the non-negative [0, 1] range it rounds half away from
 * zero — i.e. half-up. Confidence is a model self-report, not money, so a
 * single documented rounding at the persistence boundary is correct; the value
 * is never used in arithmetic afterwards.
 */
export function normalizeConfidence(value: unknown): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new CallAuditRecordError('confidence', 'must be a finite number')
  }
  if (value < 0 || value > 1) {
    throw new CallAuditRecordError('confidence', 'must be between 0 and 1')
  }
  const text = value.toFixed(CONFIDENCE_DECIMALS)
  if (!/^[01]\.\d{8}$/.test(text)) {
    throw new CallAuditRecordError(
      'confidence',
      'did not normalize to a decimal(9,8) value',
    )
  }
  return text
}

// ---------------------------------------------------------------------------
// Deterministic identity
// ---------------------------------------------------------------------------

function identityDocument(identity: CallAuditResultIdentity): JsonValue {
  return {
    runId: identity.runId,
    sourceRefId: identity.sourceRefId,
    ruleVersionId: identity.ruleVersionId,
  }
}

function derivedId(prefix: string, document: JsonValue): string {
  // A full SHA-256 is 64 hex characters and the column is varchar(40), so the
  // hash is truncated to 36 characters (144 bits) after the 4-character prefix.
  return `${prefix}${canonicalJsonSha256(document).slice(0, ID_HASH_LENGTH)}`
}

// The private variants take an ALREADY-VALIDATED identity, so the builders do
// not re-validate the same tuple once per derived id. Every exported helper
// below validates first, so a direct caller gets the same guarantees.

function idempotencyKeyFor(identity: CallAuditResultIdentity): string {
  const key = `${IDEMPOTENCY_PREFIX}${canonicalJsonSha256(identityDocument(identity))}`
  if (key.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
    throw new CallAuditRecordError('idempotencyKey', 'exceeds the column width')
  }
  return key
}

function resultIdFor(identity: CallAuditResultIdentity): string {
  return derivedId(RESULT_ID_PREFIX, identityDocument(identity))
}

function metricScoreIdFor(
  identity: CallAuditResultIdentity,
  metricCode: CallAuditMetricCode,
): string {
  return derivedId(METRIC_ID_PREFIX, {
    ...(identityDocument(identity) as Record<string, JsonValue>),
    metricCode,
  })
}

function usageEventIdFor(
  identity: CallAuditResultIdentity,
  attemptNumber: number,
): string {
  return derivedId(USAGE_ID_PREFIX, {
    ...(identityDocument(identity) as Record<string, JsonValue>),
    attemptNumber,
  })
}

/**
 * The stable idempotency key for a result, derived from its exact
 * (runId, sourceRefId, ruleVersionId) tuple. Well within varchar(191).
 */
export function buildResultIdempotencyKey(
  identity: CallAuditResultIdentity,
): string {
  return idempotencyKeyFor(requireIdentity(identity))
}

export function buildResultId(identity: CallAuditResultIdentity): string {
  return resultIdFor(requireIdentity(identity))
}

export function buildMetricScoreId(
  identity: CallAuditResultIdentity,
  metricCode: CallAuditMetricCode,
): string {
  // A TypeScript cast is not a runtime guarantee, so the code is checked
  // against the approved rubric rather than trusted.
  if (!isCallAuditMetricCode(metricCode)) {
    throw new CallAuditRecordError('metricCode', 'is not an approved metric')
  }
  return metricScoreIdFor(requireIdentity(identity), metricCode)
}

export function buildUsageEventId(
  identity: CallAuditResultIdentity,
  attemptNumber: number,
): string {
  return usageEventIdFor(
    requireIdentity(identity),
    requireAttemptNumber(attemptNumber),
  )
}

// ---------------------------------------------------------------------------
// KServe outcome comparison
// ---------------------------------------------------------------------------

export interface KserveComparison {
  kserveReportedOutcome: DetailedOutcome | null
  kserveComparisonLabel: KserveComparisonLabel
  mismatchSeverity: MismatchSeverity
}

/** Re-exported so callers get the compliance set from one place. */
export { NO_CONTACT_OUTCOMES }

/**
 * Compares the audited detailed outcome against an UNTRUSTED KServe-reported
 * candidate.
 *
 * The candidate is persisted only when it is already an EXACT member of the
 * approved taxonomy. There is deliberately no trimming, case folding, aliasing,
 * or fuzzy matching: a near-miss is a different label, and quietly repairing it
 * would fabricate agreement between two systems.
 */
export function compareKserveOutcome(
  auditedOutcome: DetailedOutcome | null,
  candidate: unknown,
): KserveComparison {
  if (!isDetailedOutcome(candidate)) {
    // Absent or unapproved source text is discarded, never stored.
    return {
      kserveReportedOutcome: null,
      kserveComparisonLabel: 'not_comparable',
      mismatchSeverity: 'none',
    }
  }
  const reported: DetailedOutcome = candidate
  if (auditedOutcome === null) {
    // Operational-only and failed results audited no outcome, so there is
    // nothing to compare the approved label against.
    return {
      kserveReportedOutcome: reported,
      kserveComparisonLabel: 'not_comparable',
      mismatchSeverity: 'none',
    }
  }
  if (auditedOutcome === reported) {
    return {
      kserveReportedOutcome: reported,
      kserveComparisonLabel: 'match',
      mismatchSeverity: 'none',
    }
  }
  // A no-contact disagreement is a compliance risk regardless of grouping, so
  // this rule takes precedence over the group comparison below. The set lives
  // in outcomes.ts beside the taxonomy, not as loose strings here.
  if (isNoContactOutcome(auditedOutcome) || isNoContactOutcome(reported)) {
    return {
      kserveReportedOutcome: reported,
      kserveComparisonLabel: 'mismatch',
      mismatchSeverity: 'high',
    }
  }
  const sameGroup =
    DETAILED_OUTCOME_GROUP[auditedOutcome] === DETAILED_OUTCOME_GROUP[reported]
  return {
    kserveReportedOutcome: reported,
    kserveComparisonLabel: 'mismatch',
    mismatchSeverity: sameGroup ? 'low' : 'medium',
  }
}

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

function metricRecords(
  resultId: string,
  identity: CallAuditResultIdentity,
  output: ValidatedContentAuditOutput,
): CallAuditMetricScoreRecord[] {
  const byCode = new Map(
    output.metricScores.map((entry) => [entry.metric, entry.score]),
  )
  // Driven by CALL_AUDIT_RUBRIC, so the persisted order is canonical whatever
  // order the caller supplied.
  return CALL_AUDIT_RUBRIC.map((metric) => {
    const score = byCode.get(metric.code)
    if (score === undefined) {
      throw new CallAuditRecordError(
        'metricScores',
        `is missing a score for metric ${metric.code}`,
      )
    }
    const notApplicable = score === METRIC_SCORE_NOT_APPLICABLE
    return {
      id: metricScoreIdFor(identity, metric.code),
      resultId,
      metricCode: metric.code,
      // NA is a distinct state: it stores NULL and the flag, never 0.
      scoreValue: notApplicable ? null : (score as number),
      isNotApplicable: notApplicable,
    }
  })
}

function canonicalMetricSet(
  metricScores: readonly CallAuditMetricScoreRecord[],
): JsonValue {
  return metricScores.map((entry) => ({
    metric: entry.metricCode,
    score: entry.isNotApplicable
      ? METRIC_SCORE_NOT_APPLICABLE
      : (entry.scoreValue as number),
  }))
}

export interface ContentAuditResultInput {
  identity: CallAuditResultIdentity
  /** The ONLY model-derived object accepted here. No transcript, ever. */
  output: ValidatedContentAuditOutput
  /** Untrusted KServe-reported label; kept only when exactly approved. */
  kserveReportedOutcome?: unknown
  auditedAt: string
}

/**
 * Builds a succeeded, content-auditable result and its eight metric rows.
 */
export function buildContentAuditResult(
  input: ContentAuditResultInput,
): CallAuditResultBundle {
  const identity = requireIdentity(input.identity)
  const auditedAt = requireTimestamp(input.auditedAt, 'auditedAt')
  const output = input.output
  if (!output || typeof output !== 'object') {
    throw new CallAuditRecordError('output', 'must be a validated audit output')
  }

  const resultId = resultIdFor(identity)
  const metricScores = metricRecords(resultId, identity, output)
  const intentConfidence = normalizeConfidence(output.confidence)
  const comparison = compareKserveOutcome(
    output.detailedOutcome,
    input.kserveReportedOutcome,
  )

  // An all-NA call has no score, and migration 0008 requires the method to be
  // absent whenever the score is.
  const overallScore = output.overallScore
  const overallScoreMethod = overallScore === null ? null : OVERALL_SCORE_METHOD

  const managementFeedback = requireSanitizedFeedback(
    output.managementSummary,
    'managementSummary',
  )
  const kserveFeedback = requireSanitizedFeedback(
    output.kserveFeedback,
    'kserveFeedback',
  )
  const improvementFeedback = requireSanitizedFeedback(
    output.improvementFeedback,
    'improvementFeedback',
  )

  // Sorted so an equivalent flag set always canonicalizes identically.
  const issueFlags = [...output.issueFlags].sort() as IssueFlag[]

  const document: JsonValue = {
    documentVersion: RESULT_DOCUMENT_VERSION,
    runId: identity.runId,
    sourceRefId: identity.sourceRefId,
    ruleVersionId: identity.ruleVersionId,
    processingStatus: 'succeeded',
    eligibility: 'content_auditable',
    ineligibilityReason: null,
    callConnected: output.callConnected,
    customerSpoke: output.customerSpoke,
    meaningfulConversation: output.meaningfulConversation,
    intent: output.intent,
    intentConfidence,
    detailedOutcome: output.detailedOutcome,
    groupedOutcome: output.groupedOutcome,
    qualification: output.qualification,
    nextAction: output.nextAction,
    overallScore,
    overallScoreMethod,
    // The metric set is bound into the hash so the deterministic score inputs
    // are covered, not just the score itself.
    metricScores: canonicalMetricSet(metricScores),
    issueFlags,
    kserveReportedOutcome: comparison.kserveReportedOutcome,
    kserveComparisonLabel: comparison.kserveComparisonLabel,
    mismatchSeverity: comparison.mismatchSeverity,
    // Feedback prose is BOUND BY HASH, never duplicated into the document.
    managementFeedbackSha256: sha256Hex(managementFeedback),
    kserveFeedbackSha256: sha256Hex(kserveFeedback),
    improvementFeedbackSha256: sha256Hex(improvementFeedback),
  }

  return {
    result: {
      id: resultId,
      runId: identity.runId,
      sourceRefId: identity.sourceRefId,
      ruleVersionId: identity.ruleVersionId,
      processingStatus: 'succeeded',
      eligibility: 'content_auditable',
      ineligibilityReason: null,
      callConnected: output.callConnected,
      customerSpoke: output.customerSpoke,
      meaningfulConversation: output.meaningfulConversation,
      intent: output.intent,
      intentConfidence,
      detailedOutcome: output.detailedOutcome,
      groupedOutcome: output.groupedOutcome,
      qualificationLabel: output.qualification,
      nextActionCode: output.nextAction,
      overallScore,
      overallScoreMethod,
      kserveReportedOutcome: comparison.kserveReportedOutcome,
      kserveComparisonLabel: comparison.kserveComparisonLabel,
      mismatchSeverity: comparison.mismatchSeverity,
      managementFeedback,
      kserveFeedback,
      improvementFeedback,
      issueFlagsJson: canonicalJson(issueFlags),
      resultJson: canonicalJson(document),
      resultSha256: canonicalJsonSha256(document),
      errorCode: null,
      errorDetail: null,
      idempotencyKey: idempotencyKeyFor(identity),
      auditedAt,
    },
    metricScores,
  }
}

export interface OperationalOnlyResultInput {
  identity: CallAuditResultIdentity
  kserveReportedOutcome?: unknown
  auditedAt: string
}

/**
 * Builds a succeeded, operational-only result for a call with no transcript.
 *
 * No audit fact is invented: the call-state booleans, intent, outcomes,
 * qualification, next action, feedback, and score are all absent, and there are
 * no metric rows at all.
 */
export function buildOperationalOnlyResult(
  input: OperationalOnlyResultInput,
): CallAuditResultBundle {
  const identity = requireIdentity(input.identity)
  const auditedAt = requireTimestamp(input.auditedAt, 'auditedAt')
  // Operational-only audited no outcome, so comparison is always
  // not_comparable; an exactly approved label may still be kept as a safe
  // categorical value, and anything else is discarded.
  const comparison = compareKserveOutcome(null, input.kserveReportedOutcome)

  const document: JsonValue = {
    documentVersion: RESULT_DOCUMENT_VERSION,
    runId: identity.runId,
    sourceRefId: identity.sourceRefId,
    ruleVersionId: identity.ruleVersionId,
    processingStatus: 'succeeded',
    eligibility: 'operational_only',
    ineligibilityReason: 'missing_transcript',
    kserveReportedOutcome: comparison.kserveReportedOutcome,
    kserveComparisonLabel: comparison.kserveComparisonLabel,
    mismatchSeverity: comparison.mismatchSeverity,
  }

  return {
    result: {
      id: resultIdFor(identity),
      runId: identity.runId,
      sourceRefId: identity.sourceRefId,
      ruleVersionId: identity.ruleVersionId,
      processingStatus: 'succeeded',
      eligibility: 'operational_only',
      ineligibilityReason: 'missing_transcript',
      callConnected: null,
      customerSpoke: null,
      meaningfulConversation: null,
      intent: null,
      intentConfidence: null,
      detailedOutcome: null,
      groupedOutcome: null,
      qualificationLabel: null,
      nextActionCode: null,
      overallScore: null,
      overallScoreMethod: null,
      kserveReportedOutcome: comparison.kserveReportedOutcome,
      kserveComparisonLabel: comparison.kserveComparisonLabel,
      mismatchSeverity: comparison.mismatchSeverity,
      managementFeedback: null,
      kserveFeedback: null,
      improvementFeedback: null,
      issueFlagsJson: null,
      resultJson: canonicalJson(document),
      resultSha256: canonicalJsonSha256(document),
      errorCode: null,
      errorDetail: null,
      idempotencyKey: idempotencyKeyFor(identity),
      auditedAt,
    },
    metricScores: [],
  }
}

export interface FailedResultInput {
  identity: CallAuditResultIdentity
  /** Eligibility determined before the attempt failed. */
  eligibility: CallAuditEligibility
  /** Safe machine code only. Provider prose is rejected, never stored. */
  errorCode: string
  kserveReportedOutcome?: unknown
}

/**
 * Builds a failed result. It carries a bounded machine error code and nothing
 * else: no canonical document, no hash, and no error detail, because a provider
 * message could echo transcript content back into the audit record.
 *
 * There is no auditedAt: a failed attempt completed no audit, so claiming an
 * audit time would be a fact the run never established. The attempt time is
 * recorded on the usage event, and the database created_at records the row.
 */
export function buildFailedResult(
  input: FailedResultInput,
): CallAuditResultBundle {
  const identity = requireIdentity(input.identity)
  if (
    input.eligibility !== 'content_auditable' &&
    input.eligibility !== 'operational_only'
  ) {
    throw new CallAuditRecordError('eligibility', 'is not an approved value')
  }
  const errorCode = requireSafeErrorCode(input.errorCode, 'errorCode')
  const comparison = compareKserveOutcome(null, input.kserveReportedOutcome)

  return {
    result: {
      id: resultIdFor(identity),
      runId: identity.runId,
      sourceRefId: identity.sourceRefId,
      ruleVersionId: identity.ruleVersionId,
      processingStatus: 'failed',
      eligibility: input.eligibility,
      // Keeps the eligibility/reason pair consistent without inventing an
      // audit fact: operational_only always means a missing transcript.
      ineligibilityReason:
        input.eligibility === 'operational_only' ? 'missing_transcript' : null,
      callConnected: null,
      customerSpoke: null,
      meaningfulConversation: null,
      intent: null,
      intentConfidence: null,
      detailedOutcome: null,
      groupedOutcome: null,
      qualificationLabel: null,
      nextActionCode: null,
      overallScore: null,
      overallScoreMethod: null,
      kserveReportedOutcome: comparison.kserveReportedOutcome,
      kserveComparisonLabel: comparison.kserveComparisonLabel,
      mismatchSeverity: comparison.mismatchSeverity,
      managementFeedback: null,
      kserveFeedback: null,
      improvementFeedback: null,
      issueFlagsJson: null,
      // A failed attempt produced no result document to hash.
      resultJson: null,
      resultSha256: null,
      errorCode,
      errorDetail: null,
      idempotencyKey: idempotencyKeyFor(identity),
      auditedAt: null,
    },
    metricScores: [],
  }
}

export interface SkippedResultInput {
  identity: CallAuditResultIdentity
  /** Eligibility determined from the source revision, before the skip. */
  eligibility: CallAuditEligibility
  /** Safe machine code naming WHY nothing was attempted. */
  skipCode: string
  kserveReportedOutcome?: unknown
}

/**
 * Builds a SKIPPED result: the run reached this call, decided not to attempt
 * anything for it, and says so.
 *
 * Distinct from every other builder on purpose. It is not `succeeded`, because
 * no audit happened; it is not `failed`, because nothing was attempted and
 * nothing went wrong; and it is not operational-only, because the transcript
 * may well have been auditable — the run simply had no business paying to audit
 * it again. Counting a skip as any of those would misreport either coverage or
 * reliability.
 *
 * Like a failed result it carries no document, no hash, no metric rows, and no
 * `auditedAt`: an audit time would assert an audit this run never performed.
 * The bounded `skipCode` is stored in `error_code`, which is the row's only
 * machine-readable slot for "why is this row not an audit" — it names a
 * decision, not a fault, and like every code persisted here it is a closed
 * token rather than prose.
 *
 * `ineligibilityReason` follows the same pairing rule the schema enforces:
 * `missing_transcript` only ever accompanies `operational_only`, so a skipped
 * content-auditable call leaves it NULL rather than inventing a reason the
 * column is not allowed to hold.
 */
export function buildSkippedResult(
  input: SkippedResultInput,
): CallAuditResultBundle {
  const identity = requireIdentity(input.identity)
  if (
    input.eligibility !== 'content_auditable' &&
    input.eligibility !== 'operational_only'
  ) {
    throw new CallAuditRecordError('eligibility', 'is not an approved value')
  }
  const skipCode = requireSafeErrorCode(input.skipCode, 'skipCode')
  const comparison = compareKserveOutcome(null, input.kserveReportedOutcome)

  return {
    result: {
      id: resultIdFor(identity),
      runId: identity.runId,
      sourceRefId: identity.sourceRefId,
      ruleVersionId: identity.ruleVersionId,
      processingStatus: 'skipped',
      eligibility: input.eligibility,
      ineligibilityReason:
        input.eligibility === 'operational_only' ? 'missing_transcript' : null,
      callConnected: null,
      customerSpoke: null,
      meaningfulConversation: null,
      intent: null,
      intentConfidence: null,
      detailedOutcome: null,
      groupedOutcome: null,
      qualificationLabel: null,
      nextActionCode: null,
      overallScore: null,
      overallScoreMethod: null,
      kserveReportedOutcome: comparison.kserveReportedOutcome,
      kserveComparisonLabel: comparison.kserveComparisonLabel,
      mismatchSeverity: comparison.mismatchSeverity,
      managementFeedback: null,
      kserveFeedback: null,
      improvementFeedback: null,
      issueFlagsJson: null,
      // Nothing was attempted, so there is no result document to hash.
      resultJson: null,
      resultSha256: null,
      errorCode: skipCode,
      errorDetail: null,
      idempotencyKey: idempotencyKeyFor(identity),
      auditedAt: null,
    },
    metricScores: [],
  }
}

export interface UsageEventInput {
  identity: CallAuditResultIdentity
  attemptNumber: number
  attemptOutcome: UsageAttemptOutcome
  providerName: string
  modelName: string
  modelVersion: string
  /** Provider-reported counts. Decimal string, safe integer, bigint, or null. */
  inputTokens?: string | number | bigint | null
  outputTokens?: string | number | bigint | null
  totalTokens?: string | number | bigint | null
  requestId?: string | null
  latencyMs?: string | number | bigint | null
  /** Required for refused and failed; must be absent for succeeded. */
  errorCode?: string | null
  recordedAt: string
}

/**
 * Builds one append-only usage-attempt record.
 *
 * Every attempt is recorded, including retries, refusals, and failures, so cost
 * and reliability reporting cannot silently count only successes. Token totals
 * are provider-reported and are never recomputed from the parts: a derived
 * total would misstate spend whenever the provider counts differently.
 */
export function buildUsageEventRecord(
  input: UsageEventInput,
): CallAuditUsageEventRecord {
  const identity = requireIdentity(input.identity)
  const recordedAt = requireTimestamp(input.recordedAt, 'recordedAt')

  const attemptNumber = requireAttemptNumber(input.attemptNumber)
  const outcome = input.attemptOutcome
  if (
    outcome !== 'succeeded' &&
    outcome !== 'refused' &&
    outcome !== 'failed'
  ) {
    throw new CallAuditRecordError('attemptOutcome', 'is not an approved value')
  }

  const providerName = requireIdentifier(
    input.providerName,
    'providerName',
    MAX_PROVIDER_NAME_LENGTH,
  )
  const modelName = requireIdentifier(
    input.modelName,
    'modelName',
    MAX_MODEL_NAME_LENGTH,
  )
  const modelVersion = requireIdentifier(
    input.modelVersion,
    'modelVersion',
    MAX_MODEL_VERSION_LENGTH,
  )

  const requestId =
    input.requestId === null || input.requestId === undefined
      ? null
      : requireIdentifier(input.requestId, 'requestId', MAX_REQUEST_ID_LENGTH)

  // A success with an error code, or a refusal/failure without one, would make
  // the ledger self-contradictory.
  let errorCode: string | null = null
  if (outcome === 'succeeded') {
    if (input.errorCode !== null && input.errorCode !== undefined) {
      throw new CallAuditRecordError(
        'errorCode',
        'must be absent when the attempt succeeded',
      )
    }
  } else {
    if (input.errorCode === null || input.errorCode === undefined) {
      throw new CallAuditRecordError(
        'errorCode',
        `is required when the attempt is ${outcome}`,
      )
    }
    errorCode = requireSafeErrorCode(input.errorCode, 'errorCode')
  }

  return {
    id: usageEventIdFor(identity, attemptNumber),
    resultId: resultIdFor(identity),
    runId: identity.runId,
    ruleVersionId: identity.ruleVersionId,
    attemptNumber,
    attemptOutcome: outcome,
    providerName,
    modelName,
    modelVersion,
    inputTokens: normalizeUnsignedCount(input.inputTokens, 'inputTokens'),
    outputTokens: normalizeUnsignedCount(input.outputTokens, 'outputTokens'),
    totalTokens: normalizeUnsignedCount(input.totalTokens, 'totalTokens'),
    requestId,
    latencyMs: normalizeUnsignedCount(input.latencyMs, 'latencyMs'),
    errorCode,
    recordedAt,
  }
}
