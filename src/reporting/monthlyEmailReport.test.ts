import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildMonthlyEmailReport,
  reportContentSha256,
} from './monthlyEmailReport.ts'

test('builds fixed-precision monthly variance without floating point money', () => {
  const report = buildMonthlyEmailReport({
    period: {
      month: '2026-04',
      start: '2026-04-01',
      end: '2026-04-30',
      label: 'April 2026',
    },
    generatedAt: '2026-05-01T00:00:00.000Z',
    invoiceClaimedAmount: '19.00',
    rows: [
      {
        callReference: 'synthetic-1',
        category: 'OK',
        confidence: '0.90000000',
        resolution: 'independent_category_service_end',
        vendorBilledMinutes: '1.00000000',
        vendorBilledAmount: '10.00000000',
        verifiedBillableDurationMs: 30_000,
        verifiedAmount: '4.75000000',
        currency: 'INR',
      },
      {
        callReference: 'synthetic-2',
        category: 'NO_RECORDING',
        confidence: null,
        resolution: 'accepted_as_billed_unverified',
        vendorBilledMinutes: '1.00000000',
        vendorBilledAmount: null,
        verifiedBillableDurationMs: 60_000,
        verifiedAmount: '9.50000000',
        currency: 'INR',
      },
    ],
  })
  assert.equal(report.summary.vendorUsageAmount, '19.5')
  assert.equal(report.summary.verifiedBillableRevenue, '14.25')
  assert.equal(report.summary.revenueVarianceVsInvoice, '4.75')
  assert.equal(report.summary.independentlyAuditedCalls, 1)
  assert.equal(report.rows[0]?.verifiedBillableMinutes, '0.5')
  assert.equal(report.rows[0]?.variance, '5.25')
  assert.equal(
    reportContentSha256(report),
    reportContentSha256({
      ...report,
      generatedAt: '2026-05-02T00:00:00.000Z',
    }),
  )
})
