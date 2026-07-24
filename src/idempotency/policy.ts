import type { IdempotencyBeginResult } from './types.ts'

export interface ExistingIdempotencyState {
  requestHash: string
  status: string
  responseReference: string | null
  httpStatus: number | null
  responseHash: string | null
  lockOwner: string | null
  lockedUntil: Date | null
}

export function classifyIdempotencyAttempt(options: {
  existing: ExistingIdempotencyState | null
  requestHash: string
  owner: string
  now: Date
}): IdempotencyBeginResult {
  const existing = options.existing
  if (!existing || existing.requestHash !== options.requestHash) {
    return { outcome: 'conflict' }
  }
  if (
    existing.status === 'completed' &&
    existing.responseReference &&
    existing.httpStatus != null &&
    existing.responseHash
  ) {
    return {
      outcome: 'replay',
      responseReference: existing.responseReference,
      httpStatus: existing.httpStatus,
      responseHash: existing.responseHash,
    }
  }
  if (
    existing.status === 'processing' &&
    existing.lockOwner !== options.owner &&
    existing.lockedUntil != null &&
    existing.lockedUntil.getTime() > options.now.getTime()
  ) {
    return { outcome: 'in_progress' }
  }
  return { outcome: 'acquired' }
}
