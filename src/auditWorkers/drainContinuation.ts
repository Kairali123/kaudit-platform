import type { ReauditErrorCategory } from '../reaudit/failures.ts'

/**
 * How a bounded audit drain decides whether it is actually finished.
 *
 * A drain run used to stop the moment one batch selected nothing. That is not
 * the same question as "is the queue drained": recording-backed work that only
 * failed a transient provider or infrastructure attempt is parked behind
 * `audio_next_attempt_at`, so it is invisible to the eligibility read for a few
 * minutes and then becomes claimable again. Reporting that as a completed drain
 * leaves real pending calls for the next scheduled run hours later.
 *
 * These two decisions are pure so the exact stop conditions can be tested
 * without a database, a worker host, or a clock.
 */

export type DrainStopReason =
  /** Nothing eligible and nothing deferred: the queue really is empty. */
  | 'drained'
  /** The host deadline governs; the next scheduled run continues. */
  | 'deadline'
  /** Deferred work is real but due beyond what one run will wait out. */
  | 'deferred_beyond_horizon'

export type DrainContinuation =
  | { action: 'continue' }
  | { action: 'wait'; waitMs: number }
  | { action: 'stop'; reason: DrainStopReason }

export interface DrainContinuationInput {
  /** Candidates the batch just claimed. */
  selected: number
  /**
   * Milliseconds until the earliest deferred retry becomes eligible, or null
   * when no deferred work exists. Measured by the database against its own
   * clock, so no cross-process clock comparison is involved.
   */
  deferredDueInMs: number | null
  /** Milliseconds left before the host deadline. */
  remainingMs: number
  /** Longest single wait, so control heartbeats stay fresh while idling. */
  maxWaitMs: number
  /** Longest deferral this run waits out before handing over to the next run. */
  horizonMs: number
}

function positiveInteger(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive integer`)
  }
}

export function decideDrainContinuation(
  input: DrainContinuationInput,
): DrainContinuation {
  if (!Number.isSafeInteger(input.selected) || input.selected < 0) {
    throw new RangeError('selected must be a non-negative integer')
  }
  positiveInteger('maxWaitMs', input.maxWaitMs)
  positiveInteger('horizonMs', input.horizonMs)
  if (
    input.deferredDueInMs !== null &&
    !Number.isFinite(input.deferredDueInMs)
  ) {
    throw new RangeError('deferredDueInMs must be a finite number or null')
  }
  if (input.remainingMs <= 0) return { action: 'stop', reason: 'deadline' }
  if (input.selected > 0) return { action: 'continue' }
  if (input.deferredDueInMs === null) {
    return { action: 'stop', reason: 'drained' }
  }
  if (input.deferredDueInMs <= 0) return { action: 'continue' }
  if (input.deferredDueInMs > input.horizonMs) {
    return { action: 'stop', reason: 'deferred_beyond_horizon' }
  }
  if (input.deferredDueInMs >= input.remainingMs) {
    return { action: 'stop', reason: 'deadline' }
  }
  return {
    action: 'wait',
    waitMs: Math.max(
      1,
      Math.ceil(
        Math.min(input.deferredDueInMs, input.maxWaitMs, input.remainingMs),
      ),
    ),
  }
}

/**
 * Infrastructure categories a bounded run may wait out and retry.
 *
 * These are contention and connectivity conditions, not answers: the same
 * batch attempted a moment later is a legitimate retry. Everything else —
 * a constraint violation, a lifecycle refusal, a busy worker lock, an
 * unclassified driver failure — is treated as a decision and ends the run,
 * so a deterministic failure can never become an unbounded retry loop.
 */
const RETRYABLE_INFRASTRUCTURE_CATEGORIES: ReadonlySet<ReauditErrorCategory> =
  new Set([
    'DB_CONNECTION_LIMIT',
    'DB_CONNECTION_TIMEOUT',
    'DB_LOCK_TIMEOUT',
    'DB_DEADLOCK',
  ])

export function isRetryableInfrastructureCategory(
  category: ReauditErrorCategory,
): boolean {
  return RETRYABLE_INFRASTRUCTURE_CATEGORIES.has(category)
}

export type BatchFaultResponse =
  | { action: 'retry'; waitMs: number }
  | { action: 'stop' }

export interface BatchFaultInput {
  category: ReauditErrorCategory
  /** Consecutive faults including this one; reset by any clean batch. */
  consecutiveFaults: number
  maxConsecutiveFaults: number
  /** Milliseconds left before the host deadline. */
  remainingMs: number
  baseBackoffMs: number
  maxBackoffMs: number
}

/**
 * Whether a bounded drain waits out one batch failure or ends the run.
 *
 * A single transient database fault used to end the whole drain, leaving the
 * rest of an eligible queue unprocessed until the next scheduled run. Retrying
 * is safe because every item is re-selected from durable state and the pre-model
 * spend lease — not the retry — owns the no-second-spend decision.
 */
export function decideBatchFaultResponse(
  input: BatchFaultInput,
): BatchFaultResponse {
  positiveInteger('maxConsecutiveFaults', input.maxConsecutiveFaults)
  positiveInteger('baseBackoffMs', input.baseBackoffMs)
  positiveInteger('maxBackoffMs', input.maxBackoffMs)
  if (
    !Number.isSafeInteger(input.consecutiveFaults) ||
    input.consecutiveFaults < 1
  ) {
    throw new RangeError('consecutiveFaults must be a positive integer')
  }
  if (!isRetryableInfrastructureCategory(input.category)) {
    return { action: 'stop' }
  }
  if (input.consecutiveFaults >= input.maxConsecutiveFaults) {
    return { action: 'stop' }
  }
  if (input.remainingMs <= 0) return { action: 'stop' }
  const exponential =
    input.baseBackoffMs * 2 ** Math.min(input.consecutiveFaults - 1, 20)
  return {
    action: 'retry',
    waitMs: Math.max(
      1,
      Math.ceil(
        Math.min(exponential, input.maxBackoffMs, input.remainingMs),
      ),
    ),
  }
}
