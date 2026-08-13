import {
  nextSourceCandidateCursor,
  validateSourceCandidateQuery,
  type SourceCandidateCursor,
  type ValidatedSourceCandidateQuery,
} from './sourceQuery.ts'
import { validateCallAuditTimestamp } from './resultRecords.ts'
import {
  processCallAuditCandidate,
  type CallAuditProcessingSummary,
  type ProcessCallAuditCandidateInput,
} from './processor.ts'
import type { InternalSourceCandidate } from './sourceTypes.ts'
import type { CallAuditPersistenceRepository } from '../adapters/mysqlCallAuditPersistence.ts'
import type {
  ActivatedContentAuditModel,
  ContentAuditModelAdapter,
} from '../adapters/openaiCallAuditModel.ts'
import type {
  CallAuditRunCounters,
  CallAuditRunRequest,
  CreateRunResult,
  MarkRunCompletedInput,
  MarkRunFailedInput,
  MarkRunRunningInput,
  RunTransitionResult,
} from '../adapters/mysqlCallAuditControl.ts'

/**
 * The Call Audit BATCH ORCHESTRATION core: one bounded run over one caller-
 * supplied period, assembled entirely from injected ports.
 *
 * Responsibilities, and nothing else: create or replay the run, claim it, read
 * the period in deterministic keyset pages, hand each candidate to the
 * one-candidate processor, record absolute progress counters, and settle the run
 * into exactly one terminal state. It owns no database, HTTP route, scheduler,
 * cron cadence, distributed lock, retry policy, clock, id generator, model
 * client, or concurrency.
 *
 * Paging is KEYSET only. The cursor for the next page is the last candidate of
 * the page just consumed, so a source that grows underneath a long run never
 * causes the skips and repeats that positional paging would. There is no SQL in
 * this file: the reader owns it.
 *
 * Scheduling is deliberately absent. Turning an Asia/Kolkata calendar period
 * into UTC-naive source boundaries is a scheduling concern, so both the run's
 * calendar period and the source window arrive already expressed by the caller.
 *
 * Privacy boundary. Candidates carry the raw transcript and the full lead ID,
 * and both stay inside the processor call. Nothing here reads, copies, returns,
 * or throws a transcript, prompt, raw model response, provider prose, lead ID,
 * Task ID, source free text, or URL. Nothing here logs at all — not even a
 * count — because the safe run summary is returned to the caller instead.
 *
 * Failure prose is a privacy risk, not just noise. A thrown value from a reader,
 * a repository, or the processor may carry a query, a row, or a provider body,
 * so no thrown value is ever inspected, wrapped, or re-emitted. The failing
 * PHASE is tracked instead, and the run is settled with the bounded machine code
 * that phase maps to.
 *
 * Billing boundary. Call Audit is a separate concern from Billing Audit:
 * nothing here reads, derives, stores, or reports a chargeable figure.
 *
 * Duplicate-spend boundary. This orchestrator does not decide what may be paid
 * for. The per-candidate processor takes a permanent, default-deny spend claim
 * on the exact source revision before any model call, so two runs over
 * overlapping periods — sequential or concurrent — cannot both pay to audit the
 * same evidence. All that happens here is counting: a suppressed duplicate is
 * tallied as skipped and as `duplicateSuppressedTotal`, never as an audit.
 * There is deliberately no run-level flag to relax that.
 */

// ---------------------------------------------------------------------------
// Errors and safe codes
// ---------------------------------------------------------------------------

/**
 * The only error this module raises. It carries a bounded machine code and, for
 * an input mistake, the offending FIELD NAME — never a submitted value, and
 * never anything taken from a thrown collaborator error.
 */
export class CallAuditBatchRunError extends Error {
  readonly code: string
  readonly field: string | null

  constructor(code: string, message: string, field: string | null = null) {
    super(message)
    this.code = code
    this.field = field
  }
}

/**
 * Every reason a run can end badly, as uppercase machine codes.
 *
 * The grammar matches what the control repository accepts for its `error_code`
 * column, so a code chosen here is always storable. Each names a PHASE of the
 * orchestration and nothing about the underlying fault, which is exactly the
 * point: a phase is safe to store, report, and alert on, while a provider or
 * source message is not.
 */
export const CALL_AUDIT_RUN_ERROR_CODES = {
  /** Caller-side input mistake, detected before any run exists. */
  invalidInput: 'CALL_AUDIT_RUN_INVALID_INPUT',
  /** The run row could not be created or replayed. */
  createFailed: 'CALL_AUDIT_RUN_CREATE_FAILED',
  /** pending -> running did not take. */
  claimFailed: 'CALL_AUDIT_RUN_CLAIM_FAILED',
  /** A source page could not be read. */
  sourceReadFailed: 'CALL_AUDIT_RUN_SOURCE_READ_FAILED',
  /** The processor threw for one candidate. */
  candidateFailed: 'CALL_AUDIT_RUN_CANDIDATE_FAILED',
  /** Progress counters could not be recorded. */
  progressFailed: 'CALL_AUDIT_RUN_PROGRESS_FAILED',
  /** The completed transition did not take. */
  completionFailed: 'CALL_AUDIT_RUN_COMPLETION_FAILED',
  /**
   * The failure itself could not be recorded. Raised, never returned: the run
   * row is now out of step with reality and a caller that carried on would be
   * reporting from a run stuck in `running`.
   */
  failureNotRecorded: 'CALL_AUDIT_RUN_FAILURE_NOT_RECORDED',
} as const

/** Phases, in the order a run passes through them. */
type RunPhase =
  | 'create'
  | 'claim'
  | 'source'
  | 'candidate'
  | 'progress'
  | 'completion'

const PHASE_ERROR_CODES: Record<RunPhase, string> = {
  create: CALL_AUDIT_RUN_ERROR_CODES.createFailed,
  claim: CALL_AUDIT_RUN_ERROR_CODES.claimFailed,
  source: CALL_AUDIT_RUN_ERROR_CODES.sourceReadFailed,
  candidate: CALL_AUDIT_RUN_ERROR_CODES.candidateFailed,
  progress: CALL_AUDIT_RUN_ERROR_CODES.progressFailed,
  completion: CALL_AUDIT_RUN_ERROR_CODES.completionFailed,
}

/**
 * Hard ceiling on pages per run, so a mistaken batch size or a source that keeps
 * growing cannot turn one run into an unbounded loop.
 */
export const MAX_RUN_PAGES = 10_000

// ---------------------------------------------------------------------------
// Ports
// ---------------------------------------------------------------------------

/**
 * The run-control surface this orchestrator needs, and only that surface.
 *
 * Narrowed on purpose: the rule-version and cancellation methods of the full
 * repository are not part of a batch run, so they are not reachable from here.
 * The real MySQL repository satisfies this structurally, and no database module
 * is loaded by this file.
 */
export interface CallAuditRunControlPort {
  createRun(request: CallAuditRunRequest): Promise<CreateRunResult>
  markRunRunning(input: MarkRunRunningInput): Promise<RunTransitionResult>
  updateRunCounters(
    runId: string,
    counters: CallAuditRunCounters,
  ): Promise<RunTransitionResult>
  markRunCompleted(input: MarkRunCompletedInput): Promise<RunTransitionResult>
  markRunFailed(input: MarkRunFailedInput): Promise<RunTransitionResult>
}

/** The read side: one bounded, deterministically ordered page at a time. */
export interface CallAuditSourceReaderPort {
  listCandidates(query: {
    periodStart: string
    periodEndExclusive: string
    batchSize: number
    cursor?: SourceCandidateCursor | null
  }): Promise<InternalSourceCandidate[]>
}

/** The one-candidate processor, as a port so a fake can stand in for it. */
export type CallAuditCandidateProcessorPort = (
  input: ProcessCallAuditCandidateInput,
) => Promise<CallAuditProcessingSummary>

// ---------------------------------------------------------------------------
// Timestamps
// ---------------------------------------------------------------------------

/**
 * Caller-supplied time. No clock is read in this module: a core that generated
 * its own stamps would not replay, and a replayed run must reproduce the exact
 * values already stored.
 *
 * Either form is accepted — a supplier consulted at each moment, or four fixed
 * literals for a deterministic replay.
 */
export type CallAuditRunTimestamps =
  | { now: () => string }
  | {
      startedAt: string
      auditedAt: string
      recordedAt: string
      finishedAt: string
    }

interface ResolvedTimestamps {
  startedAt(): string
  auditedAt(): string
  recordedAt(): string
  finishedAt(): string
}

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

export interface RunCallAuditBatchInput {
  /** Creation identity of the run, as the control repository defines it. */
  request: CallAuditRunRequest
  /** Provenance carried onto every result. Must match `request.ruleVersionId`. */
  ruleVersionId: string
  /** The activated rule snapshot / model settings, passed through untouched. */
  activation: ActivatedContentAuditModel
  /**
   * The SOURCE window, already expressed in the source's UTC-naive form. It is
   * separate from `request.periodStart`/`periodEndExclusive`, which record the
   * CALENDAR period in `request.periodTimezone`; converting between the two is
   * a scheduling concern and is not done here.
   */
  sourceWindow: {
    periodStart: string
    periodEndExclusive: string
  }
  /** Rows per page. Bounded by the source query contract. */
  batchSize: number
  /** Optional ceiling on pages read. Defaults to, and is capped by, MAX_RUN_PAGES. */
  maxPages?: number
  /** Optional ceiling on candidates processed in this run. */
  maxCandidates?: number
  control: CallAuditRunControlPort
  source: CallAuditSourceReaderPort
  /** Injected one-candidate processor. Defaults to the Task 11 processor. */
  processCandidate?: CallAuditCandidateProcessorPort
  /** The processor's dependencies. Required unless `processCandidate` is given. */
  persistence?: CallAuditPersistenceRepository
  model?: ContentAuditModelAdapter
  timestamps: CallAuditRunTimestamps
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

/**
 * Absolute outcome counts for the run.
 *
 * `processedTotal` counts candidates the processor RETURNED a summary for. A
 * candidate whose processor call threw is deliberately not counted: nothing is
 * knowable about what it did, and counting it would report work that may never
 * have happened.
 */
export interface CallAuditRunCounts {
  processedTotal: number
  succeededTotal: number
  failedTotal: number
  skippedTotal: number
  operationalOnlyTotal: number
  /** Content-auditable candidates that actually produced an audit. */
  contentAuditedTotal: number
  /**
   * Candidates the cross-run spend claim refused, so this run called no model
   * and consumed no tokens for them.
   *
   * A SUBSET of `skippedTotal`, reported separately because the two answer
   * different questions: how much of the period this run declined to audit,
   * versus how much of it had already been audited and would have been paid for
   * twice. It has no counter column on the run row — the seven stored counters
   * are unchanged by this — and lives only in the safe in-memory summary.
   */
  duplicateSuppressedTotal: number
}

/** Why the page loop stopped. */
export type CallAuditRunStopReason =
  | 'exhausted'
  | 'page_limit'
  | 'candidate_limit'
  | 'failed'

/**
 * The safe outcome of a batch run.
 *
 * Deliberately tiny and coded: ids, closed enum values, bounded machine codes,
 * and counts. There is no transcript, prompt, raw model response, provider
 * prose, lead ID, Task ID, name, phone, email, URL, source free text, or money
 * value anywhere in this shape, so it is safe to return to an operational
 * caller and safe to render in an admin view.
 */
export interface CallAuditBatchRunSummary {
  runId: string
  runCreateOutcome: 'inserted' | 'replayed'
  terminalStatus: 'completed' | 'failed'
  /** Bounded machine code on failure; null on a completed run. */
  failureCode: string | null
  stopReason: CallAuditRunStopReason
  pagesRead: number
  candidatesSelected: number
  candidatesProcessed: number
  counts: CallAuditRunCounts
}

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

function invalid(field: string, reason: string): CallAuditBatchRunError {
  return new CallAuditBatchRunError(
    CALL_AUDIT_RUN_ERROR_CODES.invalidInput,
    `${field}: ${reason}`,
    field,
  )
}

function requireObject<T>(value: unknown, field: string): T {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw invalid(field, 'must be an object')
  }
  return value as T
}

function requireText(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw invalid(field, 'must be a non-blank string')
  }
  return value
}

function requireCallable(value: unknown, field: string): void {
  if (typeof value !== 'function') {
    throw invalid(field, 'must be a function')
  }
}

function optionalLimit(value: unknown, field: string): number | null {
  if (value === null || value === undefined) return null
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw invalid(field, 'must be a positive integer')
  }
  return value
}

/**
 * Checks a caller-supplied stamp against the SAME rule the result builders
 * enforce, so an impossible date fails before a run is claimed rather than
 * halfway through a page. The caller's text is passed through unchanged; only
 * the error type is translated, and the reason names the rule, never the value.
 */
function checkTimestamp(value: unknown, field: string): string {
  const text = requireText(value, field)
  try {
    validateCallAuditTimestamp(text, field)
  } catch {
    throw invalid(
      field,
      "must be a UTC-naive 'YYYY-MM-DD HH:MM:SS[.ffffff]' timestamp naming a real date and time",
    )
  }
  return text
}

/**
 * Turns either accepted time form into four checked getters.
 *
 * A supplier is consulted at the moment its stamp is needed and its answer is
 * validated every time. It is also consulted ONCE here, before any run exists,
 * and that first answer is discarded: a supplier that cannot produce a valid
 * stamp is a caller mistake, and discovering it later would leave a claimed run
 * that could not even be marked finished.
 */
function resolveTimestamps(value: unknown): ResolvedTimestamps {
  const supplied = requireObject<Record<string, unknown>>(value, 'timestamps')
  if (supplied.now !== undefined) {
    requireCallable(supplied.now, 'timestamps.now')
    const now = supplied.now as () => string
    const stamp = () => checkTimestamp(now(), 'timestamps.now')
    stamp()
    return {
      startedAt: stamp,
      auditedAt: stamp,
      recordedAt: stamp,
      finishedAt: stamp,
    }
  }
  const startedAt = checkTimestamp(supplied.startedAt, 'timestamps.startedAt')
  const auditedAt = checkTimestamp(supplied.auditedAt, 'timestamps.auditedAt')
  const recordedAt = checkTimestamp(
    supplied.recordedAt,
    'timestamps.recordedAt',
  )
  const finishedAt = checkTimestamp(
    supplied.finishedAt,
    'timestamps.finishedAt',
  )
  return {
    startedAt: () => startedAt,
    auditedAt: () => auditedAt,
    recordedAt: () => recordedAt,
    finishedAt: () => finishedAt,
  }
}

function requireControl(value: unknown): CallAuditRunControlPort {
  const control = requireObject<CallAuditRunControlPort>(value, 'control')
  requireCallable(control.createRun, 'control.createRun')
  requireCallable(control.markRunRunning, 'control.markRunRunning')
  requireCallable(control.updateRunCounters, 'control.updateRunCounters')
  requireCallable(control.markRunCompleted, 'control.markRunCompleted')
  requireCallable(control.markRunFailed, 'control.markRunFailed')
  return control
}

function requireSource(value: unknown): CallAuditSourceReaderPort {
  const source = requireObject<CallAuditSourceReaderPort>(value, 'source')
  requireCallable(source.listCandidates, 'source.listCandidates')
  return source
}

/**
 * Picks the candidate processor.
 *
 * An injected processor is used as given and its dependencies are then this
 * module's business no longer. Otherwise the Task 11 processor is used, and its
 * two collaborators must be present: a run that discovered a missing model
 * adapter on its first candidate would already have claimed the run.
 */
function requireProcessor(input: RunCallAuditBatchInput): {
  processCandidate: CallAuditCandidateProcessorPort
  persistence: CallAuditPersistenceRepository
  model: ContentAuditModelAdapter
} {
  if (input.processCandidate !== undefined) {
    requireCallable(input.processCandidate, 'processCandidate')
    return {
      processCandidate: input.processCandidate,
      // Unused by an injected processor; the port receives them only because
      // the processor input shape carries them.
      persistence: input.persistence as CallAuditPersistenceRepository,
      model: input.model as ContentAuditModelAdapter,
    }
  }
  const persistence = requireObject<CallAuditPersistenceRepository>(
    input.persistence,
    'persistence',
  )
  requireCallable(
    persistence.upsertSourceReference,
    'persistence.upsertSourceReference',
  )
  requireCallable(persistence.saveResultBundle, 'persistence.saveResultBundle')
  requireCallable(
    persistence.recordUsageAttempt,
    'persistence.recordUsageAttempt',
  )
  // Checked here as well as inside the processor, so a run that has no
  // duplicate-spend gate is refused BEFORE it is created rather than on its
  // first content-auditable candidate — by which point the run row exists and
  // the page has been read.
  requireCallable(
    persistence.claimContentAuditSpend,
    'persistence.claimContentAuditSpend',
  )
  const model = requireObject<ContentAuditModelAdapter>(input.model, 'model')
  requireCallable(model.auditTranscript, 'model.auditTranscript')
  return { processCandidate: processCallAuditCandidate, persistence, model }
}

// ---------------------------------------------------------------------------
// Tally
// ---------------------------------------------------------------------------

interface RunTally {
  candidatesSelected: number
  counts: CallAuditRunCounts
}

function emptyTally(): RunTally {
  return {
    candidatesSelected: 0,
    counts: {
      processedTotal: 0,
      succeededTotal: 0,
      failedTotal: 0,
      skippedTotal: 0,
      operationalOnlyTotal: 0,
      contentAuditedTotal: 0,
      duplicateSuppressedTotal: 0,
    },
  }
}

/**
 * Folds one processor summary into the tally.
 *
 * The summary is already privacy-safe — closed enum values and ids only — so
 * counting reads nothing sensitive. A refused or failed content attempt raises
 * `failedTotal` and deliberately NOT `contentAuditedTotal`: the transcript was
 * auditable, but no audit came back, and a reliability figure that counted the
 * attempt as an audit would overstate coverage.
 *
 * A candidate the spend claim refused lands in `skippedTotal` — never in
 * `succeeded` and never in `contentAuditedTotal`, because this run neither
 * audited it nor paid to — and is additionally counted in
 * `duplicateSuppressedTotal`, so "we deliberately did not audit this" stays
 * distinguishable from "we audited it".
 */
function tallySummary(tally: RunTally, summary: CallAuditProcessingSummary) {
  const counts = tally.counts
  counts.processedTotal += 1
  const status = summary.result.processingStatus
  if (status === 'succeeded') counts.succeededTotal += 1
  if (status === 'failed') counts.failedTotal += 1
  if (status === 'skipped') counts.skippedTotal += 1
  if (summary.spendSkipCode !== null) counts.duplicateSuppressedTotal += 1
  if (summary.result.eligibility === 'operational_only') {
    counts.operationalOnlyTotal += 1
  } else if (status === 'succeeded') {
    counts.contentAuditedTotal += 1
  }
}

/**
 * Projects the tally onto the control repository's seven counter columns.
 *
 * Absolute values, never increments: a retried batch that added to a stored
 * counter would double-count its own progress.
 */
function countersOf(tally: RunTally): CallAuditRunCounters {
  return {
    totalCandidates: tally.candidatesSelected,
    processedCount: tally.counts.processedTotal,
    succeededCount: tally.counts.succeededTotal,
    failedCount: tally.counts.failedTotal,
    skippedCount: tally.counts.skippedTotal,
    contentAuditableCount: tally.counts.contentAuditedTotal,
    operationalOnlyCount: tally.counts.operationalOnlyTotal,
  }
}

// ---------------------------------------------------------------------------
// The orchestrator
// ---------------------------------------------------------------------------

/**
 * Runs one bounded Call Audit batch and settles it into exactly one terminal
 * state.
 *
 * The shape of a run:
 *
 *   1. create or replay the run row, and take the id it reports — a replay is
 *      normal, not an error, so a restarted caller rejoins its own run rather
 *      than minting a second one;
 *   2. claim it (pending -> running);
 *   3. read one keyset page, hand each candidate to the processor in order, and
 *      record absolute counters for the progress made so far;
 *   4. repeat from the cursor of the last candidate consumed until the period is
 *      exhausted or a caller-supplied ceiling is reached;
 *   5. mark the run completed.
 *
 * Candidates are processed SEQUENTIALLY. Concurrency would change the order in
 * which results and usage attempts are written and is deliberately out of scope.
 *
 * A model or provider outcome is not a run failure: the processor represents it
 * as a failed result and a recorded attempt, and it lands in `failedTotal`. Only
 * an infrastructure or caller fault outside that contract ends the run, and when
 * it does the run is marked failed with the bounded code for the phase it
 * reached and a safe summary is RETURNED rather than the thrown value being
 * re-raised — re-raising it would carry provider or source prose straight past
 * this module's privacy boundary.
 */
export async function runCallAuditBatch(
  input: RunCallAuditBatchInput,
): Promise<CallAuditBatchRunSummary> {
  const request = requireObject<RunCallAuditBatchInput>(input, 'input')
  const runRequest = requireObject<CallAuditRunRequest>(
    request.request,
    'request',
  )
  const ruleVersionId = requireText(request.ruleVersionId, 'ruleVersionId')
  if (runRequest.ruleVersionId !== ruleVersionId) {
    // Provenance is composite: a result cites its run AND its rule version, so
    // the two may never disagree about which contract governed the audit.
    throw invalid(
      'ruleVersionId',
      'must equal request.ruleVersionId so the run and its results cite one contract',
    )
  }
  const activation = requireObject<ActivatedContentAuditModel>(
    request.activation,
    'activation',
  )
  const window = requireObject<{
    periodStart: string
    periodEndExclusive: string
  }>(request.sourceWindow, 'sourceWindow')

  // Reuses the source query contract rather than restating its calendar and
  // batch-size rules, so this module and the reader can never disagree about
  // what a valid window is.
  let baseQuery: ValidatedSourceCandidateQuery
  try {
    baseQuery = validateSourceCandidateQuery({
      periodStart: window.periodStart,
      periodEndExclusive: window.periodEndExclusive,
      batchSize: request.batchSize,
      cursor: null,
    })
  } catch {
    throw invalid(
      'sourceWindow',
      'must be a valid half-open UTC-naive source window with an accepted batchSize',
    )
  }

  const maxPages = Math.min(
    optionalLimit(request.maxPages, 'maxPages') ?? MAX_RUN_PAGES,
    MAX_RUN_PAGES,
  )
  const maxCandidates = optionalLimit(request.maxCandidates, 'maxCandidates')
  const control = requireControl(request.control)
  const source = requireSource(request.source)
  const { processCandidate, persistence, model } = requireProcessor(request)
  const clock = resolveTimestamps(request.timestamps)

  // The run must exist before anything can be attributed to it, and a failure
  // here has no run row to record it against, so it is raised, not returned.
  let created: CreateRunResult
  try {
    created = await control.createRun(runRequest)
  } catch {
    throw new CallAuditBatchRunError(
      CALL_AUDIT_RUN_ERROR_CODES.createFailed,
      'the Call Audit run could not be created',
    )
  }
  const runId = created.id

  const tally = emptyTally()
  let pagesRead = 0
  let stopReason: CallAuditRunStopReason = 'exhausted'
  // Tracked so a failure can be coded by the phase it reached. The thrown value
  // itself is never bound, inspected, or re-emitted.
  let phase: RunPhase = 'claim'

  try {
    await control.markRunRunning({ runId, startedAt: clock.startedAt() })

    let cursor: SourceCandidateCursor | null = null
    while (pagesRead < maxPages) {
      phase = 'source'
      const page = await source.listCandidates({
        periodStart: baseQuery.periodStart,
        periodEndExclusive: baseQuery.periodEndExclusive,
        batchSize: baseQuery.batchSize,
        cursor,
      })
      pagesRead += 1
      if (page.length === 0) {
        break
      }

      tally.candidatesSelected += page.length
      for (const candidate of page) {
        phase = 'candidate'
        const summary = await processCandidate({
          runId,
          ruleVersionId,
          activation,
          candidate,
          // One attempt per candidate in this task: retry policy belongs to a
          // caller that can decide how often a run may pay for the same call.
          attemptNumber: 1,
          auditedAt: clock.auditedAt(),
          recordedAt: clock.recordedAt(),
          repository: persistence,
          model,
        })
        tallySummary(tally, summary)
        if (
          maxCandidates !== null &&
          tally.counts.processedTotal >= maxCandidates
        ) {
          stopReason = 'candidate_limit'
          break
        }
      }

      phase = 'progress'
      await control.updateRunCounters(runId, countersOf(tally))
      if (stopReason === 'candidate_limit') {
        break
      }

      // The cursor is the last candidate consumed, so the next page resumes
      // exactly after it. A short page means the period held no more rows.
      cursor = nextSourceCandidateCursor(page)
      if (page.length < baseQuery.batchSize) {
        break
      }
      if (pagesRead >= maxPages) {
        stopReason = 'page_limit'
      }
    }

    phase = 'completion'
    await control.markRunCompleted({
      runId,
      finishedAt: clock.finishedAt(),
      counters: countersOf(tally),
    })
  } catch {
    // The thrown value is deliberately NOT bound. Nothing about it is knowable
    // after this point, which is the guarantee: it cannot be logged, wrapped,
    // stored, or returned, so no query, row, or provider body can escape.
    return await settleFailedRun({
      control,
      runId,
      created,
      clock,
      tally,
      pagesRead,
      errorCode: PHASE_ERROR_CODES[phase],
    })
  }

  return {
    runId,
    runCreateOutcome: created.outcome,
    terminalStatus: 'completed',
    failureCode: null,
    stopReason,
    pagesRead,
    candidatesSelected: tally.candidatesSelected,
    candidatesProcessed: tally.counts.processedTotal,
    counts: { ...tally.counts },
  }
}

interface SettleFailedRunInput {
  control: CallAuditRunControlPort
  runId: string
  created: CreateRunResult
  clock: ResolvedTimestamps
  tally: RunTally
  pagesRead: number
  errorCode: string
}

/**
 * Records the failure and returns the safe summary for it.
 *
 * If the failure marking ITSELF fails, that is not swallowed: the run row is
 * left in `running` while the work has stopped, and a caller told the run merely
 * failed would never learn the record is wrong. So a typed error is raised —
 * carrying the two bounded codes and no prose from either thrown value.
 */
async function settleFailedRun(
  input: SettleFailedRunInput,
): Promise<CallAuditBatchRunSummary> {
  try {
    await input.control.markRunFailed({
      runId: input.runId,
      finishedAt: input.clock.finishedAt(),
      errorCode: input.errorCode,
      counters: countersOf(input.tally),
    })
  } catch {
    throw new CallAuditBatchRunError(
      CALL_AUDIT_RUN_ERROR_CODES.failureNotRecorded,
      `the Call Audit run failed with ${input.errorCode} and the failure could not be recorded`,
    )
  }
  return {
    runId: input.runId,
    runCreateOutcome: input.created.outcome,
    terminalStatus: 'failed',
    failureCode: input.errorCode,
    stopReason: 'failed',
    pagesRead: input.pagesRead,
    candidatesSelected: input.tally.candidatesSelected,
    candidatesProcessed: input.tally.counts.processedTotal,
    counts: { ...input.tally.counts },
  }
}
