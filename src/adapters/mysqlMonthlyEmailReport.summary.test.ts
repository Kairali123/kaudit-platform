import assert from 'node:assert/strict'
import test from 'node:test'
import type { Pool } from 'mysql2/promise'
import { collectMonthlyPdfReport } from './mysqlMonthlyEmailReport.ts'

test('PDF collection reads grouped month facts instead of per-call evidence', async () => {
  const queries: string[] = []
  const pool = {
    async query(sql: string) {
      queries.push(sql)
      if (sql.includes('GROUP BY calculation.calculation_basis')) {
        return [[
          {
            calculation_basis: 'independent_conversation_end',
            calls: '38',
            vendor_billed_amount: '380.00000000',
            verified_amount: '250.00000000',
            currency: 'INR',
          },
          {
            calculation_basis: 'no_recording_zero',
            calls: 2,
            vendor_billed_amount: '20.00000000',
            verified_amount: '0.00000000',
            currency: 'INR',
          },
        ], []]
      }
      if (sql.includes('FROM kaudit_invoice')) {
        return [[{ subtotal: '410.00000000' }], []]
      }
      return [[], []]
    },
    async execute() {
      return [[], []]
    },
  } as unknown as Pool

  const report = await collectMonthlyPdfReport(pool, {
    period: {
      month: '2026-06',
      label: 'June 2026',
      start: '2026-06-01',
      end: '2026-06-30',
    },
    generatedAt: '2026-09-05T00:00:00.000Z',
  })

  assert.equal(report.summary.totalCalls, 40)
  assert.equal(report.summary.independentlyAuditedCalls, 38)
  assert.equal(report.summary.acceptedAsBilledCalls, 2)
  assert.equal(report.summary.vendorUsageAmount, '400')
  assert.equal(report.summary.verifiedBillableRevenue, '250')
  assert.equal(report.summary.revenueVarianceVsInvoice, '160')
  assert.deepEqual(report.rows, [])
  assert.equal(queries.length, 2)
  assert.match(queries[0] ?? '', /GROUP BY calculation\.calculation_basis/)
  assert.doesNotMatch(queries[0] ?? '', /call_reference|evidence_artifact/)
})
