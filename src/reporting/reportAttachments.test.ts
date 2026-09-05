import assert from 'node:assert/strict'
import test from 'node:test'
import { unzipSync, strFromU8 } from 'fflate'
import { buildMonthlyEmailReport } from './monthlyEmailReport.ts'
import {
  buildReportEmailHtml,
  buildReportPdf,
  buildReportXlsx,
} from './reportAttachments.ts'

const report = buildMonthlyEmailReport({
  period: {
    month: '2026-04',
    start: '2026-04-01',
    end: '2026-04-30',
    label: 'April 2026',
  },
  generatedAt: '2026-05-01T00:00:00.000Z',
  invoiceClaimedAmount: '9.50',
  rows: [{
    callReference: '=synthetic-1',
    category: 'OK',
    confidence: '0.95',
    resolution: 'independent_conversation_end',
    vendorBilledMinutes: '1',
    verifiedBillableDurationMs: 60_000,
    verifiedAmount: '9.50',
    currency: 'INR',
  }],
})

test('creates a valid XLSX zip using inline strings, not formulas', () => {
  const workbook = unzipSync(buildReportXlsx(report))
  const worksheet = strFromU8(
    workbook['xl/worksheets/sheet1.xml']!,
  )
  assert.match(worksheet, /t="inlineStr"/)
  assert.match(worksheet, /=synthetic-1/)
  assert.doesNotMatch(worksheet, /<f>/)
})

test('creates PDF and escaped HTML report attachments', async () => {
  const pdf = await buildReportPdf(report)
  assert.equal(pdf.subarray(0, 4).toString(), '%PDF')
  const pdfSource = pdf.toString('latin1')
  assert.ok((pdfSource.match(/\/Type \/Page\b/g) ?? []).length >= 2)
  assert.match(pdfSource, /Kairali April 2026 Billing Audit/)
  assert.match(pdfSource, /Kairali Billing Audit Platform/)
  const email = buildReportEmailHtml(report)
  assert.match(email, /April 2026/)
  assert.doesNotMatch(email, /<script/)
})
