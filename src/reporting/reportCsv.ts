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

export const REPORT_CSV_COLUMNS = [
  'call_reference',
  'resolution',
  'resolution_basis',
  'independently_measured',
  'category',
  'confidence',
  'kserve_billed_minutes',
  'kserve_billed_amount',
  'audited_billable_minutes',
  'audited_amount',
  'variance_amount',
  'currency',
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
    lines.push(row([
      line.callReference,
      resolution.label,
      line.resolution,
      resolution.independentlyMeasured ? 'yes' : 'no',
      line.category,
      line.confidence,
      line.vendorBilledMinutes,
      line.vendorAmount,
      line.verifiedBillableMinutes,
      line.verifiedAmount,
      line.variance,
      line.currency,
      resolution.explanation,
    ]))
  }
  // Excel opens UTF-8 as the local codepage without a BOM, which mangles the
  // rupee sign and any non-ASCII reference the vendor may use.
  return Buffer.from(`﻿${lines.join('\r\n')}\r\n`, 'utf8')
}
