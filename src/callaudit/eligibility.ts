import type {
  CallAuditAssessment,
  CallAuditClassification,
  CallIntent,
  MetricScoreEntry,
} from './types.ts'

/** True when the transcript holds at least one non-whitespace character. */
export function hasAuditableTranscript(
  transcript: string | null | undefined,
): boolean {
  return typeof transcript === 'string' && transcript.trim() !== ''
}

/**
 * A non-blank transcript makes a call content-auditable. A missing or
 * whitespace-only transcript limits the call to an operational-only audit.
 */
export function classifyEligibility(
  transcript: string | null | undefined,
): CallAuditClassification {
  if (hasAuditableTranscript(transcript)) {
    return { eligibility: 'content_auditable' }
  }
  return { eligibility: 'operational_only', reason: 'missing_transcript' }
}

/**
 * Builds the assessment for one call. Quality scores and intent are attached
 * only when the call is content-auditable; scores supplied for an
 * operational-only call are dropped rather than recorded.
 */
export function assessCall(input: {
  transcript: string | null | undefined
  intent: CallIntent
  scores: readonly MetricScoreEntry[]
}): CallAuditAssessment {
  const classification = classifyEligibility(input.transcript)
  if (classification.eligibility === 'operational_only') {
    return classification
  }
  return {
    eligibility: 'content_auditable',
    intent: input.intent,
    scores: input.scores,
  }
}
