import type { Pool } from 'mysql2/promise'
import { collectMetrics } from './mysqlMetrics.ts'
import type {
  CountRow,
  FindingRow,
  RawBillingMetrics,
  RawFullDashboard,
  RawQualityMetrics,
  RawRevenueSnapshot,
} from '../ui/fullDashboard.ts'
import { completedPeriods, type DatePeriod } from '../ui/periods.ts'

// Aggregate-only, read-only adapter for the full local dashboard. No query selects
// call IDs, phone data, transcript text, evidence URLs, or health content. Every
// optional subsystem is defensive: a missing migration/table yields null/[] and is
// rendered as unavailable rather than fabricated.

async function one(pool: Pool, sql: string, params: unknown[] = []): Promise<Record<string, any> | null> {
  try {
    const [result] = await pool.query(sql, params)
    return (result as any[])[0] ?? null
  } catch {
    return null
  }
}

async function many(pool: Pool, sql: string, params: unknown[] = []): Promise<any[]> {
  try {
    const [result] = await pool.query(sql, params)
    return result as any[]
  } catch {
    return []
  }
}

function n(value: unknown): number | null {
  return value == null ? null : Number(value)
}
function s(value: unknown): string | null {
  return value == null ? null : String(value)
}

export async function collectQuality(pool: Pool): Promise<RawQualityMetrics> {
  const [summary, catalog, confirmationRows, originRows, findingRows] = await Promise.all([
    one(
      pool,
      `SELECT
         (SELECT COUNT(*) FROM kaudit_audit_run) AS audit_runs,
         (SELECT COUNT(DISTINCT call_id) FROM kaudit_audit_run WHERE status='completed') AS analyzed_calls,
         COUNT(*) AS total_findings,
         COUNT(DISTINCT call_id) AS calls_with_findings,
         CAST(AVG(confidence) AS CHAR) AS avg_confidence
       FROM kaudit_audit_finding`,
    ),
    one(
      pool,
      `SELECT catalog_version, status
       FROM kaudit_quality_flag_catalog_version
       ORDER BY created_at DESC LIMIT 1`,
    ),
    many(
      pool,
      `SELECT confirmation_status AS label, COUNT(*) AS n
       FROM kaudit_audit_finding
       GROUP BY confirmation_status ORDER BY n DESC`,
    ),
    many(
      pool,
      `SELECT origin AS label, COUNT(*) AS n
       FROM kaudit_audit_finding
       GROUP BY origin ORDER BY n DESC`,
    ),
    many(
      pool,
      `SELECT finding_code AS code, COUNT(*) AS n, CAST(AVG(confidence) AS CHAR) AS avg_confidence
       FROM kaudit_audit_finding
       GROUP BY finding_code ORDER BY n DESC, finding_code LIMIT 10`,
    ),
  ])

  return {
    auditRuns: n(summary?.audit_runs),
    analyzedCalls: n(summary?.analyzed_calls),
    totalFindings: n(summary?.total_findings),
    callsWithFindings: n(summary?.calls_with_findings),
    avgConfidence: s(summary?.avg_confidence),
    catalogVersion: s(catalog?.catalog_version),
    catalogStatus: s(catalog?.status),
    confirmations: confirmationRows.map((r): CountRow => ({ label: String(r.label), n: Number(r.n) })),
    origins: originRows.map((r): CountRow => ({ label: String(r.label), n: Number(r.n) })),
    topFindings: findingRows.map(
      (r): FindingRow => ({
        code: String(r.code),
        n: Number(r.n),
        avgConfidence: s(r.avg_confidence),
      }),
    ),
  }
}

export async function collectBilling(pool: Pool): Promise<RawBillingMetrics> {
  const [summary, rateCard, reconciliation] = await Promise.all([
    one(
      pool,
      `SELECT
         COUNT(*) AS calculations,
         CAST(SUM(bc.total_amount) AS CHAR) AS calculated_total,
         CAST(SUM(bc.billable_duration_ms) / 60000 AS CHAR) AS billable_minutes,
         MAX(bc.currency) AS currency
       FROM kaudit_billing_calculation bc
       WHERE NOT EXISTS (
         SELECT 1 FROM kaudit_billing_calculation newer
         WHERE newer.supersedes_calculation_id = bc.id
       )`,
    ),
    one(
      pool,
      `SELECT version, status, approved_by, CAST(approved_at AS CHAR) AS approved_at, currency
       FROM kaudit_rate_card_version
       ORDER BY created_at DESC LIMIT 1`,
    ),
    one(
      pool,
      `SELECT status, CAST(claimed_subtotal AS CHAR) AS claimed_subtotal,
              CAST(verified_subtotal AS CHAR) AS verified_subtotal,
              CAST(net_variance AS CHAR) AS net_variance, currency
       FROM kaudit_reconciliation
       ORDER BY created_at DESC, version DESC LIMIT 1`,
    ),
  ])

  return {
    calculations: n(summary?.calculations),
    calculatedTotal: s(summary?.calculated_total),
    billableMinutes: s(summary?.billable_minutes),
    currency: s(reconciliation?.currency) ?? s(summary?.currency) ?? s(rateCard?.currency) ?? 'INR',
    rateCardVersion: s(rateCard?.version),
    rateCardStatus: s(rateCard?.status),
    rateCardApprovedBy: s(rateCard?.approved_by),
    rateCardApprovedAt: s(rateCard?.approved_at),
    reconciliationStatus: s(reconciliation?.status),
    claimedSubtotal: s(reconciliation?.claimed_subtotal),
    verifiedSubtotal: s(reconciliation?.verified_subtotal),
    netVariance: s(reconciliation?.net_variance),
  }
}

interface PeriodAmounts {
  verified: string | null
  providerClaimed: string | null
  invoiceTotal: string | null
  currency: string
}

async function periodAmounts(pool: Pool, start: string, end: string): Promise<PeriodAmounts> {
  const [usage, invoice] = await Promise.all([
    one(
      pool,
      `SELECT
         CAST(SUM(bc.total_amount) AS CHAR) AS verified,
         CAST(SUM(
           CASE WHEN pc.minutes_decimal IS NOT NULL AND rate.per_minute_rate IS NOT NULL
                THEN pc.minutes_decimal * rate.per_minute_rate END
         ) AS CHAR) AS provider_claimed,
         MAX(bc.currency) AS currency
       FROM kaudit_call c
       LEFT JOIN kaudit_billing_calculation bc
         ON bc.call_id = c.id
        AND NOT EXISTS (
          SELECT 1 FROM kaudit_billing_calculation newer
          WHERE newer.supersedes_calculation_id = bc.id
        )
       LEFT JOIN kaudit_provider_cost pc
         ON pc.call_id = c.id
        AND pc.provider_sku = 'vendor_asserted_billed_minutes'
       CROSS JOIN (
         SELECT MAX(unit_rate) AS per_minute_rate
         FROM kaudit_billing_component_result
         WHERE rule_code = 'PER_MINUTE_CEIL'
       ) rate
       WHERE c.billing_period_date BETWEEN ? AND ?`,
      [start, end],
    ),
    one(
      pool,
      `SELECT CAST(total_amount AS CHAR) AS invoice_total, currency
       FROM kaudit_invoice
       WHERE period_start = ? AND period_end = ?
       ORDER BY revision_no DESC LIMIT 1`,
      [start, end],
    ),
  ])

  return {
    verified: s(usage?.verified),
    providerClaimed: s(usage?.provider_claimed),
    invoiceTotal: s(invoice?.invoice_total),
    currency: s(invoice?.currency) ?? s(usage?.currency) ?? 'INR',
  }
}

async function collectSnapshot(pool: Pool, period: DatePeriod): Promise<RawRevenueSnapshot> {
  const [current, prior] = await Promise.all([
    periodAmounts(pool, period.start, period.end),
    periodAmounts(pool, period.priorStart, period.priorEnd),
  ])
  const hasInvoice = current.invoiceTotal != null
  const priorHasInvoice = prior.invoiceTotal != null
  return {
    cadence: period.cadence,
    label: period.label,
    start: period.start,
    end: period.end,
    currency: current.currency,
    verified: current.verified,
    vendorClaimed: hasInvoice ? current.invoiceTotal : current.providerClaimed,
    vendorClaimedBasis: hasInvoice
      ? 'invoiced'
      : current.providerClaimed != null
        ? 'provider_claimed_no_invoice'
        : 'unavailable',
    priorVerified: prior.verified,
    priorVendorClaimed: priorHasInvoice ? prior.invoiceTotal : prior.providerClaimed,
  }
}

export async function collectRevenueSnapshots(pool: Pool): Promise<RawRevenueSnapshot[]> {
  return Promise.all(completedPeriods(todayInIndia()).map((period) => collectSnapshot(pool, period)))
}

function todayInIndia(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date())
}

export async function collectFullDashboard(pool: Pool): Promise<RawFullDashboard> {
  const [monitor, quality, billing, snapshots] = await Promise.all([
    collectMetrics(pool),
    collectQuality(pool),
    collectBilling(pool),
    collectRevenueSnapshots(pool),
  ])
  const generatedAt = new Date().toISOString()
  return {
    generatedAt,
    monitor: { ...monitor, generatedAt },
    quality,
    billing,
    snapshots,
  }
}
