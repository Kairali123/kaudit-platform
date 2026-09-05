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
      detail: {
        billingPeriodDate: '2026-06-14',
        claimedDurationMs: 132_000,
        connectedDurationMs: 120_000,
        recordedDurationMs: 118_000,
        speechDurationMs: 40_000,
        conversationEndMs: 47_000,
        wrapUpGraceMs: 60_000,
        adjustedChargeableDurationMs: 107_000,
        oneWayTailMs: 11_000,
        oneWayTailAlert: false,
        billingEngineVersion: 'kserve-verified-billing/1.1.0',
        auditEngineVersion: 'kairali-independent-reaudit/2.6.5',
        rulesetSha256: 'a'.repeat(64),
        inputManifestSha256: 'b'.repeat(64),
        decisionTraceSha256: 'c'.repeat(64),
        finalizedAt: '2026-06-30 18:29:59',
        evidenceSha256: 'd'.repeat(64),
        evidenceVerifiedAt: '2026-06-30 12:00:00',
        processingStatus: 'completed',
        attemptCount: 1,
      },
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

test('the vendor duration is shown beside the audited one, and compared', () => {
  // "You billed two minutes; the conversation was forty-seven seconds" has to
  // be answerable from the row, without the reader doing arithmetic.
  const rows = dataRows(buildReportCsv(report).toString('utf8'))
  const header = rows[0].split(',')
  const audited = rows[1].split(',')
  const at = (name: string) => audited[header.indexOf(name)]

  assert.equal(at('kserve_connected_duration_sec'), '120.000')
  assert.equal(at('audited_chargeable_duration_sec'), '107.000')
  assert.equal(at('audited_conversation_end_sec'), '47.000')
  // 120s billed less 107s chargeable.
  assert.equal(at('duration_variance_sec'), '13.000')
  assert.equal(at('bill_month'), '2026-06-14')
})

test('evidence identity travels, the evidence itself does not', () => {
  const rows = dataRows(buildReportCsv(report).toString('utf8'))
  const header = rows[0].split(',')
  const audited = rows[1].split(',')
  // The hash lets the vendor check WHICH bytes were audited against the file
  // they supplied, without the recording leaving this platform.
  assert.equal(audited[header.indexOf('evidence_sha256')], 'd'.repeat(64))
  assert.equal(
    audited[header.indexOf('audit_engine_version')],
    'kairali-independent-reaudit/2.6.5',
  )
  assert.equal(
    audited[header.indexOf('input_manifest_sha256')],
    'b'.repeat(64),
  )
})

test('a row with no audit detail leaves cells empty, never zero', () => {
  // An unknown duration is not a duration of zero; a zero would understate
  // the vendor's own figure in a document they are shown.
  const rows = dataRows(buildReportCsv(report).toString('utf8'))
  const header = rows[0].split(',')
  const noDetail = rows[2].split(',')
  for (const column of [
    'kserve_connected_duration_sec',
    'audited_chargeable_duration_sec',
    'duration_variance_sec',
    'evidence_sha256',
  ]) {
    assert.equal(noDetail[header.indexOf(column)], '', column)
  }
})

test('amounts stay unformatted so a spreadsheet can total them', () => {
  const rows = dataRows(buildReportCsv(report).toString('utf8'))
  // No grouping separators and no currency symbol anywhere in the values.
  // Per cell: joining first lets one column's end and the next column's start
  // look like a thousands separator.
  for (const line of rows.slice(1)) {
    for (const value of line.split(',')) {
      assert.doesNotMatch(value, /[₹]|\d,\d{3}/, value)
    }
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
