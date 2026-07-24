import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sha256Hex } from '../lib/hash.ts'
import {
  publishOutboxBatch,
  retryDelayMs,
} from './outboxPublisher.ts'
import type {
  ClaimedOutboxMessage,
  OutboxRepository,
} from './types.ts'

function message(
  overrides: Partial<ClaimedOutboxMessage> = {},
): ClaimedOutboxMessage {
  const payloadJson = '{"callId":"synthetic-call-1"}'
  return {
    id: 'outbox-1',
    messageId: 'message-1',
    aggregateType: 'call',
    aggregateId: 'synthetic-call-1',
    eventType: 'call.received',
    payloadJson,
    payloadSha256: sha256Hex(payloadJson),
    correlationId: 'corr-1',
    attempts: 0,
    ...overrides,
  }
}

function repository(
  messages: ClaimedOutboxMessage[],
  events: string[],
): OutboxRepository {
  return {
    async claim() {
      return messages
    },
    async markPublished(id) {
      events.push(`published:${id}`)
    },
    async markFailed(options) {
      events.push(
        `${options.nextStatus}:${options.id}:${options.errorCode}`,
      )
    },
  }
}

test('publishes a claimed message and marks it only after transport success', async () => {
  const events: string[] = []
  const summary = await publishOutboxBatch({
    repository: repository([message()], events),
    transport: {
      async publish(item) {
        events.push(`transport:${item.id}`)
      },
    },
    owner: 'worker-1',
    limit: 10,
    now: new Date('2026-07-24T10:00:00Z'),
    leaseMs: 30_000,
    maxAttempts: 5,
  })
  assert.deepEqual(events, [
    'transport:outbox-1',
    'published:outbox-1',
  ])
  assert.equal(summary.published, 1)
})

test('hash mismatch never reaches the transport and enters visible DLQ', async () => {
  const events: string[] = []
  let transported = false
  const summary = await publishOutboxBatch({
    repository: repository(
      [message({ payloadSha256: '0'.repeat(64) })],
      events,
    ),
    transport: {
      async publish() {
        transported = true
      },
    },
    owner: 'worker-1',
    limit: 10,
    now: new Date('2026-07-24T10:00:00Z'),
    leaseMs: 30_000,
    maxAttempts: 5,
  })
  assert.equal(transported, false)
  assert.equal(summary.integrityRejected, 1)
  assert.deepEqual(events, [
    'dead_letter:outbox-1:PAYLOAD_HASH_MISMATCH',
  ])
})

test('transport failure retries, then dead-letters at the configured bound', async () => {
  const firstEvents: string[] = []
  const failedTransport = {
    async publish() {
      throw Object.assign(new Error('synthetic'), {
        code: 'PROVIDER_TIMEOUT',
      })
    },
  }
  const first = await publishOutboxBatch({
    repository: repository(
      [message({ attempts: 0 })],
      firstEvents,
    ),
    transport: failedTransport,
    owner: 'worker-1',
    limit: 10,
    now: new Date('2026-07-24T10:00:00Z'),
    leaseMs: 30_000,
    maxAttempts: 2,
  })
  assert.equal(first.retried, 1)
  assert.deepEqual(firstEvents, [
    'retry:outbox-1:PROVIDER_TIMEOUT',
  ])

  const finalEvents: string[] = []
  const final = await publishOutboxBatch({
    repository: repository(
      [message({ attempts: 1 })],
      finalEvents,
    ),
    transport: failedTransport,
    owner: 'worker-1',
    limit: 10,
    now: new Date('2026-07-24T10:00:00Z'),
    leaseMs: 30_000,
    maxAttempts: 2,
  })
  assert.equal(final.deadLettered, 1)
  assert.deepEqual(finalEvents, [
    'dead_letter:outbox-1:PROVIDER_TIMEOUT',
  ])
})

test('retry delay is bounded exponential', () => {
  assert.equal(retryDelayMs(0), 1_000)
  assert.equal(retryDelayMs(3), 8_000)
  assert.equal(retryDelayMs(99), 15 * 60_000)
})
