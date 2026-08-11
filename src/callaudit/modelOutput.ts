import { isCallIntent } from './intent.ts'
import {
  calculateOverallScore,
  CallAuditScoringError,
  normalizeMetricScoreSet,
} from './overallScore.ts'
import {
  groupForDetailedOutcome,
  isDetailedOutcome,
  type DetailedOutcome,
  type OutcomeGroup,
} from './outcomes.ts'
import {
  CALL_AUDIT_RUBRIC,
  type CallAuditMetricCode,
  type CallAuditMetricScore,
} from './rubric.ts'
import {
  METRIC_SCORE_NOT_APPLICABLE,
  type CallAuditEligibility,
  type CallIntent,
  type MetricScore,
} from './types.ts'

/**
 * Strict runtime validation of an UNTRUSTED content-audit model value.
 *
 * Everything here is framework-free and deterministic. Two fields are never
 * accepted from the model and are always derived afterwards in application
 * code: the grouped outcome (which must follow from the detailed outcome) and
 * the overall score (which is arithmetic, not judgement).
 */

/**
 * Typed, safe validation failure. The message names the offending FIELD and the
 * rule it broke — never the value, so an untrusted transcript, summary, or the
 * raw model payload can never reach a log, an error response, or a stack trace.
 */
export class CallAuditOutputError extends Error {
  readonly code = 'INVALID_CALL_AUDIT_OUTPUT'
  readonly field: string

  constructor(field: string, reason: string) {
    super(`${field}: ${reason}`)
    this.field = field
  }
}

export const QUALIFICATIONS = [
  'QUALIFIED',
  'NON_QUALIFIED',
  'UNCERTAIN',
  'NOT_APPLICABLE',
] as const

export type Qualification = (typeof QUALIFICATIONS)[number]

export const NEXT_ACTION_CODES = [
  'NONE',
  'CALLBACK',
  'SEND_DETAILS_EMAIL',
  'ASSIGN_TO_MR',
  'EXPERT_FOLLOWUP',
  'DOCTOR_CONSULTATION',
  'SCHEDULE_BOOKING',
  'DO_NOT_CALL',
  'REVERIFY',
  'TECHNICAL_RETRY',
  'LANGUAGE_CALLBACK',
  'OTHER',
] as const

export type NextActionCode = (typeof NEXT_ACTION_CODES)[number]

export const ISSUE_FLAGS = [
  'TECHNICAL_ISSUE',
  'LANGUAGE_ISSUE',
  'NO_CUSTOMER_SPEECH',
  'MISSED_REQUIREMENT',
  'INCORRECT_CLASSIFICATION',
  'WEAK_DISCOVERY',
  'WEAK_OBJECTION_HANDLING',
  'WEAK_NEXT_STEP',
  'UNSUPPORTED_CLAIM',
  'PRIVACY_COMPLIANCE_RISK',
  'DNC_RISK',
  'DUPLICATE_LEAD',
  'POOR_TRANSCRIPT_QUALITY',
  'REPEATED_QUESTION',
  'PREMATURE_END',
  'CUSTOMER_FRUSTRATION',
] as const

export type IssueFlag = (typeof ISSUE_FLAGS)[number]

/** The exact set of keys a model value may carry. Anything else is rejected. */
export const CONTENT_AUDIT_OUTPUT_KEYS = [
  'callConnected',
  'customerSpoke',
  'meaningfulConversation',
  'intent',
  'detailedOutcome',
  'qualification',
  'nextAction',
  'confidence',
  'metricScores',
  'issueFlags',
  'managementSummary',
  'kserveFeedback',
  'improvementFeedback',
] as const

/** Matches the varchar(2000) feedback columns in migration 0008. */
export const MAX_FEEDBACK_LENGTH = 2000

/** Validated model output plus the two application-derived fields. */
export interface ValidatedContentAuditOutput {
  callConnected: boolean
  customerSpoke: boolean
  meaningfulConversation: boolean
  intent: CallIntent
  detailedOutcome: DetailedOutcome
  /** DERIVED from detailedOutcome; never read from model output. */
  groupedOutcome: OutcomeGroup
  qualification: Qualification
  nextAction: NextActionCode
  confidence: number
  metricScores: readonly CallAuditMetricScore[]
  /** DERIVED from metricScores; never read from model output. */
  overallScore: string | null
  issueFlags: readonly IssueFlag[]
  managementSummary: string
  kserveFeedback: string
  improvementFeedback: string
}

function requireBoolean(record: Record<string, unknown>, field: string): boolean {
  const value = record[field]
  if (typeof value !== 'boolean') {
    throw new CallAuditOutputError(field, 'must be a boolean')
  }
  return value
}

function requireMember<T extends string>(
  record: Record<string, unknown>,
  field: string,
  allowed: readonly T[],
): T {
  const value = record[field]
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    throw new CallAuditOutputError(field, 'is not an approved value')
  }
  return value as T
}

/**
 * Sanitized free-text field: bounded, control-character free, and carrying no
 * contact detail or link. These strings are shown to management and to the
 * vendor, so a transcript fragment or phone number must never ride along.
 */
function requireSanitizedText(
  record: Record<string, unknown>,
  field: string,
): string {
  const value = record[field]
  if (typeof value !== 'string') {
    throw new CallAuditOutputError(field, 'must be a string')
  }
  const text = value.trim()
  if (text.length > MAX_FEEDBACK_LENGTH) {
    throw new CallAuditOutputError(
      field,
      `must be at most ${MAX_FEEDBACK_LENGTH} characters`,
    )
  }
  // Tab and newline are allowed; every other C0/C1 control character is not.
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/.test(text)) {
    throw new CallAuditOutputError(field, 'must not contain control characters')
  }
  if (/https?:\/\/|www\./i.test(text)) {
    throw new CallAuditOutputError(field, 'must not contain a URL')
  }
  if (/[^\s@]+@[^\s@]+\.[^\s@]+/.test(text)) {
    throw new CallAuditOutputError(field, 'must not contain an email address')
  }
  if (/\d[\d\s-]{6,}/.test(text)) {
    throw new CallAuditOutputError(field, 'must not contain a phone number')
  }
  return text
}

function requireConfidence(record: Record<string, unknown>): number {
  const value = record.confidence
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new CallAuditOutputError('confidence', 'must be a finite number')
  }
  if (value < 0 || value > 1) {
    throw new CallAuditOutputError('confidence', 'must be between 0 and 1')
  }
  return value
}

function requireIssueFlags(record: Record<string, unknown>): IssueFlag[] {
  const value = record.issueFlags
  if (!Array.isArray(value)) {
    throw new CallAuditOutputError('issueFlags', 'must be an array')
  }
  if (value.length > ISSUE_FLAGS.length) {
    throw new CallAuditOutputError('issueFlags', 'contains more flags than exist')
  }
  const flags: IssueFlag[] = []
  for (const flag of value) {
    if (
      typeof flag !== 'string' ||
      !(ISSUE_FLAGS as readonly string[]).includes(flag)
    ) {
      throw new CallAuditOutputError('issueFlags', 'contains an unapproved flag')
    }
    if (flags.includes(flag as IssueFlag)) {
      throw new CallAuditOutputError('issueFlags', 'contains a duplicate flag')
    }
    flags.push(flag as IssueFlag)
  }
  return flags
}

function requireMetricScores(
  record: Record<string, unknown>,
): Map<CallAuditMetricCode, MetricScore> {
  try {
    return normalizeMetricScoreSet(record.metricScores)
  } catch (error) {
    if (error instanceof CallAuditScoringError) {
      throw new CallAuditOutputError('metricScores', error.message)
    }
    throw error
  }
}

/**
 * Deterministic semantic checks.
 *
 * These assert only what follows from the model's own answers — no business
 * fact is invented. When nobody spoke, there is nothing to interpret, nothing
 * to qualify, and nothing to score.
 */
function assertSemanticConsistency(
  output: {
    callConnected: boolean
    customerSpoke: boolean
    meaningfulConversation: boolean
    intent: CallIntent
    qualification: Qualification
  },
  scores: Map<CallAuditMetricCode, MetricScore>,
): void {
  // A call that never connected cannot have carried customer speech. Without
  // this, the contradictory record (not connected, yet spoken and scored) would
  // pass validation and land in reports and aggregates unchallenged.
  //
  // The implication runs one way only: a call CAN connect without the customer
  // saying anything meaningful, so callConnected true with customerSpoke false
  // stays valid and falls through to the silent-call rules below.
  if (!output.callConnected && output.customerSpoke) {
    throw new CallAuditOutputError(
      'customerSpoke',
      'must be false when the call did not connect',
    )
  }
  if (!output.customerSpoke) {
    if (output.meaningfulConversation) {
      throw new CallAuditOutputError(
        'meaningfulConversation',
        'must be false when the customer did not speak',
      )
    }
    if (output.intent !== 'NONE') {
      throw new CallAuditOutputError(
        'intent',
        'must be NONE when the customer did not speak',
      )
    }
    if (output.qualification !== 'NOT_APPLICABLE') {
      throw new CallAuditOutputError(
        'qualification',
        'must be NOT_APPLICABLE when the customer did not speak',
      )
    }
    for (const [code, score] of scores) {
      if (score !== METRIC_SCORE_NOT_APPLICABLE) {
        throw new CallAuditOutputError(
          'metricScores',
          `metric ${code} must be NA when the customer did not speak`,
        )
      }
    }
    return
  }
  // The customer spoke, so only the two genuinely optional metrics may be NA.
  for (const metric of CALL_AUDIT_RUBRIC) {
    if (metric.naAllowedWhenCustomerSpoke) {
      continue
    }
    if (scores.get(metric.code) === METRIC_SCORE_NOT_APPLICABLE) {
      throw new CallAuditOutputError(
        'metricScores',
        `metric ${metric.code} may not be NA when the customer spoke`,
      )
    }
  }
}

/**
 * Validates untrusted content-audit model output and returns it with the
 * grouped outcome and overall score derived by the application.
 *
 * `context.eligibility` is trusted application state, not model output. An
 * operational-only call is handled by the non-content branch and is rejected
 * here even if the model volunteered a full set of scores.
 */
export function validateContentAuditOutput(
  value: unknown,
  context: { eligibility: CallAuditEligibility },
): ValidatedContentAuditOutput {
  if (context.eligibility !== 'content_auditable') {
    throw new CallAuditOutputError(
      'eligibility',
      'an operational-only call has no content-audit output',
    )
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new CallAuditOutputError('root', 'must be an object')
  }
  const record = value as Record<string, unknown>

  const allowed = new Set<string>(CONTENT_AUDIT_OUTPUT_KEYS)
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      // Named deliberately: groupedOutcome and overallScore land here, which is
      // how the model is prevented from choosing either.
      throw new CallAuditOutputError(key, 'is not an accepted output field')
    }
  }
  for (const key of CONTENT_AUDIT_OUTPUT_KEYS) {
    if (!(key in record)) {
      throw new CallAuditOutputError(key, 'is required')
    }
  }

  const callConnected = requireBoolean(record, 'callConnected')
  const customerSpoke = requireBoolean(record, 'customerSpoke')
  const meaningfulConversation = requireBoolean(record, 'meaningfulConversation')
  const intentValue = record.intent
  if (!isCallIntent(intentValue)) {
    throw new CallAuditOutputError('intent', 'is not an approved value')
  }
  const intent: CallIntent = intentValue
  const detailedOutcomeValue = record.detailedOutcome
  if (!isDetailedOutcome(detailedOutcomeValue)) {
    throw new CallAuditOutputError(
      'detailedOutcome',
      'is not an approved detailed outcome',
    )
  }
  const detailedOutcome: DetailedOutcome = detailedOutcomeValue
  const qualification = requireMember(record, 'qualification', QUALIFICATIONS)
  const nextAction = requireMember(record, 'nextAction', NEXT_ACTION_CODES)
  const confidence = requireConfidence(record)
  const scores = requireMetricScores(record)
  const issueFlags = requireIssueFlags(record)
  const managementSummary = requireSanitizedText(record, 'managementSummary')
  const kserveFeedback = requireSanitizedText(record, 'kserveFeedback')
  const improvementFeedback = requireSanitizedText(record, 'improvementFeedback')

  assertSemanticConsistency(
    {
      callConnected,
      customerSpoke,
      meaningfulConversation,
      intent,
      qualification,
    },
    scores,
  )

  const metricScores: CallAuditMetricScore[] = CALL_AUDIT_RUBRIC.map(
    (metric) => ({
      metric: metric.code,
      score: scores.get(metric.code) as MetricScore,
    }),
  )

  return {
    callConnected,
    customerSpoke,
    meaningfulConversation,
    intent,
    detailedOutcome,
    groupedOutcome: groupForDetailedOutcome(detailedOutcome),
    qualification,
    nextAction,
    confidence,
    metricScores,
    overallScore: calculateOverallScore(metricScores),
    issueFlags,
    managementSummary,
    kserveFeedback,
    improvementFeedback,
  }
}
