import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CredentialError } from './credentialTypes.ts'
import {
  LOGIN_MAX_LENGTH,
  looksLikeEmail,
  normalizeEmail,
  normalizeLogin,
  normalizeUsername,
} from './credentialIdentity.ts'

/**
 * Login-handle normalization. Every identity here is synthetic and uses the
 * reserved .test TLD; no real account name or address appears.
 */

test('a username normalizes to one case-folded, trimmed handle', () => {
  for (const variant of [
    'Audit.Admin',
    'AUDIT.ADMIN',
    '  audit.admin  ',
    'aUdIt.AdMiN',
  ]) {
    assert.equal(normalizeUsername(variant), 'audit.admin')
  }
})

test('a rejected username can never become a second account', () => {
  for (const invalid of [
    '',
    '  ',
    'ab', // shorter than the 3-character floor
    '.leading',
    'trailing-',
    'has space',
    'has@at.sign', // an '@' would let a username shadow an email
    'has/slash',
    'ünïcode', // homoglyph risk: ASCII only
    'ааааа', // Cyrillic look-alike of "aaaaa"
    'a'.repeat(65),
    null,
    42,
    undefined,
  ]) {
    assert.throws(
      () => normalizeUsername(invalid as string),
      (error: unknown) => {
        assert.ok(error instanceof CredentialError)
        assert.equal(error.code, 'USERNAME_MALFORMED')
        return true
      },
      JSON.stringify(invalid),
    )
  }
})

test('a rejected handle is never echoed back in the error', () => {
  for (const rejected of ['forbidden.handle@example.test', 'Sup3rSecretHandle']) {
    for (const normalize of [normalizeUsername, normalizeEmail]) {
      try {
        normalize(rejected)
      } catch (error) {
        assert.ok(error instanceof CredentialError)
        assert.equal(error.message.includes(rejected), false)
        assert.equal(error.message.includes('Sup3r'), false)
      }
    }
  }
})

test('an email normalizes to lowercase and rejects malformed addresses', () => {
  assert.equal(
    normalizeEmail('  Audit.Admin@Example.TEST  '),
    'audit.admin@example.test',
  )
  for (const invalid of [
    'no-at-sign',
    'two@at@signs.test',
    'no-domain-dot@example',
    'spaced address@example.test',
    '@example.test',
    'admin@',
    `${'a'.repeat(LOGIN_MAX_LENGTH)}@example.test`,
    null,
  ]) {
    assert.throws(
      () => normalizeEmail(invalid as string),
      (error: unknown) => {
        assert.ok(error instanceof CredentialError)
        assert.equal(error.code, 'EMAIL_MALFORMED')
        return true
      },
      String(invalid),
    )
  }
})

test('the single login box accepts either form and classifies it', () => {
  assert.equal(normalizeLogin('  Audit.Admin '), 'audit.admin')
  assert.equal(looksLikeEmail('audit.admin'), false)
  assert.equal(
    normalizeLogin('Audit.Admin@Example.TEST'),
    'audit.admin@example.test',
  )
  assert.equal(looksLikeEmail('audit.admin@example.test'), true)
})

test('an unusable login returns null instead of throwing or querying', () => {
  // Failing silently keeps a malformed login indistinguishable from a wrong
  // password, so the login box cannot be used to enumerate accounts.
  for (const invalid of [
    '',
    '   ',
    'ab',
    "admin' OR '1'='1",
    'admin; DROP TABLE kaudit_user_credential',
    'admin\u0000truncated', // an embedded NUL must never reach a query
    'admin\ttab',
    'a'.repeat(LOGIN_MAX_LENGTH + 1),
    `${'a'.repeat(LOGIN_MAX_LENGTH)}@example.test`,
    null,
    7,
    {},
  ]) {
    assert.equal(normalizeLogin(invalid as string), null, String(invalid))
  }
})

test('a normalized handle is already normalized: the operation is idempotent', () => {
  const once = normalizeUsername('Audit.Admin')
  assert.equal(normalizeUsername(once), once)
  const email = normalizeEmail('Audit.Admin@Example.TEST')
  assert.equal(normalizeEmail(email), email)
})
