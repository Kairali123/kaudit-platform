import type { Pool } from 'mysql2/promise'
import type { RawMetrics } from '../ui/metrics.ts'

// Read-only aggregate counts for the monitoring dashboard. Every query is independently
// defensive: a missing column/table (e.g. source_url before migration 0002, kaudit_user
// before 0003) yields null for that metric, not a crash — the dashboard shows 'pending'.
// Aggregate COUNTs only; no row data, no PII, no health content leaves the DB.
async function scalar(pool: Pool, sql: string): Promise<number | null> {
  try {
    const [rows] = await pool.query(sql)
    const r = (rows as any[])[0]
    if (!r) return null
    const v = Object.values(r)[0]
    return v == null ? null : Number(v)
  } catch {
    return null
  }
}

export async function collectMetrics(pool: Pool): Promise<RawMetrics> {
  const [
    calls,
    evidenceObjects,
    ingestionBatches,
    ingestionCompleted,
    users,
    recordingArtifacts,
    withSourceUrl,
    withBaseline,
    everVerified,
  ] = await Promise.all([
    scalar(pool, `SELECT COUNT(*) FROM kaudit_call`),
    scalar(pool, `SELECT COUNT(*) FROM kaudit_evidence_object`),
    scalar(pool, `SELECT COUNT(*) FROM kaudit_ingestion_batch`),
    scalar(pool, `SELECT COUNT(*) FROM kaudit_ingestion_batch WHERE status='completed'`),
    scalar(pool, `SELECT COUNT(*) FROM kaudit_user`),
    scalar(pool, `SELECT COUNT(*) FROM kaudit_call_artifact WHERE artifact_type='recording'`),
    scalar(pool, `SELECT COUNT(*) FROM kaudit_call_artifact WHERE artifact_type='recording' AND source_url IS NOT NULL`),
    scalar(pool, `SELECT COUNT(*) FROM kaudit_call_artifact WHERE artifact_type='recording' AND sha256 IS NOT NULL`),
    scalar(pool, `SELECT COUNT(*) FROM kaudit_call_artifact WHERE artifact_type='recording' AND last_verified_at IS NOT NULL`),
  ])

  let findings: { action: string; n: number }[] = []
  try {
    const [rows] = await pool.query(
      `SELECT action, COUNT(*) n FROM kaudit_audit_log
        WHERE action LIKE 'evidence\\_%' OR action LIKE 'backfill\\_%'
        GROUP BY action ORDER BY n DESC`,
    )
    findings = (rows as any[]).map((r) => ({ action: String(r.action), n: Number(r.n) }))
  } catch {
    findings = []
  }

  return {
    calls, recordingArtifacts, withSourceUrl, withBaseline, everVerified,
    evidenceObjects, ingestionBatches, ingestionCompleted, users, findings,
    generatedAt: new Date().toISOString(),
  }
}
