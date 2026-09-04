import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  AUDITED_PROJECTION_RULESET_VERSION,
  buildAuditedProjectionRecords,
} from './auditedProjectionSettlement.ts'
import { KSERVE_RULESET_SHA256 } from './kserveRules.ts'

const rateCard = {
  id: 'test-rate-card',
  version: 'test.1',
  status: 'published',
  currency: 'INR' as const,
  rulesetSha256: KSERVE_RULESET_SHA256,
  approvedBy: 'finance@example.invalid',
  approvedAt: '2026-06-30T12:00:00.000Z',
}

const base = {
  callId: 'call-audited',
  auditRunId: 'run-1',
  category: 'answered_resolved',
  recordedDurationMs: 200_000,
  speechDurationMs: 120_000,
  serviceEndMs: 90_000,
  graceMs: 60_000,
  claimedDurationMs: 210_000,
  connectedDurationMs: 205_000,
  vendorBilledAmount: '38.00000000',
  sourceEvidence: {
    kind: 'call_manifest' as const,
    referenceId: 'usage-1',
    sha256: 'a'.repeat(64),
  },
  decidedAt: '2026-06-30T18:29:59.999Z',
}

test('an audited call is priced from its own audited duration', () => {
  const records = buildAuditedProjectionRecords(base, rateCard)
  assert.ok(records)
  // 90s service end + 60s grace = 150s, under the 200s recording: 3 minutes.
  assert.equal(records.calculation?.adjustedChargeableDurationMs, 150_000)
  assert.equal(records.calculation?.billableDurationMs, 180_000)
  assert.equal(records.calculation?.totalAmount, '28.50000000')
  assert.equal(
    records.calculation?.calculationBasis,
    'independent_audited_projection',
  )
  // No model decided this money.
  assert.equal(records.decision.modelProvider, 'none')
  assert.equal(records.decision.modelVersion, AUDITED_PROJECTION_RULESET_VERSION)
})

test('the record states that no consensus cross-check was performed', () => {
  const records = buildAuditedProjectionRecords(base, rateCard)
  assert.ok(records)
  // It must never be mistaken for the consensus-validated pipeline.
  assert.notEqual(
    records.calculation?.calculationBasis,
    'independent_conversation_end',
  )
  assert.match(
    records.decision.decisionOutputJson,
    /single-pass; no consensus cross-check was performed/,
  )
  assert.equal(records.decision.reasonCode, 'INDEPENDENT_AUDITED_PROJECTION')
})

test('the audited amount can never exceed the vendor charge', () => {
  const records = buildAuditedProjectionRecords(
    { ...base, vendorBilledAmount: '9.50000000' },
    rateCard,
  )
  assert.ok(records)
  assert.equal(records.calculation?.totalAmount, '9.50000000')
  assert.match(records.decision.decisionOutputJson, /"cappedByVendorAmount":true/)
})

test('an audit with no service endpoint yields nothing, not a zero', () => {
  // Pricing it at zero would assert a measurement nobody made. The caller
  // settles these from the vendor claim instead.
  assert.equal(
    buildAuditedProjectionRecords({ ...base, serviceEndMs: null }, rateCard),
    null,
  )
})

test('a genuinely zero audited duration is a real zero amount', () => {
  const records = buildAuditedProjectionRecords(
    { ...base, serviceEndMs: 0, graceMs: 0, recordedDurationMs: 0 },
    rateCard,
  )
  assert.ok(records)
  assert.equal(records.calculation?.totalAmount, '0.00000000')
  assert.equal(records.component?.ruleCode, 'ZERO_DURATION_NOT_BILLED')
  assert.equal(records.component?.billingIncrement, 'zero')
})

test('an unpublished rate card refuses the projection too', () => {
  assert.throws(
    () =>
      buildAuditedProjectionRecords(base, { ...rateCard, status: 'draft' }),
    /D-03/,
  )
})
