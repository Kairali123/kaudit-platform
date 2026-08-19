import {
  canonicalJson,
  canonicalJsonSha256,
  type JsonValue,
} from '../messaging/canonicalJson.ts'
import {
  KSERVE_BILLING_ENGINE_VERSION,
  KSERVE_RATE_PER_MINUTE_PAISE,
  KSERVE_RULESET_SHA256,
  KSERVE_RULESET_VERSION,
} from './kserveRules.ts'
import type {
  AutomatedDecisionRecord,
  BillingCalculationRecord,
  BillingComponentRecord,
  VerifiedBillingRecords,
} from './records.ts'
import type {
  EvidenceHashReference,
  PublishedRateCard,
} from './types.ts'

const SCALE = 100_000_000n
const HALF_MINUTE = 50_000_000n
const SHA256 = /^[a-f0-9]{64}$/

export const ACCEPTED_AS_BILLED_RULESET = {
  schemaVersion: '1',
  rule: 'accepted_as_billed_unverified',
  triggers: [
    'no_recording_after_automatic_retry_window',
    'automated_validation_unresolved_at_cycle_close',
  ],
  amount:
    'vendor-supplied billed amount when present; otherwise vendor billed minutes multiplied by the locked rate',
  authority:
    'cycle-close deterministic fallback; not an independent AI audit',
} satisfies JsonValue

export const ACCEPTED_AS_BILLED_RULESET_VERSION =
  'cycle-close-fallback/1.2.0'
export const ACCEPTED_AS_BILLED_RULESET_SHA256 =
  canonicalJsonSha256(ACCEPTED_AS_BILLED_RULESET)

export interface AcceptedAsBilledInput {
  callId: string
  auditRunId?: string | null
  fallbackReason?:
    | 'no_recording'
    | 'automated_validation_unresolved'
  claimedDurationMs: number | null
  connectedDurationMs: number | null
  vendorBilledMinutes: string
  vendorBilledAmount?: string | null
  sourceEvidence: EvidenceHashReference
  decidedAt: string
}

function decimalScale8(value: string): bigint {
  if (!/^\d+(?:\.\d{1,8})?$/.test(value)) {
    throw new TypeError('vendorBilledMinutes must be a positive scale-8 decimal')
  }
  const [whole, fraction = ''] = value.split('.')
  return (
    BigInt(whole) * SCALE +
    BigInt((fraction + '00000000').slice(0, 8))
  )
}

function fixed8(value: bigint): string {
  return `${value / SCALE}.${(value % SCALE)
    .toString()
    .padStart(8, '0')}`
}

function validateRateCard(rateCard: PublishedRateCard): void {
  if (
    rateCard.status !== 'published' ||
    !rateCard.approvedBy ||
    !rateCard.approvedAt ||
    rateCard.currency !== 'INR' ||
    rateCard.rulesetSha256 !== KSERVE_RULESET_SHA256
  ) {
    throw new Error(
      'D-03: accepted-as-billed fallback requires the same formally published rate card as independent billing',
    )
  }
}

export function buildAcceptedAsBilledRecords(
  input: AcceptedAsBilledInput,
  rateCard: PublishedRateCard,
): VerifiedBillingRecords {
  validateRateCard(rateCard)
  if (!input.callId.trim()) throw new TypeError('callId is required')
  if (!SHA256.test(input.sourceEvidence.sha256)) {
    throw new TypeError('source evidence must carry a SHA-256 hash')
  }
  if (Number.isNaN(Date.parse(input.decidedAt))) {
    throw new TypeError('decidedAt must be an ISO timestamp')
  }
  const minuteScale = decimalScale8(input.vendorBilledMinutes)
  if (minuteScale % HALF_MINUTE !== 0n) {
    throw new Error(
      'Vendor billed minutes must use the locked 0.5-minute increments',
    )
  }
  const billableDurationMs = Number(
    (minuteScale * 60_000n) / SCALE,
  )
  const suppliedAmountScale = input.vendorBilledAmount == null
    ? null
    : decimalScale8(input.vendorBilledAmount)
  const amountPaise = (minuteScale * KSERVE_RATE_PER_MINUTE_PAISE) / SCALE
  const legacyAmountScale = amountPaise * 1_000_000n
  if (
    !Number.isSafeInteger(billableDurationMs) ||
    amountPaise * SCALE !==
      minuteScale * KSERVE_RATE_PER_MINUTE_PAISE
  ) {
    throw new Error('Vendor quantity cannot be represented exactly')
  }
  const amountScale = suppliedAmountScale ?? legacyAmountScale
  const amount = fixed8(amountScale)
  const vendorAmountSource = suppliedAmountScale == null
    ? 'legacy_rate_derived'
    : 'vendor_supplied'
  const evidence = [input.sourceEvidence]
  const evidenceManifestSha256 = canonicalJsonSha256(
    evidence as unknown as JsonValue,
  )
  const inputManifestSha256 = canonicalJsonSha256({
    callId: input.callId,
    vendorBilledMinutes: fixed8(minuteScale),
    vendorBilledAmount: amount,
    vendorAmountSource,
    claimedDurationMs: input.claimedDurationMs,
    connectedDurationMs: input.connectedDurationMs,
    fallbackReason: input.fallbackReason ?? 'no_recording',
    evidenceManifestSha256,
    fallbackRulesetSha256: ACCEPTED_AS_BILLED_RULESET_SHA256,
    billingRulesetSha256: KSERVE_RULESET_SHA256,
  } as JsonValue)
  const fallbackReason = input.fallbackReason ?? 'no_recording'
  const reasonCode =
    fallbackReason === 'automated_validation_unresolved'
      ? 'AUTOMATED_VALIDATION_UNRESOLVED_ACCEPTED_AS_BILLED'
      : 'NO_RECORDING_ACCEPTED_AS_BILLED'
  const trace = {
    schemaVersion: '1',
    decisionType: 'verified_call_billing',
    calculationBasis: 'accepted_as_billed_unverified',
    warning:
      fallbackReason === 'automated_validation_unresolved'
        ? 'Automated validation remained unresolved at cycle close; the KServe claim was accepted without an independently verified duration.'
        : 'No recording was available; the KServe claim was accepted without independent verification.',
    callId: input.callId,
    rateCardId: rateCard.id,
    rateCardVersion: rateCard.version,
    engineVersion: KSERVE_BILLING_ENGINE_VERSION,
    rulesetVersion: KSERVE_RULESET_VERSION,
    rulesetSha256: KSERVE_RULESET_SHA256,
    fallbackRulesetVersion: ACCEPTED_AS_BILLED_RULESET_VERSION,
    fallbackRulesetSha256: ACCEPTED_AS_BILLED_RULESET_SHA256,
    evidence: evidence as unknown as JsonValue,
    evidenceManifestSha256,
    inputManifestSha256,
    vendorBilledMinutes: fixed8(minuteScale),
    vendorBilledAmount: amount,
    vendorAmountSource,
    billableDurationMs,
    amount,
    currency: 'INR',
    outcome: {
      status: 'final',
      reasonCode,
    },
    decidedAt: input.decidedAt,
  } satisfies JsonValue
  const decisionOutputJson = canonicalJson(trace)
  const decisionOutputSha256 = canonicalJsonSha256(trace)
  const calculation: BillingCalculationRecord = {
    callId: input.callId,
    rateCardVersionId: rateCard.id,
    auditRunId: input.auditRunId ?? null,
    engineVersion: KSERVE_BILLING_ENGINE_VERSION,
    inputManifestSha256,
    status: 'final',
    calculationBasis: 'accepted_as_billed_unverified',
    claimedDurationMs: input.claimedDurationMs,
    connectedDurationMs: input.connectedDurationMs,
    recordedDurationMs: null,
    speechDurationMs: null,
    conversationEndMs: null,
    wrapUpGraceMs: null,
    adjustedChargeableDurationMs: null,
    billableDurationMs,
    oneWayTailMs: null,
    oneWayTailAlert: null,
    subtotalAmount: amount,
    taxAmount: '0.00000000',
    totalAmount: amount,
    currency: 'INR',
    rulesetSha256: KSERVE_RULESET_SHA256,
    decisionTraceJson: decisionOutputJson,
    decisionTraceSha256: decisionOutputSha256,
    calculatedAt: input.decidedAt,
    finalizedAt: input.decidedAt,
  }
  const component: BillingComponentRecord = {
    componentType: 'platform',
    ruleCode: 'ACCEPTED_AS_BILLED_UNVERIFIED',
    rawQuantity: suppliedAmountScale == null
      ? fixed8(minuteScale)
      : amount,
    rawUnit: suppliedAmountScale == null ? 'minute' : 'INR',
    billableQuantity: suppliedAmountScale == null
      ? fixed8(minuteScale)
      : amount,
    billingIncrement: suppliedAmountScale == null
      ? 'vendor_0.5_min'
      : 'vendor_asserted_amount',
    unitRate: suppliedAmountScale == null ? '9.50000000' : '1.00000000',
    subtotalAmount: amount,
    taxAmount: '0.00000000',
    totalAmount: amount,
    currency: 'INR',
    resultStatus: 'final',
    explanationJson: decisionOutputJson,
  }
  const decision: AutomatedDecisionRecord = {
    callId: input.callId,
    auditRunId: input.auditRunId ?? null,
    decisionType: 'verified_call_billing',
    decisionStatus: 'final',
    reasonCode,
    nextAction: null,
    sensitivityTier: 'K0',
    languageCode: 'unknown',
    findingType:
      fallbackReason === 'automated_validation_unresolved'
        ? 'AUTOMATED_VALIDATION_UNRESOLVED'
        : 'NO_RECORDING',
    decisionEngineName: 'kserve-verified-billing',
    decisionEngineVersion: KSERVE_BILLING_ENGINE_VERSION,
    modelProvider: 'none',
    modelName: 'deterministic-cycle-close-fallback',
    modelVersion: ACCEPTED_AS_BILLED_RULESET_VERSION,
    rulesetVersion: KSERVE_RULESET_VERSION,
    rulesetSha256: KSERVE_RULESET_SHA256,
    classifierRulesetVersion: ACCEPTED_AS_BILLED_RULESET_VERSION,
    classifierRulesetSha256: ACCEPTED_AS_BILLED_RULESET_SHA256,
    calibrationVersion: null,
    confidence: '1.00000000',
    confidenceThreshold: '1.00000000',
    evidenceManifestSha256,
    evidenceRefsJson: canonicalJson(evidence as unknown as JsonValue),
    inputManifestSha256,
    decisionOutputJson,
    decisionOutputSha256,
    recheckAttempt:
      fallbackReason === 'automated_validation_unresolved' ? 3 : 0,
    decidedAt: input.decidedAt,
  }
  return { calculation, component, decision }
}
