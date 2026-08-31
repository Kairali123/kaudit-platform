import type { Pool, RowDataPacket } from 'mysql2/promise'
import type { BillingMonthScope } from '../reporting/billingMonth.ts'
import {
  buildMonthlyEmailReport,
  UNAVAILABLE_MONTHLY_SETTLEMENT,
  type MonthlyEmailReport,
  type MonthlyReportInputRow,
  type MonthlyReportSettlement,
} from '../reporting/monthlyEmailReport.ts'
import {
  buildKserveSettlementView,
  toSettlementSummary,
} from '../reporting/kserveSettlement.ts'
import { createMysqlKserveSettlementRepository } from './mysqlKserveSettlement.ts'
import { createMysqlKserveVendorBilledRepository } from './mysqlKserveVendorBilled.ts'
import { DEFAULT_SETTLEMENT_HISTORY } from '../billing/kserveSettlement.ts'

/**
 * The month's settlement, folded into the report's own shape.
 *
 * It reads through the SAME view builder the Billing Audit page uses, so the
 * emailed PDF and the screen cannot state different "finally paid" or
 * "savings" figures for one month.
 *
 * A FAILED READ IS REPORTED AS `unavailable`, never as null and never as
 * `pending`. The revenue report predates settlements and must still be produced
 * for every month, including the closed periods that will never have one, so a
 * failure does not propagate — but the artifacts must say "temporarily
 * unavailable" for it rather than "not recorded for this period", which would
 * assert something about the month that this run never established. Either read
 * failing is enough: savings needs both sides, so a missing vendor charge is as
 * unknown as a missing settlement.
 */
async function collectSettlement(
  pool: Pool,
  period: BillingMonthScope,
): Promise<MonthlyReportSettlement> {
  try {
    const [vendorBilled, history] = await Promise.all([
      createMysqlKserveVendorBilledRepository(pool).readMonthlyBilledCharge({
        periodStart: period.start,
        periodEnd: period.end,
      }),
      createMysqlKserveSettlementRepository(pool).readHistory(
        period.month,
        DEFAULT_SETTLEMENT_HISTORY,
      ),
    ])
    const summary = toSettlementSummary(
      buildKserveSettlementView({ month: period, vendorBilled, history }),
    )
    return {
      status: summary.status,
      finallyPaidAmount: summary.finallyPaidInr,
      finallyPaidVersion: summary.finallyPaidVersion,
      vendorBilledChargeAmount: summary.vendorBilledChargeInr,
      savingsAmount: summary.savingsInr,
      savingsAvailable: summary.savingsAvailable,
      savingsDirection: summary.savingsDirection,
      currency: summary.currency,
    }
  } catch {
    // The repository has already reduced any driver failure to a bounded typed
    // error; nothing about it is carried into the report. The constant below
    // holds no money, so no figure can be fabricated from a failure.
    return UNAVAILABLE_MONTHLY_SETTLEMENT
  }
}

interface ReportRow extends RowDataPacket {
  call_reference: string
  category: string | null
  confidence: string | null
  calculation_basis: string
  vendor_billed_minutes: string
  vendor_billed_amount: string
  billable_duration_ms: number | string
  verified_amount: string
  currency: string
}

interface InvoiceRow extends RowDataPacket {
  subtotal: string | null
}

export async function collectMonthlyEmailReport(
  pool: Pool,
  options: {
    period: BillingMonthScope
    generatedAt: string
  },
): Promise<MonthlyEmailReport> {
  const [rows] = await pool.execute<ReportRow[]>(
    `SELECT
       COALESCE(
         (
           SELECT external_id
           FROM kaudit_call_external_reference ref
           WHERE ref.call_id = c.id
             AND ref.reference_type IN ('task_id','taskId','task')
           ORDER BY ref.id
           LIMIT 1
         ),
         c.logical_call_key
       ) AS call_reference,
       COALESCE(c.canonical_outcome_code, 'NO_RECORDING')
         AS category,
       CAST((
         SELECT finding.confidence
         FROM kaudit_audit_finding finding
         WHERE finding.call_id = c.id
         ORDER BY finding.created_at DESC, finding.id DESC
         LIMIT 1
       ) AS CHAR) AS confidence,
       calculation.calculation_basis,
       CAST(minutes.minutes_decimal AS CHAR)
         AS vendor_billed_minutes,
       CAST(COALESCE(
         amount.quantity_decimal,
         minutes.minutes_decimal * 9.5
       ) AS CHAR) AS vendor_billed_amount,
       calculation.billable_duration_ms,
       CAST(calculation.total_amount AS CHAR)
         AS verified_amount,
       calculation.currency
     FROM kaudit_call c
     JOIN kaudit_provider_cost minutes
       ON minutes.call_id = c.id
      AND minutes.provider_sku =
            'vendor_asserted_billed_minutes'
      AND minutes.is_final = 1
     JOIN kaudit_billing_calculation calculation
       ON calculation.call_id = c.id
      AND calculation.status = 'final'
      AND calculation.calculation_basis IN (
        'independent_conversation_end',
        'independent_category_service_end',
        'accepted_as_billed_unverified'
      )
      AND calculation.input_manifest_sha256 IS NOT NULL
      AND calculation.ruleset_sha256 IS NOT NULL
      AND calculation.decision_trace_sha256 IS NOT NULL
      AND calculation.finalized_at IS NOT NULL
      AND NOT EXISTS (
        SELECT 1
        FROM kaudit_billing_calculation newer
        WHERE newer.supersedes_calculation_id = calculation.id
      )
     LEFT JOIN kaudit_provider_cost amount
       ON amount.call_id = c.id
      AND amount.provider_sku = 'vendor_asserted_billed_amount'
      AND amount.is_final = 1
     WHERE c.billing_period_date BETWEEN ? AND ?
     ORDER BY call_reference`,
    [options.period.start, options.period.end],
  )
  const [invoiceRows] = await pool.execute<InvoiceRow[]>(
    `SELECT CAST(subtotal_amount AS CHAR) AS subtotal
     FROM kaudit_invoice
     WHERE period_start = ? AND period_end = ?
     ORDER BY revision_no DESC, created_at DESC, id DESC
     LIMIT 1`,
    [options.period.start, options.period.end],
  )
  return buildMonthlyEmailReport({
    period: options.period,
    generatedAt: options.generatedAt,
    invoiceClaimedAmount: invoiceRows[0]?.subtotal ?? null,
    settlement: await collectSettlement(pool, options.period),
    rows: rows.map(
      (row): MonthlyReportInputRow => ({
        callReference: row.call_reference,
        category: row.category || 'NO_RECORDING',
        confidence: row.confidence,
        resolution: row.calculation_basis,
        vendorBilledMinutes: row.vendor_billed_minutes,
        vendorBilledAmount: row.vendor_billed_amount,
        verifiedBillableDurationMs: Number(
          row.billable_duration_ms,
        ),
        verifiedAmount: row.verified_amount,
        currency: row.currency,
      }),
    ),
  })
}
