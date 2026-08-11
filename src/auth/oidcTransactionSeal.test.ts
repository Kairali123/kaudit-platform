import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHmac, hkdfSync } from 'node:crypto'
import {
  OidcBrowserFlowError,
  OIDC_TRANSACTION_TTL_SECONDS,
  type OidcTransaction,
} from './oidcBrowserFlow.ts'
import {
  createOidcTransactionSeal,
  OIDC_TRANSACTION_KEY_INFO,
  OIDC_TRANSACTION_KEY_SALT,
} from './oidcTransactionSeal.ts'

/**
 * The authenticated transaction envelope.
 *
 * Everything here is synthetic: `KEY_MATERIAL` and `ATTACKER_KEY` are fixed
 * strings invented in this file, they authenticate nothing outside it, and no
 * provider, socket, or database is involved.
 *
 * What is being proved is one property, from several directions: a transaction
 * cookie this key did not produce is refused, and refused with exactly one
 * bounded code that says nothing about which check refused it.
 */

const KEY_MATERIAL = 'synthetic-client-secret-not-a-credential'
/** A sibling host's key, standing in for whoever wrote a parent-domain cookie. */
const ATTACKER_KEY = 'synthetic-attacker-key-not-a-credential'

const TRANSACTION: OidcTransaction = {
  state: 'synthetic-state-value-0000000000000000000',
  nonce: 'synthetic-nonce-value-0000000000000000000',
  codeVerifier: 'synthetic-verifier-value-0000000000000000',
}

const seal = createOidcTransactionSeal(KEY_MATERIAL)

/** Asserts the one bounded refusal, and that it carries nothing else. */
function assertRefused(open: () => unknown, because: string): void {
  assert.throws(
    open,
    (error: unknown) => {
      assert.ok(error instanceof OidcBrowserFlowError, because)
      assert.equal(error.code, 'OIDC_TRANSACTION_MISSING', because)
      assert.equal(error.message, 'Sign-in request has expired', because)
      assert.equal(error.cause, undefined, because)
      return true
    },
    because,
  )
}

/** Rebuilds an envelope from parts, the way an attacker would have to. */
function envelope(version: string, payload: string, mac: string): string {
  return `${version}.${payload}.${mac}`
}

function partsOf(value: string): [string, string, string] {
  const parts = value.split('.')
  assert.equal(parts.length, 3)
  return parts as [string, string, string]
}

// ---------------------------------------------------------------------------
// The envelope round-trips, and is opaque
// ---------------------------------------------------------------------------

test('a sealed transaction opens back to exactly what was sealed', () => {
  assert.deepEqual(seal.open(seal.seal(TRANSACTION)), TRANSACTION)
})

test('the envelope is opaque, versioned, and carries no bare transaction value', () => {
  const sealed = seal.seal(TRANSACTION)
  const [version, payload, mac] = partsOf(sealed)
  assert.equal(version, 'v1')
  // 32 bytes of HMAC-SHA256, base64url.
  assert.equal(mac.length, 43)
  assert.match(payload, /^[A-Za-z0-9_-]+$/)
  // None of the three values, nor the key material, is readable as a substring.
  for (const secret of [
    TRANSACTION.state,
    TRANSACTION.nonce,
    TRANSACTION.codeVerifier,
    KEY_MATERIAL,
  ]) {
    assert.equal(sealed.includes(secret), false)
  }
  // Comfortably inside the cookie the transport module will wrap it in.
  assert.ok(sealed.length < 1024)
})

test('two seals of the same transaction differ only where issuance differs', () => {
  const now = 1_700_000_000
  assert.equal(seal.seal(TRANSACTION, now), seal.seal(TRANSACTION, now))
  assert.notEqual(seal.seal(TRANSACTION, now), seal.seal(TRANSACTION, now + 1))
})

// ---------------------------------------------------------------------------
// Tampering
// ---------------------------------------------------------------------------

test('a one-byte change anywhere in a valid envelope is refused', () => {
  const sealed = seal.seal(TRANSACTION)
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
  for (let index = 0; index < sealed.length; index += 1) {
    const original = sealed[index] as string
    if (original === '.') continue
    const replacement = alphabet[(alphabet.indexOf(original) + 1) % alphabet.length] as string
    const mutated = `${sealed.slice(0, index)}${replacement}${sealed.slice(index + 1)}`
    assertRefused(() => seal.open(mutated), `byte ${index} changed`)
  }
})

test('a field-level edit under a re-encoded payload is refused', () => {
  // The realistic shape of the attack: keep the JSON well-formed and the
  // grammar valid, and swap the state (or the verifier) for one the attacker
  // knows. Without the key the authenticator cannot be recomputed.
  const sealed = seal.seal(TRANSACTION)
  const [version, payload, mac] = partsOf(sealed)
  const decoded = JSON.parse(
    Buffer.from(payload, 'base64url').toString('utf8'),
  ) as Record<string, unknown>
  for (const field of ['s', 'n', 'v'] as const) {
    const edited = {
      ...decoded,
      [field]: 'synthetic-attacker-value-00000000000000000',
    }
    const repacked = Buffer.from(JSON.stringify(edited), 'utf8').toString(
      'base64url',
    )
    assert.notEqual(repacked, payload)
    assertRefused(
      () => seal.open(envelope(version, repacked, mac)),
      `field ${field} replaced`,
    )
  }
  // Extending the lifetime by editing the authenticated issuance time fails the
  // same way, which is why the expiry below cannot be talked out of.
  const postdated = Buffer.from(
    JSON.stringify({ ...decoded, t: Number(decoded.t) + 86_400 }),
    'utf8',
  ).toString('base64url')
  assertRefused(
    () => seal.open(envelope(version, postdated, mac)),
    'issuance time moved forward',
  )
})

test('a truncated envelope is refused, at every truncation', () => {
  const sealed = seal.seal(TRANSACTION)
  for (let length = 0; length < sealed.length; length += 1) {
    assertRefused(() => seal.open(sealed.slice(0, length)), `truncated to ${length}`)
  }
  // And a payload truncated inside its own base64url, MAC left intact.
  const [version, payload, mac] = partsOf(sealed)
  assertRefused(
    () => seal.open(envelope(version, payload.slice(0, -4), mac)),
    'payload truncated',
  )
})

test('a wrong-version envelope is refused whole, not read under this version', () => {
  const sealed = seal.seal(TRANSACTION)
  const [, payload, mac] = partsOf(sealed)
  for (const version of ['v0', 'v2', 'V1', '', 'v1 ']) {
    assertRefused(() => seal.open(envelope(version, payload, mac)), version)
  }
  // Including one whose authenticator is computed over the new version string:
  // the version is inside the MAC input, so re-labelling is not a downgrade.
  const key = Buffer.from(
    hkdfSync(
      'sha256',
      Buffer.from(KEY_MATERIAL, 'utf8'),
      Buffer.from(OIDC_TRANSACTION_KEY_SALT, 'utf8'),
      Buffer.from(OIDC_TRANSACTION_KEY_INFO, 'utf8'),
      32,
    ),
  )
  const relabelled = createHmac('sha256', key)
    .update(`v2.${payload}`, 'utf8')
    .digest('base64url')
  assertRefused(
    () => seal.open(envelope('v2', payload, relabelled)),
    'version 2 with its own valid MAC',
  )
})

test('a malformed or oversized value is refused before it is parsed', () => {
  for (const value of [
    null,
    '',
    'not-an-envelope',
    'v1.payload',
    'v1.payload.mac.extra',
    'v1..',
    // Right shape, unparseable payload, MAC-shaped tail.
    envelope('v1', 'not@base64url', 'A'.repeat(43)),
    envelope('v1', Buffer.from('{}').toString('base64url'), 'A'.repeat(43)),
    // Oversized: refused unparsed.
    `v1.${'A'.repeat(2048)}.${'B'.repeat(43)}`,
  ]) {
    assertRefused(() => seal.open(value), JSON.stringify(value)?.slice(0, 48))
  }
})

// ---------------------------------------------------------------------------
// Forgery
// ---------------------------------------------------------------------------

test('a structurally valid envelope sealed under another key is refused', () => {
  // The parent-domain cookie-injection case: the attacker controls the whole
  // value, knows the format exactly, and picks a state they will send back.
  const attacker = createOidcTransactionSeal(ATTACKER_KEY)
  const forged = attacker.seal({
    state: 'synthetic-attacker-state-000000000000000',
    nonce: 'synthetic-attacker-nonce-000000000000000',
    codeVerifier: 'synthetic-attacker-verifier-00000000000',
  })
  // Well-formed by construction — it opens under the key that made it.
  assert.equal(partsOf(forged)[0], 'v1')
  assert.ok(attacker.open(forged))
  assertRefused(() => seal.open(forged), 'forged under another key')
})

test('an envelope with no authenticator at all is refused', () => {
  // What the previous implementation accepted: base64url JSON of the three
  // values, presented as if the format had never had a MAC.
  const bare = Buffer.from(
    JSON.stringify({
      s: TRANSACTION.state,
      n: TRANSACTION.nonce,
      v: TRANSACTION.codeVerifier,
      t: Math.floor(Date.now() / 1000),
    }),
    'utf8',
  ).toString('base64url')
  assertRefused(() => seal.open(bare), 'bare payload, no envelope')
  assertRefused(() => seal.open(envelope('v1', bare, '')), 'empty MAC')
  assertRefused(() => seal.open(envelope('v1', bare, 'A'.repeat(43))), 'guessed MAC')
})

test('the derivation is domain-separated, so the key is not the client secret', () => {
  const sealed = seal.seal(TRANSACTION, 1_700_000_000)
  const [, payload, mac] = partsOf(sealed)
  // Signing with the raw material instead of the derived key produces a
  // different authenticator, and one this seal refuses.
  const undomained = createHmac('sha256', KEY_MATERIAL)
    .update(`v1.${payload}`, 'utf8')
    .digest('base64url')
  assert.notEqual(undomained, mac)
  assertRefused(
    () => seal.open(envelope('v1', payload, undomained)),
    'HMAC under the undomained secret',
  )
  // And the derived key itself never appears in what leaves the module.
  const derived = Buffer.from(
    hkdfSync(
      'sha256',
      Buffer.from(KEY_MATERIAL, 'utf8'),
      Buffer.from(OIDC_TRANSACTION_KEY_SALT, 'utf8'),
      Buffer.from(OIDC_TRANSACTION_KEY_INFO, 'utf8'),
      32,
    ),
  )
  for (const encoding of ['base64url', 'base64', 'hex'] as const) {
    assert.equal(sealed.includes(derived.toString(encoding)), false)
  }
  assert.equal(derived.toString('utf8').includes(KEY_MATERIAL), false)
})

test('key material too short to authenticate a transaction disables the flow', () => {
  assert.throws(
    () => createOidcTransactionSeal('too-short'),
    (error: unknown) => {
      assert.ok(error instanceof OidcBrowserFlowError)
      assert.equal(error.code, 'OIDC_BROWSER_LOGIN_UNAVAILABLE')
      // The refusal names no value.
      assert.equal(error.message.includes('too-short'), false)
      return true
    },
  )
  assert.throws(() => createOidcTransactionSeal(''), OidcBrowserFlowError)
})

// ---------------------------------------------------------------------------
// Expiry, verified here rather than trusted to the browser
// ---------------------------------------------------------------------------

test('an expired transaction is refused server-side, whatever the cookie lived', () => {
  const now = 1_700_000_000
  const issued = now - OIDC_TRANSACTION_TTL_SECONDS - 1
  const stale = seal.seal(TRANSACTION, issued)
  // A browser that ignored `Max-Age`, or a replay by something that is not a
  // browser at all, still presents an intact, correctly authenticated value.
  assertRefused(() => seal.open(stale, now), 'one second past the TTL')
  // Inside the window it opens, including exactly at the boundary.
  assert.deepEqual(
    seal.open(seal.seal(TRANSACTION, now - OIDC_TRANSACTION_TTL_SECONDS), now),
    TRANSACTION,
  )
  assert.deepEqual(seal.open(seal.seal(TRANSACTION, now), now), TRANSACTION)
})

test('a transaction issued in the future beyond clock skew is refused', () => {
  const now = 1_700_000_000
  assert.deepEqual(seal.open(seal.seal(TRANSACTION, now + 30), now), TRANSACTION)
  assertRefused(() => seal.open(seal.seal(TRANSACTION, now + 3_600), now), 'postdated')
})

// ---------------------------------------------------------------------------
// Nothing sealed that could not have been generated
// ---------------------------------------------------------------------------

test('a value outside the generator grammar is never sealed', () => {
  for (const transaction of [
    { ...TRANSACTION, state: 'short' },
    { ...TRANSACTION, nonce: '' },
    { ...TRANSACTION, codeVerifier: 'has spaces 000000000000000000000000000' },
    { ...TRANSACTION, state: 'A'.repeat(200) },
  ]) {
    assertRefused(() => seal.seal(transaction), JSON.stringify(transaction.state))
  }
})
