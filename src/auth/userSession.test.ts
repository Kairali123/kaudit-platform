import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { CredentialError } from './credentialTypes.ts'
import type { CredentialSessionState } from './credentialTypes.ts'
import {
  SESSION_MAX_TOKEN_LENGTH,
  SESSION_MAX_TTL_SECONDS,
  isSessionCurrent,
  issueUserSession,
  verifyUserSession,
} from './userSession.ts'

/**
 * Signed database-user sessions. Every value here is synthetic: the secret is a
 * fixture string, and the subject is a made-up user id, never a real account.
 */

const SECRET = 'synthetic-session-secret-at-least-32-characters'
const OTHER_SECRET = 'synthetic-rotated-secret-at-least-32-characters'
const USER_ID = 'usr_synthetic0001'
const NOW = new Date('2026-08-12T09:00:00.000Z')
const LATER = new Date('2026-08-12T09:30:00.000Z')

function issue(sessionVersion = 3, ttlSeconds = 3600): string {
  return issueUserSession({ userId: USER_ID, sessionVersion }, SECRET, ttlSeconds, NOW)
}

function issueWithSecret(secret: string): string {
  return issueUserSession({ userId: USER_ID, sessionVersion: 1 }, secret, 3600, NOW)
}

function decodeClaims(token: string): Record<string, unknown> {
  return JSON.parse(
    Buffer.from(token.split('.')[0], 'base64url').toString('utf8'),
  )
}

test('a session carries a user id and session version, never an identity', () => {
  const claims = decodeClaims(issue())
  assert.deepEqual(Object.keys(claims).sort(), ['exp', 'iat', 'sub', 'sv', 'v'])
  assert.equal(claims.sub, USER_ID)
  assert.equal(claims.sv, 3)
  assert.equal(Number.isInteger(claims.sv), true)
  // No email, username, display name, role, or tier may ever travel in a token.
  for (const forbidden of [
    'email',
    'username',
    'name',
    'display_name',
    'roles',
    'tier',
  ]) {
    assert.equal(forbidden in claims, false, forbidden)
  }
})

test('a well-formed session verifies within its bounded lifetime', () => {
  const verified = verifyUserSession(issue(), SECRET, LATER)
  assert.equal(verified?.sub, USER_ID)
  assert.equal(verified?.sv, 3)
  assert.equal(verified?.exp, verified ? verified.iat + 3600 : -1)
})

test('a tampered token never verifies', () => {
  const token = issue()
  const [body, signature] = token.split('.')
  const forgedBody = Buffer.from(
    JSON.stringify({ v: 1, sub: 'usr_attacker0001', sv: 1, iat: 0, exp: 4102444800 }),
  ).toString('base64url')

  for (const tampered of [
    `${token}tampered`, // appended bytes
    `${forgedBody}.${signature}`, // swapped payload, replayed signature
    `${body}.${signature.slice(0, -1)}`, // truncated signature
    `${body}.`,
    `.${signature}`,
    `${body}.${signature}.${signature}`, // an extra segment
    body,
    '',
    'a'.repeat(SESSION_MAX_TOKEN_LENGTH + 1),
    Buffer.from('{"v":1}').toString('base64url'),
    null,
    42,
  ]) {
    assert.equal(
      verifyUserSession(tampered as string, SECRET, LATER),
      null,
      String(tampered).slice(0, 24),
    )
  }

  // A token signed with a different secret is just as invalid.
  assert.equal(verifyUserSession(token, OTHER_SECRET, LATER), null)
})

test('an expired session stops verifying at its expiry, not after', () => {
  const token = issue(3, 3600)
  const justInside = new Date(NOW.getTime() + 3599_000)
  const atExpiry = new Date(NOW.getTime() + 3600_000)
  assert.notEqual(verifyUserSession(token, SECRET, justInside), null)
  assert.equal(verifyUserSession(token, SECRET, atExpiry), null)
  assert.equal(
    verifyUserSession(token, SECRET, new Date(NOW.getTime() + 86_400_000)),
    null,
  )
})

test('a lifetime outside policy is refused at issue and at verification', () => {
  for (const ttlSeconds of [0, -1, 1.5, SESSION_MAX_TTL_SECONDS + 1, Number.NaN]) {
    assert.throws(
      () => issue(3, ttlSeconds),
      (error: unknown) => {
        assert.ok(error instanceof CredentialError)
        assert.equal(error.code, 'SESSION_TTL_OUT_OF_RANGE')
        return true
      },
      String(ttlSeconds),
    )
  }

  // A correctly signed but over-long session is still rejected, so a future
  // misconfiguration cannot mint a token that outlives the policy.
  const issuedAt = Math.floor(NOW.getTime() / 1000)
  const overLong = Buffer.from(
    JSON.stringify({
      v: 1,
      sub: USER_ID,
      sv: 3,
      iat: issuedAt,
      exp: issuedAt + SESSION_MAX_TTL_SECONDS + 60,
    }),
  ).toString('base64url')
  const signed = `${overLong}.${createHmac('sha256', SECRET).update(overLong).digest('base64url')}`
  assert.equal(verifyUserSession(signed, SECRET, LATER), null)
})

test('a session that does not expire after it was issued never verifies', () => {
  // Synthetic, correctly signed tokens with an incoherent timeline. Each is
  // still unexpired and still within the clock-skew window at NOW, so the ONLY
  // thing that can reject them is the exp > iat invariant itself.
  const nowSeconds = Math.floor(NOW.getTime() / 1000)
  const sign = (claims: Record<string, unknown>): string => {
    const body = Buffer.from(JSON.stringify(claims)).toString('base64url')
    return `${body}.${createHmac('sha256', SECRET).update(body).digest('base64url')}`
  }
  const base = { v: 1, sub: USER_ID, sv: 3 }

  for (const timeline of [
    { iat: nowSeconds + 30, exp: nowSeconds + 30 }, // expires the instant it is issued
    { iat: nowSeconds + 60, exp: nowSeconds + 30 }, // expires before it is issued
    { iat: nowSeconds + 60, exp: nowSeconds + 1 },
  ]) {
    const token = sign({ ...base, ...timeline })
    // The signature is genuine: this is a claim-content rejection, not a forgery.
    assert.equal(verifyUserSession(token, SECRET, NOW), null, JSON.stringify(timeline))
  }

  // The same construction with a positive lifetime still verifies, so the check
  // rejects the timeline and nothing else.
  const wellFormed = sign({ ...base, iat: nowSeconds, exp: nowSeconds + 3600 })
  assert.equal(verifyUserSession(wellFormed, SECRET, NOW)?.sub, USER_ID)
})

test('a weak signing secret is refused before a token is minted or read', () => {
  for (const secret of ['', 'too-short', 'a'.repeat(31), null]) {
    for (const call of [
      () => issueWithSecret(secret as string),
      () => verifyUserSession(issue(), secret as string, LATER),
    ]) {
      assert.throws(call, (error: unknown) => {
        assert.ok(error instanceof CredentialError)
        assert.equal(error.code, 'SESSION_SECRET_WEAK')
        return true
      })
    }
  }
})

test('a malformed subject or session version is never issued', () => {
  for (const input of [
    { userId: '', sessionVersion: 1 },
    { userId: 'a'.repeat(41), sessionVersion: 1 },
    { userId: "usr' OR '1'='1", sessionVersion: 1 },
    { userId: 'usr synthetic', sessionVersion: 1 },
    { userId: USER_ID, sessionVersion: 0 },
    { userId: USER_ID, sessionVersion: -1 },
    { userId: USER_ID, sessionVersion: 1.5 },
    { userId: USER_ID, sessionVersion: Number.NaN },
  ]) {
    assert.throws(
      () => issueUserSession(input, SECRET, 3600, NOW),
      (error: unknown) => {
        assert.ok(error instanceof CredentialError)
        assert.equal(error.code, 'SESSION_INVALID')
        return true
      },
      JSON.stringify(input),
    )
  }
})

function state(
  overrides: Partial<CredentialSessionState> = {},
): CredentialSessionState {
  return {
    id: USER_ID,
    status: 'active',
    credentialStatus: 'active',
    sessionVersion: 3,
    ...overrides,
  }
}

test('a bumped session version revokes every session minted before it', () => {
  const claims = verifyUserSession(issue(3), SECRET, LATER)
  assert.equal(isSessionCurrent(claims, state()), true)
  // A password change, disable, or tombstone increments session_version.
  assert.equal(isSessionCurrent(claims, state({ sessionVersion: 4 })), false)
  // A downgrade is equally unacceptable: only an exact match passes.
  assert.equal(isSessionCurrent(claims, state({ sessionVersion: 2 })), false)
})

test('a disabled user or credential fails the per-request gate', () => {
  const claims = verifyUserSession(issue(3), SECRET, LATER)
  for (const disabled of [
    state({ status: 'disabled' }),
    state({ status: 'suspended' }),
    state({ credentialStatus: 'disabled' }),
    state({ credentialStatus: 'tombstoned' }),
    state({ id: 'usr_someone_else' }),
  ]) {
    assert.equal(isSessionCurrent(claims, disabled), false)
  }
  assert.equal(isSessionCurrent(claims, null), false)
  assert.equal(isSessionCurrent(null, state()), false)
})
