import { randomUUID } from 'node:crypto'
import type {
  Pool,
  ResultSetHeader,
  RowDataPacket,
} from 'mysql2/promise'
import { LeaseLostError } from '../messaging/errors.ts'
import type {
  IdempotencyBeginResult,
  IdempotencyRepository,
} from '../idempotency/types.ts'
import { classifyIdempotencyAttempt } from '../idempotency/policy.ts'

interface IdempotencyRow extends RowDataPacket {
  request_hash: string
  status: string
  response_reference: string | null
  http_status: number | null
  response_hash: string | null
  lock_owner: string | null
  locked_until: Date | null
}

function isDuplicateKey(error: unknown): boolean {
  return (
    error != null &&
    typeof error === 'object' &&
    'code' in error &&
    error.code === 'ER_DUP_ENTRY'
  )
}

export function createMysqlIdempotencyRepository(
  pool: Pool,
): IdempotencyRepository {
  return {
    async begin(options): Promise<IdempotencyBeginResult> {
      const connection = await pool.getConnection()
      try {
        await connection.beginTransaction()
        let inserted = false
        try {
          await connection.execute<ResultSetHeader>(
            `INSERT INTO kaudit_idempotency_record
               (id, route, idem_key, request_hash, status,
                lock_owner, locked_until, expires_at)
             VALUES (?, ?, ?, ?, 'processing', ?, ?, ?)`,
            [
              randomUUID(),
              options.route,
              options.key,
              options.requestHash,
              options.owner,
              options.lockUntil,
              options.expiresAt,
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
        const [rows] =
          await connection.execute<IdempotencyRow[]>(
            `SELECT request_hash, status, response_reference,
                    http_status, response_hash, lock_owner, locked_until
             FROM kaudit_idempotency_record
             WHERE route = ? AND idem_key = ?
             FOR UPDATE`,
            [options.route, options.key],
          )
        const existing = rows[0]
        const decision = classifyIdempotencyAttempt({
          existing: existing
            ? {
                requestHash: existing.request_hash,
                status: existing.status,
                responseReference:
                  existing.response_reference,
                httpStatus:
                  existing.http_status == null
                    ? null
                    : Number(existing.http_status),
                responseHash: existing.response_hash,
                lockOwner: existing.lock_owner,
                lockedUntil: existing.locked_until,
              }
            : null,
          requestHash: options.requestHash,
          owner: options.owner,
          now: options.now,
        })
        if (decision.outcome !== 'acquired') {
          await connection.commit()
          return decision
        }
        await connection.execute(
          `UPDATE kaudit_idempotency_record
           SET status = 'processing', lock_owner = ?,
               locked_until = ?, expires_at = ?
           WHERE route = ? AND idem_key = ?`,
          [
            options.owner,
            options.lockUntil,
            options.expiresAt,
            options.route,
            options.key,
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
        `UPDATE kaudit_idempotency_record
         SET status = 'completed', response_reference = ?,
             http_status = ?, response_hash = ?,
             lock_owner = NULL, locked_until = NULL
         WHERE route = ? AND idem_key = ?
           AND status = 'processing' AND lock_owner = ?`,
        [
          options.responseReference,
          options.httpStatus,
          options.responseHash,
          options.route,
          options.key,
          options.owner,
        ],
      )
      if (result.affectedRows !== 1) {
        throw new LeaseLostError(
          'Idempotency lease no longer belongs to this request',
        )
      }
    },

    async fail(options) {
      const [result] = await pool.execute<ResultSetHeader>(
        `UPDATE kaudit_idempotency_record
         SET status = 'failed', lock_owner = NULL, locked_until = NULL
         WHERE route = ? AND idem_key = ?
           AND status = 'processing' AND lock_owner = ?`,
        [options.route, options.key, options.owner],
      )
      if (result.affectedRows !== 1) {
        throw new LeaseLostError(
          'Idempotency lease no longer belongs to this request',
        )
      }
    },
  }
}
