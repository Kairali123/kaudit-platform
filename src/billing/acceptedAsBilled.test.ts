import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildAcceptedAsBilledRecords,
} from './acceptedAsBilled.ts'
import {
  KSERVE_RULESET_SHA256,
} from './kserveRules.ts'

const rateCard = {
  id: 'test-rate-card',
  version: 'april-test.1',
  status: 'published',
  currency: 'INR' as const,
  rulesetSha256: KSERVE_RULESET_SHA256,
  approvedBy: 'finance@example.invalid',
  approvedAt: '2026-04-30T12:00:00.000Z',
}

test('creates an explicit final accepted-as-billed record without pretending an AI audit ran', () => {
  const records = buildAcceptedAsBilledRecords({
    callId: 'call-1',
    claimedDurationMs: 14_000,
    connectedDurationMs: 14_000,
    vendorBilledMinutes: '0.50000000',
    vendorBilledAmount: '5.25000000',
    sourceEvidence: {
      kind: 'call_manifest',
      referenceId: 'usage-file-1',
      sha256: 'a'.repeat(64),
    },
    decidedAt: '2026-04-30T12:00:00.000Z',
  }, rateCard)
  assert.equal(
    records.calculation?.calculationBasis,
    'accepted_as_billed_unverified',
  )
  assert.equal(records.calculation?.auditRunId, null)
  assert.equal(records.calculation?.billableDurationMs, 30_000)
  assert.equal(records.calculation?.totalAmount, '5.25000000')
  assert.ok(records.component)
  assert.equal(records.component.rawUnit, 'INR')
  assert.equal(
    records.component.billingIncrement,
    'vendor_asserted_amount',
  )
  assert.equal(records.decision.modelProvider, 'none')
  assert.equal(
    records.decision.reasonCode,
    'NO_RECORDING_ACCEPTED_AS_BILLED',
  )
})

test('requires a published card and exact half-minute vendor quantity', () => {
  const input = {
    callId: 'call-1',
    claimedDurationMs: null,
    connectedDurationMs: null,
    vendorBilledMinutes: '0.25000000',
    sourceEvidence: {
      kind: 'call_manifest' as const,
      referenceId: 'usage-file-1',
      sha256: 'b'.repeat(64),
    },
    decidedAt: '2026-04-30T12:00:00.000Z',
  }
  assert.throws(
    () => buildAcceptedAsBilledRecords(input, rateCard),
    /0.5-minute/,
  )
  assert.throws(
    () =>
      buildAcceptedAsBilledRecords(
        { ...input, vendorBilledMinutes: '0.50000000' },
        { ...rateCard, status: 'draft' },
      ),
    /D-03/,
  )
})

test('calculates from billed minutes only when KServe amount is blank', () => {
  const records = buildAcceptedAsBilledRecords({
    callId: 'call-legacy',
    claimedDurationMs: null,
    connectedDurationMs: null,
    vendorBilledMinutes: '0.50000000',
    vendorBilledAmount: null,
    sourceEvidence: {
      kind: 'call_manifest',
      referenceId: 'usage-file-legacy',
      sha256: 'c'.repeat(64),
    },
    decidedAt: '2026-04-30T12:00:00.000Z',
  }, rateCard)
  assert.equal(records.calculation?.totalAmount, '4.75000000')
})
