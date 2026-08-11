import type {
  Pool,
  ResultSetHeader,
  RowDataPacket,
} from 'mysql2/promise'
import { createMysqlOutboxWriter } from './mysqlOutbox.ts'
import type { ClaimedOutboxMessage } from '../messaging/types.ts'
import {
  canonicalJson,
  type JsonValue,
} from '../messaging/canonicalJson.ts'
import {
  buildMonthlyReportEmailPayload,
  MONTHLY_REPORT_EMAIL_EVENT,
  parseMonthlyReportEmailPayload,
  type MonthlyReportEmailPayload,
} from '../reporting/reportEmail.ts'
import type { MonthlyEmailReport } from '../reporting/monthlyEmailReport.ts'
import { LeaseLostError } from '../messaging/errors.ts'
import { sha256Hex } from '../lib/hash.ts'

interface ReportOutboxRow extends RowDataPacket {
  id: string
  message_id: string
  aggregate_type: string
  aggregate_id: string
  event_type: string
  payload_json: string | JsonValue
  payload_sha256: string
  correlation_id: string | null
  attempts: number
}

export async function enqueueMonthlyReportEmail(
  pool: Pool,
  options: {
    report: MonthlyEmailReport
    recipients: string[]
  },
): Promise<{
  outcome: 'inserted' | 'duplicate'
  messageId: string
  payload: MonthlyReportEmailPayload
}> {
  const built = buildMonthlyReportEmailPayload(
    options.report,
    options.recipients,
  )
  const connection = await pool.getConnection()
  try {
    await connection.beginTransaction()
    const [existingRows] =
      await connection.query<ReportOutboxRow[]>(
        `SELECT id, message_id, aggregate_type, aggregate_id,
                event_type, payload_json, payload_sha256,
                correlation_id, attempts
         FROM kaudit_outbox_message
         WHERE message_id = ?
         LIMIT 1
         FOR UPDATE`,
        [built.messageId],
      )
    const existing = existingRows[0]
    if (existing) {
      const payloadJson =
        typeof existing.payload_json === 'string'
          ? existing.payload_json
          : canonicalJson(existing.payload_json)
      if (sha256Hex(payloadJson) !== existing.payload_sha256) {
        throw new Error(
          'Existing report email outbox payload failed integrity verification',
        )
      }
      const payload = parseMonthlyReportEmailPayload({
        id: existing.id,
        messageId: existing.message_id,
        aggregateType: existing.aggregate_type,
        aggregateId: existing.aggregate_id,
        eventType: existing.event_type,
        payloadJson,
        payloadSha256: existing.payload_sha256,
        correlationId: existing.correlation_id,
        attempts: Number(existing.attempts),
      })
      if (
        payload.month !== built.payload.month ||
        payload.reportSha256 !== built.payload.reportSha256 ||
        payload.recipientHash !== built.payload.recipientHash
      ) {
        throw new Error(
          'Existing report email message identity does not match its payload',
        )
      }
      await connection.commit()
      return {
        outcome: 'duplicate',
        messageId: built.messageId,
        // Preserve the original generation timestamp for a retry. A new
        // worker invocation must not mutate an already queued message.
        payload,
      }
    }
    const writer = createMysqlOutboxWriter(connection)
    const outcome = await writer.enqueue({
      messageId: built.messageId,
      aggregateType: 'billing_cycle',
      aggregateId: options.report.period.month,
      eventType: MONTHLY_REPORT_EMAIL_EVENT,
      correlationId: `report:${options.report.period.month}`,
      payload: built.payload as unknown as JsonValue,
    })
    await connection.commit()
    return { outcome, ...built }
  } catch (error) {
    await connection.rollback()
    throw error
  } finally {
    connection.release()
  }
}

export async function claimMonthlyReportEmails(
  pool: Pool,
  options: {
    owner: string
    limit: number
    now: Date
    leaseUntil: Date
  },
): Promise<ClaimedOutboxMessage[]> {
  if (
    !Number.isInteger(options.limit) ||
    options.limit < 1 ||
    options.limit > 100
  ) {
    throw new RangeError('Report email claim limit must be 1..100')
  }
  const connection = await pool.getConnection()
  try {
    await connection.beginTransaction()
    const [rows] = await connection.query<ReportOutboxRow[]>(
      `SELECT id, message_id, aggregate_type, aggregate_id,
              event_type, payload_json, payload_sha256,
              correlation_id, attempts
       FROM kaudit_outbox_message
       WHERE event_type = ?
         AND status IN ('pending','retry')
         AND available_at <= ?
         AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
         AND message_id IS NOT NULL
         AND payload_sha256 IS NOT NULL
       ORDER BY available_at, created_at, id
       LIMIT ${options.limit}
       FOR UPDATE SKIP LOCKED`,
      [MONTHLY_REPORT_EMAIL_EVENT, options.now, options.now],
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
    return rows.map((row) => ({
      id: row.id,
      messageId: row.message_id,
      aggregateType: row.aggregate_type,
      aggregateId: row.aggregate_id,
      eventType: row.event_type,
      payloadJson:
        typeof row.payload_json === 'string'
          ? row.payload_json
          : canonicalJson(row.payload_json),
      payloadSha256: row.payload_sha256,
      correlationId: row.correlation_id,
      attempts: Number(row.attempts),
    }))
  } catch (error) {
    await connection.rollback()
    throw error
  } finally {
    connection.release()
  }
}

export async function markMonthlyReportEmailPublished(
  pool: Pool,
  options: {
    id: string
    owner: string
    at: Date
  },
): Promise<void> {
  const [result] = await pool.execute<ResultSetHeader>(
    `UPDATE kaudit_outbox_message
     SET status = 'published', published_at = ?,
         lease_owner = NULL, lease_expires_at = NULL,
         last_error_code = NULL
     WHERE id = ? AND status = 'publishing' AND lease_owner = ?`,
    [options.at, options.id, options.owner],
  )
  if (result.affectedRows !== 1) {
    throw new LeaseLostError(
      'Report email lease no longer belongs to this worker',
    )
  }
}

export async function markMonthlyReportEmailFailed(
  pool: Pool,
  options: {
    id: string
    owner: string
    at: Date
    availableAt: Date
    deadLetter: boolean
    errorCode: string
  },
): Promise<void> {
  const [result] = await pool.execute<ResultSetHeader>(
    `UPDATE kaudit_outbox_message
     SET status = ?, attempts = attempts + 1,
         available_at = ?, lease_owner = NULL,
         lease_expires_at = NULL, last_error_code = ?
     WHERE id = ? AND status = 'publishing' AND lease_owner = ?`,
    [
      options.deadLetter ? 'dead_letter' : 'retry',
      options.availableAt,
      options.errorCode,
      options.id,
      options.owner,
    ],
  )
  if (result.affectedRows !== 1) {
    throw new LeaseLostError(
      'Report email failure lease no longer belongs to this worker',
    )
  }
}

export async function requeueMonthlyReportEmailDeadLetter(
  pool: Pool,
  month: string,
): Promise<boolean> {
  if (!/^\d{4}-\d{2}$/.test(month)) {
    throw new TypeError('Dead-letter replay requires YYYY-MM')
  }
  const [result] = await pool.execute<ResultSetHeader>(
    `UPDATE kaudit_outbox_message
     SET status = 'retry', attempts = 0, available_at = NOW(6),
         lease_owner = NULL, lease_expires_at = NULL,
         last_error_code = NULL
     WHERE event_type = ? AND aggregate_id = ?
       AND status = 'dead_letter'
     ORDER BY created_at DESC, id DESC
     LIMIT 1`,
    [MONTHLY_REPORT_EMAIL_EVENT, month],
  )
  return result.affectedRows === 1
}

export async function collectReportEmailDeliveryStatus(
  pool: Pool,
  month: string,
): Promise<{
  configured: boolean
  status: string
  attempts: number
  sentAt: string | null
  lastErrorCode: string | null
}> {
  try {
    const [rows] = await pool.execute<RowDataPacket[]>(
      `SELECT status, attempts, published_at, last_error_code
       FROM kaudit_outbox_message
       WHERE event_type = ? AND aggregate_id = ?
       ORDER BY created_at DESC, id DESC LIMIT 1`,
      [MONTHLY_REPORT_EMAIL_EVENT, month],
    )
    const row = rows[0]
    return {
      configured: true,
      status: row?.status ?? 'not_queued',
      attempts: Number(row?.attempts || 0),
      sentAt:
        row?.published_at == null
          ? null
          : new Date(row.published_at).toISOString(),
      lastErrorCode: row?.last_error_code ?? null,
    }
  } catch {
    return {
      configured: false,
      status: 'unavailable',
      attempts: 0,
      sentAt: null,
      lastErrorCode: null,
    }
  }
}
