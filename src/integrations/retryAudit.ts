import type { Pool, PoolConnection, RowDataPacket } from 'mysql2/promise'
import { randomUUID } from 'node:crypto'
import { canonicalJsonSha256, type JsonValue } from '../messaging/canonicalJson.ts'

/**
 * Operator-requested retry of an audit that never happened.
 *
 * A call whose recording was attached but never downloaded, whose audit gave
 * up (`exhausted`), and which month close therefore settled at KServe's
 * unverified claim, gets one more real audit. The reset is exactly what an
 * administrator otherwise did by hand: the recording goes back to pending and
 * the spend guard, which had closed after the failed paid attempt, is
 * reopened. The audit and billing that follow are the ordinary ones; a
 * successful bill supersedes the unverified one, which stays in history.
 *
 * Anything else -- an audited call, a recording that was fetched, a call
 * billed on independent evidence -- is refused and left untouched.
 */
export const RETRY_AUDIT_ELIGIBLE_BASES = ['accepted_as_billed_unverified'] as const

export type RetryAuditRefusal =
  | 'RETRY_NO_RECORDING'
  | 'RETRY_AUDIT_ALREADY_COMPLETED'
  | 'RETRY_RECORDING_ALREADY_FETCHED'
  | 'RETRY_CALL_ALREADY_VERIFIED'

interface RetryStateRow extends RowDataPacket {
  artifact_id: string | null
  has_source_url: number | string
  has_sha256: number | string
  audio_processing_status: string | null
  live_basis: string | null
  audit_completed: number | string
}

export async function prepareRetryAudit(
  pool: Pool,
  calls: ReadonlyArray<{ taskId: string; callId: string }>,
  correlationId: string | null,
): Promise<{ eligible: string[]; refused: Map<string, RetryAuditRefusal> }> {
  const eligible: string[] = []
  const refused = new Map<string, RetryAuditRefusal>()
  for (const call of calls) {
    const connection = await pool.getConnection()
    try {
      await connection.beginTransaction()
      const outcome = await prepareOne(connection, call.callId, correlationId)
      await connection.commit()
      if (outcome === 'eligible') eligible.push(call.taskId)
      else refused.set(call.taskId, outcome)
    } catch (error) {
      await connection.rollback().catch(() => undefined)
      throw error
    } finally {
      connection.release()
    }
  }
  return { eligible, refused }
}

async function prepareOne(
  connection: PoolConnection,
  callId: string,
  correlationId: string | null,
): Promise<'eligible' | RetryAuditRefusal> {
  const [rows] = await connection.execute<RetryStateRow[]>(
    `SELECT ca.id AS artifact_id,
            ca.source_url IS NOT NULL AS has_source_url,
            ca.sha256 IS NOT NULL AS has_sha256,
            ca.audio_processing_status,
            (SELECT calc.calculation_basis
               FROM kaudit_billing_calculation calc
              WHERE calc.call_id = ca.call_id AND calc.status = 'final'
                AND NOT EXISTS (SELECT 1 FROM kaudit_billing_calculation newer
                                WHERE newer.supersedes_calculation_id = calc.id)
              ORDER BY calc.calculated_at DESC, calc.id DESC
              LIMIT 1) AS live_basis,
            EXISTS (SELECT 1 FROM kaudit_audit_run run
                     WHERE run.call_id = ca.call_id AND run.status = 'completed')
              AS audit_completed
       FROM kaudit_call_artifact ca
      WHERE ca.call_id = ? AND ca.artifact_type = 'recording' AND ca.is_final = 1
      LIMIT 1
      FOR UPDATE`,
    [callId],
  )
  const row = rows[0]
  if (!row?.artifact_id || Number(row.has_source_url) !== 1) return 'RETRY_NO_RECORDING'
  if (Number(row.audit_completed) === 1) return 'RETRY_AUDIT_ALREADY_COMPLETED'
  if (Number(row.has_sha256) === 1) return 'RETRY_RECORDING_ALREADY_FETCHED'
  if (
    row.live_basis != null &&
    !(RETRY_AUDIT_ELIGIBLE_BASES as readonly string[]).includes(row.live_basis)
  ) return 'RETRY_CALL_ALREADY_VERIFIED'
  // Pending or failed-but-retrying already: nothing to reset (a replay of
  // this batch after the reset lands here).
  if (row.audio_processing_status !== 'exhausted') return 'eligible'

  await connection.execute(
    `UPDATE kaudit_call_artifact
        SET audio_processing_status = 'pending', audio_attempt_count = 0,
            audio_next_attempt_at = NULL, audio_last_error = NULL
      WHERE id = ? AND audio_processing_status = 'exhausted' AND sha256 IS NULL`,
    [row.artifact_id],
  )
  // A closed lease means the earlier paid attempt ended in failure; an active
  // one (work in flight) is never touched.
  await connection.execute(
    `UPDATE kaudit_billing_spend_lease
        SET status = 'released', staged_result_json = NULL, staged_at = NULL
      WHERE call_id = ? AND artifact_id = ? AND manual_item_id IS NULL
        AND status IN ('completed', 'expired')`,
    [callId, row.artifact_id],
  )
  await connection.execute(
    `INSERT INTO kaudit_audit_log
       (id, actor_email, action, resource_type, resource_id,
        before_hash, after_hash, client, correlation_id)
     VALUES (?, NULL, 'audit_retry_reset', 'call_artifact', ?, ?, ?,
             'kaudit-reconciliation', ?)`,
    [
      randomUUID(),
      row.artifact_id,
      canonicalJsonSha256({
        audioProcessingStatus: row.audio_processing_status,
        liveBasis: row.live_basis,
      } as unknown as JsonValue),
      canonicalJsonSha256({ audioProcessingStatus: 'pending' } as unknown as JsonValue),
      correlationId ?? 'retry-audit',
    ],
  )
  return 'eligible'
}
