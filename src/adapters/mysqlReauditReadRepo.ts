import type { Pool, RowDataPacket } from 'mysql2/promise'
import type { ReauditCandidate } from '../reaudit/types.ts'

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

export function createMysqlReauditReadRepo(pool: Pool) {
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
           AND (? = 1 OR NOT EXISTS (
             SELECT 1
             FROM kaudit_audit_run ar
             WHERE ar.call_id = c.id
               AND ar.engine_version = 'kairali-independent-reaudit/2.0.0'
               AND ar.status = 'completed'
           ))
         GROUP BY c.id, ca.id, ca.source_url, ca.sha256
         ORDER BY c.billing_period_date, c.id
         LIMIT ?`,
        [options.includePreviouslyClassified ? 1 : 0, options.limit],
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
