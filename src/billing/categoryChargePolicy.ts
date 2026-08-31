import {
  canonicalJsonSha256,
  type JsonValue,
} from '../messaging/canonicalJson.ts'
import type { ReauditCategory } from '../reaudit/types.ts'
import { KSERVE_WRAP_UP_GRACE_MS } from './kserveRules.ts'

export const CATEGORY_CHARGE_POLICY_VERSION =
  'management-category-charge/2026-08-31.1'
export const VOICEMAIL_GRACE_MS = 30_000

export const CATEGORY_CHARGE_POLICY_DOCUMENT = {
  schemaVersion: '1',
  version: CATEGORY_CHARGE_POLICY_VERSION,
  rules: {
    USER_SILENCE: 'last_agent_exchange_plus_standard_grace',
    VOICEMAIL: 'last_agent_or_voicemail_exchange_plus_30s_grace',
    AI_TO_AI: 'standard_grace_only',
    INACTIVE_CALL: 'zero',
    OK: 'last_customer_exchange_plus_standard_grace',
    CONNECT_NOT_FRUITFUL: 'last_customer_exchange_plus_standard_grace',
    TIME_DURATION: 'last_customer_exchange_plus_standard_grace',
    AGENT_FAILURE: 'zero',
    AI_CONVERSATION_HANDLING: 'zero',
    NETWORK_FAILURE_TELECOM: 'zero',
    JUNK_CALL: 'business_relevant_customer_exchange_plus_standard_grace',
    INCORRECT_CALL_DURATION: 'last_verified_interaction_plus_standard_grace',
  },
} satisfies JsonValue

export const CATEGORY_CHARGE_POLICY_SHA256 = canonicalJsonSha256(
  CATEGORY_CHARGE_POLICY_DOCUMENT,
)

export type CategoryChargePolicyCode =
  | 'STANDARD_CUSTOMER_PLUS_GRACE'
  | 'USER_SILENCE_AGENT_PLUS_GRACE'
  | 'VOICEMAIL_SERVICE_PLUS_30S'
  | 'AI_TO_AI_GRACE_ONLY'
  | 'JUNK_BUSINESS_INTERACTION_PLUS_GRACE'
  | 'VERIFIED_INTERACTION_PLUS_GRACE'
  | 'MANAGEMENT_ZERO_CATEGORY'
  | 'NO_VERIFIED_CHARGEABLE_INTERACTION'

export const CATEGORY_CHARGE_POLICY_CODES = [
  'STANDARD_CUSTOMER_PLUS_GRACE',
  'USER_SILENCE_AGENT_PLUS_GRACE',
  'VOICEMAIL_SERVICE_PLUS_30S',
  'AI_TO_AI_GRACE_ONLY',
  'JUNK_BUSINESS_INTERACTION_PLUS_GRACE',
  'VERIFIED_INTERACTION_PLUS_GRACE',
  'MANAGEMENT_ZERO_CATEGORY',
  'NO_VERIFIED_CHARGEABLE_INTERACTION',
] as const satisfies readonly CategoryChargePolicyCode[]

export interface CategoryChargeEvidence {
  category: ReauditCategory
  recordedDurationMs: number
  lastCustomerExchangeMs: number | null
  lastAgentExchangeMs: number | null
  lastVoicemailExchangeMs: number | null
  lastBusinessRelevantCustomerExchangeMs: number | null
  lastVerifiedInteractionMs: number | null
}

export interface CategoryChargeDecision {
  policyCode: CategoryChargePolicyCode
  serviceEndMs: number
  graceMs: number
  adjustedChargeableDurationMs: number
}

function boundedEnd(value: number | null, recordedDurationMs: number): number {
  return value == null ? 0 : Math.min(recordedDurationMs, Math.max(0, value))
}

function decision(
  evidence: CategoryChargeEvidence,
  policyCode: CategoryChargePolicyCode,
  rawEndMs: number | null,
  graceMs: number,
): CategoryChargeDecision {
  const serviceEndMs = boundedEnd(rawEndMs, evidence.recordedDurationMs)
  const adjustedChargeableDurationMs = Math.min(
    evidence.recordedDurationMs,
    serviceEndMs + graceMs,
  )
  return {
    policyCode,
    serviceEndMs,
    graceMs,
    adjustedChargeableDurationMs,
  }
}

export function resolveCategoryCharge(
  evidence: CategoryChargeEvidence,
): CategoryChargeDecision {
  if (
    evidence.category === 'INACTIVE_CALL' ||
    evidence.category === 'AGENT_FAILURE' ||
    evidence.category === 'AI_CONVERSATION_HANDLING' ||
    evidence.category === 'NETWORK_FAILURE_TELECOM'
  ) {
    return decision(evidence, 'MANAGEMENT_ZERO_CATEGORY', null, 0)
  }
  if (evidence.category === 'AI_TO_AI') {
    return decision(evidence, 'AI_TO_AI_GRACE_ONLY', null, KSERVE_WRAP_UP_GRACE_MS)
  }
  if (evidence.category === 'USER_SILENCE') {
    if (evidence.lastAgentExchangeMs == null) {
      return decision(
        evidence,
        'NO_VERIFIED_CHARGEABLE_INTERACTION',
        null,
        0,
      )
    }
    return decision(
      evidence,
      'USER_SILENCE_AGENT_PLUS_GRACE',
      evidence.lastAgentExchangeMs,
      KSERVE_WRAP_UP_GRACE_MS,
    )
  }
  if (evidence.category === 'VOICEMAIL') {
    const serviceEndMs = Math.max(
      evidence.lastAgentExchangeMs ?? 0,
      evidence.lastVoicemailExchangeMs ?? 0,
    )
    if (serviceEndMs === 0) {
      return decision(
        evidence,
        'NO_VERIFIED_CHARGEABLE_INTERACTION',
        null,
        0,
      )
    }
    return decision(
      evidence,
      'VOICEMAIL_SERVICE_PLUS_30S',
      serviceEndMs,
      VOICEMAIL_GRACE_MS,
    )
  }
  if (evidence.category === 'JUNK_CALL') {
    return decision(
      evidence,
      evidence.lastBusinessRelevantCustomerExchangeMs == null
        ? 'NO_VERIFIED_CHARGEABLE_INTERACTION'
        : 'JUNK_BUSINESS_INTERACTION_PLUS_GRACE',
      evidence.lastBusinessRelevantCustomerExchangeMs,
      evidence.lastBusinessRelevantCustomerExchangeMs == null
        ? 0
        : KSERVE_WRAP_UP_GRACE_MS,
    )
  }
  if (evidence.category === 'INCORRECT_CALL_DURATION') {
    return decision(
      evidence,
      evidence.lastVerifiedInteractionMs == null
        ? 'NO_VERIFIED_CHARGEABLE_INTERACTION'
        : 'VERIFIED_INTERACTION_PLUS_GRACE',
      evidence.lastVerifiedInteractionMs,
      evidence.lastVerifiedInteractionMs == null ? 0 : KSERVE_WRAP_UP_GRACE_MS,
    )
  }
  return decision(
    evidence,
    evidence.lastCustomerExchangeMs == null
      ? 'NO_VERIFIED_CHARGEABLE_INTERACTION'
      : 'STANDARD_CUSTOMER_PLUS_GRACE',
    evidence.lastCustomerExchangeMs,
    evidence.lastCustomerExchangeMs == null ? 0 : KSERVE_WRAP_UP_GRACE_MS,
  )
}
