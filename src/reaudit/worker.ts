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
}

export async function runReauditBatch(options: {
  candidates: ReauditCandidateRepository
  results: ReauditResultRepository
  processor: ReauditProcessor
  batchSize: number
  now?: () => Date
  onProgress?: (summary: ReauditWorkerSummary) => void
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
  }
  for (const candidate of rows) {
    const started = await options.results.markStarted(
      candidate,
      (options.now ?? (() => new Date()))(),
    )
    if (started === 'already_completed') {
      summary.alreadyCompleted += 1
      options.onProgress?.(summary)
      continue
    }
    const result = await options.processor.process(candidate)
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
