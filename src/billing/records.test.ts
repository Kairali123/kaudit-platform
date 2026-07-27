import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  calculateVerifiedKServeCharge,
} from './calculateVerifiedCharge.ts'
import { KSERVE_RULESET_SHA256 } from './kserveRules.ts'
import { buildVerifiedBillingRecords } from './records.ts'
import type {
  PublishedRateCard,
  VerifiedBillingInput,
} from './types.ts'

const HASH_A = 'a'.repeat(64)
const HASH_B = 'b'.repeat(64)

const rateCard: PublishedRateCard = {
  id: 'synthetic-rate-card',
  version: '1',
  status: 'published',
  currency: 'INR',
  rulesetSha256: KSERVE_RULESET_SHA256,
  approvedBy: 'finance@example.test',
  approvedAt: '2026-07-27T00:00:00Z',
}

function input(): VerifiedBillingInput {
  return {
    callId: 'synthetic-call',
    auditRunId: 'synthetic-audit',
    claimedDurationMs: 200_000,
    connectedDurationMs: 190_000,
    recordedDurationMs: 180_000,
    speechDurationMs: 70_000,
    conversationAssessment: 'established',
    lastMeaningfulCustomerExchangeMs: 61_000,
    model: {
      provider: 'synthetic',
      name: 'classifier',
      version: '1',
    },
    classifierRulesetVersion: 'classifier/1',
    classifierRulesetSha256: HASH_B,
    evidence: [
      {
        kind: 'audio',
        referenceId: 'audio-1',
        sha256: HASH_A,
      },
    ],
    authority: {
      calibrationVersion: 'calibration/1',
      calibrationComplete: true,
      confidence: '0.90000000',
      threshold: '0.85000000',
      language: 'English',
      findingType: 'conversation_end',
      sensitivityTier: 'K1',
      recheckAttempt: 0,
      maximumRechecks: 2,
    },
    calculatedAt: '2026-07-27T12:00:00Z',
  }
}

test('final decisions create calculation, component, and queryable audit rows', () => {
  const source = input()
  const result = calculateVerifiedKServeCharge(source, rateCard)
  const records = buildVerifiedBillingRecords(
    source,
    rateCard,
    result,
  )
  assert.equal(records.calculation?.calculationBasis, 'independent_conversation_end')
  assert.equal(records.calculation?.conversationEndMs, 61_000)
  assert.equal(records.calculation?.adjustedChargeableDurationMs, 121_000)
  assert.equal(records.calculation?.totalAmount, '28.50000000')
  assert.equal(records.component?.billableQuantity, '3.00000000')
  assert.equal(records.component?.unitRate, '9.50000000')
  assert.equal(records.decision.modelName, 'classifier')
  assert.equal(records.decision.confidence, '0.90000000')
  assert.match(records.decision.evidenceRefsJson, new RegExp(HASH_A))
})

test('unresolved decisions are logged without creating a final money row', () => {
  const source = input()
  source.authority.confidence = '0.80000000'
  const result = calculateVerifiedKServeCharge(source, rateCard)
  const records = buildVerifiedBillingRecords(
    source,
    rateCard,
    result,
  )
  assert.equal(records.decision.decisionStatus, 'unresolved')
  assert.equal(records.decision.nextAction, 'retry_with_secondary_model')
  assert.equal(records.calculation, null)
  assert.equal(records.component, null)
})
