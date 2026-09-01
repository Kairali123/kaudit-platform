export const REAUDIT_CATEGORIES = [
  'TIME_DURATION',
  'AGENT_FAILURE',
  'CONNECT_NOT_FRUITFUL',
  'INACTIVE_CALL',
  'INCORRECT_CALL_DURATION',
  'AI_CONVERSATION_HANDLING',
  'VOICEMAIL',
  'AI_TO_AI',
  'NETWORK_FAILURE_TELECOM',
  'USER_SILENCE',
  'JUNK_CALL',
  'OK',
] as const

export type ReauditCategory = (typeof REAUDIT_CATEGORIES)[number]

export interface ReauditCandidate {
  callId: string
  artifactId: string
  sourceUrl: string
  baselineSha256: string | null
  claimedDurationMs: number | null
  connectedDurationMs: number | null
  vendorBilledMinutes: string | null
  /**
   * Present ONLY for an administrator-requested re-audit claimed from the
   * durable queue. Its presence is what tells the writer to settle the queue
   * item and to check the baseline before spending on a model.
   */
  manualRequest?: {
    requestId: string
    itemId: string
    /** The call's current audit run when the administrator selected the row. */
    baselineAuditRunId: string
  }
}

export interface TranscriptSegment {
  startMs: number
  endMs: number
  text: string
}

export interface AiUsage {
  inputTokens: number | null
  outputTokens: number | null
  totalTokens: number | null
  audioSeconds: number | null
  requestId: string | null
}

export interface TranscriptionResult {
  model: {
    provider: 'openai'
    name: 'whisper-1'
    version: 'whisper-1'
  }
  language: string
  durationMs: number
  speechMs: number
  text: string
  segments: TranscriptSegment[]
  usage?: AiUsage
}

export interface NaturalSpeechBlock {
  number: number
  startMs: number
  endMs: number
  text: string
}

export interface ClassificationDecisionSignals {
  counterpartyType:
    | 'human'
    | 'voicemail'
    | 'interactive_automation'
    | 'no_response'
    | 'unclear'
  agentHandling: 'normal' | 'failed' | 'unclear'
  conversationOutcome: 'successful' | 'no_outcome' | 'unclear'
  durationOutcome:
    | 'appropriate'
    | 'ended_too_early'
    | 'continued_without_value'
    | 'unclear'
  /** Required from live classifiers; absent only on durable legacy results. */
  stopIntent?:
    | 'none'
    | 'busy_or_bad_time'
    | 'callback_or_defer'
    | 'decline_or_end'
  /** Required from live classifiers; absent only on durable legacy results. */
  postStopBehavior?:
    | 'not_applicable'
    | 'appropriate_close'
    | 'administrative_extension'
    | 'continued_sales_flow'
    | 'unclear'
  /** Required from live classifiers; absent only on durable legacy results. */
  successfulOutcome?:
    | 'none'
    | 'qualified'
    | 'handoff_or_transfer'
    | 'resolved'
  /** Required from live classifiers; absent only on durable legacy results. */
  voicemailEvidence?:
    | 'fixed_greeting'
    | 'leave_message_request'
    | 'mailbox_notice'
    | 'recording_notice'
    | 'beep'
    | 'none'
  /** Required from live classifiers; absent only on durable legacy results. */
  automationEvidence?:
    | 'menu_prompt'
    | 'virtual_assistant_disclosure'
    | 'screening_prompt'
    | 'none'
  /** Required from live classifiers; absent only on durable legacy results. */
  junkEvidence?:
    | 'test_call'
    | 'spam_or_scam'
    | 'prank_or_illegitimate_purpose'
    | 'none'
}

export interface ModelClassification {
  model: {
    provider: 'openai'
    name: string
    version: string
  }
  category: ReauditCategory
  confidence: string
  customerBlockNumbers: number[]
  unclearBlockNumbers: number[]
  /** Transcript blocks containing affirmative voicemail evidence. */
  voicemailEvidenceBlockNumbers?: number[]
  /** Transcript blocks containing affirmative interactive-automation evidence. */
  automationEvidenceBlockNumbers?: number[]
  /** Transcript blocks containing affirmative test, spam, or illegitimate-purpose evidence. */
  junkEvidenceBlockNumbers?: number[]
  /** Customer blocks that establish a meaningful Kairali business interaction. */
  businessRelevantCustomerBlockNumbers?: number[]
  customerSpoke: boolean
  lastMeaningfulCustomerExchangeMs: number | null
  /** Deterministically derived from attributed transcript blocks. */
  lastMeaningfulAgentExchangeMs?: number | null
  /** Deterministically derived from affirmative voicemail evidence blocks. */
  lastVoicemailExchangeMs?: number | null
  /** Deterministically derived from reviewed business-relevant customer blocks. */
  lastBusinessRelevantCustomerExchangeMs?: number | null
  /** Latest non-unclear interaction block, independent of speaker role. */
  lastVerifiedInteractionMs?: number | null
  remarks: string
  disputeRecommended: boolean
  /** Required from live classifiers; optional for durable legacy results. */
  decisionSignals?: ClassificationDecisionSignals
  usage?: AiUsage
}

export interface ReauditAnalysis {
  category: ReauditCategory
  confidence: string
  language: string
  recordedDurationMs: number
  speechDurationMs: number
  conversationAssessment:
    | 'established'
    | 'no_meaningful_exchange'
    | 'unresolved'
  lastMeaningfulCustomerExchangeMs: number | null
  customerSpeechMs: number
  agentSpeechMs: number
  chargeableServiceEndMs: number
  appliedBillingGraceMs: number
  categoryChargePolicyCode: string
  durationMismatch: boolean
  evidenceSha256: string
  remarks: string
  disputeRecommended: boolean
}

export interface ReauditProjection {
  amount: string
  amountPaise: bigint
  billableMinutes: string
  billableDurationMs: number
  adjustedChargeableDurationMs: number
  oneWayTailMs: number
  oneWayTailAlert: boolean
  categoryChargePolicyCode: string
  ruleCode:
    | 'ZERO_DURATION_NOT_BILLED'
    | 'SHORT_CALL_FLAT'
    | 'PER_MINUTE_CEIL'
  authority: 'provisional_uncalibrated'
}

export interface ReauditItemResult {
  callId: string
  artifactId: string
  outcome:
    | 'projected'
    | 'source_missing'
    | 'evidence_altered'
    | 'unsafe_url'
    | 'transcription_failed'
    | 'classification_failed'
    | 'spend_state_unknown'
  analysis?: ReauditAnalysis
  transcription?: TranscriptionResult
  classification?: ModelClassification
  projection?: ReauditProjection
  errorCode?: string
}

export interface ReauditAi {
  transcribe(
    bytes: Buffer,
    options: { contentType: string },
  ): Promise<TranscriptionResult>
  classify(options: {
    blocks: NaturalSpeechBlock[]
    language: string
    recordedDurationMs: number
    speechDurationMs: number
    connectedDurationMs: number | null
    durationMismatch: boolean
  }): Promise<ModelClassification>
}
