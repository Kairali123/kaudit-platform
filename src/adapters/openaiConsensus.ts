import OpenAI from 'openai'
import {
  canonicalJsonSha256,
  type JsonValue,
} from '../messaging/canonicalJson.ts'
import type {
  ModelClassification,
  NaturalSpeechBlock,
  ReauditCategory,
} from '../reaudit/types.ts'
import { REAUDIT_CATEGORIES } from '../reaudit/types.ts'
import {
  REAUDIT_CLASSIFICATION_MODEL,
  REAUDIT_SPEAKER_ATTRIBUTION_RULES,
} from './openaiReaudit.ts'

export const CONSENSUS_REVIEWER_VERSION =
  'kairali-independent-consensus-review/1.0.0'

export const CONSENSUS_REVIEWER_PROMPT = `You are an independent automated
verification pass for Kairali's call-audit system. Review the timestamped,
numbered transcript without seeing another model's answer.

Identify whether a real customer meaningfully responded, the end timestamp of
the final meaningful customer exchange, and exactly one category from:
${REAUDIT_CATEGORIES.join(', ')}.

Saanvi is Kairali's female AI agent. Do not count Saanvi's later monologue as a
customer exchange. Do not calculate money or add the deterministic 60-second
goodbye grace. Return confidence from 0 to 1. If speaker identity or meaning is
ambiguous, lower confidence and mark unclear blocks.

${REAUDIT_SPEAKER_ATTRIBUTION_RULES}`

export const CONSENSUS_REVIEWER_RULESET_SHA256 =
  canonicalJsonSha256({
    schemaVersion: '1',
    model: REAUDIT_CLASSIFICATION_MODEL,
    prompt: CONSENSUS_REVIEWER_PROMPT,
    categories: REAUDIT_CATEGORIES,
    outputSchemaVersion: '1',
  } as unknown as JsonValue)

const schema = {
  name: 'kairali_consensus_review',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      category: { type: 'string', enum: REAUDIT_CATEGORIES },
      confidence: { type: 'number', minimum: 0, maximum: 1 },
      customer_block_numbers: {
        type: 'array',
        items: { type: 'integer', minimum: 1 },
      },
      unclear_block_numbers: {
        type: 'array',
        items: { type: 'integer', minimum: 1 },
      },
      customer_spoke: { type: 'boolean' },
      last_meaningful_customer_exchange_sec: {
        anyOf: [{ type: 'number', minimum: 0 }, { type: 'null' }],
      },
      remarks: { type: 'string', maxLength: 1200 },
      dispute_recommended: { type: 'boolean' },
    },
    required: [
      'category',
      'confidence',
      'customer_block_numbers',
      'unclear_block_numbers',
      'customer_spoke',
      'last_meaningful_customer_exchange_sec',
      'remarks',
      'dispute_recommended',
    ],
  },
} as const

export function createOpenAiConsensusReviewer(apiKey: string): {
  classify(options: {
    blocks: NaturalSpeechBlock[]
    language: string
    recordedDurationMs: number
    speechDurationMs: number
    connectedDurationMs: number | null
  }): Promise<ModelClassification>
} {
  if (!apiKey.trim()) throw new Error('OPENAI_API_KEY is required')
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
        temperature: 0,
        response_format: {
          type: 'json_schema',
          json_schema: schema,
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
      const raw = JSON.parse(message.content || '{}') as {
        category: ReauditCategory
        confidence: number
        customer_block_numbers: number[]
        unclear_block_numbers: number[]
        customer_spoke: boolean
        last_meaningful_customer_exchange_sec: number | null
        remarks: string
        dispute_recommended: boolean
      }
      return {
        model: {
          provider: 'openai',
          name: REAUDIT_CLASSIFICATION_MODEL,
          version: REAUDIT_CLASSIFICATION_MODEL,
        },
        category: raw.category,
        confidence: Number(raw.confidence).toFixed(8),
        customerBlockNumbers: raw.customer_block_numbers,
        unclearBlockNumbers: raw.unclear_block_numbers,
        customerSpoke: raw.customer_spoke,
        lastMeaningfulCustomerExchangeMs:
          raw.last_meaningful_customer_exchange_sec == null
            ? null
            : Math.round(
                raw.last_meaningful_customer_exchange_sec * 1000,
              ),
        remarks: raw.remarks,
        disputeRecommended: raw.dispute_recommended,
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
