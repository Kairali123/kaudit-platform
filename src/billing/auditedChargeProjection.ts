import { roundKServeChargeableDuration } from './calculateVerifiedCharge.ts'
import {
  KSERVE_RULESET_DOCUMENT,
  KSERVE_RULESET_VERSION,
  KSERVE_WRAP_UP_GRACE_MS,
} from './kserveRules.ts'
import { fromScaled, toScaled } from '../ui/decimal.ts'
import { VOICEMAIL_GRACE_MS } from './categoryChargePolicy.ts'

export interface AuditedChargeBoundaryInput {
  category: string | null
  policyServiceEndMs: number | null
  policyGraceMs: number | null
  finalCustomerExchangeMs: number | null
  finalTranscriptSegmentEndMs: number | null
}

export interface AuditedChargeBoundary {
  serviceEndMs: number
  graceMs: number
  source: 'stored_policy' | 'legacy_category_fallback'
}

export interface AuditedChargeProjectionInput {
  recordedDurationMs: number | null
  serviceEndMs: number | null
  graceMs: number | null
  vendorAmount: string | null
}

export interface AuditedChargeProjection {
  adjustedChargeableDurationMs: number
  billableDurationMs: number
  billableMinutes: string
  unitRate: string
  amount: string
  ruleCode:
    | 'ZERO_DURATION_NOT_BILLED'
    | 'SHORT_CALL_FLAT'
    | 'PER_MINUTE_CEIL'
  billingIncrement: string
  rulesetVersion: string
  cappedByVendorAmount: boolean
}

function validMilliseconds(value: number | null): value is number {
  return value != null && Number.isSafeInteger(value) && value >= 0
}

/**
 * Completes old successful audits that predate persisted category endpoints.
 * Only categories whose legacy endpoint is deterministic are eligible.
 */
export function resolveAuditedChargeBoundary(
  input: AuditedChargeBoundaryInput,
): AuditedChargeBoundary | null {
  if (
    validMilliseconds(input.policyServiceEndMs) &&
    validMilliseconds(input.policyGraceMs)
  ) {
    return {
      serviceEndMs: input.policyServiceEndMs,
      graceMs: input.policyGraceMs,
      source: 'stored_policy',
    }
  }
  if (
    input.category === 'INACTIVE_CALL' ||
    input.category === 'AGENT_FAILURE' ||
    input.category === 'AI_CONVERSATION_HANDLING' ||
    input.category === 'NETWORK_FAILURE_TELECOM'
  ) {
    return {
      serviceEndMs: 0,
      graceMs: 0,
      source: 'legacy_category_fallback',
    }
  }
  if (input.category === 'AI_TO_AI') {
    return {
      serviceEndMs: 0,
      graceMs: KSERVE_WRAP_UP_GRACE_MS,
      source: 'legacy_category_fallback',
    }
  }
  if (
    input.category === 'USER_SILENCE' &&
    validMilliseconds(input.finalTranscriptSegmentEndMs)
  ) {
    return {
      serviceEndMs: input.finalTranscriptSegmentEndMs,
      graceMs: KSERVE_WRAP_UP_GRACE_MS,
      source: 'legacy_category_fallback',
    }
  }
  if (
    input.category === 'VOICEMAIL' &&
    validMilliseconds(input.finalTranscriptSegmentEndMs)
  ) {
    return {
      serviceEndMs: input.finalTranscriptSegmentEndMs,
      graceMs: VOICEMAIL_GRACE_MS,
      source: 'legacy_category_fallback',
    }
  }
  if (
    (input.category === 'OK' ||
      input.category === 'CONNECT_NOT_FRUITFUL' ||
      input.category === 'TIME_DURATION') &&
    validMilliseconds(input.finalCustomerExchangeMs)
  ) {
    return {
      serviceEndMs: input.finalCustomerExchangeMs,
      graceMs: KSERVE_WRAP_UP_GRACE_MS,
      source: 'legacy_category_fallback',
    }
  }
  return null
}

function billingIncrement(
  ruleCode: AuditedChargeProjection['ruleCode'],
): string {
  if (ruleCode === 'ZERO_DURATION_NOT_BILLED') return 'none'
  if (ruleCode === 'SHORT_CALL_FLAT') return '0.5 minute flat'
  return '1 minute ceiling'
}

/**
 * Read-only per-call projection from persisted audit facts.
 *
 * The classifier selects a category and service endpoint; this function only
 * applies the locked deterministic duration and money rules. It never promotes
 * the result to an authoritative final calculation. The approved consensus
 * pipeline may later supersede it with a persisted final record.
 */
export function projectAuditedCharge(
  input: AuditedChargeProjectionInput,
): AuditedChargeProjection | null {
  if (!validMilliseconds(input.serviceEndMs)) return null
  if (!validMilliseconds(input.graceMs)) return null
  if (
    input.recordedDurationMs != null &&
    !validMilliseconds(input.recordedDurationMs)
  ) {
    return null
  }

  const endpointWithGrace = input.serviceEndMs + input.graceMs
  if (!Number.isSafeInteger(endpointWithGrace)) return null
  const adjustedChargeableDurationMs = Math.min(
    input.recordedDurationMs ?? endpointWithGrace,
    endpointWithGrace,
  )
  const rounded = roundKServeChargeableDuration(
    adjustedChargeableDurationMs,
  )
  const projectedAmount = toScaled(rounded.amount)
  if (projectedAmount == null) return null
  const vendorAmount = toScaled(input.vendorAmount)
  const cappedByVendorAmount =
    vendorAmount != null &&
    vendorAmount >= 0n &&
    vendorAmount < projectedAmount
  const amount = cappedByVendorAmount
    ? fromScaled(vendorAmount)
    : rounded.amount

  return {
    adjustedChargeableDurationMs,
    billableDurationMs: rounded.billableDurationMs,
    billableMinutes: rounded.billableMinutes,
    unitRate: KSERVE_RULESET_DOCUMENT.ratePerMinute,
    amount,
    ruleCode: rounded.ruleCode,
    billingIncrement: billingIncrement(rounded.ruleCode),
    rulesetVersion: KSERVE_RULESET_VERSION,
    cappedByVendorAmount,
  }
}
