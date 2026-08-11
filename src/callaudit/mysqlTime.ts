/**
 * MySQL TIME values arrive as strings such as '00:01:30' or '01:02:03.500000'.
 * The hour part is not capped at 24 (MySQL allows up to 838:59:59), so this
 * parses the components with integer arithmetic only — no Number parsing of the
 * whole value, no floating point, and no rounding surprises.
 */
const MYSQL_TIME = /^(\d{1,3}):([0-5]\d):([0-5]\d)(?:\.(\d{1,6}))?$/

/**
 * Parses a MySQL TIME duration into whole non-negative seconds.
 *
 * Returns null for a missing, blank, negative, or malformed value: a duration
 * the source could not state is recorded as unknown, never as zero. Any
 * fractional second is truncated, so the result is always a whole second count.
 */
export function parseMysqlTimeToSeconds(
  value: string | null | undefined,
): number | null {
  if (typeof value !== 'string') {
    return null
  }
  const trimmed = value.trim()
  if (!trimmed) {
    return null
  }
  const match = MYSQL_TIME.exec(trimmed)
  if (!match) {
    return null
  }
  const hours = Number(match[1])
  const minutes = Number(match[2])
  const seconds = Number(match[3])
  return hours * 3600 + minutes * 60 + seconds
}
