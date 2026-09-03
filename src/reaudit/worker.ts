import type {
  ReauditCandidate,
  ReauditItemResult,
} from './types.ts'
import {
  asReauditFatalError,
  ReauditFatalError,
} from './failures.ts'

export interface ReauditCandidateRepository {
  listCandidates(options: {
    limit: number
    includePreviouslyClassified: boolean
  }): Promise<ReauditCandidate[]>
  /**
   * Milliseconds until the earliest candidate that is eligible in every way
   * EXCEPT that it is still serving a retry backoff, or null when no such
   * candidate exists.
   *
   * A bounded drain needs this to tell "the queue is empty" apart from "every
   * remaining call is parked behind `audio_next_attempt_at` for a few minutes".
   * Optional so a reader with no backoff concept (the durable administrator
   * request queue) stays unchanged.
   */
  deferredWorkDueInMs?(): Promise<number | null>
}

export interface ReauditResultRepository {
  markStarted(candidate: ReauditCandidate, at: Date): Promise<'acquired' | 'already_completed'>
  persist(
    candidate: ReauditCandidate,
    result: ReauditItemResult,
    at: Date,
  ): Promise<'completed' | 'retry_scheduled' | 'terminal_failure' | 'already_completed'>
}

export interface ReauditProcessor {
  process(candidate: ReauditCandidate): Promise<ReauditItemResult>
}

/**
 * Durable pre-model spend guard (migration 0017).
 *
 * `claim` runs before any model call; a `busy` answer means another run holds
 * the right to spend on this exact question, so this run must skip it. A
 * `closed` answer reconciles stale work state without reopening the spend
 * lease. `settle` records what happened so a persistence failure after model
 * completion can never turn into an automatic second paid call.
 */
export interface ReauditSpendGuard {
  claim(candidate: ReauditCandidate): Promise<
    | { outcome: 'acquired' }
    | { outcome: 'busy' }
    | { outcome: 'closed'; result: ReauditItemResult }
    | { outcome: 'recovered'; result: ReauditItemResult }
  >
  stageResult(
    candidate: ReauditCandidate,
    result: ReauditItemResult,
  ): Promise<void>
  settle(
    candidate: ReauditCandidate,
    outcome: 'model_spent' | 'no_model_call' | 'unknown',
  ): Promise<void>
}

export interface ReauditWorkerSummary {
  selected: number
  completed: number
  retriesScheduled: number
  terminalFailures: number
  alreadyCompleted: number
  /** Items skipped because another run holds an active pre-model spend lease. */
  spendGuardSkipped: number
  stoppedEarly: boolean
  /**
   * Bounded diagnostic for the first fatal infrastructure failure:
   * lifecycle phase + allowlisted category. Never carries a raw error.
   */
  fatal?: { phase: string; category: string }
}

const MAX_PERSIST_DEADLOCK_RETRIES = 3

function isRetryableProviderResult(result: ReauditItemResult): boolean {
  return result.errorCode?.startsWith('TRANSCRIPTION_PROVIDER_') === true ||
    result.errorCode?.startsWith('CLASSIFICATION_PROVIDER_') === true
}

async function persistWithDeadlockRetry(options: {
  results: ReauditResultRepository
  candidate: ReauditCandidate
  result: ReauditItemResult
  at: Date
}): Promise<Awaited<ReturnType<ReauditResultRepository['persist']>>> {
  for (let retry = 0; ; retry += 1) {
    try {
      return await options.results.persist(
        options.candidate,
        options.result,
        options.at,
      )
    } catch (error) {
      const fatal = asReauditFatalError('persist', error)
      if (
        fatal.category !== 'DB_DEADLOCK' ||
        retry >= MAX_PERSIST_DEADLOCK_RETRIES
      ) {
        throw error
      }
      await new Promise((resolve) =>
        setTimeout(resolve, 25 * 2 ** retry),
      )
    }
  }
}

export async function runReauditBatch(options: {
  candidates: ReauditCandidateRepository
  results: ReauditResultRepository
  processor: ReauditProcessor
  batchSize: number
  concurrency?: number
  includePreviouslyClassified?: boolean
  spendGuard?: ReauditSpendGuard
  now?: () => Date
  onProgress?: (
    summary: Readonly<ReauditWorkerSummary>,
  ) => void | Promise<void>
  /** Graceful pause gate, checked before each new call is claimed. */
  shouldContinue?: () => Promise<boolean>
}): Promise<ReauditWorkerSummary> {
  if (!Number.isInteger(options.batchSize) || options.batchSize < 1 || options.batchSize > 100) {
    throw new RangeError('batchSize must be from 1 to 100')
  }
  const concurrency = options.concurrency ?? 1
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 10) {
    throw new RangeError('concurrency must be from 1 to 10')
  }
  const rows = await options.candidates.listCandidates({
    limit: options.batchSize,
    includePreviouslyClassified:
      options.includePreviouslyClassified === true,
  })
  const summary: ReauditWorkerSummary = {
    selected: rows.length,
    completed: 0,
    retriesScheduled: 0,
    terminalFailures: 0,
    alreadyCompleted: 0,
    spendGuardSkipped: 0,
    stoppedEarly: false,
  }
  const now = options.now ?? (() => new Date())
  let nextIndex = 0
  let progressChain = Promise.resolve()
  const workerState: { fatalError: { value: unknown } | null } = {
    fatalError: null,
  }

  const recordFatal = (
    phase: 'claim' | 'persist',
    error: unknown,
  ): void => {
    const fatal = asReauditFatalError(phase, error)
    workerState.fatalError ??= { value: fatal }
  }

  const reportProgress = async (): Promise<void> => {
    // The snapshot is taken synchronously, so per-item accounting is already
    // accurate even if progress/control reporting fails below.
    const snapshot = { ...summary }
    progressChain = progressChain.then(() => options.onProgress?.(snapshot))
    try {
      await progressChain
    } catch (error) {
      // A control-plane failure is fatal but must not interrupt items that
      // are still in flight, and must not corrupt the counts above.
      const fatal = asReauditFatalError('progress', error)
      workerState.fatalError ??= { value: fatal }
      // Replace the broken chain so later progress reports can still run.
      progressChain = Promise.resolve()
    }
  }

  const processCandidate = async (
    candidate: ReauditCandidate,
  ): Promise<void> => {
    let recoveredResult: ReauditItemResult | null = null
    let recoveredFromStage = false
    let spendClaimed = false
    if (options.spendGuard) {
      let spendRight: Awaited<ReturnType<ReauditSpendGuard['claim']>>
      try {
        spendRight = await options.spendGuard.claim(candidate)
      } catch (error) {
        recordFatal('claim', error)
        throw workerState.fatalError!.value
      }
      if (spendRight.outcome === 'busy') {
        summary.spendGuardSkipped += 1
        await reportProgress()
        return
      }
      spendClaimed = spendRight.outcome !== 'closed'
      if (
        spendRight.outcome === 'recovered' ||
        spendRight.outcome === 'closed'
      ) {
        recoveredResult = spendRight.result
        recoveredFromStage = spendRight.outcome === 'recovered'
      }
    }
    let started: 'acquired' | 'already_completed'
    try {
      started = await options.results.markStarted(candidate, now())
    } catch (error) {
      if (options.spendGuard && spendClaimed) {
        try {
          await options.spendGuard.settle(
            candidate,
            recoveredFromStage ? 'unknown' : 'no_model_call',
          )
        } catch { /* claim failure remains the reported phase */ }
      }
      recordFatal('claim', error)
      throw workerState.fatalError!.value
    }
    if (started === 'already_completed') {
      if (options.spendGuard && spendClaimed) {
        try {
          await options.spendGuard.settle(
            candidate,
            recoveredFromStage ? 'model_spent' : 'no_model_call',
          )
        } catch (error) {
          recordFatal('persist', error)
          throw workerState.fatalError!.value
        }
      }
      summary.alreadyCompleted += 1
      await reportProgress()
      return
    }
    let result: ReauditItemResult
    if (recoveredResult) {
      result = recoveredResult
    } else {
      try {
        result = await options.processor.process(candidate)
      } catch {
        // A provider/fetch/parser throw belongs to this call, not the whole
        // queue. Persist only a bounded code and let the retry policy decide.
        result = {
          callId: candidate.callId,
          artifactId: candidate.artifactId,
          outcome: 'classification_failed',
          errorCode: 'AUDIT_PROCESSOR_FAILED',
        }
      }
      if (
        options.spendGuard &&
        spendClaimed &&
        result.outcome !== 'source_missing' &&
        !isRetryableProviderResult(result)
      ) {
        try {
          await options.spendGuard.stageResult(candidate, result)
        } catch (error) {
          recordFatal('persist', error)
          throw workerState.fatalError!.value
        }
      }
    }
    let persistOutcome: Awaited<
      ReturnType<ReauditResultRepository['persist']>
    >
    try {
      persistOutcome = await persistWithDeadlockRetry({
        results: options.results,
        candidate,
        result,
        at: now(),
      })
    } catch (error) {
      if (options.spendGuard && spendClaimed) {
        // Best-effort settle so the lease — not the retry policy — owns the
        // no-second-spend decision while this item waits for recovery.
        try {
          await options.spendGuard.settle(
            candidate,
            result.outcome === 'source_missing' ||
              isRetryableProviderResult(result)
              ? 'no_model_call'
              : 'unknown',
          )
        } catch { /* recorded via the fatal below */ }
      }
      recordFatal('persist', error)
      throw workerState.fatalError!.value
    }
    if (options.spendGuard && spendClaimed) {
      // Persistence succeeded, so the paid boundary is no longer ambiguous.
      // Failed paid output is terminal and must not remain staged for replay.
      const settledOutcome = result.outcome === 'source_missing' ||
        isRetryableProviderResult(result)
        ? 'no_model_call'
        : 'model_spent'
      try {
        await options.spendGuard.settle(candidate, settledOutcome)
      } catch (error) {
        recordFatal('persist', error)
      }
    }
    if (persistOutcome === 'completed') summary.completed += 1
    else if (persistOutcome === 'retry_scheduled') summary.retriesScheduled += 1
    else if (persistOutcome === 'terminal_failure') summary.terminalFailures += 1
    else summary.alreadyCompleted += 1
    await reportProgress()
  }

  const claimAndProcessNext = async (): Promise<boolean> => {
    if (workerState.fatalError || summary.stoppedEarly || nextIndex >= rows.length) {
      return false
    }
    if (options.shouldContinue && !(await options.shouldContinue())) {
      summary.stoppedEarly = true
      return false
    }
    // Another slot may have failed while this one awaited the pause/deadline
    // gate. Do not claim fresh work after a fatal infrastructure error.
    if (workerState.fatalError || summary.stoppedEarly || nextIndex >= rows.length) {
      return false
    }
    const candidate = rows[nextIndex]
    nextIndex += 1
    await processCandidate(candidate)
    return true
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, rows.length) }, async () => {
      try {
        while (await claimAndProcessNext()) {
          // Keep this worker slot draining until there is no more claimable work.
        }
      } catch (error) {
        // Promise.all rejects early. Capture the failure instead so every item
        // already in flight gets a chance to persist before the caller closes
        // shared resources such as the MySQL pool.
        workerState.fatalError ??=
          error instanceof ReauditFatalError ? { value: error } : { value: error }
      }
    }),
  )
  await progressChain
  if (workerState.fatalError) {
    const fatal = asReauditFatalError('claim', workerState.fatalError.value)
    summary.fatal = { phase: fatal.phase, category: fatal.category }
    throw fatal
  }
  return summary
}
