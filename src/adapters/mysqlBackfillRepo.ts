import type { Pool } from 'mysql2/promise'
import type { BackfillCandidate, BackfillRepo } from '../backfill/ports.ts'

// Lists recording rows needing `source_url` and writes the resolved S3 object URL.
//
// SCHEMA/LINKAGE NOTE: the candidate query mirrors the KCRM linkage
// (call → recording call_artifact → evidence_object; call → source_envelope →
// raw evidence_object). The exact join — especially whether every recording already
// has a call_artifact + evidence_object row in the URL-reference model, and the raw
// export key — MUST be confirmed against the live schema during a dry-run before EXECUTE.
export function createMysqlBackfillRepo(pool: Pool): BackfillRepo {
  return {
    async listCandidates(limit: number): Promise<BackfillCandidate[]> {
      const [rows] = await pool.query(
        `SELECT rec.id            AS evidence_object_id,
                c.id              AS call_id,
                c.logical_call_key,
                raw.object_bucket AS raw_bucket,
                raw.object_key    AS raw_key,
                rec.source_url    AS existing_source_url
           FROM kaudit_call c
           JOIN kaudit_call_artifact ca
             ON ca.call_id = c.id AND ca.artifact_type = 'recording'
           JOIN kaudit_evidence_object rec
             ON rec.id = ca.evidence_object_id
           JOIN kaudit_source_envelope se
             ON se.source_connection_id = 'sc-kserve-gas-export'
            AND se.external_event_id = c.logical_call_key
           JOIN kaudit_evidence_object raw
             ON raw.id = se.evidence_object_id
          WHERE rec.source_url IS NULL
          ORDER BY c.source_started_at ASC
          LIMIT ?`,
        [limit],
      )
      return (rows as any[]).map((r) => ({
        evidenceObjectId: r.evidence_object_id,
        callId: r.call_id,
        logicalCallKey: r.logical_call_key,
        rawBucket: r.raw_bucket,
        rawKey: r.raw_key,
        existingSourceUrl: r.existing_source_url,
      }))
    },
    async setSourceUrl(evidenceObjectId, s3Url): Promise<void> {
      await pool.query(`UPDATE kaudit_evidence_object SET source_url = ? WHERE id = ?`, [
        s3Url,
        evidenceObjectId,
      ])
    },
    async recordIssue(evidenceObjectId, code, detail): Promise<void> {
      await pool.query(
        `INSERT INTO kaudit_audit_log
           (id, actor_email, action, resource_type, resource_id, correlation_id, occurred_at)
         VALUES (UUID(), 'w3-backfill', ?, 'evidence_object', ?, ?, NOW(6))`,
        [`backfill_${code}`, evidenceObjectId, detail.slice(0, 120)],
      )
    },
  }
}
