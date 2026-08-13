import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  CallAuditProcessorError,
  processCallAuditCandidate,
  type ProcessCallAuditCandidateInput,
} from './processor.ts'
import {
  buildResultId,
  buildUsageEventId,
  type CallAuditMetricScoreRecord,
  type CallAuditResultBundle,
  type CallAuditUsageEventRecord,
} from './resultRecords.ts'
import { buildSourceRevision } from './sourceRevision.ts'
import {
  CALL_AUDIT_SPEND_SKIP_CODES,
  type CallAuditSpendClaimResult,
  type CallAuditSpendSkipCode,
  type ContentAuditSpendClaimInput,
} from './spendClaim.ts'
import {
  CALL_AUDIT_SOURCE_TABLE,
  type CallAuditSourceReference,
  type InternalSourceCandidate,
} from './sourceTypes.ts'
import { validateContentAuditOutput } from './modelOutput.ts'
import { CALL_AUDIT_METRIC_CODES, CALL_AUDIT_RUBRIC } from './rubric.ts'
import type { MetricScore } from './types.ts'
import type {
  CallAuditPersistenceRepository,
  SourceReferencePersistResult,
} from '../adapters/mysqlCallAuditPersistence.ts'
import {
  CONTENT_AUDIT_ERROR_CODES,
  type ActivatedContentAuditModel,
  type ContentAuditModelAdapter,
  type ContentAuditModelRequest,
  type ContentAuditModelResult,
  type ContentAuditUsageFacts,
} from '../adapters/openaiCallAuditModel.ts'

/**
 * Every fixture below is SYNTHETIC. No real transcript, lead, customer, or
 * recording appears in this file, and no test reaches a database, a network, a
 * clock, or a model provider: both collaborators are fakes.
 */

const TRANSCRIPT =
  'Saanvi: good morning, this is Saanvi from Kairali.\n' +
  'Caller: yes, I want to know about the panchakarma package.'

/** Uppercase by construction, so it can never collide with a lowercase hex id. */
const LEAD_ID = 'LEAD-SYNTH-ZQXJ0918'
const TASK_ID = 'ZQXJ0918'

const RUN_ID = 'run_synth_0001'
const RULE_VERSION_ID = 'crv_synth_0001'
const AUDITED_AT = '2026-08-01 10:00:00.000000'
const RECORDED_AT = '2026-08-01 10:00:02.500000'

function syntheticCandidate(
  overrides: Partial<InternalSourceCandidate> = {},
): InternalSourceCandidate {
  return {
    sourceTable: CALL_AUDIT_SOURCE_TABLE,
    sourceRowId: '5510',
    leadId: LEAD_ID,
    transcript: TRANSCRIPT,
    effectiveCallTime: '2026-08-01 09:15:00.000000',
    sourceUpdatedAt: '2026-08-01 09:20:00.000000',
    callStartedAt: '2026-08-01 09:15:00.000000',
    callEndedAt: '2026-08-01 09:16:24.000000',
    callDurationSec: '00:01:24',
    company_by_kserve: 'Kairali',
    company: 'Kairali Ayurvedic Group',
    data_source: 'website_form',
    verified_source: 'verified_web',
    service_category: 'panchakarma',
    call_type: 'outbound',
    call_status: 'connected',
    call_end_reason: 'customer_hangup',
    final_call_status: 'completed',
    ai_call_category: 'information_request',
    customer_engagement_level: 'engaged',
    interest_level: 'high',
    call_outcome: 'callback_requested',
    lead_status: 'qualified',
    // The KServe-reported outcome, exactly as the approved taxonomy states it.
    final_lead_outcome: 'Individual Resort Booking',
    calculated_qualification_status: 'qualified',
    followup_required: 'yes',
    ...overrides,
  }
}

function syntheticActivation(): ActivatedContentAuditModel {
  return {
    versionLabel: 'v1-synthetic',
    businessPrompt: 'Audit the Saanvi call against the approved rubric.',
    modelProvider: 'openai',
    modelName: 'gpt-synth-mini',
    modelVersion: '2026-05-01',
    temperature: '0.000',
  }
}

function syntheticUsage(
  overrides: Partial<ContentAuditUsageFacts> = {},
): ContentAuditUsageFacts {
  return {
    provider: 'openai',
    modelName: 'gpt-synth-mini',
    modelVersion: '2026-05-01',
    requestId: 'req_synth_0001',
    inputTokens: '1200',
    outputTokens: '340',
    totalTokens: '1540',
    latencyMs: '820',
    ...overrides,
  }
}

function scores(fill: MetricScore): Array<{ metric: string; score: MetricScore }> {
  return CALL_AUDIT_METRIC_CODES.map((metric) => ({ metric, score: fill }))
}

/** A validated output built through the authoritative application validator. */
function syntheticOutput(overrides: Record<string, unknown> = {}) {
  return validateContentAuditOutput(
    {
      callConnected: true,
      customerSpoke: true,
      meaningfulConversation: true,
      intent: 'WARM',
      detailedOutcome: 'Individual Resort Booking',
      qualification: 'QUALIFIED',
      nextAction: 'SCHEDULE_BOOKING',
      confidence: 0.82,
      metricScores: scores(4),
      issueFlags: ['WEAK_NEXT_STEP'],
      managementSummary: 'Caller asked about a resort stay and wants a callback.',
      kserveFeedback: 'Agent skipped confirming the preferred travel window.',
      improvementFeedback: 'Confirm dates before closing the call.',
      ...overrides,
    },
    { eligibility: 'content_auditable' },
  )
}

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

type RepositoryCall =
  | { kind: 'sourceRef'; reference: CallAuditSourceReference }
  | { kind: 'spendClaim'; input: ContentAuditSpendClaimInput }
  | { kind: 'resultBundle'; bundle: CallAuditResultBundle }
  | { kind: 'usageAttempt'; record: CallAuditUsageEventRecord }

interface FakeRepository extends CallAuditPersistenceRepository {
  /** Every write, in the order it was made. */
  calls: RepositoryCall[]
}

/** Matches the varchar(40) shape of a real source-reference id exactly. */
function sourceRefId(marker: string): string {
  return `cas_${marker.padEnd(36, 'a')}`
}

const DEFAULT_SOURCE_REF: SourceReferencePersistResult = {
  id: sourceRefId('synthinserted'),
  outcome: 'inserted',
}

function fakeRepository(
  sourceRef: SourceReferencePersistResult = DEFAULT_SOURCE_REF,
  claim: CallAuditSpendClaimResult = { outcome: 'claimed' },
): FakeRepository {
  const calls: RepositoryCall[] = []
  return {
    calls,
    async upsertSourceReference(reference) {
      calls.push({ kind: 'sourceRef', reference })
      return sourceRef
    },
    async claimContentAuditSpend(input) {
      calls.push({ kind: 'spendClaim', input })
      return claim
    },
    async saveResultBundle(bundle) {
      calls.push({ kind: 'resultBundle', bundle })
      return { outcome: 'inserted' }
    },
    async recordUsageAttempt(record) {
      calls.push({ kind: 'usageAttempt', record })
      return { outcome: 'inserted' }
    },
  }
}

interface FakeModel extends ContentAuditModelAdapter {
  /** Every request the processor made. Should never exceed one. */
  requests: ContentAuditModelRequest[]
}

function fakeModel(result: ContentAuditModelResult): FakeModel {
  const requests: ContentAuditModelRequest[] = []
  return {
    requests,
    async auditTranscript(request) {
      requests.push(request)
      return result
    },
  }
}

function succeededResult(): ContentAuditModelResult {
  return {
    status: 'succeeded',
    output: syntheticOutput(),
    usage: syntheticUsage(),
  }
}

function refusedResult(): ContentAuditModelResult {
  return {
    status: 'refused',
    failure: {
      kind: 'refusal',
      errorCode: CONTENT_AUDIT_ERROR_CODES.refused,
    },
    usage: syntheticUsage({ outputTokens: null, totalTokens: null }),
  }
}

function failedResult(
  kind: 'invalid_output' | 'transport',
): ContentAuditModelResult {
  return {
    status: 'failed',
    failure: {
      kind,
      errorCode:
        kind === 'invalid_output'
          ? CONTENT_AUDIT_ERROR_CODES.invalidOutput
          : CONTENT_AUDIT_ERROR_CODES.requestFailed,
    },
    usage:
      kind === 'transport'
        ? syntheticUsage({
            requestId: null,
            inputTokens: null,
            outputTokens: null,
            totalTokens: null,
          })
        : syntheticUsage(),
  }
}

/**
 * Provider prose, a fake credential, and the transcript itself — the three
 * things a real provider error is most likely to echo back. All synthetic.
 */
const PROVIDER_PROSE = 'upstream 502: model could not summarise this conversation'
const FAKE_SECRET = 'sk' + '-synthetic-NOTAREALKEY-0000'

/** An adapter that breaks its own contract by throwing instead of returning. */
function throwingModel(): FakeModel {
  const requests: ContentAuditModelRequest[] = []
  return {
    requests,
    async auditTranscript(request) {
      requests.push(request)
      throw new Error(
        `${PROVIDER_PROSE} | authorization: Bearer ${FAKE_SECRET} ` +
          `| request body was: ${TRANSCRIPT}`,
      )
    },
  }
}

function processInput(
  overrides: Partial<ProcessCallAuditCandidateInput> = {},
): ProcessCallAuditCandidateInput {
  return {
    runId: RUN_ID,
    ruleVersionId: RULE_VERSION_ID,
    activation: syntheticActivation(),
    candidate: syntheticCandidate(),
    attemptNumber: 1,
    auditedAt: AUDITED_AT,
    recordedAt: RECORDED_AT,
    repository: fakeRepository(),
    model: fakeModel(succeededResult()),
    ...overrides,
  }
}

function kinds(repository: FakeRepository): string[] {
  return repository.calls.map((call) => call.kind)
}

function savedBundle(repository: FakeRepository): CallAuditResultBundle {
  const call = repository.calls.find((entry) => entry.kind === 'resultBundle')
  assert.ok(call, 'expected a result bundle to be saved')
  return (call as { kind: 'resultBundle'; bundle: CallAuditResultBundle }).bundle
}

function savedUsage(repository: FakeRepository): CallAuditUsageEventRecord {
  const call = repository.calls.find((entry) => entry.kind === 'usageAttempt')
  assert.ok(call, 'expected a usage attempt to be recorded')
  return (
    call as { kind: 'usageAttempt'; record: CallAuditUsageEventRecord }
  ).record
}

// ---------------------------------------------------------------------------
// Operational-only path
// ---------------------------------------------------------------------------

test('a call with no transcript persists an operational-only result and never calls the model', async () => {
  const repository = fakeRepository()
  const model = fakeModel(succeededResult())
  const summary = await processCallAuditCandidate(
    processInput({
      candidate: syntheticCandidate({ transcript: null }),
      repository,
      model,
    }),
  )

  assert.deepEqual(kinds(repository), ['sourceRef', 'resultBundle'])
  assert.equal(model.requests.length, 0, 'no transcript means no model spend')

  const bundle = savedBundle(repository)
  assert.equal(bundle.result.processingStatus, 'succeeded')
  assert.equal(bundle.result.eligibility, 'operational_only')
  assert.equal(bundle.result.ineligibilityReason, 'missing_transcript')
  assert.deepEqual(bundle.metricScores, [])
  assert.equal(bundle.result.errorCode, null)

  assert.equal(summary.modelAttempted, false)
  assert.equal(summary.usage, null)
  assert.equal(summary.result.eligibility, 'operational_only')
})

test('a whitespace-only transcript is operational-only, not an empty audit', async () => {
  const repository = fakeRepository()
  const model = fakeModel(succeededResult())
  const summary = await processCallAuditCandidate(
    processInput({
      candidate: syntheticCandidate({ transcript: '   \n\t  ' }),
      repository,
      model,
    }),
  )

  assert.equal(model.requests.length, 0)
  assert.equal(summary.result.eligibility, 'operational_only')
  assert.equal(summary.usage, null)
})

// ---------------------------------------------------------------------------
// Successful content path
// ---------------------------------------------------------------------------

test('a transcript is audited once and persists the result, its metric rows, and a succeeded attempt', async () => {
  const repository = fakeRepository()
  const model = fakeModel(succeededResult())
  const summary = await processCallAuditCandidate(
    processInput({ repository, model }),
  )

  // The ordering is the contract: the result identity needs the persisted
  // source ref id, and the usage event needs the result row to exist.
  assert.deepEqual(kinds(repository), [
    'sourceRef',
    // The spend claim is taken BEFORE the model, and after the revision it is
    // keyed by has been persisted.
    'spendClaim',
    'resultBundle',
    'usageAttempt',
  ])
  assert.equal(model.requests.length, 1, 'the model is called exactly once')

  const bundle = savedBundle(repository)
  assert.equal(bundle.result.processingStatus, 'succeeded')
  assert.equal(bundle.result.eligibility, 'content_auditable')
  assert.equal(bundle.metricScores.length, CALL_AUDIT_RUBRIC.length)
  assert.equal(bundle.metricScores.length, 8)
  assert.deepEqual(
    bundle.metricScores.map(
      (record: CallAuditMetricScoreRecord) => record.metricCode,
    ),
    CALL_AUDIT_RUBRIC.map((metric) => metric.code),
  )

  const usage = savedUsage(repository)
  assert.equal(usage.attemptOutcome, 'succeeded')
  assert.equal(usage.attemptNumber, 1)
  assert.equal(usage.errorCode, null, 'a success carries no error code')
  assert.equal(usage.resultId, bundle.result.id)
  assert.equal(usage.runId, RUN_ID)
  assert.equal(usage.ruleVersionId, RULE_VERSION_ID)
  assert.equal(usage.providerName, 'openai')
  assert.equal(usage.totalTokens, '1540')
  assert.equal(usage.recordedAt, RECORDED_AT)

  assert.equal(summary.modelAttempted, true)
  assert.deepEqual(summary.usage, {
    attemptNumber: 1,
    attemptOutcome: 'succeeded',
    errorCode: null,
    persistOutcome: 'inserted',
  })
})

test('the model receives the raw transcript with only safe context', async () => {
  const repository = fakeRepository()
  const model = fakeModel(succeededResult())
  await processCallAuditCandidate(processInput({ repository, model }))

  const request = model.requests[0]
  assert.equal(request.transcript, TRANSCRIPT)
  // Duration comes from the privacy-safe reference; nothing else is sent.
  assert.deepEqual(request.context, { durationSeconds: 84 })
  assert.deepEqual(Object.keys(request).sort(), [
    'activation',
    'context',
    'transcript',
  ])

  const context = JSON.stringify(request.context)
  for (const forbidden of [LEAD_ID, TASK_ID, 'ZQXJ', '5510', 'Kairali']) {
    assert.equal(
      context.includes(forbidden),
      false,
      `the model context must not carry ${forbidden}`,
    )
  }
})

test('an implausible source duration is sent as unknown rather than as a number', async () => {
  const repository = fakeRepository()
  const model = fakeModel(succeededResult())
  await processCallAuditCandidate(
    processInput({
      // MySQL TIME allows up to 838:59:59, far beyond any real call.
      candidate: syntheticCandidate({ callDurationSec: '838:00:00' }),
      repository,
      model,
    }),
  )

  assert.deepEqual(model.requests[0].context, { durationSeconds: null })
})

// ---------------------------------------------------------------------------
// Refusal and failure paths
// ---------------------------------------------------------------------------

test('a refusal persists a failed result and a refused attempt with a safe code only', async () => {
  const repository = fakeRepository()
  const model = fakeModel(refusedResult())
  const summary = await processCallAuditCandidate(
    processInput({ repository, model }),
  )

  assert.deepEqual(kinds(repository), [
    'sourceRef',
    // The spend claim is taken BEFORE the model, and after the revision it is
    // keyed by has been persisted.
    'spendClaim',
    'resultBundle',
    'usageAttempt',
  ])

  const bundle = savedBundle(repository)
  assert.equal(bundle.result.processingStatus, 'failed')
  // The transcript existed, so the call stays content-auditable.
  assert.equal(bundle.result.eligibility, 'content_auditable')
  assert.equal(bundle.result.errorCode, CONTENT_AUDIT_ERROR_CODES.refused)
  assert.equal(bundle.result.errorDetail, null)
  assert.equal(bundle.result.auditedAt, null, 'no audit completed')
  assert.equal(bundle.result.resultJson, null)
  assert.equal(bundle.result.resultSha256, null)
  assert.deepEqual(bundle.metricScores, [])

  const usage = savedUsage(repository)
  assert.equal(usage.attemptOutcome, 'refused')
  assert.equal(usage.errorCode, CONTENT_AUDIT_ERROR_CODES.refused)
  assert.match(usage.errorCode as string, /^[A-Z][A-Z0-9_]*$/)

  assert.deepEqual(summary.usage, {
    attemptNumber: 1,
    attemptOutcome: 'refused',
    errorCode: 'MODEL_REFUSED',
    persistOutcome: 'inserted',
  })
})

test('an invalid model output persists a failed result and a failed attempt', async () => {
  const repository = fakeRepository()
  const model = fakeModel(failedResult('invalid_output'))
  const summary = await processCallAuditCandidate(
    processInput({ repository, model }),
  )

  const bundle = savedBundle(repository)
  assert.equal(bundle.result.processingStatus, 'failed')
  assert.equal(bundle.result.errorCode, CONTENT_AUDIT_ERROR_CODES.invalidOutput)
  assert.deepEqual(bundle.metricScores, [])

  const usage = savedUsage(repository)
  assert.equal(usage.attemptOutcome, 'failed')
  assert.equal(usage.errorCode, CONTENT_AUDIT_ERROR_CODES.invalidOutput)
  assert.equal(summary.result.processingStatus, 'failed')
})

test('a transport failure persists a failed result and a failed attempt', async () => {
  const repository = fakeRepository()
  const model = fakeModel(failedResult('transport'))
  const summary = await processCallAuditCandidate(
    processInput({ repository, model, attemptNumber: 3 }),
  )

  const bundle = savedBundle(repository)
  assert.equal(bundle.result.processingStatus, 'failed')
  assert.equal(bundle.result.errorCode, CONTENT_AUDIT_ERROR_CODES.requestFailed)

  const usage = savedUsage(repository)
  assert.equal(usage.attemptOutcome, 'failed')
  assert.equal(usage.attemptNumber, 3)
  assert.equal(usage.inputTokens, null, 'a transport failure reports no counts')
  assert.equal(
    usage.id,
    buildUsageEventId(
      {
        runId: RUN_ID,
        sourceRefId: DEFAULT_SOURCE_REF.id,
        ruleVersionId: RULE_VERSION_ID,
      },
      3,
    ),
  )
  assert.equal(summary.usage?.attemptNumber, 3)
})

test('a content model that throws is recorded as a failed attempt with activated identity and no measurements', async () => {
  const repository = fakeRepository()
  const model = throwingModel()
  const summary = await processCallAuditCandidate(
    processInput({ repository, model, attemptNumber: 2 }),
  )

  assert.equal(model.requests.length, 1, 'the model is still called exactly once')
  // A throw does not skip the records: the request may have reached the provider.
  assert.deepEqual(kinds(repository), [
    'sourceRef',
    // The spend claim is taken BEFORE the model, and after the revision it is
    // keyed by has been persisted.
    'spendClaim',
    'resultBundle',
    'usageAttempt',
  ])

  const bundle = savedBundle(repository)
  assert.equal(bundle.result.processingStatus, 'failed')
  assert.equal(bundle.result.eligibility, 'content_auditable')
  assert.equal(bundle.result.errorCode, CONTENT_AUDIT_ERROR_CODES.requestFailed)
  assert.equal(bundle.result.errorDetail, null)
  assert.equal(bundle.result.auditedAt, null, 'no audit completed')
  assert.equal(bundle.result.resultJson, null)
  assert.equal(bundle.result.resultSha256, null)
  assert.deepEqual(bundle.metricScores, [])

  const usage = savedUsage(repository)
  assert.equal(usage.attemptOutcome, 'failed')
  assert.equal(usage.attemptNumber, 2)
  assert.equal(usage.errorCode, CONTENT_AUDIT_ERROR_CODES.requestFailed)
  assert.equal(usage.resultId, bundle.result.id)
  assert.equal(usage.recordedAt, RECORDED_AT)
  // Identity comes from the ACTIVATED rule, not from a reply that never arrived.
  assert.equal(usage.providerName, 'openai')
  assert.equal(usage.modelName, 'gpt-synth-mini')
  assert.equal(usage.modelVersion, '2026-05-01')
  // A throw produced no safe usage facts; a zero would read as a measurement.
  assert.equal(usage.requestId, null)
  assert.equal(usage.inputTokens, null)
  assert.equal(usage.outputTokens, null)
  assert.equal(usage.totalTokens, null)
  assert.equal(usage.latencyMs, null)

  assert.equal(summary.modelAttempted, true)
  assert.equal(summary.result.processingStatus, 'failed')
  assert.deepEqual(summary.usage, {
    attemptNumber: 2,
    attemptOutcome: 'failed',
    errorCode: 'MODEL_REQUEST_FAILED',
    persistOutcome: 'inserted',
  })
})

test('nothing from a thrown model error reaches the summary or persistence', async () => {
  const repository = fakeRepository()
  const summary = await processCallAuditCandidate(
    processInput({ repository, model: throwingModel() }),
  )

  const written = JSON.stringify(repository.calls)
  const returned = JSON.stringify(summary)
  for (const json of [returned, written]) {
    for (const forbidden of [
      PROVIDER_PROSE,
      'upstream 502',
      FAKE_SECRET,
      'sk-synthetic',
      'Bearer',
      TRANSCRIPT,
      'Saanvi',
      'request body was',
      'Error',
      'stack',
    ]) {
      assert.equal(
        json.includes(forbidden),
        false,
        `the thrown error must not leak ${forbidden}`,
      )
    }
  }
})

test('a provider outcome is never thrown as an exception', async () => {
  for (const result of [
    refusedResult(),
    failedResult('invalid_output'),
    failedResult('transport'),
  ]) {
    const summary = await processCallAuditCandidate(
      processInput({ repository: fakeRepository(), model: fakeModel(result) }),
    )
    assert.equal(summary.result.processingStatus, 'failed')
  }
})

// ---------------------------------------------------------------------------
// Cross-run duplicate-spend protection
// ---------------------------------------------------------------------------

/** A repository whose spend claim refuses, for the stated bounded reason. */
function refusingRepository(
  skipCode: CallAuditSpendSkipCode,
  sourceRef: SourceReferencePersistResult = DEFAULT_SOURCE_REF,
): FakeRepository {
  return fakeRepository(sourceRef, { outcome: 'duplicate', skipCode })
}

test('a prior result for the exact source revision suppresses the model on a new run key', async () => {
  // The run id is different from whatever produced the earlier result. Nothing
  // about this run's identity is a repeat; the evidence is, and the evidence is
  // what the claim is keyed by.
  const repository = refusingRepository(CALL_AUDIT_SPEND_SKIP_CODES.priorResult)
  const model = fakeModel(succeededResult())
  const summary = await processCallAuditCandidate(
    processInput({ runId: 'run_synth_second_0002', repository, model }),
  )

  assert.equal(
    model.requests.length,
    0,
    'a revision another run already audited must not be sent to the model again',
  )
  assert.equal(summary.modelAttempted, false)
  assert.equal(summary.spendSkipCode, CALL_AUDIT_SPEND_SKIP_CODES.priorResult)
})

test('no usage attempt is written for a suppressed duplicate', async () => {
  const repository = refusingRepository(CALL_AUDIT_SPEND_SKIP_CODES.priorResult)
  const summary = await processCallAuditCandidate(
    processInput({ repository, model: fakeModel(succeededResult()) }),
  )

  // The usage-attempt record is the record of requests MADE. No request was
  // made, so a row there would be phantom tokens in reliability and spend
  // reporting.
  assert.equal(
    repository.calls.some((call) => call.kind === 'usageAttempt'),
    false,
  )
  assert.equal(summary.usage, null)
  assert.deepEqual(kinds(repository), [
    'sourceRef',
    'spendClaim',
    'resultBundle',
  ])
})

test('a suppressed duplicate is reported as skipped with a coded reason, never as an audit', async () => {
  const repository = refusingRepository(CALL_AUDIT_SPEND_SKIP_CODES.priorClaim)
  const summary = await processCallAuditCandidate(
    processInput({ repository, model: fakeModel(succeededResult()) }),
  )

  const bundle = savedBundle(repository)
  assert.equal(bundle.result.processingStatus, 'skipped')
  // The transcript was auditable. The claim, not the evidence, is what stopped
  // this run, and the row says so rather than pretending the call had none.
  assert.equal(bundle.result.eligibility, 'content_auditable')
  assert.equal(bundle.result.ineligibilityReason, null)
  assert.equal(bundle.result.errorCode, CALL_AUDIT_SPEND_SKIP_CODES.priorClaim)
  // No audit happened, so no audit time, no document, no hash, and no scores.
  assert.equal(bundle.result.auditedAt, null)
  assert.equal(bundle.result.resultJson, null)
  assert.equal(bundle.result.resultSha256, null)
  assert.equal(bundle.result.overallScore, null)
  assert.deepEqual(bundle.metricScores, [])

  assert.equal(summary.result.processingStatus, 'skipped')
  assert.equal(summary.spendSkipCode, CALL_AUDIT_SPEND_SKIP_CODES.priorClaim)
})

test('the claim is keyed by the persisted revision, and taken before the model', async () => {
  const persisted: SourceReferencePersistResult = {
    id: sourceRefId('revisionkeyed'),
    outcome: 'reused',
  }
  const repository = fakeRepository(persisted)
  await processCallAuditCandidate(processInput({ repository }))

  const claim = repository.calls.find((call) => call.kind === 'spendClaim')
  assert.ok(claim && claim.kind === 'spendClaim')
  assert.deepEqual(claim.input, {
    sourceRefId: persisted.id,
    runId: RUN_ID,
    ruleVersionId: RULE_VERSION_ID,
    claimedAt: RECORDED_AT,
  })
  // Only hash-derived ids and a stamp cross the port; nothing identifying.
  const json = JSON.stringify(claim.input)
  for (const forbidden of [TRANSCRIPT, LEAD_ID, TASK_ID, 'Saanvi', 'panchakarma']) {
    assert.equal(json.includes(forbidden), false)
  }
})

test('a changed source revision remains eligible for a first audit', async () => {
  // Same source row, later transcript. `buildSourceRevision` hashes the
  // transcript into the revision, so this is different immutable evidence with
  // a different revision hash — and therefore a different claim key, which no
  // run holds.
  const revisedTranscript = `${TRANSCRIPT}\nSaanvi: I will send the details today.`
  const first = buildSourceRevision(syntheticCandidate())
  const revised = buildSourceRevision(
    syntheticCandidate({ transcript: revisedTranscript }),
  )
  assert.equal(first.reference.sourceRowId, revised.reference.sourceRowId)
  assert.notEqual(
    first.reference.sourceRevisionSha256,
    revised.reference.sourceRevisionSha256,
    'a changed transcript must be a new revision',
  )
  assert.notEqual(
    first.reference.sourceRefIdempotencyKey,
    revised.reference.sourceRefIdempotencyKey,
  )

  const repository = fakeRepository({
    id: sourceRefId('changedrevision'),
    outcome: 'inserted',
  })
  const model = fakeModel(succeededResult())
  const summary = await processCallAuditCandidate(
    processInput({
      candidate: syntheticCandidate({ transcript: revisedTranscript }),
      repository,
      model,
    }),
  )

  assert.equal(model.requests.length, 1, 'new evidence is auditable')
  assert.equal(summary.spendSkipCode, null)
  assert.equal(summary.result.processingStatus, 'succeeded')
  assert.equal(savedBundle(repository).result.eligibility, 'content_auditable')
})

test('a first-time candidate continues through the existing model path unchanged', async () => {
  const repository = fakeRepository()
  const model = fakeModel(succeededResult())
  const summary = await processCallAuditCandidate(
    processInput({ repository, model }),
  )

  assert.equal(model.requests.length, 1)
  assert.equal(model.requests[0].transcript, TRANSCRIPT)
  assert.equal(summary.spendSkipCode, null)
  assert.equal(summary.modelAttempted, true)
  assert.equal(summary.result.processingStatus, 'succeeded')
  assert.equal(summary.usage?.attemptOutcome, 'succeeded')
  assert.deepEqual(kinds(repository), [
    'sourceRef',
    'spendClaim',
    'resultBundle',
    'usageAttempt',
  ])
})

test('an operational-only call never consumes a claim', async () => {
  // A call with no transcript cannot spend, so it takes no claim. The
  // transcript-bearing revision that arrives later is a different revision with
  // a claim of its own, so nothing it needs has been used up.
  const repository = fakeRepository()
  await processCallAuditCandidate(
    processInput({
      candidate: syntheticCandidate({ transcript: null }),
      repository,
    }),
  )
  assert.equal(
    repository.calls.some((call) => call.kind === 'spendClaim'),
    false,
  )
})

test('an unrecognised claim answer is refused, never read as permission', async () => {
  // Default deny is a property of the TEST, not of the answer: anything that is
  // not exactly `claimed` denies, so a port that grew a third outcome could not
  // be mistaken for consent.
  const repository = fakeRepository()
  repository.claimContentAuditSpend = async () =>
    ({ outcome: 'unknown_future_outcome' }) as unknown as CallAuditSpendClaimResult
  const model = fakeModel(succeededResult())
  const summary = await processCallAuditCandidate(
    processInput({ repository, model }),
  )

  assert.equal(model.requests.length, 0)
  assert.equal(summary.modelAttempted, false)
  assert.equal(summary.usage, null)
  assert.equal(summary.result.processingStatus, 'skipped')
  // Normalised to a code this contract defines, so no unknown token is stored.
  assert.equal(summary.spendSkipCode, CALL_AUDIT_SPEND_SKIP_CODES.priorClaim)
})

test('a repository without the claim gate is refused before any write', async () => {
  const repository = fakeRepository()
  delete (repository as Partial<FakeRepository>).claimContentAuditSpend
  const model = fakeModel(succeededResult())
  await assert.rejects(
    processCallAuditCandidate(processInput({ repository, model })),
    (error: unknown) =>
      error instanceof CallAuditProcessorError &&
      error.field === 'repository.claimContentAuditSpend',
  )
  assert.deepEqual(repository.calls, [])
  assert.equal(model.requests.length, 0)
})

// ---------------------------------------------------------------------------
// Identity and source-reference reuse
// ---------------------------------------------------------------------------

test('the result identity uses the persisted source reference id', async () => {
  const reused: SourceReferencePersistResult = {
    id: sourceRefId('synthreused'),
    outcome: 'reused',
  }
  const repository = fakeRepository(reused)
  const summary = await processCallAuditCandidate(
    processInput({ repository, model: fakeModel(succeededResult()) }),
  )

  const identity = {
    runId: RUN_ID,
    sourceRefId: reused.id,
    ruleVersionId: RULE_VERSION_ID,
  }
  const bundle = savedBundle(repository)
  assert.equal(bundle.result.sourceRefId, reused.id)
  assert.equal(bundle.result.id, buildResultId(identity))
  for (const record of bundle.metricScores) {
    assert.equal(record.resultId, buildResultId(identity))
  }
  assert.equal(savedUsage(repository).resultId, buildResultId(identity))

  assert.deepEqual(summary.sourceRef, {
    id: reused.id,
    persistOutcome: 'reused',
  })
})

test('the persisted source reference is the one buildSourceRevision produced', async () => {
  const candidate = syntheticCandidate()
  const repository = fakeRepository()
  await processCallAuditCandidate(
    processInput({ candidate, repository, model: fakeModel(succeededResult()) }),
  )

  const call = repository.calls[0]
  assert.equal(call.kind, 'sourceRef')
  const reference = (
    call as { kind: 'sourceRef'; reference: CallAuditSourceReference }
  ).reference
  assert.deepEqual(reference, buildSourceRevision(candidate).reference)
  assert.equal(reference.hasTranscript, true)
  assert.equal(
    Object.hasOwn(reference, 'transcript'),
    false,
    'the reference must never carry the transcript itself',
  )
})

// ---------------------------------------------------------------------------
// KServe outcome comparison
// ---------------------------------------------------------------------------

test('the KServe reported outcome comes from the safe source outcome field', async () => {
  const repository = fakeRepository()
  await processCallAuditCandidate(
    processInput({ repository, model: fakeModel(succeededResult()) }),
  )

  const result = savedBundle(repository).result
  assert.equal(result.kserveReportedOutcome, 'Individual Resort Booking')
  assert.equal(result.detailedOutcome, 'Individual Resort Booking')
  assert.equal(result.kserveComparisonLabel, 'match')
  assert.equal(result.mismatchSeverity, 'none')
})

test('a disagreeing KServe label is compared, never aliased or repaired', async () => {
  const repository = fakeRepository()
  await processCallAuditCandidate(
    processInput({
      candidate: syntheticCandidate({
        final_lead_outcome: 'Outreach Stopped',
      }),
      repository,
      model: fakeModel(succeededResult()),
    }),
  )

  const result = savedBundle(repository).result
  assert.equal(result.kserveReportedOutcome, 'Outreach Stopped')
  assert.equal(result.kserveComparisonLabel, 'mismatch')
  // A no-contact disagreement is a compliance risk, not a near miss.
  assert.equal(result.mismatchSeverity, 'high')
})

test('an unapproved KServe label is discarded rather than normalized', async () => {
  const repository = fakeRepository()
  await processCallAuditCandidate(
    processInput({
      // A near miss on an approved label is a DIFFERENT label.
      candidate: syntheticCandidate({
        final_lead_outcome: 'individual resort booking ',
      }),
      repository,
      model: fakeModel(succeededResult()),
    }),
  )

  const result = savedBundle(repository).result
  assert.equal(result.kserveReportedOutcome, null)
  assert.equal(result.kserveComparisonLabel, 'not_comparable')
  assert.equal(result.mismatchSeverity, 'none')
})

// ---------------------------------------------------------------------------
// Privacy
// ---------------------------------------------------------------------------

const FORBIDDEN_IN_OUTPUT = [
  TRANSCRIPT,
  'Saanvi',
  'panchakarma',
  LEAD_ID,
  TASK_ID,
  'Audit the Saanvi call',
  'refusal',
  'Caller asked about a resort stay',
  'Kairali',
  '5510',
]

test('the returned summary carries no transcript, prose, PII, or money', async () => {
  for (const model of [
    fakeModel(succeededResult()),
    fakeModel(refusedResult()),
    fakeModel(failedResult('transport')),
  ]) {
    const summary = await processCallAuditCandidate(
      processInput({ repository: fakeRepository(), model }),
    )
    const json = JSON.stringify(summary)
    for (const forbidden of FORBIDDEN_IN_OUTPUT) {
      assert.equal(
        json.includes(forbidden),
        false,
        `the summary must not contain ${forbidden}`,
      )
    }
    for (const forbidden of [
      /amount/i,
      /currency/i,
      /\brate\b/i,
      /invoice/i,
      /price/i,
      /\bcost\b/i,
      /₹/,
      /prompt/i,
      /transcript/i,
      /http/i,
      /@/,
    ]) {
      assert.equal(
        forbidden.test(json),
        false,
        `the summary must not match ${forbidden}`,
      )
    }
  }
})

test('the summary shape is exactly the small safe set', async () => {
  const summary = await processCallAuditCandidate(processInput())
  assert.deepEqual(Object.keys(summary).sort(), [
    'modelAttempted',
    'result',
    'sourceRef',
    'spendSkipCode',
    'usage',
  ])
  assert.deepEqual(Object.keys(summary.sourceRef).sort(), ['id', 'persistOutcome'])
  assert.deepEqual(Object.keys(summary.result).sort(), [
    'eligibility',
    'id',
    'persistOutcome',
    'processingStatus',
  ])
  assert.deepEqual(Object.keys(summary.usage ?? {}).sort(), [
    'attemptNumber',
    'attemptOutcome',
    'errorCode',
    'persistOutcome',
  ])
})

test('nothing written to persistence carries the transcript or the raw lead id', async () => {
  for (const model of [
    fakeModel(succeededResult()),
    fakeModel(refusedResult()),
    fakeModel(failedResult('invalid_output')),
  ]) {
    const repository = fakeRepository()
    await processCallAuditCandidate(processInput({ repository, model }))
    const json = JSON.stringify(repository.calls)
    // Approved categorical columns (company, service_category, …) DO reach the
    // source reference; the transcript, the raw lead ID, and prompt text never do.
    for (const forbidden of [TRANSCRIPT, LEAD_ID, 'Saanvi', 'Audit the Saanvi']) {
      assert.equal(
        json.includes(forbidden),
        false,
        `no persisted record may contain ${forbidden}`,
      )
    }
    // The privacy-safe reference does carry the extracted Task ID, which is an
    // approved column; the raw lead ID it came from never appears.
    assert.equal(
      (repository.calls[0] as { reference: CallAuditSourceReference }).reference
        .taskId,
      TASK_ID,
    )
  }
})

// ---------------------------------------------------------------------------
// Caller-side validation
// ---------------------------------------------------------------------------

test('invalid input throws a typed error before anything is written', async () => {
  const cases: Array<[Partial<ProcessCallAuditCandidateInput>, string]> = [
    [{ runId: '  ' }, 'runId'],
    [{ ruleVersionId: '' }, 'ruleVersionId'],
    [{ attemptNumber: 0 }, 'attemptNumber'],
    [{ attemptNumber: 1.5 }, 'attemptNumber'],
    [{ auditedAt: '' }, 'auditedAt'],
    [{ recordedAt: '' }, 'recordedAt'],
    [{ activation: null as unknown as ActivatedContentAuditModel }, 'activation'],
    [{ candidate: null as unknown as InternalSourceCandidate }, 'candidate'],
    [
      { repository: {} as unknown as CallAuditPersistenceRepository },
      'repository.upsertSourceReference',
    ],
    [{ model: {} as unknown as ContentAuditModelAdapter }, 'model.auditTranscript'],
  ]

  for (const [overrides, field] of cases) {
    const repository = fakeRepository()
    const model = fakeModel(succeededResult())
    await assert.rejects(
      processCallAuditCandidate(
        processInput({ repository, model, ...overrides }),
      ),
      (error: unknown) => {
        assert.ok(error instanceof CallAuditProcessorError)
        const typed = error as CallAuditProcessorError
        assert.equal(typed.field, field)
        assert.equal(typed.code, 'INVALID_CALL_AUDIT_PROCESSOR_INPUT')
        return true
      },
    )
    // An input mistake must not have reached a collaborator.
    if (!('repository' in overrides)) {
      assert.deepEqual(repository.calls, [])
    }
    assert.equal(model.requests.length, 0)
  }
})

test('a thrown model error never escapes the processor', async () => {
  await assert.doesNotReject(
    processCallAuditCandidate(
      processInput({ repository: fakeRepository(), model: throwingModel() }),
    ),
  )
})

test('an invalid supplied timestamp is rejected before any write', async () => {
  const cases: Array<[Partial<ProcessCallAuditCandidateInput>, string]> = [
    // Impossible dates. 2026 is not a leap year, and April has 30 days.
    [{ auditedAt: '2026-02-29 10:00:00' }, 'auditedAt'],
    [{ recordedAt: '2026-04-31 10:00:00' }, 'recordedAt'],
    // Out-of-range time components.
    [{ auditedAt: '2026-08-01 24:00:00' }, 'auditedAt'],
    [{ recordedAt: '2026-08-01 10:60:00' }, 'recordedAt'],
    [{ auditedAt: '2026-08-01 10:00:60' }, 'auditedAt'],
    // Non-canonical shapes: unpadded parts, a zone suffix, an offset, more
    // fractional digits than datetime(6) holds, and a millisecond epoch.
    [{ auditedAt: '2026-8-1 10:00:00' }, 'auditedAt'],
    [{ recordedAt: '2026-08-01T10:00:00Z' }, 'recordedAt'],
    [{ auditedAt: '2026-08-01 10:00:00+05:30' }, 'auditedAt'],
    [{ recordedAt: '2026-08-01 10:00:00.1234567' }, 'recordedAt'],
    [{ auditedAt: '1785535200000' }, 'auditedAt'],
    [{ recordedAt: 'now' }, 'recordedAt'],
  ]

  for (const [overrides, field] of cases) {
    const repository = fakeRepository()
    const model = fakeModel(succeededResult())
    await assert.rejects(
      processCallAuditCandidate(
        processInput({ repository, model, ...overrides }),
      ),
      (error: unknown) => {
        assert.ok(
          error instanceof CallAuditProcessorError,
          `expected a typed processor error for ${JSON.stringify(overrides)}`,
        )
        const typed = error as CallAuditProcessorError
        assert.equal(typed.field, field)
        assert.equal(typed.code, 'INVALID_CALL_AUDIT_PROCESSOR_INPUT')
        // The reason names the rule; the rejected value is never echoed.
        assert.equal(
          typed.message.includes(String(Object.values(overrides)[0])),
          false,
        )
        return true
      },
    )
    // The check runs before upsertSourceReference, so no row was written and no
    // paid model call was made.
    assert.deepEqual(repository.calls, [])
    assert.equal(model.requests.length, 0)
  }
})

test('an unusable source row is rejected without any write', async () => {
  const repository = fakeRepository()
  const model = fakeModel(succeededResult())
  await assert.rejects(
    processCallAuditCandidate(
      processInput({
        candidate: syntheticCandidate({ effectiveCallTime: '   ' }),
        repository,
        model,
      }),
    ),
    /Effective call time is required/,
  )
  assert.deepEqual(repository.calls, [])
  assert.equal(model.requests.length, 0)
})

// ---------------------------------------------------------------------------
// Module boundaries
// ---------------------------------------------------------------------------

const MODULE_SOURCE = readFileSync(
  new URL('./processor.ts', import.meta.url),
  'utf8',
)

function importSpecifiers(source: string): string[] {
  return [...source.matchAll(/from\s+'([^']+)'/g)].map((match) => match[1])
}

test('the module imports nothing outside the Call Audit core and its injected ports', () => {
  const specifiers = importSpecifiers(MODULE_SOURCE)
  assert.ok(specifiers.length > 0, 'expected the module to declare imports')
  for (const specifier of specifiers) {
    for (const forbidden of [
      /^mysql2/,
      /^openai$/,
      /^node:/,
      /billing/i,
      /reaudit/i,
      /\/http\//,
      /\/ui\//,
      /kcrm/i,
      /scheduler/i,
      /express/,
      /server/i,
    ]) {
      assert.equal(
        forbidden.test(specifier),
        false,
        `${specifier} must not be imported here`,
      )
    }
  }
  // The persistence contract is a TYPE-ONLY port: no database module is loaded
  // at runtime by this file.
  assert.match(
    MODULE_SOURCE,
    /import type \{\n  CallAuditPersistenceRepository,?\n\} from|import type \{ CallAuditPersistenceRepository \} from/,
  )
})

test('the module contains no SQL and never names the external source table', () => {
  for (const forbidden of [
    /INSERT\s+INTO/i,
    /\bSELECT\s/i,
    /\bUPDATE\s+`/i,
    /DELETE\s+FROM/i,
    /\bWHERE\b/i,
    /\bJOIN\b/i,
    /FOR\s+UPDATE/i,
    /`kaudit_/,
    /ai_voice_leads_received/,
    /\.execute\(/,
    /pool\./,
    /getConnection/,
    /beginTransaction/,
  ]) {
    assert.equal(
      forbidden.test(MODULE_SOURCE),
      false,
      `processor.ts must not contain ${forbidden}`,
    )
  }
})

test('the module never logs, reads a clock, or reaches the environment', () => {
  for (const forbidden of [
    /console\./,
    /process\.env/,
    /process\.(argv|exit|stdout|stderr)/,
    /Date\.now/,
    /new Date\(/,
    /randomUUID/,
    /Math\.random/,
    /require\(/,
    /fetch\(/,
    /createHash/,
    /sha256/i,
  ]) {
    assert.equal(
      forbidden.test(MODULE_SOURCE),
      false,
      `processor.ts must not use ${forbidden}`,
    )
  }
})
