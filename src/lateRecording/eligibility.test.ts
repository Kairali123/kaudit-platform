import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  decideLateRecordingRow,
  summarizeLateRecordingDecisions,
  type LateRecordingCallFacts,
} from './eligibility.ts'

/**
 * Every fixture is SYNTHETIC. This suite proves the eligibility rule as a
 * function of facts: no database, no URL, and no network.
 */

const SUBMITTED_HASH = 'a'.repeat(64)
const OTHER_HASH = 'b'.repeat(64)

function call(
  overrides: Partial<LateRecordingCallFacts> = {},
): LateRecordingCallFacts {
  return {
    callId: 'synthetic-call-1',
    artifactId: 'synthetic-artifact-1',
    existingUrlSha256: null,
    evidenceHashRecorded: false,
    invoicePresent: true,
    auditCompleted: false,
    liveCalculationId: 'synthetic-zero-calculation',
    liveCalculationBasis: 'no_recording_zero',
    liveTotalAmount: '0.00000000',
    ...overrides,
  }
}

function decide(
  matches: LateRecordingCallFacts[],
  rateCardAvailable = true,
) {
  return decideLateRecordingRow({
    rateCardAvailable,
    row: {
      rowNumber: 7,
      taskId: 'T-SYNTH-1',
      canonicalUrlSha256: SUBMITTED_HASH,
      matches,
    },
  })
}

test('a settled no-recording call in the month is accepted', () => {
  const outcome = decide([call()])
  assert.deepEqual(outcome.decision, { rowNumber: 7, outcome: 'accepted' })
  assert.equal(outcome.callId, 'synthetic-call-1')
  assert.equal(outcome.artifactId, 'synthetic-artifact-1')
})

test('an UNSETTLED call with no recording is equally eligible', () => {
  const outcome = decide([call({ liveCalculationBasis: null })])
  assert.equal(outcome.decision.outcome, 'accepted')
})

test('exactly one call, or nothing happens', () => {
  assert.deepEqual(decide([]).decision, {
    rowNumber: 7,
    outcome: 'rejected',
    code: 'TASK_NOT_FOUND',
  })
  assert.deepEqual(
    decide([call(), call({ callId: 'synthetic-call-2' })]).decision,
    { rowNumber: 7, outcome: 'rejected', code: 'TASK_AMBIGUOUS' },
  )
})

test('an already-audited call is never re-audited by an upload', () => {
  assert.deepEqual(decide([call({ auditCompleted: true })]).decision, {
    rowNumber: 7,
    outcome: 'rejected',
    code: 'AUDIT_ALREADY_COMPLETED',
  })
})

test('a call settled on OTHER evidence is not reopened here', () => {
  for (const basis of [
    'independent_conversation_end',
    'independent_category_service_end',
    'independent_audited_projection',
    'accepted_as_billed_unverified',
  ]) {
    assert.deepEqual(
      decide([call({ liveCalculationBasis: basis })]).decision,
      { rowNumber: 7, outcome: 'rejected', code: 'CALL_STATE_INELIGIBLE' },
    )
  }
})

test('a month with no received invoice is refused', () => {
  assert.deepEqual(decide([call({ invoicePresent: false })]).decision, {
    rowNumber: 7,
    outcome: 'rejected',
    code: 'INVOICE_MISSING',
  })
})

test('a call with no recording artifact has nothing to attach to', () => {
  assert.deepEqual(decide([call({ artifactId: null })]).decision, {
    rowNumber: 7,
    outcome: 'rejected',
    code: 'RECORDING_ARTIFACT_MISSING',
  })
})

test('the same task and the same canonical URL is an idempotent replay', () => {
  assert.deepEqual(
    decide([call({ existingUrlSha256: SUBMITTED_HASH })]).decision,
    { rowNumber: 7, outcome: 'duplicate_replay' },
  )
})

test('a DIFFERENT URL on an attached artifact is a conflict, never an overwrite', () => {
  const outcome = decide([call({ existingUrlSha256: OTHER_HASH })])
  assert.deepEqual(outcome.decision, {
    rowNumber: 7,
    outcome: 'rejected',
    code: 'RECORDING_URL_ALREADY_PRESENT',
  })
  // Nothing to write: a conflict never names a call to act on.
  assert.equal(outcome.callId, undefined)
})

test('an artifact that already carries an evidence hash is immutable', () => {
  assert.deepEqual(
    decide([call({ evidenceHashRecorded: true })]).decision,
    { rowNumber: 7, outcome: 'rejected', code: 'RECORDING_URL_ALREADY_PRESENT' },
  )
})

test('without a published rate card nothing is accepted at all', () => {
  // Money cannot be written without one, so an upload that could never be
  // priced is refused before anything is attached rather than after.
  assert.deepEqual(decide([call()], false).decision, {
    rowNumber: 7,
    outcome: 'rejected',
    code: 'RATE_CARD_UNAVAILABLE',
  })
})

test('the summary counts each outcome and orders rows as the sheet does', () => {
  const summary = summarizeLateRecordingDecisions(
    [
      { rowNumber: 5, outcome: 'rejected', code: 'TASK_NOT_FOUND' },
      { rowNumber: 2, outcome: 'accepted' },
      { rowNumber: 4, outcome: 'duplicate_replay' },
      { rowNumber: 3, outcome: 'rejected', code: 'TASK_NOT_FOUND' },
    ],
    4,
  )
  assert.deepEqual(
    summary.decisions.map((decision) => decision.rowNumber),
    [2, 3, 4, 5],
  )
  assert.equal(summary.acceptedCount, 1)
  assert.equal(summary.duplicateCount, 1)
  assert.equal(summary.rejectedCount, 2)
  assert.deepEqual(summary.rejectionCounts, { TASK_NOT_FOUND: 2 })
})
