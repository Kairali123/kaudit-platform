import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  CALL_AUDIT_RUN_ERROR_CODES,
  CallAuditBatchRunError,
  MAX_RUN_PAGES,
  runCallAuditBatch,
  type CallAuditRunControlPort,
  type CallAuditSourceReaderPort,
  type RunCallAuditBatchInput,
} from './batchRunner.ts'
import type { CallAuditProcessingSummary } from './processor.ts'
import {
  CALL_AUDIT_SOURCE_TABLE,
  type InternalSourceCandidate,
} from './sourceTypes.ts'
import type { SourceCandidateCursor } from './sourceQuery.ts'
import type {
  CallAuditRunCounters,
  CallAuditRunRequest,
} from '../adapters/mysqlCallAuditControl.ts'
import type { ActivatedContentAuditModel } from '../adapters/openaiCallAuditModel.ts'

/**
 * Every fixture below is SYNTHETIC. No real transcript, lead, customer, or
 * recording appears in this file, and no test reaches a database, a network, a
 * clock, or a model provider: every collaborator is a fake.
 */

const RUN_ID = 'crn_synth_run_0001'
const RULE_VERSION_ID = 'crv_synth_0001'
const IDEMPOTENCY_KEY = 'synthetic-run-key-0001'

const STARTED_AT = '2026-08-01 10:00:00.000000'
const AUDITED_AT = '2026-08-01 10:00:01.000000'
const RECORDED_AT = '2026-08-01 10:00:02.000000'
const FINISHED_AT = '2026-08-01 10:05:00.000000'

/** SENSITIVE-looking synthetic values, asserted absent from every summary. */
const TRANSCRIPT =
  'Saanvi: good morning, this is Saanvi from Kairali.\n' +
  'Caller: I would like to know about the panchakarma package.'
const LEAD_ID = 'LEAD-SYNTH-ZQXJ0918'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function syntheticCandidate(
  sourceRowId: string,
  effectiveCallTime: string,
): InternalSourceCandidate {
  return {
    sourceTable: CALL_AUDIT_SOURCE_TABLE,
    sourceRowId,
    leadId: `${LEAD_ID}-${sourceRowId}`,
    transcript: TRANSCRIPT,
    effectiveCallTime,
    sourceUpdatedAt: null,
    callStartedAt: effectiveCallTime,
    callEndedAt: null,
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
    final_lead_outcome: 'Individual Resort Booking',
    calculated_qualification_status: 'qualified',
    followup_required: 'yes',
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

function syntheticRunRequest(): CallAuditRunRequest {
  return {
    ruleVersionId: RULE_VERSION_ID,
    runType: 'daily',
    periodStart: '2026-07-31 00:00:00',
    periodEndExclusive: '2026-08-01 00:00:00',
    periodTimezone: 'Asia/Kolkata',
    idempotencyKey: IDEMPOTENCY_KEY,
  }
}

const SOURCE_WINDOW = {
  periodStart: '2026-07-30 18:30:00',
  periodEndExclusive: '2026-07-31 18:30:00',
}

/**
 * A processor summary shaped exactly like a real one, built from the outcome
 * the test wants to count. Nothing is persisted: the processor is a fake here.
 */
function summaryOf(
  marker: string,
  processingStatus: CallAuditProcessingSummary['result']['processingStatus'],
  eligibility: CallAuditProcessingSummary['result']['eligibility'],
): CallAuditProcessingSummary {
  const contentAttempt = eligibility === 'content_auditable'
  return {
    sourceRef: { id: `cas_${marker}`, persistOutcome: 'inserted' },
    result: {
      id: `car_${marker}`,
      processingStatus,
      eligibility,
      persistOutcome: 'inserted',
    },
    modelAttempted: contentAttempt,
    usage: contentAttempt
      ? {
          attemptNumber: 1,
          attemptOutcome: processingStatus === 'succeeded' ? 'succeeded' : 'failed',
          errorCode:
            processingStatus === 'succeeded' ? null : 'CONTENT_AUDIT_REFUSED',
          persistOutcome: 'inserted',
        }
      : null,
  }
}

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

type ControlCall =
  | { kind: 'createRun'; request: CallAuditRunRequest }
  | { kind: 'running'; startedAt: string }
  | { kind: 'counters'; counters: CallAuditRunCounters }
  | { kind: 'completed'; finishedAt: string; counters: CallAuditRunCounters }
  | {
      kind: 'failed'
      finishedAt: string
      errorCode: string
      counters: CallAuditRunCounters | undefined
    }

interface FakeControl extends CallAuditRunControlPort {
  calls: ControlCall[]
}

interface FakeControlOptions {
  createOutcome?: 'inserted' | 'replayed'
  failOn?: 'createRun' | 'markRunRunning' | 'updateRunCounters' | 'markRunCompleted'
  failMarkRunFailed?: boolean
}

function fakeControl(options: FakeControlOptions = {}): FakeControl {
  const calls: ControlCall[] = []
  /** Carries prose no summary may ever repeat. */
  const boom = () => {
    throw new Error(
      `control failure detail: ${TRANSCRIPT} for lead ${LEAD_ID} in ai_voice_leads_received`,
    )
  }
  return {
    calls,
    async createRun(request) {
      calls.push({ kind: 'createRun', request })
      if (options.failOn === 'createRun') boom()
      return { id: RUN_ID, outcome: options.createOutcome ?? 'inserted' }
    },
    async markRunRunning(input) {
      calls.push({ kind: 'running', startedAt: input.startedAt })
      if (options.failOn === 'markRunRunning') boom()
      return { id: input.runId, status: 'running', outcome: 'updated' }
    },
    async updateRunCounters(runId, counters) {
      calls.push({ kind: 'counters', counters })
      if (options.failOn === 'updateRunCounters') boom()
      return { id: runId, status: 'running', outcome: 'updated' }
    },
    async markRunCompleted(input) {
      calls.push({
        kind: 'completed',
        finishedAt: input.finishedAt,
        counters: input.counters,
      })
      if (options.failOn === 'markRunCompleted') boom()
      return { id: input.runId, status: 'completed', outcome: 'updated' }
    },
    async markRunFailed(input) {
      calls.push({
        kind: 'failed',
        finishedAt: input.finishedAt,
        errorCode: input.errorCode,
        counters: input.counters,
      })
      if (options.failMarkRunFailed) boom()
      return { id: input.runId, status: 'failed', outcome: 'updated' }
    },
  }
}

interface RecordedQuery {
  periodStart: string
  periodEndExclusive: string
  batchSize: number
  cursor: SourceCandidateCursor | null
}

interface FakeSource extends CallAuditSourceReaderPort {
  queries: RecordedQuery[]
}

function fakeSource(
  pages: InternalSourceCandidate[][],
  options: { throwOnPage?: number } = {},
): FakeSource {
  const queries: RecordedQuery[] = []
  return {
    queries,
    async listCandidates(query) {
      const index = queries.length
      queries.push({
        periodStart: query.periodStart,
        periodEndExclusive: query.periodEndExclusive,
        batchSize: query.batchSize,
        cursor: query.cursor ?? null,
      })
      if (options.throwOnPage === index) {
        throw new Error(
          `source read failed for ${LEAD_ID}: ai_voice_leads_received scan`,
        )
      }
      return pages[index] ?? []
    },
  }
}

function baseInput(
  overrides: Partial<RunCallAuditBatchInput> = {},
): RunCallAuditBatchInput {
  return {
    request: syntheticRunRequest(),
    ruleVersionId: RULE_VERSION_ID,
    activation: syntheticActivation(),
    sourceWindow: SOURCE_WINDOW,
    batchSize: 2,
    control: fakeControl(),
    source: fakeSource([[]]),
    processCandidate: async () =>
      summaryOf('default', 'succeeded', 'content_auditable'),
    timestamps: {
      startedAt: STARTED_AT,
      auditedAt: AUDITED_AT,
      recordedAt: RECORDED_AT,
      finishedAt: FINISHED_AT,
    },
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

test('one full page is created, claimed, processed, counted, and completed', async () => {
  const control = fakeControl()
  const page = [
    syntheticCandidate('101', '2026-07-30 19:00:00.000000'),
    syntheticCandidate('102', '2026-07-30 19:05:00.000000'),
  ]
  // A short second page ends the run without another read after it.
  const source = fakeSource([page, []])
  const processed: string[] = []

  const summary = await runCallAuditBatch(
    baseInput({
      control,
      source,
      batchSize: 2,
      processCandidate: async (input) => {
        processed.push(input.candidate.sourceRowId)
        assert.equal(input.runId, RUN_ID)
        assert.equal(input.ruleVersionId, RULE_VERSION_ID)
        assert.equal(input.attemptNumber, 1)
        assert.equal(input.auditedAt, AUDITED_AT)
        assert.equal(input.recordedAt, RECORDED_AT)
        return summaryOf(
          input.candidate.sourceRowId,
          'succeeded',
          'content_auditable',
        )
      },
    }),
  )

  // Sequential, in source order.
  assert.deepEqual(processed, ['101', '102'])
  assert.deepEqual(summary, {
    runId: RUN_ID,
    runCreateOutcome: 'inserted',
    terminalStatus: 'completed',
    failureCode: null,
    stopReason: 'exhausted',
    pagesRead: 2,
    candidatesSelected: 2,
    candidatesProcessed: 2,
    counts: {
      processedTotal: 2,
      succeededTotal: 2,
      failedTotal: 0,
      skippedTotal: 0,
      operationalOnlyTotal: 0,
      contentAuditedTotal: 2,
    },
  })

  assert.deepEqual(
    control.calls.map((call) => call.kind),
    ['createRun', 'running', 'counters', 'completed'],
  )
  const claim = control.calls[1]
  assert.equal(claim.kind === 'running' && claim.startedAt, STARTED_AT)
  const finished = control.calls[3]
  assert.ok(finished.kind === 'completed')
  assert.equal(finished.finishedAt, FINISHED_AT)
  // Absolute counters, projected onto all seven control columns.
  assert.deepEqual(finished.counters, {
    totalCandidates: 2,
    processedCount: 2,
    succeededCount: 2,
    failedCount: 0,
    skippedCount: 0,
    contentAuditableCount: 2,
    operationalOnlyCount: 0,
  })
})

test('the run request reaches createRun unchanged', async () => {
  const control = fakeControl()
  await runCallAuditBatch(baseInput({ control }))
  const created = control.calls[0]
  assert.ok(created.kind === 'createRun')
  assert.deepEqual(created.request, syntheticRunRequest())
})

// ---------------------------------------------------------------------------
// Paging
// ---------------------------------------------------------------------------

test('pages advance by the cursor of the last candidate, never by a position', async () => {
  const pageOne = [
    syntheticCandidate('101', '2026-07-30 19:00:00.000000'),
    syntheticCandidate('102', '2026-07-30 19:05:00.000000'),
  ]
  const pageTwo = [
    syntheticCandidate('103', '2026-07-30 19:10:00.000000'),
    syntheticCandidate('104', '2026-07-30 19:15:00.000000'),
  ]
  const pageThree = [syntheticCandidate('105', '2026-07-30 19:20:00.000000')]
  const source = fakeSource([pageOne, pageTwo, pageThree])
  const control = fakeControl()

  const summary = await runCallAuditBatch(
    baseInput({ control, source, batchSize: 2 }),
  )

  assert.equal(summary.pagesRead, 3)
  assert.equal(summary.candidatesSelected, 5)
  assert.equal(summary.candidatesProcessed, 5)
  assert.equal(summary.stopReason, 'exhausted')

  // The first read has no cursor; each later read resumes from the last row of
  // the page before it. No offset, limit-skip, or page number is ever passed.
  assert.deepEqual(
    source.queries.map((query) => query.cursor),
    [
      null,
      { effectiveCallTime: '2026-07-30 19:05:00.000000', sourceRowId: '102' },
      { effectiveCallTime: '2026-07-30 19:15:00.000000', sourceRowId: '104' },
    ],
  )
  for (const query of source.queries) {
    assert.equal(query.batchSize, 2)
    assert.equal(query.periodStart, '2026-07-30 18:30:00.000000')
    assert.equal(query.periodEndExclusive, '2026-07-31 18:30:00.000000')
    assert.equal('offset' in query, false)
  }

  // Counters are recorded after each page, always as absolute totals.
  const counterCalls = control.calls.filter((call) => call.kind === 'counters')
  assert.deepEqual(
    counterCalls.map((call) =>
      call.kind === 'counters' ? call.counters.processedCount : -1,
    ),
    [2, 4, 5],
  )
})

test('a short page ends the run without a further read', async () => {
  const source = fakeSource([
    [syntheticCandidate('101', '2026-07-30 19:00:00.000000')],
  ])
  const summary = await runCallAuditBatch(baseInput({ source, batchSize: 5 }))
  assert.equal(source.queries.length, 1)
  assert.equal(summary.pagesRead, 1)
  assert.equal(summary.stopReason, 'exhausted')
})

test('maxPages bounds the loop and is reported as the stop reason', async () => {
  const pages = [
    [
      syntheticCandidate('101', '2026-07-30 19:00:00.000000'),
      syntheticCandidate('102', '2026-07-30 19:05:00.000000'),
    ],
    [
      syntheticCandidate('103', '2026-07-30 19:10:00.000000'),
      syntheticCandidate('104', '2026-07-30 19:15:00.000000'),
    ],
    [
      syntheticCandidate('105', '2026-07-30 19:20:00.000000'),
      syntheticCandidate('106', '2026-07-30 19:25:00.000000'),
    ],
  ]
  const source = fakeSource(pages)
  const summary = await runCallAuditBatch(
    baseInput({ source, batchSize: 2, maxPages: 2 }),
  )
  assert.equal(source.queries.length, 2)
  assert.equal(summary.pagesRead, 2)
  assert.equal(summary.candidatesProcessed, 4)
  assert.equal(summary.stopReason, 'page_limit')
  assert.equal(summary.terminalStatus, 'completed')
})

test('maxCandidates stops mid-page and still completes with absolute counters', async () => {
  const source = fakeSource([
    [
      syntheticCandidate('101', '2026-07-30 19:00:00.000000'),
      syntheticCandidate('102', '2026-07-30 19:05:00.000000'),
      syntheticCandidate('103', '2026-07-30 19:10:00.000000'),
    ],
  ])
  const control = fakeControl()
  const summary = await runCallAuditBatch(
    baseInput({ control, source, batchSize: 3, maxCandidates: 2 }),
  )
  assert.equal(summary.stopReason, 'candidate_limit')
  assert.equal(summary.candidatesProcessed, 2)
  // Every row of the page was selected even though two were processed.
  assert.equal(summary.candidatesSelected, 3)
  assert.equal(source.queries.length, 1)
  const finished = control.calls.at(-1)
  assert.ok(finished?.kind === 'completed')
  assert.equal(finished.counters.totalCandidates, 3)
  assert.equal(finished.counters.processedCount, 2)
})

test('an empty first page completes with zero counters and no counter write', async () => {
  const control = fakeControl()
  const source = fakeSource([[]])
  const summary = await runCallAuditBatch(baseInput({ control, source }))

  assert.equal(summary.terminalStatus, 'completed')
  assert.equal(summary.pagesRead, 1)
  assert.equal(summary.candidatesSelected, 0)
  assert.equal(summary.candidatesProcessed, 0)
  assert.deepEqual(summary.counts, {
    processedTotal: 0,
    succeededTotal: 0,
    failedTotal: 0,
    skippedTotal: 0,
    operationalOnlyTotal: 0,
    contentAuditedTotal: 0,
  })
  assert.deepEqual(
    control.calls.map((call) => call.kind),
    ['createRun', 'running', 'completed'],
  )
  const finished = control.calls[2]
  assert.ok(finished.kind === 'completed')
  assert.deepEqual(finished.counters, {
    totalCandidates: 0,
    processedCount: 0,
    succeededCount: 0,
    failedCount: 0,
    skippedCount: 0,
    contentAuditableCount: 0,
    operationalOnlyCount: 0,
  })
})

// ---------------------------------------------------------------------------
// Counting
// ---------------------------------------------------------------------------

test('operational-only, audited, failed, and skipped outcomes are counted apart', async () => {
  const page = [
    syntheticCandidate('101', '2026-07-30 19:00:00.000000'),
    syntheticCandidate('102', '2026-07-30 19:05:00.000000'),
    syntheticCandidate('103', '2026-07-30 19:10:00.000000'),
    syntheticCandidate('104', '2026-07-30 19:15:00.000000'),
    syntheticCandidate('105', '2026-07-30 19:20:00.000000'),
  ]
  const outcomes: Record<string, CallAuditProcessingSummary> = {
    // Audited content.
    '101': summaryOf('101', 'succeeded', 'content_auditable'),
    // No transcript: no model spend, no content audit.
    '102': summaryOf('102', 'succeeded', 'operational_only'),
    // Refused by the model: failed, and NOT an audit.
    '103': summaryOf('103', 'failed', 'content_auditable'),
    // Transport failure recorded by the processor: same treatment.
    '104': summaryOf('104', 'failed', 'content_auditable'),
    '105': summaryOf('105', 'skipped', 'operational_only'),
  }
  const control = fakeControl()
  const summary = await runCallAuditBatch(
    baseInput({
      control,
      source: fakeSource([page]),
      batchSize: 10,
      processCandidate: async (input) => outcomes[input.candidate.sourceRowId],
    }),
  )

  assert.deepEqual(summary.counts, {
    processedTotal: 5,
    succeededTotal: 2,
    failedTotal: 2,
    skippedTotal: 1,
    operationalOnlyTotal: 2,
    // Only the one content-auditable candidate that actually produced an audit.
    contentAuditedTotal: 1,
  })
  const finished = control.calls.at(-1)
  assert.ok(finished?.kind === 'completed')
  assert.deepEqual(finished.counters, {
    totalCandidates: 5,
    processedCount: 5,
    succeededCount: 2,
    failedCount: 2,
    skippedCount: 1,
    contentAuditableCount: 1,
    operationalOnlyCount: 2,
  })
})

// ---------------------------------------------------------------------------
// Replay
// ---------------------------------------------------------------------------

test('a replayed createRun still proceeds under the returned run id', async () => {
  const control = fakeControl({ createOutcome: 'replayed' })
  const seenRunIds: string[] = []
  const summary = await runCallAuditBatch(
    baseInput({
      control,
      source: fakeSource([
        [syntheticCandidate('101', '2026-07-30 19:00:00.000000')],
      ]),
      batchSize: 5,
      processCandidate: async (input) => {
        seenRunIds.push(input.runId)
        return summaryOf('101', 'succeeded', 'content_auditable')
      },
    }),
  )
  assert.equal(summary.runCreateOutcome, 'replayed')
  assert.equal(summary.runId, RUN_ID)
  assert.equal(summary.terminalStatus, 'completed')
  assert.deepEqual(seenRunIds, [RUN_ID])
})

// ---------------------------------------------------------------------------
// Timestamps
// ---------------------------------------------------------------------------

test('an injected supplier is the only clock, consulted per moment', async () => {
  const stamps = [
    // Consumed by the up-front probe that proves the supplier answers at all.
    '2026-08-01 09:59:59.000000',
    '2026-08-01 10:00:00.000000',
    '2026-08-01 10:00:01.000000',
    '2026-08-01 10:00:02.000000',
    '2026-08-01 10:00:03.000000',
    '2026-08-01 10:00:04.000000',
  ]
  let index = 0
  const control = fakeControl()
  await runCallAuditBatch(
    baseInput({
      control,
      source: fakeSource([
        [syntheticCandidate('101', '2026-07-30 19:00:00.000000')],
      ]),
      batchSize: 5,
      timestamps: { now: () => stamps[index++] ?? stamps.at(-1)! },
    }),
  )
  const claim = control.calls[1]
  assert.ok(claim.kind === 'running')
  assert.equal(claim.startedAt, stamps[1])
  assert.ok(index > 2, 'the supplier must be consulted at each moment')
})

test('a supplier returning an impossible date is refused, not stored', async () => {
  await assert.rejects(
    runCallAuditBatch(
      baseInput({ timestamps: { now: () => '2026-02-30 10:00:00' } }),
    ),
    (error: unknown) =>
      error instanceof CallAuditBatchRunError &&
      error.code === CALL_AUDIT_RUN_ERROR_CODES.invalidInput,
  )
})

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

test('a run whose rule version disagrees with its request is refused', async () => {
  await assert.rejects(
    runCallAuditBatch(baseInput({ ruleVersionId: 'crv_synth_other' })),
    (error: unknown) =>
      error instanceof CallAuditBatchRunError &&
      error.code === CALL_AUDIT_RUN_ERROR_CODES.invalidInput &&
      error.field === 'ruleVersionId',
  )
})

test('an invalid source window is refused before the run is created', async () => {
  const control = fakeControl()
  await assert.rejects(
    runCallAuditBatch(
      baseInput({
        control,
        sourceWindow: {
          periodStart: '2026-07-31 18:30:00',
          periodEndExclusive: '2026-07-30 18:30:00',
        },
      }),
    ),
    (error: unknown) =>
      error instanceof CallAuditBatchRunError &&
      error.field === 'sourceWindow',
  )
  assert.deepEqual(control.calls, [])
})

test('omitting the processor requires its two dependencies', async () => {
  const input = baseInput()
  delete input.processCandidate
  await assert.rejects(
    runCallAuditBatch(input),
    (error: unknown) =>
      error instanceof CallAuditBatchRunError &&
      error.code === CALL_AUDIT_RUN_ERROR_CODES.invalidInput &&
      error.field === 'persistence',
  )
})

test('the page ceiling is capped at MAX_RUN_PAGES', async () => {
  const source = fakeSource([[]])
  const summary = await runCallAuditBatch(
    baseInput({ source, maxPages: MAX_RUN_PAGES * 10 }),
  )
  assert.equal(summary.terminalStatus, 'completed')
  assert.equal(source.queries.length, 1)
})

// ---------------------------------------------------------------------------
// Failure
// ---------------------------------------------------------------------------

/** Everything a summary or error must never repeat. */
const FORBIDDEN_IN_OUTPUT = [
  TRANSCRIPT,
  LEAD_ID,
  'Saanvi',
  'panchakarma',
  'ai_voice_leads_received',
  'control failure detail',
  'source read failed',
]

function assertSafe(value: unknown, label: string): void {
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  for (const forbidden of FORBIDDEN_IN_OUTPUT) {
    assert.equal(
      text.includes(forbidden),
      false,
      `${label} must not contain ${forbidden}`,
    )
  }
}

test('a processor throw marks the run failed with a safe code and leaks no prose', async () => {
  const control = fakeControl()
  const page = [
    syntheticCandidate('101', '2026-07-30 19:00:00.000000'),
    syntheticCandidate('102', '2026-07-30 19:05:00.000000'),
  ]
  const summary = await runCallAuditBatch(
    baseInput({
      control,
      source: fakeSource([page]),
      batchSize: 5,
      processCandidate: async (input) => {
        if (input.candidate.sourceRowId === '102') {
          throw new Error(
            `infrastructure failure while auditing ${LEAD_ID}: ${TRANSCRIPT}`,
          )
        }
        return summaryOf('101', 'succeeded', 'content_auditable')
      },
    }),
  )

  assert.equal(summary.terminalStatus, 'failed')
  assert.equal(
    summary.failureCode,
    CALL_AUDIT_RUN_ERROR_CODES.candidateFailed,
  )
  assert.equal(summary.stopReason, 'failed')
  // The candidate that threw is not counted: nothing is knowable about it.
  assert.equal(summary.candidatesProcessed, 1)
  assert.equal(summary.candidatesSelected, 2)
  assertSafe(summary, 'the failure summary')

  const failed = control.calls.at(-1)
  assert.ok(failed?.kind === 'failed')
  assert.equal(failed.errorCode, CALL_AUDIT_RUN_ERROR_CODES.candidateFailed)
  assert.match(failed.errorCode, /^[A-Z][A-Z0-9_]*$/)
  assert.equal(failed.finishedAt, FINISHED_AT)
  // Progress made before the throw is still recorded.
  assert.equal(failed.counters?.processedCount, 1)
  assert.equal(failed.counters?.totalCandidates, 2)
})

test('a source read failure is coded by phase, not by the thrown value', async () => {
  const control = fakeControl()
  const summary = await runCallAuditBatch(
    baseInput({ control, source: fakeSource([[]], { throwOnPage: 0 }) }),
  )
  assert.equal(summary.terminalStatus, 'failed')
  assert.equal(
    summary.failureCode,
    CALL_AUDIT_RUN_ERROR_CODES.sourceReadFailed,
  )
  assert.equal(summary.pagesRead, 0)
  assertSafe(summary, 'the failure summary')
})

test('a failed claim, counter write, or completion each map to their own code', async () => {
  for (const [failOn, expected] of [
    ['markRunRunning', CALL_AUDIT_RUN_ERROR_CODES.claimFailed],
    ['updateRunCounters', CALL_AUDIT_RUN_ERROR_CODES.progressFailed],
    ['markRunCompleted', CALL_AUDIT_RUN_ERROR_CODES.completionFailed],
  ] as const) {
    const control = fakeControl({ failOn })
    const summary = await runCallAuditBatch(
      baseInput({
        control,
        source: fakeSource([
          [syntheticCandidate('101', '2026-07-30 19:00:00.000000')],
        ]),
        batchSize: 5,
      }),
    )
    assert.equal(summary.terminalStatus, 'failed')
    assert.equal(summary.failureCode, expected, `${failOn} should code as ${expected}`)
    assertSafe(summary, `the ${failOn} failure summary`)
  }
})

test('a createRun failure is raised, because no run exists to record it', async () => {
  const control = fakeControl({ failOn: 'createRun' })
  await assert.rejects(
    runCallAuditBatch(baseInput({ control })),
    (error: unknown) => {
      assert.ok(error instanceof CallAuditBatchRunError)
      assert.equal(error.code, CALL_AUDIT_RUN_ERROR_CODES.createFailed)
      assertSafe(error.message, 'the createRun error message')
      return true
    },
  )
  // Nothing was claimed or finished.
  assert.deepEqual(
    control.calls.map((call) => call.kind),
    ['createRun'],
  )
})

test('a failure that cannot itself be recorded is raised, not swallowed', async () => {
  const control = fakeControl({
    failOn: 'markRunRunning',
    failMarkRunFailed: true,
  })
  await assert.rejects(
    runCallAuditBatch(baseInput({ control })),
    (error: unknown) => {
      assert.ok(error instanceof CallAuditBatchRunError)
      assert.equal(
        error.code,
        CALL_AUDIT_RUN_ERROR_CODES.failureNotRecorded,
      )
      // The original phase code survives; neither thrown value's prose does.
      assert.match(error.message, /CALL_AUDIT_RUN_CLAIM_FAILED/)
      assertSafe(error.message, 'the unrecorded-failure error message')
      return true
    },
  )
  assert.deepEqual(
    control.calls.map((call) => call.kind),
    ['createRun', 'running', 'failed'],
  )
})

test('every safe error code is storable in the control error_code column', () => {
  for (const code of Object.values(CALL_AUDIT_RUN_ERROR_CODES)) {
    assert.match(code, /^[A-Z][A-Z0-9_]*$/)
    assert.ok(code.length <= 80)
  }
})

// ---------------------------------------------------------------------------
// Module boundaries
// ---------------------------------------------------------------------------

const MODULE_SOURCE = readFileSync(
  new URL('./batchRunner.ts', import.meta.url),
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
      /\/cli\//,
      /report/i,
      /email/i,
    ]) {
      assert.equal(
        forbidden.test(specifier),
        false,
        `${specifier} must not be imported here`,
      )
    }
  }
  // Both MySQL adapters are TYPE-ONLY ports: no database module is loaded at
  // runtime by this file.
  for (const adapter of [
    'mysqlCallAuditControl.ts',
    'mysqlCallAuditPersistence.ts',
  ]) {
    const valueImport = new RegExp(
      `import (?!type )\\{[^}]*\\} from '[^']*${adapter}'`,
    )
    assert.equal(
      valueImport.test(MODULE_SOURCE),
      false,
      `${adapter} must be imported as a type only`,
    )
  }
})

test('the module contains no SQL, no positional paging, and never names the source table', () => {
  for (const forbidden of [
    /INSERT\s+INTO/i,
    /\bSELECT\s/i,
    /\bUPDATE\s+`/i,
    /DELETE\s+FROM/i,
    /\bWHERE\b/i,
    /\bJOIN\b/i,
    /FOR\s+UPDATE/i,
    /\bOFFSET\b/i,
    /\bLIMIT\s/i,
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
      `batchRunner.ts must not contain ${forbidden}`,
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
    /setTimeout/,
    /setInterval/,
    /createHash/,
    /sha256/i,
  ]) {
    assert.equal(
      forbidden.test(MODULE_SOURCE),
      false,
      `batchRunner.ts must not use ${forbidden}`,
    )
  }
})

test('the module carries no billing quantity of any kind', () => {
  for (const forbidden of [
    /\brate\b/i,
    /\bcost\b/i,
    /\bprice\b/i,
    /\bamount\b/i,
    /\binvoice\b/i,
    /\bcurrency\b/i,
    /\bdecimal\b/i,
    /\bINR\b/,
  ]) {
    assert.equal(
      forbidden.test(MODULE_SOURCE),
      false,
      `batchRunner.ts must not mention ${forbidden}`,
    )
  }
  // The single mention of money is the privacy rule that forbids one in the
  // returned summary.
  assert.equal(MODULE_SOURCE.match(/\bmoney\b/gi)?.length, 1)
})
