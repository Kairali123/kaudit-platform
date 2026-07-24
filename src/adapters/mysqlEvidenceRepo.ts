import type { Pool } from 'mysql2/promise'
import type { EvidenceRepo } from '../storage/ports.ts'
import type { EvidenceRow } from '../domain/types.ts'

// Reads evidence rows for KServe-URL verification and records baseline hashes,
// verifications, and findings.
//
// SCHEMA NOTE (additive migration): this approach stores the vendor recording URL
// server-side in a dedicated `source_url` column, plus a `last_verified_at` column.
// `source_url` MUST NEVER be sent to the browser, logs, or exports (it is a
// long-lived vendor URL — see the trade-off note in verifyEvidenceUrl.ts).
export function createMysqlEvidenceRepo(pool: Pool): EvidenceRepo {
  return {
    async listForVerification(limit: number): Promise<EvidenceRow[]> {
      const [rows] = await pool.query(
        `SELECT id, source_url, sha256, size_bytes, last_verified_at
           FROM kaudit_evidence_object
          WHERE source_url IS NOT NULL
          ORDER BY (last_verified_at IS NULL) DESC, last_verified_at ASC
          LIMIT ?`,
        [limit],
      )
      return (rows as any[]).map((r) => ({
        id: r.id,
        sourceUrl: r.source_url,
        sha256: r.sha256,
        sizeBytes: r.size_bytes,
        lastVerifiedAt: r.last_verified_at ? new Date(r.last_verified_at).toISOString() : null,
      }))
    },
    async recordHash(id, sha256, verifiedAt): Promise<void> {
      await pool.query(
        `UPDATE kaudit_evidence_object SET sha256 = ?, last_verified_at = ? WHERE id = ?`,
        [sha256, new Date(verifiedAt), id],
      )
    },
    async recordVerified(id, verifiedAt): Promise<void> {
      await pool.query(`UPDATE kaudit_evidence_object SET last_verified_at = ? WHERE id = ?`, [
        new Date(verifiedAt),
        id,
      ])
    },
    async recordIssue(id, code, detail): Promise<void> {
      if (code === 'evidence_altered' || code === 'source_missing') {
        await pool.query(`UPDATE kaudit_evidence_object SET status = 'quarantined' WHERE id = ?`, [id])
      }
      await pool.query(
        `INSERT INTO kaudit_audit_log
           (id, actor_email, action, resource_type, resource_id, correlation_id, occurred_at)
         VALUES (UUID(), 'w3-url-verify', ?, 'evidence_object', ?, ?, NOW(6))`,
        [`evidence_${code}`, id, detail.slice(0, 120)],
      )
    },
  }
}
