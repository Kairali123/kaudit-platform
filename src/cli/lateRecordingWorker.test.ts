import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { decideLateRecordingOutcome } from '../lateRecording/eligibility.ts'

/**
 * Contract for the late-recording worker.
 *
 * The decision function is exercised directly; the runner itself is READ AS
 * SOURCE, because importing it would start a run. Nothing here opens a
 * connection, calls a provider, or spends anything.
 */

const source = readFileSync(
  new URL('./run-late-recording-worker.ts', import.meta.url),
  'utf8',
)

test('an audited recording is priced from its own audited duration', () => {
  assert.equal(
    decideLateRecordingOutcome({
      auditCompleted: true,
      auditExhausted: false,
    }),
    'audited_projection',
  )
})

test('attached evidence the audit could not resolve uses the approved fallback', () => {
  // It must never be left silently described as no_recording_zero: a recording
  // exists now, and a record saying none was found would be false.
  assert.equal(
    decideLateRecordingOutcome({
      auditCompleted: false,
      auditExhausted: true,
    }),
    'accepted_as_billed_unverified',
  )
})

test('an audit still in flight writes no money at all', () => {
  assert.equal(
    decideLateRecordingOutcome({
      auditCompleted: false,
      auditExhausted: false,
    }),
    'in_flight',
  )
})

test('a completed audit outranks an exhausted flag', () => {
  // A call can be both: the last attempt failed after an earlier one wrote a
  // result. The result is what the money is priced from.
  assert.equal(
    decideLateRecordingOutcome({
      auditCompleted: true,
      auditExhausted: true,
    }),
    'audited_projection',
  )
})

test('the runner accepts an opaque batch handle and refuses anything else', () => {
  assert.match(source, /const BATCH_ID = \/\^lrb_\[0-9a-f-\]\{36\}\$\//)
  assert.match(
    source,
    /KAUDIT_LATE_RECORDING_BATCH_ID is not a batch handle/,
  )
  // A batch id is the ONLY scope input. No task, call, or URL variable exists.
  assert.doesNotMatch(source, /KAUDIT_LATE_RECORDING_(?:TASK|CALL|URL)/)
  assert.doesNotMatch(source, /KAUDIT_AUDIT_SCOPE_FILE/)
})

test('the runner shares the Billing Audit advisory lock and the spend lease', () => {
  // Two runs must never pay twice for one recording, so the late-recording
  // scope takes the same lock and the same durable pre-model lease as the
  // general billing worker rather than inventing its own.
  assert.match(source, /kaudit-independent-reaudit-v2/)
  assert.match(source, /createMysqlBillingSpendGuard/)
  assert.match(source, /createMysqlTranscriptionCache/)
})

test('the correction supersedes rather than settling for the first time', () => {
  // `firstSettlement` skips the supersede probe, which is exactly the probe a
  // correction needs: the new calculation must name the no_recording_zero row
  // it replaces, and that row must survive unchanged.
  assert.match(source, /persistVerifiedBillingRecords\(/)
  // The option is discussed in a comment and deliberately never PASSED.
  assert.doesNotMatch(source, /firstSettlement\s*:/)
  assert.match(source, /supersededCalculationId: facts\.baselineCalculationId/)
})

test('an interrupted money write is completed without writing money twice', () => {
  assert.match(source, /facts\.persistedRevisedAmount != null/)
  const recovered = source.indexOf('facts.persistedRevisedAmount != null')
  const validate = source.indexOf('const outcome = decideLateRecordingOutcome')
  assert.ok(recovered > 0 && recovered < validate)
})

test('the month summary cache is dropped before the revised total is read', () => {
  const invalidate = source.indexOf('summaries.invalidate')
  const revised = source.indexOf('const revisedVerifiedTotal')
  assert.ok(invalidate > 0 && revised > invalidate)
})

test('the runner never writes the actual-paid settlement table', () => {
  // That table is what Finance actually paid. The correction records a
  // PROPOSAL and leaves accepting it an explicit Finance action.
  assert.doesNotMatch(source, /INSERT INTO kaudit_kserve_monthly_settlement/)
  assert.match(source, /proposedFinanceAdjustment/)
  assert.match(source, /readActualPaidAmount/)
})

test('nothing the runner prints can carry a URL or a task reference', () => {
  // Every stdout write goes through `report`, which serializes a bounded
  // object, and no call site passes a URL or a task reference into it.
  const reports = source.match(/report\(\{[\s\S]*?\}\)/g) ?? []
  assert.ok(reports.length > 0)
  for (const call of reports) {
    assert.doesNotMatch(call, /sourceUrl|source_url|taskReference|https?:/)
  }
  assert.doesNotMatch(source, /console\.log/)
  // The final handler reduces any failure to a phase and a bounded category.
  assert.match(source, /LATE_RECORDING_WORKER_FAILED/)
})

test('a corrected call runs the approved validation and adjudication policy', () => {
  // Scoped to that exact call through the shared runner, so a correction
  // applies the same policy the month-wide runner does without ever
  // validating a call the administrator did not upload.
  assert.match(source, /runAutomatedValidation\(/)
  assert.match(source, /collectAutomatedValidationCandidates\(/)
  assert.match(source, /callIds: \[options\.callId\]/)
  assert.match(source, /createOpenAiConsensusReviewer/)
})

test('a resolved consensus is the money, and the projection is the fallback', () => {
  // When consensus resolves it has already written the superseding verified
  // calculation, so the projection must not write a second one on top.
  const resolved = source.indexOf("validated?.billingStatus === 'final'")
  // The projection call site, not the import line at the top of the file.
  const projection = source.indexOf('? buildAuditedProjectionRecords(')
  assert.ok(resolved > 0 && projection > resolved)
  assert.match(source, /return 'corrected'/)
})
