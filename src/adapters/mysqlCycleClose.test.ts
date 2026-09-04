import assert from 'node:assert/strict'
import test from 'node:test'
import type { Pool } from 'mysql2/promise'
import {
  listAcceptedAsBilledCandidates,
  type CycleCloseCohort,
} from './mysqlCycleClose.ts'

test('cycle close admits recording-backed calls only after audit exhaustion', async () => {
  let statement = ''
  const pool = {
    async execute(sql: string) {
      statement = sql
      return [[]]
    },
  } as unknown as Pool

  await listAcceptedAsBilledCandidates(pool, {
    month: '2026-06',
    label: 'June 2026',
    start: '2026-06-01',
    end: '2026-06-30',
  }, 100)

  assert.match(
    statement,
    /exhausted_recording\.audio_processing_status = 'exhausted'/,
  )
  assert.match(statement, /exhausted_recording\.source_url IS NOT NULL/)
  assert.doesNotMatch(
    statement,
    /audio_processing_status IN \('pending','transcribe_failed'/,
  )
})

async function capture(cohort?: CycleCloseCohort): Promise<string> {
  let statement = ''
  const pool = {
    async execute(sql: string) {
      statement = sql
      return [[]]
    },
  } as unknown as Pool
  await listAcceptedAsBilledCandidates(pool, {
    month: '2026-06',
    label: 'June 2026',
    start: '2026-06-01',
    end: '2026-06-30',
  }, 100, cohort)
  return statement
}

test('the exhausted cohort cannot reach the no-recording population', async () => {
  // The operator asked for the exhausted recording-backed calls only. The
  // no-recording population is a separate, already-zero-rated outcome and a
  // targeted run must not be able to re-price it.
  const statement = await capture('exhausted-recording')

  assert.match(
    statement,
    /exhausted_recording\.audio_processing_status = 'exhausted'/,
  )
  // No "call has no recording at all" branch, and no unresolved-validation
  // branch, may appear in the eligibility predicate.
  assert.doesNotMatch(
    statement,
    /WHERE c\.billing_period_date BETWEEN \? AND \?[\s\S]*?FROM kaudit_automated_decision validation/,
  )
  assert.doesNotMatch(statement, /decision_status = 'unresolved'/)
})

test('the exhausted cohort leaves calls the audit worker will still claim', async () => {
  // mysqlReauditReadRepo re-selects an exhausted artifact whose last error is
  // one of these while attempts remain. Settling those here would take money
  // away from an audit that is still going to run.
  const statement = await capture('exhausted-recording')

  assert.match(statement, /CLASSIFICATION_VALIDATION_FAILED/)
  assert.match(statement, /AUDIT_SPEND_STATE_UNKNOWN/)
  assert.match(
    statement,
    /COALESCE\(exhausted_recording\.audio_attempt_count, 0\)\s*<\s*8/,
  )
})

test('an exhausted recording-backed call reports the exhausted reason', async () => {
  const statement = await capture('exhausted-recording')

  assert.match(statement, /THEN 'audit_exhausted'/)
  // A recording-backed call must never default to the validation reason just
  // because it has a recording.
  assert.match(
    statement,
    /THEN 'audit_exhausted'[\s\S]{0,120}ELSE 'automated_validation_unresolved'/,
  )
})

test('the default cohort keeps the original whole-population eligibility', async () => {
  const statement = await capture()
  const explicit = await capture('all')

  assert.equal(statement, explicit)
  assert.match(statement, /FROM kaudit_automated_decision validation/)
  assert.match(statement, /decision_status = 'unresolved'/)
  assert.match(
    statement,
    /exhausted_recording\.audio_processing_status = 'exhausted'/,
  )
})

test('every cohort still refuses a call that already has a final calculation', async () => {
  for (const cohort of ['all', 'exhausted-recording'] as const) {
    const statement = await capture(cohort)
    assert.match(
      statement,
      /FROM kaudit_billing_calculation calculation[\s\S]{0,200}calculation\.status = 'final'/,
      cohort,
    )
    assert.match(
      statement,
      /newer\.supersedes_calculation_id = calculation\.id/,
      cohort,
    )
  }
})

/**
 * The eligibility clause only.
 *
 * The `fallback_reason` CASE in the SELECT list names every reason whatever
 * the cohort — that is how a row is labelled, not how it is selected. Cohort
 * scoping lives in the WHERE, so that is what these assertions read.
 */
function eligibilityClause(statement: string): string {
  const at = statement.indexOf('WHERE c.billing_period_date')
  assert.ok(at > 0, 'the candidate query must be month-bounded')
  return statement.slice(at)
}

test('the no-recording cohort reaches only calls with no recording', async () => {
  const where = eligibilityClause(await capture('no-recording'))

  assert.match(
    where,
    /NOT EXISTS \(\s*SELECT 1\s*FROM kaudit_call_artifact recording/,
  )
  // It must not reach recording-backed work of any kind.
  assert.doesNotMatch(where, /exhausted_recording/)
  assert.doesNotMatch(where, /decision_status = 'unresolved'/)
})

test('a no-recording call reports the no_recording reason', async () => {
  const statement = await capture('no-recording')
  assert.match(statement, /THEN 'no_recording'/)
})

test('the two targeted cohorts are mutually exclusive by construction', async () => {
  const exhausted = eligibilityClause(await capture('exhausted-recording'))
  const noRecording = eligibilityClause(await capture('no-recording'))

  // A call cannot satisfy both: one requires a final recording with a source
  // URL, the other requires that no such recording exists.
  assert.match(exhausted, /exhausted_recording\.source_url IS NOT NULL/)
  assert.doesNotMatch(noRecording, /exhausted_recording/)
  assert.notEqual(exhausted, noRecording)
})
