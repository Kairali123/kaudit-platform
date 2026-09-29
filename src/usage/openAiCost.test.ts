import assert from 'node:assert/strict'
import test from 'node:test'
import { calculateAiAuditCost } from './openAiCost.ts'

test('prices GPT-6 Luna tokens and Whisper seconds exactly', () => {
  const result = calculateAiAuditCost([
    {
      providerName: 'openai',
      modelName: 'gpt-6-luna',
      inputTokens: 747,
      outputTokens: 69,
      audioSeconds: '0',
    },
    {
      providerName: 'openai',
      modelName: 'whisper-1',
      inputTokens: 0,
      outputTokens: 0,
      audioSeconds: '29.000',
    },
  ])
  assert.equal(result.estimatedUsd, '0.0030092')
  assert.equal(result.pricedRows, 2)
  assert.equal(result.unpricedRows, 0)
})

test('prices ElevenLabs Scribe v2 seconds exactly', () => {
  const result = calculateAiAuditCost([{
    providerName: 'elevenlabs',
    modelName: 'scribe_v2',
    inputTokens: 0,
    outputTokens: 0,
    audioSeconds: '3600.000',
  }])
  assert.equal(result.estimatedUsd, '0.22')
  assert.equal(result.pricedRows, 1)
  assert.equal(result.unpricedRows, 0)
})

test('does not silently price an unknown model', () => {
  const result = calculateAiAuditCost([
    {
      providerName: 'unknown',
      modelName: 'future-model',
      inputTokens: 100,
      outputTokens: 50,
      audioSeconds: '0',
    },
  ])
  assert.equal(result.estimatedUsd, '0')
  assert.equal(result.unpricedRows, 1)
})
