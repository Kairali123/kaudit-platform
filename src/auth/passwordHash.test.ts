import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CredentialError } from './credentialTypes.ts'
import {
  MAX_VERIFY_MEMORY_BYTES,
  MAX_VERIFY_WORK_UNITS,
  PASSWORD_MAX_BYTES,
  PASSWORD_MAX_LENGTH,
  checkPasswordPolicy,
  hashPassword,
  isStoredPasswordHashValid,
  verifyPassword,
} from './passwordHash.ts'

/**
 * Password primitives. Every credential here is synthetic and exists only in
 * this file; no real password, hash, or account appears.
 */

const SYNTHETIC_PASSWORD = 'Synthetic-Admin-Pass-2026!'
const SYNTHETIC_USERNAME = 'audit.admin'

test('a hashed password is one-way, salted, and never stores plaintext', async () => {
  const hash = await hashPassword(SYNTHETIC_PASSWORD)
  assert.match(hash, /^scrypt\$N=\d+,r=\d+,p=\d+\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$/)
  assert.equal(hash.includes(SYNTHETIC_PASSWORD), false)
  assert.equal(hash.toLowerCase().includes('synthetic'), false)

  // A random salt per call: the same password never yields the same row value.
  const second = await hashPassword(SYNTHETIC_PASSWORD)
  assert.notEqual(hash, second)
  assert.equal(await verifyPassword(SYNTHETIC_PASSWORD, second), true)
})

test('verification succeeds for the right password and fails for anything else', async () => {
  const hash = await hashPassword(SYNTHETIC_PASSWORD)
  assert.equal(await verifyPassword(SYNTHETIC_PASSWORD, hash), true)
  for (const wrong of [
    'Synthetic-Admin-Pass-2026',
    'synthetic-admin-pass-2026!',
    `${SYNTHETIC_PASSWORD} `,
    ` ${SYNTHETIC_PASSWORD}`,
    '',
  ]) {
    assert.equal(await verifyPassword(wrong, hash), false, JSON.stringify(wrong))
  }
})

test('a malformed stored hash fails closed instead of authenticating', async () => {
  const valid = await hashPassword(SYNTHETIC_PASSWORD)
  const [, parameters, salt, digest] = valid.split('$')
  for (const malformed of [
    '',
    'not-a-hash',
    SYNTHETIC_PASSWORD, // a plaintext value that leaked into the column
    `plain$${parameters}$${salt}$${digest}`, // unknown algorithm
    `scrypt$${salt}$${digest}`, // missing the parameter segment
    `scrypt$${parameters}$${salt}$${digest}$extra`, // an extra segment
    `scrypt$N=0,r=8,p=1$${salt}$${digest}`, // non power-of-two cost
    `scrypt$N=15000,r=8,p=1$${salt}$${digest}`,
    `scrypt$N=1073741824,r=8,p=1$${salt}$${digest}`, // memory-exhausting cost
    `scrypt$N=16384,r=999,p=1$${salt}$${digest}`,
    `scrypt$N=16384,r=8,p=999$${salt}$${digest}`,
    `scrypt$${parameters}$${salt}$${digest.slice(0, 10)}`, // truncated digest
    `scrypt$${parameters}$AA$${digest}`, // salt below the floor
    `scrypt$${parameters}$${salt}$not base64url!`,
    `scrypt$${parameters}$$${digest}`,
    'a'.repeat(600),
    null,
    { algorithm: 'scrypt' },
    42,
  ]) {
    assert.equal(isStoredPasswordHashValid(malformed), false, String(malformed))
    assert.equal(
      await verifyPassword(SYNTHETIC_PASSWORD, malformed),
      false,
      String(malformed),
    )
  }
  assert.equal(isStoredPasswordHashValid(valid), true)
})

test('accepted parameters are capped without weakening a newly written hash', async () => {
  // The envelope stays near the parameters a current hash is written with: one
  // login attempt can buy at most 64 MiB and four times a real verify's CPU.
  assert.equal(MAX_VERIFY_MEMORY_BYTES, 64 * 1024 * 1024)
  assert.equal(MAX_VERIFY_WORK_UNITS, 4 * 16384 * 8 * 1)

  const hash = await hashPassword(SYNTHETIC_PASSWORD)
  // Capping what is ACCEPTED must never quietly weaken what is PRODUCED.
  assert.match(hash, /^scrypt\$N=16384,r=8,p=1\$/)
  assert.equal(await verifyPassword(SYNTHETIC_PASSWORD, hash), true)
  assert.ok(128 * 16384 * 8 <= MAX_VERIFY_MEMORY_BYTES)
})

test('an over-ceiling stored hash fails closed without buying the work it names', async () => {
  const valid = await hashPassword(SYNTHETIC_PASSWORD)
  const [, , salt, digest] = valid.split('$')
  const encode = (parameters: string) => `scrypt$${parameters}$${salt}$${digest}`

  const started = Date.now()
  for (const parameters of [
    'N=65536,r=16,p=1', // 128 MiB
    'N=131072,r=16,p=1', // 256 MiB: each parameter is legal, the product is not
    'N=262144,r=8,p=1', // 256 MiB
    'N=1048576,r=8,p=1', // 1 GiB — the cost the previous ceiling still admitted
    'N=32768,r=8,p=4', // inside the memory cap, four times the CPU budget
    'N=16384,r=8,p=5', // past the structural parallelization bound
  ]) {
    const stored = encode(parameters)
    // This check is SYNCHRONOUS, so a false proves the row was refused by
    // arithmetic alone: no asynchronous scrypt could have run at all.
    assert.equal(isStoredPasswordHashValid(stored), false, parameters)
    assert.equal(
      await verifyPassword(SYNTHETIC_PASSWORD, stored),
      false,
      parameters,
    )
  }
  // Refusing all of them together must cost far less than deriving even one:
  // N=262144,r=8 alone is ~16x a real verify, at 256 MiB.
  assert.ok(Date.now() - started < 1000, 'over-ceiling rejection must be cheap')

  // A ceiling, not a narrowing to one hard-coded cost: the current parameters
  // and the envelope boundary itself both stay verifiable, so a later rotation
  // to a stronger hash needs no code change.
  assert.equal(isStoredPasswordHashValid(encode('N=16384,r=8,p=1')), true)
  assert.equal(isStoredPasswordHashValid(encode('N=65536,r=8,p=1')), true)
  assert.equal(isStoredPasswordHashValid(encode('N=16384,r=8,p=4')), true)
})

test('an oversized password is refused before any hashing work is bought', async () => {
  const hash = await hashPassword(SYNTHETIC_PASSWORD)
  const oversizeByLength = 'A1!a'.repeat(PASSWORD_MAX_LENGTH)
  assert.ok(oversizeByLength.length > PASSWORD_MAX_LENGTH)
  assert.equal(await verifyPassword(oversizeByLength, hash), false)

  // Multi-byte characters are bounded by BYTES, not just by character count.
  const oversizeByBytes = '\u{1F510}'.repeat(PASSWORD_MAX_BYTES)
  assert.ok(Buffer.byteLength(oversizeByBytes, 'utf8') > PASSWORD_MAX_BYTES)
  assert.equal(await verifyPassword(oversizeByBytes, hash), false)

  await assert.rejects(
    () => hashPassword(oversizeByLength),
    (error: unknown) => {
      assert.ok(error instanceof CredentialError)
      assert.equal(error.code, 'PASSWORD_POLICY')
      return true
    },
  )
})

test('the policy demands a length and mix appropriate to an administrator', () => {
  assert.deepEqual(checkPasswordPolicy(SYNTHETIC_PASSWORD), [])
  assert.deepEqual(checkPasswordPolicy('Sh0rt!'), ['TOO_SHORT'])
  assert.deepEqual(checkPasswordPolicy('LOUD-PASSWORD-2026!'), [
    'MISSING_LOWERCASE',
  ])
  assert.deepEqual(checkPasswordPolicy('quiet-password-2026!'), [
    'MISSING_UPPERCASE',
  ])
  assert.deepEqual(checkPasswordPolicy('Quiet-Password-Word!'), [
    'MISSING_DIGIT',
  ])
  assert.deepEqual(checkPasswordPolicy('QuietPassword2026'), ['MISSING_SYMBOL'])
  assert.deepEqual(checkPasswordPolicy('Quiet\tPassword-2026!'), [
    'CONTAINS_CONTROL_CHARACTER',
  ])
  assert.deepEqual(checkPasswordPolicy(null), ['TOO_SHORT'])

  // A spaced passphrase is a good administrator password, not a violation.
  assert.deepEqual(checkPasswordPolicy('Correct Horse 42 Staple'), [])
})

test('a password may not restate the account it protects', () => {
  const identity = {
    username: SYNTHETIC_USERNAME,
    email: 'audit.admin@example.test',
  }
  assert.deepEqual(checkPasswordPolicy(SYNTHETIC_PASSWORD, identity), [])
  assert.deepEqual(
    checkPasswordPolicy('Audit.Admin-2026!x', identity),
    ['CONTAINS_IDENTITY'],
  )
})

test('a policy-violating password is never hashed, and the error carries no value', async () => {
  await assert.rejects(
    () => hashPassword('short', { username: SYNTHETIC_USERNAME }),
    (error: unknown) => {
      assert.ok(error instanceof CredentialError)
      assert.equal(error.code, 'PASSWORD_POLICY')
      assert.equal(error.message.includes('short'), false)
      assert.equal(error.message.includes(SYNTHETIC_USERNAME), false)
      return true
    },
  )
})

test('hashing and verification are asynchronous, never blocking scrypt', async () => {
  // Both entry points must return a promise: a synchronous scrypt on a request
  // path would stall every concurrent request for the whole KDF.
  const hashing = hashPassword(SYNTHETIC_PASSWORD)
  assert.ok(hashing instanceof Promise)
  const verifying = verifyPassword(SYNTHETIC_PASSWORD, await hashing)
  assert.ok(verifying instanceof Promise)
  assert.equal(await verifying, true)
})
