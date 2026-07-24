import { randomUUID } from 'node:crypto'
import type {
  Pool,
  ResultSetHeader,
  RowDataPacket,
} from 'mysql2/promise'
import { canonicalJson } from '../messaging/canonicalJson.ts'
import { LeaseLostError } from '../messaging/errors.ts'
import { classifyInboxAttempt } from '../messaging/inboxPolicy.ts'
import type {
  InboxBeginResult,
  InboxRepository,
} from '../messaging/types.ts'

interface InboxRow extends RowDataPacket {
  payload_sha256: string | null
  status: string
  lease_owner: string | null
  lease_expires_at: Date | null
}

function isDuplicateKey(error: unknown): boolean {
  return (
    error != null &&
    typeof error === 'object' &&
    'code' in error &&
    error.code === 'ER_DUP_ENTRY'
  )
}

export function createMysqlInboxRepository(
  pool: Pool,
): InboxRepository {
  return {
    async begin(options): Promise<InboxBeginResult> {
      const connection = await pool.getConnection()
      try {
        await connection.beginTransaction()
        let inserted = false
        try {
          await connection.execute<ResultSetHeader>(
            `INSERT INTO kaudit_inbox_message
               (id, consumer, message_id, payload_sha256, status,
                lease_owner, lease_expires_at)
             VALUES (?, ?, ?, ?, 'processing', ?, ?)`,
            [
              randomUUID(),
              options.consumer,
              options.messageId,
              options.payloadSha256,
              options.owner,
              options.leaseUntil,
            ],
          )
          inserted = true
        } catch (error) {
          if (!isDuplicateKey(error)) throw error
        }
        if (inserted) {
          await connection.commit()
          return { outcome: 'acquired' }
        }
        const [rows] = await connection.execute<InboxRow[]>(
          `SELECT payload_sha256, status, lease_owner, lease_expires_at
           FROM kaudit_inbox_message
           WHERE consumer = ? AND message_id = ?
           FOR UPDATE`,
          [options.consumer, options.messageId],
        )
        const existing = rows[0]
        const decision = classifyInboxAttempt({
          existing: existing
            ? {
                payloadSha256: existing.payload_sha256,
                status: existing.status,
                leaseOwner: existing.lease_owner,
                leaseExpiresAt: existing.lease_expires_at,
              }
            : null,
          incomingPayloadSha256: options.payloadSha256,
          owner: options.owner,
          now: options.now,
        })
        if (decision.outcome !== 'acquired') {
          await connection.commit()
          return decision
        }
        await connection.execute(
          `UPDATE kaudit_inbox_message
           SET status = 'processing', lease_owner = ?,
               lease_expires_at = ?, error_code = NULL
           WHERE consumer = ? AND message_id = ?`,
          [
            options.owner,
            options.leaseUntil,
            options.consumer,
            options.messageId,
          ],
        )
        await connection.commit()
        return { outcome: 'acquired' }
      } catch (error) {
        await connection.rollback()
        throw error
      } finally {
        connection.release()
      }
    },

    async complete(options) {
      const [result] = await pool.execute<ResultSetHeader>(
        `UPDATE kaudit_inbox_message
         SET status = 'completed', result_json = ?,
             processed_at = ?, lease_owner = NULL,
             lease_expires_at = NULL, error_code = NULL
         WHERE consumer = ? AND message_id = ?
           AND status = 'processing' AND lease_owner = ?`,
        [
          options.result == null
            ? null
            : canonicalJson(options.result),
          options.at,
          options.consumer,
          options.messageId,
          options.owner,
        ],
      )
      if (result.affectedRows !== 1) {
        throw new LeaseLostError(
          'Inbox processing lease no longer belongs to this worker',
        )
      }
    },

    async fail(options) {
      const [result] = await pool.execute<ResultSetHeader>(
        `UPDATE kaudit_inbox_message
         SET status = 'failed', error_code = ?,
             lease_owner = NULL, lease_expires_at = NULL
         WHERE consumer = ? AND message_id = ?
           AND status = 'processing' AND lease_owner = ?`,
        [
          options.errorCode,
          options.consumer,
          options.messageId,
          options.owner,
        ],
      )
      if (result.affectedRows !== 1) {
        throw new LeaseLostError(
          'Inbox processing lease no longer belongs to this worker',
        )
      }
    },
  }
}
