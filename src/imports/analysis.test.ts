import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  analyzeUsageCsv,
  normalizeInvoiceExtraction,
} from './analysis.ts'

const csv = Buffer.from(`Task ID,Destination Number,Call Start Time,Call Connected Time,Call End Time,Duration (Seconds) With Ringing,Duration (Seconds) Without Ringing,Duration (Minutes) - Actual Billing Mins,Actual Billing Amount,Recording URL
T001,9000000001,01/05/2026 09:00:00,01/05/2026 09:00:03,01/05/2026 09:00:30,30,27,0.5,4.75,https://recordings.example.test/a.ogg
T002,9000000002,31/05/2026 18:00:00,31/05/2026 18:00:02,31/05/2026 18:01:00,60,58,1,9.50,
`)

test('derives an editable usage period and counts missing recordings deterministically', () => {
  assert.deepEqual(analyzeUsageCsv(csv), {
    method: 'deterministic',
    periodStart: '2026-05-01',
    periodEnd: '2026-05-31',
    rowCount: 2,
    recordingUrlCount: 1,
    missingRecordingUrlCount: 1,
    recognizedColumns: [
      'Task ID',
      'Destination Number',
      'Call Start Time',
      'Call Connected Time',
      'Call End Time',
      'Duration (Seconds) With Ringing',
      'Duration (Seconds) Without Ringing',
      'Duration (Minutes) - Actual Billing Mins',
      'Actual Billing Amount',
      'Recording URL',
    ],
    warnings: [
      '1 rows have no recording URL and will remain explicitly unaudited.',
    ],
  })
})

test('normalizes AI invoice suggestions without making missing values authoritative', () => {
  const preview = normalizeInvoiceExtraction({
    invoice_number: ' INV-001 ',
    invoice_date: '2026-06-03',
    period_start: '2026-05-01',
    period_end: '2026-05-31',
    subtotal_amount: '100.5',
    tax_amount: null,
    total_amount: '118.59',
    currency: 'INR',
    confidence: 0.91,
    warnings: [' Tax was not clearly printed. '],
  })
  assert.equal(preview.invoiceNumber, 'INV-001')
  assert.equal(preview.subtotalAmount, '100.50')
  assert.equal(preview.taxAmount, '')
  assert.equal(preview.confidence, '0.9100')
  assert.deepEqual(preview.warnings, [
    'Tax was not clearly printed.',
  ])
})
