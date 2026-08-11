import type { MetricScore } from './types.ts'

/**
 * The approved eight-metric scoring rubric.
 *
 * Weights are integers totalling exactly 100. This audit reads TRANSCRIPTS
 * ONLY, so there is deliberately no audio-volume or voice-clarity metric —
 * neither is observable from text, and scoring one would be fabrication.
 */

export const CALL_AUDIT_METRIC_CODES = [
  'PRODUCT_SERVICE_KNOWLEDGE',
  'CUSTOMER_UNDERSTANDING',
  'COMMUNICATION_CLARITY',
  'OBJECTION_CALLBACK_HANDLING',
  'CLOSING_NEXT_STEP',
  'PROFESSIONALISM',
  'QUALIFICATION_COMPLETENESS',
  'COMPLIANCE_PRIVACY',
] as const

export type CallAuditMetricCode = (typeof CALL_AUDIT_METRIC_CODES)[number]

export interface CallAuditMetricDefinition {
  code: CallAuditMetricCode
  weight: number
  /**
   * Whether NA is a legitimate score when the customer spoke. Only two metrics
   * can genuinely not apply to a real conversation; the rest are always
   * observable once there is speech to read.
   */
  naAllowedWhenCustomerSpoke: boolean
  naReason: string | null
}

export const CALL_AUDIT_RUBRIC: readonly CallAuditMetricDefinition[] = [
  {
    code: 'PRODUCT_SERVICE_KNOWLEDGE',
    weight: 15,
    naAllowedWhenCustomerSpoke: true,
    naReason: 'no product or service explanation occurred',
  },
  {
    code: 'CUSTOMER_UNDERSTANDING',
    weight: 20,
    naAllowedWhenCustomerSpoke: false,
    naReason: null,
  },
  {
    code: 'COMMUNICATION_CLARITY',
    weight: 15,
    naAllowedWhenCustomerSpoke: false,
    naReason: null,
  },
  {
    code: 'OBJECTION_CALLBACK_HANDLING',
    weight: 10,
    naAllowedWhenCustomerSpoke: true,
    naReason: 'no objection or callback request occurred',
  },
  {
    code: 'CLOSING_NEXT_STEP',
    weight: 10,
    naAllowedWhenCustomerSpoke: false,
    naReason: null,
  },
  {
    code: 'PROFESSIONALISM',
    weight: 10,
    naAllowedWhenCustomerSpoke: false,
    naReason: null,
  },
  {
    code: 'QUALIFICATION_COMPLETENESS',
    weight: 15,
    naAllowedWhenCustomerSpoke: false,
    naReason: null,
  },
  {
    code: 'COMPLIANCE_PRIVACY',
    weight: 5,
    naAllowedWhenCustomerSpoke: false,
    naReason: null,
  },
]

export const CALL_AUDIT_METRIC_WEIGHT: Record<CallAuditMetricCode, number> =
  Object.fromEntries(
    CALL_AUDIT_RUBRIC.map((metric) => [metric.code, metric.weight]),
  ) as Record<CallAuditMetricCode, number>

/** Total of every weight. Pinned by test; the rubric is meaningless if it drifts. */
export const CALL_AUDIT_TOTAL_WEIGHT = 100

export interface CallAuditMetricScore {
  metric: CallAuditMetricCode
  score: MetricScore
}

export function isCallAuditMetricCode(
  value: unknown,
): value is CallAuditMetricCode {
  return (
    typeof value === 'string' &&
    (CALL_AUDIT_METRIC_CODES as readonly string[]).includes(value)
  )
}

export function metricWeight(code: CallAuditMetricCode): number {
  return CALL_AUDIT_METRIC_WEIGHT[code]
}
