import assert from 'node:assert/strict'
import test from 'node:test'
import {
  ACCEPTED_AS_BILLED_RULESET,
  ACCEPTED_AS_BILLED_RULESET_SHA256,
  ACCEPTED_AS_BILLED_RULESET_VERSION,
  buildAcceptedAsBilledRecords,
  validateRateCard,
} from './acceptedAsBilled.ts'
import {
  KSERVE_RULESET_SHA256,
} from './kserveRules.ts'
import {
  canonicalJsonSha256,
  type JsonValue,
} from '../messaging/canonicalJson.ts'

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
    'no_recording_zero',
  )
  assert.equal(records.calculation?.auditRunId, null)
  assert.equal(records.calculation?.billableDurationMs, 0)
  assert.equal(records.calculation?.totalAmount, '0.00000000')
  assert.ok(records.component)
  assert.equal(records.component.ruleCode, 'NO_RECORDING_ZERO')
  assert.equal(records.component.rawUnit, 'INR')
  assert.equal(
    records.component.billingIncrement,
    'no_recording_zero',
  )
  assert.equal(records.decision.modelProvider, 'none')
  assert.equal(
    records.decision.reasonCode,
    'NO_RECORDING_FOUND_ZERO',
  )
  assert.match(
    records.decision.decisionOutputJson,
    /No Recording Found/,
  )
  const trace = JSON.parse(records.decision.decisionOutputJson) as {
    vendorBilledAmount: string
    amount: string
  }
  assert.equal(trace.vendorBilledAmount, '5.25000000')
  assert.equal(trace.amount, '0.00000000')
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
    fallbackReason: 'automated_validation_unresolved',
    sourceEvidence: {
      kind: 'call_manifest',
      referenceId: 'usage-file-legacy',
      sha256: 'c'.repeat(64),
    },
    decidedAt: '2026-04-30T12:00:00.000Z',
  }, rateCard)
  assert.equal(records.calculation?.totalAmount, '4.75000000')
  assert.equal(
    records.calculation?.calculationBasis,
    'accepted_as_billed_unverified',
  )
})

test('an exhausted audit is recorded as exhausted, not as an unresolved validation', () => {
  // The operator's rule: when the AI could not audit and gave up, settle the
  // call from KServe's own amount and time. That is a different fact from a
  // validation that ran and could not resolve, so it gets its own reason.
  const records = buildAcceptedAsBilledRecords({
    callId: 'call-exhausted',
    auditRunId: 'run-exhausted',
    claimedDurationMs: 92_000,
    connectedDurationMs: 88_000,
    vendorBilledMinutes: '2.00000000',
    vendorBilledAmount: '19.00000000',
    fallbackReason: 'audit_exhausted',
    sourceEvidence: {
      kind: 'call_manifest',
      referenceId: 'usage-file-exhausted',
      sha256: 'd'.repeat(64),
    },
    decidedAt: '2026-06-30T18:29:59.999Z',
  }, rateCard)

  assert.equal(
    records.decision.reasonCode,
    'INDEPENDENT_AUDIT_EXHAUSTED_ACCEPTED_AS_BILLED',
  )
  assert.equal(records.decision.findingType, 'INDEPENDENT_AUDIT_EXHAUSTED')
  // It must never be mislabelled as the validation outcome.
  assert.doesNotMatch(
    records.decision.decisionOutputJson,
    /Automated validation remained unresolved/,
  )
  assert.match(
    records.decision.decisionOutputJson,
    /exhausted its retry budget/,
  )
  // No model decided this money.
  assert.equal(records.decision.modelProvider, 'none')
  assert.equal(records.decision.recheckAttempt, 0)
})

test('an exhausted call is billed from the stored KServe amount and time', () => {
  const records = buildAcceptedAsBilledRecords({
    callId: 'call-exhausted-amount',
    claimedDurationMs: 92_000,
    connectedDurationMs: 88_000,
    vendorBilledMinutes: '2.00000000',
    vendorBilledAmount: '19.00000000',
    fallbackReason: 'audit_exhausted',
    sourceEvidence: {
      kind: 'call_manifest',
      referenceId: 'usage-file-exhausted',
      sha256: 'd'.repeat(64),
    },
    decidedAt: '2026-06-30T18:29:59.999Z',
  }, rateCard)

  // KServe's own asserted amount, at fixed precision — never recomputed.
  assert.equal(records.calculation?.totalAmount, '19.00000000')
  assert.equal(records.calculation?.subtotalAmount, '19.00000000')
  assert.equal(records.calculation?.taxAmount, '0.00000000')
  // KServe's own durations are carried through unchanged.
  assert.equal(records.calculation?.claimedDurationMs, 92_000)
  assert.equal(records.calculation?.connectedDurationMs, 88_000)
  assert.equal(records.calculation?.billableDurationMs, 120_000)
  // No independently measured duration is invented for an unaudited call.
  assert.equal(records.calculation?.recordedDurationMs, null)
  assert.equal(records.calculation?.speechDurationMs, null)
  assert.equal(records.calculation?.adjustedChargeableDurationMs, null)
  // The basis stays the shared accepted-as-billed one, so the monitor's
  // resolved-fallback rule keeps recognising it.
  assert.equal(
    records.calculation?.calculationBasis,
    'accepted_as_billed_unverified',
  )
  assert.equal(records.component?.billingIncrement, 'vendor_asserted_amount')
})

test('an exhausted call with no KServe amount falls back to the locked rate', () => {
  const records = buildAcceptedAsBilledRecords({
    callId: 'call-exhausted-legacy',
    claimedDurationMs: null,
    connectedDurationMs: null,
    vendorBilledMinutes: '1.50000000',
    vendorBilledAmount: null,
    fallbackReason: 'audit_exhausted',
    sourceEvidence: {
      kind: 'call_manifest',
      referenceId: 'usage-file-exhausted-legacy',
      sha256: 'e'.repeat(64),
    },
    decidedAt: '2026-06-30T18:29:59.999Z',
  }, rateCard)

  assert.equal(records.calculation?.totalAmount, '14.25000000')
  assert.equal(records.component?.billingIncrement, 'vendor_0.5_min')
})

test('the exhausted trigger is versioned into the fallback ruleset identity', () => {
  // Changing what the fallback may be triggered by changes the ruleset, so the
  // version must move with it or an old and new decision become indistinguishable.
  assert.equal(
    ACCEPTED_AS_BILLED_RULESET_VERSION,
    'cycle-close-fallback/1.4.0',
  )
  assert.ok(
    (ACCEPTED_AS_BILLED_RULESET.triggers as string[]).includes(
      'independent_audit_exhausted_at_cycle_close',
    ),
  )
  assert.equal(
    ACCEPTED_AS_BILLED_RULESET_SHA256,
    canonicalJsonSha256(ACCEPTED_AS_BILLED_RULESET as unknown as JsonValue),
  )
})

test('a rate card not bound to the locked ruleset can be refused before any work', () => {
  // The finalizer checks this once up front; it must be the same refusal the
  // record build makes, so a pre-check can never pass what a build rejects.
  assert.throws(
    () => validateRateCard({ ...rateCard, rulesetSha256: 'f'.repeat(64) }),
    /D-03/,
  )
  assert.throws(
    () => validateRateCard({ ...rateCard, approvedBy: null }),
    /D-03/,
  )
  assert.doesNotThrow(() => validateRateCard(rateCard))
})
