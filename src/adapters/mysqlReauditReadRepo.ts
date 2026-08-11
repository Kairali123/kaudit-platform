import type { Pool, RowDataPacket } from 'mysql2/promise'
import type { ReauditCandidate } from '../reaudit/types.ts'
import { normalizeTaskIdScope } from '../reaudit/scope.ts'

interface CandidateRow extends RowDataPacket {
  call_id: string
  artifact_id: string
  source_url: string
  baseline_sha256: string | null
  claimed_duration_ms: string | number | null
  connected_duration_ms: string | number | null
  vendor_billed_minutes: string | null
}

function nullableMs(value: string | number | null): number | null {
  if (value == null) return null
  const number = Number(value)
  if (!Number.isFinite(number) || number < 0) return null
  return Math.round(number)
}

export function createMysqlReauditReadRepo(
  pool: Pool,
  options: { externalTaskIds?: readonly string[] } = {},
) {
  const taskIds = options.externalTaskIds
    ? normalizeTaskIdScope(options.externalTaskIds)
    : []
  const scopeSql = taskIds.length
    ? `AND EXISTS (
              SELECT 1
              FROM kaudit_call_external_reference scope_ref
              WHERE scope_ref.call_id = c.id
                AND scope_ref.provider_name = 'kserve'
                AND scope_ref.reference_type = 'task_id'
                AND scope_ref.external_id IN (${taskIds.map(() => '?').join(',')})
            )`
    : ''
  return {
    async listCandidates(options: {
      limit: number
      includePreviouslyClassified: boolean
    }): Promise<ReauditCandidate[]> {
      const [rows] = await pool.execute<CandidateRow[]>(
        `SELECT c.id AS call_id, ca.id AS artifact_id, ca.source_url,
                ca.sha256 AS baseline_sha256,
                MAX(CASE
                      WHEN pc.provider_sku = 'duration_with_ringing_sec'
                      THEN ROUND(pc.quantity_decimal * 1000)
                    END) AS claimed_duration_ms,
                MAX(CASE
                      WHEN pc.provider_sku = 'duration_without_ringing_sec'
                      THEN ROUND(pc.quantity_decimal * 1000)
                    END) AS connected_duration_ms,
                MAX(CASE
                      WHEN pc.provider_sku = 'vendor_asserted_billed_minutes'
                      THEN CAST(pc.minutes_decimal AS CHAR)
                    END) AS vendor_billed_minutes
         FROM kaudit_call c
         JOIN kaudit_call_artifact ca
           ON ca.call_id = c.id
          AND ca.artifact_type = 'recording'
          AND ca.is_final = 1
         LEFT JOIN kaudit_provider_cost pc ON pc.call_id = c.id
         WHERE ca.source_url IS NOT NULL
           AND ca.audio_attempt_count < 8
           AND (
             ca.audio_next_attempt_at IS NULL
             OR ca.audio_next_attempt_at <= current_timestamp(6)
           )
           AND ca.audio_processing_status NOT IN ('completed','exhausted')
           AND (? = 1 OR (
             NOT EXISTS (
               SELECT 1
               FROM kaudit_audit_run ar
               WHERE ar.call_id = c.id
                 AND ar.status = 'completed'
             )
             AND NOT (
               c.canonical_outcome_code IS NOT NULL
               AND EXISTS (
                 SELECT 1 FROM kaudit_media_analysis ma
                 WHERE ma.call_artifact_id = ca.id
                   AND ma.status = 'completed'
                   AND ma.classification_status = 'completed'
               )
               AND EXISTS (
                 SELECT 1 FROM kaudit_transcript transcript
                 WHERE transcript.call_id = c.id
                   AND transcript.call_artifact_id = ca.id
                   AND transcript.status = 'completed'
               )
             )
           ))
           ${scopeSql}
         GROUP BY c.id, ca.id, ca.source_url, ca.sha256
         ORDER BY c.billing_period_date, c.id
         LIMIT ?`,
        [
          options.includePreviouslyClassified ? 1 : 0,
          ...taskIds,
          options.limit,
        ],
      )
      return rows.map((row) => ({
        callId: row.call_id,
        artifactId: row.artifact_id,
        sourceUrl: row.source_url,
        baselineSha256: row.baseline_sha256,
        claimedDurationMs: nullableMs(row.claimed_duration_ms),
        connectedDurationMs: nullableMs(row.connected_duration_ms),
        vendorBilledMinutes: row.vendor_billed_minutes,
      }))
    },
  }
}
