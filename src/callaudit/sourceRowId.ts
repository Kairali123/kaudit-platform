/**
 * `ai_voice_leads_received.id` is a BIGINT. A JavaScript number cannot hold
 * every BIGINT exactly, so the source row ID is carried as a canonical decimal
 * STRING everywhere — candidate, reference, cursor, canonical JSON, and
 * idempotency key. Narrowing it to a number would silently round ids above
 * 2^53-1 and collapse two distinct calls onto one audit row.
 */

/** Signed BIGINT maximum, the largest id the source column can hold. */
export const MAX_SIGNED_BIGINT = '9223372036854775807'

/** Canonical form: no sign, no decimal point, no leading zero, at least one digit. */
const CANONICAL_DECIMAL = /^[1-9][0-9]*$/

/** True when `value` is already a canonical positive decimal within BIGINT range. */
export function isCanonicalSourceRowId(value: string): boolean {
  if (!CANONICAL_DECIMAL.test(value)) {
    return false
  }
  if (value.length > MAX_SIGNED_BIGINT.length) {
    return false
  }
  // Equal-length canonical decimals compare correctly lexicographically.
  return (
    value.length < MAX_SIGNED_BIGINT.length || value <= MAX_SIGNED_BIGINT
  )
}

/**
 * Normalizes an untrusted source row ID into a canonical decimal string.
 *
 * Returns null — never a guess — for zero, negatives, an explicit sign, a
 * decimal point, leading zeros, blank text, non-numeric text, or anything above
 * the signed BIGINT maximum. A number is accepted only when it is a positive
 * safe integer, so an already-rounded value can never enter the system.
 */
export function normalizeSourceRowId(value: unknown): string | null {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    return isCanonicalSourceRowId(trimmed) ? trimmed : null
  }
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value <= 0) {
      return null
    }
    return String(value)
  }
  if (typeof value === 'bigint') {
    const text = value.toString()
    return isCanonicalSourceRowId(text) ? text : null
  }
  return null
}
