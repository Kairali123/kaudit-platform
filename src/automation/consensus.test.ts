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

test('two passes with different categories stay unresolved until a tie-breaker votes', () => {
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
  assert.deepEqual(consensus.reasons, ['CATEGORY_DISAGREEMENT'])
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

test('user-silence agreement charges through the introduction plus grace', () => {
  const consensus = evaluateAutomatedConsensus({
    primary: result({
      category: 'USER_SILENCE',
      customerSpoke: false,
      lastMeaningfulCustomerExchangeMs: null,
      lastMeaningfulAgentExchangeMs: 20_000,
      firstAgentTurnEndMs: 20_000,
    }),
    secondary: result({
      category: 'USER_SILENCE',
      customerSpoke: false,
      lastMeaningfulCustomerExchangeMs: null,
      lastMeaningfulAgentExchangeMs: 20_000,
      firstAgentTurnEndMs: 20_000,
    }),
    recordedDurationMs: 100_000,
  })
  assert.equal(consensus.status, 'accepted')
  assert.equal(consensus.primaryBillableDurationMs, 120_000)
  assert.equal(consensus.secondaryBillableDurationMs, 120_000)
  assert.equal(
    consensus.selectedChargeDecision?.policyCode,
    'USER_SILENCE_INTRO_PLUS_GRACE',
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

// ---- v2: category majority, then the duration most agreeing passes share ----

const silence = (agentEndMs: number, confidence = '0.90000000') => result({
  category: 'USER_SILENCE',
  confidence,
  customerSpoke: false,
  lastMeaningfulCustomerExchangeMs: null,
  lastMeaningfulAgentExchangeMs: agentEndMs,
  firstAgentTurnEndMs: agentEndMs,
})

test('same category, different money: unresolved until the tie-breaker is asked', () => {
  const consensus = evaluateAutomatedConsensus({
    primary: silence(20_000),
    secondary: silence(90_000),
    recordedDurationMs: 200_000,
  })
  assert.equal(consensus.status, 'unresolved')
  assert.deepEqual(consensus.reasons, ['BILLABLE_DURATION_DISAGREEMENT'])
})

test('the duration two agreeing passes share wins over a lone outlier', () => {
  const consensus = evaluateAutomatedConsensus({
    primary: silence(90_000),
    secondary: silence(20_000),
    adjudicator: silence(90_000),
    recordedDurationMs: 200_000,
  })
  assert.equal(consensus.status, 'accepted')
  assert.equal(consensus.selectedSource, 'primary')
  assert.equal(consensus.primaryBillableDurationMs, 180_000)
})

test('with no shared duration the shortest agreeing duration is used', () => {
  const consensus = evaluateAutomatedConsensus({
    primary: silence(90_000),
    secondary: silence(20_000),
    adjudicator: silence(150_000),
    recordedDurationMs: 300_000,
  })
  assert.equal(consensus.status, 'accepted')
  assert.equal(consensus.selectedSource, 'secondary')
})

test('the two most confident agreeing passes must clear the 0.65 floor', () => {
  const accepted = evaluateAutomatedConsensus({
    primary: silence(20_000, '0.70000000'),
    secondary: silence(20_000, '0.66000000'),
    recordedDurationMs: 100_000,
  })
  assert.equal(accepted.status, 'accepted')
  assert.equal(accepted.threshold, '0.65000000')
  const low = evaluateAutomatedConsensus({
    primary: silence(20_000, '0.70000000'),
    secondary: silence(20_000, '0.64000000'),
    recordedDurationMs: 100_000,
  })
  assert.deepEqual(low.reasons, ['WINNING_CONSENSUS_CONFIDENCE_BELOW_FLOOR'])
})
