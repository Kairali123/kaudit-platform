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
    'A test, spam, or clearly illegitimate interaction with no genuine customer purpose.',
  OK: 'Normal, legitimate and properly handled two-way customer conversation.',
}

/**
 * Decision precedence distilled from administrator-reviewed outcomes. These
 * are behavioral rules only: no reviewed call content or source identity is
 * embedded in configuration.
 */
export const REAUDIT_KAIRALI_REFERENCE_RULES = `KAIRALI-REVIEWED DECISION RULES
Apply the first rule supported by the transcript evidence. Do not use a broad
category when a more specific rule below matches:
1. A fixed voicemail greeting, leave-a-message request, mailbox notice, beep,
   or fixed system notice that a message/recording completed and the caller may
   hang up
   is VOICEMAIL. It is not customer speech and is not AI_TO_AI.
   Silence, a short call, Saanvi's scripted introduction, and the absence of a
   human reply are NEVER voicemail evidence. Do not claim a voicemail greeting
   unless a non-Saanvi transcript block contains affirmative mailbox evidence.
2. AI_TO_AI requires an interactive automated system, IVR, or screening agent
   that exchanges prompts with Saanvi. Require an explicit menu prompt, virtual-
   assistant disclosure, or screening prompt in a non-Saanvi block. A language
   choice, short human reply, accent, unclear audio, or synthetic-sounding voice
   is never enough. A one-way voicemail greeting is VOICEMAIL.
3. When Saanvi speaks and the called person gives no response at all, choose
   USER_SILENCE. Any human reply, including hello, wrong number, busy, callback,
   or not interested, means USER_SILENCE is not allowed.
4. When a human says they are busy, asks for a callback, declines, or asks to
   end, distinguish what happens next. Continued qualification or sales
   questions are AGENT_FAILURE. Acknowledging the stop but extending the call
   only for unnecessary contact/admin details is TIME_DURATION. An appropriate
   close with no successful outcome is CONNECT_NOT_FRUITFUL. For substantive
   continuation after stop intent, AGENT_FAILURE outranks CONNECT_NOT_FRUITFUL.
5. Choose CONNECT_NOT_FRUITFUL for a legitimate human connection that ends
   without an outcome, such as wrong number, busy, callback, not interested, or
   an early hang-up, when Saanvi did not itself fail. Wrong number is not JUNK_CALL.
6. JUNK_CALL is only for a test, spam, or clearly illegitimate interaction. It
   requires an explicit test, spam/scam, prank, or illegitimate-purpose block.
   It is never a fallback for silence, voicemail, wrong number, repeated hello,
   agent non-response, unclear audio, or a short call.
7. INCORRECT_CALL_DURATION is only for the supplied vendor-versus-recording
   duration-mismatch fact. TIME_DURATION instead describes a recording that
   continued too long or ended too early for the conversational outcome. Never
   infer either category merely because a displayed duration is absent.
8. Choose OK when qualification, resolution, or a handoff/transfer was already
   completed normally. A later callback or deferral statement does not erase
   that successful outcome. Do not invent a defect.
9. A human stop, defer, wrong-number, busy, or decline response followed by an
   appropriate Saanvi close is CONNECT_NOT_FRUITFUL when no successful outcome
   occurred. A vendor-duration difference never changes that quality category.

REFERENCE DECISIONS (SYNTHETIC)
- Saanvi introduces herself and receives no human response: USER_SILENCE.
- A mailbox greeting asks for a message: VOICEMAIL.
- A human says the number is wrong and Saanvi closes appropriately:
  CONNECT_NOT_FRUITFUL.
- A human answers or asks a question and Saanvi gives no useful response:
  AGENT_FAILURE.
- An automated menu interactively prompts Saanvi: AI_TO_AI.
- A person requests a callback and Saanvi continues qualification: AGENT_FAILURE.
- A person requests a callback, Saanvi accepts, then needlessly collects only
  administrative contact details: TIME_DURATION.
- Qualification or handoff completes before a later deferral: OK.
- A normal completed two-way exchange with no independent defect: OK.
- A customer repeatedly says hello while Saanvi never meaningfully responds:
  AGENT_FAILURE.
- A customer gives a language preference and no successful outcome follows:
  CONNECT_NOT_FRUITFUL, not AI_TO_AI.

REMARK REQUIREMENTS
Write one or two concise sentences explaining the observable facts behind the
decision signals and why the nearest plausible alternative does not apply. The
remark must remain accurate if the deterministic engine corrects the proposed
category. Do not quote transcript text or include a name, phone number, email
address, URL, task identifier, provider prose, money, or a calculated duration.
Do not claim facts that are absent from the supplied evidence.`

export const REAUDIT_SPEAKER_ATTRIBUTION_RULES = `SPEAKER ATTRIBUTION RULES
The transcript contains text and timestamps but no acoustic speaker labels. Assign
speaker roles from conversational meaning before choosing a category:
- A block belongs in customer_block_numbers when the speaker answers Saanvi,
  describes a need, supplies requested details, asks a customer-side question,
  repeatedly says hello while waiting for a response, or otherwise speaks as the
  called person. Long or continuous speech is NOT evidence that the speaker is
  Saanvi.
- A block containing only repeated greetings while waiting for Saanvi, or only
  a language choice such as English, Hindi, Tamil, or Malayalam, is customer
  speech. It is not automation and not junk.
- Leave a block out of customer_block_numbers and unclear_block_numbers only when
  its wording positively identifies it as Saanvi's Kairali introduction, scripted
  question, explanation, acknowledgement, or closing.
- Put genuinely ambiguous blocks in unclear_block_numbers. Customer and unclear
  blocks must never overlap.
- The deterministic engine derives whether the customer spoke and the final
  customer-exchange timestamp from customer_block_numbers. Do not return a
  separate boolean or timestamp for those facts.

CATEGORY GUARDRAILS
- USER_SILENCE requires at least one positively identified Saanvi block and zero
  customer blocks. Never use USER_SILENCE when the customer speaks but Saanvi is
  silent or stops responding.
- When customer speech continues and Saanvi gives no substantive response after
  it begins, use AGENT_FAILURE by default.
- Use NETWORK_FAILURE_TELECOM instead only when the transcript contains explicit
  evidence of one-way audio, inability to hear, distortion, a connection problem,
  or a telecom drop. Absence of an agent response by itself is not network evidence.
- A recorded voicemail or answering-machine greeting is VOICEMAIL, not
  USER_SILENCE and not customer speech.`

export const REAUDIT_DECISION_SIGNAL_RULES = `DECISION SIGNALS
Before proposing a category, extract these observable facts independently:
- counterparty_type: human for a real person's response; voicemail for a fixed
  mailbox greeting or beep; interactive_automation for an IVR or automated
  system that exchanges prompts; no_response when only Saanvi speaks; otherwise
  unclear.
- voicemail_evidence: the affirmative voicemail feature actually present in the
  transcript: fixed_greeting, leave_message_request, mailbox_notice,
  recording_notice, or beep.
  Return none unless that feature appears in one or more non-Saanvi blocks, and
  put exactly those block numbers in voicemail_evidence_block_numbers. A
  voicemail counterparty requires non-none evidence and at least one evidence
  block. When only Saanvi speaks, return none and no_response.
- agent_handling: failed when Saanvi ignores or mishandles a human response,
  abandons the exchange, repeats without value, or continues against the stated
  response; normal when handling is appropriate; otherwise unclear.
- conversation_outcome: successful only when the legitimate purpose succeeds,
  including a properly completed transfer; no_outcome when a human connection
  ends without that result; otherwise unclear.
- duration_outcome: ended_too_early or continued_without_value only when the
  conversational sequence itself demonstrates that behavior; appropriate when
  timing fits the outcome; otherwise unclear.
- stop_intent: the human's explicit busy/bad-time, callback/defer, decline, or
  end request; otherwise none.
- post_stop_behavior: what Saanvi does after stop_intent: appropriate_close,
  administrative_extension for unnecessary contact/admin collection only,
  continued_sales_flow for substantive qualification/sales continuation,
  not_applicable when there is no stop intent, otherwise unclear.
- successful_outcome: qualified, handoff_or_transfer, or resolved only when that
  result was completed before the call ended; otherwise none.
- business_relevant_customer_block_numbers: customer blocks that contain a
  genuine Kairali business enquiry, need, qualification answer, or resolution.
  Ordinary greetings, spam, tests, abuse, and unrelated speech are not business
  relevant. Every number here must also appear in customer_block_numbers.
- automation_evidence: menu_prompt only for explicit interactive menu choices;
  virtual_assistant_disclosure only when the counterparty identifies itself as
  automated; screening_prompt only for an automated name/purpose screening
  exchange. Otherwise none. Put only the supporting non-Saanvi blocks in
  automation_evidence_block_numbers.
- junk_evidence: test_call, spam_or_scam, or prank_or_illegitimate_purpose only
  when an explicit supporting block exists. Otherwise none. Put only those
  supporting blocks in junk_evidence_block_numbers.

The deterministic engine applies reviewed precedence to these signals. Do not
alter a signal to justify the proposed category. A vendor-versus-recording
duration mismatch is supplied separately and is never inferred from transcript
timing.`

export const REAUDIT_CLASSIFIER_PROMPT = `You are the automated call-quality auditor for Kairali Group.
The female Kairali AI agent is named Saanvi. Calls may be English, Hindi, Hinglish,
Malayalam, or another detected language.

Input is a numbered, timestamped transcript with no speaker labels. Identify customer
blocks from conversational cues. The deterministic engine uses the END timestamp of the
last identified customer block as the final meaningful customer exchange. Saanvi's
natural closing words are handled later by a deterministic 60-second billing grace rule.

${REAUDIT_SPEAKER_ATTRIBUTION_RULES}

${REAUDIT_KAIRALI_REFERENCE_RULES}

${REAUDIT_DECISION_SIGNAL_RULES}

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
  outputSchemaVersion: '7',
} as unknown as JsonValue)

export const REAUDIT_CLASSIFIER_OUTPUT_SCHEMA = {
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
          json_schema: REAUDIT_CLASSIFIER_OUTPUT_SCHEMA,
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
        confidence: fixedConfidence(raw.confidence),
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
