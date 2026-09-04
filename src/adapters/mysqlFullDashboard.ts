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
import { collectLatestBillingCycle } from './mysqlBillingCycle.ts'
import {
  previousBillingMonth,
  type BillingMonthScope,
} from '../reporting/billingMonth.ts'
import { isDatabaseStatementTimeout } from './mysqlReadTimeout.ts'

// Aggregate-only, read-only adapter for the full local dashboard. No query selects
// call IDs, phone data, transcript text, evidence URLs, or health content. Every
// optional subsystem is defensive: a missing migration/table yields null/[] and is
// rendered as unavailable rather than fabricated.

async function one(pool: Pool, sql: string, params: unknown[] = []): Promise<Record<string, any> | null> {
  try {
    const [result] = await pool.query(sql, params)
    return (result as any[])[0] ?? null
  } catch (error) {
    if (isDatabaseStatementTimeout(error)) throw error
    return null
  }
}

async function many(pool: Pool, sql: string, params: unknown[] = []): Promise<any[]> {
  try {
    const [result] = await pool.query(sql, params)
    return result as any[]
  } catch (error) {
    if (isDatabaseStatementTimeout(error)) throw error
    return []
  }
}

function n(value: unknown): number | null {
  return value == null ? null : Number(value)
}
function s(value: unknown): string | null {
  return value == null ? null : String(value)
}

export async function collectQuality(
  pool: Pool,
  period: BillingMonthScope | null = null,
): Promise<RawQualityMetrics> {
  const callWhere = period
    ? ' WHERE c.billing_period_date BETWEEN ? AND ?'
    : ''
  const findingWhere = period
    ? ' WHERE finding_call.billing_period_date BETWEEN ? AND ?'
    : ''
  const periodParams = period ? [period.start, period.end] : []
  const [summary, catalog, confirmationRows, originRows, findingRows] = await Promise.all([
    one(
      pool,
      `SELECT
         (
           SELECT COUNT(*)
           FROM kaudit_audit_run run
           JOIN kaudit_call c ON c.id = run.call_id
           ${callWhere}
         ) AS audit_runs,
         (
           SELECT COUNT(DISTINCT run.call_id)
           FROM kaudit_audit_run run
           JOIN kaudit_call c ON c.id = run.call_id
           ${callWhere}${period ? ' AND' : ' WHERE'} run.status='completed'
         ) AS analyzed_calls,
         COUNT(*) AS total_findings,
         COUNT(DISTINCT finding.call_id) AS calls_with_findings,
         CAST(AVG(finding.confidence) AS CHAR) AS avg_confidence
       FROM kaudit_audit_finding finding
       JOIN kaudit_call finding_call ON finding_call.id = finding.call_id
       ${findingWhere}`,
      period ? [...periodParams, ...periodParams, ...periodParams] : [],
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
       FROM kaudit_audit_finding finding
       JOIN kaudit_call c ON c.id = finding.call_id
       ${callWhere}
       GROUP BY confirmation_status ORDER BY n DESC`,
      periodParams,
    ),
    many(
      pool,
      `SELECT origin AS label, COUNT(*) AS n
       FROM kaudit_audit_finding finding
       JOIN kaudit_call c ON c.id = finding.call_id
       ${callWhere}
       GROUP BY origin ORDER BY n DESC`,
      periodParams,
    ),
    many(
      pool,
      `SELECT finding_code AS code, COUNT(*) AS n, CAST(AVG(confidence) AS CHAR) AS avg_confidence
       FROM kaudit_audit_finding finding
       JOIN kaudit_call c ON c.id = finding.call_id
       ${callWhere}
       GROUP BY finding_code ORDER BY n DESC, finding_code LIMIT 10`,
      periodParams,
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

export async function collectBilling(
  pool: Pool,
  period: BillingMonthScope | null = null,
): Promise<RawBillingMetrics> {
  const calculationWindow = period
    ? ' AND calculation_call.billing_period_date BETWEEN ? AND ?'
    : ''
  const periodParams = period ? [period.start, period.end] : []
  const [summary, authority, rateCard, invoice, reconciliation, cycle] = await Promise.all([
    one(
      pool,
      `SELECT
         COUNT(*) AS calculations,
         CAST(SUM(bc.total_amount) AS CHAR) AS calculated_total,
         CAST(SUM(bc.billable_duration_ms) / 60000 AS CHAR) AS billable_minutes,
         MAX(bc.currency) AS currency
       FROM kaudit_billing_calculation bc
       JOIN kaudit_call calculation_call ON calculation_call.id = bc.call_id
       WHERE NOT EXISTS (
         SELECT 1 FROM kaudit_billing_calculation newer
         WHERE newer.supersedes_calculation_id = bc.id
       )${calculationWindow}`,
      periodParams,
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
                'independent_category_service_end',
                'accepted_as_billed_unverified',
                'no_recording_zero'
              )
              AND (
                (current.calculation_basis IN (
                   'independent_conversation_end',
                   'independent_category_service_end'
                 )
                 AND current.audit_run_id IS NOT NULL)
                OR current.calculation_basis IN (
                   'accepted_as_billed_unverified',
                   'no_recording_zero'
                )
              )
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
             AND current.calculation_basis IN (
                'independent_conversation_end',
                'independent_category_service_end'
              )
             THEN 1 ELSE 0
           END
         ) AS independent_final_calculations,
         (
           SELECT COUNT(*)
           FROM kaudit_automated_decision decision_row
           JOIN kaudit_call decision_call
             ON decision_call.id = decision_row.call_id
           WHERE decision_row.decision_type =
                   'verified_call_billing'
             AND decision_row.decision_status = 'unresolved'
             AND NOT EXISTS (
               SELECT 1
               FROM kaudit_automated_decision newer_decision
               WHERE newer_decision.supersedes_decision_id =
                     decision_row.id
             )${period ? ' AND decision_call.billing_period_date BETWEEN ? AND ?' : ''}
         ) AS unresolved_automated_decisions
       FROM kaudit_billing_calculation current
       JOIN kaudit_call calculation_call
         ON calculation_call.id = current.call_id
       WHERE NOT EXISTS (
         SELECT 1 FROM kaudit_billing_calculation newer
         WHERE newer.supersedes_calculation_id = current.id
       )${calculationWindow}`,
      period ? [...periodParams, ...periodParams] : [],
    ),
    one(
      pool,
      `SELECT version, status, approved_by, CAST(approved_at AS CHAR) AS approved_at, currency
       FROM kaudit_rate_card_version
       ${period
         ? `WHERE effective_from <= ?
              AND (effective_to IS NULL OR effective_to >= ?)`
         : ''}
       ORDER BY created_at DESC LIMIT 1`,
      period ? [period.end, period.start] : [],
    ),
    /**
     * The vendor's own claim for the period, independent of any reconciliation.
     *
     * The claim is a FACT recorded when the invoice was imported; a
     * reconciliation is a later, separate act of agreeing it. Reading the claim
     * only from the reconciliation meant a month with a perfectly good stored
     * invoice showed no vendor claim and, because the variance subtracts from
     * it, no variance either — the two numbers the page exists to compare.
     */
    one(
      pool,
      `SELECT CAST(invoice.subtotal_amount AS CHAR) AS invoice_subtotal,
              invoice.currency
       FROM kaudit_invoice invoice
       ${period
         ? 'WHERE invoice.period_start = ? AND invoice.period_end = ?'
         : ''}
       ORDER BY invoice.period_start DESC, invoice.created_at DESC,
                invoice.id DESC
       LIMIT 1`,
      periodParams,
    ),
    one(
      pool,
      `SELECT reconciliation.status,
              CAST(reconciliation.claimed_subtotal AS CHAR) AS claimed_subtotal,
              CAST(verified_subtotal AS CHAR) AS verified_subtotal,
              CAST(net_variance AS CHAR) AS net_variance,
              reconciliation.currency
       FROM kaudit_reconciliation reconciliation
       JOIN kaudit_invoice reconciliation_invoice
         ON reconciliation_invoice.id = reconciliation.invoice_id
       ${period
         ? 'WHERE reconciliation_invoice.period_start = ? AND reconciliation_invoice.period_end = ?'
         : ''}
       ORDER BY reconciliation.created_at DESC,
                reconciliation.version DESC LIMIT 1`,
      periodParams,
    ),
    collectLatestBillingCycle(pool, period),
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
    /**
     * A closed reconciliation is the agreed claim and wins. Without one, the
     * stored invoice is still what the vendor asked for, and the tile says
     * which of the two it is showing rather than showing nothing.
     */
    claimedSubtotal:
      s(reconciliation?.claimed_subtotal) ?? s(invoice?.invoice_subtotal),
    claimedSubtotalBasis: s(reconciliation?.claimed_subtotal) != null
      ? 'reconciled'
      : s(invoice?.invoice_subtotal) != null
        ? 'vendor_invoice'
        : 'unavailable',
    verifiedSubtotal: s(reconciliation?.verified_subtotal),
    netVariance: s(reconciliation?.net_variance),
    cycle,
  }
}

interface PeriodAmounts {
  verified: string | null
  providerClaimed: string | null
  invoiceSubtotal: string | null
  currency: string
}

export interface RequestedPeriod {
  key: string
  /** Inclusive `YYYY-MM-DD` bill-period bounds. */
  start: string
  end: string
}

// ---------------------------------------------------------------------------
// Revenue snapshot reads
// ---------------------------------------------------------------------------

/**
 * The snapshot cards ask for at most four cadences, each with its own prior
 * period. Nothing legitimate reaches this adapter with more, so the bound is
 * enforced rather than assumed: it is what keeps the requested-period relation
 * — and therefore every result set below — small no matter what a caller does.
 */
export const MAX_REQUESTED_PERIODS = 8

const PERIOD_KEY_PATTERN = /^[a-z]+:(current|prior)$/
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/

/**
 * Validate the requested periods BEFORE any SQL is built.
 *
 * Only the row COUNT ever reaches the statement text; every key and every date
 * is bound as a parameter. The checks here are therefore not an escaping
 * mechanism — they are the bound on how much work the database is asked to do,
 * and a guard against a malformed period silently matching nothing.
 */
export function validateRequestedPeriods(
  requested: readonly RequestedPeriod[],
): RequestedPeriod[] {
  if (requested.length === 0) {
    throw new RangeError('at least one billing period must be requested')
  }
  if (requested.length > MAX_REQUESTED_PERIODS) {
    throw new RangeError(
      `at most ${MAX_REQUESTED_PERIODS} billing periods may be requested`,
    )
  }
  const seen = new Set<string>()
  for (const period of requested) {
    if (!PERIOD_KEY_PATTERN.test(period.key)) {
      throw new RangeError(`unsupported period key: ${period.key}`)
    }
    if (seen.has(period.key)) {
      throw new RangeError(`duplicate period key: ${period.key}`)
    }
    seen.add(period.key)
    if (
      !ISO_DATE_PATTERN.test(period.start) ||
      !ISO_DATE_PATTERN.test(period.end)
    ) {
      throw new RangeError(`period ${period.key} must use YYYY-MM-DD bounds`)
    }
    if (period.start > period.end) {
      throw new RangeError(`period ${period.key} ends before it starts`)
    }
  }
  return [...requested]
}

/** Key, start and end of every requested period, in statement order. */
export function requestedPeriodParams(
  periods: readonly RequestedPeriod[],
): unknown[] {
  return periods.flatMap((period) => [period.key, period.start, period.end])
}

/**
 * The requested periods as a bounded, fully parameterized relation.
 *
 * `DATE(?)` rather than a bare placeholder so the bounds are compared as dates
 * against the indexed `billing_period_date` column instead of as whatever type
 * the engine infers for a projected placeholder. The only caller-derived thing
 * in the statement text is the number of rows, which validation has already
 * capped at `MAX_REQUESTED_PERIODS`.
 */
function requestedPeriodCte(periodCount: number): string {
  const rows = Array.from(
    { length: periodCount },
    () => 'SELECT ?, DATE(?), DATE(?)',
  ).join('\n            UNION ALL ')
  return `requested_period (period_key, period_start, period_end) AS (
            ${rows}
          )`
}

/**
 * Every call that falls in a requested period, tagged with that period.
 *
 * A call appearing in two overlapping requested periods (the weekly and the
 * monthly card cover the same days) yields one row per period, which is what
 * gives each period its own complete total. Call ids exist only inside this
 * relation: they are joined on and grouped away, never projected.
 */
const PERIOD_CALL_CTE = `period_call AS (
            SELECT requested.period_key AS period_key, c.id AS call_id
            FROM requested_period requested
            JOIN kaudit_call c
              ON c.billing_period_date
                 BETWEEN requested.period_start AND requested.period_end
          )`

/**
 * Verified billable money per requested period: one row per period, or no row
 * at all when the period holds no calculation.
 *
 * The latest calculation per call (`calculated_at DESC, id DESC`) is chosen
 * once, over the calls in scope only, and joined at rank 1 — so several
 * calculations for one call contribute exactly one amount, and the ranking
 * never walks calculations belonging to months nobody asked for.
 */
export function verifiedPeriodTotalsSql(periodCount: number): string {
  return `WITH ${requestedPeriodCte(periodCount)},
          ${PERIOD_CALL_CTE},
          scoped_calculation AS (
            SELECT calculation.call_id AS call_id,
                   calculation.total_amount AS total_amount,
                   calculation.currency AS currency,
                   ROW_NUMBER() OVER (
                     PARTITION BY calculation.call_id
                     ORDER BY calculation.calculated_at DESC,
                              calculation.id DESC
                   ) AS revision_rank
            FROM kaudit_billing_calculation calculation
            WHERE calculation.call_id IN (SELECT call_id FROM period_call)
          )
          SELECT period_call.period_key AS period_key,
                 CAST(SUM(latest.total_amount) AS CHAR) AS verified_amount,
                 MAX(latest.currency) AS currency
          FROM period_call
          JOIN scoped_calculation latest
            ON latest.call_id = period_call.call_id
           AND latest.revision_rank = 1
          GROUP BY period_call.period_key`
}

/**
 * Vendor assertions per requested period: billed minutes and, when supplied,
 * the billed amount. The amount is authoritative for the vendor claim; minutes
 * are retained for the legacy fallback only.
 *
 * Aggregated independently of the calculations above. Joining provider cost
 * rows and calculations in one statement would multiply each provider row by
 * the number of calculations on the call (and vice versa); summing each fact
 * on its own and combining the two totals in Node cannot.
 *
 * Provider cost is deliberately the first table and STRAIGHT_JOIN fixes that
 * order on MySQL. Production evidence showed the optimizer otherwise scanning
 * every call before looking up costs, turning this bounded monthly aggregate
 * into a 20+ second read. Starting from the much smaller cost fact set preserves
 * the basis: every matching minutes row contributes to every requested period
 * containing its call.
 */
export function providerPeriodTotalsSql(periodCount: number): string {
  return `WITH ${requestedPeriodCte(periodCount)},
          provider_claim AS (
            SELECT cost.call_id,
                   SUM(CASE
                     WHEN cost.provider_sku = 'vendor_asserted_billed_minutes'
                     THEN cost.minutes_decimal
                   END) AS provider_minutes,
                   MAX(CASE
                     WHEN cost.provider_sku = 'vendor_asserted_billed_amount'
                     THEN cost.quantity_decimal
                   END) AS provider_amount
            FROM kaudit_provider_cost cost
            WHERE cost.provider_sku IN (
                    'vendor_asserted_billed_minutes',
                    'vendor_asserted_billed_amount'
                  )
              AND cost.is_final = 1
            GROUP BY cost.call_id
          ),
          provider_period_total AS (
            SELECT requested.period_key AS period_key,
                 CAST(SUM(claim.provider_minutes) AS CHAR)
                   AS provider_minutes,
                 CAST(SUM(claim.provider_amount) AS CHAR)
                   AS provider_amount,
                 CAST(SUM(CASE
                   WHEN claim.provider_amount IS NULL
                   THEN claim.provider_minutes
                 END) AS CHAR) AS fallback_minutes
            FROM provider_claim claim
            STRAIGHT_JOIN kaudit_call c ON c.id = claim.call_id
            STRAIGHT_JOIN requested_period requested
              ON c.billing_period_date
                 BETWEEN requested.period_start AND requested.period_end
            GROUP BY requested.period_key
          )
          SELECT period_key, provider_minutes, provider_amount,
                 fallback_minutes
          FROM provider_period_total`
}

/**
 * The latest invoice revision for each requested period's EXACT bounds: at
 * most one row per period. An invoice covering different bounds is not this
 * period's invoice and is never read.
 */
export function latestInvoicePeriodSql(periodCount: number): string {
  return `WITH ${requestedPeriodCte(periodCount)},
          scoped_invoice AS (
            SELECT requested.period_key AS period_key,
                   invoice.subtotal_amount AS subtotal_amount,
                   invoice.currency AS currency,
                   ROW_NUMBER() OVER (
                     PARTITION BY requested.period_key
                     ORDER BY invoice.revision_no DESC,
                              invoice.created_at DESC,
                              invoice.id DESC
                   ) AS revision_rank
            FROM requested_period requested
            JOIN kaudit_invoice invoice
              ON invoice.period_start = requested.period_start
             AND invoice.period_end = requested.period_end
          )
          SELECT period_key,
                 CAST(subtotal_amount AS CHAR) AS invoice_subtotal,
                 currency
          FROM scoped_invoice
          WHERE revision_rank = 1`
}

/** The per-minute rate the provider claim is valued at. Always one row. */
export const PER_MINUTE_RATE_SQL = `SELECT CAST(MAX(unit_rate) AS CHAR) AS per_minute_rate
   FROM kaudit_billing_component_result
   WHERE rule_code = 'PER_MINUTE_CEIL'`

/**
 * The amounts behind the snapshot cards, for at most eight requested periods.
 *
 * Four bounded reads whose cost follows the requested periods rather than the
 * size of the tables: filtering, latest-revision selection and summation all
 * happen in the database, and what crosses into Node is at most one aggregate
 * row per period per read. No call id, no per-call row and no invoice identity
 * is selected.
 *
 * Money stays exact throughout: the database returns fixed-precision DECIMAL
 * text, and every arithmetic step here is BigInt at 1e8 scale.
 */
export async function collectPeriodAmounts(
  pool: Pool,
  requested: readonly RequestedPeriod[],
): Promise<Map<string, PeriodAmounts>> {
  const periods = validateRequestedPeriods(requested)
  const params = requestedPeriodParams(periods)
  const [verifiedRows, providerRows, rateRow, invoiceRows] = await Promise.all([
    many(pool, verifiedPeriodTotalsSql(periods.length), params),
    many(pool, providerPeriodTotalsSql(periods.length), params),
    one(pool, PER_MINUTE_RATE_SQL),
    many(pool, latestInvoicePeriodSql(periods.length), params),
  ])
  const byPeriod = (rows: any[]): Map<string, any> =>
    new Map(rows.map((row) => [String(row.period_key), row]))
  const verifiedByPeriod = byPeriod(verifiedRows)
  const providerByPeriod = byPeriod(providerRows)
  const invoiceByPeriod = byPeriod(invoiceRows)
  const rate = toScaled(s(rateRow?.per_minute_rate))
  return new Map(
    periods.map((period) => {
      const verifiedRow = verifiedByPeriod.get(period.key)
      const verified = toScaled(s(verifiedRow?.verified_amount))
      const providerRow = providerByPeriod.get(period.key)
      const suppliedProviderAmount = toScaled(
        s(providerRow?.provider_amount),
      )
      const fallbackMinutes = toScaled(s(providerRow?.fallback_minutes))
      const fallbackAmount = fallbackMinutes == null || rate == null
        ? null
        : (fallbackMinutes * rate) / 100_000_000n
      const providerClaimed = suppliedProviderAmount == null
        ? fallbackAmount
        : suppliedProviderAmount + (fallbackAmount ?? 0n)
      const invoice = invoiceByPeriod.get(period.key)
      return [
        period.key,
        {
          verified: verified == null ? null : fromScaled(verified),
          providerClaimed:
            providerClaimed == null
              ? null
              : fromScaled(providerClaimed),
          // Verified billing is pre-tax, so compare it with the invoice
          // subtotal. Using the tax-inclusive invoice total would overstate
          // the operational variance by IGST and round-off.
          invoiceSubtotal: s(invoice?.invoice_subtotal),
          currency:
            s(invoice?.currency) ?? s(verifiedRow?.currency) ?? 'INR',
        },
      ]
    }),
  )
}

export async function collectRevenueSnapshots(
  pool: Pool,
  selectedPeriod: BillingMonthScope | null = null,
): Promise<RawRevenueSnapshot[]> {
  if (selectedPeriod) {
    const prior = previousBillingMonth(selectedPeriod)
    const amounts = await collectPeriodAmounts(pool, [
      {
        key: 'monthly:current',
        start: selectedPeriod.start,
        end: selectedPeriod.end,
      },
      {
        key: 'monthly:prior',
        start: prior.start,
        end: prior.end,
      },
    ])
    const current = amounts.get('monthly:current') ?? {
      verified: null,
      providerClaimed: null,
      invoiceSubtotal: null,
      currency: 'INR',
    }
    const priorAmounts = amounts.get('monthly:prior') ?? {
      verified: null,
      providerClaimed: null,
      invoiceSubtotal: null,
      currency: current.currency,
    }
    return [{
      cadence: 'monthly',
      label: selectedPeriod.label,
      start: selectedPeriod.start,
      end: selectedPeriod.end,
      currency: current.currency,
      verified: current.verified,
      vendorClaimed:
        current.invoiceSubtotal ?? current.providerClaimed,
      vendorClaimedBasis:
        current.invoiceSubtotal != null
          ? 'invoiced'
          : current.providerClaimed != null
            ? 'provider_claimed_no_invoice'
            : 'unavailable',
      priorVerified: priorAmounts.verified,
      priorVendorClaimed:
        priorAmounts.invoiceSubtotal ?? priorAmounts.providerClaimed,
    }]
  }
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
        invoiceSubtotal: null,
        currency: 'INR',
      }
    const prior =
      amounts.get(`${period.cadence}:prior`) ??
      {
        verified: null,
        providerClaimed: null,
        invoiceSubtotal: null,
        currency: current.currency,
      }
    const hasInvoice = current.invoiceSubtotal != null
    const priorHasInvoice = prior.invoiceSubtotal != null
    return {
      cadence: period.cadence,
      label: period.label,
      start: period.start,
      end: period.end,
      currency: current.currency,
      verified: current.verified,
      vendorClaimed: hasInvoice
        ? current.invoiceSubtotal
        : current.providerClaimed,
      vendorClaimedBasis: hasInvoice
        ? 'invoiced'
        : current.providerClaimed != null
          ? 'provider_claimed_no_invoice'
          : 'unavailable',
      priorVerified: prior.verified,
      priorVendorClaimed: priorHasInvoice
        ? prior.invoiceSubtotal
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
