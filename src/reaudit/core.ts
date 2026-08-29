import {
  KSERVE_ONE_WAY_TAIL_ALERT_MS,
  KSERVE_WRAP_UP_GRACE_MS,
} from '../billing/kserveRules.ts'
import { roundKServeChargeableDuration } from '../billing/calculateVerifiedCharge.ts'
import { sha256Hex } from '../lib/hash.ts'
import { isSafeVendorUrl } from '../security/urlSafety.ts'
import type { UrlFetcher } from '../storage/ports.ts'
import type {
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

export const REAUDIT_ENGINE_VERSION = 'kairali-independent-reaudit/2.1.0'
export const REAUDIT_CLASSIFIER_RULESET_VERSION = 'kairali-12cat/2.3.0'
export const DURATION_TOLERANCE_MS = 5_000
export const MERGE_GAP_MS = 1_000
export const MERGE_MAX_BLOCK_MS = 15_000
export const MERGE_MAX_BLOCK_CHARS = 250

const decimal = /^(0|1)(?:\.\d{1,8})?$/

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
  const customerBlocks = new Set(customerBlockNumbers)
  const unclearBlocks = new Set(unclearBlockNumbers)
  if (customerBlockNumbers.some((number) => unclearBlocks.has(number))) {
    throw new Error('Customer and unclear speech blocks must not overlap')
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
  if (last != null && last > recordedDurationMs) {
    throw new Error('Customer block end falls outside the recording')
  }
  if (raw.category === 'USER_SILENCE') {
    if (customerBlockNumbers.length > 0) {
      throw new Error('User-silence result cannot contain customer speech')
    }
    const agentBlockCount = blocks.filter(
      (block) =>
        !customerBlocks.has(block.number) &&
        !unclearBlocks.has(block.number),
    ).length
    if (agentBlockCount === 0) {
      throw new Error(
        'User-silence result requires positively identified agent speech',
      )
    }
  }
  return {
    ...raw,
    customerBlockNumbers,
    unclearBlockNumbers,
    customerSpoke,
    lastMeaningfulCustomerExchangeMs: last,
    remarks: raw.remarks.trim().slice(0, 2_000),
  }
}

function speechByRole(
  blocks: NaturalSpeechBlock[],
  classification: ModelClassification,
): { customerSpeechMs: number; agentSpeechMs: number } {
  const customer = new Set(classification.customerBlockNumbers)
  const unclear = new Set(classification.unclearBlockNumbers)
  let customerSpeechMs = 0
  let agentSpeechMs = 0
  for (const block of blocks) {
    const duration = Math.max(0, block.endMs - block.startMs)
    if (customer.has(block.number)) customerSpeechMs += duration
    else if (!unclear.has(block.number)) agentSpeechMs += duration
  }
  return { customerSpeechMs, agentSpeechMs }
}

export function projectVerifiedCharge(
  analysis: ReauditAnalysis,
): ReauditProjection {
  const end =
    analysis.conversationAssessment === 'established'
      ? (analysis.lastMeaningfulCustomerExchangeMs as number)
      : 0
  const adjusted =
    analysis.conversationAssessment === 'established'
      ? Math.min(
          analysis.recordedDurationMs,
          end + KSERVE_WRAP_UP_GRACE_MS,
        )
      : 0
  const rounded = roundKServeChargeableDuration(adjusted)
  const oneWayTailMs = Math.max(0, analysis.recordedDurationMs - adjusted)
  return {
    amount: rounded.amount,
    amountPaise: rounded.amountPaise,
    billableMinutes: rounded.billableMinutes,
    billableDurationMs: rounded.billableDurationMs,
    adjustedChargeableDurationMs: adjusted,
    oneWayTailMs,
    oneWayTailAlert: oneWayTailMs > KSERVE_ONE_WAY_TAIL_ALERT_MS,
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
