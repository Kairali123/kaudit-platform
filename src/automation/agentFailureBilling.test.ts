import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Pool } from 'mysql2/promise'
import { runAutomatedValidation } from './validationRun.ts'
import {
  collectAutomatedValidationCandidates,
  persistedAgentFailureFacts,
  type AutomatedValidationCandidate,
} from '../adapters/mysqlAutomatedValidation.ts'
import { validateClassification, mergeTranscriptSegments } from '../reaudit/core.ts'
import { calculateVerifiedKServeCharge } from '../billing/calculateVerifiedCharge.ts'
import { KSERVE_RULESET_SHA256 } from '../billing/kserveRules.ts'
import {
  CATEGORY_CHARGE_POLICY_SHA256,
  CATEGORY_CHARGE_POLICY_VERSION,
} from '../billing/categoryChargePolicy.ts'
import type {
  PublishedRateCard,
  VerifiedBillingInput,
} from '../billing/types.ts'
import type {
  ClassificationDecisionSignals,
  ModelClassification,
  ReauditAi,
} from '../reaudit/types.ts'

/**
 * AGENT_FAILURE money, end to end: validated classification -> consensus ->
 * verified charge. Every identifier and transcript line is SYNTHETIC, and the
 * pool throws on use, so a DRY-RUN that wrote anything would fail loudly.
 */

const RECORDED_MS = 300_000
const FAILURE_MS = 70_000

const SEGMENTS = [
  { startMs: 0, endMs: 8_000, text: 'Namaste, this is Saanvi from Kairali.' },
  { startMs: 10_000, endMs: 20_000, text: 'I want to book a wellness package.' },
  { startMs: 22_000, endMs: 40_000, text: 'Our seven day package includes daily therapy.' },
  { startMs: 42_000, endMs: 50_000, text: 'What does it cost?' },
  { startMs: 52_000, endMs: 60_000, text: 'It is priced per night, let me check.' },
  { startMs: 70_000, endMs: 80_000, text: 'Hello? Are you still there?' },
  { startMs: 90_000, endMs: 100_000, text: 'Hello? Hello?' },
]
const BLOCKS = mergeTranscriptSegments(SEGMENTS)

const BASE_SIGNALS: ClassificationDecisionSignals = {
  counterpartyType: 'human',
  agentHandling: 'failed',
  conversationOutcome: 'no_outcome',
  durationOutcome: 'unclear',
  stopIntent: 'none',
  postStopBehavior: 'not_applicable',
  successfulOutcome: 'none',
  voicemailEvidence: 'none',
  automationEvidence: 'none',
  junkEvidence: 'none',
  agentFailureMode: 'mid_conversation',
  meaningfulServiceBeforeFailure: true,
}

function raw(overrides: Partial<ModelClassification> = {}): ModelClassification {
  return {
    model: { provider: 'openai', name: 'synthetic-model', version: 'synthetic/1' },
    category: 'AGENT_FAILURE',
    confidence: '0.95000000',
    customerBlockNumbers: [2, 4, 6, 7],
    unclearBlockNumbers: [],
    agentBlockNumbers: [1, 3, 5],
    customerSpoke: true,
    lastMeaningfulCustomerExchangeMs: null,
    agentFailureStartBlockNumber: 6,
    remarks: 'synthetic',
    disputeRecommended: false,
    decisionSignals: BASE_SIGNALS,
    ...overrides,
  }
}

const FROM_START = raw({
  agentFailureStartBlockNumber: null,
  decisionSignals: { ...BASE_SIGNALS, agentFailureMode: 'start', meaningfulServiceBeforeFailure: false },
})
// Customer speaks first and Saanvi never answers before the named boundary.
const NO_SERVICE = raw({ agentBlockNumbers: [], customerBlockNumbers: [1, 2, 3, 4, 5, 6, 7] })
const UNSUPPORTED_BOUNDARY = raw({ agentFailureStartBlockNumber: 99 })

function validated(model: ModelClassification): ModelClassification {
  return validateClassification(model, BLOCKS, RECORDED_MS)
}

function reviewer(model: ModelClassification): Pick<ReauditAi, 'classify'> & { calls: number } {
  const port = {
    calls: 0,
    async classify() {
      port.calls += 1
      return model
    },
  }
  return port
}

const untouchablePool = new Proxy({}, {
  get() {
    throw new Error('DRY-RUN must not touch the database')
  },
}) as Pool

const RATE_CARD: PublishedRateCard = {
  id: 'synthetic-rate-card',
  version: 'synthetic-2026-06',
  status: 'published',
  currency: 'INR',
  rulesetSha256: KSERVE_RULESET_SHA256,
  approvedBy: 'finance-approver@example.test',
  approvedAt: '2026-05-31T10:00:00.000Z',
}

function candidate(primary: ModelClassification): AutomatedValidationCandidate {
  return {
    callId: 'synthetic-call',
    callReference: 'synthetic-task',
    auditRunId: 'synthetic-run',
    artifactId: 'synthetic-artifact',
    transcriptId: 'synthetic-transcript',
    language: 'english',
    recordedDurationMs: RECORDED_MS,
    speechDurationMs: 80_000,
    connectedDurationMs: RECORDED_MS,
    claimedDurationMs: RECORDED_MS,
    primary,
    segments: SEGMENTS,
    evidence: [
      { kind: 'audio', referenceId: 'synthetic-artifact', sha256: 'a'.repeat(64) },
    ],
  }
}

async function run(primary: ModelClassification, secondary: ModelClassification, third = secondary) {
  const adjudicator = reviewer(third)
  const outcome = await runAutomatedValidation(untouchablePool, {
    candidate: candidate(primary),
    reviewer: reviewer(secondary),
    adjudicator,
    rateCard: RATE_CARD,
    correlationId: null,
    decidedAt: '2026-06-30T10:00:00.000Z',
    dryRun: true,
  })
  return { outcome, adjudicatorCalls: adjudicator.calls }
}

test('a genuine mid-conversation failure charges the boundary plus exactly 30 seconds', async () => {
  const primary = validated(raw())
  assert.equal(primary.failureStartMs, FAILURE_MS)
  const { outcome } = await run(primary, raw())
  assert.equal(outcome.status, 'accepted')
  assert.equal(outcome.billingStatus, 'final')
  assert.equal(outcome.policyCode, 'AGENT_FAILURE_MID_CONVERSATION_PLUS_30S')
  // 70s + 30s = 100s -> 2 minutes at INR 9.50. A 60s grace would be 3 minutes.
  assert.equal(outcome.amount, '19.00000000')
})

test('from-start, no-service, and unsupported-boundary failures are zero', async () => {
  for (const model of [FROM_START, NO_SERVICE, UNSUPPORTED_BOUNDARY]) {
    const primary = validated(model)
    assert.equal(primary.agentFailureMode, 'start')
    const { outcome } = await run(primary, model)
    assert.equal(outcome.status, 'accepted')
    assert.equal(outcome.policyCode, 'MANAGEMENT_ZERO_CATEGORY')
    assert.equal(outcome.amount, '0.00000000')
  }
})

test('a primary that lost its evidence cannot agree with a charging reviewer', async () => {
  // The old bug: consensus priced every AGENT_FAILURE at zero, so a stripped
  // primary and a charging secondary "agreed". They must not.
  const stripped = { ...validated(raw()), agentFailureMode: null, failureStartMs: null }
  const { outcome } = await run(stripped, raw(), FROM_START)
  assert.equal(outcome.status, 'unresolved')
  assert.ok(outcome.reasons.includes('BILLABLE_DURATION_DISAGREEMENT'))
  assert.equal(outcome.billingStatus, 'unresolved')
  assert.equal(outcome.amount, null)
})

test('DRY-RUN still adjudicates a lone category disagreement and writes nothing', async () => {
  const ok = raw({
    category: 'CONNECT_NOT_FRUITFUL',
    agentFailureStartBlockNumber: null,
    decisionSignals: {
      ...BASE_SIGNALS,
      agentHandling: 'normal',
      agentFailureMode: 'none',
      meaningfulServiceBeforeFailure: false,
    },
  })
  // CONNECT_NOT_FRUITFUL and TIME_DURATION both charge to the last customer
  // block, so the category is the ONLY disagreement and a third pass is due.
  const primary = validated(ok)
  const time = validated(raw({ category: 'TIME_DURATION', decisionSignals: {
    ...BASE_SIGNALS,
    agentHandling: 'unclear',
    durationOutcome: 'continued_without_value',
    agentFailureMode: 'none',
    meaningfulServiceBeforeFailure: false,
  }, agentFailureStartBlockNumber: null }))
  assert.equal(time.category, 'TIME_DURATION')
  const { outcome, adjudicatorCalls } = await run(primary, time, ok)
  assert.equal(adjudicatorCalls, 1)
  assert.equal(outcome.status, 'accepted')
  assert.equal(outcome.billingStatus, 'final')
})

// ---------------------------------------------------------------------------
// Verified billing accepts exactly two AGENT_FAILURE shapes.
// ---------------------------------------------------------------------------

function billingInput(
  categoryCharge: NonNullable<VerifiedBillingInput['categoryCharge']>,
): VerifiedBillingInput {
  return {
    callId: 'synthetic-call',
    auditRunId: 'synthetic-run',
    claimedDurationMs: RECORDED_MS,
    connectedDurationMs: RECORDED_MS,
    recordedDurationMs: RECORDED_MS,
    speechDurationMs: 80_000,
    conversationAssessment: 'established',
    lastMeaningfulCustomerExchangeMs: 100_000,
    categoryCharge,
    model: { provider: 'openai', name: 'synthetic-model', version: 'synthetic/1' },
    classifierRulesetVersion: 'synthetic-rules/1',
    classifierRulesetSha256: 'b'.repeat(64),
    evidence: [{ kind: 'audio', referenceId: 'synthetic-artifact', sha256: 'a'.repeat(64) }],
    authority: {
      calibrationVersion: 'synthetic/1',
      calibrationComplete: true,
      confidence: '0.95000000',
      threshold: '0.80000000',
      language: 'english',
      findingType: 'AGENT_FAILURE',
      sensitivityTier: 'K0',
      recheckAttempt: 1,
      maximumRechecks: 3,
    },
    calculatedAt: '2026-06-30T10:00:00.000Z',
  }
}

const MID = {
  category: 'AGENT_FAILURE' as const,
  serviceEndMs: FAILURE_MS,
  graceMs: 30_000,
  policyCode: 'AGENT_FAILURE_MID_CONVERSATION_PLUS_30S' as const,
  policyVersion: CATEGORY_CHARGE_POLICY_VERSION,
  policySha256: CATEGORY_CHARGE_POLICY_SHA256,
  agentFailure: {
    mode: 'mid_conversation' as const,
    meaningfulServiceBeforeFailure: true,
    failureStartMs: FAILURE_MS,
  },
}
const ZERO = {
  ...MID,
  serviceEndMs: 0,
  graceMs: 0,
  policyCode: 'MANAGEMENT_ZERO_CATEGORY' as const,
  agentFailure: { mode: 'start' as const, meaningfulServiceBeforeFailure: false, failureStartMs: null },
}

test('verified billing accepts the validated mid-conversation and zero shapes', () => {
  const mid = calculateVerifiedKServeCharge(billingInput(MID), RATE_CARD)
  assert.equal(mid.status, 'final')
  assert.equal(mid.status === 'final' && mid.adjustedChargeableDurationMs, 100_000)
  assert.deepEqual(
    (mid.trace.inputs.categoryCharge as typeof MID).agentFailure,
    MID.agentFailure,
  )
  const zero = calculateVerifiedKServeCharge(billingInput(ZERO), RATE_CARD)
  assert.equal(zero.status === 'final' && zero.amount, '0.00000000')
  const { agentFailure: _omitted, ...legacyZero } = ZERO
  assert.equal(
    calculateVerifiedKServeCharge(billingInput(legacyZero), RATE_CARD).status,
    'final',
  )
})

test('the recording still caps a mid-conversation charge', () => {
  const late = calculateVerifiedKServeCharge(
    billingInput({
      ...MID,
      serviceEndMs: 290_000,
      agentFailure: { ...MID.agentFailure, failureStartMs: 290_000 },
    }),
    RATE_CARD,
  )
  assert.equal(late.status === 'final' && late.adjustedChargeableDurationMs, RECORDED_MS)
  assert.throws(() =>
    calculateVerifiedKServeCharge(
      billingInput({
        ...MID,
        serviceEndMs: 310_000,
        agentFailure: { ...MID.agentFailure, failureStartMs: 310_000 },
      }),
      RATE_CARD,
    ),
  )
})

test('invalid or missing failure evidence fails closed', () => {
  const invalid: Array<NonNullable<VerifiedBillingInput['categoryCharge']>> = [
    { ...MID, agentFailure: undefined },
    { ...MID, graceMs: 60_000 },
    { ...MID, graceMs: 0 },
    { ...MID, serviceEndMs: 0, agentFailure: { ...MID.agentFailure, failureStartMs: 0 } },
    { ...MID, agentFailure: { ...MID.agentFailure, failureStartMs: 65_000 } },
    { ...MID, agentFailure: { ...MID.agentFailure, mode: 'start' } },
    { ...MID, agentFailure: { ...MID.agentFailure, meaningfulServiceBeforeFailure: false } },
    { ...ZERO, agentFailure: MID.agentFailure },
    { ...ZERO, serviceEndMs: FAILURE_MS },
    { ...MID, category: 'OK' },
    { ...MID, category: 'INACTIVE_CALL' },
  ]
  for (const categoryCharge of invalid) {
    assert.throws(
      () => calculateVerifiedKServeCharge(billingInput(categoryCharge), RATE_CARD),
      /does not match the locked category rule/,
    )
  }
})

// ---------------------------------------------------------------------------
// A persisted primary keeps its evidence only if it still re-derives.
// ---------------------------------------------------------------------------

const PERSISTED_METRICS = {
  agentBlockNumbers: [1, 3, 5],
  agentFailureMode: 'mid_conversation',
  meaningfulServiceBeforeFailure: true,
  failureStartMs: FAILURE_MS,
  agentFailureStartBlockNumber: 6,
  chargeableServiceEndMs: FAILURE_MS,
  categoryChargePolicyCode: 'AGENT_FAILURE_MID_CONVERSATION_PLUS_30S',
}
const PERSISTED_SIGNALS = { customerBlockNumbers: [2, 4, 6, 7] }

function facts(metrics: Record<string, unknown>, signals = PERSISTED_SIGNALS) {
  return persistedAgentFailureFacts({
    category: 'AGENT_FAILURE',
    metrics,
    signals,
    segments: SEGMENTS,
    recordedDurationMs: RECORDED_MS,
  })
}

test('persisted mid-conversation evidence is reconstructed, and tampering collapses to start', () => {
  assert.deepEqual(facts(PERSISTED_METRICS), {
    agentFailureMode: 'mid_conversation',
    meaningfulServiceBeforeFailure: true,
    failureStartMs: FAILURE_MS,
    agentFailureStartBlockNumber: 6,
  })
  const tampered: Array<[Record<string, unknown>, typeof PERSISTED_SIGNALS?]> = [
    [{}],
    [{ ...PERSISTED_METRICS, failureStartMs: 69_000 }],
    [{ ...PERSISTED_METRICS, chargeableServiceEndMs: 0 }],
    [{ ...PERSISTED_METRICS, categoryChargePolicyCode: 'MANAGEMENT_ZERO_CATEGORY' }],
    [{ ...PERSISTED_METRICS, meaningfulServiceBeforeFailure: 'true' }],
    [{ ...PERSISTED_METRICS, agentBlockNumbers: [] }],
    [{ ...PERSISTED_METRICS, agentFailureStartBlockNumber: 99 }],
    [PERSISTED_METRICS, { customerBlockNumbers: [6, 7] }],
  ]
  for (const [metrics, signals] of tampered) {
    assert.equal(facts(metrics, signals).agentFailureMode, 'start')
    assert.equal(facts(metrics, signals).failureStartMs, null)
  }
})

test('candidate collection carries the primary failure facts into consensus', async () => {
  const pool = {
    async execute(sql: string) {
      if (/FROM kaudit_transcript_segment/.test(sql)) {
        return [SEGMENTS.map((segment) => ({
          start_ms: segment.startMs,
          end_ms: segment.endMs,
          text: segment.text,
        })), []]
      }
      return [[{
        call_id: 'synthetic-call',
        call_reference: 'synthetic-task',
        audit_run_id: 'synthetic-run',
        artifact_id: 'synthetic-artifact',
        audio_sha256: 'a'.repeat(64),
        transcript_id: 'synthetic-transcript',
        language: 'english',
        category: 'AGENT_FAILURE',
        confidence: '0.95000000',
        conversation_end_ms: 100_000,
        recorded_duration_ms: String(RECORDED_MS),
        speech_duration_ms: '80000',
        connected_duration_ms: RECORDED_MS,
        claimed_duration_ms: RECORDED_MS,
        metrics_json: JSON.stringify(PERSISTED_METRICS),
        signal_values_json: JSON.stringify(PERSISTED_SIGNALS),
      }], []]
    },
  } as unknown as Pool
  const [collected] = await collectAutomatedValidationCandidates(pool, {
    start: '2026-06-01',
    end: '2026-06-30',
    limit: 1,
  })
  assert.equal(collected.primary.agentFailureMode, 'mid_conversation')
  assert.equal(collected.primary.failureStartMs, FAILURE_MS)
  const { outcome } = await run(collected.primary, raw())
  assert.equal(outcome.status, 'accepted')
  assert.equal(outcome.amount, '19.00000000')
})
