import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  clearLocalSessionCookie,
  createLocalPasswordHash,
  issueLocalSession,
  localSessionCookie,
  verifyLocalPassword,
  verifyLocalSession,
} from './localSession.ts'

const secret = 'synthetic-session-secret-at-least-32-characters'
const now = new Date('2026-01-01T00:00:00.000Z')

test('hashes and verifies a local development password without storing plaintext', () => {
  const hash = createLocalPasswordHash(
    'synthetic-password',
    Buffer.alloc(16, 7),
  )
  assert.match(hash, /^scrypt\$/)
  assert.equal(
    verifyLocalPassword('synthetic-password', hash),
    true,
  )
  assert.equal(verifyLocalPassword('wrong-password', hash), false)
})

test('issues an expiring signed session scoped to the configured email', () => {
  const token = issueLocalSession(
    'operator@example.test',
    secret,
    3600,
    now,
  )
  assert.equal(
    verifyLocalSession(
      token,
      secret,
      'operator@example.test',
      new Date('2026-01-01T00:30:00.000Z'),
    ),
    'operator@example.test',
  )
  assert.equal(
    verifyLocalSession(
      token,
      secret,
      'other@example.test',
      new Date('2026-01-01T00:30:00.000Z'),
    ),
    null,
  )
  assert.equal(
    verifyLocalSession(
      `${token}tampered`,
      secret,
      'operator@example.test',
      now,
    ),
    null,
  )
  assert.equal(
    verifyLocalSession(
      token,
      secret,
      'operator@example.test',
      new Date('2026-01-01T01:00:01.000Z'),
    ),
    null,
  )
})

test('builds HttpOnly same-site session and clearing cookies', () => {
  assert.match(
    localSessionCookie('kaudit_session', 'token', 3600),
    /HttpOnly; SameSite=Strict; Max-Age=3600/,
  )
  assert.match(
    clearLocalSessionCookie('kaudit_session'),
    /Max-Age=0/,
  )
})
