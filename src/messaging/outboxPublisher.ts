import { sha256Hex } from '../lib/hash.ts'
import type {
  MessageTransport,
  OutboxRepository,
} from './types.ts'

export interface PublishSummary {
  claimed: number
  published: number
  retried: number
  deadLettered: number
  integrityRejected: number
}

export function retryDelayMs(
  attemptsBeforeFailure: number,
  baseMs = 1_000,
  maximumMs = 15 * 60_000,
): number {
  const exponent = Math.max(
    0,
    Math.min(attemptsBeforeFailure, 20),
  )
  return Math.min(maximumMs, baseMs * 2 ** exponent)
}

function safeErrorCode(error: unknown): string {
  if (
    error &&
    typeof error === 'object' &&
    'code' in error &&
    typeof error.code === 'string' &&
    /^[A-Z0-9_]{1,80}$/.test(error.code)
  ) {
    return error.code
  }
  return 'TRANSPORT_FAILURE'
}

export async function publishOutboxBatch(options: {
  repository: OutboxRepository
  transport: MessageTransport
  owner: string
  limit: number
  now: Date
  leaseMs: number
  maxAttempts: number
}): Promise<PublishSummary> {
  const claimed = await options.repository.claim({
    owner: options.owner,
    limit: options.limit,
    now: options.now,
    leaseUntil: new Date(options.now.getTime() + options.leaseMs),
  })
  const summary: PublishSummary = {
    claimed: claimed.length,
    published: 0,
    retried: 0,
    deadLettered: 0,
    integrityRejected: 0,
  }

  for (const message of claimed) {
    if (sha256Hex(message.payloadJson) !== message.payloadSha256) {
      await options.repository.markFailed({
        id: message.id,
        owner: options.owner,
        nextStatus: 'dead_letter',
        availableAt: options.now,
        errorCode: 'PAYLOAD_HASH_MISMATCH',
      })
      summary.deadLettered += 1
      summary.integrityRejected += 1
      continue
    }
    try {
      await options.transport.publish(message)
      await options.repository.markPublished(
        message.id,
        options.owner,
        options.now,
      )
      summary.published += 1
    } catch (error) {
      const attemptAfterFailure = message.attempts + 1
      const deadLetter =
        attemptAfterFailure >= options.maxAttempts
      await options.repository.markFailed({
        id: message.id,
        owner: options.owner,
        nextStatus: deadLetter ? 'dead_letter' : 'retry',
        availableAt: new Date(
          options.now.getTime() +
            retryDelayMs(attemptAfterFailure),
        ),
        errorCode: safeErrorCode(error),
      })
      if (deadLetter) summary.deadLettered += 1
      else summary.retried += 1
    }
  }
  return summary
}
