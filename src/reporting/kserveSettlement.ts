import {
  KSERVE_SETTLEMENT_CURRENCY,
  MAX_SETTLEMENT_HISTORY,
  calculateSettlementSavings,
} from '../billing/kserveSettlement.ts'
import type {
  KserveSettlementHistory,
  KserveSettlementVersion,
} from '../adapters/mysqlKserveSettlement.ts'
import type { MonthlyKserveBilledCharge } from '../adapters/mysqlKserveVendorBilled.ts'
import type { BillingMonthScope } from './billingMonth.ts'

/**
 * Presentation layer for the MONTHLY KSERVE SETTLEMENT — "Finally paid" and
 * "Savings" for one bill month.
 *
 * It folds two already-scoped reads (the month's vendor billed charge and the
 * month's settlement history) into a DTO. Pure: no SQL, no write, no clock
 * except the one passed in, no model call.
 *
 * Boundaries restated here because this is the layer that faces a browser and a
 * report:
 *
 *   * ADMINISTRATOR-ONLY. Recording and reading what was paid is a money
 *     decision, so both the API and the page take the `billing:approve` gate
 *     and every read and write is access-logged under its own action.
 *   * The DTO is assembled by explicit field copy. There is no actor identity,
 *     internal id, idempotency key, request digest, source id, source text,
 *     URL, evidence hash, transcript, or provider prose on any shape below, and
 *     none is derivable from one.
 *   * MONEY IS FIXED-PRECISION TEXT and SAVINGS IS COMPUTED HERE, once, on the
 *     server. The browser formats the string it is given and never subtracts.
 *   * ABSENT IS NOT ZERO. With no settlement recorded — or with no vendor
 *     billed evidence for the month — "Finally paid" and "Savings" are reported
 *     as pending or unavailable. Neither is ever rendered as 0.00.
 *   * BILLING AUDIT ONLY. This figure never appears in a Call Audit report.
 */

export const KSERVE_SETTLEMENT_TITLE = 'Final amount paid to KServe'

export const KSERVE_SETTLEMENT_ROUTE = '/api/v1/billing/settlement'

export const KSERVE_SETTLEMENT_CONTENT_BOUNDARY =
  'Admin-only settlement record. Bill month, rupee amounts, and version ' +
  'timestamps only — who recorded a version, internal identifiers, retry ' +
  'keys, and every form of call evidence stay server-side.'

/**
 * The one basis statement for savings, carried on every response so a reader
 * never has to guess which two numbers were subtracted.
 */
export const KSERVE_SETTLEMENT_SAVINGS_BASIS =
  'Savings is the final KServe billed charge for the complete month — the ' +
  'vendor’s own final billed-minute evidence at the contract rate — minus the ' +
  'current final amount paid. It is not derived from AI duration, model ' +
  'output, or projected auditor money, and a negative result means the ' +
  'payment exceeded what was billed.'

// ---------------------------------------------------------------------------
// DTO
// ---------------------------------------------------------------------------

/** One reviewable version. Money as text; no identity of any kind. */
export interface KserveSettlementVersionView {
  versionNo: number
  finalPaidAmountInr: string
  currency: string
  recordedAt: string
  status: 'current' | 'superseded'
}

export interface KserveSettlementSavingsView {
  /** False whenever either side of the subtraction is missing. */
  available: boolean
  amountInr: string | null
  /** Direction of an available result, so a reader never has to infer it. */
  direction: 'saved' | 'overpaid' | 'level' | 'unavailable'
  basis: typeof KSERVE_SETTLEMENT_SAVINGS_BASIS
}

export interface KserveSettlementDto {
  generatedAt: string
  title: typeof KSERVE_SETTLEMENT_TITLE
  contentBoundary: typeof KSERVE_SETTLEMENT_CONTENT_BOUNDARY
  month: string
  monthLabel: string
  currency: typeof KSERVE_SETTLEMENT_CURRENCY
  /** `recorded` once a current version exists; `pending` before that. */
  status: 'recorded' | 'pending'
  vendorBilled: {
    /** Null when the month carries no final vendor billed-minute evidence. */
    chargeInr: string | null
    billedCalls: number
    available: boolean
  }
  /** The unsuperseded version. Null — never a zero — when none exists. */
  current: KserveSettlementVersionView | null
  savings: KserveSettlementSavingsView
  history: KserveSettlementVersionView[]
  /** True when older versions exist beyond the returned window. */
  historyTruncated: boolean
  maxHistory: typeof MAX_SETTLEMENT_HISTORY
}

// ---------------------------------------------------------------------------
// Folding
// ---------------------------------------------------------------------------

export function toSettlementVersionView(
  version: KserveSettlementVersion,
): KserveSettlementVersionView {
  return {
    versionNo: version.versionNo,
    finalPaidAmountInr: version.finalPaidAmountInr,
    currency: version.currency,
    recordedAt: version.recordedAt,
    status: version.isCurrent ? 'current' : 'superseded',
  }
}

/**
 * Savings for the month.
 *
 * The subtraction itself lives in the billing domain; this only labels the
 * result. `level` is reserved for an exact zero difference, which is a real
 * outcome and reads very differently from "no settlement yet".
 */
export function toSavingsView(
  vendorBilledChargeInr: string | null,
  finalPaidAmountInr: string | null,
): KserveSettlementSavingsView {
  const amountInr = calculateSettlementSavings(
    vendorBilledChargeInr,
    finalPaidAmountInr,
  )
  if (amountInr == null) {
    return {
      available: false,
      amountInr: null,
      direction: 'unavailable',
      basis: KSERVE_SETTLEMENT_SAVINGS_BASIS,
    }
  }
  return {
    available: true,
    amountInr,
    direction: amountInr.startsWith('-')
      ? 'overpaid'
      : /^0+\.0+$/.test(amountInr)
        ? 'level'
        : 'saved',
    basis: KSERVE_SETTLEMENT_SAVINGS_BASIS,
  }
}

/**
 * Builds the settlement DTO from reads the caller has already scoped to ONE
 * complete bill month. It performs no read of its own, so the page and the
 * report can be given the same two inputs and cannot disagree.
 */
export function buildKserveSettlementView(options: {
  month: BillingMonthScope
  vendorBilled: MonthlyKserveBilledCharge
  history: KserveSettlementHistory
  now?: Date
}): KserveSettlementDto {
  const history = options.history.versions.map(toSettlementVersionView)
  const current = history.find((version) => version.status === 'current')
    ?? null
  return {
    generatedAt: (options.now ?? new Date()).toISOString(),
    title: KSERVE_SETTLEMENT_TITLE,
    contentBoundary: KSERVE_SETTLEMENT_CONTENT_BOUNDARY,
    month: options.month.month,
    monthLabel: options.month.label,
    currency: KSERVE_SETTLEMENT_CURRENCY,
    status: current ? 'recorded' : 'pending',
    vendorBilled: {
      chargeInr: options.vendorBilled.billedChargeInr,
      billedCalls: options.vendorBilled.billedCalls,
      available: options.vendorBilled.billedChargeInr != null,
    },
    current,
    savings: toSavingsView(
      options.vendorBilled.billedChargeInr,
      current?.finalPaidAmountInr ?? null,
    ),
    history,
    historyTruncated: options.history.truncated,
    maxHistory: MAX_SETTLEMENT_HISTORY,
  }
}

// ---------------------------------------------------------------------------
// Report summary
// ---------------------------------------------------------------------------

/**
 * The three honest states a monthly report can be in about the settlement.
 *
 *   * `recorded`  — the read succeeded and the month has a current version.
 *   * `pending`   — the read SUCCEEDED and the month simply has no settlement.
 *   * `unavailable` — the read FAILED. Nothing is known about the month.
 *
 * `pending` and `unavailable` are deliberately distinct. "No settlement was
 * recorded for August" is a statement about the month; "we could not read the
 * settlement just now" is a statement about this request. Collapsing the second
 * into the first would let a transient failure be published as a fact about the
 * business, so a failed read is never reported as an absence.
 */
export type KserveSettlementSummaryStatus =
  | 'recorded'
  | 'pending'
  | 'unavailable'

/**
 * The one phrase every surface uses for a failed read. Fixed prose: it names no
 * table, carries no driver message, no value, and no identity, and it is the
 * same string whatever was thrown.
 */
export const KSERVE_SETTLEMENT_UNAVAILABLE_LABEL =
  'Settlement temporarily unavailable'

/**
 * The compact shape the monthly report and the reports API carry.
 *
 * It is folded from the SAME DTO the Billing Audit page renders, so a settled
 * month cannot show one "Finally paid" on screen and another in the emailed
 * PDF. An old period with no settlement stays explicitly unavailable rather
 * than appearing as a zero payment with total savings.
 */
export interface KserveSettlementSummary {
  month: string
  currency: typeof KSERVE_SETTLEMENT_CURRENCY
  status: KserveSettlementSummaryStatus
  finallyPaidInr: string | null
  finallyPaidVersion: number | null
  finallyPaidRecordedAt: string | null
  vendorBilledChargeInr: string | null
  savingsInr: string | null
  savingsAvailable: boolean
  savingsDirection: KserveSettlementSavingsView['direction']
  basis: typeof KSERVE_SETTLEMENT_SAVINGS_BASIS
}

/**
 * The summary for a month whose settlement could not be READ.
 *
 * Every money field, every version and every timestamp is null and savings is
 * explicitly unavailable, so nothing downstream can format a figure that was
 * never read. Only the month and the fixed basis prose survive — the caller
 * already knows both, so neither reveals anything about the failure.
 */
export function unavailableSettlementSummary(
  month: string,
): KserveSettlementSummary {
  return {
    month,
    currency: KSERVE_SETTLEMENT_CURRENCY,
    status: 'unavailable',
    finallyPaidInr: null,
    finallyPaidVersion: null,
    finallyPaidRecordedAt: null,
    vendorBilledChargeInr: null,
    savingsInr: null,
    savingsAvailable: false,
    savingsDirection: 'unavailable',
    basis: KSERVE_SETTLEMENT_SAVINGS_BASIS,
  }
}

export function toSettlementSummary(
  dto: KserveSettlementDto,
): KserveSettlementSummary {
  return {
    month: dto.month,
    currency: dto.currency,
    status: dto.status,
    finallyPaidInr: dto.current?.finalPaidAmountInr ?? null,
    finallyPaidVersion: dto.current?.versionNo ?? null,
    finallyPaidRecordedAt: dto.current?.recordedAt ?? null,
    vendorBilledChargeInr: dto.vendorBilled.chargeInr,
    savingsInr: dto.savings.amountInr,
    savingsAvailable: dto.savings.available,
    savingsDirection: dto.savings.direction,
    basis: dto.savings.basis,
  }
}
