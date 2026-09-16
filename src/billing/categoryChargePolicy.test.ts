import assert from 'node:assert/strict'
import test from 'node:test'
import {
  AGENT_FAILURE_MID_CONVERSATION_GRACE_MS,
  resolveCategoryCharge,
  VOICEMAIL_GRACE_MS,
  type CategoryChargeEvidence,
} from './categoryChargePolicy.ts'
import type { ReauditCategory } from '../reaudit/types.ts'

function charge(category: ReauditCategory, overrides: Record<string, number | null> = {}) {
  return resolveCategoryCharge({
    category,
    recordedDurationMs: 180_000,
    lastCustomerExchangeMs: 40_000,
    lastAgentExchangeMs: 50_000,
    lastVoicemailExchangeMs: 45_000,
    lastBusinessRelevantCustomerExchangeMs: 35_000,
    lastVerifiedInteractionMs: 50_000,
    ...overrides,
  })
}

test('management zero categories never produce a chargeable duration', () => {
  for (const category of [
    'INACTIVE_CALL',
    'AGENT_FAILURE',
    'AI_CONVERSATION_HANDLING',
    'NETWORK_FAILURE_TELECOM',
  ] as const) {
    assert.equal(charge(category).adjustedChargeableDurationMs, 0)
  }
})

test('user silence uses the final agent exchange plus standard grace', () => {
  const result = charge('USER_SILENCE')
  assert.equal(result.serviceEndMs, 50_000)
  assert.equal(result.adjustedChargeableDurationMs, 110_000)
})

test('voicemail uses the final service exchange plus its shorter grace', () => {
  const result = charge('VOICEMAIL')
  assert.equal(result.graceMs, VOICEMAIL_GRACE_MS)
  assert.equal(result.adjustedChargeableDurationMs, 80_000)
})

test('AI-to-AI receives grace only, capped by the recording', () => {
  assert.equal(charge('AI_TO_AI').adjustedChargeableDurationMs, 60_000)
  assert.equal(
    charge('AI_TO_AI', { recordedDurationMs: 25_000 }).adjustedChargeableDurationMs,
    25_000,
  )
})

test('ordinary human categories use the final customer exchange plus grace', () => {
  for (const category of [
    'OK',
    'CONNECT_NOT_FRUITFUL',
    'TIME_DURATION',
  ] as const) {
    assert.equal(charge(category).adjustedChargeableDurationMs, 100_000)
  }
})

test('junk calls require a verified business-relevant customer exchange', () => {
  assert.equal(charge('JUNK_CALL').adjustedChargeableDurationMs, 95_000)
  assert.equal(
    charge('JUNK_CALL', {
      lastBusinessRelevantCustomerExchangeMs: null,
    }).adjustedChargeableDurationMs,
    0,
  )
})

test('incorrect duration uses the last independently verified interaction', () => {
  assert.equal(
    charge('INCORRECT_CALL_DURATION').adjustedChargeableDurationMs,
    110_000,
  )
})

// ---------------------------------------------------------------------------
// AGENT_FAILURE: zero everywhere except one exactly-specified shape.
// Every fixture below is synthetic.
// ---------------------------------------------------------------------------

function agentFailure(
  overrides: Partial<CategoryChargeEvidence> = {},
): ReturnType<typeof resolveCategoryCharge> {
  return resolveCategoryCharge({
    category: 'AGENT_FAILURE',
    recordedDurationMs: 180_000,
    lastCustomerExchangeMs: 40_000,
    lastAgentExchangeMs: 50_000,
    lastVoicemailExchangeMs: null,
    lastBusinessRelevantCustomerExchangeMs: null,
    lastVerifiedInteractionMs: 50_000,
    agentFailureMode: 'mid_conversation',
    meaningfulServiceBeforeFailure: true,
    failureStartMs: 60_000,
    ...overrides,
  })
}

test('a mid-conversation agent failure charges the served period plus 30s', () => {
  const result = agentFailure()
  assert.equal(result.policyCode, 'AGENT_FAILURE_MID_CONVERSATION_PLUS_30S')
  assert.equal(result.serviceEndMs, 60_000)
  assert.equal(result.graceMs, AGENT_FAILURE_MID_CONVERSATION_GRACE_MS)
  assert.equal(result.graceMs, 30_000)
  assert.equal(result.adjustedChargeableDurationMs, 90_000)
})

test('a failure from the start is zero seconds and zero money', () => {
  for (const overrides of [
    { agentFailureMode: 'start' as const },
    { agentFailureMode: null },
    {},
  ]) {
    const result = resolveCategoryCharge({
      category: 'AGENT_FAILURE',
      recordedDurationMs: 180_000,
      lastCustomerExchangeMs: 40_000,
      lastAgentExchangeMs: 50_000,
      lastVoicemailExchangeMs: null,
      lastBusinessRelevantCustomerExchangeMs: null,
      lastVerifiedInteractionMs: 50_000,
      ...overrides,
    })
    assert.equal(result.policyCode, 'MANAGEMENT_ZERO_CATEGORY')
    assert.equal(result.graceMs, 0)
    assert.equal(result.adjustedChargeableDurationMs, 0)
  }
})

test('a mid-conversation claim without meaningful service fails closed to zero', () => {
  const result = agentFailure({ meaningfulServiceBeforeFailure: false })
  assert.equal(result.policyCode, 'MANAGEMENT_ZERO_CATEGORY')
  assert.equal(result.adjustedChargeableDurationMs, 0)
})

test('a missing, zero, or out-of-range boundary fails closed to zero', () => {
  for (const failureStartMs of [null, 0, -1, 180_001, 1.5]) {
    const result = agentFailure({ failureStartMs })
    assert.equal(result.policyCode, 'MANAGEMENT_ZERO_CATEGORY')
    assert.equal(result.adjustedChargeableDurationMs, 0)
  }
})

test('the mid-conversation charge is still capped by the recording', () => {
  const result = agentFailure({
    recordedDurationMs: 70_000,
    failureStartMs: 60_000,
  })
  assert.equal(result.adjustedChargeableDurationMs, 70_000)
})

test('no second grace is ever added after the failure boundary', () => {
  // The served period through the boundary plus exactly one 30s grace, never
  // the last agent exchange, the last customer exchange, or both.
  const result = agentFailure({
    lastAgentExchangeMs: 170_000,
    lastCustomerExchangeMs: 165_000,
  })
  assert.equal(result.adjustedChargeableDurationMs, 90_000)
})
