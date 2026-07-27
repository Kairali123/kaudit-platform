export type BillingCycleStatus =
  | 'no_data'
  | 'audit_pending'
  | 'calibration_pending'
  | 'rate_card_pending'
  | 'calculation_pending'
  | 'ready'

export interface BillingCycleCounts {
  periodStart: string | null
  periodEnd: string | null
  totalCalls: number
  recordingAvailableCalls: number
  completedAuditCalls: number
  acceptedAsBilledCalls: number
  finalCalculationCalls: number | null
  unresolvedDecisionCalls: number | null
  processingFailureCalls: number
}

export interface BillingCycleReadiness extends BillingCycleCounts {
  resolvedAuditCalls: number
  auditPendingCalls: number
  auditCoveragePercent: string
  rateCardApproved: boolean
  calibrationComplete: boolean
  status: BillingCycleStatus
  billGenerated: boolean
}

function count(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer`)
  }
  return value
}

export function assessBillingCycleReadiness(
  input: BillingCycleCounts & {
    rateCardApproved: boolean
    calibrationComplete: boolean
  },
): BillingCycleReadiness {
  const totalCalls = count(input.totalCalls, 'totalCalls')
  const recordingAvailableCalls = count(
    input.recordingAvailableCalls,
    'recordingAvailableCalls',
  )
  const completedAuditCalls = count(
    input.completedAuditCalls,
    'completedAuditCalls',
  )
  const acceptedAsBilledCalls = count(
    input.acceptedAsBilledCalls,
    'acceptedAsBilledCalls',
  )
  const processingFailureCalls = count(
    input.processingFailureCalls,
    'processingFailureCalls',
  )
  const finalCalculationCalls =
    input.finalCalculationCalls == null
      ? null
      : count(input.finalCalculationCalls, 'finalCalculationCalls')
  const unresolvedDecisionCalls =
    input.unresolvedDecisionCalls == null
      ? null
      : count(input.unresolvedDecisionCalls, 'unresolvedDecisionCalls')
  const resolvedAuditCalls = Math.min(
    totalCalls,
    completedAuditCalls + acceptedAsBilledCalls,
  )
  const auditPendingCalls = Math.max(0, totalCalls - resolvedAuditCalls)
  let status: BillingCycleStatus
  if (totalCalls === 0) {
    status = 'no_data'
  } else if (
    auditPendingCalls > 0 ||
    (unresolvedDecisionCalls != null && unresolvedDecisionCalls > 0)
  ) {
    status = 'audit_pending'
  } else if (!input.calibrationComplete) {
    status = 'calibration_pending'
  } else if (!input.rateCardApproved) {
    status = 'rate_card_pending'
  } else if (
    finalCalculationCalls == null ||
    unresolvedDecisionCalls == null ||
    finalCalculationCalls !== totalCalls
  ) {
    status = 'calculation_pending'
  } else {
    status = 'ready'
  }
  return {
    periodStart: input.periodStart,
    periodEnd: input.periodEnd,
    totalCalls,
    recordingAvailableCalls,
    completedAuditCalls,
    acceptedAsBilledCalls,
    finalCalculationCalls,
    unresolvedDecisionCalls,
    processingFailureCalls,
    resolvedAuditCalls,
    auditPendingCalls,
    auditCoveragePercent:
      totalCalls === 0
        ? '0.00'
        : ((resolvedAuditCalls / totalCalls) * 100).toFixed(2),
    rateCardApproved: input.rateCardApproved,
    calibrationComplete: input.calibrationComplete,
    status,
    billGenerated: status === 'ready',
  }
}
