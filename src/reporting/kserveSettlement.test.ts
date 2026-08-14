import { test } from 'node:test'
import assert from 'node:assert/strict'
import { inflateSync } from 'node:zlib'
import { unzipSync, strFromU8 } from 'fflate'
import {
  KSERVE_SETTLEMENT_ROUTE,
  KSERVE_SETTLEMENT_UNAVAILABLE_LABEL,
  buildKserveSettlementView,
  toSavingsView,
  toSettlementSummary,
  unavailableSettlementSummary,
} from './kserveSettlement.ts'
import {
  UNAVAILABLE_MONTHLY_SETTLEMENT,
  buildMonthlyEmailReport,
  reportContentSha256,
  type MonthlyReportSettlement,
} from './monthlyEmailReport.ts'
import {
  buildReportEmailHtml,
  buildReportPdf,
  buildReportXlsx,
} from './reportAttachments.ts'
import { parseBillingMonth, type BillingMonthScope } from './billingMonth.ts'
import type { KserveSettlementHistory } from '../adapters/mysqlKserveSettlement.ts'
import type { MonthlyKserveBilledCharge } from '../adapters/mysqlKserveVendorBilled.ts'

/**
 * The settlement DTO and its appearance in the monthly report artifacts.
 *
 * Every month, amount and version below is SYNTHETIC. The point of these tests
 * is that "finally paid" and "savings" reach the screen and the emailed report
 * from ONE view builder, and that an unsettled month stays explicitly
 * unavailable everywhere rather than becoming a zero payment.
 */

const MONTH = parseBillingMonth('2026-08') as BillingMonthScope

function billed(chargeInr: string | null): MonthlyKserveBilledCharge {
  return chargeInr == null
    ? { billedCalls: 0, billedMinutes: null, billedChargeInr: null }
    : {
        billedCalls: 6,
        billedMinutes: '2105.26315789',
        billedChargeInr: chargeInr,
      }
}

function history(
  ...amounts: string[]
): KserveSettlementHistory {
  return {
    versions: amounts.map((amount, index) => ({
      versionNo: amounts.length - index,
      finalPaidAmountInr: amount,
      currency: 'INR',
      recordedAt: `2026-09-0${amounts.length - index} 10:00:00.000000`,
      isCurrent: index === 0,
    })),
    truncated: false,
  }
}

const NOW = new Date('2026-09-05T00:00:00.000Z')

// ---------------------------------------------------------------------------
// DTO
// ---------------------------------------------------------------------------

test('the current version is the unsuperseded one and drives savings', () => {
  const dto = buildKserveSettlementView({
    month: MONTH,
    vendorBilled: billed('20000.00000000'),
    history: history('16000.00000000', '17500.00000000'),
    now: NOW,
  })
  assert.equal(dto.month, '2026-08')
  assert.equal(dto.status, 'recorded')
  assert.equal(dto.current?.versionNo, 2)
  assert.equal(dto.current?.finalPaidAmountInr, '16000.00000000')
  assert.equal(dto.savings.amountInr, '4000.00000000')
  assert.equal(dto.savings.direction, 'saved')
  assert.deepEqual(
    dto.history.map((version) => version.status),
    ['current', 'superseded'],
  )
})

test('no settlement means pending and unavailable, never zero', () => {
  const dto = buildKserveSettlementView({
    month: MONTH,
    vendorBilled: billed('20000.00000000'),
    history: { versions: [], truncated: false },
    now: NOW,
  })
  assert.equal(dto.status, 'pending')
  assert.equal(dto.current, null)
  assert.equal(dto.savings.available, false)
  assert.equal(dto.savings.amountInr, null)
  assert.equal(dto.savings.direction, 'unavailable')
  // The vendor side is still reported: it is evidence, not a settlement.
  assert.equal(dto.vendorBilled.chargeInr, '20000.00000000')
})

test('no vendor billed evidence leaves savings unavailable too', () => {
  const dto = buildKserveSettlementView({
    month: MONTH,
    vendorBilled: billed(null),
    history: history('16000.00000000'),
    now: NOW,
  })
  assert.equal(dto.status, 'recorded')
  assert.equal(dto.vendorBilled.available, false)
  assert.equal(dto.savings.available, false)
  assert.equal(dto.savings.amountInr, null)
})

test('paying more than was billed is reported, not clamped', () => {
  const overpaid = toSavingsView('1000.00000000', '1250.00000000')
  assert.equal(overpaid.amountInr, '-250.00000000')
  assert.equal(overpaid.direction, 'overpaid')
  const level = toSavingsView('1000.00000000', '1000.00000000')
  assert.equal(level.amountInr, '0.00000000')
  assert.equal(level.direction, 'level')
})

test('the DTO carries no identity of any kind', () => {
  const dto = buildKserveSettlementView({
    month: MONTH,
    vendorBilled: billed('20000.00000000'),
    history: history('16000.00000000'),
    now: NOW,
  })
  const serialized = JSON.stringify(dto)
  for (const forbidden of [
    'settlementId',
    'idempotencyKey',
    'requestDigest',
    'recordedByUserId',
    'correlationId',
    'supersedes',
    'callId',
    'transcript',
    'sourceUrl',
  ]) {
    assert.equal(serialized.includes(forbidden), false, forbidden)
  }
})

test('the route the page reads is the route the server exposes', () => {
  assert.equal(KSERVE_SETTLEMENT_ROUTE, '/api/v1/billing/settlement')
})

// ---------------------------------------------------------------------------
// Report summary
// ---------------------------------------------------------------------------

test('the report summary is folded from the same DTO the page renders', () => {
  const dto = buildKserveSettlementView({
    month: MONTH,
    vendorBilled: billed('20000.00000000'),
    history: history('16000.00000000'),
    now: NOW,
  })
  const summary = toSettlementSummary(dto)
  assert.equal(summary.finallyPaidInr, dto.current?.finalPaidAmountInr)
  assert.equal(summary.savingsInr, dto.savings.amountInr)
  assert.equal(summary.vendorBilledChargeInr, dto.vendorBilled.chargeInr)
  assert.equal(summary.month, dto.month)
  assert.equal(summary.status, 'recorded')
})

// ---------------------------------------------------------------------------
// Report artifacts
// ---------------------------------------------------------------------------

function reportWith(
  settlement: MonthlyReportSettlement | null,
) {
  return buildMonthlyEmailReport({
    period: MONTH,
    generatedAt: '2026-09-05T00:00:00.000Z',
    invoiceClaimedAmount: '19.00',
    settlement,
    rows: [
      {
        callReference: 'synthetic-1',
        category: 'OK',
        confidence: '0.90000000',
        resolution: 'independent_conversation_end',
        vendorBilledMinutes: '1.00000000',
        verifiedBillableDurationMs: 60_000,
        verifiedAmount: '9.50000000',
        currency: 'INR',
      },
    ],
  })
}

const RECORDED: MonthlyReportSettlement = {
  status: 'recorded',
  finallyPaidAmount: '16000.00000000',
  finallyPaidVersion: 2,
  vendorBilledChargeAmount: '20000.00000000',
  savingsAmount: '4000.00000000',
  savingsAvailable: true,
  savingsDirection: 'saved',
  currency: 'INR',
}

function sheetXml(report: ReturnType<typeof reportWith>): string {
  const files = unzipSync(new Uint8Array(buildReportXlsx(report)))
  return strFromU8(files['xl/worksheets/sheet1.xml'])
}

test('a settled month reaches the workbook and the email with the same figures', () => {
  const report = reportWith(RECORDED)
  assert.equal(report.settlement?.finallyPaidAmount, '16000')
  assert.equal(report.settlement?.savingsAmount, '4000')

  const sheet = sheetXml(report)
  assert.ok(sheet.includes('Finally paid to KServe'))
  assert.ok(sheet.includes('INR 16,000.00 (version 2)'))
  assert.ok(sheet.includes('Savings vs KServe billed'))
  assert.ok(sheet.includes('INR 4,000.00 (saved)'))

  const html = buildReportEmailHtml(report)
  assert.ok(html.includes('Finally paid to KServe'))
  assert.ok(html.includes('INR 16,000.00 (version 2)'))
  assert.ok(html.includes('INR 4,000.00 (saved)'))
})

test('the workbook filter still starts on the header row after the settlement block', () => {
  const sheet = sheetXml(reportWith(RECORDED))
  const header = /<autoFilter ref="A(\d+):J\d+"\/>/.exec(sheet)
  assert.ok(header)
  const headerRow = Number(header[1])
  // The header row is the one that holds the table's own column titles.
  assert.match(
    sheet,
    new RegExp(
      `<row r="${headerRow}">[^]*?Task / call reference`.replace(
        '/',
        '\\/',
      ),
    ),
  )
})

test('an old period with no settlement is explicitly unavailable, never zero', () => {
  for (const settlement of [
    null,
    {
      ...RECORDED,
      status: 'pending' as const,
      finallyPaidAmount: null,
      finallyPaidVersion: null,
      savingsAmount: null,
      savingsAvailable: false,
      savingsDirection: 'unavailable' as const,
    },
  ]) {
    const report = reportWith(settlement)
    const sheet = sheetXml(report)
    assert.ok(sheet.includes('Not recorded for this period'))
    assert.ok(sheet.includes('Unavailable — no settlement recorded'))
    // No zero payment and no invented total saving.
    assert.equal(sheet.includes('INR 0.00'), false)
    const html = buildReportEmailHtml(report)
    assert.ok(html.includes('Not recorded for this period'))
    assert.equal(html.includes('INR 0.00'), false)
  }
})

/**
 * A read that FAILED is a third state, and the one that is easiest to lose.
 *
 * Reporting it as `pending` would publish "no settlement was recorded for this
 * period" — a claim about the month — on the strength of a transient database
 * failure. These tests hold the two apart in every artifact.
 */
function pdfText(pdf: Buffer): string {
  // This report's content streams are compressed, so they are inflated before
  // the text-showing operators are read back out of them.
  const raw = pdf.toString('latin1')
  const parts: string[] = []
  for (const match of raw.matchAll(/stream\r?\n([\s\S]*?)endstream/g)) {
    let body: string
    try {
      body = inflateSync(Buffer.from(match[1], 'latin1')).toString('latin1')
    } catch {
      continue
    }
    for (const operator of body.matchAll(/\[([^\]]*)\]\s*TJ/g)) {
      let line = ''
      for (const run of operator[1].matchAll(/<([0-9a-fA-F]*)>/g)) {
        line += Buffer.from(run[1], 'hex').toString('latin1')
      }
      parts.push(line)
    }
  }
  return parts.join('\n')
}

test('an unavailable summary carries a month and no money whatsoever', () => {
  const summary = unavailableSettlementSummary('2026-08')
  assert.equal(summary.status, 'unavailable')
  assert.notEqual(summary.status, 'pending')
  assert.equal(summary.month, '2026-08')
  for (const amount of [
    summary.finallyPaidInr,
    summary.finallyPaidVersion,
    summary.finallyPaidRecordedAt,
    summary.vendorBilledChargeInr,
    summary.savingsInr,
  ]) {
    assert.equal(amount, null)
  }
  assert.equal(summary.savingsAvailable, false)
  assert.equal(summary.savingsDirection, 'unavailable')
  // Only the month and the fixed basis prose; nothing about the failure.
  assert.equal(
    JSON.stringify(summary).includes(KSERVE_SETTLEMENT_UNAVAILABLE_LABEL),
    false,
  )
})

test('a failed read prints as temporarily unavailable, never as not recorded', async () => {
  const report = reportWith(UNAVAILABLE_MONTHLY_SETTLEMENT)
  assert.equal(report.settlement?.status, 'unavailable')
  assert.equal(report.settlement?.finallyPaidAmount, null)
  assert.equal(report.settlement?.savingsAmount, null)

  const artifacts = [
    sheetXml(report),
    buildReportEmailHtml(report),
    pdfText(await buildReportPdf(report)),
  ]
  for (const artifact of artifacts) {
    assert.ok(artifact.includes(KSERVE_SETTLEMENT_UNAVAILABLE_LABEL))
    // The absence wording is reserved for a month that was actually read.
    assert.equal(artifact.includes('Not recorded for this period'), false)
    assert.equal(
      artifact.includes('Unavailable — no settlement recorded'),
      false,
    )
    // No zero payment and no invented total saving.
    assert.equal(artifact.includes('INR 0.00'), false)
  }
})

test('pending and unavailable are never the same artifact text', () => {
  const pending = sheetXml(
    reportWith({
      ...RECORDED,
      status: 'pending',
      finallyPaidAmount: null,
      finallyPaidVersion: null,
      savingsAmount: null,
      savingsAvailable: false,
      savingsDirection: 'unavailable',
    }),
  )
  const unavailable = sheetXml(reportWith(UNAVAILABLE_MONTHLY_SETTLEMENT))
  assert.notEqual(pending, unavailable)
  assert.ok(pending.includes('Not recorded for this period'))
  assert.equal(
    pending.includes(KSERVE_SETTLEMENT_UNAVAILABLE_LABEL),
    false,
  )
})

test('the settlement is part of the report content hash', () => {
  const withSettlement = reportWith(RECORDED)
  const corrected = reportWith({
    ...RECORDED,
    finallyPaidAmount: '15000.00000000',
    savingsAmount: '5000.00000000',
  })
  assert.notEqual(
    reportContentSha256(withSettlement),
    reportContentSha256(corrected),
  )
  // The hash still ignores when the report was generated.
  assert.equal(
    reportContentSha256(withSettlement),
    reportContentSha256({
      ...withSettlement,
      generatedAt: '2026-09-06T00:00:00.000Z',
    }),
  )
})

test('the Call Audit report never carries settlement money', async () => {
  const callAudit = await import('./callAuditReport.ts')
  const source = JSON.stringify(Object.keys(callAudit))
  for (const forbidden of ['settlement', 'finallyPaid', 'savings']) {
    assert.equal(
      source.toLowerCase().includes(forbidden.toLowerCase()),
      false,
      forbidden,
    )
  }
})
