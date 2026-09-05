import { canonicalJsonSha256, type JsonValue } from '../messaging/canonicalJson.ts'
import { fromScaled, toScaled } from '../ui/decimal.ts'
import type { BillingMonthScope } from './billingMonth.ts'

const SCALE = 100_000_000n
const KSERVE_RATE = toScaled('9.50') as bigint

import { resolutionLabel } from './resolutionLabels.ts'

/**
 * How the month's calls resolved, and what each outcome contributed.
 *
 * A single variance number invites the question it does not answer: where did
 * the difference come from. This splits it by the reason each call resolved,
 * so "we cut X" can be shown as "X of it is calls you supplied no recording
 * for" rather than asserted.
 */
export interface MonthlyResolutionBreakdown {
  basis: string
  label: string
  explanation: string
  independentlyMeasured: boolean
  calls: number
  vendorAmount: string
  verifiedAmount: string
  variance: string
}

/**
 * The audit facts behind one call's amount.
 *
 * Optional because the emailed report does not carry it: this exists for the
 * per-call export a vendor is walked through, where "your three minutes was
 * forty-seven seconds of conversation" has to be answerable from the row.
 *
 * It carries no transcript, no recording location and no customer text. The
 * evidence hash is here instead — it proves WHICH bytes were audited, so the
 * vendor can hash the file they supplied and compare, without the recording
 * itself ever leaving this platform.
 */
export interface MonthlyReportRowDetail {
  billingPeriodDate: string | null
  /** KServe's own figures, as supplied. */
  claimedDurationMs: number | null
  connectedDurationMs: number | null
  /** What this platform measured from the recording. */
  recordedDurationMs: number | null
  speechDurationMs: number | null
  conversationEndMs: number | null
  wrapUpGraceMs: number | null
  adjustedChargeableDurationMs: number | null
  oneWayTailMs: number | null
  oneWayTailAlert: boolean | null
  billingEngineVersion: string | null
  auditEngineVersion: string | null
  rulesetSha256: string | null
  inputManifestSha256: string | null
  decisionTraceSha256: string | null
  finalizedAt: string | null
  evidenceSha256: string | null
  evidenceVerifiedAt: string | null
  processingStatus: string | null
  attemptCount: number | null
}

export interface MonthlyReportInputRow {
  callReference: string
  category: string
  confidence: string | null
  resolution: string
  vendorBilledMinutes: string
  vendorBilledAmount?: string | null
  verifiedBillableDurationMs: number
  verifiedAmount: string
  currency: string
  detail?: MonthlyReportRowDetail
}

/** Pre-aggregated billing facts used by summary-only artifacts such as PDF. */
export interface MonthlyReportAggregateInput {
  resolution: string
  calls: number
  vendorAmount: string
  verifiedAmount: string
  currency: string
}

export interface MonthlyReportRow extends MonthlyReportInputRow {
  vendorAmount: string
  verifiedBillableMinutes: string
  variance: string
}

/**
 * What the month's KServe settlement contributes to the report.
 *
 * It is a SEPARATE block from `summary`, not another variance line, because it
 * answers a different question. Verified revenue and variance are what the
 * audit calculated; this is what was actually paid after negotiation, and the
 * savings beside it is that payment subtracted from the vendor's own billed
 * charge for the complete month.
 *
 * Every amount may be null, and null means UNAVAILABLE. A month with no
 * recorded settlement — every period that closed before settlements existed —
 * reports `pending` with null amounts rather than a zero payment and total
 * savings, which would read as a triumph that never happened.
 *
 * `unavailable` is a THIRD state and never a synonym for `pending`. It means
 * the settlement could not be read at all, so the report knows nothing about
 * the month; `pending` means the read succeeded and the month genuinely has no
 * settlement. A failed read published as "not recorded" would state a fact
 * about the business that nobody established.
 */
export interface MonthlyReportSettlement {
  status: 'recorded' | 'pending' | 'unavailable'
  finallyPaidAmount: string | null
  /** Which version of the month's history is current. Never a row id. */
  finallyPaidVersion: number | null
  vendorBilledChargeAmount: string | null
  savingsAmount: string | null
  savingsAvailable: boolean
  /** Negative savings means the payment exceeded the vendor's billed charge. */
  savingsDirection: 'saved' | 'overpaid' | 'level' | 'unavailable'
  currency: string
}

/**
 * What a collector emits when its settlement read FAILED.
 *
 * No amount, no version and no direction: a failure produces no figure at all,
 * and nothing here varies with what was thrown, so no driver message, table
 * name, value or identity can ride along into an artifact.
 */
export const UNAVAILABLE_MONTHLY_SETTLEMENT: MonthlyReportSettlement =
  Object.freeze({
    status: 'unavailable',
    finallyPaidAmount: null,
    finallyPaidVersion: null,
    vendorBilledChargeAmount: null,
    savingsAmount: null,
    savingsAvailable: false,
    savingsDirection: 'unavailable',
    currency: 'INR',
  })

export interface MonthlyEmailReport {
  schemaVersion: '1'
  reportVersion: 'monthly-revenue/1.0.0'
  authority: 'authoritative'
  period: BillingMonthScope
  generatedAt: string
  /** Null when the caller had no settlement read for the period at all. */
  settlement: MonthlyReportSettlement | null
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
  resolutionBreakdown: MonthlyResolutionBreakdown[]
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

function fallbackVendorAmount(minutes: string): string {
  return fromScaled(
    (requiredScaled(minutes, 'vendorBilledMinutes') * KSERVE_RATE) /
      SCALE,
  )
}

/**
 * Re-cuts a settlement amount into the report's own decimal presentation.
 *
 * The settlement store returns eight-place text and this report trims trailing
 * zeros, so both sides pass through the SAME scaled-integer helpers used for
 * every other amount here. Null stays null: an absent figure is never
 * normalized into '0'.
 */
function settlementAmount(value: string | null, name: string): string | null {
  return value == null ? null : fromScaled(requiredScaled(value, name))
}

function toReportSettlement(
  settlement: MonthlyReportSettlement | null,
): MonthlyReportSettlement | null {
  if (settlement == null) return null
  return {
    status: settlement.status,
    finallyPaidAmount: settlementAmount(
      settlement.finallyPaidAmount,
      'finallyPaidAmount',
    ),
    finallyPaidVersion: settlement.finallyPaidVersion,
    vendorBilledChargeAmount: settlementAmount(
      settlement.vendorBilledChargeAmount,
      'vendorBilledChargeAmount',
    ),
    savingsAmount: settlementAmount(
      settlement.savingsAmount,
      'savingsAmount',
    ),
    savingsAvailable: settlement.savingsAvailable,
    savingsDirection: settlement.savingsDirection,
    currency: settlement.currency,
  }
}

function buildResolutionBreakdown(
  rows: MonthlyReportRow[],
): MonthlyResolutionBreakdown[] {
  const totals = new Map<
    string,
    { calls: number; vendor: bigint; verified: bigint }
  >()
  for (const row of rows) {
    const running = totals.get(row.resolution) ??
      { calls: 0, vendor: 0n, verified: 0n }
    running.calls += 1
    running.vendor += requiredScaled(row.vendorAmount, 'vendorAmount')
    running.verified += requiredScaled(row.verifiedAmount, 'verifiedAmount')
    totals.set(row.resolution, running)
  }
  return [...totals.entries()]
    // Largest contribution first: the reader is looking for where the money
    // went, not for an alphabet.
    .sort((left, right) =>
      right[1].vendor - right[1].verified >
      left[1].vendor - left[1].verified
        ? 1
        : -1,
    )
    .map(([basis, running]) => {
      const label = resolutionLabel(basis)
      return {
        basis,
        label: label.label,
        explanation: label.explanation,
        independentlyMeasured: label.independentlyMeasured,
        calls: running.calls,
        vendorAmount: fromScaled(running.vendor),
        verifiedAmount: fromScaled(running.verified),
        variance: fromScaled(running.vendor - running.verified),
      }
    })
}

function aggregateResolutionBreakdown(
  groups: MonthlyReportAggregateInput[],
): MonthlyResolutionBreakdown[] {
  return groups
    .map((group) => {
      if (!Number.isSafeInteger(group.calls) || group.calls < 0) {
        throw new RangeError('calls must be a non-negative integer')
      }
      const vendor = requiredScaled(group.vendorAmount, 'vendorAmount')
      const verified = requiredScaled(group.verifiedAmount, 'verifiedAmount')
      const label = resolutionLabel(group.resolution)
      return {
        basis: group.resolution,
        label: label.label,
        explanation: label.explanation,
        independentlyMeasured: label.independentlyMeasured,
        calls: group.calls,
        vendorAmount: fromScaled(vendor),
        verifiedAmount: fromScaled(verified),
        variance: fromScaled(vendor - verified),
      }
    })
    .sort((left, right) => {
      const leftVariance = requiredScaled(left.variance, 'variance')
      const rightVariance = requiredScaled(right.variance, 'variance')
      if (rightVariance > leftVariance) return 1
      if (rightVariance < leftVariance) return -1
      return left.basis.localeCompare(right.basis)
    })
}

/**
 * Builds the same authoritative summary as the detailed report without
 * materializing one JavaScript object per call. Summary PDFs use this path;
 * per-call CSV/XLSX artifacts continue to use `buildMonthlyEmailReport`.
 */
export function buildMonthlySummaryReport(options: {
  period: BillingMonthScope
  generatedAt: string
  invoiceClaimedAmount: string | null
  groups: MonthlyReportAggregateInput[]
  settlement?: MonthlyReportSettlement | null
}): MonthlyEmailReport {
  const breakdown = aggregateResolutionBreakdown(options.groups)
  const totals = breakdown.reduce(
    (sum, group) => ({
      calls: sum.calls + group.calls,
      independentlyAuditedCalls:
        sum.independentlyAuditedCalls +
        (group.independentlyMeasured ? group.calls : 0),
      acceptedAsBilledCalls:
        sum.acceptedAsBilledCalls +
        (group.independentlyMeasured ? 0 : group.calls),
      vendor:
        sum.vendor + requiredScaled(group.vendorAmount, 'vendorAmount'),
      verified:
        sum.verified + requiredScaled(group.verifiedAmount, 'verifiedAmount'),
    }),
    {
      calls: 0,
      independentlyAuditedCalls: 0,
      acceptedAsBilledCalls: 0,
      vendor: 0n,
      verified: 0n,
    },
  )
  const invoice = options.invoiceClaimedAmount == null
    ? null
    : requiredScaled(options.invoiceClaimedAmount, 'invoiceClaimedAmount')
  const sourceManifestSha256 = canonicalJsonSha256({
    period: options.period,
    invoiceClaimedAmount: options.invoiceClaimedAmount,
    groups: breakdown.map((group) => ({
      basis: group.basis,
      calls: group.calls,
      vendorAmount: group.vendorAmount,
      verifiedAmount: group.verifiedAmount,
    })),
  } as unknown as JsonValue)

  return {
    schemaVersion: '1',
    reportVersion: 'monthly-revenue/1.0.0',
    authority: 'authoritative',
    period: options.period,
    generatedAt: options.generatedAt,
    settlement: toReportSettlement(options.settlement ?? null),
    summary: {
      totalCalls: totals.calls,
      independentlyAuditedCalls: totals.independentlyAuditedCalls,
      acceptedAsBilledCalls: totals.acceptedAsBilledCalls,
      vendorUsageAmount: fromScaled(totals.vendor),
      invoiceClaimedAmount: options.invoiceClaimedAmount,
      verifiedBillableRevenue: fromScaled(totals.verified),
      revenueVarianceVsInvoice:
        invoice == null ? null : fromScaled(invoice - totals.verified),
      revenueVarianceVsUsage: fromScaled(totals.vendor - totals.verified),
      currency: options.groups[0]?.currency ?? 'INR',
    },
    resolutionBreakdown: breakdown,
    rows: [],
    sourceManifestSha256,
  }
}

export function buildMonthlyEmailReport(options: {
  period: BillingMonthScope
  generatedAt: string
  invoiceClaimedAmount: string | null
  rows: MonthlyReportInputRow[]
  /** Absent when the caller could not read a settlement for the period. */
  settlement?: MonthlyReportSettlement | null
}): MonthlyEmailReport {
  const rows = options.rows.map((row): MonthlyReportRow => {
    const claimed = row.vendorBilledAmount == null
      ? fallbackVendorAmount(row.vendorBilledMinutes)
      : fromScaled(
          requiredScaled(row.vendorBilledAmount, 'vendorBilledAmount'),
        )
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
    settlement: toReportSettlement(options.settlement ?? null),
    summary: {
      totalCalls: rows.length,
      // Derived from the shared resolution vocabulary rather than a second
      // list of bases, so a new basis cannot be counted as accepted-as-billed
      // simply because nobody remembered to add it here.
      independentlyAuditedCalls: rows.filter(
        (row) => resolutionLabel(row.resolution).independentlyMeasured,
      ).length,
      acceptedAsBilledCalls: rows.filter(
        (row) => !resolutionLabel(row.resolution).independentlyMeasured,
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
    resolutionBreakdown: buildResolutionBreakdown(rows),
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
    // Part of the content hash: a report that reached a mailbox stating one
    // "finally paid" must not hash the same as one stating another.
    settlement: report.settlement,
    summary: report.summary,
    rows: report.rows,
    sourceManifestSha256: report.sourceManifestSha256,
  } as unknown as JsonValue)
}
