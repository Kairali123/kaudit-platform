import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  calculateVerifiedKServeCharge,
  roundKServeChargeableDuration,
} from './calculateVerifiedCharge.ts'
import {
  KSERVE_RULESET_SHA256,
} from './kserveRules.ts'
import type {
  PublishedRateCard,
  VerifiedBillingInput,
} from './types.ts'

const HASH_A = 'a'.repeat(64)
const HASH_B = 'b'.repeat(64)

function publishedRateCard(): PublishedRateCard {
  return {
    id: 'synthetic-rate-card',
    version: '2026-07-27.1',
    status: 'published',
    currency: 'INR',
    rulesetSha256: KSERVE_RULESET_SHA256,
    approvedBy: 'finance-approver@example.test',
    approvedAt: '2026-07-27T10:00:00.000Z',
  }
}

function input(
  overrides: Partial<VerifiedBillingInput> = {},
): VerifiedBillingInput {
  return {
    callId: 'synthetic-call',
    auditRunId: 'synthetic-audit-run',
    claimedDurationMs: 180_000,
    connectedDurationMs: 180_000,
    recordedDurationMs: 180_000,
    speechDurationMs: 80_000,
    conversationAssessment: 'established',
    lastMeaningfulCustomerExchangeMs: 61_000,
    model: {
      provider: 'synthetic-provider',
      name: 'synthetic-classifier',
      version: '1.0',
    },
    classifierRulesetVersion: 'synthetic-classifier-rules/1',
    classifierRulesetSha256: HASH_B,
    evidence: [
      {
        kind: 'audio',
        referenceId: 'synthetic-audio',
        sha256: HASH_A,
      },
    ],
    authority: {
      calibrationVersion: 'synthetic-calibration/1',
      calibrationComplete: true,
      confidence: '0.95000000',
      threshold: '0.85000000',
      language: 'English',
      findingType: 'conversation_end',
      sensitivityTier: 'K1',
      recheckAttempt: 0,
      maximumRechecks: 2,
    },
    calculatedAt: '2026-07-27T10:30:00.000Z',
    ...overrides,
  }
}

test('locked duration boundaries produce exact fixed-precision amounts', () => {
  const cases = [
    [0, '0.00000000', '0.00000000'],
    [1, '0.50000000', '4.75000000'],
    [29_999, '0.50000000', '4.75000000'],
    [30_000, '1.00000000', '9.50000000'],
    [60_000, '1.00000000', '9.50000000'],
    [60_001, '2.00000000', '19.00000000'],
    [120_000, '2.00000000', '19.00000000'],
    [120_001, '3.00000000', '28.50000000'],
    [240_000, '4.00000000', '38.00000000'],
  ] as const

  for (const [milliseconds, minutes, amount] of cases) {
    const result = roundKServeChargeableDuration(milliseconds)
    assert.equal(result.billableMinutes, minutes)
    assert.equal(result.amount, amount)
  }
})

test('60-second AI wrap-up grace is capped by recording duration', () => {
  const result = calculateVerifiedKServeCharge(
    input({
      recordedDurationMs: 100_000,
      lastMeaningfulCustomerExchangeMs: 50_000,
    }),
    publishedRateCard(),
  )
  assert.equal(result.status, 'final')
  if (result.status !== 'final') return
  assert.equal(result.adjustedChargeableDurationMs, 100_000)
  assert.equal(result.billableMinutes, '2.00000000')
  assert.equal(result.amount, '19.00000000')
  assert.equal(result.oneWayTailMs, 0)
})

test('one-way tail alert is strict: 60 seconds passes, 60.001 seconds alerts', () => {
  const exact = calculateVerifiedKServeCharge(
    input({
      recordedDurationMs: 150_000,
      lastMeaningfulCustomerExchangeMs: 30_000,
    }),
    publishedRateCard(),
  )
  const over = calculateVerifiedKServeCharge(
    input({
      recordedDurationMs: 150_001,
      lastMeaningfulCustomerExchangeMs: 30_000,
    }),
    publishedRateCard(),
  )
  assert.equal(exact.status, 'final')
  assert.equal(over.status, 'final')
  if (exact.status === 'final') {
    assert.equal(exact.oneWayTailMs, 60_000)
    assert.equal(exact.oneWayTailAlert, false)
  }
  if (over.status === 'final') {
    assert.equal(over.oneWayTailMs, 60_001)
    assert.equal(over.oneWayTailAlert, true)
  }
})

test('no meaningful exchange is independently verified as zero, not missing', () => {
  const result = calculateVerifiedKServeCharge(
    input({
      conversationAssessment: 'no_meaningful_exchange',
      lastMeaningfulCustomerExchangeMs: null,
    }),
    publishedRateCard(),
  )
  assert.equal(result.status, 'final')
  if (result.status !== 'final') return
  assert.equal(result.billableDurationMs, 0)
  assert.equal(result.amount, '0.00000000')
  assert.equal(result.ruleCode, 'ZERO_DURATION_NOT_BILLED')
})

test('uncalibrated and low-confidence decisions remain unresolved', () => {
  const uncalibrated = calculateVerifiedKServeCharge(
    input({
      authority: {
        ...input().authority,
        calibrationComplete: false,
        threshold: null,
      },
    }),
    publishedRateCard(),
  )
  assert.equal(uncalibrated.status, 'unresolved')
  assert.equal(uncalibrated.reasonCode, 'CALIBRATION_NOT_COMPLETED')

  const retry = calculateVerifiedKServeCharge(
    input({
      authority: {
        ...input().authority,
        confidence: '0.84000000',
        threshold: '0.85000000',
        recheckAttempt: 1,
        maximumRechecks: 2,
      },
    }),
    publishedRateCard(),
  )
  assert.equal(retry.status, 'unresolved')
  assert.equal(retry.reasonCode, 'LOW_CONFIDENCE_RECHECK_REQUIRED')
  assert.equal(retry.nextAction, 'retry_with_secondary_model')

  const exhausted = calculateVerifiedKServeCharge(
    input({
      authority: {
        ...input().authority,
        confidence: '0.84000000',
        threshold: '0.85000000',
        recheckAttempt: 2,
        maximumRechecks: 2,
      },
    }),
    publishedRateCard(),
  )
  assert.equal(exhausted.status, 'unresolved')
  assert.equal(
    exhausted.reasonCode,
    'LOW_CONFIDENCE_RECHECK_EXHAUSTED',
  )
  assert.equal(
    exhausted.nextAction,
    'hold_unresolved_until_cycle_close',
  )
})

test('legacy sensitivity metadata does not change automation authority', () => {
  const result = calculateVerifiedKServeCharge(
    input({
      authority: {
        ...input().authority,
        sensitivityTier: 'K3',
      },
    }),
    publishedRateCard(),
  )
  assert.equal(result.status, 'final')
  assert.equal(result.reasonCode, 'AUTOMATED_CONFIDENCE_CONFIRMED')
})

test('draft or hash-mismatched rate cards cannot calculate money', () => {
  assert.throws(
    () =>
      calculateVerifiedKServeCharge(
        input(),
        { ...publishedRateCard(), status: 'draft' },
      ),
    /D-03/,
  )
  assert.throws(
    () =>
      calculateVerifiedKServeCharge(
        input(),
        { ...publishedRateCard(), rulesetSha256: HASH_A },
      ),
    /hash does not match/,
  )
})

test('trace is reproducible and contains model, confidence, ruleset, and evidence hashes', () => {
  const left = calculateVerifiedKServeCharge(
    input(),
    publishedRateCard(),
  )
  const right = calculateVerifiedKServeCharge(
    input(),
    publishedRateCard(),
  )
  assert.equal(left.inputManifestSha256, right.inputManifestSha256)
  assert.equal(left.traceSha256, right.traceSha256)
  assert.equal(left.trace.model.name, 'synthetic-classifier')
  assert.equal(left.trace.authority.confidence, '0.95000000')
  assert.equal(left.trace.rulesetSha256, KSERVE_RULESET_SHA256)
  assert.equal(left.trace.evidence[0]?.sha256, HASH_A)
})

test('rounded amount never decreases as duration increases', () => {
  let previous = -1n
  for (let durationMs = 0; durationMs <= 600_000; durationMs += 997) {
    const result = roundKServeChargeableDuration(durationMs)
    assert.ok(result.amountPaise >= previous)
    previous = result.amountPaise
  }
})
