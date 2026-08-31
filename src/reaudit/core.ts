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

export const REAUDIT_ENGINE_VERSION = 'kairali-independent-reaudit/2.5.0'
export const REAUDIT_CLASSIFIER_RULESET_VERSION = 'kairali-12cat/2.7.0'
export const DURATION_TOLERANCE_MS = 5_000
export const MERGE_GAP_MS = 1_000
export const MERGE_MAX_BLOCK_MS = 15_000
export const MERGE_MAX_BLOCK_CHARS = 250

const decimal = /^(0|1)(?:\.\d{1,8})?$/

/**
 * Positive voicemail language only. Silence, an agent introduction, and a
 * request for the customer's name intentionally match none of these cues.
 * The model still handles language and meaning; this bounded multilingual
 * check prevents an unsupported evidence-block assertion from becoming fact.
 */
const AFFIRMATIVE_VOICEMAIL_CUE =
  /\b(?:voice\s*mail|mailbox|beep|after (?:the )?(?:tone|beep)|at the tone|leave (?:a |your )?message|record (?:a |your |the )?message|you(?:'ve| have) reached|is not available|cannot (?:take|answer) (?:your )?call|(?:message|recording) (?:has been |is )?(?:recorded|complete(?:d)?|finished|ended)|you (?:may|can) (?:now )?hang up)\b|वॉइस\s*मेल|वॉइसमेल|संदेश छोड़|मैसेज छोड़|बीप|टोन के बाद|उपलब्ध नहीं|വോയ്സ്\s*മെയിൽ|വോയ്സ്മെയിൽ|സന്ദേശം|ബീപ്പ്|ലഭ്യമല്ല/iu

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
} as const

function validateDecisionSignals(
  signals: ClassificationDecisionSignals,
): void {
  for (const [name, allowed] of Object.entries(DECISION_SIGNAL_VALUES)) {
    const value = signals[name as keyof ClassificationDecisionSignals]
    if (value === undefined) {
      if (
        name === 'voicemailEvidence' ||
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
  voicemailEvidenceBlockCount?: number
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
  if (signals.counterpartyType === 'interactive_automation') return 'AI_TO_AI'
  if (signals.counterpartyType === 'no_response') {
    return 'USER_SILENCE'
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
  const customerBlockNumbers = normalizeBlocks(raw.customerBlockNumbers)
  const unclearBlockNumbers = normalizeBlocks(raw.unclearBlockNumbers)
  const voicemailEvidenceBlockNumbers = normalizeBlocks(
    raw.voicemailEvidenceBlockNumbers ?? [],
  ).filter((number) => {
    const block = blocks.find((candidate) => candidate.number === number)
    return block != null && AFFIRMATIVE_VOICEMAIL_CUE.test(block.text)
  })
  const businessRelevantCustomerBlockNumbers = normalizeBlocks(
    raw.businessRelevantCustomerBlockNumbers ?? [],
  )
  const customerBlocks = new Set(customerBlockNumbers)
  const unclearBlocks = new Set(unclearBlockNumbers)
  const voicemailEvidenceBlocks = new Set(voicemailEvidenceBlockNumbers)
  const businessRelevantCustomerBlocks = new Set(
    businessRelevantCustomerBlockNumbers,
  )
  if (customerBlockNumbers.some((number) => unclearBlocks.has(number))) {
    throw new Error('Customer and unclear speech blocks must not overlap')
  }
  if (
    voicemailEvidenceBlockNumbers.some(
      (number) => customerBlocks.has(number) || unclearBlocks.has(number),
    )
  ) {
    throw new Error(
      'Voicemail evidence blocks must be separate from customer and unclear speech',
    )
  }
  if (
    businessRelevantCustomerBlockNumbers.some(
      (number) => !customerBlocks.has(number),
    )
  ) {
    throw new Error(
      'Business-relevant customer blocks must also be customer blocks',
    )
  }
  // The model identifies roles; the engine owns the resulting time fact. This
  // avoids rejecting a valid role assignment because a model repeated a
  // displayed, rounded timestamp that differed from the source block by a few
  // milliseconds.
  const customerEnds = blocks
    .filter((block) => customerBlocks.has(block.number))
    .map((block) => block.endMs)
  const customerSpoke = customerEnds.length > 0
  const last = customerEnds.length > 0 ? Math.max(...customerEnds) : null
  const agentEnds = blocks
    .filter(
      (block) =>
        !customerBlocks.has(block.number) &&
        !unclearBlocks.has(block.number) &&
        !voicemailEvidenceBlocks.has(block.number),
    )
    .map((block) => block.endMs)
  const voicemailEnds = blocks
    .filter((block) => voicemailEvidenceBlocks.has(block.number))
    .map((block) => block.endMs)
  const businessEnds = blocks
    .filter((block) => businessRelevantCustomerBlocks.has(block.number))
    .map((block) => block.endMs)
  const verifiedEnds = blocks
    .filter((block) => !unclearBlocks.has(block.number))
    .map((block) => block.endMs)
  if (last != null && last > recordedDurationMs) {
    throw new Error('Customer block end falls outside the recording')
  }
  const category = resolveReviewedCategory({
    proposedCategory: raw.category,
    decisionSignals: raw.decisionSignals,
    customerBlockCount: customerBlockNumbers.length,
    voicemailEvidenceBlockCount: voicemailEvidenceBlockNumbers.length,
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
        !voicemailEvidenceBlocks.has(block.number),
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
    unclearBlockNumbers,
    voicemailEvidenceBlockNumbers,
    businessRelevantCustomerBlockNumbers,
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
      raw.decisionSignals?.counterpartyType === 'voicemail' &&
      category === 'USER_SILENCE'
        ? 'Agent speech was identified, but no customer or affirmative voicemail evidence was identified; this is user silence.'
        : raw.remarks.trim().slice(0, 2_000),
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
  let customerSpeechMs = 0
  let agentSpeechMs = 0
  for (const block of blocks) {
    const duration = Math.max(0, block.endMs - block.startMs)
    if (customer.has(block.number)) customerSpeechMs += duration
    else if (
      !unclear.has(block.number) &&
      !voicemailEvidence.has(block.number)
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
  } catch {
    return {
      callId: candidate.callId,
      artifactId: candidate.artifactId,
      outcome: 'transcription_failed',
      errorCode: 'TRANSCRIPTION_FAILED',
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
    let classification: ModelClassification
    try {
      classification = validateClassification(
        await ai.classify({
          blocks,
          language: transcript.language || 'unknown',
          recordedDurationMs: transcript.durationMs,
          speechDurationMs: transcript.speechMs,
          connectedDurationMs: candidate.connectedDurationMs,
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
        errorCode: 'CLASSIFICATION_FAILED',
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
