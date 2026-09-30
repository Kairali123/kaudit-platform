import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  CONSENSUS_REVIEWER_OUTPUT_SCHEMA,
  createOpenAiConsensusReviewer,
} from './openaiConsensus.ts'
import { REAUDIT_KAIRALI_REFERENCE_RULES } from './openaiReaudit.ts'

/**
 * The v2 reviewer request shape, captured from a stubbed fetch. No network,
 * no real key, synthetic transcript.
 */
async function captureRequest(
  reasoningEffort?: 'none' | 'low' | 'medium',
  overrides: Record<string, unknown> = {},
) {
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
        agent_failure_mode: 'none', agent_failure_start_block_number: 0,
        remarks: 'synthetic', dispute_recommended: false,
        ...overrides,
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

test('the reviewer reports the AGENT_FAILURE boundary like the primary', async () => {
  const required = CONSENSUS_REVIEWER_OUTPUT_SCHEMA.schema.required as readonly string[]
  assert.ok(required.includes('agent_failure_mode'))
  assert.ok(required.includes('agent_failure_start_block_number'))
  const { result } = await captureRequest('low', {
    category: 'AGENT_FAILURE',
    agent_failure_mode: 'mid_conversation',
    agent_failure_start_block_number: 6,
  })
  assert.equal(result.decisionSignals?.agentFailureMode, 'mid_conversation')
  assert.equal(result.agentFailureStartBlockNumber, 6)
  const none = await captureRequest('low')
  assert.equal(none.result.agentFailureStartBlockNumber, null)
})

test('an answered introduction before the failure is a mid-conversation failure', () => {
  assert.match(REAUDIT_KAIRALI_REFERENCE_RULES, /language choice\s+counts/)
  assert.doesNotMatch(REAUDIT_KAIRALI_REFERENCE_RULES, /mid_conversation ONLY when a genuine two-way/)
})
