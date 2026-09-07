import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_INGEST_QUIET_PERIOD_MS,
  decideMonthCloseReadiness,
} from './monthCloseReadiness.ts'

const LOADED_AND_QUIET = DEFAULT_INGEST_QUIET_PERIOD_MS + 60_000

test('a fully loaded and fully audited month is ready', () => {
  const decision = decideMonthCloseReadiness({
    totalCalls: 27_705,
    recordingBackedAwaitingAudit: 0,
    millisecondsSinceNewestCall: LOADED_AND_QUIET,
  })
  assert.equal(decision.ready, true)
  assert.equal(decision.reason, 'ready')
})

test('an ended month with no data is not a month settled at zero', () => {
  // August had ended and had not been uploaded. A calendar cannot tell that
  // apart from a month where the vendor supplied nothing.
  const decision = decideMonthCloseReadiness({
    totalCalls: 0,
    recordingBackedAwaitingAudit: 0,
    millisecondsSinceNewestCall: null,
  })
  assert.equal(decision.ready, false)
  assert.equal(decision.reason, 'no_calls_loaded')
})

test('a month still being uploaded waits', () => {
  // This is the dangerous case: calls present, recordings not yet arrived.
  // Settling now would price the whole month at zero and mark it done.
  const decision = decideMonthCloseReadiness({
    totalCalls: 12_000,
    recordingBackedAwaitingAudit: 0,
    millisecondsSinceNewestCall: 60_000,
  })
  assert.equal(decision.ready, false)
  assert.equal(decision.reason, 'ingest_in_progress')
})

test('an unknown ingest age waits rather than assuming it was long ago', () => {
  const decision = decideMonthCloseReadiness({
    totalCalls: 12_000,
    recordingBackedAwaitingAudit: 0,
    millisecondsSinceNewestCall: null,
  })
  assert.equal(decision.ready, false)
  assert.equal(decision.reason, 'ingest_in_progress')
})

test('a loaded month whose audit has not finished waits', () => {
  const decision = decideMonthCloseReadiness({
    totalCalls: 27_705,
    recordingBackedAwaitingAudit: 9_219,
    millisecondsSinceNewestCall: LOADED_AND_QUIET,
  })
  assert.equal(decision.ready, false)
  assert.equal(decision.reason, 'audit_incomplete')
})

test('calls the audit has terminally given up on are not waited for', () => {
  // July closed with 34 exhausted calls. They settle on the vendor's figure
  // and are finished with the audit, so they must not hold a month open
  // forever.
  const decision = decideMonthCloseReadiness({
    totalCalls: 27_705,
    recordingBackedAwaitingAudit: 0,
    millisecondsSinceNewestCall: LOADED_AND_QUIET,
  })
  assert.equal(decision.ready, true)
})

test('the quiet period is configurable but defaults to two days', () => {
  assert.equal(DEFAULT_INGEST_QUIET_PERIOD_MS, 172_800_000)
  const decision = decideMonthCloseReadiness({
    totalCalls: 10,
    recordingBackedAwaitingAudit: 0,
    millisecondsSinceNewestCall: 60_000,
    quietPeriodMs: 30_000,
  })
  assert.equal(decision.ready, true)
})
