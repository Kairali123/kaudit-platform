import { randomUUID } from 'node:crypto'
import type {
  Pool,
  PoolConnection,
  ResultSetHeader,
  RowDataPacket,
} from 'mysql2/promise'
import { canonicalJson } from '../messaging/canonicalJson.ts'
import { MessageIntegrityError, LeaseLostError } from '../messaging/errors.ts'
import type {
  ClaimedOutboxMessage,
  OutboxRepository,
  OutboxWriter,
} from '../messaging/types.ts'
import { sha256Hex } from '../lib/hash.ts'

interface ExistingRow extends RowDataPacket {
  aggregate_type: string
  aggregate_id: string
  event_type: string
  payload_sha256: string
}

interface OutboxRow extends RowDataPacket {
  id: string
  message_id: string
  aggregate_type: string
  aggregate_id: string
  event_type: string
  payload_json: string
  payload_sha256: string
  correlation_id: string | null
  attempts: number
}

function isDuplicateKey(error: unknown): boolean {
  return (
    error != null &&
    typeof error === 'object' &&
    'code' in error &&
    error.code === 'ER_DUP_ENTRY'
  )
}

export function createMysqlOutboxWriter(
  connection: PoolConnection,
): OutboxWriter {
  return {
    async enqueue(message) {
      const payloadJson = canonicalJson(message.payload)
      const payloadSha256 = sha256Hex(payloadJson)
      try {
        await connection.execute<ResultSetHeader>(
          `INSERT INTO kaudit_outbox_message
             (id, message_id, aggregate_type, aggregate_id, event_type,
              payload_json, payload_sha256, correlation_id, attempts, status,
              available_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 'pending', current_timestamp(6))`,
          [
            randomUUID(),
            message.messageId,
            message.aggregateType,
            message.aggregateId,
            message.eventType,
            payloadJson,
            payloadSha256,
            message.correlationId,
          ],
        )
        return 'inserted'
      } catch (error) {
        if (!isDuplicateKey(error)) throw error
      }
      const [rows] = await connection.execute<ExistingRow[]>(
        `SELECT aggregate_type, aggregate_id, event_type, payload_sha256
         FROM kaudit_outbox_message
         WHERE message_id = ? FOR UPDATE`,
        [message.messageId],
      )
      const existing = rows[0]
      const same =
        existing?.aggregate_type === message.aggregateType &&
        existing.aggregate_id === message.aggregateId &&
        existing.event_type === message.eventType &&
        existing.payload_sha256 === payloadSha256
      if (!same) {
        throw new MessageIntegrityError(
          'The same outbox message ID was reused with different content',
        )
      }
      return 'duplicate'
    },
  }
}

function assertLimit(limit: number): number {
  if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) {
    throw new RangeError('Outbox claim limit must be from 1 to 1000')
  }
  return limit
}

function mapOutbox(row: OutboxRow): ClaimedOutboxMessage {
  return {
    id: row.id,
    messageId: row.message_id,
    aggregateType: row.aggregate_type,
    aggregateId: row.aggregate_id,
    eventType: row.event_type,
    payloadJson: row.payload_json,
    payloadSha256: row.payload_sha256,
    correlationId: row.correlation_id,
    attempts: Number(row.attempts),
  }
}

export function createMysqlOutboxRepository(
  pool: Pool,
): OutboxRepository {
  return {
    async claim(options) {
      const limit = assertLimit(options.limit)
      const connection = await pool.getConnection()
      try {
        await connection.beginTransaction()
        const [rows] = await connection.query<OutboxRow[]>(
          `SELECT id, message_id, aggregate_type, aggregate_id, event_type,
                  payload_json, payload_sha256, correlation_id, attempts
           FROM kaudit_outbox_message
           WHERE status IN ('pending','retry')
             AND available_at <= ?
             AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
             AND message_id IS NOT NULL
             AND payload_sha256 IS NOT NULL
           ORDER BY available_at, created_at, id
           LIMIT ${limit}
           FOR UPDATE SKIP LOCKED`,
          [options.now, options.now],
        )
        if (rows.length) {
          const placeholders = rows.map(() => '?').join(',')
          await connection.query(
            `UPDATE kaudit_outbox_message
             SET status = 'publishing', lease_owner = ?,
                 lease_expires_at = ?, last_error_code = NULL
             WHERE id IN (${placeholders})`,
            [
              options.owner,
              options.leaseUntil,
              ...rows.map((row) => row.id),
            ],
          )
        }
        await connection.commit()
        return rows.map(mapOutbox)
      } catch (error) {
        await connection.rollback()
        throw error
      } finally {
        connection.release()
      }
    },

    async markPublished(id, owner, at) {
      const [result] = await pool.execute<ResultSetHeader>(
        `UPDATE kaudit_outbox_message
         SET status = 'published', published_at = ?,
             lease_owner = NULL, lease_expires_at = NULL,
             last_error_code = NULL
         WHERE id = ? AND status = 'publishing' AND lease_owner = ?`,
        [at, id, owner],
      )
      if (result.affectedRows !== 1) {
        throw new LeaseLostError(
          'Outbox publication lease no longer belongs to this worker',
        )
      }
    },

    async markFailed(options) {
      const [result] = await pool.execute<ResultSetHeader>(
        `UPDATE kaudit_outbox_message
         SET status = ?, attempts = attempts + 1,
             available_at = ?, lease_owner = NULL,
             lease_expires_at = NULL, last_error_code = ?
         WHERE id = ? AND status = 'publishing' AND lease_owner = ?`,
        [
          options.nextStatus,
          options.availableAt,
          options.errorCode,
          options.id,
          options.owner,
        ],
      )
      if (result.affectedRows !== 1) {
        throw new LeaseLostError(
          'Outbox failure lease no longer belongs to this worker',
        )
      }
    },
  }
}
