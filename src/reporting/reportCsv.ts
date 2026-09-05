import type { MonthlyEmailReport } from './monthlyEmailReport.ts'
import { resolutionLabel } from './resolutionLabels.ts'

/**
 * The per-call audit, one row per call, for review beside the vendor's own bill.
 *
 * It carries the vendor's figures and this platform's figures side by side with
 * the reason each call resolved the way it did, so a disputed line can be
 * answered from the row rather than from a conversation. Every amount is the
 * stored fixed-precision decimal, unrounded and unformatted: a spreadsheet
 * should be able to total the column and reach the same figure the platform
 * reports, and thousands separators or symbols would defeat that.
 *
 * It carries no transcript, no recording URL, no phone number and no customer
 * text. The call reference is the vendor's own task identifier — the thing both
 * sides already use to name a call — and nothing beyond it.
 */

/** RFC 4180: quote anything that could otherwise break a cell or a row. */
function cell(value: string | number | null | undefined): string {
  if (value == null) return ''
  const text = String(value)
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}

function row(values: (string | number | null | undefined)[]): string {
  return values.map(cell).join(',')
}

/** Milliseconds as whole seconds, the unit a vendor's own bill uses. */
function seconds(value: number | null | undefined): string {
  return value == null ? '' : (value / 1000).toFixed(3)
}

export const REPORT_CSV_COLUMNS = [
  'call_reference',
  'bill_month',
  'resolution',
  'resolution_basis',
  'independently_measured',
  'category',
  'confidence',
  // What KServe asserted.
  'kserve_billed_minutes',
  'kserve_billed_amount',
  'kserve_duration_with_ringing_sec',
  'kserve_connected_duration_sec',
  // What this platform measured from the recording it was given.
  'audited_recorded_duration_sec',
  'audited_speech_duration_sec',
  'audited_conversation_end_sec',
  'audited_wrap_up_grace_sec',
  'audited_chargeable_duration_sec',
  'audited_billable_minutes',
  'audited_amount',
  // The comparison the meeting is actually about.
  'duration_variance_sec',
  'variance_amount',
  'currency',
  // One-way audio is a quality finding, not a charge.
  'one_way_tail_sec',
  'one_way_tail_alert',
  // Evidence identity: which bytes were audited, and whether re-verified.
  'evidence_sha256',
  'evidence_verified_at',
  'processing_status',
  'attempt_count',
  // Provenance, so any single line can be traced back and re-derived.
  'audit_engine_version',
  'billing_engine_version',
  'ruleset_sha256',
  'input_manifest_sha256',
  'decision_trace_sha256',
  'finalized_at',
  'resolution_explanation',
] as const

export function buildReportCsv(report: MonthlyEmailReport): Buffer {
  const lines: string[] = []
  /**
   * A short provenance preamble, commented with `#`.
   *
   * The file will be forwarded, renamed and opened months later, so it has to
   * carry what it is and what produced it. Spreadsheets treat leading `#` rows
   * as data, so the header row still follows immediately and the columns stay
   * machine-readable.
   */
  lines.push(`# Kairali AI Call Audit — ${report.period.label}`)
  lines.push(`# period,${report.period.start} to ${report.period.end}`)
  lines.push(`# generated,${report.generatedAt}`)
  lines.push(`# report_version,${report.reportVersion}`)
  lines.push(`# source_manifest_sha256,${report.sourceManifestSha256}`)
  lines.push(`# total_calls,${report.summary.totalCalls}`)
  lines.push(
    `# kserve_invoice_claimed,${report.summary.invoiceClaimedAmount ?? 'unavailable'}`,
  )
  lines.push(
    `# kserve_usage_total,${report.summary.vendorUsageAmount}`,
  )
  lines.push(
    `# audited_verified_total,${report.summary.verifiedBillableRevenue}`,
  )
  lines.push(
    `# variance_vs_invoice,${report.summary.revenueVarianceVsInvoice ?? 'unavailable'}`,
  )
  lines.push(
    `# amounts are unformatted fixed-precision ${report.summary.currency}`,
  )
  lines.push(row([...REPORT_CSV_COLUMNS]))

  for (const line of report.rows) {
    const resolution = resolutionLabel(line.resolution)
    const detail = line.detail
    /**
     * The duration comparison, stated once so the reader does not have to do
     * it. KServe's connected time less the chargeable time this platform
     * measured: positive means they billed for longer than the conversation
     * lasted. Absent whenever either side is missing, rather than treating an
     * unknown as a zero.
     */
    const durationVariance =
      detail?.connectedDurationMs != null &&
      detail.adjustedChargeableDurationMs != null
        ? detail.connectedDurationMs - detail.adjustedChargeableDurationMs
        : null
    lines.push(row([
      line.callReference,
      detail?.billingPeriodDate,
      resolution.label,
      line.resolution,
      resolution.independentlyMeasured ? 'yes' : 'no',
      line.category,
      line.confidence,
      line.vendorBilledMinutes,
      line.vendorAmount,
      seconds(detail?.claimedDurationMs),
      seconds(detail?.connectedDurationMs),
      seconds(detail?.recordedDurationMs),
      seconds(detail?.speechDurationMs),
      seconds(detail?.conversationEndMs),
      seconds(detail?.wrapUpGraceMs),
      seconds(detail?.adjustedChargeableDurationMs),
      line.verifiedBillableMinutes,
      line.verifiedAmount,
      seconds(durationVariance),
      line.variance,
      line.currency,
      seconds(detail?.oneWayTailMs),
      detail?.oneWayTailAlert == null
        ? ''
        : detail.oneWayTailAlert ? 'yes' : 'no',
      detail?.evidenceSha256,
      detail?.evidenceVerifiedAt,
      detail?.processingStatus,
      detail?.attemptCount,
      detail?.auditEngineVersion,
      detail?.billingEngineVersion,
      detail?.rulesetSha256,
      detail?.inputManifestSha256,
      detail?.decisionTraceSha256,
      detail?.finalizedAt,
      resolution.explanation,
    ]))
  }
  // Excel opens UTF-8 as the local codepage without a BOM, which mangles the
  // rupee sign and any non-ASCII reference the vendor may use.
  return Buffer.from(`﻿${lines.join('\r\n')}\r\n`, 'utf8')
}
