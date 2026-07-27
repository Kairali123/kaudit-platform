import { test } from 'node:test'
import assert from 'node:assert/strict'
import { assessBillingCycleReadiness } from './cycleReadiness.ts'

const complete = {
  periodStart: '2026-08-01',
  periodEnd: '2026-08-31',
  totalCalls: 100,
  recordingAvailableCalls: 80,
  completedAuditCalls: 80,
  acceptedAsBilledCalls: 20,
  finalCalculationCalls: 100,
  unresolvedDecisionCalls: 0,
  processingFailureCalls: 0,
  rateCardApproved: true,
  calibrationComplete: true,
}

test('withholds the bill while any call remains unresolved by audit', () => {
  const result = assessBillingCycleReadiness({
    ...complete,
    completedAuditCalls: 79,
  })
  assert.equal(result.status, 'audit_pending')
  assert.equal(result.auditPendingCalls, 1)
  assert.equal(result.billGenerated, false)
})

test('missing recordings count only after explicit accepted-as-billed resolution', () => {
  const pending = assessBillingCycleReadiness({
    ...complete,
    acceptedAsBilledCalls: 0,
  })
  assert.equal(pending.status, 'audit_pending')
  assert.equal(pending.auditPendingCalls, 20)

  const resolved = assessBillingCycleReadiness(complete)
  assert.equal(resolved.status, 'ready')
  assert.equal(resolved.auditPendingCalls, 0)
})

test('audit completion does not bypass rate-card publication', () => {
  const result = assessBillingCycleReadiness({
    ...complete,
    rateCardApproved: false,
  })
  assert.equal(result.status, 'rate_card_pending')
  assert.equal(result.billGenerated, false)
})

test('audit completion does not bypass calibration', () => {
  const result = assessBillingCycleReadiness({
    ...complete,
    calibrationComplete: false,
  })
  assert.equal(result.status, 'calibration_pending')
  assert.equal(result.billGenerated, false)
})

test('audit and rate card are insufficient without complete final calculations', () => {
  const result = assessBillingCycleReadiness({
    ...complete,
    finalCalculationCalls: 99,
  })
  assert.equal(result.status, 'calculation_pending')
  assert.equal(result.billGenerated, false)
})

test('only a fully resolved cycle releases a bill', () => {
  const result = assessBillingCycleReadiness(complete)
  assert.equal(result.status, 'ready')
  assert.equal(result.billGenerated, true)
  assert.equal(result.auditCoveragePercent, '100.00')
})
