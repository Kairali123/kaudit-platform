import type { Pool, RowDataPacket } from 'mysql2/promise'
import type { BillingMonthScope } from '../reporting/billingMonth.ts'
import {
  buildMonthlyEmailReport,
  buildMonthlySummaryReport,
  UNAVAILABLE_MONTHLY_SETTLEMENT,
  type MonthlyEmailReport,
  type MonthlyReportAggregateInput,
  type MonthlyReportInputRow,
  type MonthlyReportSettlement,
} from '../reporting/monthlyEmailReport.ts'
import {
  buildKserveSettlementView,
  toSettlementSummary,
} from '../reporting/kserveSettlement.ts'
import { createMysqlKserveSettlementRepository } from './mysqlKserveSettlement.ts'
import {
  createMysqlKserveVendorBilledRepository,
  KSERVE_VENDOR_RATE_PER_MINUTE,
  vendorBilledAssertionsSql,
} from './mysqlKserveVendorBilled.ts'
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
  billing_period_date: Date | string | null
  claimed_duration_ms: number | string | null
  connected_duration_ms: number | string | null
  recorded_duration_ms: number | string | null
  speech_duration_ms: number | string | null
  conversation_end_ms: number | string | null
  wrap_up_grace_ms: number | string | null
  adjusted_chargeable_duration_ms: number | string | null
  one_way_tail_ms: number | string | null
  one_way_tail_alert: number | string | null
  billing_engine_version: string | null
  ruleset_sha256: string | null
  input_manifest_sha256: string | null
  decision_trace_sha256: string | null
  finalized_at: string | null
  audit_engine_version: string | null
  evidence_sha256: string | null
  evidence_verified_at: string | null
  audio_processing_status: string | null
  audio_attempt_count: number | string | null
}

interface InvoiceRow extends RowDataPacket {
  subtotal: string | null
}

interface ReportAggregateRow extends RowDataPacket {
  calculation_basis: string
  calls: number | string
  vendor_billed_amount: string
  verified_amount: string
  currency: string
}

const FINAL_CALCULATION_EVIDENCE = `calculation.status = 'final'
      AND calculation.calculation_basis IN (
        'independent_conversation_end',
        'independent_category_service_end',
        'independent_audited_projection',
        'accepted_as_billed_unverified',
        'no_recording_zero'
      )
      AND calculation.input_manifest_sha256 IS NOT NULL
      AND calculation.ruleset_sha256 IS NOT NULL
      AND calculation.decision_trace_sha256 IS NOT NULL
      AND calculation.finalized_at IS NOT NULL`

/**
 * Collects only the grouped facts rendered by the summary PDF.
 *
 * Provider assertions are scoped to the selected month before grouping, and
 * MAX preserves their revision semantics. The result is one row per billing
 * basis instead of one row per call with evidence metadata.
 */
export async function collectMonthlyPdfReport(
  pool: Pool,
  options: {
    period: BillingMonthScope
    generatedAt: string
  },
): Promise<MonthlyEmailReport> {
  const [rows] = await pool.query<ReportAggregateRow[]>(
    `WITH provider_claim AS (
       ${vendorBilledAssertionsSql()}
     )
     SELECT
       calculation.calculation_basis,
       COUNT(*) AS calls,
       CAST(SUM(COALESCE(
         vendor.amount_decimal,
         vendor.minutes_decimal * ${KSERVE_VENDOR_RATE_PER_MINUTE}
       )) AS CHAR) AS vendor_billed_amount,
       CAST(SUM(calculation.total_amount) AS CHAR) AS verified_amount,
       MAX(calculation.currency) AS currency
     FROM provider_claim vendor
     STRAIGHT_JOIN kaudit_call c
       ON c.id = vendor.call_id
     STRAIGHT_JOIN kaudit_billing_calculation calculation
       ON calculation.call_id = c.id
      AND ${FINAL_CALCULATION_EVIDENCE}
     LEFT JOIN kaudit_billing_calculation newer
       ON newer.supersedes_calculation_id = calculation.id
     WHERE c.billing_period_date BETWEEN ? AND ?
       AND vendor.minutes_decimal IS NOT NULL
       AND newer.id IS NULL
     GROUP BY calculation.calculation_basis`,
    [options.period.start, options.period.end],
  )
  const [invoiceRows] = await pool.query<InvoiceRow[]>(
    `SELECT CAST(subtotal_amount AS CHAR) AS subtotal
     FROM kaudit_invoice
     WHERE period_start = ? AND period_end = ?
     ORDER BY revision_no DESC, created_at DESC, id DESC
     LIMIT 1`,
    [options.period.start, options.period.end],
  )
  return buildMonthlySummaryReport({
    period: options.period,
    generatedAt: options.generatedAt,
    invoiceClaimedAmount: invoiceRows[0]?.subtotal ?? null,
    settlement: await collectSettlement(pool, options.period),
    groups: rows.map(
      (row): MonthlyReportAggregateInput => ({
        resolution: row.calculation_basis,
        calls: Number(row.calls),
        vendorAmount: row.vendor_billed_amount,
        verifiedAmount: row.verified_amount,
        currency: row.currency,
      }),
    ),
  })
}

function ms(value: number | string | null): number | null {
  if (value == null) return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? Math.round(parsed) : null
}

/** The bill month's date as YYYY-MM-DD, with no timezone reinterpretation. */
function isoDay(value: Date | string | null): string | null {
  if (value == null) return null
  return typeof value === 'string'
    ? value.slice(0, 10)
    : `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`
}

export async function collectMonthlyEmailReport(
  pool: Pool,
  options: {
    period: BillingMonthScope
    generatedAt: string
    /** Summary email/XLSX need settlement; the per-call CSV does not. */
    includeSettlement?: boolean
  },
): Promise<MonthlyEmailReport> {
  const [rows] = await pool.query<ReportRow[]>(
    `WITH provider_claim AS (
       ${vendorBilledAssertionsSql()}
     )
     SELECT
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
       CAST(vendor.minutes_decimal AS CHAR)
         AS vendor_billed_minutes,
       CAST(COALESCE(
         vendor.amount_decimal,
         vendor.minutes_decimal * ${KSERVE_VENDOR_RATE_PER_MINUTE}
       ) AS CHAR) AS vendor_billed_amount,
       calculation.billable_duration_ms,
       CAST(calculation.total_amount AS CHAR)
         AS verified_amount,
       calculation.currency,
       c.billing_period_date,
       -- KServe's own durations, as supplied.
       calculation.claimed_duration_ms,
       calculation.connected_duration_ms,
       -- What this platform measured from the recording.
       calculation.recorded_duration_ms,
       calculation.speech_duration_ms,
       calculation.conversation_end_ms,
       calculation.wrap_up_grace_ms,
       calculation.adjusted_chargeable_duration_ms,
       calculation.one_way_tail_ms,
       calculation.one_way_tail_alert,
       -- Provenance a vendor can check a disputed line against.
       calculation.engine_version AS billing_engine_version,
       calculation.ruleset_sha256,
       calculation.input_manifest_sha256,
       calculation.decision_trace_sha256,
       CAST(calculation.finalized_at AS CHAR) AS finalized_at,
       audit_run.engine_version AS audit_engine_version,
       -- The evidence hash proves which bytes were audited WITHOUT shipping
       -- them: the vendor can hash the file they supplied and compare.
       evidence_artifact.sha256 AS evidence_sha256,
       CAST(evidence_artifact.last_verified_at AS CHAR)
         AS evidence_verified_at,
       evidence_artifact.audio_processing_status,
       evidence_artifact.audio_attempt_count
     FROM provider_claim vendor
     STRAIGHT_JOIN kaudit_call c
       ON c.id = vendor.call_id
     STRAIGHT_JOIN kaudit_billing_calculation calculation
       ON calculation.call_id = c.id
      AND ${FINAL_CALCULATION_EVIDENCE}
     LEFT JOIN kaudit_billing_calculation newer
       ON newer.supersedes_calculation_id = calculation.id
     LEFT JOIN kaudit_audit_run audit_run
       ON audit_run.id = calculation.audit_run_id
     LEFT JOIN kaudit_call_artifact evidence_artifact
       ON evidence_artifact.call_id = c.id
      AND evidence_artifact.artifact_type = 'recording'
      AND evidence_artifact.is_final = 1
     WHERE c.billing_period_date BETWEEN ? AND ?
       AND vendor.minutes_decimal IS NOT NULL
       AND newer.id IS NULL
     ORDER BY c.billing_period_date, c.id`,
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
    settlement: options.includeSettlement === false
      ? null
      : await collectSettlement(pool, options.period),
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
        detail: {
          billingPeriodDate: isoDay(row.billing_period_date),
          claimedDurationMs: ms(row.claimed_duration_ms),
          connectedDurationMs: ms(row.connected_duration_ms),
          recordedDurationMs: ms(row.recorded_duration_ms),
          speechDurationMs: ms(row.speech_duration_ms),
          conversationEndMs: ms(row.conversation_end_ms),
          wrapUpGraceMs: ms(row.wrap_up_grace_ms),
          adjustedChargeableDurationMs: ms(
            row.adjusted_chargeable_duration_ms,
          ),
          oneWayTailMs: ms(row.one_way_tail_ms),
          oneWayTailAlert:
            row.one_way_tail_alert == null
              ? null
              : Number(row.one_way_tail_alert) === 1,
          billingEngineVersion: row.billing_engine_version,
          auditEngineVersion: row.audit_engine_version,
          rulesetSha256: row.ruleset_sha256,
          inputManifestSha256: row.input_manifest_sha256,
          decisionTraceSha256: row.decision_trace_sha256,
          finalizedAt: row.finalized_at,
          evidenceSha256: row.evidence_sha256,
          evidenceVerifiedAt: row.evidence_verified_at,
          processingStatus: row.audio_processing_status,
          attemptCount: ms(row.audio_attempt_count),
        },
      }),
    ),
  })
}
