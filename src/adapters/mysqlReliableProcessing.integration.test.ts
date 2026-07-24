import { test } from 'node:test'
import assert from 'node:assert/strict'
import mysql from 'mysql2/promise'
import { createMysqlInboxRepository } from './mysqlInbox.ts'
import { createMysqlIdempotencyRepository } from './mysqlIdempotency.ts'
import {
  createMysqlOutboxRepository,
  createMysqlOutboxWriter,
} from './mysqlOutbox.ts'
import { MessageIntegrityError } from '../messaging/errors.ts'
import { publishOutboxBatch } from '../messaging/outboxPublisher.ts'

const socketPath = process.env.KAUDIT_TEST_MYSQL_SOCKET
const safeSocket =
  socketPath?.startsWith('/tmp/kaudit-') &&
  socketPath.endsWith('/mysql.sock')
    ? socketPath
    : null

test(
  'MySQL reliability adapters enforce replay, leases, hashes, and publication',
  { skip: safeSocket == null },
  async () => {
    const pool = mysql.createPool({
      socketPath: safeSocket as string,
      user: 'root',
      database: 'kaudit_verify',
      connectionLimit: 4,
    })
    try {
      await pool.query('DELETE FROM kaudit_outbox_message')
      await pool.query('DELETE FROM kaudit_inbox_message')
      await pool.query('DELETE FROM kaudit_idempotency_record')

      const connection = await pool.getConnection()
      try {
        await connection.beginTransaction()
        const writer = createMysqlOutboxWriter(connection)
        const event = {
          messageId: 'synthetic-message-1',
          aggregateType: 'call',
          aggregateId: 'synthetic-call-1',
          eventType: 'call.received',
          payload: { callId: 'synthetic-call-1' },
          correlationId: 'synthetic-correlation-1',
        } as const
        assert.equal(await writer.enqueue(event), 'inserted')
        assert.equal(await writer.enqueue(event), 'duplicate')
        await assert.rejects(
          () =>
            writer.enqueue({
              ...event,
              payload: { callId: 'changed-call' },
            }),
          MessageIntegrityError,
        )
        await connection.commit()
      } catch (error) {
        await connection.rollback()
        throw error
      } finally {
        connection.release()
      }

      const published: string[] = []
      const now = new Date()
      const summary = await publishOutboxBatch({
        repository: createMysqlOutboxRepository(pool),
        transport: {
          async publish(message) {
            published.push(message.messageId)
          },
        },
        owner: 'publisher-1',
        limit: 10,
        now,
        leaseMs: 30_000,
        maxAttempts: 3,
      })
      assert.deepEqual(published, ['synthetic-message-1'])
      assert.equal(summary.published, 1)

      const inbox = createMysqlInboxRepository(pool)
      const hash = 'a'.repeat(64)
      assert.equal(
        (
          await inbox.begin({
            consumer: 'normalizer',
            messageId: 'synthetic-message-1',
            payloadSha256: hash,
            owner: 'worker-1',
            now,
            leaseUntil: new Date(now.getTime() + 30_000),
          })
        ).outcome,
        'acquired',
      )
      assert.equal(
        (
          await inbox.begin({
            consumer: 'normalizer',
            messageId: 'synthetic-message-1',
            payloadSha256: hash,
            owner: 'worker-2',
            now,
            leaseUntil: new Date(now.getTime() + 30_000),
          })
        ).outcome,
        'in_progress',
      )
      await inbox.complete({
        consumer: 'normalizer',
        messageId: 'synthetic-message-1',
        owner: 'worker-1',
        result: { normalized: true },
        at: now,
      })
      assert.equal(
        (
          await inbox.begin({
            consumer: 'normalizer',
            messageId: 'synthetic-message-1',
            payloadSha256: hash,
            owner: 'worker-2',
            now,
            leaseUntil: new Date(now.getTime() + 30_000),
          })
        ).outcome,
        'duplicate_completed',
      )
      assert.equal(
        (
          await inbox.begin({
            consumer: 'normalizer',
            messageId: 'synthetic-message-1',
            payloadSha256: 'b'.repeat(64),
            owner: 'worker-2',
            now,
            leaseUntil: new Date(now.getTime() + 30_000),
          })
        ).outcome,
        'integrity_conflict',
      )

      const idempotency =
        createMysqlIdempotencyRepository(pool)
      const requestHash = 'c'.repeat(64)
      const begin = {
        route: '/api/v1/reconciliations',
        key: 'synthetic-idempotency-1',
        requestHash,
        expiresAt: new Date(now.getTime() + 86_400_000),
        lockUntil: new Date(now.getTime() + 30_000),
        now,
      }
      assert.equal(
        (
          await idempotency.begin({
            ...begin,
            owner: 'request-1',
          })
        ).outcome,
        'acquired',
      )
      assert.equal(
        (
          await idempotency.begin({
            ...begin,
            owner: 'request-2',
          })
        ).outcome,
        'in_progress',
      )
      await idempotency.complete({
        route: begin.route,
        key: begin.key,
        owner: 'request-1',
        responseReference: 'synthetic-response-1',
        httpStatus: 201,
        responseHash: 'd'.repeat(64),
      })
      assert.equal(
        (
          await idempotency.begin({
            ...begin,
            owner: 'request-2',
          })
        ).outcome,
        'replay',
      )
      assert.equal(
        (
          await idempotency.begin({
            ...begin,
            requestHash: 'e'.repeat(64),
            owner: 'request-2',
          })
        ).outcome,
        'conflict',
      )
    } finally {
      await pool.end()
    }
  },
)
