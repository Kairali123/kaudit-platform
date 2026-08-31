import assert from 'node:assert/strict'
import test from 'node:test'
import {
  resolveCategoryCharge,
  VOICEMAIL_GRACE_MS,
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
