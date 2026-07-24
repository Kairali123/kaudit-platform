import type { Pool } from 'mysql2/promise'
import type { BackfillCandidate, BackfillRepo } from '../backfill/ports.ts'

// Lists ALL recording call_artifact rows still needing `source_url` and writes the
// resolved S3 object URL onto the call_artifact.
//
// Deliberately NOT filtered by fetch_status or evidence_object linkage: every recording
// is re-tested fresh from the raw export (the old 'unavailable'/'pending' flags are not
// trusted — the raw file's recordingUrl is the accurate test). Target set ≈ 43,245.
export function createMysqlBackfillRepo(pool: Pool): BackfillRepo {
  return {
    async listCandidates(limit: number): Promise<BackfillCandidate[]> {
      const [rows] = await pool.query(
        `SELECT ca.id         AS call_artifact_id,
                c.id          AS call_id,
                c.logical_call_key,
                ca.source_url AS existing_source_url
           FROM kaudit_call_artifact ca
           JOIN kaudit_call c ON c.id = ca.call_id
          WHERE ca.artifact_type = 'recording'
            AND ca.source_url IS NULL
          ORDER BY c.source_started_at ASC
          LIMIT ?`,
        [limit],
      )
      return (rows as any[]).map((r) => ({
        callArtifactId: r.call_artifact_id,
        callId: r.call_id,
        logicalCallKey: r.logical_call_key,
        existingSourceUrl: r.existing_source_url,
      }))
    },
    async setSourceUrl(callArtifactId, s3Url): Promise<void> {
      await pool.query(`UPDATE kaudit_call_artifact SET source_url = ? WHERE id = ?`, [
        s3Url,
        callArtifactId,
      ])
    },
    async recordIssue(callArtifactId, code, detail): Promise<void> {
      await pool.query(
        `INSERT INTO kaudit_audit_log
           (id, actor_email, action, resource_type, resource_id, correlation_id, occurred_at)
         VALUES (UUID(), 'w3-backfill', ?, 'call_artifact', ?, ?, NOW(6))`,
        [`backfill_${code}`, callArtifactId, detail.slice(0, 120)],
      )
    },
  }
}
