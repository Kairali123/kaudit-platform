import OpenAI, { toFile } from 'openai'
import {
  canonicalJsonSha256,
  type JsonValue,
} from '../messaging/canonicalJson.ts'
import type {
  ModelClassification,
  ReauditAi,
  ReauditCategory,
} from '../reaudit/types.ts'
import { REAUDIT_CATEGORIES } from '../reaudit/types.ts'

export const REAUDIT_TRANSCRIPTION_MODEL = 'whisper-1'
export const REAUDIT_CLASSIFICATION_MODEL = 'gpt-4o-mini-2024-07-18'

const CATEGORY_RULEBOOK: Record<ReauditCategory, string> = {
  TIME_DURATION:
    'Call duration is inappropriate for the conversation outcome: it ends too early or continues without customer value.',
  AGENT_FAILURE:
    'The AI misunderstands, stops, repeats, gives incorrect information, misses required questions, or calls after a do-not-call request.',
  CONNECT_NOT_FRUITFUL:
    'A person answered but there was no meaningful outcome: busy, not interested, callback request, early hang-up, or badly handled language mismatch.',
  INACTIVE_CALL:
    'There is little or no meaningful interaction after connection, including long silence or background noise.',
  INCORRECT_CALL_DURATION:
    'Vendor-reported duration materially differs from independently decoded recording duration.',
  AI_CONVERSATION_HANDLING:
    'The system runs but interrupts, ignores answers, duplicates questions, changes topics abruptly, or sounds unnaturally handled.',
  VOICEMAIL: 'The call reached voicemail or an answering machine.',
  AI_TO_AI:
    'The Kairali agent spoke to an IVR, screening assistant, or other automated system without a human joining.',
  NETWORK_FAILURE_TELECOM:
    'Telecom/network audio problems caused distortion, one-way audio, or a dropped conversation.',
  USER_SILENCE:
    'A person picked up but never responded while the AI agent spoke.',
  JUNK_CALL:
    'Wrong number, test call, spam pickup machine, or no legitimate customer interaction.',
  OK: 'Normal, legitimate and properly handled two-way customer conversation.',
}

export const REAUDIT_CLASSIFIER_PROMPT = `You are the automated call-quality auditor for Kairali Group.
The female Kairali AI agent is named Saanvi. Calls may be English, Hindi, Hinglish,
Malayalam, or another detected language.

Input is a numbered, timestamped transcript with no speaker labels. Identify customer
blocks from conversational cues. The final meaningful customer exchange is the END
timestamp of the last meaningful customer response. Saanvi's natural closing words are
handled later by a deterministic 60-second billing grace rule; do not extend the customer
timestamp yourself. If the customer never meaningfully spoke, return null.

Choose exactly one category:
${Object.entries(CATEGORY_RULEBOOK)
  .map(([code, rule]) => `${code}: ${rule}`)
  .join('\n')}

The model does not calculate money, rates, rounding, or a final bill. Return a numeric
confidence from 0 to 1 reflecting uncertainty in speaker attribution, category, and
conversation-end detection. A billing dispute recommendation is only a signal; the
deterministic engine decides chargeable duration.`

export const REAUDIT_CLASSIFIER_RULESET_SHA256 = canonicalJsonSha256({
  schemaVersion: '1',
  model: REAUDIT_CLASSIFICATION_MODEL,
  prompt: REAUDIT_CLASSIFIER_PROMPT,
  categories: REAUDIT_CATEGORIES,
  outputSchemaVersion: '1',
} as unknown as JsonValue)

const outputSchema = {
  name: 'kairali_call_audit',
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

function fixedConfidence(value: number): string {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error('OpenAI returned an invalid confidence')
  }
  return value.toFixed(8)
}

export function createOpenAiReaudit(apiKey: string): ReauditAi {
  if (!apiKey.trim()) throw new Error('OPENAI_API_KEY is required')
  const client = new OpenAI({
    apiKey,
    maxRetries: 3,
    timeout: 120_000,
  })
  return {
    async transcribe(bytes, options) {
      const extension = options.contentType.includes('mpeg')
        ? 'mp3'
        : options.contentType.includes('wav')
          ? 'wav'
          : 'ogg'
      const response = await client.audio.transcriptions.create({
        file: await toFile(bytes, `call.${extension}`, {
          type: options.contentType,
        }),
        model: REAUDIT_TRANSCRIPTION_MODEL,
        response_format: 'verbose_json',
        timestamp_granularities: ['segment'],
      })
      const raw = response as unknown as {
        duration?: number
        language?: string
        text?: string
        segments?: Array<{ start?: number; end?: number; text?: string }>
        usage?: {
          type?: string
          seconds?: number
        }
      }
      const segments = (raw.segments || []).map((segment) => ({
        startMs: Math.max(0, Math.round(Number(segment.start || 0) * 1000)),
        endMs: Math.max(0, Math.round(Number(segment.end || 0) * 1000)),
        text: String(segment.text || ''),
      }))
      const durationMs = Math.max(
        0,
        Math.round(Number(raw.duration || 0) * 1000),
      )
      return {
        model: {
          provider: 'openai',
          name: 'whisper-1',
          version: 'whisper-1',
        },
        language: String(raw.language || 'unknown').toLowerCase(),
        durationMs,
        speechMs: segments.reduce(
          (sum, segment) =>
            sum + Math.max(0, segment.endMs - segment.startMs),
          0,
        ),
        text: String(raw.text || ''),
        segments,
        usage: {
          inputTokens: null,
          outputTokens: null,
          totalTokens: null,
          audioSeconds:
            raw.usage?.type === 'duration' &&
            Number.isFinite(raw.usage.seconds)
              ? Number(raw.usage.seconds)
              : Number(raw.duration || 0),
          requestId:
            typeof (response as unknown as { _request_id?: unknown })
              ._request_id === 'string'
              ? (response as unknown as { _request_id: string })
                  ._request_id
              : null,
        },
      }
    },
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
          json_schema: outputSchema,
        },
        messages: [
          { role: 'system', content: REAUDIT_CLASSIFIER_PROMPT },
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
Total detected speech: ${options.speechDurationMs} ms
Duration mismatch beyond 5 seconds: ${options.durationMismatch}

NUMBERED TRANSCRIPT
${transcript}`,
          },
        ],
      })
      const message = completion.choices[0]?.message
      if (!message || message.refusal) {
        throw new Error(message?.refusal || 'OpenAI classification was empty')
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
        confidence: fixedConfidence(raw.confidence),
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
