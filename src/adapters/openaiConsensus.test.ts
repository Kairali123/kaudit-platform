import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createOpenAiConsensusReviewer } from './openaiConsensus.ts'

/**
 * The v2 reviewer request shape, captured from a stubbed fetch. No network,
 * no real key, synthetic transcript.
 */
async function captureRequest(reasoningEffort?: 'none' | 'low' | 'medium') {
  const bodies: Record<string, unknown>[] = []
  const original = globalThis.fetch
  globalThis.fetch = (async (_url: unknown, init?: { body?: unknown }) => {
    bodies.push(JSON.parse(String(init?.body)))
    return new Response(JSON.stringify({
      id: 'synthetic', object: 'chat.completion', created: 0, model: 'gpt-6-luna',
      choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify({
        category: 'USER_SILENCE', confidence: 0.9,
        customer_block_numbers: [], unclear_block_numbers: [],
        voicemail_evidence_block_numbers: [], automation_evidence_block_numbers: [],
        junk_evidence_block_numbers: [], business_relevant_customer_block_numbers: [],
        counterparty_type: 'no_response', agent_handling: 'normal',
        conversation_outcome: 'no_outcome', duration_outcome: 'appropriate',
        stop_intent: 'none', post_stop_behavior: 'not_applicable',
        successful_outcome: 'none', voicemail_evidence: 'none',
        automation_evidence: 'none', junk_evidence: 'none',
        remarks: 'synthetic', dispute_recommended: false,
      }) } }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  try {
    const reviewer = createOpenAiConsensusReviewer(
      'sk-synthetic',
      reasoningEffort ? { reasoningEffort } : {},
    )
    const result = await reviewer.classify({
      blocks: [{ number: 1, startMs: 0, endMs: 2_000, text: 'Namaste, this is Saanvi.' }] as never,
      language: 'english',
      recordedDurationMs: 10_000,
      speechDurationMs: 2_000,
      connectedDurationMs: 10_000,
      durationMismatch: false,
    })
    return { body: bodies[0]!, result }
  } finally {
    globalThis.fetch = original
  }
}

test('without reasoning the reviewer stays deterministic at temperature 0', async () => {
  const { body, result } = await captureRequest()
  assert.equal(body.reasoning_effort, 'none')
  assert.equal(body.temperature, 0)
  assert.equal(result.model.version, 'gpt-6-luna')
})

test('with reasoning, temperature is omitted and the effort is recorded', async () => {
  const { body, result } = await captureRequest('medium')
  assert.equal(body.reasoning_effort, 'medium')
  assert.equal('temperature' in body, false)
  assert.equal(result.model.version, 'gpt-6-luna+reasoning-medium')
})
