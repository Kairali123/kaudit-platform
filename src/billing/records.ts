import {
  canonicalJson,
  type JsonValue,
} from '../messaging/canonicalJson.ts'
import {
  KSERVE_BILLING_ENGINE_VERSION,
  KSERVE_RULESET_SHA256,
  KSERVE_RULESET_VERSION,
  KSERVE_WRAP_UP_GRACE_MS,
} from './kserveRules.ts'
import type {
  PublishedRateCard,
  VerifiedBillingInput,
  VerifiedBillingResult,
} from './types.ts'

export interface BillingCalculationRecord {
  callId: string
  rateCardVersionId: string
  auditRunId: string
  engineVersion: string
  inputManifestSha256: string
  status: 'final'
  calculationBasis: 'independent_conversation_end'
  claimedDurationMs: number | null
  connectedDurationMs: number | null
  recordedDurationMs: number
  speechDurationMs: number | null
  conversationEndMs: number
  wrapUpGraceMs: number
  adjustedChargeableDurationMs: number
  billableDurationMs: number
  oneWayTailMs: number
  oneWayTailAlert: boolean
  subtotalAmount: string
  taxAmount: '0.00000000'
  totalAmount: string
  currency: 'INR'
  rulesetSha256: string
  decisionTraceJson: string
  decisionTraceSha256: string
  calculatedAt: string
  finalizedAt: string
}

export interface BillingComponentRecord {
  componentType: 'platform'
  ruleCode: string
  rawQuantity: string
  rawUnit: 'millisecond'
  billableQuantity: string
  billingIncrement: string
  unitRate: '9.50000000'
  subtotalAmount: string
  taxAmount: '0.00000000'
  totalAmount: string
  currency: 'INR'
  resultStatus: 'final'
  explanationJson: string
}

export interface AutomatedDecisionRecord {
  callId: string
  auditRunId: string
  decisionType: 'verified_call_billing'
  decisionStatus: 'final' | 'unresolved'
  reasonCode: string
  nextAction: string | null
  sensitivityTier: string
  languageCode: string
  findingType: string
  decisionEngineName: 'kserve-verified-billing'
  decisionEngineVersion: string
  modelProvider: string
  modelName: string
  modelVersion: string
  rulesetVersion: string
  rulesetSha256: string
  classifierRulesetVersion: string
  classifierRulesetSha256: string
  calibrationVersion: string | null
  confidence: string
  confidenceThreshold: string | null
  evidenceManifestSha256: string
  evidenceRefsJson: string
  inputManifestSha256: string
  decisionOutputJson: string
  decisionOutputSha256: string
  recheckAttempt: number
  decidedAt: string
}

export interface VerifiedBillingRecords {
  calculation: BillingCalculationRecord | null
  component: BillingComponentRecord | null
  decision: AutomatedDecisionRecord
}

function millisecondsAsDecimal(value: number): string {
  return `${value}.00000000`
}

export function buildVerifiedBillingRecords(
  input: VerifiedBillingInput,
  rateCard: PublishedRateCard,
  result: VerifiedBillingResult,
): VerifiedBillingRecords {
  if (
    result.trace.callId !== input.callId ||
    result.trace.auditRunId !== input.auditRunId ||
    result.trace.rateCardId !== rateCard.id ||
    result.inputManifestSha256 !== result.trace.inputManifestSha256 ||
    result.trace.rulesetSha256 !== KSERVE_RULESET_SHA256
  ) {
    throw new Error('Billing result does not match its input/rate-card identity')
  }
  const decisionOutputJson = canonicalJson(
    result.trace as unknown as JsonValue,
  )
  const evidenceRefsJson = canonicalJson(
    result.trace.evidence as unknown as JsonValue,
  )
  const decision: AutomatedDecisionRecord = {
    callId: input.callId,
    auditRunId: input.auditRunId,
    decisionType: 'verified_call_billing',
    decisionStatus: result.status,
    reasonCode: result.reasonCode,
    nextAction: result.nextAction,
    sensitivityTier: input.authority.sensitivityTier,
    languageCode: input.authority.language,
    findingType: input.authority.findingType,
    decisionEngineName: 'kserve-verified-billing',
    decisionEngineVersion: KSERVE_BILLING_ENGINE_VERSION,
    modelProvider: input.model.provider,
    modelName: input.model.name,
    modelVersion: input.model.version,
    rulesetVersion: KSERVE_RULESET_VERSION,
    rulesetSha256: KSERVE_RULESET_SHA256,
    classifierRulesetVersion: input.classifierRulesetVersion,
    classifierRulesetSha256: input.classifierRulesetSha256,
    calibrationVersion: input.authority.calibrationVersion,
    confidence: input.authority.confidence,
    confidenceThreshold: input.authority.threshold,
    evidenceManifestSha256: result.evidenceManifestSha256,
    evidenceRefsJson,
    inputManifestSha256: result.inputManifestSha256,
    decisionOutputJson,
    decisionOutputSha256: result.traceSha256,
    recheckAttempt: input.authority.recheckAttempt,
    decidedAt: input.calculatedAt,
  }
  if (result.status === 'unresolved') {
    return { calculation: null, component: null, decision }
  }
  const conversationEndMs =
    input.conversationAssessment === 'no_meaningful_exchange'
      ? 0
      : (input.lastMeaningfulCustomerExchangeMs as number)
  const calculation: BillingCalculationRecord = {
    callId: input.callId,
    rateCardVersionId: rateCard.id,
    auditRunId: input.auditRunId,
    engineVersion: KSERVE_BILLING_ENGINE_VERSION,
    inputManifestSha256: result.inputManifestSha256,
    status: 'final',
    calculationBasis: 'independent_conversation_end',
    claimedDurationMs: input.claimedDurationMs,
    connectedDurationMs: input.connectedDurationMs,
    recordedDurationMs: input.recordedDurationMs,
    speechDurationMs: input.speechDurationMs,
    conversationEndMs,
    wrapUpGraceMs: KSERVE_WRAP_UP_GRACE_MS,
    adjustedChargeableDurationMs:
      result.adjustedChargeableDurationMs,
    billableDurationMs: result.billableDurationMs,
    oneWayTailMs: result.oneWayTailMs,
    oneWayTailAlert: result.oneWayTailAlert,
    subtotalAmount: result.amount,
    taxAmount: '0.00000000',
    totalAmount: result.amount,
    currency: result.currency,
    rulesetSha256: KSERVE_RULESET_SHA256,
    decisionTraceJson: decisionOutputJson,
    decisionTraceSha256: result.traceSha256,
    calculatedAt: input.calculatedAt,
    finalizedAt: input.calculatedAt,
  }
  const component: BillingComponentRecord = {
    componentType: 'platform',
    ruleCode: result.ruleCode,
    rawQuantity: millisecondsAsDecimal(
      result.adjustedChargeableDurationMs,
    ),
    rawUnit: 'millisecond',
    billableQuantity: result.billableMinutes,
    billingIncrement:
      result.ruleCode === 'SHORT_CALL_FLAT'
        ? '0.5_min_flat'
        : result.ruleCode === 'ZERO_DURATION_NOT_BILLED'
          ? 'zero'
          : '1_min_ceil',
    unitRate: '9.50000000',
    subtotalAmount: result.amount,
    taxAmount: '0.00000000',
    totalAmount: result.amount,
    currency: result.currency,
    resultStatus: 'final',
    explanationJson: canonicalJson(
      result.trace.calculation,
    ),
  }
  return { calculation, component, decision }
}
