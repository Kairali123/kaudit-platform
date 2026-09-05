import assert from 'node:assert/strict'
import test from 'node:test'
import { buildMonthlyEmailReport } from './monthlyEmailReport.ts'
import { buildReportCsv, REPORT_CSV_COLUMNS } from './reportCsv.ts'

/**
 * The per-call artefact a vendor is shown. Every fixture is SYNTHETIC: no real
 * call, task id, amount, or invoice appears in this file.
 */
const report = buildMonthlyEmailReport({
  period: {
    month: '2026-06',
    start: '2026-06-01',
    end: '2026-06-30',
    label: 'June 2026',
  },
  generatedAt: '2026-07-01T00:00:00.000Z',
  invoiceClaimedAmount: '38.00',
  rows: [
    {
      callReference: 'synthetic-audited',
      category: 'OK',
      confidence: '0.95',
      resolution: 'independent_audited_projection',
      vendorBilledMinutes: '2',
      vendorBilledAmount: '19.00',
      verifiedBillableDurationMs: 60_000,
      verifiedAmount: '9.50',
      currency: 'INR',
    },
    {
      callReference: 'synthetic-no-recording',
      category: 'NO_RECORDING',
      confidence: null,
      resolution: 'no_recording_zero',
      vendorBilledMinutes: '2',
      vendorBilledAmount: '19.00',
      verifiedBillableDurationMs: 0,
      verifiedAmount: '0.00',
      currency: 'INR',
    },
  ],
})

function dataRows(csv: string): string[] {
  // The BOM sits ahead of the first comment line, so strip it before the
  // comment filter or that line survives as data.
  return csv
    .replace(/^\ufeff/, '')
    .split('\r\n')
    .filter((line) => line.length > 0 && !line.startsWith('#'))
}

test('one row per call, with the reason it resolved that way', () => {
  const rows = dataRows(buildReportCsv(report).toString('utf8'))
  assert.equal(rows.length, 3, 'header plus two calls')
  assert.equal(rows[0], REPORT_CSV_COLUMNS.join(','))
  assert.match(rows[1], /^synthetic-audited,/)
  assert.match(rows[1], /Audited — single-pass/)
  assert.match(rows[1], /,yes,/)
  assert.match(rows[2], /No recording supplied/)
  assert.match(rows[2], /,no,/)
})

test('amounts stay unformatted so a spreadsheet can total them', () => {
  const rows = dataRows(buildReportCsv(report).toString('utf8'))
  // No grouping separators and no currency symbol anywhere in the values.
  for (const line of rows.slice(1)) {
    const cells = line.split(',')
    assert.doesNotMatch(cells.slice(0, 12).join(','), /[₹]|\d,\d{3}/)
  }
  // Shortest-form decimals, exactly as the emailed workbook carries them:
  // two documents shown to the same vendor must not disagree on a figure.
  assert.match(rows[1], /,9\.5,/)
  assert.match(rows[2], /,0,/)
})

test('a value containing a comma or quote cannot break the row', () => {
  const risky = buildMonthlyEmailReport({
    ...{
      period: report.period,
      generatedAt: report.generatedAt,
      invoiceClaimedAmount: null,
    },
    rows: [{
      callReference: 'ref,with"quote',
      category: 'OK',
      confidence: null,
      resolution: 'independent_conversation_end',
      vendorBilledMinutes: '1',
      verifiedBillableDurationMs: 60_000,
      verifiedAmount: '9.50',
      currency: 'INR',
    }],
  })
  const rows = dataRows(buildReportCsv(risky).toString('utf8'))
  assert.equal(rows.length, 2)
  assert.match(rows[1], /^"ref,with""quote"/)
})

test('the file states what produced it and over what period', () => {
  const csv = buildReportCsv(report).toString('utf8')
  assert.match(csv, /# Kairali AI Call Audit — June 2026/)
  assert.match(csv, /# period,2026-06-01 to 2026-06-30/)
  assert.match(csv, /# source_manifest_sha256,[a-f0-9]{64}/)
  assert.match(csv, /# variance_vs_invoice,/)
  // Excel needs the BOM or the rupee sign and any non-ASCII reference mangles.
  assert.equal(csv.charCodeAt(0), 0xfeff)
})

test('it carries no evidence, transcript, or recording location', () => {
  const csv = buildReportCsv(report).toString('utf8').toLowerCase()
  for (const forbidden of [
    'http', 'transcript', 'sourceurl', 'source_url', 'sha256:',
    'phone', 'recording',
  ]) {
    if (forbidden === 'recording') {
      // "No recording supplied" is a reason, not a location.
      assert.doesNotMatch(csv, /recording_url|recordingurl/)
      continue
    }
    assert.equal(csv.includes(forbidden), false, forbidden)
  }
})

test('the breakdown splits the variance by how each call resolved', () => {
  const groups = report.resolutionBreakdown
  assert.equal(groups.length, 2)
  const noRecording = groups.find(
    (group) => group.basis === 'no_recording_zero',
  )
  assert.ok(noRecording)
  assert.equal(noRecording.calls, 1)
  assert.equal(noRecording.verifiedAmount, '0')
  assert.equal(noRecording.independentlyMeasured, false)
  // Largest contribution to the variance leads.
  assert.equal(groups[0].basis, 'no_recording_zero')
  // An audited call is counted as measured, including the single-pass basis.
  assert.equal(report.summary.independentlyAuditedCalls, 1)
  assert.equal(report.summary.acceptedAsBilledCalls, 1)
})
