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
import { fromScaled, toScaled } from '../ui/decimal.ts'
import { completedPeriods } from '../ui/periods.ts'

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
  const [summary, authority, rateCard, reconciliation] = await Promise.all([
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
      `SELECT
         COUNT(*) AS current_calculations,
         SUM(
           CASE
             WHEN current.status = 'final'
              AND current.calculation_basis IN (
                'independent_conversation_end',
                'accepted_as_billed_unverified'
              )
              AND current.audit_run_id IS NOT NULL
              AND current.input_manifest_sha256 IS NOT NULL
              AND current.ruleset_sha256 IS NOT NULL
              AND current.decision_trace_sha256 IS NOT NULL
              AND current.finalized_at IS NOT NULL
             THEN 1 ELSE 0
           END
         ) AS authoritative_calculations,
         SUM(
           CASE
             WHEN current.status = 'final'
              AND current.calculation_basis =
                'independent_conversation_end'
             THEN 1 ELSE 0
           END
         ) AS independent_final_calculations,
         (
           SELECT COUNT(*)
           FROM kaudit_automated_decision decision_row
           WHERE decision_row.decision_type =
                   'verified_call_billing'
             AND decision_row.decision_status = 'unresolved'
             AND NOT EXISTS (
               SELECT 1
               FROM kaudit_automated_decision newer_decision
               WHERE newer_decision.supersedes_decision_id =
                     decision_row.id
             )
         ) AS unresolved_automated_decisions
       FROM kaudit_billing_calculation current
       WHERE NOT EXISTS (
         SELECT 1 FROM kaudit_billing_calculation newer
         WHERE newer.supersedes_calculation_id = current.id
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
    authoritativeCalculations: n(authority?.authoritative_calculations),
    independentFinalCalculations: n(authority?.independent_final_calculations),
    unresolvedAutomatedDecisions: n(authority?.unresolved_automated_decisions),
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

interface RequestedPeriod {
  key: string
  start: string
  end: string
}

function addMoney(
  total: bigint | null,
  value: unknown,
): bigint | null {
  const scaled = toScaled(s(value))
  if (scaled == null) return total
  return (total ?? 0n) + scaled
}

async function collectPeriodAmounts(
  pool: Pool,
  requested: RequestedPeriod[],
): Promise<Map<string, PeriodAmounts>> {
  const calculationShape = await one(
    pool,
    `SELECT COUNT(*) AS calculation_count,
            COUNT(DISTINCT call_id) AS call_count
     FROM kaudit_billing_calculation`,
  )
  const oneCalculationPerCall =
    calculationShape != null &&
    Number(calculationShape.calculation_count) ===
      Number(calculationShape.call_count)
  const currentCalculationCte = oneCalculationPerCall
    ? `current_calculation AS (
         SELECT call_id, total_amount, currency
         FROM kaudit_billing_calculation
       )`
    : `ranked_calculation AS (
         SELECT call_id, total_amount, currency,
                ROW_NUMBER() OVER (
                  PARTITION BY call_id
                  ORDER BY calculated_at DESC, id DESC
                ) AS row_rank
         FROM kaudit_billing_calculation
       ),
       current_calculation AS (
         SELECT call_id, total_amount, currency
         FROM ranked_calculation
         WHERE row_rank = 1
       )`
  const [
    callDateRows,
    billingRows,
    providerRows,
    rateRow,
    invoiceRows,
  ] = await Promise.all([
    many(
      pool,
      `SELECT id AS call_id,
              CAST(billing_period_date AS CHAR) AS billing_date
       FROM kaudit_call
       WHERE billing_period_date IS NOT NULL`,
    ),
    many(
      pool,
      `WITH ${currentCalculationCte}
       SELECT call_id, CAST(total_amount AS CHAR) AS total_amount,
              currency
       FROM current_calculation`,
    ),
    many(
      pool,
      `SELECT call_id, CAST(minutes_decimal AS CHAR) AS minutes_decimal
       FROM kaudit_provider_cost
       WHERE provider_sku = 'vendor_asserted_billed_minutes'
         AND minutes_decimal IS NOT NULL`,
    ),
    one(
      pool,
      `SELECT CAST(MAX(unit_rate) AS CHAR) AS per_minute_rate
       FROM kaudit_billing_component_result
       WHERE rule_code = 'PER_MINUTE_CEIL'`,
    ),
    many(
      pool,
      `SELECT CAST(period_start AS CHAR) AS period_start,
              CAST(period_end AS CHAR) AS period_end,
              CAST(total_amount AS CHAR) AS invoice_total,
              currency
       FROM kaudit_invoice
       ORDER BY revision_no DESC, created_at DESC, id DESC`,
    ),
  ])
  const invoiceByPeriod = new Map<string, any>()
  for (const invoice of invoiceRows) {
    const key = `${String(invoice.period_start)}:${String(invoice.period_end)}`
    if (!invoiceByPeriod.has(key)) {
      invoiceByPeriod.set(key, invoice)
    }
  }
  // Opaque call IDs are used only inside this adapter to avoid a pathological
  // database join on the legacy schema. They are never returned by an API,
  // logged, or exposed to the browser.
  const callDateById = new Map(
    callDateRows.map((row) => [
      String(row.call_id),
      String(row.billing_date),
    ]),
  )
  const rate = toScaled(s(rateRow?.per_minute_rate))
  return new Map(
    requested.map((period) => {
      let verified: bigint | null = null
      let providerMinutes: bigint | null = null
      let currency: string | null = null
      for (const billing of billingRows) {
        const date = callDateById.get(String(billing.call_id))
        if (!date) continue
        if (date < period.start || date > period.end) continue
        verified = addMoney(verified, billing.total_amount)
        currency = currency ?? s(billing.currency)
      }
      for (const provider of providerRows) {
        const date = callDateById.get(String(provider.call_id))
        if (!date) continue
        if (date < period.start || date > period.end) continue
        providerMinutes = addMoney(
          providerMinutes,
          provider.minutes_decimal,
        )
      }
      const providerClaimed =
        providerMinutes == null || rate == null
          ? null
          : (providerMinutes * rate) / 100_000_000n
      const invoice = invoiceByPeriod.get(
        `${period.start}:${period.end}`,
      )
      return [
        period.key,
        {
          verified:
            verified == null ? null : fromScaled(verified),
          providerClaimed:
            providerClaimed == null
              ? null
              : fromScaled(providerClaimed),
          invoiceTotal: s(invoice?.invoice_total),
          currency:
            s(invoice?.currency) ?? currency ?? 'INR',
        },
      ]
    }),
  )
}

export async function collectRevenueSnapshots(pool: Pool): Promise<RawRevenueSnapshot[]> {
  const periods = completedPeriods(todayInIndia())
  const requested = periods.flatMap((period) => [
    {
      key: `${period.cadence}:current`,
      start: period.start,
      end: period.end,
    },
    {
      key: `${period.cadence}:prior`,
      start: period.priorStart,
      end: period.priorEnd,
    },
  ])
  const amounts = await collectPeriodAmounts(pool, requested)
  return periods.map((period): RawRevenueSnapshot => {
    const current =
      amounts.get(`${period.cadence}:current`) ??
      {
        verified: null,
        providerClaimed: null,
        invoiceTotal: null,
        currency: 'INR',
      }
    const prior =
      amounts.get(`${period.cadence}:prior`) ??
      {
        verified: null,
        providerClaimed: null,
        invoiceTotal: null,
        currency: current.currency,
      }
    const hasInvoice = current.invoiceTotal != null
    const priorHasInvoice = prior.invoiceTotal != null
    return {
      cadence: period.cadence,
      label: period.label,
      start: period.start,
      end: period.end,
      currency: current.currency,
      verified: current.verified,
      vendorClaimed: hasInvoice
        ? current.invoiceTotal
        : current.providerClaimed,
      vendorClaimedBasis: hasInvoice
        ? 'invoiced'
        : current.providerClaimed != null
          ? 'provider_claimed_no_invoice'
          : 'unavailable',
      priorVerified: prior.verified,
      priorVendorClaimed: priorHasInvoice
        ? prior.invoiceTotal
        : prior.providerClaimed,
    }
  })
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
