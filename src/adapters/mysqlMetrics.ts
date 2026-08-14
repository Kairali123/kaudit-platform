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

async function firstRow(
  pool: Pool,
  sql: string,
  params: unknown[] = [],
): Promise<Record<string, unknown> | null> {
  try {
    const [rows] = await pool.query(sql, params)
    return ((rows as any[])[0] as Record<string, unknown>) ?? null
  } catch {
    return null
  }
}

/** The five coverage counts the dashboard reads for one scope. */
export interface CoverageCounts {
  calls: number | null
  recordingArtifacts: number | null
  withSourceUrl: number | null
  withBaseline: number | null
  everVerified: number | null
}

const NO_COVERAGE: CoverageCounts = {
  calls: null,
  recordingArtifacts: null,
  withSourceUrl: null,
  withBaseline: null,
  everVerified: null,
}

/**
 * Coverage for one scope, in ONE round trip.
 *
 * These five counts used to be five separate statements that each re-scanned
 * the same two tables — a call count plus four near-identical artifact counts
 * differing only in which column had to be non-null. One LEFT JOIN answers all
 * of them: the call side is counted once per call however many recordings it
 * carries (`COUNT(DISTINCT c.id)`), and each artifact-side count is a
 * `COUNT(column)`, which counts one row per recording artifact and skips the
 * nulls — exactly what the four `IS NOT NULL` filters used to express.
 *
 * The statement is parameterized and aggregate-only: it selects no row, no id,
 * no URL, no hash, no identity and no content, so nothing but five integers
 * can leave the database.
 */
export function coverageSql(monthScoped: boolean): string {
  return `SELECT
       COUNT(DISTINCT c.id) AS calls,
       COUNT(ca.id) AS recording_artifacts,
       COUNT(ca.source_url) AS with_source_url,
       COUNT(ca.sha256) AS with_baseline,
       COUNT(ca.last_verified_at) AS ever_verified
     FROM kaudit_call c
     LEFT JOIN kaudit_call_artifact ca
       ON ca.call_id = c.id AND ca.artifact_type = 'recording'
     WHERE 1=1${monthScoped ? ' AND c.billing_period_date BETWEEN ? AND ?' : ''}`
}

/**
 * The five independent reads the consolidated statement replaced.
 *
 * Consolidating trades away the per-metric resilience the dashboard depends
 * on: one statement fails as a whole, so a single unavailable column (there is
 * no `source_url` before migration 0002) would blank every metric it selects,
 * and a missing `kaudit_call_artifact` would blank the call count that does not
 * even depend on that table. Falling back to the original one-metric-per-
 * statement shape restores that independence — each count survives or stays
 * pending on its own. Five reads is the cost of a degraded or legacy schema
 * only; the healthy path never reaches here and stays at one statement.
 */
export function legacyCoverageSql(
  monthScoped: boolean,
): Record<keyof CoverageCounts, string> {
  const callWindow = monthScoped
    ? ' AND c.billing_period_date BETWEEN ? AND ?'
    : ''
  const recordings = (columnFilter: string) =>
    `SELECT COUNT(*)
       FROM kaudit_call_artifact ca
       JOIN kaudit_call c ON c.id = ca.call_id
       WHERE ca.artifact_type='recording'${columnFilter}${callWindow}`
  return {
    calls: `SELECT COUNT(*) FROM kaudit_call c WHERE 1=1${callWindow}`,
    recordingArtifacts: recordings(''),
    withSourceUrl: recordings('\n         AND ca.source_url IS NOT NULL'),
    withBaseline: recordings('\n         AND ca.sha256 IS NOT NULL'),
    everVerified: recordings('\n         AND ca.last_verified_at IS NOT NULL'),
  }
}

/** A count the statement did not return, or returned as NULL, stays pending. */
function count(row: Record<string, unknown>, column: string): number | null {
  const value = row[column]
  return value == null ? null : Number(value)
}

export function toCoverageCounts(
  row: Record<string, unknown> | null,
): CoverageCounts {
  if (!row) return NO_COVERAGE
  return {
    calls: count(row, 'calls'),
    recordingArtifacts: count(row, 'recording_artifacts'),
    withSourceUrl: count(row, 'with_source_url'),
    withBaseline: count(row, 'with_baseline'),
    everVerified: count(row, 'ever_verified'),
  }
}

/** Each count read on its own, so no failure can take another one down. */
async function readCoverageIndependently(
  pool: Pool,
  monthScoped: boolean,
  params: unknown[],
): Promise<CoverageCounts> {
  const sql = legacyCoverageSql(monthScoped)
  const [calls, recordingArtifacts, withSourceUrl, withBaseline, everVerified] =
    await Promise.all([
      scalar(pool, sql.calls, params),
      scalar(pool, sql.recordingArtifacts, params),
      scalar(pool, sql.withSourceUrl, params),
      scalar(pool, sql.withBaseline, params),
      scalar(pool, sql.everVerified, params),
    ])
  return { calls, recordingArtifacts, withSourceUrl, withBaseline, everVerified }
}

async function readCoverage(
  pool: Pool,
  monthScoped: boolean,
  params: unknown[],
): Promise<CoverageCounts> {
  const row = await firstRow(pool, coverageSql(monthScoped), params)
  if (row) return toCoverageCounts(row)
  return readCoverageIndependently(pool, monthScoped, params)
}

export async function collectMetrics(
  pool: Pool,
  period: BillingMonthScope | null = null,
): Promise<RawMetrics> {
  const params = period ? [period.start, period.end] : []
  const [
    coverage,
    evidenceObjects,
    ingestionBatches,
    ingestionCompleted,
    users,
  ] = await Promise.all([
    readCoverage(pool, period != null, params),
    // All-period only: these tables carry no billing month, so a month-scoped
    // view leaves them pending rather than showing an all-time total.
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
    ...coverage,
    evidenceObjects, ingestionBatches, ingestionCompleted, users, findings,
    generatedAt: new Date().toISOString(),
  }
}
