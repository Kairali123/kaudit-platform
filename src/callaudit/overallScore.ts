import { isMetricScore } from './metricScore.ts'
import {
  CALL_AUDIT_METRIC_CODES,
  isCallAuditMetricCode,
  metricWeight,
  type CallAuditMetricCode,
  type CallAuditMetricScore,
} from './rubric.ts'
import { METRIC_SCORE_NOT_APPLICABLE, type MetricScore } from './types.ts'
import type { CallAuditEligibility } from './types.ts'

export class CallAuditScoringError extends Error {
  readonly code = 'INVALID_CALL_AUDIT_SCORES'
}

/** Decimal places of the persisted overall score. */
export const OVERALL_SCORE_DECIMALS = 3

/**
 * Stable identity of the method that produced an overall score, persisted in
 * `kaudit_call_audit_result.overall_score_method` (varchar(60)). It lives here
 * because this module owns the calculation: bump it whenever the weighting,
 * redistribution, or rounding rule changes, so an old score stays attributable
 * to the rule that actually produced it.
 */
export const OVERALL_SCORE_METHOD = 'call-audit-weighted-percentage/1.0.0'

const SCALE = 1000n // 10 ** OVERALL_SCORE_DECIMALS
const PERCENT_FACTOR = 20n // a 1-5 score maps onto 0-100

/**
 * Divides with an explicit HALF-UP rule, in integer (BigInt) arithmetic only.
 *
 * Given numerator N and denominator D, the exact value N/D is expanded to three
 * decimals as q = floor(N * 1000 / D) with remainder r. When the discarded
 * remainder is exactly half of D or more (2r >= D), q is incremented. Both
 * inputs are non-negative here, so half-up and half-away-from-zero coincide.
 *
 * Binary floating point is never involved: an IEEE double cannot hold a value
 * like 72.267 exactly, and a repeated audit must reproduce the same string.
 */
function divideHalfUpScaled(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) {
    throw new CallAuditScoringError('Applicable weight total must be positive')
  }
  const scaled = numerator * SCALE
  const quotient = scaled / denominator
  const remainder = scaled % denominator
  return remainder * 2n >= denominator ? quotient + 1n : quotient
}

/** Formats a scaled integer as a fixed 3-decimal string, e.g. 72267 -> '72.267'. */
function formatScaled(scaled: bigint): string {
  const whole = scaled / SCALE
  const fraction = scaled % SCALE
  return `${whole}.${fraction.toString().padStart(OVERALL_SCORE_DECIMALS, '0')}`
}

/**
 * The weighted percentage for an already-summed score set.
 *
 * `weightedScoreTotal` is sum(score * weight) over APPLICABLE metrics, and
 * `applicableWeightTotal` is sum(weight) over the same metrics — so an NA
 * metric contributes to neither, and its weight is redistributed across the
 * metrics that did apply.
 *
 * Exported so the rounding rule itself is directly testable, including tie
 * cases that the approved weights happen never to produce.
 */
export function weightedPercentageDecimal(
  weightedScoreTotal: bigint,
  applicableWeightTotal: bigint,
): string {
  if (weightedScoreTotal < 0n) {
    throw new CallAuditScoringError('Weighted score total must not be negative')
  }
  return formatScaled(
    divideHalfUpScaled(weightedScoreTotal * PERCENT_FACTOR, applicableWeightTotal),
  )
}

/**
 * Validates a complete metric score set: exactly one entry for every approved
 * metric, no duplicates, no unknown metrics, and every score either an integer
 * 1-5 or NA. Zero, fractions, and out-of-range values are rejected outright.
 */
export function normalizeMetricScoreSet(
  entries: unknown,
): Map<CallAuditMetricCode, MetricScore> {
  if (!Array.isArray(entries)) {
    throw new CallAuditScoringError('Metric scores must be an array')
  }
  if (entries.length !== CALL_AUDIT_METRIC_CODES.length) {
    throw new CallAuditScoringError(
      `Expected exactly ${CALL_AUDIT_METRIC_CODES.length} metric scores, received ${entries.length}`,
    )
  }
  const scores = new Map<CallAuditMetricCode, MetricScore>()
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new CallAuditScoringError('Each metric score must be an object')
    }
    const keys = Object.keys(entry).sort()
    if (keys.length !== 2 || keys[0] !== 'metric' || keys[1] !== 'score') {
      throw new CallAuditScoringError(
        'Each metric score must have exactly the keys metric and score',
      )
    }
    const { metric, score } = entry as { metric: unknown; score: unknown }
    if (!isCallAuditMetricCode(metric)) {
      throw new CallAuditScoringError('Unknown metric code')
    }
    if (scores.has(metric)) {
      throw new CallAuditScoringError(`Duplicate score for metric ${metric}`)
    }
    if (!isMetricScore(score)) {
      throw new CallAuditScoringError(
        `Score for metric ${metric} must be an integer 1-5 or NA`,
      )
    }
    scores.set(metric, score)
  }
  for (const code of CALL_AUDIT_METRIC_CODES) {
    if (!scores.has(code)) {
      throw new CallAuditScoringError(`Missing score for metric ${code}`)
    }
  }
  return scores
}

/**
 * Deterministic overall score as a fixed 3-decimal string, or null when every
 * metric is NA — an all-NA call has no measurable quality, and reporting 0.000
 * would misread "nothing to assess" as "assessed and terrible".
 */
export function calculateOverallScore(entries: unknown): string | null {
  const scores = normalizeMetricScoreSet(entries)
  let weightedScoreTotal = 0n
  let applicableWeightTotal = 0n
  for (const [code, score] of scores) {
    if (score === METRIC_SCORE_NOT_APPLICABLE) {
      continue
    }
    const weight = BigInt(metricWeight(code))
    weightedScoreTotal += BigInt(score) * weight
    applicableWeightTotal += weight
  }
  if (applicableWeightTotal === 0n) {
    return null
  }
  return weightedPercentageDecimal(weightedScoreTotal, applicableWeightTotal)
}

/**
 * Overall score for one audited call. An operational-only call is never scored:
 * it has no transcript to assess, so the score is absent rather than zero.
 */
export function deriveOverallScore(input: {
  eligibility: CallAuditEligibility
  metricScores?: readonly CallAuditMetricScore[] | unknown
}): string | null {
  if (input.eligibility === 'operational_only') {
    return null
  }
  return calculateOverallScore(input.metricScores)
}
