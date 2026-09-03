import type { Pool, RowDataPacket } from 'mysql2/promise'
import type { BillingCycleCounts } from '../billing/cycleReadiness.ts'
import type { BillingMonthScope } from '../reporting/billingMonth.ts'
import { isDatabaseStatementTimeout } from './mysqlReadTimeout.ts'

interface PeriodRow extends RowDataPacket {
  period_start: string | null
  period_end: string | null
}

interface BaseCountRow extends RowDataPacket {
  total_calls: number | string
  recording_available_calls: number | string
  completed_audit_calls: number | string
  processing_failure_calls: number | string
}

interface FinalCountRow extends RowDataPacket {
  accepted_as_billed_calls: number | string
  final_calculation_calls: number | string
  calculated_total: string | null
  billable_minutes: string | null
  currency: string | null
}

interface UnresolvedCountRow extends RowDataPacket {
  unresolved_decision_calls: number | string
}

function n(value: number | string | null | undefined): number {
  return Number(value || 0)
}

export interface LatestBillingCycleData extends BillingCycleCounts {
  calculatedTotal: string | null
  billableMinutes: string | null
  currency: string
}

export async function collectLatestBillingCycle(
  pool: Pool,
  selectedPeriod: BillingMonthScope | null = null,
): Promise<LatestBillingCycleData> {
  const period = selectedPeriod
    ? {
        period_start: selectedPeriod.start,
        period_end: selectedPeriod.end,
      }
    : (
        await pool.query<PeriodRow[]>(
          `SELECT
             DATE_FORMAT(MAX(billing_period_date), '%Y-%m-01') AS period_start,
             CAST(LAST_DAY(MAX(billing_period_date)) AS CHAR) AS period_end
           FROM kaudit_call
           WHERE billing_period_date IS NOT NULL`,
        )
      )[0][0]
  if (!period?.period_start || !period.period_end) {
    return {
      periodStart: null,
      periodEnd: null,
      totalCalls: 0,
      recordingAvailableCalls: 0,
      completedAuditCalls: 0,
      acceptedAsBilledCalls: 0,
      finalCalculationCalls: 0,
      unresolvedDecisionCalls: 0,
      processingFailureCalls: 0,
      calculatedTotal: null,
      billableMinutes: null,
      currency: 'INR',
    }
  }
  const parameters = [period.period_start, period.period_end]
  const [baseResult] = await pool.query<BaseCountRow[]>(
    `SELECT
       COUNT(*) AS total_calls,
       SUM(EXISTS (
         SELECT 1
         FROM kaudit_call_artifact artifact
         WHERE artifact.call_id = call_row.id
           AND artifact.artifact_type = 'recording'
           AND artifact.is_final = 1
           AND artifact.source_url IS NOT NULL
       )) AS recording_available_calls,
       SUM(EXISTS (
         SELECT 1
         FROM kaudit_audit_run audit_run
         WHERE audit_run.call_id = call_row.id
           AND audit_run.engine_version =
             'kairali-independent-reaudit/2.0.0'
           AND audit_run.status = 'completed'
       )) AS completed_audit_calls,
       SUM(EXISTS (
         SELECT 1
         FROM kaudit_call_artifact failed_artifact
         WHERE failed_artifact.call_id = call_row.id
           AND failed_artifact.artifact_type = 'recording'
           AND failed_artifact.is_final = 1
           AND failed_artifact.audio_processing_status IN (
             'fetch_failed',
             'transcribe_failed',
             'classify_failed',
             'exhausted'
           )
       )) AS processing_failure_calls
     FROM kaudit_call call_row
     WHERE call_row.billing_period_date BETWEEN ? AND ?`,
    parameters,
  )

  // Migration 0006 adds calculation_basis and the automated decision table.
  // Until it is applied, these values intentionally remain unavailable instead
  // of treating legacy calculations as a completed bill.
  let finalCounts: FinalCountRow | null = null
  let unresolvedCounts: UnresolvedCountRow | null = null
  try {
    const [rows] = await pool.query<FinalCountRow[]>(
      `SELECT
         COUNT(DISTINCT CASE
           WHEN calculation.calculation_basis IN (
             'accepted_as_billed_unverified',
             'no_recording_zero'
           )
           THEN calculation.call_id
         END) AS accepted_as_billed_calls,
         COUNT(DISTINCT calculation.call_id) AS final_calculation_calls,
         CAST(SUM(calculation.total_amount) AS CHAR) AS calculated_total,
         CAST(SUM(calculation.billable_duration_ms) / 60000 AS CHAR)
           AS billable_minutes,
         MAX(calculation.currency) AS currency
       FROM kaudit_billing_calculation calculation
       JOIN kaudit_call call_row ON call_row.id = calculation.call_id
       WHERE call_row.billing_period_date BETWEEN ? AND ?
         AND calculation.status = 'final'
         AND calculation.calculation_basis IN (
           'independent_conversation_end',
           'independent_category_service_end',
           'accepted_as_billed_unverified',
           'no_recording_zero'
         )
         AND (
           (calculation.calculation_basis IN (
              'independent_conversation_end',
              'independent_category_service_end'
            )
            AND calculation.audit_run_id IS NOT NULL)
           OR calculation.calculation_basis IN (
              'accepted_as_billed_unverified',
              'no_recording_zero'
           )
         )
         AND calculation.input_manifest_sha256 IS NOT NULL
         AND calculation.ruleset_sha256 IS NOT NULL
         AND calculation.decision_trace_sha256 IS NOT NULL
         AND calculation.finalized_at IS NOT NULL
         AND NOT EXISTS (
           SELECT 1
           FROM kaudit_billing_calculation newer
           WHERE newer.supersedes_calculation_id = calculation.id
         )`,
      parameters,
    )
    finalCounts = rows[0] ?? null
  } catch (error) {
    if (isDatabaseStatementTimeout(error)) throw error
    finalCounts = null
  }
  try {
    const [rows] = await pool.query<UnresolvedCountRow[]>(
      `SELECT COUNT(DISTINCT decision_row.call_id) AS unresolved_decision_calls
       FROM kaudit_automated_decision decision_row
       JOIN kaudit_call call_row ON call_row.id = decision_row.call_id
       WHERE call_row.billing_period_date BETWEEN ? AND ?
         AND decision_row.decision_status = 'unresolved'
         AND NOT EXISTS (
           SELECT 1
           FROM kaudit_automated_decision newer
           WHERE newer.supersedes_decision_id = decision_row.id
         )`,
      parameters,
    )
    unresolvedCounts = rows[0] ?? null
  } catch (error) {
    if (isDatabaseStatementTimeout(error)) throw error
    unresolvedCounts = null
  }
  const base = baseResult[0]
  return {
    periodStart: String(period.period_start),
    periodEnd: String(period.period_end),
    totalCalls: n(base?.total_calls),
    recordingAvailableCalls: n(base?.recording_available_calls),
    completedAuditCalls: n(base?.completed_audit_calls),
    acceptedAsBilledCalls: n(finalCounts?.accepted_as_billed_calls),
    finalCalculationCalls:
      finalCounts == null ? null : n(finalCounts.final_calculation_calls),
    unresolvedDecisionCalls:
      unresolvedCounts == null
        ? null
        : n(unresolvedCounts.unresolved_decision_calls),
    processingFailureCalls: n(base?.processing_failure_calls),
    calculatedTotal: finalCounts?.calculated_total ?? null,
    billableMinutes: finalCounts?.billable_minutes ?? null,
    currency: finalCounts?.currency ?? 'INR',
  }
}
