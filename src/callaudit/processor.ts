import {
  buildContentAuditResult,
  buildFailedResult,
  buildOperationalOnlyResult,
  buildUsageEventRecord,
  MAX_ATTEMPT_NUMBER,
  validateCallAuditTimestamp,
  type CallAuditResultBundle,
  type CallAuditResultIdentity,
  type ProcessingStatus,
  type UsageAttemptOutcome,
} from './resultRecords.ts'
import { buildSourceRevision } from './sourceRevision.ts'
import type {
  CallAuditSourceReference,
  InternalSourceCandidate,
} from './sourceTypes.ts'
import type { CallAuditEligibility } from './types.ts'
import type { CallAuditPersistenceRepository } from '../adapters/mysqlCallAuditPersistence.ts'
import {
  CONTENT_AUDIT_ERROR_CODES,
  MAX_DURATION_SECONDS,
  type ActivatedContentAuditModel,
  type ContentAuditCallContext,
  type ContentAuditModelAdapter,
  type ContentAuditModelResult,
} from '../adapters/openaiCallAuditModel.ts'

/**
 * The Call Audit processing core for EXACTLY ONE server-internal source
 * candidate.
 *
 * Responsibilities, and nothing else: build the privacy-safe source revision,
 * persist or reuse it, decide eligibility from that revision, call the injected
 * content model at most once when there is a transcript, build the matching
 * result bundle, and record the attempt. Every collaborator is injected, so this
 * module owns no database, HTTP route, scheduler, worker loop, retry policy,
 * batch, lock, clock, or id generator.
 *
 * Ordering is a contract, not an implementation detail: the source reference is
 * written first because the result identity needs its id, and the usage attempt
 * is recorded last because the composite provenance
 * (result_id, run_id, rule_version_id) can only be enforced once the result row
 * exists.
 *
 * Privacy boundary. The transcript reaches exactly one place — the injected
 * model adapter's request — and never a persisted record, the returned summary,
 * a thrown error, or a log. Nothing here logs at all. Nothing here hashes the
 * transcript either: `buildSourceRevision` owns that, and a second hashing site
 * could drift from the evidence hash of record.
 *
 * Billing boundary. Call Audit never chooses, calculates, stores, or reports
 * money. Token counts and elapsed milliseconds pass through as operational
 * facts about an attempt and are never turned into a chargeable figure here.
 */

/** Typed input failure. Names the offending field, never its value. */
export class CallAuditProcessorError extends Error {
  readonly code = 'INVALID_CALL_AUDIT_PROCESSOR_INPUT'
  readonly field: string

  constructor(field: string, reason: string) {
    super(`${field}: ${reason}`)
    this.field = field
  }
}

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

export interface ProcessCallAuditCandidateInput {
  /** Provenance: the run this candidate is being processed under. */
  runId: string
  /** Provenance: the activated rule version that governs the audit. */
  ruleVersionId: string
  /**
   * The activated rule snapshot / model settings the content model adapter
   * needs. A full rule activation satisfies it and may be passed straight
   * through.
   */
  activation: ActivatedContentAuditModel
  /** SERVER-INTERNAL. Carries the raw transcript; never leaves this process. */
  candidate: InternalSourceCandidate
  /** Ordinal of this content-model attempt, for the usage event. */
  attemptNumber: number
  /**
   * Audit time for a completed audit, supplied by the caller. No clock is read
   * here: a core that generated its own timestamps would not replay.
   */
  auditedAt: string
  /** Attempt time recorded on the usage event, also caller-supplied. */
  recordedAt: string
  /** Injected writer. Owns all SQL; there is none in this module. */
  repository: CallAuditPersistenceRepository
  /** Injected content model. Called at most once, and only with a transcript. */
  model: ContentAuditModelAdapter
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

/**
 * What happened to the attempt, when one was made.
 *
 * `errorCode` is the bounded machine code the model adapter returned — never
 * provider prose, a refusal string, or a raw payload.
 */
export interface CallAuditUsageSummary {
  attemptNumber: number
  attemptOutcome: UsageAttemptOutcome
  errorCode: string | null
  persistOutcome: 'inserted' | 'replayed'
}

/**
 * The safe outcome of processing one candidate.
 *
 * Deliberately tiny and coded: ids, approved enum values, and persistence
 * outcomes only. There is no transcript, prompt, raw model response, provider
 * prose, lead ID, Task ID, name, phone, email, URL, source free text, or money
 * value anywhere in this shape, so it is safe to return to an operational
 * caller.
 */
export interface CallAuditProcessingSummary {
  sourceRef: {
    id: string
    persistOutcome: 'inserted' | 'reused'
  }
  result: {
    id: string
    processingStatus: ProcessingStatus
    eligibility: CallAuditEligibility
    persistOutcome: 'inserted' | 'replayed'
  }
  /** False for an operational-only call: no transcript, so no model spend. */
  modelAttempted: boolean
  /** Null whenever no attempt was made. */
  usage: CallAuditUsageSummary | null
}

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

function requireObject<T>(value: unknown, field: string): T {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new CallAuditProcessorError(field, 'must be an object')
  }
  return value as T
}

/**
 * Checks presence and shape only. The exact identifier grammar belongs to the
 * record builders, which are authoritative for the columns; this check exists so
 * an obviously invalid input fails BEFORE any write rather than after a source
 * reference has already been persisted.
 */
function requireText(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new CallAuditProcessorError(field, 'must be a non-blank string')
  }
  return value
}

/**
 * Checks a caller-supplied timestamp against the SAME rule the record builders
 * enforce, before anything is written.
 *
 * Presence alone is not enough here: an impossible date, an out-of-range hour,
 * or a non-canonical shape would otherwise survive until a builder rejected it
 * — after a source reference had already been persisted, leaving a row whose
 * result never arrives. The grammar is not restated; `validateCallAuditTimestamp`
 * is the builders' own check, so the two can never disagree.
 *
 * The validated value is discarded and the caller's text is passed through
 * unchanged, so the builders remain authoritative for the stored form. Only the
 * error type is translated, to this module's single typed input failure; the
 * reason names the rule, never the submitted value.
 */
function requireSuppliedTimestamp(value: unknown, field: string): string {
  const text = requireText(value, field)
  try {
    validateCallAuditTimestamp(text, field)
  } catch {
    throw new CallAuditProcessorError(
      field,
      "must be a UTC-naive 'YYYY-MM-DD HH:MM:SS[.ffffff]' timestamp naming a real date and time",
    )
  }
  return text
}

function requireAttemptNumber(value: unknown): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > MAX_ATTEMPT_NUMBER
  ) {
    throw new CallAuditProcessorError(
      'attemptNumber',
      `must be an integer between 1 and ${MAX_ATTEMPT_NUMBER}`,
    )
  }
  return value
}

function requireCallable(value: unknown, field: string): void {
  if (typeof value !== 'function') {
    throw new CallAuditProcessorError(field, 'must be a function')
  }
}

function requireRepository(value: unknown): CallAuditPersistenceRepository {
  const repository = requireObject<CallAuditPersistenceRepository>(
    value,
    'repository',
  )
  requireCallable(
    repository.upsertSourceReference,
    'repository.upsertSourceReference',
  )
  requireCallable(repository.saveResultBundle, 'repository.saveResultBundle')
  requireCallable(
    repository.recordUsageAttempt,
    'repository.recordUsageAttempt',
  )
  return repository
}

function requireModel(value: unknown): ContentAuditModelAdapter {
  const model = requireObject<ContentAuditModelAdapter>(value, 'model')
  requireCallable(model.auditTranscript, 'model.auditTranscript')
  return model
}

// ---------------------------------------------------------------------------
// Safe model context
// ---------------------------------------------------------------------------

/**
 * The bounded operational context sent alongside the transcript.
 *
 * Only `durationSeconds` is available: it is already carried by the
 * privacy-safe reference and identifies nobody. There is deliberately no
 * language field — the source contract represents no language locally, and
 * inventing one would send an unsupported fact to a paid model. Nothing that
 * could identify a caller (lead ID, Task ID, name, phone, email, URL, source
 * free text, timestamps) is ever placed here.
 *
 * A duration outside the adapter's accepted range is reported as unknown rather
 * than passed on or allowed to fail the audit: optional context is omitted when
 * it is not credible, never repaired into a different number.
 */
function safeCallContext(
  reference: CallAuditSourceReference,
): ContentAuditCallContext {
  const seconds = reference.callDurationSeconds
  const credible =
    seconds !== null &&
    Number.isSafeInteger(seconds) &&
    seconds >= 0 &&
    seconds <= MAX_DURATION_SECONDS
  return { durationSeconds: credible ? seconds : null }
}

// ---------------------------------------------------------------------------
// The processor
// ---------------------------------------------------------------------------

/**
 * Processes exactly one candidate into Call Audit persistence records.
 *
 * The two paths:
 *
 *   * no auditable transcript — the model is NOT called and no usage attempt is
 *     recorded, because no spend occurred; an operational-only result is saved;
 *   * an auditable transcript — the model is called once, the matching result is
 *     saved, and the attempt is recorded afterwards whether it succeeded, was
 *     refused, or failed, so reliability reporting cannot count only successes.
 *
 * Only caller-side input mistakes throw. A model or provider outcome is an
 * expected result of running, and is represented by the persisted result and
 * usage records rather than escaping as an exception carrying provider prose —
 * including when the adapter itself throws, which is recorded as a failed
 * attempt with the thrown value never inspected.
 */
export async function processCallAuditCandidate(
  input: ProcessCallAuditCandidateInput,
): Promise<CallAuditProcessingSummary> {
  const request = requireObject<ProcessCallAuditCandidateInput>(input, 'input')
  const runId = requireText(request.runId, 'runId')
  const ruleVersionId = requireText(request.ruleVersionId, 'ruleVersionId')
  const activation = requireObject<ActivatedContentAuditModel>(
    request.activation,
    'activation',
  )
  const candidate = requireObject<InternalSourceCandidate>(
    request.candidate,
    'candidate',
  )
  // Validated on BOTH paths, even though only a content attempt records a usage
  // event: the contract of the input should not depend on the branch taken.
  const attemptNumber = requireAttemptNumber(request.attemptNumber)
  const auditedAt = requireSuppliedTimestamp(request.auditedAt, 'auditedAt')
  const recordedAt = requireSuppliedTimestamp(request.recordedAt, 'recordedAt')
  const repository = requireRepository(request.repository)
  const model = requireModel(request.model)

  // The raw transcript stays inside this envelope; `reference` is the only part
  // that ever reaches persistence.
  const envelope = buildSourceRevision(candidate)
  const reference = envelope.reference

  const persistedSourceRef = await repository.upsertSourceReference(reference)

  const identity: CallAuditResultIdentity = {
    runId,
    // The PERSISTED id, whether the row was inserted or an unchanged revision
    // was reused — the result must point at the row that actually exists.
    sourceRefId: persistedSourceRef.id,
    ruleVersionId,
  }

  // The KServe-reported label as the source states it. It is passed through
  // untouched: `compareKserveOutcome` keeps it only when it is EXACTLY an
  // approved taxonomy label, and there is no aliasing or normalization of
  // obsolete labels anywhere in this path.
  const kserveReportedOutcome = reference.final_lead_outcome

  const transcript = envelope.transcript
  if (!reference.hasTranscript || transcript === null) {
    const bundle = buildOperationalOnlyResult({
      identity,
      kserveReportedOutcome,
      auditedAt,
    })
    const saved = await repository.saveResultBundle(bundle)
    return summarize(persistedSourceRef, bundle, saved, false, null)
  }

  // The adapter's contract is to RETURN provider outcomes, but a thrown value
  // must not become the caller's problem either: an exception escaping here
  // would carry provider prose, a stack, or — worst — the transcript that was
  // in the request body, straight past this module's privacy boundary.
  //
  // So a throw is treated as exactly what the adapter would have returned for a
  // client that threw: a transport failure. The thrown value is deliberately
  // NOT bound, inspected, logged, wrapped, or persisted; nothing about it is
  // knowable after this point, which is the guarantee. `undefined` marks the
  // case, so only the model call itself is covered and a later persistence
  // error still propagates as a real failure.
  let modelResult: ContentAuditModelResult | undefined
  try {
    modelResult = await model.auditTranscript({
      activation,
      // In memory only, for this one request. Never persisted or returned.
      transcript,
      context: safeCallContext(reference),
    })
  } catch {
    modelResult = undefined
  }

  if (modelResult === undefined) {
    return await persistThrownModelFailure({
      identity,
      activation,
      kserveReportedOutcome,
      attemptNumber,
      recordedAt,
      repository,
      persistedSourceRef,
    })
  }

  const bundle =
    modelResult.status === 'succeeded'
      ? buildContentAuditResult({
          identity,
          output: modelResult.output,
          kserveReportedOutcome,
          auditedAt,
        })
      : buildFailedResult({
          identity,
          // The transcript existed, so the call stays content-auditable: the
          // attempt failed, the eligibility did not change.
          eligibility: 'content_auditable',
          // The adapter's bounded machine code, recorded verbatim.
          errorCode: modelResult.failure.errorCode,
          kserveReportedOutcome,
        })

  const saved = await repository.saveResultBundle(bundle)

  // Recorded only now: the usage event carries composite provenance back to the
  // result row, so the result must exist before the attempt can be written.
  const usage = modelResult.usage
  const attemptOutcome: UsageAttemptOutcome = modelResult.status
  const usageRecord = buildUsageEventRecord({
    identity,
    attemptNumber,
    attemptOutcome,
    providerName: usage.provider,
    modelName: usage.modelName,
    modelVersion: usage.modelVersion,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    totalTokens: usage.totalTokens,
    requestId: usage.requestId,
    latencyMs: usage.latencyMs,
    errorCode:
      modelResult.status === 'succeeded' ? null : modelResult.failure.errorCode,
    recordedAt,
  })
  const recorded = await repository.recordUsageAttempt(usageRecord)

  return summarize(persistedSourceRef, bundle, saved, true, {
    attemptNumber: usageRecord.attemptNumber,
    attemptOutcome: usageRecord.attemptOutcome,
    errorCode: usageRecord.errorCode,
    persistOutcome: recorded.outcome,
  })
}

interface ThrownModelFailureInput {
  identity: CallAuditResultIdentity
  activation: ActivatedContentAuditModel
  kserveReportedOutcome: unknown
  attemptNumber: number
  recordedAt: string
  repository: CallAuditPersistenceRepository
  persistedSourceRef: { id: string; outcome: 'inserted' | 'reused' }
}

/**
 * Persists the outcome of a content-model call that THREW.
 *
 * It is recorded as a failed attempt rather than dropped: the request may well
 * have reached the provider and been billed, and a run that silently forgot the
 * throw would report a reliability and spend figure that never happened.
 *
 * Two facts are deliberately absent instead of guessed. The provider, model, and
 * version come from the ACTIVATED rule, which is what the request was built
 * from, not from a reply that never arrived; and the request id, token counts,
 * and latency are null, because a throw produced no safe usage facts and an
 * invented zero would read as a real measurement of no tokens and no time.
 *
 * Ordering is the same contract as the normal path: the result row first, then
 * the usage event that carries composite provenance back to it.
 */
async function persistThrownModelFailure(
  input: ThrownModelFailureInput,
): Promise<CallAuditProcessingSummary> {
  const identity = input.identity
  const bundle = buildFailedResult({
    identity,
    // A transcript existed and was sent, so the call remains content-auditable:
    // the attempt failed, the eligibility did not change.
    eligibility: 'content_auditable',
    // The adapter's own code for "the client threw", used verbatim so a throw
    // and a returned transport failure are indistinguishable downstream.
    errorCode: CONTENT_AUDIT_ERROR_CODES.requestFailed,
    kserveReportedOutcome: input.kserveReportedOutcome,
  })
  const saved = await input.repository.saveResultBundle(bundle)

  const usageRecord = buildUsageEventRecord({
    identity,
    attemptNumber: input.attemptNumber,
    attemptOutcome: 'failed',
    providerName: input.activation.modelProvider,
    modelName: input.activation.modelName,
    modelVersion: input.activation.modelVersion,
    inputTokens: null,
    outputTokens: null,
    totalTokens: null,
    requestId: null,
    latencyMs: null,
    errorCode: CONTENT_AUDIT_ERROR_CODES.requestFailed,
    recordedAt: input.recordedAt,
  })
  const recorded = await input.repository.recordUsageAttempt(usageRecord)

  return summarize(input.persistedSourceRef, bundle, saved, true, {
    attemptNumber: usageRecord.attemptNumber,
    attemptOutcome: usageRecord.attemptOutcome,
    errorCode: usageRecord.errorCode,
    persistOutcome: recorded.outcome,
  })
}

/** Builds the safe summary from records that are already privacy-safe. */
function summarize(
  sourceRef: { id: string; outcome: 'inserted' | 'reused' },
  bundle: CallAuditResultBundle,
  saved: { outcome: 'inserted' | 'replayed' },
  modelAttempted: boolean,
  usage: CallAuditUsageSummary | null,
): CallAuditProcessingSummary {
  return {
    sourceRef: { id: sourceRef.id, persistOutcome: sourceRef.outcome },
    result: {
      id: bundle.result.id,
      processingStatus: bundle.result.processingStatus,
      eligibility: bundle.result.eligibility,
      persistOutcome: saved.outcome,
    },
    modelAttempted,
    usage,
  }
}
