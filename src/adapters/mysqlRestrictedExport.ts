import type { Pool, RowDataPacket } from 'mysql2/promise'
import type { BillingMonthScope } from '../reporting/billingMonth.ts'
import { canViewCallContent } from '../identity/access.ts'

/**
 * The month's most disputable calls, with the evidence behind them.
 *
 * This is the RESTRICTED half of the review pack: it carries transcript text
 * and the recording location, which the vendor-facing export deliberately does
 * not. It exists so an administrator can walk into a meeting able to answer
 * "play me that call" — not so a file of customer conversations can be handed
 * across a table.
 *
 * Three things bound it, and all three are deliberate:
 *
 *   * per-call sensitivity, applied with the SAME rule the per-call review
 *     screen uses, so a bulk download can never surface a call its downloader
 *     could not open one at a time;
 *   * a row cap, because a month is tens of thousands of calls and a meeting
 *     needs the worst of them, not all of them; and
 *   * ordering by duration variance, so the cap keeps the calls actually worth
 *     discussing rather than an arbitrary alphabetical slice.
 */

interface RestrictedRow extends RowDataPacket {
  call_reference: string
  sensitivity_tier: string
  category: string | null
  calculation_basis: string
  claimed_duration_ms: number | string | null
  connected_duration_ms: number | string | null
  adjusted_chargeable_duration_ms: number | string | null
  recorded_duration_ms: number | string | null
  vendor_billed_minutes: string | null
  vendor_billed_amount: string | null
  verified_amount: string | null
  currency: string | null
  language: string | null
  recording_source_url: string | null
  evidence_sha256: string | null
  transcript_id: string | null
}

interface SegmentRow extends RowDataPacket {
  start_ms: number | string
  end_ms: number | string
  text: string | null
}

export interface RestrictedExportRow {
  callReference: string
  category: string | null
  resolution: string
  language: string | null
  claimedDurationMs: number | null
  connectedDurationMs: number | null
  adjustedChargeableDurationMs: number | null
  recordedDurationMs: number | null
  durationVarianceMs: number | null
  vendorBilledMinutes: string | null
  vendorBilledAmount: string | null
  verifiedAmount: string | null
  currency: string | null
  evidenceSha256: string | null
  /** The stored recording location, exactly as the vendor supplied it. */
  recordingSourceUrl: string | null
  /** The transcript as one block of text, segments joined in time order. */
  transcript: string
}

export interface RestrictedExport {
  period: BillingMonthScope
  generatedAt: string
  rows: RestrictedExportRow[]
  /** Rows the requester's own sensitivity tier does not permit. */
  withheldForSensitivity: number
  /** True when the cap cut the result short, so a reader knows it is partial. */
  truncated: boolean
  rowCap: number
}

function ms(value: number | string | null): number | null {
  if (value == null) return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? Math.round(parsed) : null
}

export async function collectRestrictedExport(
  pool: Pool,
  options: {
    period: BillingMonthScope
    generatedAt: string
    /** The downloader's own ceiling; never widened by this function. */
    viewerMaxSensitivityTier: string
    rowCap: number
  },
): Promise<RestrictedExport> {
  const [rows] = await pool.execute<RestrictedRow[]>(
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
       c.sensitivity_tier,
       c.canonical_outcome_code AS category,
       calculation.calculation_basis,
       calculation.claimed_duration_ms,
       calculation.connected_duration_ms,
       calculation.adjusted_chargeable_duration_ms,
       calculation.recorded_duration_ms,
       CAST(minutes.minutes_decimal AS CHAR) AS vendor_billed_minutes,
       CAST(amount.quantity_decimal AS CHAR) AS vendor_billed_amount,
       CAST(calculation.total_amount AS CHAR) AS verified_amount,
       calculation.currency,
       transcript.language,
       transcript.id AS transcript_id,
       recording.source_url AS recording_source_url,
       recording.sha256 AS evidence_sha256
     FROM kaudit_call c
     JOIN kaudit_billing_calculation calculation
       ON calculation.call_id = c.id
      AND calculation.status = 'final'
      AND NOT EXISTS (
        SELECT 1
        FROM kaudit_billing_calculation newer
        WHERE newer.supersedes_calculation_id = calculation.id
      )
     LEFT JOIN kaudit_call_artifact recording
       ON recording.call_id = c.id
      AND recording.artifact_type = 'recording'
      AND recording.is_final = 1
     LEFT JOIN kaudit_transcript transcript
       ON transcript.call_artifact_id = recording.id
      AND transcript.status = 'completed'
      AND transcript.id = (
        SELECT latest.id
        FROM kaudit_transcript latest
        WHERE latest.call_artifact_id = recording.id
          AND latest.status = 'completed'
        ORDER BY latest.created_at DESC, latest.id DESC
        LIMIT 1
      )
     LEFT JOIN kaudit_provider_cost minutes
       ON minutes.call_id = c.id
      AND minutes.provider_sku = 'vendor_asserted_billed_minutes'
      AND minutes.is_final = 1
     LEFT JOIN kaudit_provider_cost amount
       ON amount.call_id = c.id
      AND amount.provider_sku = 'vendor_asserted_billed_amount'
      AND amount.is_final = 1
     WHERE c.billing_period_date BETWEEN ? AND ?
     -- Worst overcharge first: the cap should keep the calls worth discussing.
     ORDER BY
       COALESCE(calculation.connected_duration_ms, 0)
         - COALESCE(calculation.adjusted_chargeable_duration_ms, 0) DESC,
       c.id
     LIMIT ?`,
    [options.period.start, options.period.end, options.rowCap + 1],
  )

  const truncated = rows.length > options.rowCap
  const visible = rows.slice(0, options.rowCap)
  let withheldForSensitivity = 0
  const exported: RestrictedExportRow[] = []

  for (const row of visible) {
    /**
     * The same gate the per-call screen applies. A bulk download must never be
     * a way around a per-call refusal, and K4 is refused to everyone.
     */
    if (
      !canViewCallContent(
        options.viewerMaxSensitivityTier,
        row.sensitivity_tier,
      )
    ) {
      withheldForSensitivity += 1
      continue
    }
    const segments = row.transcript_id
      ? (
          await pool.execute<SegmentRow[]>(
            `SELECT start_ms, end_ms, text
             FROM kaudit_transcript_segment
             WHERE transcript_id = ?
             ORDER BY start_ms, end_ms, id`,
            [row.transcript_id],
          )
        )[0]
      : []
    const connected = ms(row.connected_duration_ms)
    const chargeable = ms(row.adjusted_chargeable_duration_ms)
    exported.push({
      callReference: row.call_reference,
      category: row.category,
      resolution: row.calculation_basis,
      language: row.language,
      claimedDurationMs: ms(row.claimed_duration_ms),
      connectedDurationMs: connected,
      adjustedChargeableDurationMs: chargeable,
      recordedDurationMs: ms(row.recorded_duration_ms),
      durationVarianceMs:
        connected != null && chargeable != null
          ? connected - chargeable
          : null,
      vendorBilledMinutes: row.vendor_billed_minutes,
      vendorBilledAmount: row.vendor_billed_amount,
      verifiedAmount: row.verified_amount,
      currency: row.currency,
      evidenceSha256: row.evidence_sha256,
      recordingSourceUrl: row.recording_source_url,
      transcript: segments
        .map((segment) =>
          `[${(Number(segment.start_ms) / 1000).toFixed(1)}s] ${segment.text ?? ''}`,
        )
        .join('\n'),
    })
  }

  return {
    period: options.period,
    generatedAt: options.generatedAt,
    rows: exported,
    withheldForSensitivity,
    truncated,
    rowCap: options.rowCap,
  }
}
