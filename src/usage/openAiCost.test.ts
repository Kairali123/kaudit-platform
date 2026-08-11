import assert from 'node:assert/strict'
import test from 'node:test'
import { calculateOpenAiAuditCost } from './openAiCost.ts'

test('prices GPT-4o-mini tokens and Whisper seconds exactly', () => {
  const result = calculateOpenAiAuditCost([
    {
      modelName: 'gpt-4o-mini-2024-07-18',
      inputTokens: 747,
      outputTokens: 69,
      audioSeconds: '0',
    },
    {
      modelName: 'whisper-1',
      inputTokens: 0,
      outputTokens: 0,
      audioSeconds: '29.000',
    },
  ])
  assert.equal(result.estimatedUsd, '0.00305345')
  assert.equal(result.pricedRows, 2)
  assert.equal(result.unpricedRows, 0)
})

test('does not silently price an unknown model', () => {
  const result = calculateOpenAiAuditCost([
    {
      modelName: 'future-model',
      inputTokens: 100,
      outputTokens: 50,
      audioSeconds: '0',
    },
  ])
  assert.equal(result.estimatedUsd, '0')
  assert.equal(result.unpricedRows, 1)
})
