import { createHmac, timingSafeEqual } from 'node:crypto'
import { CredentialError } from './credentialTypes.ts'
import type { CredentialSessionState } from './credentialTypes.ts'

/**
 * HMAC-signed, bounded-expiry sessions for database users.
 *
 * The token carries ONLY the stable `kaudit_user.id` and the integer
 * `session_version` it was minted under — never an email, username, display
 * name, or role. A renamed user keeps their session; a leaked token discloses
 * no identity; and every request re-reads status and roles from the database
 * rather than trusting anything the client returned.
 *
 * Wire form: base64url(JSON payload) + '.' + base64url(HMAC-SHA256 of payload).
 * This is deliberately NOT a JWT: no algorithm field means no algorithm
 * confusion, and there is no header a caller could downgrade to "none".
 */

const VERSION = 1
export const SESSION_MIN_SECRET_LENGTH = 32
export const SESSION_MAX_TTL_SECONDS = 12 * 60 * 60
export const SESSION_MAX_TOKEN_LENGTH = 1024
/** Tolerance for clock drift between the issuing and verifying process. */
const CLOCK_SKEW_SECONDS = 60
const MAX_USER_ID_LENGTH = 40

/** Exactly the claims that travel; there is deliberately no identity field. */
export interface UserSessionClaims {
  v: typeof VERSION
  /** Stable kaudit_user.id. */
  sub: string
  /** session_version at issue time. */
  sv: number
  iat: number
  exp: number
}

export interface IssueUserSessionInput {
  userId: string
  sessionVersion: number
}

function signature(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url')
}

function assertSecret(secret: unknown): asserts secret is string {
  if (typeof secret !== 'string' || secret.length < SESSION_MIN_SECRET_LENGTH) {
    throw new CredentialError(
      'SESSION_SECRET_WEAK',
      'Session signing secret must be at least 32 characters',
    )
  }
}

function isUserId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_USER_ID_LENGTH &&
    /^[A-Za-z0-9_-]+$/.test(value)
  )
}

function isSessionVersion(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1
}

export function issueUserSession(
  input: IssueUserSessionInput,
  secret: string,
  ttlSeconds: number,
  now: Date = new Date(),
): string {
  assertSecret(secret)
  if (
    !Number.isInteger(ttlSeconds) ||
    ttlSeconds < 1 ||
    ttlSeconds > SESSION_MAX_TTL_SECONDS
  ) {
    throw new CredentialError(
      'SESSION_TTL_OUT_OF_RANGE',
      'Session lifetime must be a whole number of seconds up to 12 hours',
    )
  }
  if (!isUserId(input.userId) || !isSessionVersion(input.sessionVersion)) {
    throw new CredentialError(
      'SESSION_INVALID',
      'Session subject must be a user id with an integer session version',
    )
  }
  const issuedAt = Math.floor(now.getTime() / 1000)
  const claims: UserSessionClaims = {
    v: VERSION,
    sub: input.userId,
    sv: input.sessionVersion,
    iat: issuedAt,
    exp: issuedAt + ttlSeconds,
  }
  const body = Buffer.from(JSON.stringify(claims)).toString('base64url')
  return `${body}.${signature(body, secret)}`
}

/**
 * Verifies signature, structure, and expiry. Returns null for every failure —
 * a tampered payload, a wrong secret, an expired or over-long lifetime, and a
 * malformed claim are all one indistinguishable outcome, with no raw value in
 * any error.
 */
export function verifyUserSession(
  token: unknown,
  secret: string,
  now: Date = new Date(),
): UserSessionClaims | null {
  assertSecret(secret)
  if (
    typeof token !== 'string' ||
    token.length === 0 ||
    token.length > SESSION_MAX_TOKEN_LENGTH
  ) {
    return null
  }
  const [body, supplied, extra] = token.split('.')
  if (!body || !supplied || extra != null) return null

  // Constant-time comparison, and length is checked first because
  // timingSafeEqual throws on a mismatch.
  const expectedSignature = Buffer.from(signature(body, secret))
  const suppliedSignature = Buffer.from(supplied)
  if (
    suppliedSignature.byteLength !== expectedSignature.byteLength ||
    !timingSafeEqual(suppliedSignature, expectedSignature)
  ) {
    return null
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const claims = parsed as Partial<UserSessionClaims>
  if (
    claims.v !== VERSION ||
    !isUserId(claims.sub) ||
    !isSessionVersion(claims.sv) ||
    !Number.isInteger(claims.iat) ||
    !Number.isInteger(claims.exp)
  ) {
    return null
  }

  const issuedAt = claims.iat as number
  const expiresAt = claims.exp as number
  const nowSeconds = Math.floor(now.getTime() / 1000)
  if (expiresAt <= nowSeconds) return null
  if (issuedAt > nowSeconds + CLOCK_SKEW_SECONDS) return null
  // A session must expire strictly AFTER it was issued. exp <= iat is an
  // incoherent timeline no issue path can produce, so treat it as corruption
  // rather than reasoning about how long such a token should live.
  if (expiresAt <= issuedAt) return null
  // Re-enforce the ceiling on the token itself, so a session minted under a
  // future misconfiguration can never outlive the policy.
  if (expiresAt - issuedAt > SESSION_MAX_TTL_SECONDS) return null

  return { v: VERSION, sub: claims.sub, sv: claims.sv, iat: issuedAt, exp: expiresAt }
}

/**
 * The per-request revocation gate. A password change, disable, or tombstone
 * increments `session_version`, so every session minted earlier stops matching.
 */
export function isSessionCurrent(
  claims: UserSessionClaims | null,
  state: CredentialSessionState | null,
): boolean {
  if (!claims || !state) return false
  return (
    claims.sub === state.id &&
    claims.sv === state.sessionVersion &&
    state.status === 'active' &&
    state.credentialStatus === 'active'
  )
}

export function userSessionCookie(
  name: string,
  token: string,
  ttlSeconds: number,
): string {
  return `${name}=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${ttlSeconds}`
}

export function clearUserSessionCookie(name: string): string {
  return `${name}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`
}
