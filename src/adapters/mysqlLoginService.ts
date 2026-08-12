import { randomUUID } from 'node:crypto'
import type { Pool } from 'mysql2/promise'
import {
  recordAuditEventInTransaction,
  type TransactionalAuditConnection,
} from '../audit/transactionalAuditWriter.ts'
import type {
  CredentialRepository,
  CredentialUser,
} from '../auth/credentialTypes.ts'
import {
  accountStateReason,
  boundLoginAttempt,
  buildLoginAuditEvent,
  deriveLoginGuardDigest,
  deriveLoginGuardSecret,
  guardBlockedUntil,
  guardDenialReason,
  guardExpiresAt,
  guardWindowCutoff,
  isGuardBlocked,
  loginControlHash,
  loginFault,
  trustedLoginInstant,
  LoginError,
  LOGIN_ACTIVE_STATUS,
  LOGIN_DENIAL_REASONS,
  LOGIN_DENIED,
  LOGIN_FAILURE_THRESHOLDS,
  LOGIN_FAULT_CODES,
  LOGIN_GUARD_MAX_FAILURE_COUNT,
  LOGIN_GUARD_SCOPES,
  SYNTHETIC_PASSWORD_HASH,
  type LoginDenialReason,
  type LoginDenialSink,
  type LoginGuardScope,
  type LoginGuardState,
  type LoginRequest,
  type LoginResult,
  type LoginServicePort,
} from '../auth/loginService.ts'
import {
  isStoredPasswordHashValid,
  verifyPassword,
} from '../auth/passwordHash.ts'

/**
 * The mysql2 half of database login — the only place a statement runs.
 *
 * Every statement is a module constant in {@link LOGIN_SQL} with bound
 * placeholders. No table, column, filter, or value is ever assembled from a
 * caller value, so there is no dynamic SQL anywhere in this file. The only
 * caller-derived value that reaches the driver on the throttle path is a keyed
 * HMAC digest: the login identifier, the email, and the client network source
 * are inputs to that digest and are never bound, logged, or stored.
 *
 * The shape of one attempt:
 *
 *   1. bound the sizes — arithmetic only, before any HMAC, KDF, or statement;
 *   2. derive the two guard digests and read both guards;
 *   3. refuse a blocked guard HERE, before the KDF is bought;
 *   4. look the account up and run EXACTLY ONE scrypt verification — against
 *      the stored hash for a known account, against the module's synthetic hash
 *      for an unknown or unparseable one;
 *   5. on failure, record both guard counters and deny;
 *   6. on success, ONE transaction: lock and re-read the account, confirm it is
 *      still active at the generation that was verified, lock the role rows the
 *      authorization is built from, stamp `last_login_at`, clear both guards,
 *      append the audit event, commit. A session may only be issued by the
 *      caller after that commit returns.
 *
 * The tables touched are `kaudit_login_guard`, `kaudit_user`,
 * `kaudit_user_credential`, `kaudit_user_role`, and the audit-chain tables the
 * writer owns. Nothing else, and nothing outside the `kaudit_*` schema.
 */

// ---------------------------------------------------------------------------
// Connection surface
// ---------------------------------------------------------------------------

/**
 * The narrow slice of a pooled connection used here.
 *
 * Parameter and result types are widened for the reason given in
 * `audit/transactionalAuditWriter.ts`: a real `PoolConnection` and a recording
 * fake both satisfy this, and every result is narrowed before it is read.
 */
export interface LoginConnection extends TransactionalAuditConnection {
  beginTransaction(): Promise<void>
  commit(): Promise<void>
  rollback(): Promise<void>
  release(): void
}

export interface LoginPool {
  execute(sql: string, values?: any): Promise<unknown>
  getConnection(): Promise<LoginConnection>
}

/** Compile-time proof that a real mysql2 pool satisfies the structural port. */
export function fromMysqlPool(pool: Pool): LoginPool {
  return pool
}

// ---------------------------------------------------------------------------
// Statements
// ---------------------------------------------------------------------------

/** Only real people can sign in; a `kind='system'` row is an internal actor. */
const USER_KIND = 'user'

export const LOGIN_SQL = {
  /**
   * Both guards in one round trip. Two (scope, digest) pairs against the
   * composite primary key, so this is two point lookups and never a scan.
   */
  selectGuards: `SELECT guard_scope, failure_count, blocked_until
  FROM kaudit_login_guard
  WHERE (guard_scope = ? AND guard_digest = ?)
     OR (guard_scope = ? AND guard_digest = ?)`,

  /**
   * One failure, as one atomic upsert.
   *
   * A read-modify-write would lose increments under concurrency: two failures
   * arriving together would both read N and both write N+1. Here the row's own
   * lock serializes them — the second waits for the first and observes its
   * result — so every failure counts exactly once.
   *
   * The assignment order is deliberate. MySQL evaluates ON DUPLICATE KEY UPDATE
   * assignments left to right, and a later one sees columns the earlier ones
   * already wrote. `blocked_until` is therefore FIRST, so every right-hand side
   * in this list reads the PRE-UPDATE row and the statement means the same thing
   * regardless of how an implementation orders the writes:
   *
   *   * `blocked_until`     — block when the count this failure produces reaches
   *                           the threshold; otherwise leave the existing value,
   *                           which is either NULL or already in the past.
   *   * `failure_count`     — restart at 1 when the window has expired, else
   *                           increment, clamped so a counter stays a counter.
   *   * `window_started_at` — move only when the window has expired.
   *
   * Every bound value is a fixed scalar: a scope constant, a hex digest, an
   * instant, or an integer from module policy.
   */
  upsertGuard: `INSERT INTO kaudit_login_guard
    (guard_scope, guard_digest, failure_count, window_started_at,
     last_failure_at, blocked_until, expires_at)
  VALUES (?, ?, 1, ?, ?, NULL, ?)
  ON DUPLICATE KEY UPDATE
    blocked_until     = IF(IF(window_started_at <= ?, 1, failure_count + 1) >= ?,
                           ?, blocked_until),
    failure_count     = IF(window_started_at <= ?, 1,
                           LEAST(failure_count + 1, ?)),
    window_started_at = IF(window_started_at <= ?, ?, window_started_at),
    last_failure_at   = ?,
    expires_at        = ?`,

  /**
   * The reset, run inside the success transaction.
   *
   * Deleting is the reset: a row that no longer counts anything holds nothing
   * worth keeping, and removing it is also what keeps this table small. Exactly
   * the two guards this attempt used are named, so a success can never clear
   * anyone else's counters.
   */
  deleteGuards: `DELETE FROM kaudit_login_guard
  WHERE (guard_scope = ? AND guard_digest = ?)
     OR (guard_scope = ? AND guard_digest = ?)`,

  /**
   * The locked re-read. `FOR UPDATE` holds both rows for the rest of the
   * transaction, so a concurrent disable, password reset, or tombstone either
   * lands before this read or waits behind the commit — it cannot slip between
   * the check and the session.
   */
  lockAccount: `SELECT
    u.id                    AS id,
    u.status                AS user_status,
    u.max_sensitivity_tier  AS max_sensitivity_tier,
    c.status                AS credential_status,
    c.session_version       AS session_version
  FROM kaudit_user u
  JOIN kaudit_user_credential c ON c.user_id = u.id
  WHERE u.kind = ? AND u.id = ?
  FOR UPDATE`,

  /**
   * Roles as their own read, and a LOCKING one.
   *
   * Authorization is built from these rows, so they are held for the rest of the
   * transaction exactly as the account row is: a grant or a revoke that arrives
   * while this login is being completed either lands before this read or waits
   * behind the commit, and cannot land between the read and the authorization
   * built from it. Separate from the account lock because an aggregate and
   * `FOR UPDATE` do not mix.
   */
  selectRoles: `SELECT role_code
  FROM kaudit_user_role
  WHERE user_id = ?
  ORDER BY role_code
  FOR UPDATE`,

  /** Guarded by the same state the decision was made on. */
  updateLastLogin: `UPDATE kaudit_user
  SET last_login_at = ?
  WHERE id = ? AND kind = ? AND status = ?`,
} as const

// ---------------------------------------------------------------------------
// Result narrowing
// ---------------------------------------------------------------------------

interface GuardRow {
  guard_scope: unknown
  failure_count: unknown
  blocked_until: unknown
}

interface AccountRow {
  id: string
  user_status: string
  max_sensitivity_tier: string
  credential_status: string
  session_version: number | string
}

interface RoleRow {
  role_code: string
}

function rows<T>(result: unknown): T[] {
  const first = Array.isArray(result) ? (result[0] as unknown) : undefined
  return Array.isArray(first) ? (first as T[]) : []
}

function affectedRows(result: unknown): number {
  const header = Array.isArray(result)
    ? (result[0] as { affectedRows?: unknown })
    : undefined
  return Number(header?.affectedRows ?? 0)
}

/** The column is `int unsigned`; this is its full declared range. */
const MAX_SESSION_VERSION = 4_294_967_295

/**
 * A session generation, or null. `Number()` alone would turn NULL into 0 and
 * '3.5' into a fraction, and either would mint a session that no
 * `session_version` increment could revoke.
 */
function toSessionVersion(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isInteger(value) && value >= 1 && value <= MAX_SESSION_VERSION
      ? value
      : null
  }
  if (typeof value === 'string' && /^[0-9]{1,10}$/.test(value)) {
    const parsed = Number(value)
    return parsed >= 1 && parsed <= MAX_SESSION_VERSION ? parsed : null
  }
  return null
}

/** The driver hands back a Date, or a string when `dateStrings` is configured. */
function toDate(value: unknown): Date | null {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value
  }
  if (typeof value !== 'string') return null
  const match =
    /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?$/.exec(
      value,
    )
  if (!match) return null
  const [, year, month, day, hour, minute, second, fraction = ''] = match
  const parts = [year, month, day, hour, minute, second].map(Number)
  const [y, mo, d, h, mi, s] = parts
  const millisecond = Number(fraction.padEnd(3, '0').slice(0, 3))
  const parsed = new Date(Date.UTC(y, mo - 1, d, h, mi, s, millisecond))
  if (
    parsed.getUTCFullYear() !== y ||
    parsed.getUTCMonth() !== mo - 1 ||
    parsed.getUTCDate() !== d ||
    parsed.getUTCHours() !== h ||
    parsed.getUTCMinutes() !== mi ||
    parsed.getUTCSeconds() !== s
  ) {
    return null
  }
  return parsed
}

/**
 * A failure counter, or null when the stored value is not one.
 *
 * Deliberately a narrowing rather than a coercion. `Number()` turns NULL into
 * 0, and clamping an out-of-range value would accept a counter the column's own
 * CHECK forbids — either one would read a tampered or corrupt row as "no
 * failures yet", which is the throttle switching itself off. The column is
 * `int unsigned` bounded by `ck_login_guard_failure_count`, so anything outside
 * that range, or with a fraction, is not a value this module will decide on.
 */
function toFailureCount(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isInteger(value) &&
      value >= 0 &&
      value <= LOGIN_GUARD_MAX_FAILURE_COUNT
      ? value
      : null
  }
  if (typeof value === 'string' && /^[0-9]{1,10}$/.test(value)) {
    const parsed = Number(value)
    return parsed <= LOGIN_GUARD_MAX_FAILURE_COUNT ? parsed : null
  }
  return null
}

/**
 * `blocked_until` narrowed. The column is nullable, so ABSENT is a valid state
 * — "this guard is counting but not blocking" — and is the one case that reads
 * as null. A present value that cannot be read as an instant is not absent: it
 * is corruption, and reporting it as null would unblock a blocked guard.
 */
function toBlockedUntil(
  value: unknown,
): { ok: true; value: Date | null } | { ok: false } {
  if (value === null || value === undefined) return { ok: true, value: null }
  const parsed = toDate(value)
  return parsed ? { ok: true, value: parsed } : { ok: false }
}

function isGuardScope(value: unknown): value is LoginGuardScope {
  return (
    value === LOGIN_GUARD_SCOPES.login || value === LOGIN_GUARD_SCOPES.source
  )
}

// ---------------------------------------------------------------------------
// Transaction plumbing
// ---------------------------------------------------------------------------

/**
 * Releases the transaction on a failure path. A rollback that itself fails means
 * the connection is already unusable and the pool discards it on release;
 * raising that would replace the bounded code describing what actually went
 * wrong with an unbounded driver error.
 */
async function safeRollback(connection: LoginConnection): Promise<void> {
  try {
    await connection.rollback()
  } catch {
    // Nothing to add, and nothing safe to say about it.
  }
}

/** Bounded translation. A value thrown by the driver is never read or wrapped. */
function asLoginError(error: unknown): LoginError {
  if (error instanceof LoginError) return error
  return loginFault(LOGIN_FAULT_CODES.unexpected)
}

interface TransactionOutcome<T> {
  /** False for a decided denial: there is nothing to keep, so nothing is kept. */
  commit: boolean
  value: T
}

async function inTransaction<T>(
  pool: LoginPool,
  body: (connection: LoginConnection) => Promise<TransactionOutcome<T>>,
): Promise<T> {
  let connection: LoginConnection
  try {
    connection = await pool.getConnection()
  } catch {
    throw loginFault(LOGIN_FAULT_CODES.unexpected)
  }
  try {
    try {
      await connection.beginTransaction()
    } catch {
      throw loginFault(LOGIN_FAULT_CODES.unexpected)
    }
    let outcome: TransactionOutcome<T>
    try {
      outcome = await body(connection)
    } catch (error) {
      await safeRollback(connection)
      throw asLoginError(error)
    }
    if (!outcome.commit) {
      await safeRollback(connection)
      return outcome.value
    }
    try {
      await connection.commit()
    } catch {
      await safeRollback(connection)
      throw loginFault(LOGIN_FAULT_CODES.commitFailed)
    }
    return outcome.value
  } finally {
    connection.release()
  }
}

// ---------------------------------------------------------------------------
// The service
// ---------------------------------------------------------------------------

export interface MysqlLoginServiceOptions {
  /**
   * The session signing secret. Used HERE only to derive the login-guard key,
   * through its own HMAC context; this service never mints a session, and the
   * secret is never stored, bound to a statement, or logged.
   */
  sessionSecret: string
  /** The trusted clock. Injected so a test can pin windows without a race. */
  now?: () => Date
  /** Injected for the same reason: the audit event's correlation id. */
  newId?: () => string
  /** Injected so a test can count verifications. Defaults to the real KDF. */
  verifyPassword?: (password: unknown, storedHash: unknown) => Promise<boolean>
  /** Optional operator-side sink for bounded denial reasons. */
  denialSink?: LoginDenialSink
}

/** The two guard keys one attempt uses. Digests only; no pre-image is kept. */
interface GuardKeys {
  /** Null when the submitted login was in-size but not a login shape. */
  login: string | null
  source: string
}

export function createMysqlLoginService(
  pool: LoginPool,
  credentials: CredentialRepository,
  options: MysqlLoginServiceOptions,
): LoginServicePort {
  const now = options.now ?? (() => new Date())
  const newId = options.newId ?? randomUUID
  const verify = options.verifyPassword ?? verifyPassword
  const sink = options.denialSink

  /**
   * The trusted clock, checked before anything is derived from it.
   *
   * A clock that throws, or that answers with something other than a usable
   * instant, is installation configuration in the same way the secret is — so
   * it is the same bounded AUTH_CONFIG_INVALID, and whatever it threw is
   * neither read nor wrapped. Checked on every attempt and not only at
   * construction, because a clock is a function and can start answering
   * differently at any point.
   */
  function trustedNow(): Date {
    let value: unknown
    try {
      value = now()
    } catch {
      throw loginFault(LOGIN_FAULT_CODES.configInvalid)
    }
    return trustedLoginInstant(value)
  }

  // Like the secret: a misconfigured installation should fail to start rather
  // than fail on its first login.
  if (typeof now !== 'function') {
    throw loginFault(LOGIN_FAULT_CODES.configInvalid)
  }
  trustedNow()
  // Validate the clock before buying even the key-derivation HMAC. A broken
  // installation fails at the first configuration boundary it crosses.
  const guardSecret = deriveLoginGuardSecret(options?.sessionSecret)

  /**
   * Every denial, in one place, with one shape.
   *
   * The bounded reason goes to the operator-side sink; the value returned to the
   * caller is the same constant every time, so no denial is distinguishable from
   * any other. A sink that throws is swallowed: recording why is never allowed
   * to change what.
   *
   * There is deliberately NO audit-log row per failed attempt. The audit log is
   * hash chained, which means every append locks one chain-head row — so an
   * unauthenticated request that could force an append would let anyone
   * serialize the whole installation's audit writes and grow the table without
   * limit. Failures are recorded in the bounded, self-expiring counters of
   * `kaudit_login_guard` instead, and this sink carries the fixed reason code to
   * whatever operational channel the caller wires up. Successes are audited, and
   * they cost an attacker a correct password.
   */
  function deny(reason: LoginDenialReason, at: Date): LoginResult {
    try {
      sink?.record({ reason, occurredAt: at })
    } catch {
      // Never load-bearing.
    }
    return LOGIN_DENIED
  }

  function guardPairs(keys: GuardKeys): [LoginGuardScope, string][] {
    const pairs: [LoginGuardScope, string][] = [
      [LOGIN_GUARD_SCOPES.source, keys.source],
    ]
    if (keys.login) {
      pairs.unshift([LOGIN_GUARD_SCOPES.login, keys.login])
    }
    return pairs
  }

  /**
   * The two-pair parameter list the fixed statements take.
   *
   * When there is no login digest — an in-size value that is not a login shape —
   * the source pair is named twice. The statements address rows by primary key,
   * so naming one row twice reads and clears exactly that one row, and the
   * statement text still never varies.
   */
  function guardPairParameters(keys: GuardKeys): unknown[] {
    const source = [LOGIN_GUARD_SCOPES.source, keys.source]
    const login = keys.login
      ? [LOGIN_GUARD_SCOPES.login, keys.login]
      : [...source]
    return [...login, ...source]
  }

  async function readGuards(keys: GuardKeys): Promise<LoginGuardState[]> {
    let result: unknown
    try {
      result = await pool.execute(
        LOGIN_SQL.selectGuards,
        guardPairParameters(keys),
      )
    } catch {
      throw loginFault(LOGIN_FAULT_CODES.guardReadFailed)
    }
    const states: LoginGuardState[] = []
    const seen = new Set<LoginGuardScope>()
    for (const row of rows<GuardRow>(result)) {
      // A row that is not a guard row is refused, never repaired. Skipping an
      // unknown scope, coercing a broken counter to zero, or reading an
      // unreadable block instant as "not blocked" would each turn one corrupt
      // row into a throttle that silently stopped throttling. The statement
      // addresses at most one row per scope through the composite primary key,
      // so a second row for a scope is corruption too.
      if (!isGuardScope(row.guard_scope) || seen.has(row.guard_scope)) {
        throw loginFault(LOGIN_FAULT_CODES.guardStateMalformed)
      }
      const failureCount = toFailureCount(row.failure_count)
      const blockedUntil = toBlockedUntil(row.blocked_until)
      if (failureCount === null || !blockedUntil.ok) {
        throw loginFault(LOGIN_FAULT_CODES.guardStateMalformed)
      }
      seen.add(row.guard_scope)
      states.push({
        scope: row.guard_scope,
        failureCount,
        blockedUntil: blockedUntil.value,
      })
    }
    return states
  }

  /**
   * Records one failure against every guard this attempt has a key for.
   *
   * Its own transaction, so both counters move together or neither does, and so
   * a failure is durable before the denial is returned. An unknown account still
   * counts: the whole point of the source guard is to bound an attacker who is
   * guessing usernames, and those attempts never match a row.
   *
   * A write that cannot be made is a fault, not a denial. Failing closed is the
   * conservative choice — the alternative is a login form that silently stops
   * throttling exactly when the database is unhealthy.
   */
  async function recordFailure(keys: GuardKeys, at: Date): Promise<void> {
    const cutoff = guardWindowCutoff(at)
    const blockedUntil = guardBlockedUntil(at)
    const expiresAt = guardExpiresAt(at)
    try {
      await inTransaction(pool, async (connection) => {
        for (const [scope, digest] of guardPairs(keys)) {
          await connection.execute(LOGIN_SQL.upsertGuard, [
            scope,
            digest,
            at,
            at,
            expiresAt,
            cutoff,
            LOGIN_FAILURE_THRESHOLDS[scope],
            blockedUntil,
            cutoff,
            LOGIN_GUARD_MAX_FAILURE_COUNT,
            cutoff,
            at,
            at,
            expiresAt,
          ])
        }
        return { commit: true, value: undefined }
      })
    } catch {
      throw loginFault(LOGIN_FAULT_CODES.guardWriteFailed)
    }
  }

  /**
   * The success transaction. Nothing here trusts the pre-transaction read: the
   * account is locked and read again, and the generation that was verified must
   * still be the current one.
   */
  async function completeLogin(
    account: CredentialUser,
    keys: GuardKeys,
    at: Date,
  ): Promise<LoginResult> {
    const correlationId = newId()
    const eventId = newId()
    return inTransaction<LoginResult>(pool, async (connection) => {
      const locked = await read<AccountRow>(connection, LOGIN_SQL.lockAccount, [
        USER_KIND,
        account.id,
      ])
      const row = locked[0]
      if (!row) {
        return {
          commit: false,
          value: deny(LOGIN_DENIAL_REASONS.stateChanged, at),
        }
      }
      const sessionVersion = toSessionVersion(row.session_version)
      if (sessionVersion === null) {
        throw loginFault(LOGIN_FAULT_CODES.stateMalformed)
      }
      // The two conditions the verification was made under: still usable, and
      // still the same generation. Either one moving means the state changed
      // under us, and the answer is a denial rather than a reconciliation.
      const stateReason = accountStateReason({
        status: row.user_status,
        credentialStatus: row.credential_status,
      })
      if (stateReason || sessionVersion !== account.sessionVersion) {
        return {
          commit: false,
          value: deny(LOGIN_DENIAL_REASONS.stateChanged, at),
        }
      }

      const roles = (
        await read<RoleRow>(connection, LOGIN_SQL.selectRoles, [account.id])
      )
        .map((roleRow) => roleRow.role_code)
        .filter((role): role is string => typeof role === 'string')

      // Exactly one row: the guard repeats the state the decision was made on,
      // so a concurrent change that slipped past the lock is refused rather
      // than stamped over. `last_login_at` moves on every login, so a matched
      // row is always a changed row.
      await write(
        connection,
        LOGIN_SQL.updateLastLogin,
        [at, account.id, USER_KIND, LOGIN_ACTIVE_STATUS],
        1,
      )

      // Reset in the SAME transaction as the login it belongs to: a rollback
      // after this point must not leave the guards cleared. No row count is
      // asserted — an account that never failed has no rows to clear.
      try {
        await connection.execute(
          LOGIN_SQL.deleteGuards,
          guardPairParameters(keys),
        )
      } catch {
        throw loginFault(LOGIN_FAULT_CODES.guardWriteFailed)
      }

      try {
        await recordAuditEventInTransaction(
          connection,
          buildLoginAuditEvent({
            userId: account.id,
            controlHash: loginControlHash({
              userId: account.id,
              userStatus: row.user_status,
              credentialStatus: row.credential_status,
              roles,
              sessionVersion,
            }),
            correlationId,
            occurredAt: at,
          }),
          eventId,
        )
      } catch {
        // An unauditable login is not a login: the whole transaction goes back,
        // and no session may be issued from it.
        throw loginFault(LOGIN_FAULT_CODES.auditFailed)
      }

      return {
        commit: true,
        value: {
          ok: true,
          authorization: {
            userId: account.id,
            sessionVersion,
            roles,
            maxSensitivityTier: row.max_sensitivity_tier,
          },
        },
      }
    })
  }

  return {
    async authenticate(request: LoginRequest): Promise<LoginResult> {
      // The clock first: every instant this attempt binds, blocks on, or stamps
      // comes from it, and it is checked before an HMAC, a KDF, or a statement.
      const at = trustedNow()

      // Sizes first: everything refused here is refused on arithmetic alone,
      // before an HMAC, a KDF, or a statement is bought.
      const bounded = boundLoginAttempt({
        login: request?.login,
        password: request?.password,
        clientSource: request?.clientSource,
      })
      if (!bounded.ok) return deny(bounded.reason, at)
      const { normalizedLogin, password, clientSource } = bounded.attempt

      const keys: GuardKeys = {
        login: normalizedLogin
          ? deriveLoginGuardDigest(
              LOGIN_GUARD_SCOPES.login,
              normalizedLogin,
              guardSecret,
            )
          : null,
        source: deriveLoginGuardDigest(
          LOGIN_GUARD_SCOPES.source,
          clientSource,
          guardSecret,
        ),
      }

      // Before the KDF, on purpose: a throttled attempt must be cheap for us and
      // no cheaper for the attacker to distinguish.
      const blocked = (await readGuards(keys)).find((state) =>
        isGuardBlocked(state, at),
      )
      if (blocked) {
        // Deliberately NOT counted. Counting a refused attempt would let anyone
        // hold a victim's account blocked forever by continuing to knock, and
        // would buy a write per request while blocked.
        return deny(guardDenialReason(blocked.scope), at)
      }

      let account: CredentialUser | null = null
      if (normalizedLogin) {
        try {
          account = await credentials.findByLogin(normalizedLogin)
        } catch {
          throw loginFault(LOGIN_FAULT_CODES.readFailed)
        }
      }

      // EXACTLY ONE verification, whatever happened above. An unknown login, an
      // in-size login that is not a login shape, and a row whose stored hash is
      // unparseable (a tombstoned account carries a deliberately unparseable
      // sentinel) are all charged against the module's synthetic hash, so none
      // of them returns faster than a real account with a wrong password.
      //
      // `storedHash` is null for every one of those: it records that the
      // verification below was a DUMMY, bought for timing parity and for
      // nothing else.
      const storedHash =
        account && isStoredPasswordHashValid(account.passwordHash)
          ? account.passwordHash
          : null
      const verified = await verify(
        password,
        storedHash ?? SYNTHETIC_PASSWORD_HASH,
      )

      if (!account) {
        await recordFailure(keys, at)
        return deny(
          normalizedLogin
            ? LOGIN_DENIAL_REASONS.accountUnknown
            : LOGIN_DENIAL_REASONS.loginMalformed,
          at,
        )
      }
      // A stored hash this module cannot parse is a denial on its own, BEFORE
      // `verified` is consulted — and `verified` is not consulted on this path
      // at all. The dummy verification above answered about the synthetic hash,
      // not about this account, so whatever it returned says nothing: a
      // verifier that answered true for it must still produce the same public
      // denial, the same guard writes, and no success transaction. The account's
      // own state reason is preferred when it has one, because a tombstoned row
      // carries a deliberately unparseable sentinel and that is worth telling an
      // operator apart from a hash that is merely broken.
      if (storedHash === null) {
        await recordFailure(keys, at)
        return deny(
          accountStateReason({
            status: account.status,
            credentialStatus: account.credentialStatus,
          }) ?? LOGIN_DENIAL_REASONS.credentialUnusable,
          at,
        )
      }
      if (!verified) {
        await recordFailure(keys, at)
        return deny(LOGIN_DENIAL_REASONS.passwordMismatch, at)
      }
      const stateReason = accountStateReason({
        status: account.status,
        credentialStatus: account.credentialStatus,
      })
      if (stateReason) {
        await recordFailure(keys, at)
        return deny(stateReason, at)
      }

      return completeLogin(account, keys, at)
    },
  }
}

// ---------------------------------------------------------------------------
// Bounded statement helpers
// ---------------------------------------------------------------------------

async function read<T>(
  connection: LoginConnection,
  sql: string,
  parameters: unknown[],
): Promise<T[]> {
  try {
    return rows<T>(await connection.execute(sql, parameters))
  } catch {
    throw loginFault(LOGIN_FAULT_CODES.readFailed)
  }
}

/** One guarded write, with its row count checked exactly. */
async function write(
  connection: LoginConnection,
  sql: string,
  parameters: unknown[],
  expected: number,
): Promise<void> {
  let result: unknown
  try {
    result = await connection.execute(sql, parameters)
  } catch {
    throw loginFault(LOGIN_FAULT_CODES.writeFailed)
  }
  if (affectedRows(result) !== expected) {
    throw loginFault(LOGIN_FAULT_CODES.writeCountUnexpected)
  }
}
