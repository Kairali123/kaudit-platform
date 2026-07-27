import type { JsonValue } from '../messaging/canonicalJson.ts'

export type SensitivityTier = 'K0' | 'K1' | 'K2' | 'K3'
export type ConversationAssessment =
  | 'established'
  | 'no_meaningful_exchange'
  | 'unresolved'

export interface PublishedRateCard {
  id: string
  version: string
  status: string
  currency: 'INR'
  rulesetSha256: string | null
  approvedBy: string | null
  approvedAt: string | null
}

export interface EvidenceHashReference {
  kind: 'audio' | 'transcript' | 'media_analysis' | 'call_manifest'
  sha256: string
  referenceId: string
}

export interface ModelIdentity {
  provider: string
  name: string
  version: string
}

export interface AutomationAuthority {
  calibrationVersion: string | null
  calibrationComplete: boolean
  confidence: string
  threshold: string | null
  language: string
  findingType: string
  /** Legacy classification metadata only; it never changes automation authority. */
  sensitivityTier: SensitivityTier
  recheckAttempt: number
  maximumRechecks: number
}

export interface VerifiedBillingInput {
  callId: string
  auditRunId: string
  claimedDurationMs: number | null
  connectedDurationMs: number | null
  recordedDurationMs: number
  speechDurationMs: number | null
  conversationAssessment: ConversationAssessment
  lastMeaningfulCustomerExchangeMs: number | null
  model: ModelIdentity
  classifierRulesetVersion: string
  classifierRulesetSha256: string
  evidence: EvidenceHashReference[]
  authority: AutomationAuthority
  calculatedAt: string
}

export type BillingUnresolvedReason =
  | 'CALIBRATION_NOT_COMPLETED'
  | 'THRESHOLD_NOT_CONFIGURED'
  | 'LOW_CONFIDENCE_RECHECK_REQUIRED'
  | 'LOW_CONFIDENCE_RECHECK_EXHAUSTED'
  | 'CONVERSATION_ASSESSMENT_UNRESOLVED'

export type BillingNextAction =
  | 'await_calibration'
  | 'configure_threshold'
  | 'retry_with_secondary_model'
  | 'hold_unresolved_until_cycle_close'
  | 'retry_conversation_assessment'

export interface BillingDecisionTrace {
  schemaVersion: '1'
  decisionType: 'verified_call_billing'
  engineVersion: string
  rulesetVersion: string
  rulesetSha256: string
  rateCardId: string
  rateCardVersion: string
  callId: string
  auditRunId: string
  model: ModelIdentity
  classifierRulesetVersion: string
  classifierRulesetSha256: string
  evidence: EvidenceHashReference[]
  evidenceManifestSha256: string
  inputManifestSha256: string
  authority: AutomationAuthority
  inputs: {
    claimedDurationMs: number | null
    connectedDurationMs: number | null
    recordedDurationMs: number
    speechDurationMs: number | null
    conversationAssessment: ConversationAssessment
    lastMeaningfulCustomerExchangeMs: number | null
  }
  calculation: JsonValue
  outcome: {
    status: 'final' | 'unresolved'
    reasonCode: string
    nextAction: BillingNextAction | null
  }
  decidedAt: string
}

export interface FinalVerifiedBilling {
  status: 'final'
  reasonCode: 'AUTOMATED_CONFIDENCE_CONFIRMED'
  nextAction: null
  adjustedChargeableDurationMs: number
  billableDurationMs: number
  billableMinutes: string
  amount: string
  amountPaise: bigint
  currency: 'INR'
  ruleCode:
    | 'ZERO_DURATION_NOT_BILLED'
    | 'SHORT_CALL_FLAT'
    | 'PER_MINUTE_CEIL'
  oneWayTailMs: number
  oneWayTailAlert: boolean
  inputManifestSha256: string
  evidenceManifestSha256: string
  traceSha256: string
  trace: BillingDecisionTrace
}

export interface UnresolvedVerifiedBilling {
  status: 'unresolved'
  reasonCode: BillingUnresolvedReason
  nextAction: BillingNextAction
  inputManifestSha256: string
  evidenceManifestSha256: string
  traceSha256: string
  trace: BillingDecisionTrace
}

export type VerifiedBillingResult =
  | FinalVerifiedBilling
  | UnresolvedVerifiedBilling
