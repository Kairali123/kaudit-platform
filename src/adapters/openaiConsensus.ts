import OpenAI from 'openai'
import {
  canonicalJsonSha256,
  type JsonValue,
} from '../messaging/canonicalJson.ts'
import type {
  ModelClassification,
  NaturalSpeechBlock,
} from '../reaudit/types.ts'
import { REAUDIT_CATEGORIES } from '../reaudit/types.ts'
import {
  parseClassifierOutput,
  REAUDIT_CLASSIFICATION_MODEL,
  REAUDIT_CLASSIFIER_OUTPUT_SCHEMA,
  REAUDIT_DECISION_SIGNAL_RULES,
  REAUDIT_KAIRALI_REFERENCE_RULES,
  REAUDIT_SPEAKER_ATTRIBUTION_RULES,
} from './openaiReaudit.ts'

export const CONSENSUS_REVIEWER_VERSION =
  'kairali-independent-consensus-review/1.8.0'

export const CONSENSUS_REVIEWER_PROMPT = `You are an independent automated
verification pass for Kairali's call-audit system. Review the timestamped,
numbered transcript without seeing another model's answer.

Identify the blocks where a real customer meaningfully responded and exactly
one category from:
${REAUDIT_CATEGORIES.join(', ')}.

Saanvi is Kairali's female AI agent. Do not count Saanvi's later monologue as a
customer exchange. Do not calculate money or add the deterministic 60-second
goodbye grace. Return confidence from 0 to 1. If speaker identity or meaning is
ambiguous, lower confidence and mark unclear blocks.

${REAUDIT_SPEAKER_ATTRIBUTION_RULES}

${REAUDIT_KAIRALI_REFERENCE_RULES}

${REAUDIT_DECISION_SIGNAL_RULES}`

export const CONSENSUS_REVIEWER_RULESET_SHA256 =
  canonicalJsonSha256({
    schemaVersion: '1',
    model: REAUDIT_CLASSIFICATION_MODEL,
    prompt: CONSENSUS_REVIEWER_PROMPT,
    categories: REAUDIT_CATEGORIES,
    outputSchemaVersion: '9',
  } as unknown as JsonValue)

// The primary classifier's own schema: every field the pricing engine needs
// (agent blocks for USER_SILENCE, the AGENT_FAILURE boundary, ...) is present
// for the reviewer too. A private copy drifted and priced those at zero.
export const CONSENSUS_REVIEWER_OUTPUT_SCHEMA = {
  ...REAUDIT_CLASSIFIER_OUTPUT_SCHEMA,
  name: 'kairali_consensus_review',
} as const

export type ConsensusReasoningEffort = 'none' | 'low' | 'medium'

/**
 * Auto consensus v2 runs the second opinion with light reasoning and the
 * tie-breaker with deeper reasoning, so the three passes are not copies of
 * one another. The effort is part of the recorded model version.
 */
export function createOpenAiConsensusReviewer(
  apiKey: string,
  options: { reasoningEffort?: ConsensusReasoningEffort } = {},
): {
  classify(options: {
    blocks: NaturalSpeechBlock[]
    language: string
    recordedDurationMs: number
    speechDurationMs: number
    connectedDurationMs: number | null
    durationMismatch: boolean
  }): Promise<ModelClassification>
} {
  if (!apiKey.trim()) throw new Error('OPENAI_API_KEY is required')
  const reasoningEffort = options.reasoningEffort ?? 'none'
  const modelVersion = reasoningEffort === 'none'
    ? REAUDIT_CLASSIFICATION_MODEL
    : `${REAUDIT_CLASSIFICATION_MODEL}+reasoning-${reasoningEffort}`
  const client = new OpenAI({
    apiKey,
    maxRetries: 3,
    timeout: 120_000,
  })
  return {
    async classify(options) {
      const transcript = options.blocks
        .map(
          (block) =>
            `#${block.number} [${(block.startMs / 1000).toFixed(1)}-${(
              block.endMs / 1000
            ).toFixed(1)}] ${block.text}`,
        )
        .join('\n')
        .slice(0, 60_000)
      const completion = await client.chat.completions.create({
        model: REAUDIT_CLASSIFICATION_MODEL,
        reasoning_effort: reasoningEffort,
        // Sampling temperature is accepted only without reasoning.
        ...(reasoningEffort === 'none' ? { temperature: 0 } : {}),
        response_format: {
          type: 'json_schema',
          json_schema: CONSENSUS_REVIEWER_OUTPUT_SCHEMA,
        },
        messages: [
          { role: 'system', content: CONSENSUS_REVIEWER_PROMPT },
          {
            role: 'user',
            content: `CALL FACTS
Detected language: ${options.language}
Vendor connected duration: ${
              options.connectedDurationMs == null
                ? 'unknown'
                : `${options.connectedDurationMs} ms`
            }
Decoded recording duration: ${options.recordedDurationMs} ms
Detected speech: ${options.speechDurationMs} ms
Duration mismatch beyond 5 seconds: ${options.durationMismatch}

NUMBERED TRANSCRIPT
${transcript}`,
          },
        ],
      })
      const message = completion.choices[0]?.message
      if (!message || message.refusal) {
        throw new Error(
          message?.refusal || 'Automated consensus review was empty',
        )
      }
      return {
        ...parseClassifierOutput(message.content || '{}', options.blocks, {
          provider: 'openai',
          name: REAUDIT_CLASSIFICATION_MODEL,
          version: modelVersion,
        }),
        usage: {
          inputTokens: completion.usage?.prompt_tokens ?? null,
          outputTokens: completion.usage?.completion_tokens ?? null,
          totalTokens: completion.usage?.total_tokens ?? null,
          audioSeconds: null,
          requestId:
            typeof (completion as unknown as { _request_id?: unknown })
              ._request_id === 'string'
              ? (completion as unknown as { _request_id: string })
                  ._request_id
              : null,
        },
      }
    },
  }
}
