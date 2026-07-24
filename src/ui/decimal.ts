// Fixed-precision decimal helpers for money display (no binary floating point — same rule
// as the billing engine). Amounts are DECIMAL(20,8) strings from the DB; we operate on
// integers scaled by 1e8 via BigInt.

const SCALE_DIGITS = 8

export function toScaled(s: string | null | undefined): bigint | null {
  if (s == null) return null
  const t = String(s).trim()
  if (t === '') return null
  const neg = t.startsWith('-')
  const clean = t.replace(/^[+-]/, '')
  if (!/^\d+(\.\d+)?$/.test(clean)) return null
  const [i, f = ''] = clean.split('.')
  const frac = (f + '0'.repeat(SCALE_DIGITS)).slice(0, SCALE_DIGITS)
  const v = BigInt(i + frac)
  return neg ? -v : v
}

export function fromScaled(v: bigint): string {
  const neg = v < 0n
  const abs = (neg ? -v : v).toString().padStart(SCALE_DIGITS + 1, '0')
  const i = abs.slice(0, -SCALE_DIGITS)
  const f = abs.slice(-SCALE_DIGITS).replace(/0+$/, '')
  return (neg ? '-' : '') + i + (f ? '.' + f : '')
}

export function subtract(a: string | null, b: string | null): string | null {
  const sa = toScaled(a)
  const sb = toScaled(b)
  if (sa == null || sb == null) return null
  return fromScaled(sa - sb)
}

export type Trend = 'up' | 'down' | 'flat' | 'unknown'

export function trend(current: string | null, prior: string | null): Trend {
  const c = toScaled(current)
  const p = toScaled(prior)
  if (c == null || p == null) return 'unknown'
  if (c > p) return 'up'
  if (c < p) return 'down'
  return 'flat'
}

// Compare with a percentage dead-band. Used by D-12 so tiny period-on-period
// movement is presented as flat rather than as a misleading directional trend.
export function trendWithDeadband(
  current: string | null,
  prior: string | null,
  deadbandBasisPoints = 200, // 2%
): Trend {
  const c = toScaled(current)
  const p = toScaled(prior)
  if (c == null || p == null) return 'unknown'
  if (p === 0n) return c === 0n ? 'flat' : c > 0n ? 'up' : 'down'
  const delta = c > p ? c - p : p - c
  const threshold = ((p < 0n ? -p : p) * BigInt(deadbandBasisPoints)) / 10_000n
  if (delta <= threshold) return 'flat'
  return c > p ? 'up' : 'down'
}

// Display money rounded to 2 dp with Indian grouping, e.g. "INR 82,450.00".
export function formatMoney(s: string | null, currency = 'INR'): string {
  const scaled = toScaled(s)
  if (scaled == null) return '—'
  const neg = scaled < 0n
  const abs = neg ? -scaled : scaled
  const hundredths = (abs + 500000n) / 1000000n // round 1e8-scaled → 1e2-scaled
  const rupees = hundredths / 100n
  const paise = (hundredths % 100n).toString().padStart(2, '0')
  return `${neg ? '-' : ''}${currency} ${rupees.toLocaleString('en-IN')}.${paise}`
}
