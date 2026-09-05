import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_VENDOR_ASSERTED_FLOOR,
  decideVendorAssertedBound,
} from './vendorAssertedBound.ts'

test('ordinary attrition settles automatically', () => {
  // June closed with 36 exhausted calls out of 14,925 recording-backed ones,
  // and July with 21 out of 11,530. Both are the case this bound must wave
  // through without an operator being involved at all.
  for (const month of [
    { exhaustedCandidates: 36, recordingBackedCalls: 14_925 },
    { exhaustedCandidates: 21, recordingBackedCalls: 11_530 },
  ]) {
    const decision = decideVendorAssertedBound(month)
    assert.equal(decision.permitted, true)
    assert.equal(decision.reason, 'within_bound')
  }
})

test('a month whose audit failed at scale refuses to settle on the vendor word', () => {
  const decision = decideVendorAssertedBound({
    exhaustedCandidates: 4_000,
    recordingBackedCalls: 11_530,
  })
  assert.equal(decision.permitted, false)
  assert.equal(decision.reason, 'exceeds_bound')
  // The share is reported so the refusal names its own magnitude rather than
  // leaving the reader to divide two numbers out of a log line.
  assert.ok((decision.share ?? 0) > 0.34)
})

test('a small month is bounded by the floor, not by the share', () => {
  // 20 of 200 is 10%, far past the share, and still only twenty calls.
  const decision = decideVendorAssertedBound({
    exhaustedCandidates: 20,
    recordingBackedCalls: 200,
  })
  assert.equal(decision.permitted, true)
  assert.equal(decision.allowance, DEFAULT_VENDOR_ASSERTED_FLOOR)
})

test('nothing to settle is permitted and says so', () => {
  const decision = decideVendorAssertedBound({
    exhaustedCandidates: 0,
    recordingBackedCalls: 11_530,
  })
  assert.equal(decision.permitted, true)
  assert.equal(decision.reason, 'nothing_to_settle')
})

test('an uncountable population is not treated as a small one', () => {
  // A failed or empty denominator must not read as "0 calls, so any share is
  // infinite" NOR as "no limit". Only the floor can be applied honestly.
  const withinFloor = decideVendorAssertedBound({
    exhaustedCandidates: 10,
    recordingBackedCalls: 0,
  })
  assert.equal(withinFloor.permitted, true)
  assert.equal(withinFloor.share, null)

  const beyondFloor = decideVendorAssertedBound({
    exhaustedCandidates: 5_000,
    recordingBackedCalls: 0,
  })
  assert.equal(beyondFloor.permitted, false)
  assert.equal(beyondFloor.reason, 'population_unknown')
})

test('the bound is configurable in both directions', () => {
  const strict = decideVendorAssertedBound({
    exhaustedCandidates: 36,
    recordingBackedCalls: 14_925,
    maxShare: 0.001,
    floor: 0,
  })
  assert.equal(strict.permitted, false)
  assert.equal(strict.allowance, 15)
})
