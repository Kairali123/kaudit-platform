import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  calculateOverallScore,
  CallAuditScoringError,
  deriveOverallScore,
  normalizeMetricScoreSet,
  OVERALL_SCORE_DECIMALS,
  weightedPercentageDecimal,
} from './overallScore.ts'
import {
  CALL_AUDIT_METRIC_CODES,
  type CallAuditMetricCode,
  type CallAuditMetricScore,
} from './rubric.ts'
import type { MetricScore } from './types.ts'

/** Full score set, every metric the same value unless overridden. */
function scoreSet(
  fill: MetricScore,
  overrides: Partial<Record<CallAuditMetricCode, MetricScore>> = {},
): CallAuditMetricScore[] {
  // Object.hasOwn, not ??, so an explicit null/undefined override is injected
  // rather than silently falling back to the fill value.
  return CALL_AUDIT_METRIC_CODES.map((metric) => ({
    metric,
    score: Object.hasOwn(overrides, metric)
      ? (overrides[metric] as MetricScore)
      : fill,
  }))
}

// ---------------------------------------------------------------------------
// Exact boundaries
// ---------------------------------------------------------------------------

test('all fives is exactly 100.000 and all ones exactly 20.000', () => {
  assert.equal(calculateOverallScore(scoreSet(5)), '100.000')
  assert.equal(calculateOverallScore(scoreSet(1)), '20.000')
})

test('a uniform score maps onto its exact percentage', () => {
  assert.equal(calculateOverallScore(scoreSet(2)), '40.000')
  assert.equal(calculateOverallScore(scoreSet(3)), '60.000')
  assert.equal(calculateOverallScore(scoreSet(4)), '80.000')
})

test('always returns a fixed three-decimal string', () => {
  assert.equal(OVERALL_SCORE_DECIMALS, 3)
  for (const fill of [1, 2, 3, 4, 5] as const) {
    const score = calculateOverallScore(scoreSet(fill)) as string
    assert.match(score, /^\d{1,3}\.\d{3}$/)
  }
})

test('a mixed score set is computed exactly', () => {
  // 5*15 + 4*20 + 3*15 + 2*10 + 1*10 + 5*10 + 4*15 + 3*5
  //   = 75 + 80 + 45 + 20 + 10 + 50 + 60 + 15 = 355
  // 355 * 20 / 100 = 71
  const score = calculateOverallScore([
    { metric: 'PRODUCT_SERVICE_KNOWLEDGE', score: 5 },
    { metric: 'CUSTOMER_UNDERSTANDING', score: 4 },
    { metric: 'COMMUNICATION_CLARITY', score: 3 },
    { metric: 'OBJECTION_CALLBACK_HANDLING', score: 2 },
    { metric: 'CLOSING_NEXT_STEP', score: 1 },
    { metric: 'PROFESSIONALISM', score: 5 },
    { metric: 'QUALIFICATION_COMPLETENESS', score: 4 },
    { metric: 'COMPLIANCE_PRIVACY', score: 3 },
  ])
  assert.equal(score, '71.000')
})

// ---------------------------------------------------------------------------
// NA redistribution
// ---------------------------------------------------------------------------

test('an NA metric contributes to neither numerator nor denominator', () => {
  // PRODUCT_SERVICE_KNOWLEDGE (15) is NA, so the denominator is 85 and the
  // remaining weights absorb its share.
  const score = calculateOverallScore(
    scoreSet(5, { PRODUCT_SERVICE_KNOWLEDGE: 'NA' }),
  )
  assert.equal(score, '100.000')
  assert.equal(
    calculateOverallScore(scoreSet(1, { PRODUCT_SERVICE_KNOWLEDGE: 'NA' })),
    '20.000',
  )
})

test('redistribution changes the result versus scoring the NA metric low', () => {
  const withNa = calculateOverallScore(
    scoreSet(5, { OBJECTION_CALLBACK_HANDLING: 'NA' }),
  )
  const withOne = calculateOverallScore(
    scoreSet(5, { OBJECTION_CALLBACK_HANDLING: 1 }),
  )
  assert.equal(withNa, '100.000')
  assert.equal(withOne, '92.000')
  assert.notEqual(withNa, withOne)
})

test('both optional metrics NA leaves a denominator of 75', () => {
  // CU 20 + CC 15 + CN 10 + PR 10 + QC 15 + CP 5 = 75.
  // 4*20 + 3*15 + 5*10 + 4*10 + 3*15 + 2*5 = 80+45+50+40+45+10 = 270
  // 270 * 20 / 75 = 72 exactly.
  const score = calculateOverallScore([
    { metric: 'PRODUCT_SERVICE_KNOWLEDGE', score: 'NA' },
    { metric: 'CUSTOMER_UNDERSTANDING', score: 4 },
    { metric: 'COMMUNICATION_CLARITY', score: 3 },
    { metric: 'OBJECTION_CALLBACK_HANDLING', score: 'NA' },
    { metric: 'CLOSING_NEXT_STEP', score: 5 },
    { metric: 'PROFESSIONALISM', score: 4 },
    { metric: 'QUALIFICATION_COMPLETENESS', score: 3 },
    { metric: 'COMPLIANCE_PRIVACY', score: 2 },
  ])
  assert.equal(score, '72.000')
})

test('a repeating quotient is truncated downward when below the half', () => {
  // Denominator 75, weighted total 5*20 + 5*15 + 5*10 + 2*10 + 1*15 + 3*5 = 275.
  // 275 * 20 / 75 = 73.33333..., so the discarded remainder is below half.
  const score = calculateOverallScore([
    { metric: 'PRODUCT_SERVICE_KNOWLEDGE', score: 'NA' },
    { metric: 'CUSTOMER_UNDERSTANDING', score: 5 },
    { metric: 'COMMUNICATION_CLARITY', score: 5 },
    { metric: 'OBJECTION_CALLBACK_HANDLING', score: 'NA' },
    { metric: 'CLOSING_NEXT_STEP', score: 5 },
    { metric: 'PROFESSIONALISM', score: 2 },
    { metric: 'QUALIFICATION_COMPLETENESS', score: 1 },
    { metric: 'COMPLIANCE_PRIVACY', score: 3 },
  ])
  assert.equal(score, '73.333')
})

test('a repeating quotient is rounded up when at or above the half', () => {
  // Denominator 75, weighted total 4*20 + 3*15 + 5*10 + 5*10 + 3*15 + 2*5 = 280.
  // 280 * 20 / 75 = 74.66666..., so the remainder rounds the last digit up.
  const upward = calculateOverallScore([
    { metric: 'PRODUCT_SERVICE_KNOWLEDGE', score: 'NA' },
    { metric: 'CUSTOMER_UNDERSTANDING', score: 4 },
    { metric: 'COMMUNICATION_CLARITY', score: 3 },
    { metric: 'OBJECTION_CALLBACK_HANDLING', score: 'NA' },
    { metric: 'CLOSING_NEXT_STEP', score: 5 },
    { metric: 'PROFESSIONALISM', score: 5 },
    { metric: 'QUALIFICATION_COMPLETENESS', score: 3 },
    { metric: 'COMPLIANCE_PRIVACY', score: 2 },
  ])
  assert.equal(upward, '74.667')

  // Denominator 85, weighted total 5*20 + 5*15 + 5*10 + 5*10 + 1*10 + 3*15 + 1*5
  //   = 335. 335 * 20 / 85 = 78.8235294..., which rounds to 78.824.
  const alsoUpward = calculateOverallScore([
    { metric: 'PRODUCT_SERVICE_KNOWLEDGE', score: 'NA' },
    { metric: 'CUSTOMER_UNDERSTANDING', score: 5 },
    { metric: 'COMMUNICATION_CLARITY', score: 5 },
    { metric: 'OBJECTION_CALLBACK_HANDLING', score: 5 },
    { metric: 'CLOSING_NEXT_STEP', score: 5 },
    { metric: 'PROFESSIONALISM', score: 1 },
    { metric: 'QUALIFICATION_COMPLETENESS', score: 3 },
    { metric: 'COMPLIANCE_PRIVACY', score: 1 },
  ])
  assert.equal(alsoUpward, '78.824')
})

// ---------------------------------------------------------------------------
// The rounding rule itself
// ---------------------------------------------------------------------------

test('an exact half rounds up, never to even', () => {
  // 1 * 20 * 1000 / 64 = 312.5 -> 313. Banker's rounding would give 312.
  assert.equal(weightedPercentageDecimal(1n, 64n), '0.313')
  // 3 * 20 * 1000 / 64 = 937.5 -> 938. Banker's rounding would also give 938,
  // so the pair together distinguishes half-up from half-to-even.
  assert.equal(weightedPercentageDecimal(3n, 64n), '0.938')
})

test('a value just below a half rounds down', () => {
  // 20000/64 = 312.5 exactly; 19999/64 = 312.484... -> 312
  assert.equal(weightedPercentageDecimal(1n, 64n), '0.313')
  assert.equal(weightedPercentageDecimal(999n, 64000n), '0.312')
})

test('exact division needs no rounding', () => {
  assert.equal(weightedPercentageDecimal(5n, 100n), '1.000')
  assert.equal(weightedPercentageDecimal(500n, 100n), '100.000')
  assert.equal(weightedPercentageDecimal(0n, 100n), '0.000')
})

test('the calculation uses no binary floating point', () => {
  // 0.1 + 0.2 !== 0.3 in IEEE doubles; the same class of drift must never
  // reach a persisted audit score, so the arithmetic is BigInt throughout.
  const first = calculateOverallScore(scoreSet(3, { COMPLIANCE_PRIVACY: 4 }))
  const second = calculateOverallScore(scoreSet(3, { COMPLIANCE_PRIVACY: 4 }))
  assert.equal(first, second)
  assert.match(first as string, /^\d+\.\d{3}$/)
  assert.equal(String(first).includes('e'), false)
})

test('rejects a non-positive denominator', () => {
  assert.throws(() => weightedPercentageDecimal(1n, 0n), CallAuditScoringError)
  assert.throws(() => weightedPercentageDecimal(1n, -5n), CallAuditScoringError)
  assert.throws(() => weightedPercentageDecimal(-1n, 5n), CallAuditScoringError)
})

// ---------------------------------------------------------------------------
// All-NA and operational-only
// ---------------------------------------------------------------------------

test('every metric NA yields null, never zero', () => {
  const score = calculateOverallScore(scoreSet('NA'))
  assert.equal(score, null)
  assert.notEqual(score, '0.000')
  assert.notEqual(score, 0)
})

test('an operational-only call is never scored', () => {
  assert.equal(
    deriveOverallScore({ eligibility: 'operational_only' }),
    null,
  )
  // Even when scores are supplied, an operational-only call stays unscored.
  assert.equal(
    deriveOverallScore({
      eligibility: 'operational_only',
      metricScores: scoreSet(5),
    }),
    null,
  )
})

test('a content-auditable call is scored from its metrics', () => {
  assert.equal(
    deriveOverallScore({
      eligibility: 'content_auditable',
      metricScores: scoreSet(4),
    }),
    '80.000',
  )
})

// ---------------------------------------------------------------------------
// Score-set validation
// ---------------------------------------------------------------------------

test('requires exactly one score for every metric', () => {
  const complete = normalizeMetricScoreSet(scoreSet(3))
  assert.equal(complete.size, 8)
  for (const code of CALL_AUDIT_METRIC_CODES) {
    assert.ok(complete.has(code))
  }
})

test('rejects a missing metric', () => {
  const short = scoreSet(3).slice(0, 7)
  assert.throws(() => normalizeMetricScoreSet(short), CallAuditScoringError)
  assert.throws(() => calculateOverallScore(short), CallAuditScoringError)
})

test('rejects a duplicate metric', () => {
  const duplicated = scoreSet(3)
  duplicated[7] = { metric: 'PRODUCT_SERVICE_KNOWLEDGE', score: 4 }
  assert.throws(
    () => normalizeMetricScoreSet(duplicated),
    CallAuditScoringError,
  )
})

test('rejects an unknown metric', () => {
  const unknown = scoreSet(3)
  unknown[0] = {
    metric: 'AUDIO_VOLUME' as CallAuditMetricCode,
    score: 4,
  }
  assert.throws(() => normalizeMetricScoreSet(unknown), CallAuditScoringError)
})

test('rejects an extra metric entry', () => {
  const extra = [
    ...scoreSet(3),
    { metric: 'PROFESSIONALISM' as CallAuditMetricCode, score: 3 as MetricScore },
  ]
  assert.throws(() => normalizeMetricScoreSet(extra), CallAuditScoringError)
})

test('rejects zero, fractions, and out-of-range scores', () => {
  for (const bad of [0, 6, -1, 1.5, 4.9, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(
      () =>
        normalizeMetricScoreSet(
          scoreSet(3, { PROFESSIONALISM: bad as MetricScore }),
        ),
      CallAuditScoringError,
      `${bad} must be rejected`,
    )
  }
})

test('rejects a score that is a string or other non-score value', () => {
  for (const bad of ['3', 'na', 'n/a', '', null, undefined, true, {}, []]) {
    assert.throws(
      () =>
        normalizeMetricScoreSet(
          scoreSet(3, { CLOSING_NEXT_STEP: bad as MetricScore }),
        ),
      CallAuditScoringError,
      `${JSON.stringify(bad)} must be rejected`,
    )
  }
})

test('rejects a malformed score container', () => {
  for (const bad of [null, undefined, {}, 'scores', 42]) {
    assert.throws(() => normalizeMetricScoreSet(bad), CallAuditScoringError)
  }
  assert.throws(
    () => normalizeMetricScoreSet([1, 2, 3, 4, 5, 6, 7, 8]),
    CallAuditScoringError,
  )
})

test('rejects a score entry with extra or missing keys', () => {
  const withExtra = scoreSet(3) as unknown as Record<string, unknown>[]
  withExtra[0] = { metric: 'PROFESSIONALISM', score: 3, comment: 'nice' }
  assert.throws(
    () => normalizeMetricScoreSet(withExtra),
    CallAuditScoringError,
  )

  const withMissing = scoreSet(3) as unknown as Record<string, unknown>[]
  withMissing[0] = { metric: 'PROFESSIONALISM' }
  assert.throws(
    () => normalizeMetricScoreSet(withMissing),
    CallAuditScoringError,
  )
})

test('validation errors are typed and carry no score payload', () => {
  try {
    normalizeMetricScoreSet(scoreSet(3).slice(0, 7))
    assert.fail('expected a scoring error')
  } catch (error) {
    assert.ok(error instanceof CallAuditScoringError)
    assert.equal(error.code, 'INVALID_CALL_AUDIT_SCORES')
  }
})
