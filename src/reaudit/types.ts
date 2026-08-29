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
  customerSpoke: boolean
  lastMeaningfulCustomerExchangeMs: number | null
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
