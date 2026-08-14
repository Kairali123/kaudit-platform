import type { Pool, RowDataPacket } from 'mysql2/promise'
import { readStoredDecimal } from '../billing/kserveSettlement.ts'

/**
 * THE shared KServe vendor-billed read model.
 *
 * Every surface that reports "what KServe billed" reads it from here, so the
 * Billing Audit page, the category analysis, and the monthly report cannot
 * drift into three slightly different definitions of the vendor's own figure.
 *
 * The basis is fixed and is not a calculation of ours:
 *
 *   * the quantity is `kaudit_provider_cost` rows with the
 *     `vendor_asserted_billed_minutes` SKU marked final — the provider's own
 *     billing evidence, and the same rows the category analysis already prices;
 *   * the rate is the contract rate per billed minute from the locked KServe
 *     ruleset. It is stated once, below, as the SQL literal every KServe
 *     evidence surface uses.
 *
 * No rounding rule, minute ceiling, short-call flat, or wrap-up grace from the
 * locked billing ruleset is reproduced here, and none may be added: this module
 * multiplies the vendor's asserted minutes by the contract rate and does
 * nothing else. Reinterpreting the vendor's own claim would make it no longer
 * the vendor's claim.
 *
 * READ-ONLY over Kaudit-owned `kaudit_*` tables. Nothing here writes, locks,
 * alters, or references the external `ai_voice_leads_received` source table.
 */

/**
 * Vendor-asserted billed minutes, one row per call.
 *
 * `MAX` rather than `SUM`: several final cost rows for one call are revisions
 * of the same assertion, not additional minutes, and summing them would inflate
 * the vendor's own claim.
 */
export const VENDOR_BILLED_MINUTES_SQL = `
  SELECT
    cost.call_id,
    MAX(cost.minutes_decimal) AS minutes_decimal
  FROM kaudit_provider_cost cost
  WHERE cost.provider_sku = 'vendor_asserted_billed_minutes'
    AND cost.is_final = 1
  GROUP BY cost.call_id
`

/**
 * The KServe contract rate per billed minute, as the SQL literal.
 *
 * It is the `ratePerMinute` of the finance-approved ruleset locked on
 * 2026-07-27 (`KSERVE_RULESET_DOCUMENT` in `../billing/kserveRules.ts`), stated
 * here in the form MySQL's DECIMAL arithmetic uses so the multiplication stays
 * exact. A test pins the two against each other; this constant is not a second
 * rate card and must never be edited on its own.
 */
export const KSERVE_VENDOR_RATE_PER_MINUTE = '9.5'

/**
 * The vendor's billed charge for a COMPLETE bill month.
 *
 * Deliberately NOT restricted to audited calls: this is what the vendor billed
 * for the month, so every call in the month that carries final vendor
 * billed-minute evidence contributes, whether or not the audit has reached it.
 * Restricting it to audited calls would make "savings" grow as the audit fell
 * behind, which is exactly backwards.
 *
 * One grouped derived table joined once, filtered on the indexed
 * `billing_period_date`. There is no per-call correlated subquery, so a month
 * costs one pass regardless of how many calls it holds.
 */
export const MONTHLY_KSERVE_BILLED_CHARGE_SQL = `SELECT
     COUNT(*) AS billed_calls,
     CAST(SUM(vendor.minutes_decimal) AS CHAR) AS billed_minutes,
     CAST(
       SUM(vendor.minutes_decimal * ${KSERVE_VENDOR_RATE_PER_MINUTE}) AS CHAR
     ) AS billed_charge_inr
   FROM kaudit_call c
   JOIN (
     ${VENDOR_BILLED_MINUTES_SQL}
   ) vendor ON vendor.call_id = c.id
   WHERE c.billing_period_date BETWEEN ? AND ?`

/**
 * What the vendor billed for one month.
 *
 * `billedChargeInr` is NULL when the month carries no final vendor billed-
 * minute evidence at all. That is "the vendor has not billed this month yet",
 * not "the vendor billed zero", and every caller keeps the distinction.
 */
export interface MonthlyKserveBilledCharge {
  billedCalls: number
  billedMinutes: string | null
  billedChargeInr: string | null
}

export interface MonthlyKserveBilledScope {
  /** Inclusive calendar bounds of the complete bill month. */
  periodStart: string
  periodEnd: string
}

export interface KserveVendorBilledPort {
  readMonthlyBilledCharge(
    scope: MonthlyKserveBilledScope,
  ): Promise<MonthlyKserveBilledCharge>
}

interface BilledChargeRow extends RowDataPacket {
  billed_calls: number | string | null
  billed_minutes: string | null
  billed_charge_inr: string | null
}

export function toMonthlyKserveBilledCharge(
  row: BilledChargeRow | undefined,
): MonthlyKserveBilledCharge {
  const billedCalls = Number(row?.billed_calls ?? 0)
  // A month with no evidence reports absence, never a manufactured 0.00.
  if (!Number.isSafeInteger(billedCalls) || billedCalls <= 0) {
    return { billedCalls: 0, billedMinutes: null, billedChargeInr: null }
  }
  return {
    billedCalls,
    billedMinutes: readStoredDecimal(row?.billed_minutes, 'billedMinutes'),
    billedChargeInr: readStoredDecimal(
      row?.billed_charge_inr,
      'billedChargeInr',
    ),
  }
}

export function createMysqlKserveVendorBilledRepository(
  pool: Pool,
): KserveVendorBilledPort {
  return {
    async readMonthlyBilledCharge(scope) {
      const [rows] = await pool.execute<BilledChargeRow[]>(
        MONTHLY_KSERVE_BILLED_CHARGE_SQL,
        [scope.periodStart, scope.periodEnd],
      )
      return toMonthlyKserveBilledCharge(rows[0])
    },
  }
}
