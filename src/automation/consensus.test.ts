import assert from 'node:assert/strict'
import test from 'node:test'
import {
  evaluateAutomatedConsensus,
} from './consensus.ts'
import type { ModelClassification } from '../reaudit/types.ts'

function result(
  overrides: Partial<ModelClassification> = {},
): ModelClassification {
  return {
    model: {
      provider: 'openai',
      name: 'synthetic-model',
      version: 'synthetic-model/1',
    },
    category: 'OK',
    confidence: '0.90000000',
    customerBlockNumbers: [2],
    unclearBlockNumbers: [],
    customerSpoke: true,
    lastMeaningfulCustomerExchangeMs: 40_000,
    remarks: 'synthetic',
    disputeRecommended: false,
    ...overrides,
  }
}

test('accepts independent agreement on category and rounded money basis', () => {
  const consensus = evaluateAutomatedConsensus({
    primary: result({ lastMeaningfulCustomerExchangeMs: 35_000 }),
    secondary: result({ lastMeaningfulCustomerExchangeMs: 40_000 }),
    recordedDurationMs: 100_000,
  })
  assert.equal(consensus.status, 'accepted')
  assert.equal(consensus.primaryBillableDurationMs, 120_000)
  assert.equal(consensus.secondaryBillableDurationMs, 120_000)
  assert.deepEqual(consensus.reasons, [])
})

test('keeps category, billable-duration, and low-confidence conflicts unresolved', () => {
  const consensus = evaluateAutomatedConsensus({
    primary: result(),
    secondary: result({
      category: 'USER_SILENCE',
      confidence: '0.79000000',
      customerSpoke: false,
      lastMeaningfulCustomerExchangeMs: null,
    }),
    recordedDurationMs: 100_000,
  })
  assert.equal(consensus.status, 'unresolved')
  assert.deepEqual(consensus.reasons, [
    'CATEGORY_DISAGREEMENT',
    'CUSTOMER_SPEECH_DISAGREEMENT',
    'BILLABLE_DURATION_DISAGREEMENT',
  ])
})

test('a third independent pass resolves a two-pass category disagreement by majority', () => {
  const consensus = evaluateAutomatedConsensus({
    primary: result({ category: 'USER_SILENCE' }),
    secondary: result({ category: 'INACTIVE_CALL' }),
    adjudicator: result({ category: 'USER_SILENCE' }),
    recordedDurationMs: 100_000,
  })
  assert.equal(consensus.status, 'accepted')
  assert.equal(consensus.selectedSource, 'primary')
  assert.equal(
    consensus.selectedClassification?.category,
    'USER_SILENCE',
  )
})

test('user-silence agreement charges through the final agent exchange', () => {
  const consensus = evaluateAutomatedConsensus({
    primary: result({
      category: 'USER_SILENCE',
      customerSpoke: false,
      lastMeaningfulCustomerExchangeMs: null,
      lastMeaningfulAgentExchangeMs: 20_000,
    }),
    secondary: result({
      category: 'USER_SILENCE',
      customerSpoke: false,
      lastMeaningfulCustomerExchangeMs: null,
      lastMeaningfulAgentExchangeMs: 20_000,
    }),
    recordedDurationMs: 100_000,
  })
  assert.equal(consensus.status, 'accepted')
  assert.equal(consensus.primaryBillableDurationMs, 120_000)
  assert.equal(consensus.secondaryBillableDurationMs, 120_000)
  assert.equal(
    consensus.selectedChargeDecision?.policyCode,
    'USER_SILENCE_AGENT_PLUS_GRACE',
  )
})

test('management-zero categories remain zero even when customer speech exists', () => {
  const consensus = evaluateAutomatedConsensus({
    primary: result({ category: 'AGENT_FAILURE' }),
    secondary: result({ category: 'AGENT_FAILURE' }),
    recordedDurationMs: 100_000,
  })
  assert.equal(consensus.status, 'accepted')
  assert.equal(consensus.primaryBillableDurationMs, 0)
  assert.equal(consensus.secondaryBillableDurationMs, 0)
  assert.equal(
    consensus.selectedChargeDecision?.policyCode,
    'MANAGEMENT_ZERO_CATEGORY',
  )
})
