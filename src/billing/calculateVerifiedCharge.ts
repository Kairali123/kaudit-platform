import {
  canonicalJsonSha256,
  type JsonValue,
} from '../messaging/canonicalJson.ts'
import {
  KSERVE_BILLING_ENGINE_VERSION,
  KSERVE_MINUTE_MS,
  KSERVE_ONE_WAY_TAIL_ALERT_MS,
  KSERVE_RATE_PER_MINUTE_PAISE,
  KSERVE_RULESET_SHA256,
  KSERVE_RULESET_VERSION,
  KSERVE_SHORT_CALL_CUTOFF_MS,
  KSERVE_WRAP_UP_GRACE_MS,
} from './kserveRules.ts'
import type {
  AutomationAuthority,
  BillingDecisionTrace,
  BillingNextAction,
  BillingUnresolvedReason,
  EvidenceHashReference,
  PublishedRateCard,
  VerifiedBillingInput,
  VerifiedBillingResult,
} from './types.ts'

const SHA256 = /^[a-f0-9]{64}$/
const DECIMAL = /^(0|1)(?:\.\d{1,8})?$/

function requireText(value: string, name: string): void {
  if (!value.trim()) throw new TypeError(`${name} is required`)
}

function requireSha256(value: string, name: string): void {
  if (!SHA256.test(value)) {
    throw new TypeError(`${name} must be a lowercase SHA-256 hex value`)
  }
}

function requireMilliseconds(
  value: number | null,
  name: string,
  nullable = false,
): void {
  if (value == null && nullable) return
  if (
    value == null ||
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    throw new RangeError(`${name} must be a non-negative safe integer`)
  }
}

function decimalToScale8(value: string, name: string): bigint {
  if (!DECIMAL.test(value)) {
    throw new TypeError(`${name} must be a decimal from 0 to 1`)
  }
  const [whole, fraction = ''] = value.split('.')
  const scaled = BigInt(whole) * 100_000_000n +
    BigInt((fraction + '00000000').slice(0, 8))
  if (scaled > 100_000_000n) {
    throw new TypeError(`${name} must be a decimal from 0 to 1`)
  }
  return scaled
}

function fixed8FromPaise(paise: bigint): string {
  if (paise < 0n) throw new RangeError('Money cannot be negative')
  const rupees = paise / 100n
  const paisePart = (paise % 100n).toString().padStart(2, '0')
  return `${rupees}.${paisePart}000000`
}

function fixed8FromHalfMinutes(halfMinutes: bigint): string {
  const whole = halfMinutes / 2n
  return `${whole}.${halfMinutes % 2n === 0n ? '00000000' : '50000000'}`
}

function validateRateCard(rateCard: PublishedRateCard): void {
  requireText(rateCard.id, 'rateCard.id')
  requireText(rateCard.version, 'rateCard.version')
  if (
    rateCard.status !== 'published' ||
    !rateCard.approvedBy?.trim() ||
    !rateCard.approvedAt?.trim() ||
    Number.isNaN(Date.parse(rateCard.approvedAt))
  ) {
    throw new Error(
      'D-03: billing requires a formally published rate card with approver and approval timestamp',
    )
  }
  if (rateCard.currency !== 'INR') {
    throw new Error('The locked KServe ruleset supports INR only')
  }
  if (rateCard.rulesetSha256 !== KSERVE_RULESET_SHA256) {
    throw new Error(
      'Published rate-card hash does not match the locked KServe ruleset',
    )
  }
}

function validateEvidence(evidence: EvidenceHashReference[]): void {
  if (evidence.length === 0) {
    throw new TypeError('At least one input evidence hash is required')
  }
  for (const [index, ref] of evidence.entries()) {
    requireText(ref.referenceId, `evidence[${index}].referenceId`)
    requireSha256(ref.sha256, `evidence[${index}].sha256`)
  }
}

function validateInput(input: VerifiedBillingInput): void {
  requireText(input.callId, 'callId')
  requireText(input.auditRunId, 'auditRunId')
  requireText(input.model.provider, 'model.provider')
  requireText(input.model.name, 'model.name')
  requireText(input.model.version, 'model.version')
  requireText(input.classifierRulesetVersion, 'classifierRulesetVersion')
  requireSha256(
    input.classifierRulesetSha256,
    'classifierRulesetSha256',
  )
  requireMilliseconds(input.claimedDurationMs, 'claimedDurationMs', true)
  requireMilliseconds(input.connectedDurationMs, 'connectedDurationMs', true)
  requireMilliseconds(input.recordedDurationMs, 'recordedDurationMs')
  requireMilliseconds(input.speechDurationMs, 'speechDurationMs', true)
  requireMilliseconds(
    input.lastMeaningfulCustomerExchangeMs,
    'lastMeaningfulCustomerExchangeMs',
    true,
  )
  validateEvidence(input.evidence)
  if (Number.isNaN(Date.parse(input.calculatedAt))) {
    throw new TypeError('calculatedAt must be an ISO timestamp')
  }
  if (
    input.conversationAssessment === 'established' &&
    (input.lastMeaningfulCustomerExchangeMs == null ||
      input.lastMeaningfulCustomerExchangeMs <= 0)
  ) {
    throw new Error(
      'An established conversation requires a positive final customer-exchange timestamp',
    )
  }
  if (
    input.lastMeaningfulCustomerExchangeMs != null &&
    input.lastMeaningfulCustomerExchangeMs > input.recordedDurationMs
  ) {
    throw new Error(
      'Final customer-exchange timestamp cannot exceed the decoded recording duration',
    )
  }
  if (
    input.conversationAssessment === 'no_meaningful_exchange' &&
    input.lastMeaningfulCustomerExchangeMs != null
  ) {
    throw new Error(
      'No-meaningful-exchange assessments must not carry a customer-exchange timestamp',
    )
  }
  const authority = input.authority
  decimalToScale8(authority.confidence, 'authority.confidence')
  if (authority.threshold != null) {
    decimalToScale8(authority.threshold, 'authority.threshold')
  }
  if (
    !Number.isSafeInteger(authority.recheckAttempt) ||
    authority.recheckAttempt < 0 ||
    !Number.isSafeInteger(authority.maximumRechecks) ||
    authority.maximumRechecks < 0
  ) {
    throw new RangeError('Automated recheck counts must be non-negative integers')
  }
}

interface AuthorityDecision {
  final: boolean
  reasonCode:
    | 'AUTOMATED_CONFIDENCE_CONFIRMED'
    | BillingUnresolvedReason
  nextAction: BillingNextAction | null
}

function decideAuthority(
  authority: AutomationAuthority,
  conversationAssessment: VerifiedBillingInput['conversationAssessment'],
): AuthorityDecision {
  if (!authority.calibrationComplete) {
    return {
      final: false,
      reasonCode: 'CALIBRATION_NOT_COMPLETED',
      nextAction: 'await_calibration',
    }
  }
  if (!authority.threshold) {
    return {
      final: false,
      reasonCode: 'THRESHOLD_NOT_CONFIGURED',
      nextAction: 'configure_threshold',
    }
  }
  if (
    (authority.sensitivityTier === 'K2' ||
      authority.sensitivityTier === 'K3') &&
    (!authority.k23AutomationEnabled ||
      !authority.clinicalSafetyOwner?.trim())
  ) {
    return {
      final: false,
      reasonCode: 'K23_AUTOMATION_NOT_APPROVED',
      nextAction: 'await_clinical_safety_approval',
    }
  }
  if (conversationAssessment === 'unresolved') {
    return {
      final: false,
      reasonCode: 'CONVERSATION_ASSESSMENT_UNRESOLVED',
      nextAction: 'retry_conversation_assessment',
    }
  }
  const confidence = decimalToScale8(
    authority.confidence,
    'authority.confidence',
  )
  const threshold = decimalToScale8(
    authority.threshold,
    'authority.threshold',
  )
  if (confidence < threshold) {
    const exhausted =
      authority.recheckAttempt >= authority.maximumRechecks
    return {
      final: false,
      reasonCode: exhausted
        ? 'LOW_CONFIDENCE_RECHECK_EXHAUSTED'
        : 'LOW_CONFIDENCE_RECHECK_REQUIRED',
      nextAction: exhausted
        ? 'hold_unresolved_until_cycle_close'
        : 'retry_with_secondary_model',
    }
  }
  return {
    final: true,
    reasonCode: 'AUTOMATED_CONFIDENCE_CONFIRMED',
    nextAction: null,
  }
}

export interface RoundedCharge {
  billableHalfMinutes: bigint
  billableDurationMs: number
  billableMinutes: string
  amountPaise: bigint
  amount: string
  ruleCode:
    | 'ZERO_DURATION_NOT_BILLED'
    | 'SHORT_CALL_FLAT'
    | 'PER_MINUTE_CEIL'
}

export function roundKServeChargeableDuration(
  adjustedChargeableDurationMs: number,
): RoundedCharge {
  requireMilliseconds(
    adjustedChargeableDurationMs,
    'adjustedChargeableDurationMs',
  )
  let halfMinutes: bigint
  let ruleCode: RoundedCharge['ruleCode']
  if (adjustedChargeableDurationMs === 0) {
    halfMinutes = 0n
    ruleCode = 'ZERO_DURATION_NOT_BILLED'
  } else if (adjustedChargeableDurationMs < KSERVE_SHORT_CALL_CUTOFF_MS) {
    halfMinutes = 1n
    ruleCode = 'SHORT_CALL_FLAT'
  } else {
    const milliseconds = BigInt(adjustedChargeableDurationMs)
    const minuteMs = BigInt(KSERVE_MINUTE_MS)
    const minutes = (milliseconds + minuteMs - 1n) / minuteMs
    halfMinutes = minutes * 2n
    ruleCode = 'PER_MINUTE_CEIL'
  }
  const amountPaise =
    (halfMinutes * KSERVE_RATE_PER_MINUTE_PAISE) / 2n
  const billableDurationMs = Number(
    halfMinutes * BigInt(KSERVE_MINUTE_MS / 2),
  )
  if (!Number.isSafeInteger(billableDurationMs)) {
    throw new RangeError('Rounded billable duration exceeds safe integer range')
  }
  return {
    billableHalfMinutes: halfMinutes,
    billableDurationMs,
    billableMinutes: fixed8FromHalfMinutes(halfMinutes),
    amountPaise,
    amount: fixed8FromPaise(amountPaise),
    ruleCode,
  }
}

function manifestParts(input: VerifiedBillingInput): {
  evidenceManifestSha256: string
  inputManifestSha256: string
} {
  const orderedEvidence = orderEvidence(input.evidence)
  const evidenceManifestSha256 = canonicalJsonSha256(
    orderedEvidence as unknown as JsonValue,
  )
  const inputManifestSha256 = canonicalJsonSha256({
    callId: input.callId,
    auditRunId: input.auditRunId,
    evidenceManifestSha256,
    model: input.model,
    classifierRulesetVersion: input.classifierRulesetVersion,
    classifierRulesetSha256: input.classifierRulesetSha256,
    authority: input.authority,
    durations: {
      claimedDurationMs: input.claimedDurationMs,
      connectedDurationMs: input.connectedDurationMs,
      recordedDurationMs: input.recordedDurationMs,
      speechDurationMs: input.speechDurationMs,
      conversationAssessment: input.conversationAssessment,
      lastMeaningfulCustomerExchangeMs:
        input.lastMeaningfulCustomerExchangeMs,
    },
    billingRulesetSha256: KSERVE_RULESET_SHA256,
  } as unknown as JsonValue)
  return { evidenceManifestSha256, inputManifestSha256 }
}

function orderEvidence(
  evidence: EvidenceHashReference[],
): EvidenceHashReference[] {
  return [...evidence].sort((left, right) => {
    const leftKey = `${left.kind}:${left.referenceId}:${left.sha256}`
    const rightKey = `${right.kind}:${right.referenceId}:${right.sha256}`
    return leftKey.localeCompare(rightKey)
  })
}

function createTrace(options: {
  input: VerifiedBillingInput
  rateCard: PublishedRateCard
  evidenceManifestSha256: string
  inputManifestSha256: string
  calculation: JsonValue
  outcome: AuthorityDecision
}): BillingDecisionTrace {
  return {
    schemaVersion: '1',
    decisionType: 'verified_call_billing',
    engineVersion: KSERVE_BILLING_ENGINE_VERSION,
    rulesetVersion: KSERVE_RULESET_VERSION,
    rulesetSha256: KSERVE_RULESET_SHA256,
    rateCardId: options.rateCard.id,
    rateCardVersion: options.rateCard.version,
    callId: options.input.callId,
    auditRunId: options.input.auditRunId,
    model: options.input.model,
    classifierRulesetVersion: options.input.classifierRulesetVersion,
    classifierRulesetSha256: options.input.classifierRulesetSha256,
    evidence: orderEvidence(options.input.evidence),
    evidenceManifestSha256: options.evidenceManifestSha256,
    inputManifestSha256: options.inputManifestSha256,
    authority: options.input.authority,
    inputs: {
      claimedDurationMs: options.input.claimedDurationMs,
      connectedDurationMs: options.input.connectedDurationMs,
      recordedDurationMs: options.input.recordedDurationMs,
      speechDurationMs: options.input.speechDurationMs,
      conversationAssessment: options.input.conversationAssessment,
      lastMeaningfulCustomerExchangeMs:
        options.input.lastMeaningfulCustomerExchangeMs,
    },
    calculation: options.calculation,
    outcome: {
      status: options.outcome.final ? 'final' : 'unresolved',
      reasonCode: options.outcome.reasonCode,
      nextAction: options.outcome.nextAction,
    },
    decidedAt: options.input.calculatedAt,
  }
}

export function calculateVerifiedKServeCharge(
  input: VerifiedBillingInput,
  rateCard: PublishedRateCard,
): VerifiedBillingResult {
  validateInput(input)
  validateRateCard(rateCard)
  const { evidenceManifestSha256, inputManifestSha256 } =
    manifestParts(input)
  const authority = decideAuthority(
    input.authority,
    input.conversationAssessment,
  )

  if (!authority.final) {
    const trace = createTrace({
      input,
      rateCard,
      evidenceManifestSha256,
      inputManifestSha256,
      calculation: {
        status: 'not_calculated',
        reason: 'authority_gate_unresolved',
      },
      outcome: authority,
    })
    return {
      status: 'unresolved',
      reasonCode: authority.reasonCode as BillingUnresolvedReason,
      nextAction: authority.nextAction as BillingNextAction,
      evidenceManifestSha256,
      inputManifestSha256,
      traceSha256: canonicalJsonSha256(trace as unknown as JsonValue),
      trace,
    }
  }

  const finalExchangeMs =
    input.conversationAssessment === 'no_meaningful_exchange'
      ? 0
      : (input.lastMeaningfulCustomerExchangeMs as number)
  const adjustedChargeableDurationMs =
    input.conversationAssessment === 'no_meaningful_exchange'
      ? 0
      : finalExchangeMs >
          input.recordedDurationMs - KSERVE_WRAP_UP_GRACE_MS
        ? input.recordedDurationMs
        : finalExchangeMs + KSERVE_WRAP_UP_GRACE_MS
  const appliedWrapUpGraceMs =
    input.conversationAssessment === 'no_meaningful_exchange'
      ? 0
      : adjustedChargeableDurationMs - finalExchangeMs
  const oneWayTailMs = Math.max(
    0,
    input.recordedDurationMs - adjustedChargeableDurationMs,
  )
  const oneWayTailAlert =
    oneWayTailMs > KSERVE_ONE_WAY_TAIL_ALERT_MS
  const rounded = roundKServeChargeableDuration(
    adjustedChargeableDurationMs,
  )
  const calculation: JsonValue = {
    basis: 'last_meaningful_customer_exchange_plus_wrap_up_grace',
    finalMeaningfulCustomerExchangeMs: finalExchangeMs,
    configuredWrapUpGraceMs: KSERVE_WRAP_UP_GRACE_MS,
    appliedWrapUpGraceMs,
    adjustedChargeableDurationMs,
    rounding: {
      ruleCode: rounded.ruleCode,
      billableDurationMs: rounded.billableDurationMs,
      billableMinutes: rounded.billableMinutes,
    },
    ratePerMinute: '9.50000000',
    subtotalAmount: rounded.amount,
    taxAmount: '0.00000000',
    totalAmount: rounded.amount,
    oneWayTailMs,
    oneWayTailAlertThresholdMs: KSERVE_ONE_WAY_TAIL_ALERT_MS,
    oneWayTailAlert,
  }
  const trace = createTrace({
    input,
    rateCard,
    evidenceManifestSha256,
    inputManifestSha256,
    calculation,
    outcome: authority,
  })
  return {
    status: 'final',
    reasonCode: 'AUTOMATED_CONFIDENCE_CONFIRMED',
    nextAction: null,
    adjustedChargeableDurationMs,
    billableDurationMs: rounded.billableDurationMs,
    billableMinutes: rounded.billableMinutes,
    amount: rounded.amount,
    amountPaise: rounded.amountPaise,
    currency: 'INR',
    ruleCode: rounded.ruleCode,
    oneWayTailMs,
    oneWayTailAlert,
    inputManifestSha256,
    evidenceManifestSha256,
    traceSha256: canonicalJsonSha256(trace as unknown as JsonValue),
    trace,
  }
}
