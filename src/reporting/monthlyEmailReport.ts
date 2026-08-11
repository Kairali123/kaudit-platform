import { canonicalJsonSha256, type JsonValue } from '../messaging/canonicalJson.ts'
import { fromScaled, toScaled } from '../ui/decimal.ts'
import type { BillingMonthScope } from './billingMonth.ts'

const SCALE = 100_000_000n
const KSERVE_RATE = toScaled('9.50') as bigint

export interface MonthlyReportInputRow {
  callReference: string
  category: string
  confidence: string | null
  resolution: string
  vendorBilledMinutes: string
  verifiedBillableDurationMs: number
  verifiedAmount: string
  currency: string
}

export interface MonthlyReportRow extends MonthlyReportInputRow {
  vendorAmount: string
  verifiedBillableMinutes: string
  variance: string
}

export interface MonthlyEmailReport {
  schemaVersion: '1'
  reportVersion: 'monthly-revenue/1.0.0'
  authority: 'authoritative'
  period: BillingMonthScope
  generatedAt: string
  summary: {
    totalCalls: number
    independentlyAuditedCalls: number
    acceptedAsBilledCalls: number
    vendorUsageAmount: string
    invoiceClaimedAmount: string | null
    verifiedBillableRevenue: string
    revenueVarianceVsInvoice: string | null
    revenueVarianceVsUsage: string
    currency: string
  }
  rows: MonthlyReportRow[]
  sourceManifestSha256: string
}

function requiredScaled(value: string, name: string): bigint {
  const result = toScaled(value)
  if (result == null) throw new TypeError(`${name} is not a decimal`)
  return result
}

function minutesFromMs(milliseconds: number): string {
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) {
    throw new RangeError(
      'verifiedBillableDurationMs must be a non-negative integer',
    )
  }
  return fromScaled(
    (BigInt(milliseconds) * SCALE) / 60_000n,
  )
}

function vendorAmount(minutes: string): string {
  return fromScaled(
    (requiredScaled(minutes, 'vendorBilledMinutes') *
      KSERVE_RATE) /
      SCALE,
  )
}

export function buildMonthlyEmailReport(options: {
  period: BillingMonthScope
  generatedAt: string
  invoiceClaimedAmount: string | null
  rows: MonthlyReportInputRow[]
}): MonthlyEmailReport {
  const rows = options.rows.map((row): MonthlyReportRow => {
    const claimed = vendorAmount(row.vendorBilledMinutes)
    const verified = requiredScaled(
      row.verifiedAmount,
      'verifiedAmount',
    )
    return {
      ...row,
      vendorAmount: claimed,
      verifiedBillableMinutes: minutesFromMs(
        row.verifiedBillableDurationMs,
      ),
      variance: fromScaled(
        requiredScaled(claimed, 'vendorAmount') - verified,
      ),
    }
  })
  const totals = rows.reduce(
    (sum, row) => ({
      vendor:
        sum.vendor +
        requiredScaled(row.vendorAmount, 'vendorAmount'),
      verified:
        sum.verified +
        requiredScaled(row.verifiedAmount, 'verifiedAmount'),
    }),
    { vendor: 0n, verified: 0n },
  )
  const invoice =
    options.invoiceClaimedAmount == null
      ? null
      : requiredScaled(
          options.invoiceClaimedAmount,
          'invoiceClaimedAmount',
        )
  const sourceManifestSha256 = canonicalJsonSha256({
    period: options.period,
    invoiceClaimedAmount: options.invoiceClaimedAmount,
    rows,
  } as unknown as JsonValue)
  return {
    schemaVersion: '1',
    reportVersion: 'monthly-revenue/1.0.0',
    authority: 'authoritative',
    period: options.period,
    generatedAt: options.generatedAt,
    summary: {
      totalCalls: rows.length,
      independentlyAuditedCalls: rows.filter(
        (row) =>
          row.resolution === 'independent_conversation_end',
      ).length,
      acceptedAsBilledCalls: rows.filter(
        (row) =>
          row.resolution === 'accepted_as_billed_unverified',
      ).length,
      vendorUsageAmount: fromScaled(totals.vendor),
      invoiceClaimedAmount: options.invoiceClaimedAmount,
      verifiedBillableRevenue: fromScaled(totals.verified),
      revenueVarianceVsInvoice:
        invoice == null
          ? null
          : fromScaled(invoice - totals.verified),
      revenueVarianceVsUsage: fromScaled(
        totals.vendor - totals.verified,
      ),
      currency: rows[0]?.currency ?? 'INR',
    },
    rows,
    sourceManifestSha256,
  }
}

export function reportContentSha256(
  report: MonthlyEmailReport,
): string {
  return canonicalJsonSha256({
    schemaVersion: report.schemaVersion,
    reportVersion: report.reportVersion,
    authority: report.authority,
    period: report.period,
    summary: report.summary,
    rows: report.rows,
    sourceManifestSha256: report.sourceManifestSha256,
  } as unknown as JsonValue)
}

