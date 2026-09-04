import {
  canonicalJson,
  canonicalJsonSha256,
  type JsonValue,
} from '../messaging/canonicalJson.ts'
import {
  KSERVE_BILLING_ENGINE_VERSION,
  KSERVE_RULESET_SHA256,
  KSERVE_RULESET_VERSION,
} from './kserveRules.ts'
import { projectAuditedCharge } from './auditedChargeProjection.ts'
import { validateRateCard } from './acceptedAsBilled.ts'
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

/**
 * Settles a call from THIS platform's own audited duration.
 *
 * The amount is not a new measurement: it is the same deterministic projection
 * the Audit Monitor already displays, recomputed from the audit facts already
 * persisted for the call — recorded duration, service endpoint, applied grace —
 * priced with the locked KServe ruleset and capped per call at KServe's own
 * charge. No model is called and no recording is re-read.
 *
 * It is deliberately NOT recorded as `independent_conversation_end`. That basis
 * belongs to the consensus-validated pipeline, where a second opinion has
 * cross-checked the classification that chose the service endpoint. Here the
 * classification is single-pass. The money is the auditor's own and the cap
 * means it can never exceed the vendor's claim, but the record has to say which
 * of the two produced it, or a later reader cannot tell how much scrutiny the
 * number received.
 */

export const AUDITED_PROJECTION_RULESET = {
  schemaVersion: '1',
  rule: 'independent_audited_projection',
  basis:
    'audited chargeable duration priced with the locked KServe ruleset, capped per call at the vendor charge',
  classification:
    'single-pass independent audit; no consensus cross-check was performed',
  authority:
    'deterministic projection over persisted audit facts; not a consensus-validated calculation',
} satisfies JsonValue

export const AUDITED_PROJECTION_RULESET_VERSION =
  'audited-projection/1.0.0'
export const AUDITED_PROJECTION_RULESET_SHA256 = canonicalJsonSha256(
  AUDITED_PROJECTION_RULESET,
)

/** The persisted audit facts this settlement prices. It reads nothing else. */
export interface AuditedProjectionInput {
  callId: string
  auditRunId: string | null
  category: string | null
  recordedDurationMs: number | null
  speechDurationMs: number | null
  serviceEndMs: number | null
  graceMs: number | null
  claimedDurationMs: number | null
  connectedDurationMs: number | null
  /** KServe's own asserted amount, used only as the per-call ceiling. */
  vendorBilledAmount: string | null
  sourceEvidence: EvidenceHashReference
  decidedAt: string
}

const SHA256 = /^[a-f0-9]{64}$/

/**
 * Money at fixed scale-8, always.
 *
 * The shared projection is a DISPLAY helper and returns the shortest form, so a
 * capped amount arrives as `9.5` where an uncapped one is `9.50000000`. Both
 * are the same money, but they are different bytes — and these bytes go into
 * the input manifest and decision-trace hashes. Normalizing here keeps one
 * amount hashing one way whichever path produced it.
 */
function fixed8(value: string): string {
  const match = /^(-?)(\d+)(?:\.(\d*))?$/.exec(value.trim())
  if (!match) throw new TypeError('projected amount is not a decimal')
  return `${match[1]}${match[2]}.${(match[3] ?? '').padEnd(8, '0').slice(0, 8)}`
}

/** Persisted labels, matching the independent path rather than display prose. */
function persistedIncrement(
  ruleCode: 'ZERO_DURATION_NOT_BILLED' | 'SHORT_CALL_FLAT' | 'PER_MINUTE_CEIL',
): string {
  if (ruleCode === 'ZERO_DURATION_NOT_BILLED') return 'zero'
  return ruleCode === 'SHORT_CALL_FLAT' ? '0.5_min_flat' : '1_min_ceil'
}

/**
 * Returns null when the audit produced no usable duration.
 *
 * That is not an error and not a zero: a call whose classification never
 * established a service endpoint has no audited amount at all, and pricing it
 * at zero would assert a measurement nobody made. The caller settles those from
 * the vendor's claim instead.
 */
export function buildAuditedProjectionRecords(
  input: AuditedProjectionInput,
  rateCard: PublishedRateCard,
): VerifiedBillingRecords | null {
  validateRateCard(rateCard)
  if (!input.callId.trim()) throw new TypeError('callId is required')
  if (!SHA256.test(input.sourceEvidence.sha256)) {
    throw new TypeError('source evidence must carry a SHA-256 hash')
  }
  if (Number.isNaN(Date.parse(input.decidedAt))) {
    throw new TypeError('decidedAt must be an ISO timestamp')
  }
  const projection = projectAuditedCharge({
    recordedDurationMs: input.recordedDurationMs,
    serviceEndMs: input.serviceEndMs,
    graceMs: input.graceMs,
    vendorAmount: input.vendorBilledAmount,
  })
  if (!projection) return null

  const evidence = [input.sourceEvidence]
  const evidenceManifestSha256 = canonicalJsonSha256(
    evidence as unknown as JsonValue,
  )
  const inputManifestSha256 = canonicalJsonSha256({
    callId: input.callId,
    category: input.category,
    recordedDurationMs: input.recordedDurationMs,
    serviceEndMs: input.serviceEndMs,
    graceMs: input.graceMs,
    adjustedChargeableDurationMs: projection.adjustedChargeableDurationMs,
    billableDurationMs: projection.billableDurationMs,
    amount: fixed8(projection.amount),
    cappedByVendorAmount: projection.cappedByVendorAmount,
    vendorBilledAmount: input.vendorBilledAmount,
    evidenceManifestSha256,
    projectionRulesetSha256: AUDITED_PROJECTION_RULESET_SHA256,
    billingRulesetSha256: KSERVE_RULESET_SHA256,
  } as JsonValue)

  const trace = {
    schemaVersion: '1',
    decisionType: 'verified_call_billing',
    calculationBasis: 'independent_audited_projection',
    warning:
      'Priced from this platform\'s own audited duration under the locked KServe ruleset, capped at the vendor charge. The classification behind it is single-pass; no consensus cross-check was performed.',
    callId: input.callId,
    category: input.category,
    rateCardId: rateCard.id,
    rateCardVersion: rateCard.version,
    engineVersion: KSERVE_BILLING_ENGINE_VERSION,
    rulesetVersion: KSERVE_RULESET_VERSION,
    rulesetSha256: KSERVE_RULESET_SHA256,
    projectionRulesetVersion: AUDITED_PROJECTION_RULESET_VERSION,
    projectionRulesetSha256: AUDITED_PROJECTION_RULESET_SHA256,
    evidence: evidence as unknown as JsonValue,
    evidenceManifestSha256,
    inputManifestSha256,
    recordedDurationMs: input.recordedDurationMs,
    serviceEndMs: input.serviceEndMs,
    wrapUpGraceMs: input.graceMs,
    adjustedChargeableDurationMs: projection.adjustedChargeableDurationMs,
    billableDurationMs: projection.billableDurationMs,
    billableMinutes: projection.billableMinutes,
    unitRate: projection.unitRate,
    ruleCode: projection.ruleCode,
    cappedByVendorAmount: projection.cappedByVendorAmount,
    vendorBilledAmount: input.vendorBilledAmount,
    amount: fixed8(projection.amount),
    currency: 'INR',
    outcome: {
      status: 'final',
      reasonCode: 'INDEPENDENT_AUDITED_PROJECTION',
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
    calculationBasis: 'independent_audited_projection',
    claimedDurationMs: input.claimedDurationMs,
    connectedDurationMs: input.connectedDurationMs,
    recordedDurationMs: input.recordedDurationMs,
    speechDurationMs: input.speechDurationMs,
    conversationEndMs: input.serviceEndMs,
    wrapUpGraceMs: input.graceMs,
    adjustedChargeableDurationMs: projection.adjustedChargeableDurationMs,
    billableDurationMs: projection.billableDurationMs,
    // A one-way tail is a finding of the consensus pipeline, not of this
    // projection. Nothing is asserted about it here.
    oneWayTailMs: null,
    oneWayTailAlert: null,
    subtotalAmount: fixed8(projection.amount),
    taxAmount: '0.00000000',
    totalAmount: fixed8(projection.amount),
    currency: 'INR',
    rulesetSha256: KSERVE_RULESET_SHA256,
    decisionTraceJson: decisionOutputJson,
    decisionTraceSha256: decisionOutputSha256,
    calculatedAt: input.decidedAt,
    finalizedAt: input.decidedAt,
  }

  const component: BillingComponentRecord = {
    componentType: 'platform',
    ruleCode: projection.ruleCode,
    rawQuantity: `${projection.adjustedChargeableDurationMs}.00000000`,
    rawUnit: 'millisecond',
    billableQuantity: projection.billableMinutes,
    billingIncrement: persistedIncrement(projection.ruleCode),
    unitRate: projection.unitRate,
    subtotalAmount: fixed8(projection.amount),
    taxAmount: '0.00000000',
    totalAmount: fixed8(projection.amount),
    currency: 'INR',
    resultStatus: 'final',
    explanationJson: decisionOutputJson,
  }

  const decision: AutomatedDecisionRecord = {
    callId: input.callId,
    auditRunId: input.auditRunId ?? null,
    decisionType: 'verified_call_billing',
    decisionStatus: 'final',
    reasonCode: 'INDEPENDENT_AUDITED_PROJECTION',
    nextAction: null,
    sensitivityTier: 'K0',
    languageCode: 'unknown',
    findingType: 'INDEPENDENT_AUDITED_PROJECTION',
    decisionEngineName: 'kserve-verified-billing',
    decisionEngineVersion: KSERVE_BILLING_ENGINE_VERSION,
    // No model decided this money. The classification it rests on was made
    // earlier by the audit; this step is arithmetic.
    modelProvider: 'none',
    modelName: 'deterministic-audited-projection',
    modelVersion: AUDITED_PROJECTION_RULESET_VERSION,
    rulesetVersion: KSERVE_RULESET_VERSION,
    rulesetSha256: KSERVE_RULESET_SHA256,
    classifierRulesetVersion: AUDITED_PROJECTION_RULESET_VERSION,
    classifierRulesetSha256: AUDITED_PROJECTION_RULESET_SHA256,
    calibrationVersion: null,
    // Deterministic arithmetic over stored facts, so the projection itself is
    // certain. It says nothing about confidence in the classification beneath.
    confidence: '1.00000000',
    confidenceThreshold: '1.00000000',
    evidenceManifestSha256,
    evidenceRefsJson: canonicalJson(evidence as unknown as JsonValue),
    inputManifestSha256,
    decisionOutputJson,
    decisionOutputSha256,
    recheckAttempt: 0,
    decidedAt: input.decidedAt,
  }

  return { calculation, component, decision }
}
