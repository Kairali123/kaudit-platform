import type { Pool } from 'mysql2/promise'
import type { RawMetrics } from '../ui/metrics.ts'
import type { BillingMonthScope } from '../reporting/billingMonth.ts'

// Read-only aggregate counts for the monitoring dashboard. Every query is independently
// defensive: a missing column/table (e.g. source_url before migration 0002, kaudit_user
// before 0003) yields null for that metric, not a crash — the dashboard shows 'pending'.
// Aggregate COUNTs only; no row data, no PII, no health content leaves the DB.
async function scalar(
  pool: Pool,
  sql: string,
  params: unknown[] = [],
): Promise<number | null> {
  try {
    const [rows] = await pool.query(sql, params)
    const r = (rows as any[])[0]
    if (!r) return null
    const v = Object.values(r)[0]
    return v == null ? null : Number(v)
  } catch {
    return null
  }
}

export async function collectMetrics(
  pool: Pool,
  period: BillingMonthScope | null = null,
): Promise<RawMetrics> {
  const callWindow = period
    ? ' AND c.billing_period_date BETWEEN ? AND ?'
    : ''
  const params = period ? [period.start, period.end] : []
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
    scalar(
      pool,
      `SELECT COUNT(*) FROM kaudit_call c WHERE 1=1${callWindow}`,
      params,
    ),
    period
      ? Promise.resolve(null)
      : scalar(pool, `SELECT COUNT(*) FROM kaudit_evidence_object`),
    period
      ? Promise.resolve(null)
      : scalar(pool, `SELECT COUNT(*) FROM kaudit_ingestion_batch`),
    period
      ? Promise.resolve(null)
      : scalar(pool, `SELECT COUNT(*) FROM kaudit_ingestion_batch WHERE status='completed'`),
    period
      ? Promise.resolve(null)
      : scalar(pool, `SELECT COUNT(*) FROM kaudit_user`),
    scalar(
      pool,
      `SELECT COUNT(*)
       FROM kaudit_call_artifact ca
       JOIN kaudit_call c ON c.id = ca.call_id
       WHERE ca.artifact_type='recording'${callWindow}`,
      params,
    ),
    scalar(
      pool,
      `SELECT COUNT(*)
       FROM kaudit_call_artifact ca
       JOIN kaudit_call c ON c.id = ca.call_id
       WHERE ca.artifact_type='recording'
         AND ca.source_url IS NOT NULL${callWindow}`,
      params,
    ),
    scalar(
      pool,
      `SELECT COUNT(*)
       FROM kaudit_call_artifact ca
       JOIN kaudit_call c ON c.id = ca.call_id
       WHERE ca.artifact_type='recording'
         AND ca.sha256 IS NOT NULL${callWindow}`,
      params,
    ),
    scalar(
      pool,
      `SELECT COUNT(*)
       FROM kaudit_call_artifact ca
       JOIN kaudit_call c ON c.id = ca.call_id
       WHERE ca.artifact_type='recording'
         AND ca.last_verified_at IS NOT NULL${callWindow}`,
      params,
    ),
  ])

  let findings: { action: string; n: number }[] = []
  try {
    // Legacy evidence events are not reliably linked to a billing month.
    // Returning no events for a selected month avoids leaking all-time totals
    // into a month-scoped view.
    if (period) throw new Error('month-scoped evidence events unavailable')
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
