import { test } from 'node:test'
import assert from 'node:assert/strict'
import { hashPassword, isStoredPasswordHashValid } from './passwordHash.ts'
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
  trustedLoginInstant,
  LoginError,
  LOGIN_AUDIT_ACTION,
  LOGIN_BLOCK_SECONDS,
  LOGIN_DENIAL_REASONS,
  LOGIN_DENIED,
  LOGIN_DENIED_CODE,
  LOGIN_FAILURE_THRESHOLDS,
  LOGIN_FAILURE_WINDOW_SECONDS,
  LOGIN_FAULT_CODES,
  LOGIN_GUARD_DIGEST_LENGTH,
  LOGIN_GUARD_RETENTION_SECONDS,
  LOGIN_GUARD_SCOPES,
  SYNTHETIC_PASSWORD_HASH,
} from './loginService.ts'

// ---------------------------------------------------------------------------
// Synthetic values. Nothing here is, or resembles, a real account or secret.
// ---------------------------------------------------------------------------

const SECRET = 'synthetic-login-guard-secret-0123456789'
const OTHER_SECRET = 'synthetic-login-guard-secret-9876543210'
const LOGIN = 'sample.operator'
const EMAIL = 'sample.operator@example.invalid'
const SOURCE = '203.0.113.7'
const PASSWORD = 'Synthetic-Passphrase-9!'
const AT = new Date('2026-08-12T09:00:00.000Z')

const HEX_64 = /^[0-9a-f]{64}$/

// ---------------------------------------------------------------------------
// Size bounds, applied before any HMAC, KDF, or statement
// ---------------------------------------------------------------------------

test('an in-size login is normalized exactly once, to one lowercase value', () => {
  const bounded = boundLoginAttempt({
    login: '  Sample.Operator  ',
    password: PASSWORD,
    clientSource: SOURCE,
  })
  assert.equal(bounded.ok, true)
  assert.equal(bounded.ok && bounded.attempt.normalizedLogin, LOGIN)
  assert.equal(bounded.ok && bounded.attempt.clientSource, SOURCE)
})

test('an email login normalizes to the address, not to a username', () => {
  const bounded = boundLoginAttempt({
    login: `  ${EMAIL.toUpperCase()} `,
    password: PASSWORD,
    clientSource: SOURCE,
  })
  assert.equal(bounded.ok && bounded.attempt.normalizedLogin, EMAIL)
})

test('an in-size login that is not a login shape still continues, unresolved', () => {
  // It must reach the KDF path so an unknown account costs what a known one
  // costs; the null is what tells the caller there is nothing to look up.
  for (const login of ['..', 'no spaces here', '-leading', 'a']) {
    const bounded = boundLoginAttempt({
      login,
      password: PASSWORD,
      clientSource: SOURCE,
    })
    assert.equal(bounded.ok, true, login)
    assert.equal(bounded.ok && bounded.attempt.normalizedLogin, null, login)
  }
})

test('oversize and non-string fields are refused on size alone', () => {
  const cases: [unknown, unknown, unknown, string][] = [
    ['x'.repeat(256), PASSWORD, SOURCE, LOGIN_DENIAL_REASONS.loginOversize],
    [null, PASSWORD, SOURCE, LOGIN_DENIAL_REASONS.loginOversize],
    [LOGIN, '', SOURCE, LOGIN_DENIAL_REASONS.passwordMissing],
    [LOGIN, 42, SOURCE, LOGIN_DENIAL_REASONS.passwordMissing],
    [LOGIN, 'A1!'.repeat(200), SOURCE, LOGIN_DENIAL_REASONS.passwordOversize],
    [LOGIN, PASSWORD, '', LOGIN_DENIAL_REASONS.clientSourceInvalid],
    [LOGIN, PASSWORD, 'x'.repeat(101), LOGIN_DENIAL_REASONS.clientSourceInvalid],
    [LOGIN, PASSWORD, 'has space', LOGIN_DENIAL_REASONS.clientSourceInvalid],
    [LOGIN, PASSWORD, undefined, LOGIN_DENIAL_REASONS.clientSourceInvalid],
  ]
  for (const [login, password, clientSource, reason] of cases) {
    const bounded = boundLoginAttempt({ login, password, clientSource })
    assert.equal(bounded.ok, false)
    assert.equal(!bounded.ok && bounded.reason, reason)
  }
})

test('a login at the maximum accepted size is not refused for its size', () => {
  // Exactly LOGIN_MAX_LENGTH characters once the domain is appended.
  const local = 'a'.repeat(239)
  const bounded = boundLoginAttempt({
    login: `${local}@example.invalid`,
    password: PASSWORD,
    clientSource: SOURCE,
  })
  assert.equal(bounded.ok, true)
})

// ---------------------------------------------------------------------------
// Guard keys
// ---------------------------------------------------------------------------

test('a guard digest is keyed: the same value under two secrets differs', () => {
  const a = deriveLoginGuardDigest(
    LOGIN_GUARD_SCOPES.login,
    LOGIN,
    deriveLoginGuardSecret(SECRET),
  )
  const b = deriveLoginGuardDigest(
    LOGIN_GUARD_SCOPES.login,
    LOGIN,
    deriveLoginGuardSecret(OTHER_SECRET),
  )
  assert.notEqual(a, b)
})

test('a guard digest is domain separated by scope', () => {
  const secret = deriveLoginGuardSecret(SECRET)
  const asLogin = deriveLoginGuardDigest(LOGIN_GUARD_SCOPES.login, SOURCE, secret)
  const asSource = deriveLoginGuardDigest(
    LOGIN_GUARD_SCOPES.source,
    SOURCE,
    secret,
  )
  assert.notEqual(asLogin, asSource)
})

test('a guard digest is stable, hex, and never its own pre-image', () => {
  const secret = deriveLoginGuardSecret(SECRET)
  for (const value of [LOGIN, EMAIL, SOURCE]) {
    const digest = deriveLoginGuardDigest(
      LOGIN_GUARD_SCOPES.login,
      value,
      secret,
    )
    assert.match(digest, HEX_64)
    assert.equal(digest.length, LOGIN_GUARD_DIGEST_LENGTH)
    assert.equal(
      digest,
      deriveLoginGuardDigest(LOGIN_GUARD_SCOPES.login, value, secret),
    )
    assert.ok(!digest.includes(value))
  }
})

test('the guard secret is derived from, and is not, the session secret', () => {
  const secret = deriveLoginGuardSecret(SECRET)
  assert.equal(secret.byteLength, 32)
  assert.ok(!secret.toString('utf8').includes(SECRET))
  assert.ok(!secret.toString('hex').includes(Buffer.from(SECRET).toString('hex')))
})

test('a weak session secret is a bounded configuration fault', () => {
  for (const weak of ['', 'short', null, 31 as unknown]) {
    assert.throws(
      () => deriveLoginGuardSecret(weak),
      (error: unknown) =>
        error instanceof LoginError &&
        error.code === LOGIN_FAULT_CODES.configInvalid &&
        error.message === LOGIN_FAULT_CODES.configInvalid,
    )
  }
})

// ---------------------------------------------------------------------------
// Throttle policy
// ---------------------------------------------------------------------------

test('a guard blocks only while its block instant is in the future', () => {
  const state = {
    scope: LOGIN_GUARD_SCOPES.login,
    failureCount: 5,
    blockedUntil: new Date(AT.getTime() + 1000),
  }
  assert.equal(isGuardBlocked(state, AT), true)
  assert.equal(isGuardBlocked(state, new Date(AT.getTime() + 1000)), false)
  assert.equal(isGuardBlocked({ ...state, blockedUntil: null }, AT), false)
  assert.equal(isGuardBlocked(null, AT), false)
})

test('thresholds are conservative for a person and looser for a shared egress', () => {
  assert.ok(LOGIN_FAILURE_THRESHOLDS.login >= 3)
  assert.ok(LOGIN_FAILURE_THRESHOLDS.login <= 10)
  assert.ok(LOGIN_FAILURE_THRESHOLDS.source > LOGIN_FAILURE_THRESHOLDS.login)
})

test('window, block, and retention instants are derived from the trusted clock', () => {
  assert.equal(
    guardWindowCutoff(AT).getTime(),
    AT.getTime() - LOGIN_FAILURE_WINDOW_SECONDS * 1000,
  )
  assert.equal(
    guardBlockedUntil(AT).getTime(),
    AT.getTime() + LOGIN_BLOCK_SECONDS * 1000,
  )
  assert.equal(
    guardExpiresAt(AT).getTime(),
    AT.getTime() + LOGIN_GUARD_RETENTION_SECONDS * 1000,
  )
  // Retention must outlast both windows, or a row could expire mid-block.
  assert.ok(guardExpiresAt(AT).getTime() > guardBlockedUntil(AT).getTime())
})

test('a usable instant passes the trusted-clock check unchanged', () => {
  assert.equal(trustedLoginInstant(AT), AT)
})

test('an unusable instant is a bounded configuration fault, not a denial', () => {
  for (const value of [
    new Date(Number.NaN),
    new Date('not-an-instant'),
    AT.getTime(),
    AT.toISOString(),
    null,
    undefined,
    {},
    // Representable as an instant, but every derived guard date overflows.
    new Date(8_640_000_000_000_000),
  ]) {
    assert.throws(
      () => trustedLoginInstant(value),
      (error: unknown) =>
        error instanceof LoginError &&
        error.code === LOGIN_FAULT_CODES.configInvalid &&
        error.message === LOGIN_FAULT_CODES.configInvalid,
      `unusable clock value accepted: ${String(value)}`,
    )
  }
})

test('the instants derived from a checked clock are themselves usable', () => {
  const checked = trustedLoginInstant(AT)
  for (const derived of [
    guardWindowCutoff(checked),
    guardBlockedUntil(checked),
    guardExpiresAt(checked),
  ]) {
    assert.equal(Number.isNaN(derived.getTime()), false)
  }
})

test('each guard denies with its own bounded internal reason', () => {
  assert.equal(
    guardDenialReason(LOGIN_GUARD_SCOPES.login),
    LOGIN_DENIAL_REASONS.loginThrottled,
  )
  assert.equal(
    guardDenialReason(LOGIN_GUARD_SCOPES.source),
    LOGIN_DENIAL_REASONS.sourceThrottled,
  )
})

// ---------------------------------------------------------------------------
// The synthetic hash the unknown-account path is charged against
// ---------------------------------------------------------------------------

test('the synthetic hash is a hash this module will really verify against', () => {
  assert.equal(isStoredPasswordHashValid(SYNTHETIC_PASSWORD_HASH), true)
})

test('the synthetic hash carries the parameters a fresh hash carries', async () => {
  // The unknown-account path must cost what a real verification costs. This
  // pins the coupling: if `hashPassword` rotates its cost, the constant must
  // move with it or this fails.
  const fresh = await hashPassword(PASSWORD)
  assert.equal(fresh.split('$')[1], SYNTHETIC_PASSWORD_HASH.split('$')[1])
  assert.equal(fresh.split('$')[0], SYNTHETIC_PASSWORD_HASH.split('$')[0])
})

// ---------------------------------------------------------------------------
// Account state
// ---------------------------------------------------------------------------

test('every unusable account state maps to a bounded internal reason', () => {
  assert.equal(
    accountStateReason({ status: 'active', credentialStatus: 'active' }),
    null,
  )
  assert.equal(
    accountStateReason({ status: 'disabled', credentialStatus: 'active' }),
    LOGIN_DENIAL_REASONS.accountInactive,
  )
  assert.equal(
    accountStateReason({ status: 'active', credentialStatus: 'disabled' }),
    LOGIN_DENIAL_REASONS.credentialDisabled,
  )
  assert.equal(
    accountStateReason({ status: 'active', credentialStatus: 'tombstoned' }),
    LOGIN_DENIAL_REASONS.credentialTombstoned,
  )
  assert.equal(
    accountStateReason({ status: 'unknown-state', credentialStatus: 'active' }),
    LOGIN_DENIAL_REASONS.accountInactive,
  )
})

// ---------------------------------------------------------------------------
// The uniform public denial
// ---------------------------------------------------------------------------

test('the public denial is one code and carries nothing else', () => {
  assert.deepEqual(LOGIN_DENIED, { ok: false, code: LOGIN_DENIED_CODE })
  assert.deepEqual(Object.keys(LOGIN_DENIED).sort(), ['code', 'ok'])
})

test('internal reasons are distinct constants and none is the public code', () => {
  const reasons = Object.values(LOGIN_DENIAL_REASONS)
  assert.equal(new Set(reasons).size, reasons.length)
  for (const reason of reasons) {
    assert.notEqual(reason, LOGIN_DENIED_CODE)
    assert.ok(reason.length <= 40)
    assert.match(reason, /^[A-Z_]+$/)
  }
})

test('fault codes are bounded constants, distinct from the denial', () => {
  const codes = Object.values(LOGIN_FAULT_CODES)
  assert.equal(new Set(codes).size, codes.length)
  for (const code of codes) {
    assert.notEqual(code, LOGIN_DENIED_CODE)
    assert.match(code, /^AUTH_[A-Z_]+$/)
  }
})

// ---------------------------------------------------------------------------
// The audit event
// ---------------------------------------------------------------------------

test('the control hash pins state, ignores role order, and moves with generation', () => {
  const facts = {
    userId: 'usr_synthetic_1',
    userStatus: 'active',
    credentialStatus: 'active',
    roles: ['admin', 'user'],
    sessionVersion: 3,
  }
  const hash = loginControlHash(facts)
  assert.match(hash, HEX_64)
  assert.equal(hash, loginControlHash({ ...facts, roles: ['user', 'admin'] }))
  assert.notEqual(hash, loginControlHash({ ...facts, sessionVersion: 4 }))
  assert.notEqual(hash, loginControlHash({ ...facts, userStatus: 'disabled' }))
})

test('a login audit event carries a user id and control hashes only', () => {
  const event = buildLoginAuditEvent({
    userId: 'usr_synthetic_1',
    controlHash: loginControlHash({
      userId: 'usr_synthetic_1',
      userStatus: 'active',
      credentialStatus: 'active',
      roles: ['user'],
      sessionVersion: 1,
    }),
    correlationId: 'corr_synthetic_1',
    occurredAt: AT,
  })
  assert.equal(event.action, LOGIN_AUDIT_ACTION)
  assert.equal(event.outcome, 'success')
  assert.equal(event.actorUserId, 'usr_synthetic_1')
  assert.equal(event.resourceId, 'usr_synthetic_1')
  // The three fields that would turn the trail into a record of a person.
  assert.equal(event.actorEmail, null)
  assert.equal(event.ipAddress, null)
  assert.equal(event.beforeHash, null)

  const serialized = JSON.stringify(event)
  for (const value of [LOGIN, EMAIL, SOURCE, PASSWORD, SECRET]) {
    assert.ok(!serialized.includes(value), value)
  }
})
