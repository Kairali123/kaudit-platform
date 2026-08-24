import type {
  ReauditCandidate,
  ReauditItemResult,
} from './types.ts'

export interface ReauditCandidateRepository {
  listCandidates(options: {
    limit: number
    includePreviouslyClassified: boolean
  }): Promise<ReauditCandidate[]>
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

export interface ReauditWorkerSummary {
  selected: number
  completed: number
  retriesScheduled: number
  terminalFailures: number
  alreadyCompleted: number
  stoppedEarly: boolean
}

export async function runReauditBatch(options: {
  candidates: ReauditCandidateRepository
  results: ReauditResultRepository
  processor: ReauditProcessor
  batchSize: number
  concurrency?: number
  includePreviouslyClassified?: boolean
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
    stoppedEarly: false,
  }
  const now = options.now ?? (() => new Date())
  let nextIndex = 0
  let progressChain = Promise.resolve()
  const workerState: { fatalError: { value: unknown } | null } = {
    fatalError: null,
  }

  const reportProgress = async (): Promise<void> => {
    const snapshot = { ...summary }
    progressChain = progressChain.then(() => options.onProgress?.(snapshot))
    await progressChain
  }

  const processCandidate = async (
    candidate: ReauditCandidate,
  ): Promise<void> => {
    const started = await options.results.markStarted(candidate, now())
    if (started === 'already_completed') {
      summary.alreadyCompleted += 1
      await reportProgress()
      return
    }
    let result: ReauditItemResult
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
    const outcome = await options.results.persist(candidate, result, now())
    if (outcome === 'completed') summary.completed += 1
    else if (outcome === 'retry_scheduled') summary.retriesScheduled += 1
    else if (outcome === 'terminal_failure') summary.terminalFailures += 1
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
        workerState.fatalError ??= { value: error }
      }
    }),
  )
  await progressChain
  if (workerState.fatalError) throw workerState.fatalError.value
  return summary
}
