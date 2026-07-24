import type { Pool } from 'mysql2/promise'
import type { EvidenceRepo } from '../storage/ports.ts'
import type { EvidenceRow } from '../domain/types.ts'

// Verify-side repo. Reads recording rows for URL verification and records baseline
// hashes, verifications, and findings — on `kaudit_call_artifact` (the recording is a
// call_artifact; source_url/sha256/last_verified_at live there per migration 0002).
//
// `source_url` is a server-only vendor URL — never sent to the browser, logs, or exports.
export function createMysqlEvidenceRepo(pool: Pool): EvidenceRepo {
  return {
    async listForVerification(limit: number): Promise<EvidenceRow[]> {
      const [rows] = await pool.query(
        `SELECT id, source_url, sha256, last_verified_at
           FROM kaudit_call_artifact
          WHERE artifact_type = 'recording' AND source_url IS NOT NULL
          ORDER BY (last_verified_at IS NULL) DESC, last_verified_at ASC
          LIMIT ?`,
        [limit],
      )
      return (rows as any[]).map((r) => ({
        id: r.id,
        sourceUrl: r.source_url,
        sha256: r.sha256,
        sizeBytes: null,
        lastVerifiedAt: r.last_verified_at ? new Date(r.last_verified_at).toISOString() : null,
      }))
    },
    async recordHash(id, sha256, verifiedAt): Promise<void> {
      await pool.query(
        `UPDATE kaudit_call_artifact SET sha256 = ?, last_verified_at = ? WHERE id = ?`,
        [sha256, new Date(verifiedAt), id],
      )
    },
    async recordVerified(id, verifiedAt): Promise<void> {
      await pool.query(`UPDATE kaudit_call_artifact SET last_verified_at = ? WHERE id = ?`, [
        new Date(verifiedAt),
        id,
      ])
    },
    async recordIssue(id, code, detail): Promise<void> {
      await pool.query(
        `INSERT INTO kaudit_audit_log
           (id, actor_email, action, resource_type, resource_id, correlation_id, occurred_at)
         VALUES (UUID(), 'w3-url-verify', ?, 'call_artifact', ?, ?, NOW(6))`,
        [`evidence_${code}`, id, detail.slice(0, 120)],
      )
    },
  }
}
