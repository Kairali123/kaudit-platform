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
  now?: () => Date
  onProgress?: (summary: ReauditWorkerSummary) => void
  /** Graceful pause gate, checked before each new call is claimed. */
  shouldContinue?: () => Promise<boolean>
}): Promise<ReauditWorkerSummary> {
  if (!Number.isInteger(options.batchSize) || options.batchSize < 1 || options.batchSize > 100) {
    throw new RangeError('batchSize must be from 1 to 100')
  }
  const rows = await options.candidates.listCandidates({
    limit: options.batchSize,
    includePreviouslyClassified: false,
  })
  const summary: ReauditWorkerSummary = {
    selected: rows.length,
    completed: 0,
    retriesScheduled: 0,
    terminalFailures: 0,
    alreadyCompleted: 0,
    stoppedEarly: false,
  }
  for (const candidate of rows) {
    if (options.shouldContinue && !(await options.shouldContinue())) {
      summary.stoppedEarly = true
      break
    }
    const started = await options.results.markStarted(
      candidate,
      (options.now ?? (() => new Date()))(),
    )
    if (started === 'already_completed') {
      summary.alreadyCompleted += 1
      options.onProgress?.(summary)
      continue
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
    const outcome = await options.results.persist(
      candidate,
      result,
      (options.now ?? (() => new Date()))(),
    )
    if (outcome === 'completed') summary.completed += 1
    else if (outcome === 'retry_scheduled') summary.retriesScheduled += 1
    else if (outcome === 'terminal_failure') summary.terminalFailures += 1
    else summary.alreadyCompleted += 1
    options.onProgress?.(summary)
  }
  return summary
}
