import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildRestrictedExportCsv,
  RESTRICTED_CSV_COLUMNS,
  RESTRICTED_EXPORT_BANNER,
} from './restrictedExportCsv.ts'
import type { RestrictedExport } from '../adapters/mysqlRestrictedExport.ts'

/** Every fixture is SYNTHETIC. No real call, transcript, or URL appears here. */
const report: RestrictedExport = {
  period: {
    month: '2026-06',
    start: '2026-06-01',
    end: '2026-06-30',
    label: 'June 2026',
  },
  generatedAt: '2026-07-01T00:00:00.000Z',
  rowCap: 500,
  truncated: true,
  withheldForSensitivity: 3,
  rows: [{
    callReference: 'synthetic-1',
    category: 'OK',
    resolution: 'independent_audited_projection',
    language: 'ml',
    claimedDurationMs: 132_000,
    connectedDurationMs: 120_000,
    adjustedChargeableDurationMs: 107_000,
    recordedDurationMs: 118_000,
    durationVarianceMs: 13_000,
    vendorBilledMinutes: '2',
    vendorBilledAmount: '19.00',
    verifiedAmount: '9.50',
    currency: 'INR',
    evidenceSha256: 'a'.repeat(64),
    recordingSourceUrl: 'https://recordings.example.invalid/synthetic.ogg',
    transcript: '[0.0s] hello\n[2.5s] line, with comma\n[4.0s] a "quote"',
  }],
}

test('the file says what it is, in the file', () => {
  const csv = buildRestrictedExportCsv(report).toString('utf8')
  // A CSV outlives the conversation in which it was explained.
  assert.match(csv, new RegExp(`# ${RESTRICTED_EXPORT_BANNER.slice(0, 40)}`))
  assert.match(csv, /must not be sent|Not for the vendor/i)
})

test('a partial file admits it is partial', () => {
  const csv = buildRestrictedExportCsv(report).toString('utf8')
  assert.match(csv, /# truncated,yes/)
  assert.match(csv, /# row cap 500|row cap 500/)
  // Withheld rows are counted, never silently dropped.
  assert.match(csv, /# withheld_for_sensitivity,3/)
})

test('a transcript with commas, quotes and newlines stays one row', () => {
  const csv = buildRestrictedExportCsv(report).toString('utf8')
  const body = csv.slice(csv.indexOf(RESTRICTED_CSV_COLUMNS[0]))
  // The transcript is quoted, so its newlines cannot become new records.
  assert.match(body, /"\[0\.0s\] hello\r?\n\[2\.5s\] line, with comma/)
  assert.match(body, /a ""quote""/)
})

test('it carries the content the vendor pack deliberately does not', () => {
  const csv = buildRestrictedExportCsv(report).toString('utf8')
  assert.match(csv, /recording_source_url/)
  assert.match(csv, /transcript/)
  assert.match(csv, /recordings\.example\.invalid/)
  // And still shows the comparison the review is about.
  assert.match(csv, /duration_variance_sec/)
  assert.match(csv, /13\.000/)
})
