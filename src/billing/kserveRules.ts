import {
  canonicalJsonSha256,
  type JsonValue,
} from '../messaging/canonicalJson.ts'

export const KSERVE_BILLING_ENGINE_VERSION = 'kserve-verified-billing/1.1.0'
export const KSERVE_RULESET_VERSION = '2026-07-27.1'

export const KSERVE_RATE_PER_MINUTE_PAISE = 950n
export const KSERVE_SHORT_CALL_CUTOFF_MS = 30_000
export const KSERVE_WRAP_UP_GRACE_MS = 60_000
export const KSERVE_ONE_WAY_TAIL_ALERT_MS = 60_000
export const KSERVE_MINUTE_MS = 60_000

/**
 * Finance-approved KServe interpretation, locked by leadership on 2026-07-27.
 *
 * This remains the locked rate and rounding layer. Category-specific service
 * endpoints and grace are separately versioned by categoryChargePolicy.ts, so
 * management policy can evolve without silently changing the published rate
 * card identity.
 */
export const KSERVE_RULESET_DOCUMENT = {
  schemaVersion: '1',
  rulesetVersion: KSERVE_RULESET_VERSION,
  currency: 'INR',
  ratePerMinute: '9.50000000',
  shortCall: {
    condition: '0 < adjusted_chargeable_ms < 30000',
    billableMinutes: '0.50000000',
    amount: '4.75000000',
    ruleCode: 'SHORT_CALL_FLAT',
  },
  zeroDuration: {
    condition: 'adjusted_chargeable_ms = 0',
    billableMinutes: '0.00000000',
    amount: '0.00000000',
    ruleCode: 'ZERO_DURATION_NOT_BILLED',
  },
  minuteRounding: {
    condition: 'adjusted_chargeable_ms >= 30000',
    operation: 'ceil(adjusted_chargeable_ms / 60000)',
    ruleCode: 'PER_MINUTE_CEIL',
  },
  chargeableDuration: {
    operation:
      'min(recorded_duration_ms, last_meaningful_customer_exchange_ms + 60000)',
    wrapUpGraceMs: KSERVE_WRAP_UP_GRACE_MS,
  },
  oneWayTail: {
    operation:
      'max(0, recorded_duration_ms - adjusted_chargeable_duration_ms)',
    alertWhen: 'one_way_tail_ms > 60000',
    alertThresholdMs: KSERVE_ONE_WAY_TAIL_ALERT_MS,
  },
  tax: {
    scope: 'invoice',
    perCallTax: '0.00000000',
  },
  contractReference: 'KServe AI Voicebot Service Agreement — Schedule B',
  approvedDecisionDate: '2026-07-27',
} satisfies JsonValue

export const KSERVE_RULESET_SHA256 = canonicalJsonSha256(
  KSERVE_RULESET_DOCUMENT,
)
