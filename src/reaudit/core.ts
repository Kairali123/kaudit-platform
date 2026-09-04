import {
  KSERVE_ONE_WAY_TAIL_ALERT_MS,
} from '../billing/kserveRules.ts'
import { roundKServeChargeableDuration } from '../billing/calculateVerifiedCharge.ts'
import { resolveCategoryCharge } from '../billing/categoryChargePolicy.ts'
import { sha256Hex } from '../lib/hash.ts'
import { isSafeVendorUrl } from '../security/urlSafety.ts'
import type { UrlFetcher } from '../storage/ports.ts'
import type {
  ClassificationDecisionSignals,
  ModelClassification,
  NaturalSpeechBlock,
  ReauditAi,
  ReauditAnalysis,
  ReauditCandidate,
  ReauditItemResult,
  ReauditProjection,
  TranscriptSegment,
} from './types.ts'
import { REAUDIT_CATEGORIES } from './types.ts'

export const REAUDIT_ENGINE_VERSION = 'kairali-independent-reaudit/2.6.5'

/**
 * The engine FAMILY, for readers asking "was this call audited by our
 * independent engine" rather than "by which build".
 *
 * The version above moves whenever the engine's identity changes, and it has
 * moved many times. A reader that pins one exact version silently stops
 * counting every audit written by a later build — which is how the billing
 * cycle came to report a fully audited month as almost entirely pending. Match
 * this prefix instead, and let the run's own `engine_version` carry the exact
 * provenance.
 */
export const REAUDIT_ENGINE_FAMILY = 'kairali-independent-reaudit/'

if (!REAUDIT_ENGINE_VERSION.startsWith(REAUDIT_ENGINE_FAMILY)) {
  throw new Error('Reaudit engine version must belong to its engine family')
}
export const REAUDIT_CLASSIFIER_RULESET_VERSION = 'kairali-12cat/2.8.5'
export const DURATION_TOLERANCE_MS = 5_000
export const MERGE_GAP_MS = 1_000
export const MERGE_MAX_BLOCK_MS = 15_000
export const MERGE_MAX_BLOCK_CHARS = 250

const decimal = /^(0|1)(?:\.\d{1,8})?$/

function providerFailureCode(
  phase: 'TRANSCRIPTION' | 'CLASSIFICATION',
  error: unknown,
): string | null {
  if (!error || typeof error !== 'object') return null
  const shaped = error as { status?: unknown; code?: unknown }
  const status = Number(shaped.status)
  const code = String(shaped.code || '')
  if (status === 429) {
    if (code === 'insufficient_quota') {
      return `${phase}_PROVIDER_QUOTA_EXHAUSTED`
    }
    if (code === 'rate_limit_exceeded') {
      return `${phase}_PROVIDER_RATE_LIMITED`
    }
    return `${phase}_PROVIDER_HTTP_429`
  }
  if (status === 408) return `${phase}_PROVIDER_TIMEOUT`
  if (status === 409) return `${phase}_PROVIDER_CONFLICT`
  if (status >= 500) return `${phase}_PROVIDER_SERVER_ERROR`
  if (new Set([
    'ETIMEDOUT',
    'ECONNRESET',
    'ECONNREFUSED',
    'EAI_AGAIN',
    'ENETUNREACH',
    'APIConnectionError',
    'APIConnectionTimeoutError',
  ]).has(code)) {
    return `${phase}_PROVIDER_CONNECTION_ERROR`
  }
  return null
}

/**
 * Positive voicemail language only. Silence, an agent introduction, and a
 * request for the customer's name intentionally match none of these cues.
 * The model still handles language and meaning; this bounded multilingual
 * check prevents an unsupported evidence-block assertion from becoming fact.
 */
const AFFIRMATIVE_VOICEMAIL_CUE =
  /\b(?:voice\s*mail|mailbox|beep|after (?:the )?(?:tone|beep)|at the tone|leave (?:a |your )?message|record (?:a |your |the )?message|you(?:'ve| have) reached|is not available|cannot (?:take|answer) (?:your )?call|(?:message|recording) (?:has been |is )?(?:recorded|complete(?:d)?|finished|ended)|you (?:may|can) (?:now )?hang up)\b|वॉइस\s*मेल|वॉइसमेल|संदेश छोड़|मैसेज छोड़|बीप|टोन के बाद|उपलब्ध नहीं|വോയ്സ്\s*മെയിൽ|വോയ്സ്മെയിൽ|സന്ദേശം|ബീപ്പ്|ലഭ്യമല്ല/iu

const AFFIRMATIVE_AUTOMATION_CUE =
  /\b(?:press|dial|choose|select)\s+(?:a\s+)?(?:number|option|one|two|three|[0-9])\b|\b(?:virtual|automated|digital)\s+(?:assistant|agent|system|service|menu)\b|\b(?:state|say)\s+(?:your\s+)?(?:name|purpose|reason for (?:the )?call)\b|\b(?:call is being screened|screening (?:assistant|service))\b|(?:बटन|विकल्प)\s*(?:दबाएँ|चुनें)|ഓപ്ഷൻ\s*(?:തിരഞ്ഞെടുക്കുക|അമർത്തുക)/iu

const AFFIRMATIVE_JUNK_CUE =
  /\b(?:test(?:ing)?(?:\s+(?:call|audio|system|line))?|spam|scam|prank|robocall)\b|\b(?:fake|fraudulent)\s+(?:call|enquiry|inquiry)\b|टेस्ट\s*कॉल|स्पैम|स्कैम|തമാശ\s*കോൾ/iu

const REPEATED_CUSTOMER_GREETING_CUE =
  /^(?:(?:hello|hallo|helo|hi|हेलो|हलो|ഹലോ)[\s,!?]*){2,}$/iu

const CUSTOMER_LANGUAGE_CHOICE_CUE =
  /^(?:(?:english|hindi|hinglish|tamil|malayalam|telugu|kannada|marathi|bengali|ગુજરાતી|हिंदी|தமிழ்|മലയാളം)[\s,/&]*)+$/iu

const DECISION_SIGNAL_VALUES = {
  counterpartyType: [
    'human',
    'voicemail',
    'interactive_automation',
    'no_response',
    'unclear',
  ],
  agentHandling: ['normal', 'failed', 'unclear'],
  conversationOutcome: ['successful', 'no_outcome', 'unclear'],
  durationOutcome: [
    'appropriate',
    'ended_too_early',
    'continued_without_value',
    'unclear',
  ],
  stopIntent: [
    'none',
    'busy_or_bad_time',
    'callback_or_defer',
    'decline_or_end',
  ],
  postStopBehavior: [
    'not_applicable',
    'appropriate_close',
    'administrative_extension',
    'continued_sales_flow',
    'unclear',
  ],
  successfulOutcome: [
    'none',
    'qualified',
    'handoff_or_transfer',
    'resolved',
  ],
  voicemailEvidence: [
    'fixed_greeting',
    'leave_message_request',
    'mailbox_notice',
    'recording_notice',
    'beep',
    'none',
  ],
  automationEvidence: [
    'menu_prompt',
    'virtual_assistant_disclosure',
    'screening_prompt',
    'none',
  ],
  junkEvidence: [
    'test_call',
    'spam_or_scam',
    'prank_or_illegitimate_purpose',
    'none',
  ],
} as const

function validateDecisionSignals(
  signals: ClassificationDecisionSignals,
): void {
  for (const [name, allowed] of Object.entries(DECISION_SIGNAL_VALUES)) {
    const value = signals[name as keyof ClassificationDecisionSignals]
    if (value === undefined) {
      if (
        name === 'voicemailEvidence' ||
        name === 'automationEvidence' ||
        name === 'junkEvidence' ||
        name === 'stopIntent' ||
        name === 'postStopBehavior' ||
        name === 'successfulOutcome'
      ) continue
      throw new Error(`Classifier returned an unsupported ${name} signal`)
    }
    if (!(allowed as readonly string[]).includes(value)) {
      throw new Error(`Classifier returned an unsupported ${name} signal`)
    }
  }
}

export function resolveReviewedCategory(options: {
  proposedCategory: ModelClassification['category']
  decisionSignals?: ClassificationDecisionSignals
  customerBlockCount: number
  agentBlockCount?: number
  voicemailEvidenceBlockCount?: number
  automationEvidenceBlockCount?: number
  junkEvidenceBlockCount?: number
  durationMismatch?: boolean
}): ModelClassification['category'] {
  const signals = options.decisionSignals
  if (!signals) return options.proposedCategory
  validateDecisionSignals(signals)

  if (
    signals.counterpartyType === 'human' &&
    options.customerBlockCount === 0
  ) {
    throw new Error('Human counterparty signal requires customer speech')
  }
  if (
    (signals.counterpartyType === 'voicemail' ||
      signals.counterpartyType === 'interactive_automation' ||
      signals.counterpartyType === 'no_response') &&
    options.customerBlockCount > 0
  ) {
    throw new Error('Non-human counterparty signal cannot contain customer speech')
  }

  if (signals.counterpartyType === 'voicemail') {
    // Legacy durable results predate affirmative voicemail evidence. New live
    // classifiers always provide both fields and cannot turn mere silence into
    // voicemail by assertion alone.
    if (
      signals.voicemailEvidence !== undefined &&
      (signals.voicemailEvidence === 'none' ||
        options.voicemailEvidenceBlockCount === 0)
    ) {
      return 'USER_SILENCE'
    }
    return 'VOICEMAIL'
  }
  if (
    signals.voicemailEvidence !== undefined &&
    (signals.voicemailEvidence !== 'none' ||
      (options.voicemailEvidenceBlockCount ?? 0) > 0)
  ) {
    throw new Error(
      'Voicemail evidence requires a voicemail counterparty signal',
    )
  }
  if (signals.counterpartyType === 'interactive_automation') {
    if (
      signals.automationEvidence !== undefined &&
      (signals.automationEvidence === 'none' ||
        options.automationEvidenceBlockCount === 0 ||
        options.agentBlockCount === 0)
    ) {
      throw new Error(
        'AI-to-AI requires affirmative interactive-automation evidence',
      )
    }
    return 'AI_TO_AI'
  }
  if (
    signals.automationEvidence !== undefined &&
    (signals.automationEvidence !== 'none' ||
      (options.automationEvidenceBlockCount ?? 0) > 0)
  ) {
    throw new Error(
      'Automation evidence requires an interactive-automation counterparty',
    )
  }
  if (signals.counterpartyType === 'no_response') {
    return 'USER_SILENCE'
  }
  const explicitJunkEvidence =
    signals.junkEvidence !== undefined &&
    signals.junkEvidence !== 'none' &&
    (options.junkEvidenceBlockCount ?? 0) > 0
  if (options.proposedCategory === 'JUNK_CALL' && explicitJunkEvidence) {
    return 'JUNK_CALL'
  }
  if (
    signals.counterpartyType === 'human' &&
    options.customerBlockCount > 0 &&
    options.agentBlockCount === 0
  ) {
    return 'AGENT_FAILURE'
  }
  if (
    options.proposedCategory === 'JUNK_CALL' &&
    signals.junkEvidence !== undefined
  ) {
    throw new Error('Junk call requires affirmative junk evidence')
  }
  if (
    options.proposedCategory !== 'JUNK_CALL' &&
    (explicitJunkEvidence || (options.junkEvidenceBlockCount ?? 0) > 0)
  ) {
    throw new Error('Junk evidence requires the junk-call category')
  }
  if (
    signals.counterpartyType === 'human' &&
    signals.successfulOutcome !== undefined &&
    signals.successfulOutcome !== 'none' &&
    signals.agentHandling === 'normal'
  ) {
    return 'OK'
  }
  if (
    signals.stopIntent !== undefined &&
    signals.stopIntent !== 'none' &&
    signals.postStopBehavior === 'continued_sales_flow'
  ) {
    return 'AGENT_FAILURE'
  }
  if (
    signals.stopIntent !== undefined &&
    signals.stopIntent !== 'none' &&
    signals.postStopBehavior === 'administrative_extension'
  ) {
    return 'TIME_DURATION'
  }
  if (signals.agentHandling === 'failed') return 'AGENT_FAILURE'
  if (
    signals.counterpartyType === 'human' &&
    signals.conversationOutcome === 'successful' &&
    signals.agentHandling === 'normal'
  ) {
    return 'OK'
  }
  if (
    signals.counterpartyType === 'human' &&
    signals.stopIntent !== undefined &&
    signals.stopIntent !== 'none' &&
    signals.postStopBehavior === 'appropriate_close' &&
    signals.conversationOutcome === 'no_outcome' &&
    signals.agentHandling === 'normal'
  ) {
    return 'CONNECT_NOT_FRUITFUL'
  }
  if (
    signals.durationOutcome === 'ended_too_early' ||
    signals.durationOutcome === 'continued_without_value'
  ) {
    return 'TIME_DURATION'
  }
  if (
    signals.counterpartyType === 'human' &&
    signals.conversationOutcome === 'no_outcome' &&
    signals.agentHandling === 'normal'
  ) {
    return 'CONNECT_NOT_FRUITFUL'
  }
  if (options.proposedCategory === 'INCORRECT_CALL_DURATION') {
    if (options.durationMismatch === true) return 'INCORRECT_CALL_DURATION'
    throw new Error(
      'Duration-mismatch category requires a verified duration mismatch',
    )
  }
  return options.proposedCategory
}

function safeMs(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer`)
  }
  return value
}

export function mergeTranscriptSegments(
  segments: TranscriptSegment[],
): NaturalSpeechBlock[] {
  const result: NaturalSpeechBlock[] = []
  let current: Omit<NaturalSpeechBlock, 'number'> | null = null
  for (const segment of segments) {
    const startMs = safeMs(segment.startMs, 'segment.startMs')
    const endMs = safeMs(segment.endMs, 'segment.endMs')
    if (endMs < startMs) throw new RangeError('segment.endMs precedes startMs')
    const text = segment.text.trim()
    const split =
      current != null &&
      (startMs - current.endMs >= MERGE_GAP_MS ||
        endMs - current.startMs > MERGE_MAX_BLOCK_MS ||
        current.text.length + text.length + 1 > MERGE_MAX_BLOCK_CHARS)
    if (current == null || split) {
      if (current) result.push({ number: result.length + 1, ...current })
      current = { startMs, endMs, text }
    } else {
      current.endMs = endMs
      current.text = `${current.text}${text ? ` ${text}` : ''}`
    }
  }
  if (current) result.push({ number: result.length + 1, ...current })
  return result
}

export function validateClassification(
  raw: ModelClassification,
  blocks: NaturalSpeechBlock[],
  recordedDurationMs: number,
  options: { durationMismatch?: boolean } = {},
): ModelClassification {
  if (!(REAUDIT_CATEGORIES as readonly string[]).includes(raw.category)) {
    throw new Error(`Classifier returned unsupported category: ${raw.category}`)
  }
  if (!decimal.test(raw.confidence)) {
    throw new Error('Classifier confidence must be a decimal from 0 to 1')
  }
  const maxBlock = blocks.length
  const normalizeBlocks = (values: number[]): number[] =>
    [...new Set(values)]
      .filter((value) => Number.isInteger(value) && value >= 1 && value <= maxBlock)
      .sort((left, right) => left - right)
  const deterministicCustomerBlockNumbers = blocks
    .filter((block) => {
      const text = block.text.trim()
      return (
        (raw.category === 'JUNK_CALL' &&
          REPEATED_CUSTOMER_GREETING_CUE.test(text)) ||
        ((raw.category === 'AI_TO_AI' ||
          raw.decisionSignals?.counterpartyType ===
            'interactive_automation') &&
          CUSTOMER_LANGUAGE_CHOICE_CUE.test(text))
      )
    })
    .map((block) => block.number)
  const rawCustomerBlockNumbers = normalizeBlocks(raw.customerBlockNumbers)
  const customerBlockNumbers = normalizeBlocks([
    ...rawCustomerBlockNumbers,
    ...deterministicCustomerBlockNumbers,
  ])
  const unclearBlockNumbers = normalizeBlocks(raw.unclearBlockNumbers)
  const voicemailEvidenceBlockNumbers = normalizeBlocks(
    raw.voicemailEvidenceBlockNumbers ?? [],
  ).filter((number) => {
    const block = blocks.find((candidate) => candidate.number === number)
    return block != null && AFFIRMATIVE_VOICEMAIL_CUE.test(block.text)
  })
  const customerBlocks = new Set(customerBlockNumbers)
  if (
    rawCustomerBlockNumbers.some((number) =>
      unclearBlockNumbers.includes(number),
    )
  ) {
    throw new Error('Customer and unclear speech blocks must not overlap')
  }
  const deterministicCustomerBlocks = new Set(
    deterministicCustomerBlockNumbers,
  )
  const unclearBlocks = new Set(
    unclearBlockNumbers.filter(
      (number) => !deterministicCustomerBlocks.has(number),
    ),
  )
  const normalizedUnclearBlockNumbers = [...unclearBlocks].sort(
    (left, right) => left - right,
  )
  const voicemailEvidenceBlocks = new Set(voicemailEvidenceBlockNumbers)
  const automationEvidenceBlockNumbers = normalizeBlocks(
    raw.automationEvidenceBlockNumbers ?? [],
  ).filter((number) => {
    const block = blocks.find((candidate) => candidate.number === number)
    return (
      block != null &&
      !customerBlocks.has(number) &&
      !unclearBlocks.has(number) &&
      AFFIRMATIVE_AUTOMATION_CUE.test(block.text)
    )
  })
  const automationEvidenceBlocks = new Set(
    automationEvidenceBlockNumbers,
  )
  const junkEvidenceBlockNumbers = normalizeBlocks(
    raw.junkEvidenceBlockNumbers ?? [],
  ).filter((number) => {
    const block = blocks.find((candidate) => candidate.number === number)
    return block != null && AFFIRMATIVE_JUNK_CUE.test(block.text)
  })
  // This field affects only the JUNK_CALL billing endpoint. Keep the model's
  // customer-role assignment authoritative and discard contradictory extras
  // instead of failing the entire quality audit over a derived billing tag.
  const businessRelevantCustomerBlockNumbers = normalizeBlocks(
    raw.businessRelevantCustomerBlockNumbers ?? [],
  ).filter((number) => customerBlocks.has(number))
  const businessRelevantCustomerBlocks = new Set(
    businessRelevantCustomerBlockNumbers,
  )
  if (
    voicemailEvidenceBlockNumbers.some(
      (number) => customerBlocks.has(number) || unclearBlocks.has(number),
    )
  ) {
    throw new Error(
      'Voicemail evidence blocks must be separate from customer and unclear speech',
    )
  }
  // The model identifies roles; the engine owns the resulting time fact. This
  // avoids rejecting a valid role assignment because a model repeated a
  // displayed, rounded timestamp that differed from the source block by a few
  // milliseconds.
  const customerEnds = blocks
    .filter((block) => customerBlocks.has(block.number))
    .map((block) => Math.min(block.endMs, recordedDurationMs))
  const customerSpoke = customerEnds.length > 0
  const last = customerEnds.length > 0 ? Math.max(...customerEnds) : null
  const agentEnds = blocks
    .filter(
      (block) =>
        !customerBlocks.has(block.number) &&
        !unclearBlocks.has(block.number) &&
        !voicemailEvidenceBlocks.has(block.number) &&
        !automationEvidenceBlocks.has(block.number),
    )
    .map((block) => Math.min(block.endMs, recordedDurationMs))
  const voicemailEnds = blocks
    .filter((block) => voicemailEvidenceBlocks.has(block.number))
    .map((block) => Math.min(block.endMs, recordedDurationMs))
  const businessEnds = blocks
    .filter((block) => businessRelevantCustomerBlocks.has(block.number))
    .map((block) => Math.min(block.endMs, recordedDurationMs))
  const verifiedEnds = blocks
    .filter((block) => !unclearBlocks.has(block.number))
    .map((block) => Math.min(block.endMs, recordedDurationMs))
  const decisionSignals =
    raw.decisionSignals?.counterpartyType === 'interactive_automation' &&
    customerBlockNumbers.length > 0
      ? {
          ...raw.decisionSignals,
          counterpartyType: 'human' as const,
          automationEvidence: 'none' as const,
        }
      : raw.decisionSignals
  const category = resolveReviewedCategory({
    proposedCategory: raw.category,
    decisionSignals,
    customerBlockCount: customerBlockNumbers.length,
    agentBlockCount: agentEnds.length,
    voicemailEvidenceBlockCount: voicemailEvidenceBlockNumbers.length,
    automationEvidenceBlockCount: automationEvidenceBlockNumbers.length,
    junkEvidenceBlockCount: junkEvidenceBlockNumbers.length,
    durationMismatch: options.durationMismatch,
  })
  if (category === 'USER_SILENCE') {
    if (customerBlockNumbers.length > 0) {
      throw new Error('User-silence result cannot contain customer speech')
    }
    const agentBlockCount = blocks.filter(
      (block) =>
        !customerBlocks.has(block.number) &&
        !unclearBlocks.has(block.number) &&
        !voicemailEvidenceBlocks.has(block.number) &&
        !automationEvidenceBlocks.has(block.number),
    ).length
    if (agentBlockCount === 0) {
      throw new Error(
        'User-silence result requires positively identified agent speech',
      )
    }
  }
  return {
    ...raw,
    category,
    customerBlockNumbers,
    unclearBlockNumbers: normalizedUnclearBlockNumbers,
    voicemailEvidenceBlockNumbers,
    automationEvidenceBlockNumbers,
    junkEvidenceBlockNumbers,
    businessRelevantCustomerBlockNumbers,
    decisionSignals,
    customerSpoke,
    lastMeaningfulCustomerExchangeMs: last,
    lastMeaningfulAgentExchangeMs:
      agentEnds.length > 0 ? Math.max(...agentEnds) : null,
    lastVoicemailExchangeMs:
      voicemailEnds.length > 0 ? Math.max(...voicemailEnds) : null,
    lastBusinessRelevantCustomerExchangeMs:
      businessEnds.length > 0 ? Math.max(...businessEnds) : null,
    lastVerifiedInteractionMs:
      verifiedEnds.length > 0 ? Math.max(...verifiedEnds) : null,
    remarks:
      decisionSignals?.counterpartyType === 'voicemail' &&
      category === 'USER_SILENCE'
        ? 'Agent speech was identified, but no customer or affirmative voicemail evidence was identified; this is user silence.'
        : raw.remarks.trim().slice(0, 2_000),
  }
}

/**
 * Repairs semantic contradictions in otherwise schema-valid model output.
 * Evidence-backed system blocks outrank model role guesses; customer speech
 * outranks an unclear label. The strict validator still owns the final check.
 */
export function repairClassification(
  raw: ModelClassification,
  blocks: NaturalSpeechBlock[],
  options: { durationMismatch?: boolean } = {},
): ModelClassification {
  const valid = new Set(blocks.map((block) => block.number))
  const numbers = (values: readonly number[] | undefined): number[] =>
    [...new Set(values ?? [])]
      .filter((value) => Number.isInteger(value) && valid.has(value))
      .sort((left, right) => left - right)
  const blockText = (number: number): string =>
    blocks.find((block) => block.number === number)?.text ?? ''

  const voicemailEvidenceBlockNumbers = numbers(
    raw.voicemailEvidenceBlockNumbers,
  ).filter((number) => AFFIRMATIVE_VOICEMAIL_CUE.test(blockText(number)))
  const automationEvidenceBlockNumbers = numbers(
    raw.automationEvidenceBlockNumbers,
  ).filter((number) => AFFIRMATIVE_AUTOMATION_CUE.test(blockText(number)))
  const systemEvidence = new Set([
    ...voicemailEvidenceBlockNumbers,
    ...automationEvidenceBlockNumbers,
  ])
  const customerBlockNumbers = numbers(raw.customerBlockNumbers).filter(
    (number) => !systemEvidence.has(number),
  )
  const customer = new Set(customerBlockNumbers)
  const unclearBlockNumbers = numbers(raw.unclearBlockNumbers).filter(
    (number) => !customer.has(number) && !systemEvidence.has(number),
  )
  const unclear = new Set(unclearBlockNumbers)
  const junkEvidenceBlockNumbers = numbers(
    raw.junkEvidenceBlockNumbers,
  ).filter((number) => AFFIRMATIVE_JUNK_CUE.test(blockText(number)))
  const evidenceText = (values: readonly number[]): string =>
    values.map(blockText).join(' ')
  const voicemailEvidenceText = evidenceText(voicemailEvidenceBlockNumbers)
  const automationEvidenceText = evidenceText(automationEvidenceBlockNumbers)
  const junkEvidenceText = evidenceText(junkEvidenceBlockNumbers)
  const agentBlockCount = blocks.filter(
    (block) =>
      !customer.has(block.number) &&
      !unclear.has(block.number) &&
      !systemEvidence.has(block.number),
  ).length

  const counterpartyType = voicemailEvidenceBlockNumbers.length > 0
    ? 'voicemail' as const
    : automationEvidenceBlockNumbers.length > 0 && agentBlockCount > 0
      ? 'interactive_automation' as const
      : customerBlockNumbers.length > 0
        ? 'human' as const
        : agentBlockCount > 0
          ? 'no_response' as const
          : 'unclear' as const
  const signals = raw.decisionSignals
    ? {
        ...raw.decisionSignals,
        counterpartyType,
        voicemailEvidence:
          voicemailEvidenceBlockNumbers.length > 0
            ? raw.decisionSignals.voicemailEvidence === 'none' ||
                raw.decisionSignals.voicemailEvidence === undefined
              ? /\b(?:beep|tone)\b|बीप|ബീപ്പ്/iu.test(voicemailEvidenceText)
                ? 'beep' as const
                : /leave (?:a |your )?message|record (?:a |your |the )?message|संदेश छोड़|मैसेज छोड़/iu.test(
                      voicemailEvidenceText,
                    )
                  ? 'leave_message_request' as const
                  : /(?:message|recording) (?:has been |is )?(?:recorded|complete(?:d)?|finished|ended)|hang up/iu.test(
                        voicemailEvidenceText,
                      )
                    ? 'recording_notice' as const
                    : /mailbox|is not available|cannot (?:take|answer)/iu.test(
                          voicemailEvidenceText,
                        )
                      ? 'mailbox_notice' as const
                      : 'fixed_greeting' as const
              : raw.decisionSignals.voicemailEvidence
            : 'none' as const,
        automationEvidence:
          automationEvidenceBlockNumbers.length > 0
            ? raw.decisionSignals.automationEvidence === 'none' ||
                raw.decisionSignals.automationEvidence === undefined
              ? /\b(?:virtual|automated|digital)\s+(?:assistant|agent|system|service)\b/iu.test(
                  automationEvidenceText,
                )
                ? 'virtual_assistant_disclosure' as const
                : /\b(?:state|say)\s+(?:your\s+)?(?:name|purpose|reason for (?:the )?call)\b|screen/iu.test(
                      automationEvidenceText,
                    )
                  ? 'screening_prompt' as const
                  : 'menu_prompt' as const
              : raw.decisionSignals.automationEvidence
            : 'none' as const,
        junkEvidence:
          junkEvidenceBlockNumbers.length > 0
            ? raw.decisionSignals.junkEvidence === 'none' ||
                raw.decisionSignals.junkEvidence === undefined
              ? /\btest(?:ing)?\b|टेस्ट\s*कॉल/iu.test(junkEvidenceText)
                ? 'test_call' as const
                : /\b(?:spam|scam|robocall|fake|fraudulent)\b|स्पैम|स्कैम/iu.test(
                      junkEvidenceText,
                    )
                  ? 'spam_or_scam' as const
                  : 'prank_or_illegitimate_purpose' as const
              : raw.decisionSignals.junkEvidence
            : 'none' as const,
      }
    : undefined

  let category = raw.category
  if (counterpartyType === 'voicemail') category = 'VOICEMAIL'
  else if (counterpartyType === 'interactive_automation') category = 'AI_TO_AI'
  else if (counterpartyType === 'no_response') category = 'USER_SILENCE'
  else if (counterpartyType === 'unclear') category = 'INACTIVE_CALL'
  else if (junkEvidenceBlockNumbers.length > 0) category = 'JUNK_CALL'
  else if (
    category === 'USER_SILENCE' ||
    category === 'VOICEMAIL' ||
    category === 'AI_TO_AI' ||
    category === 'INACTIVE_CALL' ||
    (category === 'JUNK_CALL' && junkEvidenceBlockNumbers.length === 0) ||
    (category === 'INCORRECT_CALL_DURATION' && !options.durationMismatch)
  ) {
    category = signals?.agentHandling === 'failed' || agentBlockCount === 0
      ? 'AGENT_FAILURE'
      : signals?.conversationOutcome === 'successful'
        ? 'OK'
        : signals?.durationOutcome === 'ended_too_early' ||
            signals?.durationOutcome === 'continued_without_value'
          ? 'TIME_DURATION'
          : 'CONNECT_NOT_FRUITFUL'
  }

  return {
    ...raw,
    category,
    customerBlockNumbers,
    unclearBlockNumbers,
    voicemailEvidenceBlockNumbers,
    automationEvidenceBlockNumbers,
    junkEvidenceBlockNumbers,
    businessRelevantCustomerBlockNumbers: numbers(
      raw.businessRelevantCustomerBlockNumbers,
    ).filter((number) => customer.has(number)),
    decisionSignals: signals,
  }
}

function speechByRole(
  blocks: NaturalSpeechBlock[],
  classification: ModelClassification,
): { customerSpeechMs: number; agentSpeechMs: number } {
  const customer = new Set(classification.customerBlockNumbers)
  const unclear = new Set(classification.unclearBlockNumbers)
  const voicemailEvidence = new Set(
    classification.voicemailEvidenceBlockNumbers ?? [],
  )
  const automationEvidence = new Set(
    classification.automationEvidenceBlockNumbers ?? [],
  )
  let customerSpeechMs = 0
  let agentSpeechMs = 0
  for (const block of blocks) {
    const duration = Math.max(0, block.endMs - block.startMs)
    if (customer.has(block.number)) customerSpeechMs += duration
    else if (
      !unclear.has(block.number) &&
      !voicemailEvidence.has(block.number) &&
      !automationEvidence.has(block.number)
    ) {
      agentSpeechMs += duration
    }
  }
  return { customerSpeechMs, agentSpeechMs }
}

export function projectVerifiedCharge(
  analysis: ReauditAnalysis,
): ReauditProjection {
  const adjusted = analysis.chargeableServiceEndMs + analysis.appliedBillingGraceMs
  const boundedAdjusted = Math.min(analysis.recordedDurationMs, adjusted)
  const rounded = roundKServeChargeableDuration(boundedAdjusted)
  const oneWayTailMs = Math.max(
    0,
    analysis.recordedDurationMs - boundedAdjusted,
  )
  return {
    amount: rounded.amount,
    amountPaise: rounded.amountPaise,
    billableMinutes: rounded.billableMinutes,
    billableDurationMs: rounded.billableDurationMs,
    adjustedChargeableDurationMs: boundedAdjusted,
    oneWayTailMs,
    oneWayTailAlert: oneWayTailMs > KSERVE_ONE_WAY_TAIL_ALERT_MS,
    categoryChargePolicyCode: analysis.categoryChargePolicyCode,
    ruleCode: rounded.ruleCode,
    authority: 'provisional_uncalibrated',
  }
}

export async function auditOneCall(options: {
  candidate: ReauditCandidate
  fetcher: UrlFetcher
  ai: ReauditAi
  allowedHosts: string[]
}): Promise<ReauditItemResult> {
  const { candidate, fetcher, ai, allowedHosts } = options
  const safety = isSafeVendorUrl(candidate.sourceUrl, allowedHosts)
  if (!safety.safe) {
    return {
      callId: candidate.callId,
      artifactId: candidate.artifactId,
      outcome: 'unsafe_url',
      errorCode: safety.reason ?? 'unsafe_url',
    }
  }
  const fetched = await fetcher.fetch(candidate.sourceUrl)
  if (!fetched.ok) {
    return {
      callId: candidate.callId,
      artifactId: candidate.artifactId,
      outcome: 'source_missing',
      errorCode: fetched.error,
    }
  }
  const evidenceSha256 = sha256Hex(fetched.bytes)
  if (
    candidate.baselineSha256 &&
    candidate.baselineSha256 !== evidenceSha256
  ) {
    return {
      callId: candidate.callId,
      artifactId: candidate.artifactId,
      outcome: 'evidence_altered',
      errorCode: 'sha256_mismatch',
    }
  }

  let transcript
  try {
    transcript = await ai.transcribe(fetched.bytes, {
      contentType: fetched.contentType || 'audio/ogg',
    })
  } catch (error) {
    return {
      callId: candidate.callId,
      artifactId: candidate.artifactId,
      outcome: 'transcription_failed',
      errorCode: providerFailureCode('TRANSCRIPTION', error) ??
        'TRANSCRIPTION_FAILED',
    }
  }
  const durationMismatch =
    candidate.connectedDurationMs != null &&
    Math.abs(candidate.connectedDurationMs - transcript.durationMs) >
      DURATION_TOLERANCE_MS

  let analysis: ReauditAnalysis
  let modelClassification: ModelClassification | null = null
  if (transcript.segments.length === 0 || !transcript.text.trim()) {
    const categoryCharge = resolveCategoryCharge({
      category: 'INACTIVE_CALL',
      recordedDurationMs: transcript.durationMs,
      lastCustomerExchangeMs: null,
      lastAgentExchangeMs: null,
      lastVoicemailExchangeMs: null,
      lastBusinessRelevantCustomerExchangeMs: null,
      lastVerifiedInteractionMs: null,
    })
    analysis = {
      category: 'INACTIVE_CALL',
      confidence: '1.00000000',
      language: transcript.language || 'unknown',
      recordedDurationMs: transcript.durationMs,
      speechDurationMs: transcript.speechMs,
      conversationAssessment: 'no_meaningful_exchange',
      lastMeaningfulCustomerExchangeMs: null,
      customerSpeechMs: 0,
      agentSpeechMs: 0,
      chargeableServiceEndMs: categoryCharge.serviceEndMs,
      appliedBillingGraceMs: categoryCharge.graceMs,
      categoryChargePolicyCode: categoryCharge.policyCode,
      durationMismatch,
      evidenceSha256,
      remarks: 'No detectable speech; no independently verified conversation.',
      disputeRecommended:
        (candidate.connectedDurationMs ?? candidate.claimedDurationMs ?? 0) > 0,
    }
  } else {
    const blocks = mergeTranscriptSegments(transcript.segments)
    let rawClassification: ModelClassification
    try {
      rawClassification = await ai.classify({
        blocks,
        language: transcript.language || 'unknown',
        recordedDurationMs: transcript.durationMs,
        speechDurationMs: transcript.speechMs,
        connectedDurationMs: candidate.connectedDurationMs,
        durationMismatch,
      })
    } catch (error) {
      return {
        callId: candidate.callId,
        artifactId: candidate.artifactId,
        outcome: 'classification_failed',
        errorCode: providerFailureCode('CLASSIFICATION', error) ??
          'CLASSIFICATION_MODEL_FAILED',
      }
    }
    let classification: ModelClassification
    try {
      classification = validateClassification(
        rawClassification,
        blocks,
        transcript.durationMs,
        { durationMismatch },
      )
    } catch {
      try {
        classification = validateClassification(
          repairClassification(rawClassification, blocks, {
            durationMismatch,
          }),
          blocks,
          transcript.durationMs,
          { durationMismatch },
        )
      } catch {
        return {
          callId: candidate.callId,
          artifactId: candidate.artifactId,
          outcome: 'classification_failed',
          errorCode: 'CLASSIFICATION_OUTPUT_UNRECOVERABLE',
        }
      }
    }
    modelClassification = classification
    const roleSpeech = speechByRole(blocks, classification)
    const categoryCharge = resolveCategoryCharge({
      category: classification.category,
      recordedDurationMs: transcript.durationMs,
      lastCustomerExchangeMs:
        classification.lastMeaningfulCustomerExchangeMs,
      lastAgentExchangeMs:
        classification.lastMeaningfulAgentExchangeMs ?? null,
      lastVoicemailExchangeMs:
        classification.lastVoicemailExchangeMs ?? null,
      lastBusinessRelevantCustomerExchangeMs:
        classification.lastBusinessRelevantCustomerExchangeMs ?? null,
      lastVerifiedInteractionMs:
        classification.lastVerifiedInteractionMs ?? null,
    })
    analysis = {
      category: classification.category,
      confidence: classification.confidence,
      language: transcript.language || 'unknown',
      recordedDurationMs: transcript.durationMs,
      speechDurationMs: transcript.speechMs,
      conversationAssessment: classification.customerSpoke
        ? 'established'
        : 'no_meaningful_exchange',
      lastMeaningfulCustomerExchangeMs:
        classification.lastMeaningfulCustomerExchangeMs,
      ...roleSpeech,
      chargeableServiceEndMs: categoryCharge.serviceEndMs,
      appliedBillingGraceMs: categoryCharge.graceMs,
      categoryChargePolicyCode: categoryCharge.policyCode,
      durationMismatch,
      evidenceSha256,
      remarks: classification.remarks,
      disputeRecommended: classification.disputeRecommended,
    }
  }

  return {
    callId: candidate.callId,
    artifactId: candidate.artifactId,
    outcome: 'projected',
    analysis,
    transcription: transcript,
    classification:
      transcript.segments.length === 0 || !transcript.text.trim()
        ? {
            model: {
              provider: 'openai',
              name: 'deterministic-no-speech',
              version: REAUDIT_ENGINE_VERSION,
            },
            category: 'INACTIVE_CALL',
            confidence: '1.00000000',
            customerBlockNumbers: [],
            unclearBlockNumbers: [],
            customerSpoke: false,
            lastMeaningfulCustomerExchangeMs: null,
            remarks: analysis.remarks,
            disputeRecommended: analysis.disputeRecommended,
          }
        : (modelClassification as ModelClassification),
    projection: projectVerifiedCharge(analysis),
  }
}
