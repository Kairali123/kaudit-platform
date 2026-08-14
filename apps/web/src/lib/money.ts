/**
 * THE browser money formatter.
 *
 * Every Billing Audit screen formats amounts through this one function, so two
 * screens cannot round the same stored figure differently.
 *
 * Fixed-precision rupees, rounded half-up to paise in INTEGER arithmetic. A
 * stored amount is decimal TEXT from DECIMAL(20,8) and is never parsed into a
 * binary float on its way to the screen: `Number`, `parseFloat`, and `+`/`-`
 * on an amount are deliberately absent from this module.
 *
 * The browser FORMATS money. It never computes it — no totals, no variances,
 * and no savings are derived here. Every figure arrives already calculated by
 * the server, because a number a page invented for itself is a number nobody
 * can audit.
 */

const MONEY_TEXT = /^(-?)(\d+)\.(\d+)$/

/** Absent stays absent. A missing amount is an em dash, never a zero. */
export function money(value: string | null | undefined): string {
  if (value == null) return '—'
  const match = MONEY_TEXT.exec(value)
  if (!match) return '—'
  const [, sign, whole, fraction] = match
  const paise =
    BigInt(`${whole}${fraction.slice(0, 2).padEnd(2, '0')}`) +
    // '5' is char code 53; a shorter fraction rounds down.
    ((fraction.charCodeAt(2) || 0) >= 53 ? 1n : 0n)
  const units = paise / 100n
  return `${sign}₹${units.toLocaleString('en-IN')}.${(paise % 100n)
    .toString()
    .padStart(2, '0')}`
}
