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
  rule: 'cycle_close_unverified_fallback',
  triggers: [
    'no_recording_after_automatic_retry_window',
    'automated_validation_unresolved_at_cycle_close',
    'independent_audit_exhausted_at_cycle_close',
  ],
  amount:
    'zero when no recording exists; otherwise vendor-supplied billed amount when present or vendor billed minutes multiplied by the locked rate',
  authority:
    'cycle-close deterministic fallback; not an independent AI audit',
} satisfies JsonValue

export const ACCEPTED_AS_BILLED_RULESET_VERSION =
  'cycle-close-fallback/1.4.0'

/**
 * Why a call was settled from the vendor's own claim instead of an audit.
 *
 * `audit_exhausted` is deliberately its own reason rather than being folded
 * into `automated_validation_unresolved`. Those are different facts: one says
 * a validation ran and could not resolve; the other says the independent audit
 * pipeline spent its whole retry budget and never produced a result at all.
 * Recording the second as the first would misstate, in the permanent decision
 * record, what the platform actually knew when it accepted the charge.
 */
export type AcceptedAsBilledFallbackReason =
  | 'no_recording'
  | 'automated_validation_unresolved'
  | 'audit_exhausted'
export const ACCEPTED_AS_BILLED_RULESET_SHA256 =
  canonicalJsonSha256(ACCEPTED_AS_BILLED_RULESET)

export interface AcceptedAsBilledInput {
  callId: string
  auditRunId?: string | null
  fallbackReason?: AcceptedAsBilledFallbackReason
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

/**
 * The same D-03 gate independent billing uses.
 *
 * Exported so a cycle-close run can check the published rate card ONCE before
 * it reads a single candidate, instead of discovering the mismatch on the first
 * record it tries to build. It is a check, never a repair: a rate card whose
 * stored hash does not match the locked ruleset must be re-published through
 * the approval path before any money is written against it.
 */
export function validateRateCard(rateCard: PublishedRateCard): void {
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
  const fallbackReason = input.fallbackReason ?? 'no_recording'
  const vendorAssertedAmountScale = suppliedAmountScale ?? legacyAmountScale
  const vendorAssertedAmount = fixed8(vendorAssertedAmountScale)
  const amountScale = fallbackReason === 'no_recording'
    ? 0n
    : vendorAssertedAmountScale
  const amount = fixed8(amountScale)
  const vendorAmountSource = fallbackReason === 'no_recording'
    ? 'no_recording_zero'
    : suppliedAmountScale == null
      ? 'legacy_rate_derived'
      : 'vendor_supplied'
  const evidence = [input.sourceEvidence]
  const evidenceManifestSha256 = canonicalJsonSha256(
    evidence as unknown as JsonValue,
  )
  const inputManifestSha256 = canonicalJsonSha256({
    callId: input.callId,
    vendorBilledMinutes: fixed8(minuteScale),
    vendorBilledAmount: vendorAssertedAmount,
    fallbackAmount: amount,
    vendorAmountSource,
    claimedDurationMs: input.claimedDurationMs,
    connectedDurationMs: input.connectedDurationMs,
    fallbackReason: input.fallbackReason ?? 'no_recording',
    evidenceManifestSha256,
    fallbackRulesetSha256: ACCEPTED_AS_BILLED_RULESET_SHA256,
    billingRulesetSha256: KSERVE_RULESET_SHA256,
  } as JsonValue)
  const reasonCode =
    fallbackReason === 'automated_validation_unresolved'
      ? 'AUTOMATED_VALIDATION_UNRESOLVED_ACCEPTED_AS_BILLED'
      : fallbackReason === 'audit_exhausted'
        ? 'INDEPENDENT_AUDIT_EXHAUSTED_ACCEPTED_AS_BILLED'
        : 'NO_RECORDING_FOUND_ZERO'
  const trace = {
    schemaVersion: '1',
    decisionType: 'verified_call_billing',
    calculationBasis: fallbackReason === 'no_recording'
      ? 'no_recording_zero'
      : 'accepted_as_billed_unverified',
    warning:
      fallbackReason === 'automated_validation_unresolved'
        ? 'Automated validation remained unresolved at cycle close; the KServe claim was accepted without an independently verified duration.'
        : fallbackReason === 'audit_exhausted'
          ? 'The independent audit exhausted its retry budget and produced no result; the KServe claim was accepted without an independently verified duration.'
          : 'No Recording Found',
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
    vendorBilledAmount: vendorAssertedAmount,
    vendorAmountSource,
    billableDurationMs: fallbackReason === 'no_recording'
      ? 0
      : billableDurationMs,
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
    calculationBasis: fallbackReason === 'no_recording'
      ? 'no_recording_zero'
      : 'accepted_as_billed_unverified',
    claimedDurationMs: input.claimedDurationMs,
    connectedDurationMs: input.connectedDurationMs,
    recordedDurationMs: null,
    speechDurationMs: null,
    conversationEndMs: null,
    wrapUpGraceMs: null,
    adjustedChargeableDurationMs: null,
    billableDurationMs: fallbackReason === 'no_recording'
      ? 0
      : billableDurationMs,
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
    // The rule code names the money rule, which is the same accepted-as-billed
    // arithmetic for both non-zero reasons. WHY it was reached is carried by
    // the reason code and finding type, not by re-encoding it here.
    ruleCode: fallbackReason === 'no_recording'
      ? 'NO_RECORDING_ZERO'
      : 'ACCEPTED_AS_BILLED_UNVERIFIED',
    rawQuantity: fallbackReason === 'no_recording'
      ? '0.00000000'
      : suppliedAmountScale == null
        ? fixed8(minuteScale)
        : amount,
    rawUnit: fallbackReason === 'no_recording' || suppliedAmountScale != null
      ? 'INR'
      : 'minute',
    billableQuantity: fallbackReason === 'no_recording'
      ? '0.00000000'
      : suppliedAmountScale == null
        ? fixed8(minuteScale)
        : amount,
    // `kaudit_billing_component_result.billing_increment` is varchar(20).
    // Every label here must fit it; `vendor_asserted_amount` was 22 and could
    // never be written, which is why no accepted-as-billed row carries it.
    billingIncrement: fallbackReason === 'no_recording'
      ? 'no_recording_zero'
      : suppliedAmountScale == null
        ? 'vendor_0.5_min'
        : 'vendor_amount',
    unitRate: fallbackReason === 'no_recording' || suppliedAmountScale != null
      ? '1.00000000'
      : '9.50000000',
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
        : fallbackReason === 'audit_exhausted'
          ? 'INDEPENDENT_AUDIT_EXHAUSTED'
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
    // An exhausted call has already burned the pipeline's own attempt budget,
    // so this record settles it rather than counting another recheck.
    recheckAttempt:
      fallbackReason === 'automated_validation_unresolved' ? 3 : 0,
    decidedAt: input.decidedAt,
  }
  return { calculation, component, decision }
}
