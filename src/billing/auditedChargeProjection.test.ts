import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  projectAuditedCharge,
  resolveAuditedChargeBoundary,
} from './auditedChargeProjection.ts'

test('stored category policy always wins over legacy inference', () => {
  assert.deepEqual(
    resolveAuditedChargeBoundary({
      category: 'VOICEMAIL',
      policyServiceEndMs: 40_000,
      policyGraceMs: 30_000,
      finalCustomerExchangeMs: null,
      finalTranscriptSegmentEndMs: 90_000,
    }),
    {
      serviceEndMs: 40_000,
      graceMs: 30_000,
      source: 'stored_policy',
    },
  )
})

test('legacy silence and voicemail use their final timestamped speech', () => {
  assert.deepEqual(
    resolveAuditedChargeBoundary({
      category: 'USER_SILENCE',
      policyServiceEndMs: null,
      policyGraceMs: null,
      finalCustomerExchangeMs: null,
      finalTranscriptSegmentEndMs: 42_000,
    }),
    {
      serviceEndMs: 42_000,
      graceMs: 60_000,
      source: 'legacy_category_fallback',
    },
  )
  assert.deepEqual(
    resolveAuditedChargeBoundary({
      category: 'VOICEMAIL',
      policyServiceEndMs: null,
      policyGraceMs: null,
      finalCustomerExchangeMs: null,
      finalTranscriptSegmentEndMs: 42_000,
    }),
    {
      serviceEndMs: 42_000,
      graceMs: 30_000,
      source: 'legacy_category_fallback',
    },
  )
})

test('legacy deterministic zero and grace-only categories remain explicit', () => {
  assert.deepEqual(
    resolveAuditedChargeBoundary({
      category: 'AGENT_FAILURE',
      policyServiceEndMs: null,
      policyGraceMs: null,
      finalCustomerExchangeMs: 20_000,
      finalTranscriptSegmentEndMs: 30_000,
    }),
    {
      serviceEndMs: 0,
      graceMs: 0,
      source: 'legacy_category_fallback',
    },
  )
  assert.deepEqual(
    resolveAuditedChargeBoundary({
      category: 'AI_TO_AI',
      policyServiceEndMs: null,
      policyGraceMs: null,
      finalCustomerExchangeMs: null,
      finalTranscriptSegmentEndMs: 30_000,
    }),
    {
      serviceEndMs: 0,
      graceMs: 60_000,
      source: 'legacy_category_fallback',
    },
  )
})

test('legacy categories needing semantic evidence stay unavailable', () => {
  assert.equal(
    resolveAuditedChargeBoundary({
      category: 'JUNK_CALL',
      policyServiceEndMs: null,
      policyGraceMs: null,
      finalCustomerExchangeMs: 20_000,
      finalTranscriptSegmentEndMs: 30_000,
    }),
    null,
  )
})

test('projects category endpoint plus grace with locked rounding', () => {
  const projection = projectAuditedCharge({
    recordedDurationMs: 200_000,
    serviceEndMs: 40_000,
    graceMs: 60_000,
    vendorAmount: null,
  })

  assert.deepEqual(projection, {
    adjustedChargeableDurationMs: 100_000,
    billableDurationMs: 120_000,
    billableMinutes: '2.00000000',
    unitRate: '9.50000000',
    amount: '19.00000000',
    ruleCode: 'PER_MINUTE_CEIL',
    billingIncrement: '1 minute ceiling',
    rulesetVersion: '2026-07-27.1',
    cappedByVendorAmount: false,
  })
})

test('caps a projection at the vendor charge without changing audited duration', () => {
  const projection = projectAuditedCharge({
    recordedDurationMs: 200_000,
    serviceEndMs: 40_000,
    graceMs: 60_000,
    vendorAmount: '9.50000000',
  })

  assert.equal(projection?.amount, '9.5')
  assert.equal(projection?.billableMinutes, '2.00000000')
  assert.equal(projection?.cappedByVendorAmount, true)
})

test('keeps an explicit zero-duration policy distinct from missing evidence', () => {
  const zero = projectAuditedCharge({
    recordedDurationMs: 90_000,
    serviceEndMs: 0,
    graceMs: 0,
    vendorAmount: null,
  })
  assert.equal(zero?.amount, '0.00000000')
  assert.equal(zero?.ruleCode, 'ZERO_DURATION_NOT_BILLED')

  assert.equal(
    projectAuditedCharge({
      recordedDurationMs: 90_000,
      serviceEndMs: null,
      graceMs: 60_000,
      vendorAmount: null,
    }),
    null,
  )
})

test('caps chargeable time at the verified recording duration', () => {
  const projection = projectAuditedCharge({
    recordedDurationMs: 20_000,
    serviceEndMs: 80_000,
    graceMs: 60_000,
    vendorAmount: null,
  })

  assert.equal(projection?.adjustedChargeableDurationMs, 20_000)
  assert.equal(projection?.billableDurationMs, 30_000)
  assert.equal(projection?.ruleCode, 'SHORT_CALL_FLAT')
})
