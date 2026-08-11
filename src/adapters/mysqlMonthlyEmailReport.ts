import type { Pool, RowDataPacket } from 'mysql2/promise'
import type { BillingMonthScope } from '../reporting/billingMonth.ts'
import {
  buildMonthlyEmailReport,
  type MonthlyEmailReport,
  type MonthlyReportInputRow,
} from '../reporting/monthlyEmailReport.ts'

interface ReportRow extends RowDataPacket {
  call_reference: string
  category: string | null
  confidence: string | null
  calculation_basis: string
  vendor_billed_minutes: string
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
    rows: rows.map(
      (row): MonthlyReportInputRow => ({
        callReference: row.call_reference,
        category: row.category || 'NO_RECORDING',
        confidence: row.confidence,
        resolution: row.calculation_basis,
        vendorBilledMinutes: row.vendor_billed_minutes,
        verifiedBillableDurationMs: Number(
          row.billable_duration_ms,
        ),
        verifiedAmount: row.verified_amount,
        currency: row.currency,
      }),
    ),
  })
}

