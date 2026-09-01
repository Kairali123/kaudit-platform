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
  REAUDIT_DECISION_SIGNAL_RULES,
  REAUDIT_KAIRALI_REFERENCE_RULES,
  REAUDIT_SPEAKER_ATTRIBUTION_RULES,
} from './openaiReaudit.ts'

export const CONSENSUS_REVIEWER_VERSION =
  'kairali-independent-consensus-review/1.7.0'

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
    outputSchemaVersion: '7',
  } as unknown as JsonValue)

export const CONSENSUS_REVIEWER_OUTPUT_SCHEMA = {
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
      voicemail_evidence_block_numbers: {
        type: 'array',
        items: { type: 'integer', minimum: 1 },
      },
      automation_evidence_block_numbers: {
        type: 'array',
        items: { type: 'integer', minimum: 1 },
      },
      junk_evidence_block_numbers: {
        type: 'array',
        items: { type: 'integer', minimum: 1 },
      },
      business_relevant_customer_block_numbers: {
        type: 'array',
        items: { type: 'integer', minimum: 1 },
      },
      counterparty_type: {
        type: 'string',
        enum: [
          'human',
          'voicemail',
          'interactive_automation',
          'no_response',
          'unclear',
        ],
      },
      agent_handling: {
        type: 'string',
        enum: ['normal', 'failed', 'unclear'],
      },
      conversation_outcome: {
        type: 'string',
        enum: ['successful', 'no_outcome', 'unclear'],
      },
      duration_outcome: {
        type: 'string',
        enum: [
          'appropriate',
          'ended_too_early',
          'continued_without_value',
          'unclear',
        ],
      },
      stop_intent: {
        type: 'string',
        enum: ['none', 'busy_or_bad_time', 'callback_or_defer', 'decline_or_end'],
      },
      post_stop_behavior: {
        type: 'string',
        enum: [
          'not_applicable',
          'appropriate_close',
          'administrative_extension',
          'continued_sales_flow',
          'unclear',
        ],
      },
      successful_outcome: {
        type: 'string',
        enum: ['none', 'qualified', 'handoff_or_transfer', 'resolved'],
      },
      voicemail_evidence: {
        type: 'string',
        enum: [
          'fixed_greeting',
          'leave_message_request',
          'mailbox_notice',
          'recording_notice',
          'beep',
          'none',
        ],
      },
      automation_evidence: {
        type: 'string',
        enum: [
          'menu_prompt',
          'virtual_assistant_disclosure',
          'screening_prompt',
          'none',
        ],
      },
      junk_evidence: {
        type: 'string',
        enum: [
          'test_call',
          'spam_or_scam',
          'prank_or_illegitimate_purpose',
          'none',
        ],
      },
      remarks: { type: 'string', maxLength: 1200 },
      dispute_recommended: { type: 'boolean' },
    },
    required: [
      'category',
      'confidence',
      'customer_block_numbers',
      'unclear_block_numbers',
      'voicemail_evidence_block_numbers',
      'automation_evidence_block_numbers',
      'junk_evidence_block_numbers',
      'business_relevant_customer_block_numbers',
      'counterparty_type',
      'agent_handling',
      'conversation_outcome',
      'duration_outcome',
      'stop_intent',
      'post_stop_behavior',
      'successful_outcome',
      'voicemail_evidence',
      'automation_evidence',
      'junk_evidence',
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
    durationMismatch: boolean
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
      const raw = JSON.parse(message.content || '{}') as {
        category: ReauditCategory
        confidence: number
        customer_block_numbers: number[]
        unclear_block_numbers: number[]
        voicemail_evidence_block_numbers: number[]
        automation_evidence_block_numbers: number[]
        junk_evidence_block_numbers: number[]
        business_relevant_customer_block_numbers: number[]
        counterparty_type:
          | 'human'
          | 'voicemail'
          | 'interactive_automation'
          | 'no_response'
          | 'unclear'
        agent_handling: 'normal' | 'failed' | 'unclear'
        conversation_outcome: 'successful' | 'no_outcome' | 'unclear'
        duration_outcome:
          | 'appropriate'
          | 'ended_too_early'
          | 'continued_without_value'
          | 'unclear'
        stop_intent:
          | 'none'
          | 'busy_or_bad_time'
          | 'callback_or_defer'
          | 'decline_or_end'
        post_stop_behavior:
          | 'not_applicable'
          | 'appropriate_close'
          | 'administrative_extension'
          | 'continued_sales_flow'
          | 'unclear'
        successful_outcome:
          | 'none'
          | 'qualified'
          | 'handoff_or_transfer'
          | 'resolved'
        voicemail_evidence:
          | 'fixed_greeting'
          | 'leave_message_request'
          | 'mailbox_notice'
          | 'recording_notice'
          | 'beep'
          | 'none'
        automation_evidence:
          | 'menu_prompt'
          | 'virtual_assistant_disclosure'
          | 'screening_prompt'
          | 'none'
        junk_evidence:
          | 'test_call'
          | 'spam_or_scam'
          | 'prank_or_illegitimate_purpose'
          | 'none'
        remarks: string
        dispute_recommended: boolean
      }
      const customerBlocks = new Set(raw.customer_block_numbers)
      const customerEnds = options.blocks
        .filter((block) => customerBlocks.has(block.number))
        .map((block) => block.endMs)
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
        voicemailEvidenceBlockNumbers:
          raw.voicemail_evidence_block_numbers,
        automationEvidenceBlockNumbers:
          raw.automation_evidence_block_numbers,
        junkEvidenceBlockNumbers: raw.junk_evidence_block_numbers,
        businessRelevantCustomerBlockNumbers:
          raw.business_relevant_customer_block_numbers,
        customerSpoke: customerEnds.length > 0,
        lastMeaningfulCustomerExchangeMs:
          customerEnds.length > 0 ? Math.max(...customerEnds) : null,
        remarks: raw.remarks,
        disputeRecommended: raw.dispute_recommended,
        decisionSignals: {
          counterpartyType: raw.counterparty_type,
          agentHandling: raw.agent_handling,
          conversationOutcome: raw.conversation_outcome,
          durationOutcome: raw.duration_outcome,
          stopIntent: raw.stop_intent,
          postStopBehavior: raw.post_stop_behavior,
          successfulOutcome: raw.successful_outcome,
          voicemailEvidence: raw.voicemail_evidence,
          automationEvidence: raw.automation_evidence,
          junkEvidence: raw.junk_evidence,
        },
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
