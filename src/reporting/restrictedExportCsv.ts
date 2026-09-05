import type { RestrictedExport } from '../adapters/mysqlRestrictedExport.ts'
import { resolutionLabel } from './resolutionLabels.ts'

/**
 * The restricted per-call export, as a file.
 *
 * It carries transcript text and the recording location. That is the whole
 * point of it and also the whole risk: the vendor pack exists precisely so this
 * file never has to be the one handed across a table. The header says so in the
 * file itself, because a CSV outlives the conversation in which it was
 * explained, and the person who opens it in six months will not have been in
 * the room.
 */

function cell(value: string | number | null | undefined): string {
  if (value == null) return ''
  const text = String(value)
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}

function row(values: (string | number | null | undefined)[]): string {
  return values.map(cell).join(',')
}

function seconds(value: number | null): string {
  return value == null ? '' : (value / 1000).toFixed(3)
}

export const RESTRICTED_CSV_COLUMNS = [
  'call_reference',
  'resolution',
  'category',
  'language',
  'kserve_billed_minutes',
  'kserve_billed_amount',
  'kserve_connected_duration_sec',
  'audited_chargeable_duration_sec',
  'audited_recorded_duration_sec',
  'duration_variance_sec',
  'audited_amount',
  'currency',
  'evidence_sha256',
  'recording_source_url',
  'transcript',
] as const

export const RESTRICTED_EXPORT_BANNER =
  'RESTRICTED — contains call transcripts and recording locations. Not for the vendor or any third party.'

export function buildRestrictedExportCsv(
  report: RestrictedExport,
): Buffer {
  const lines: string[] = []
  lines.push(`# ${RESTRICTED_EXPORT_BANNER}`)
  lines.push(`# period,${report.period.start} to ${report.period.end}`)
  lines.push(`# generated,${report.generatedAt}`)
  lines.push(`# rows,${report.rows.length}`)
  /**
   * Both bounds are stated, because a partial file that does not say it is
   * partial gets read as the whole month.
   */
  lines.push(
    `# ordering,highest KServe-minus-audited duration first (row cap ${report.rowCap})`,
  )
  lines.push(`# truncated,${report.truncated ? 'yes' : 'no'}`)
  lines.push(
    `# withheld_for_sensitivity,${report.withheldForSensitivity}`,
  )
  lines.push(row([...RESTRICTED_CSV_COLUMNS]))

  for (const line of report.rows) {
    lines.push(row([
      line.callReference,
      resolutionLabel(line.resolution).label,
      line.category,
      line.language,
      line.vendorBilledMinutes,
      line.vendorBilledAmount,
      seconds(line.connectedDurationMs),
      seconds(line.adjustedChargeableDurationMs),
      seconds(line.recordedDurationMs),
      seconds(line.durationVarianceMs),
      line.verifiedAmount,
      line.currency,
      line.evidenceSha256,
      line.recordingSourceUrl,
      line.transcript,
    ]))
  }
  return Buffer.from(`﻿${lines.join('\r\n')}\r\n`, 'utf8')
}
