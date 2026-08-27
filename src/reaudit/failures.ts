/**
 * Privacy-safe diagnostic classification for Billing Audit worker failures.
 *
 * The worker's fatal paths (claim, persistence, progress/control, pool
 * acquisition) surface raw driver errors that can quote SQL fragments,
 * column values, internal identifiers, or infrastructure hostnames. Those
 * errors are NEVER carried outward. Instead every failure is reduced to:
 *
 *   - the lifecycle PHASE it occurred in, and
 *   - one allowlisted error CATEGORY.
 *
 * Nothing else — no message, no stack, no driver code string beyond what the
 * allowlist mapping needs internally.
 */

export const REAUDIT_PHASES = [
  'claim',
  'processor',
  'persist',
  'progress',
  'pool_acquisition',
] as const

export type ReauditPhase = (typeof REAUDIT_PHASES)[number]

export const REAUDIT_ERROR_CATEGORIES = [
  'DB_CONNECTION_LIMIT',
  'DB_CONNECTION_TIMEOUT',
  'DB_LOCK_TIMEOUT',
  'DB_DEADLOCK',
  'DB_CONSTRAINT',
  'DB_UNKNOWN',
  'WORKER_LIFECYCLE',
] as const

export type ReauditErrorCategory = (typeof REAUDIT_ERROR_CATEGORIES)[number]

/** Driver-level codes mapped to bounded categories. Never logged directly. */
const MYSQL_CODE_CATEGORIES: Record<string, ReauditErrorCategory> = {
  ER_CON_COUNT_ERROR: 'DB_CONNECTION_LIMIT',
  ER_TOO_MANY_USER_CONNECTIONS: 'DB_CONNECTION_LIMIT',
  ER_USER_LIMIT_REACHED: 'DB_CONNECTION_LIMIT',
  ER_CONNECT_TIMEOUT: 'DB_CONNECTION_TIMEOUT',
  ETIMEDOUT: 'DB_CONNECTION_TIMEOUT',
  ECONNREFUSED: 'DB_CONNECTION_TIMEOUT',
  ECONNRESET: 'DB_CONNECTION_TIMEOUT',
  EPIPE: 'DB_CONNECTION_TIMEOUT',
  PROTOCOL_CONNECTION_LOST: 'DB_CONNECTION_TIMEOUT',
  ER_LOCK_WAIT_TIMEOUT: 'DB_LOCK_TIMEOUT',
  ER_LOCK_DEADLOCK: 'DB_DEADLOCK',
  ER_DUP_ENTRY: 'DB_CONSTRAINT',
  ER_NO_REFERENCED_ROW_2: 'DB_CONSTRAINT',
  ER_ROW_IS_REFERENCED_2: 'DB_CONSTRAINT',
  ER_BAD_NULL_ERROR: 'DB_CONSTRAINT',
}

export class ReauditFatalError extends Error {
  readonly phase: ReauditPhase
  readonly category: ReauditErrorCategory

  constructor(phase: ReauditPhase, category: ReauditErrorCategory) {
    super(`billing audit worker failed during ${phase}: ${category}`)
    this.phase = phase
    this.category = category
  }
}

interface RawErrorShape {
  code?: unknown
  errno?: unknown
  sqlState?: unknown
  message?: unknown
  kauditPhase?: unknown
}

function errorCodeOf(error: unknown): string | null {
  if (typeof error !== 'object' || error === null) return null
  const { code } = error as RawErrorShape
  return typeof code === 'string' ? code : null
}

/**
 * Reduces any thrown value to ONE allowlisted category.
 *
 * A driver error carrying a known code maps through the table above; anything
 * else — including application state conflicts — collapses to a bounded
 * catch-all. The original error object never survives this function.
 */
export function classifyErrorCategory(error: unknown): ReauditErrorCategory {
  const code = errorCodeOf(error)
  if (
    error instanceof RangeError ||
    (code === 'REAUDIT_ITEM_STATE_CONFLICT' || code === 'REAUDIT_QUEUE_UNAVAILABLE')
  ) {
    return 'WORKER_LIFECYCLE'
  }
  if (code && MYSQL_CODE_CATEGORIES[code]) {
    return MYSQL_CODE_CATEGORIES[code]
  }
  // mysql2 reports some conditions on `errno`/`sqlState` alone.
  if (typeof error === 'object' && error !== null) {
    const shaped = error as RawErrorShape
    if (shaped.errno === 1205) return 'DB_LOCK_TIMEOUT'
    if (shaped.errno === 1213) return 'DB_DEADLOCK'
    if (shaped.sqlState === 'HY000' && shaped.errno === 1040) {
      return 'DB_CONNECTION_LIMIT'
    }
    if (typeof shaped.errno === 'number') {
      if (shaped.errno >= 1000 && shaped.errno < 2100) return 'DB_CONSTRAINT'
      return 'DB_UNKNOWN'
    }
  }
  return 'DB_UNKNOWN'
}

/**
 * Wraps an arbitrary failure as a bounded fatal error for its lifecycle phase.
 * Pool-acquisition failures are tagged by the connection wrapper before they
 * reach this point; everything else is classified from the error shape.
 */
export function asReauditFatalError(
  phase: ReauditPhase,
  error: unknown,
): ReauditFatalError {
  if (error instanceof ReauditFatalError) return error
  const attached =
    typeof error === 'object' && error !== null
      ? (error as RawErrorShape).kauditPhase
      : undefined
  const resolvedPhase: ReauditPhase =
    attached === 'pool_acquisition' ? 'pool_acquisition' : phase
  return new ReauditFatalError(resolvedPhase, classifyErrorCategory(error))
}
