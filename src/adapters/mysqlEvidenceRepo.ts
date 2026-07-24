import type { Pool } from 'mysql2/promise'
import type { EvidenceRepo } from '../storage/ports.ts'
import type { EvidenceRow } from '../domain/types.ts'

// Reads migration candidates and updates evidence-object location in the shared
// KCRM MySQL. recordIssue() quarantines the row AND appends a migration finding
// to the audit log so the exception is queryable.
export function createMysqlEvidenceRepo(pool: Pool): EvidenceRepo {
  return {
    async listCandidates(limit: number): Promise<EvidenceRow[]> {
      const [rows] = await pool.query(
        `SELECT id, object_bucket, object_key, sha256, size_bytes, object_version_id
           FROM kaudit_evidence_object
          WHERE object_bucket IN ('local-disk','kaudit-local')
          ORDER BY acquired_at ASC
          LIMIT ?`,
        [limit],
      )
      return (rows as any[]).map((r) => ({
        id: r.id,
        objectBucket: r.object_bucket,
        objectKey: r.object_key,
        sha256: r.sha256,
        sizeBytes: r.size_bytes,
        objectVersionId: r.object_version_id,
      }))
    },
    async updateLocation(id, bucket, key, versionId): Promise<void> {
      await pool.query(
        `UPDATE kaudit_evidence_object
            SET object_bucket = ?, object_key = ?, object_version_id = ?
          WHERE id = ?`,
        [bucket, key, versionId, id],
      )
    },
    async recordIssue(id, code, detail): Promise<void> {
      await pool.query(`UPDATE kaudit_evidence_object SET status = 'quarantined' WHERE id = ?`, [id])
      await pool.query(
        `INSERT INTO kaudit_audit_log
           (id, actor_email, action, resource_type, resource_id, correlation_id, occurred_at)
         VALUES (UUID(), 'w3-migration', ?, 'evidence_object', ?, ?, NOW(6))`,
        [`storage_migration_${code}`, id, detail.slice(0, 120)],
      )
    },
  }
}
