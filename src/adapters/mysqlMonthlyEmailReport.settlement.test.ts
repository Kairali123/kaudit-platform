import { test } from 'node:test'
import assert from 'node:assert/strict'
import { strFromU8, unzipSync } from 'fflate'
import type { Pool } from 'mysql2/promise'
import { collectMonthlyEmailReport } from './mysqlMonthlyEmailReport.ts'
import type { BillingMonthScope } from '../reporting/billingMonth.ts'
import {
  buildReportEmailHtml,
  buildReportXlsx,
} from '../reporting/reportAttachments.ts'

/**
 * What the monthly report says when its SETTLEMENT read fails.
 *
 * The collector must not propagate — the revenue report predates settlements
 * and has to be produced for every month — but the failure must also not be
 * flattened into "no settlement was recorded for this period", which is a claim
 * about the month that a failed read never established. This file pins the
 * three states apart: recorded, pending (read succeeded, no row), and
 * unavailable (read failed).
 *
 * The pool is SYNTHETIC and returns no rows: no database, and no real month,
 * amount, actor or key in any fixture here.
 */

const MONTH: BillingMonthScope = {
  month: '2026-08',
  label: 'August 2026',
  start: '2026-08-01',
  end: '2026-08-31',
}

const GENERATED_AT = '2026-09-05T00:00:00.000Z'

/**
 * A pool that answers every query with no rows, except the settlement or
 * vendor-billed read when the test asks for that one to fail.
 *
 * Dispatch is on a token unique to each statement, so a failure is aimed at
 * exactly one read and the rest of the report is collected normally.
 */
function syntheticPool(options: { failOn?: 'settlement' | 'vendorBilled' } = {}): Pool {
  const marker =
    options.failOn === 'settlement'
      ? 'kserve_monthly_settlement'
      : options.failOn === 'vendorBilled'
        ? 'billed_charge_inr'
        : null
  const answer = async (sql: string) => {
    if (marker != null && sql.includes(marker)) {
      throw new Error(
        `synthetic-failure reading ${marker} for 2026-08 at 17500.00`,
      )
    }
    return [[], []]
  }
  return {
    async query(sql: string) {
      return answer(sql)
    },
    async execute(sql: string) {
      return answer(sql)
    },
  } as unknown as Pool
}

function sheetXml(xlsx: Buffer): string {
  return strFromU8(
    unzipSync(new Uint8Array(xlsx))['xl/worksheets/sheet1.xml'],
  )
}

test('a month that reads cleanly with no settlement row stays pending', async () => {
  const report = await collectMonthlyEmailReport(syntheticPool(), {
    period: MONTH,
    generatedAt: GENERATED_AT,
  })
  assert.equal(report.settlement?.status, 'pending')
  assert.equal(report.settlement?.finallyPaidAmount, null)
  assert.equal(report.settlement?.savingsAvailable, false)

  // Its existing honest wording is unchanged.
  const sheet = sheetXml(buildReportXlsx(report))
  assert.ok(sheet.includes('Not recorded for this period'))
  assert.equal(sheet.includes('Settlement temporarily unavailable'), false)
})

for (const failOn of ['settlement', 'vendorBilled'] as const) {
  test(`a failed ${failOn} read is reported as unavailable, not as pending`, async () => {
    const report = await collectMonthlyEmailReport(
      syntheticPool({ failOn }),
      { period: MONTH, generatedAt: GENERATED_AT },
    )
    const settlement = report.settlement
    assert.ok(settlement)
    assert.equal(settlement.status, 'unavailable')
    assert.notEqual(settlement.status, 'pending')

    // A failure produces no figure at all.
    assert.equal(settlement.finallyPaidAmount, null)
    assert.equal(settlement.finallyPaidVersion, null)
    assert.equal(settlement.vendorBilledChargeAmount, null)
    assert.equal(settlement.savingsAmount, null)
    assert.equal(settlement.savingsAvailable, false)
    assert.equal(settlement.savingsDirection, 'unavailable')

    // The rest of the report is still produced.
    assert.equal(report.reportVersion, 'monthly-revenue/1.0.0')
    assert.equal(report.period.month, MONTH.month)
  })
}

test('the artifacts say temporarily unavailable and never not recorded', async () => {
  const report = await collectMonthlyEmailReport(
    syntheticPool({ failOn: 'settlement' }),
    { period: MONTH, generatedAt: GENERATED_AT },
  )
  const sheet = sheetXml(buildReportXlsx(report))
  const html = buildReportEmailHtml(report)
  for (const artifact of [sheet, html]) {
    // The absence wording belongs to a month that was read, not to a failure.
    assert.equal(artifact.includes('Not recorded for this period'), false)
    assert.equal(artifact.includes('Unavailable — no settlement recorded'), false)
    // Every settlement line carries the failure phrase, so none of the three
    // can be read as a figure — and none of them prints a zero.
    assert.equal(
      artifact.split('Settlement temporarily unavailable').length - 1,
      3,
    )
    for (const label of [
      'Finally paid to KServe',
      'KServe billed for the month',
      'Savings vs KServe billed',
    ]) {
      assert.ok(artifact.includes(label), label)
    }
  }
})

test('nothing about the failure reaches an artifact', async () => {
  const report = await collectMonthlyEmailReport(
    syntheticPool({ failOn: 'settlement' }),
    { period: MONTH, generatedAt: GENERATED_AT },
  )
  const artifacts = [
    sheetXml(buildReportXlsx(report)),
    buildReportEmailHtml(report),
    JSON.stringify(report.settlement),
  ]
  for (const artifact of artifacts) {
    for (const leak of [
      'synthetic-failure',
      'kserve_monthly_settlement',
      'billed_charge_inr',
      'SELECT',
      'Error',
      '17500',
    ]) {
      assert.equal(artifact.includes(leak), false, leak)
    }
  }
})
