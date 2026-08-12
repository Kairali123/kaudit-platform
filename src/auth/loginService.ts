import { createHash, createHmac } from 'node:crypto'
import type { AuditEvent } from '../audit/types.ts'
import { sha256Hex } from '../lib/hash.ts'
import { LOGIN_MAX_LENGTH, normalizeLogin } from './credentialIdentity.ts'
import { PASSWORD_MAX_BYTES, PASSWORD_MAX_LENGTH } from './passwordHash.ts'
import { SESSION_MIN_SECRET_LENGTH } from './userSession.ts'

/**
 * Database login — the framework-neutral half.
 *
 * Names, input bounds, guard-key derivation, the throttle policy, the denial
 * vocabulary, and the audit event. Nothing here opens a connection, runs a
 * statement, reads the environment, or knows that HTTP exists; the mysql2 half
 * lives in `adapters/mysqlLoginService.ts` and is the only place a statement
 * runs. The OIDC path is untouched and remains the production entry point.
 *
 * Three properties this module exists to make testable in isolation:
 *
 *  - **One public denial.** Malformed, unknown, wrong password, inactive,
 *    disabled, tombstoned, and throttled all produce the same
 *    {@link LOGIN_DENIED_CODE}. The bounded reasons in
 *    {@link LOGIN_DENIAL_REASONS} exist for an operator-side event sink and are
 *    never part of a result a browser can observe.
 *  - **One KDF per attempt.** A known account is verified against its stored
 *    hash; an unknown or unparseable login is verified against
 *    {@link SYNTHETIC_PASSWORD_HASH}. Both cost one real default-cost scrypt,
 *    so response time does not answer "does this account exist".
 *  - **Nothing in the clear.** The throttle is keyed by a keyed HMAC digest, so
 *    the login identifier and the client network source are inputs to the guard
 *    and never values in it.
 */

// ---------------------------------------------------------------------------
// Names and policy
// ---------------------------------------------------------------------------

/** The two independent guards. Fixed vocabulary; never a caller value. */
export const LOGIN_GUARD_SCOPES = {
  /** One normalized login identifier. */
  login: 'login',
  /** One client network source string, as the caller's transport resolved it. */
  source: 'source',
} as const

export type LoginGuardScope =
  (typeof LOGIN_GUARD_SCOPES)[keyof typeof LOGIN_GUARD_SCOPES]

/**
 * Bounds on the client network source, applied before it is hashed.
 *
 * Wide enough for an IPv6 address with a zone or a bounded proxy-supplied
 * token, narrow enough that an unbounded header cannot buy HMAC work. Printable
 * ASCII only, so the value can never contain the separator used below or a
 * control character that a log line would render as something else.
 */
export const CLIENT_SOURCE_MAX_LENGTH = 100
const CLIENT_SOURCE_PATTERN = /^[\x21-\x7e]{1,100}$/

/** Failures are counted in a fixed window; an older window starts over. */
export const LOGIN_FAILURE_WINDOW_SECONDS = 15 * 60

/**
 * Failures tolerated inside one window before a temporary block.
 *
 * The identifier threshold is conservative — a human mistypes a password a
 * handful of times, not five hundred. The source threshold is deliberately much
 * looser: a whole office behind one egress address shares it, and locking that
 * out at five attempts would be a self-inflicted outage.
 */
export const LOGIN_FAILURE_THRESHOLDS: Record<LoginGuardScope, number> = {
  login: 5,
  source: 50,
}

/** How long a crossed threshold blocks for. Temporary, never a lockout. */
export const LOGIN_BLOCK_SECONDS = 15 * 60

/** How long a guard row may survive its last failure before cleanup may drop it. */
export const LOGIN_GUARD_RETENTION_SECONDS = 24 * 60 * 60

/** Matches `ck_login_guard_failure_count`. A counter, not an accumulator. */
export const LOGIN_GUARD_MAX_FAILURE_COUNT = 1_000_000

/** `kaudit_login_guard.guard_digest` is a hex SHA-256. */
export const LOGIN_GUARD_DIGEST_LENGTH = 64

export const LOGIN_AUDIT_ACTION = 'auth.login'
export const LOGIN_AUDIT_CLIENT = 'auth:database-login'
export const LOGIN_AUDIT_PURPOSE = 'authentication'

// ---------------------------------------------------------------------------
// The public denial, and the internal reasons behind it
// ---------------------------------------------------------------------------

/**
 * The ONLY authentication code a caller — and therefore a browser — ever sees.
 *
 * Every denial is this code with the same shape, so nothing about lookup,
 * account state, password correctness, or throttling can be read off a response.
 */
export const LOGIN_DENIED_CODE = 'AUTH_INVALID_CREDENTIALS'
export type LoginDeniedCode = typeof LOGIN_DENIED_CODE

/**
 * Bounded internal reasons. Operator-side only.
 *
 * These are constants: no reason carries a login, an email, a network source, a
 * digest, a hash, or a driver message, so a sink that records them cannot become
 * a record of who tried to sign in.
 */
export const LOGIN_DENIAL_REASONS = {
  /** Over the size bound. Refused before any HMAC, KDF, or statement. */
  loginOversize: 'LOGIN_OVERSIZE',
  passwordMissing: 'PASSWORD_MISSING',
  passwordOversize: 'PASSWORD_OVERSIZE',
  clientSourceInvalid: 'CLIENT_SOURCE_INVALID',
  /** In-size but not a login shape. Still costs one dummy verification. */
  loginMalformed: 'LOGIN_MALFORMED',
  /** Refused by a guard, before the KDF. */
  loginThrottled: 'LOGIN_THROTTLED',
  sourceThrottled: 'SOURCE_THROTTLED',
  accountUnknown: 'ACCOUNT_UNKNOWN',
  passwordMismatch: 'PASSWORD_MISMATCH',
  accountInactive: 'ACCOUNT_INACTIVE',
  credentialDisabled: 'CREDENTIAL_DISABLED',
  credentialTombstoned: 'CREDENTIAL_TOMBSTONED',
  /**
   * The stored hash is not a shape this module can verify against, so the one
   * verification the attempt bought was charged to
   * {@link SYNTHETIC_PASSWORD_HASH} for timing parity only. Its result decides
   * nothing: an account whose stored hash cannot be parsed is denied on this
   * reason rather than on whatever the verifier answered.
   */
  credentialUnusable: 'CREDENTIAL_UNUSABLE',
  /** The verified state moved between verification and the locked re-read. */
  stateChanged: 'STATE_CHANGED',
} as const

export type LoginDenialReason =
  (typeof LOGIN_DENIAL_REASONS)[keyof typeof LOGIN_DENIAL_REASONS]

/**
 * Faults: something went wrong and nothing was decided.
 *
 * Distinct from a denial on purpose — an unavailable database is not a wrong
 * password, and reporting it as one would hide an outage behind a login form.
 * Every code is a constant that is true of the installation, not of an account,
 * so none of them can be used to probe for a user.
 */
export const LOGIN_FAULT_CODES = {
  /** The service was constructed with an unusable secret or clock. */
  configInvalid: 'AUTH_CONFIG_INVALID',
  guardReadFailed: 'AUTH_GUARD_READ_FAILED',
  /**
   * A guard row was read but is not a guard row: an unknown scope, a counter
   * that is not a bounded integer, an unreadable block instant, or two rows for
   * one scope. Refused rather than repaired — skipping the row, coercing the
   * counter, or reading an unreadable block instant as "not blocked" would each
   * turn one corrupt row into a silently disabled throttle.
   */
  guardStateMalformed: 'AUTH_GUARD_STATE_MALFORMED',
  /** The throttle could not be recorded, so the attempt is not completed. */
  guardWriteFailed: 'AUTH_GUARD_WRITE_FAILED',
  readFailed: 'AUTH_READ_FAILED',
  writeFailed: 'AUTH_WRITE_FAILED',
  writeCountUnexpected: 'AUTH_WRITE_COUNT_UNEXPECTED',
  /** A stored value is not a shape this module will mint a session from. */
  stateMalformed: 'AUTH_STATE_MALFORMED',
  auditFailed: 'AUTH_AUDIT_FAILED',
  commitFailed: 'AUTH_COMMIT_FAILED',
  unexpected: 'AUTH_UNEXPECTED_FAILURE',
} as const

export type LoginFaultCode =
  (typeof LOGIN_FAULT_CODES)[keyof typeof LOGIN_FAULT_CODES]

/**
 * The only error this surface raises, and it is never a denial.
 *
 * It carries a bounded code and nothing else. `Error.message` is the code, so an
 * accidental `console.error(error)` upstream prints a constant rather than a
 * driver message quoting a statement and its parameters.
 */
export class LoginError extends Error {
  readonly code: LoginFaultCode

  constructor(code: LoginFaultCode) {
    super(code)
    this.name = 'LoginError'
    this.code = code
  }
}

export function loginFault(code: LoginFaultCode): LoginError {
  return new LoginError(code)
}

// ---------------------------------------------------------------------------
// Input bounds
// ---------------------------------------------------------------------------

/**
 * An attempt whose sizes have been checked.
 *
 * `normalizedLogin` is null when the value was inside the size bound but is not
 * a login shape. That case deliberately continues rather than returning: it must
 * cost the same as an unknown account, which means one real verification.
 */
export interface BoundedLoginAttempt {
  normalizedLogin: string | null
  password: string
  clientSource: string
}

export type BoundLoginResult =
  | { ok: true; attempt: BoundedLoginAttempt }
  | { ok: false; reason: LoginDenialReason }

/**
 * Size bounds, applied before any HMAC, KDF, or statement.
 *
 * Everything refused here is refused on arithmetic alone, so an oversized field
 * cannot buy hashing work or a database round trip. The login is normalized
 * exactly ONCE, here, and every later step — the guard digest, the lookup, the
 * audit — uses that one normalized value.
 */
export function boundLoginAttempt(input: {
  login: unknown
  password: unknown
  clientSource: unknown
}): BoundLoginResult {
  if (typeof input?.password !== 'string' || input.password.length === 0) {
    return { ok: false, reason: LOGIN_DENIAL_REASONS.passwordMissing }
  }
  if (
    input.password.length > PASSWORD_MAX_LENGTH ||
    Buffer.byteLength(input.password, 'utf8') > PASSWORD_MAX_BYTES
  ) {
    return { ok: false, reason: LOGIN_DENIAL_REASONS.passwordOversize }
  }
  if (
    typeof input.clientSource !== 'string' ||
    input.clientSource.length > CLIENT_SOURCE_MAX_LENGTH ||
    !CLIENT_SOURCE_PATTERN.test(input.clientSource)
  ) {
    return { ok: false, reason: LOGIN_DENIAL_REASONS.clientSourceInvalid }
  }
  if (typeof input.login !== 'string' || input.login.length > LOGIN_MAX_LENGTH) {
    return { ok: false, reason: LOGIN_DENIAL_REASONS.loginOversize }
  }
  return {
    ok: true,
    attempt: {
      normalizedLogin: normalizeLogin(input.login),
      password: input.password,
      clientSource: input.clientSource,
    },
  }
}

// ---------------------------------------------------------------------------
// Guard keys
// ---------------------------------------------------------------------------

/**
 * Domain separation. The two contexts are distinct strings, so the key the
 * digests are computed under is not the key anything else is computed under,
 * and the scope inside the message means the `login` and `source` guards for the
 * same text are different rows.
 */
const GUARD_KEY_CONTEXT = 'kaudit.login-guard.v1.key'
const GUARD_DIGEST_CONTEXT = 'kaudit.login-guard.v1.digest'
/** A separator no bounded input may contain, so two fields cannot be confused. */
const FIELD_SEPARATOR = '\u001f'

/**
 * The guard secret, derived from the session signing secret.
 *
 * Passing the session secret through its own HMAC context means the guard
 * digests are not computable from a session signature and vice versa, so one
 * installation secret can serve both without the two being the same key. The
 * derived value is a Buffer that stays inside the service: it is never stored,
 * never logged, and never bound to a statement.
 */
export function deriveLoginGuardSecret(sessionSecret: unknown): Buffer {
  if (
    typeof sessionSecret !== 'string' ||
    sessionSecret.length < SESSION_MIN_SECRET_LENGTH
  ) {
    throw loginFault(LOGIN_FAULT_CODES.configInvalid)
  }
  return createHmac('sha256', sessionSecret).update(GUARD_KEY_CONTEXT).digest()
}

/**
 * The keyed digest a guard row is keyed by.
 *
 * Keyed, so it cannot be recomputed from a stolen table; domain-separated by
 * scope, so the same string is two independent guards; hex, so it satisfies
 * `ck_login_guard_digest` and no raw byte reaches the driver.
 */
export function deriveLoginGuardDigest(
  scope: LoginGuardScope,
  value: string,
  guardSecret: Buffer,
): string {
  return createHmac('sha256', guardSecret)
    .update(
      `${GUARD_DIGEST_CONTEXT}${FIELD_SEPARATOR}${scope}${FIELD_SEPARATOR}${value}`,
    )
    .digest('hex')
}

/** One guard row, as a decision needs it. Counters and instants only. */
export interface LoginGuardState {
  scope: LoginGuardScope
  failureCount: number
  blockedUntil: Date | null
}

/** A guard blocks while its block instant is in the future, and not after. */
export function isGuardBlocked(
  state: LoginGuardState | null | undefined,
  now: Date,
): boolean {
  if (!state?.blockedUntil) return false
  return state.blockedUntil.getTime() > now.getTime()
}

/** The reason a blocked guard denies with. Internal; never returned to a caller. */
export function guardDenialReason(scope: LoginGuardScope): LoginDenialReason {
  return scope === LOGIN_GUARD_SCOPES.login
    ? LOGIN_DENIAL_REASONS.loginThrottled
    : LOGIN_DENIAL_REASONS.sourceThrottled
}

/** Window boundary: a window that started at or before this has expired. */
export function guardWindowCutoff(now: Date): Date {
  return new Date(now.getTime() - LOGIN_FAILURE_WINDOW_SECONDS * 1000)
}

export function guardBlockedUntil(now: Date): Date {
  return new Date(now.getTime() + LOGIN_BLOCK_SECONDS * 1000)
}

export function guardExpiresAt(now: Date): Date {
  return new Date(now.getTime() + LOGIN_GUARD_RETENTION_SECONDS * 1000)
}

/**
 * The trusted clock's answer, checked before anything is derived from it.
 *
 * Every guard decision, the `last_login_at` stamp, and the audit instant come
 * from this one value, so a clock that hands back something other than a usable
 * instant is a misconfigured installation rather than a failed login: it is
 * refused as {@link LOGIN_FAULT_CODES.configInvalid}, and — because the check
 * runs before the guard digests — before an HMAC, a KDF, or a statement is
 * bought.
 *
 * The derived instants are checked too. An instant near the edge of the
 * representable range is itself valid but pushes `blocked_until` or
 * `expires_at` past that edge, and an Invalid Date bound to a statement would
 * be a NULL block or a NULL retention bound: a guard that never blocks and a
 * row that never expires.
 */
export function trustedLoginInstant(value: unknown): Date {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw loginFault(LOGIN_FAULT_CODES.configInvalid)
  }
  for (const derived of [
    guardWindowCutoff(value),
    guardBlockedUntil(value),
    guardExpiresAt(value),
  ]) {
    if (Number.isNaN(derived.getTime())) {
      throw loginFault(LOGIN_FAULT_CODES.configInvalid)
    }
  }
  return value
}

// ---------------------------------------------------------------------------
// The synthetic hash the unknown-account path is charged against
// ---------------------------------------------------------------------------

/** Derived, not written down, so no high-entropy literal sits in the source. */
function syntheticSegment(label: string, bytes: number): string {
  return createHash('sha256')
    .update(label)
    .digest()
    .subarray(0, bytes)
    .toString('base64url')
}

/**
 * A module-owned hash that no password can ever match.
 *
 * Its salt and digest are derived from two fixed labels, so this is a synthetic
 * value rather than anything anyone chose, and it matches no account. Its
 * parameters are the current defaults of `hashPassword`, so verifying against it
 * costs exactly what verifying a real account costs — which is the point: an
 * unknown login must not be cheaper than a known one. A test pins the parameters
 * to the ones a freshly hashed password actually carries.
 */
export const SYNTHETIC_PASSWORD_HASH = [
  'scrypt',
  'N=16384,r=8,p=1',
  syntheticSegment('kaudit.login.synthetic.salt.v1', 16),
  syntheticSegment('kaudit.login.synthetic.digest.v1', 32),
].join('$')

// ---------------------------------------------------------------------------
// Account state
// ---------------------------------------------------------------------------

export const LOGIN_ACTIVE_STATUS = 'active'

/**
 * Why an otherwise-verified account is still refused.
 *
 * Returns a bounded internal reason, or null when the account is usable. The
 * caller turns every one of these into the same public denial; the distinction
 * exists only so an operator can tell a disabled colleague from an attack.
 */
export function accountStateReason(state: {
  status: string
  credentialStatus: string
}): LoginDenialReason | null {
  if (state.credentialStatus === 'tombstoned') {
    return LOGIN_DENIAL_REASONS.credentialTombstoned
  }
  if (state.credentialStatus === 'disabled') {
    return LOGIN_DENIAL_REASONS.credentialDisabled
  }
  if (
    state.status !== LOGIN_ACTIVE_STATUS ||
    state.credentialStatus !== LOGIN_ACTIVE_STATUS
  ) {
    return LOGIN_DENIAL_REASONS.accountInactive
  }
  return null
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

/**
 * What a successful login hands back.
 *
 * A stable id, the session generation the caller must mint under, and the
 * authorization context it needs to decide anything — and nothing else. No
 * username, no email, no display name, no password hash, no token: minting the
 * session is the caller's step, from the id and generation here.
 */
export interface LoginAuthorization {
  userId: string
  sessionVersion: number
  roles: string[]
  maxSensitivityTier: string
}

/**
 * The result shape.
 *
 * The failure arm carries the one public code and nothing that varies: two
 * denials are indistinguishable as values, not merely as messages.
 */
export type LoginResult =
  | { ok: true; authorization: LoginAuthorization }
  | { ok: false; code: LoginDeniedCode }

export const LOGIN_DENIED: LoginResult = {
  ok: false,
  code: LOGIN_DENIED_CODE,
}

export interface LoginRequest {
  login: unknown
  password: unknown
  /** The client network source, as the caller's transport resolved it. */
  clientSource: unknown
}

/**
 * Database login.
 *
 * The session signing secret and the trusted clock are supplied when the service
 * is CONSTRUCTED, not per request: a per-request secret would let one caller
 * throttle against a different key space than another, and a per-request clock
 * would let one move the window. Both are therefore installation configuration,
 * and this port takes only what actually arrives from a sign-in form.
 */
export interface LoginServicePort {
  authenticate(request: LoginRequest): Promise<LoginResult>
}

// ---------------------------------------------------------------------------
// The internal denial event
// ---------------------------------------------------------------------------

/**
 * A denial, as an operator-side sink may record it.
 *
 * A bounded reason and an instant. Deliberately NOT a login, an email, a network
 * source, a guard digest, a user id, or a thrown error — a sink is a log, and a
 * log of who failed to sign in from where is the record this whole design exists
 * to not create.
 */
export interface LoginDenialEvent {
  reason: LoginDenialReason
  occurredAt: Date
}

/**
 * Fire-and-forget, and never load-bearing.
 *
 * Synchronous and returning void so a sink cannot delay an authentication
 * decision, and so a slow or broken sink cannot become the thing that makes a
 * login fail. The service swallows anything it throws.
 */
export interface LoginDenialSink {
  record(event: LoginDenialEvent): void
}

// ---------------------------------------------------------------------------
// The audit event
// ---------------------------------------------------------------------------

/**
 * The control facts a successful login is allowed to pin.
 *
 * The same discipline as `userLifecycleHash`: who, what they may do, whether the
 * account is usable, and which generation is current. No username, no email, no
 * network source, no password material, no guard digest.
 */
export interface LoginControlFacts {
  userId: string
  userStatus: string
  credentialStatus: string
  roles: readonly string[]
  sessionVersion: number
}

export function loginControlHash(facts: LoginControlFacts): string {
  return sha256Hex(
    JSON.stringify([
      'kaudit-login-control',
      facts.userId,
      facts.userStatus,
      facts.credentialStatus,
      [...facts.roles].sort(),
      facts.sessionVersion,
    ]),
  )
}

/**
 * One successful login, as the permanent trail records it.
 *
 * `ipAddress` stays null on purpose. The column exists, and a network source was
 * available — but this trail is read far more widely than the login form, and an
 * address is the one field that turns "who signed in" into "where they were".
 * The throttle already uses the source, as a keyed digest that is not this row.
 */
export function buildLoginAuditEvent(input: {
  userId: string
  controlHash: string
  correlationId: string
  occurredAt: Date
}): AuditEvent {
  return {
    actorUserId: input.userId,
    actorEmail: null,
    action: LOGIN_AUDIT_ACTION,
    resourceType: 'kaudit_user',
    resourceId: input.userId,
    outcome: 'success',
    purpose: LOGIN_AUDIT_PURPOSE,
    correlationId: input.correlationId,
    ipAddress: null,
    client: LOGIN_AUDIT_CLIENT,
    beforeHash: null,
    afterHash: input.controlHash,
    occurredAt: input.occurredAt,
  }
}
