import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  boundedFlowFailure,
  callbackUrlFor,
  clearOidcIdentityCookie,
  clearOidcTransactionCookie,
  identityCookieMaxAge,
  isOidcTransactionValue,
  oidcIdentityCookie,
  oidcTransactionCookie,
  stateMatches,
  OidcBrowserFlowError,
  OIDC_BROWSER_FLOW_FAILURES,
  OIDC_CALLBACK_ROUTE,
  OIDC_LOGIN_ROUTE,
  OIDC_LOGIN_SUCCESS_PATH,
  OIDC_SCOPE,
  OIDC_TRANSACTION_TTL_SECONDS,
  type OidcTransaction,
} from './oidcBrowserFlow.ts'
import { createOidcTransactionSeal } from './oidcTransactionSeal.ts'

/**
 * Transport-half unit tests. Everything here is synthetic: the "state", "nonce"
 * and "verifier" below are fixed strings shaped like the real generator's
 * output, no provider is contacted, and no socket is opened.
 */

const TRANSACTION: OidcTransaction = {
  state: 'synthetic-state-value-0000000000000000000',
  nonce: 'synthetic-nonce-value-0000000000000000000',
  codeVerifier: 'synthetic-verifier-value-0000000000000000',
}

const REDIRECT_URI = `https://audit.example.test${OIDC_CALLBACK_ROUTE}`

test('the routes and the success destination are same-origin fixed paths', () => {
  for (const route of [
    OIDC_LOGIN_ROUTE,
    OIDC_CALLBACK_ROUTE,
    OIDC_LOGIN_SUCCESS_PATH,
  ]) {
    assert.match(route, /^\/[A-Za-z0-9/-]*$/)
    assert.equal(route.startsWith('//'), false)
  }
  assert.equal(OIDC_LOGIN_ROUTE.startsWith('/api/v1/auth/oidc/'), true)
  assert.equal(OIDC_CALLBACK_ROUTE.startsWith('/api/v1/auth/oidc/'), true)
})

test('only identity scopes are requested, and never offline access', () => {
  assert.deepEqual(OIDC_SCOPE.split(' ').sort(), ['email', 'openid', 'profile'])
  assert.equal(/offline/.test(OIDC_SCOPE), false)
  assert.equal(/googleapis/.test(OIDC_SCOPE), false)
})

test('the transaction grammar admits generated values and nothing else', () => {
  // The bound underneath the envelope's authenticator: whatever a sealed
  // payload claims, only values shaped like the library's own 32-random-byte
  // base64url output are handed to an exchange.
  for (const value of [
    TRANSACTION.state,
    TRANSACTION.nonce,
    TRANSACTION.codeVerifier,
    'A'.repeat(32),
  ]) {
    assert.equal(isOidcTransactionValue(value), true)
  }
  for (const value of [
    null,
    undefined,
    '',
    'short',
    'A'.repeat(129),
    'has spaces in it 0000000000000000000000000',
    'has/slashes/and+plus/00000000000000000000000',
    42,
  ]) {
    assert.equal(isOidcTransactionValue(value), false, String(value))
  }
})

test('state comparison rejects a mismatch, a prefix, and a missing value', () => {
  assert.equal(stateMatches(TRANSACTION.state, TRANSACTION.state), true)
  assert.equal(stateMatches(null, TRANSACTION.state), false)
  assert.equal(stateMatches('', TRANSACTION.state), false)
  assert.equal(
    stateMatches(TRANSACTION.state.slice(0, -1), TRANSACTION.state),
    false,
  )
  assert.equal(stateMatches(`${TRANSACTION.state}x`, TRANSACTION.state), false)
  assert.equal(stateMatches(TRANSACTION.nonce, TRANSACTION.state), false)
})

/** A seal over synthetic key material, for the cookie-attribute tests below. */
const seal = createOidcTransactionSeal('synthetic-seal-key-material-000000')

test('transaction cookies are Secure, HttpOnly, Lax and scoped to the flow', () => {
  for (const header of [
    oidcTransactionCookie(seal.seal(TRANSACTION)),
    clearOidcTransactionCookie(),
  ]) {
    assert.match(header, /; Secure(;|$)/)
    assert.match(header, /; HttpOnly(;|$)/)
    assert.match(header, /; SameSite=Lax(;|$)/)
    // Narrower than the application: a dashboard read never carries it.
    assert.match(header, /; Path=\/api\/v1\/auth\/oidc;/)
  }
  assert.match(
    oidcTransactionCookie(seal.seal(TRANSACTION)),
    new RegExp(`; Max-Age=${OIDC_TRANSACTION_TTL_SECONDS};`),
  )
  assert.match(clearOidcTransactionCookie(), /; Max-Age=0;/)
})

test('the identity cookie is Secure, HttpOnly, Lax and bounded', () => {
  const header = oidcIdentityCookie('kaudit_id', 'synthetic.id.token', 3600)
  assert.match(header, /^kaudit_id=synthetic\.id\.token;/)
  assert.match(header, /; Path=\/;/)
  assert.match(header, /; Max-Age=3600;/)
  assert.match(header, /; Secure(;|$)/)
  assert.match(header, /; HttpOnly(;|$)/)
  assert.match(header, /; SameSite=Lax(;|$)/)
  assert.match(clearOidcIdentityCookie('kaudit_id'), /^kaudit_id=; Path=\/; Max-Age=0;/)
})

test('the identity cookie never outlives the token or the policy', () => {
  const now = 1_000_000
  // Provider lifetime shorter than policy.
  assert.equal(identityCookieMaxAge(now + 300, 3600, now), 300)
  // Policy shorter than provider lifetime.
  assert.equal(identityCookieMaxAge(now + 3600, 900, now), 900)
  // Already expired, and clock skew past expiry, both floor at zero.
  assert.equal(identityCookieMaxAge(now - 1, 3600, now), 0)
  assert.equal(identityCookieMaxAge(now - 10_000, 3600, now), 0)
})

test('the callback URL is rebuilt from configuration, never from the request host', () => {
  const url = callbackUrlFor(
    REDIRECT_URI,
    '?code=synthetic-code&state=synthetic-state',
  )
  assert.equal(url.origin, 'https://audit.example.test')
  assert.equal(url.pathname, OIDC_CALLBACK_ROUTE)
  assert.equal(url.searchParams.get('code'), 'synthetic-code')
  // A crafted query cannot move the origin or the path off the configured URI.
  const hostile = callbackUrlFor(
    REDIRECT_URI,
    '?code=x&redirect_uri=https://attacker.example.invalid/',
  )
  assert.equal(hostile.origin, 'https://audit.example.test')
  assert.equal(hostile.pathname, OIDC_CALLBACK_ROUTE)
})

test('the callback URL refuses a wrong redirect path or an unbounded query', () => {
  assert.throws(
    () => callbackUrlFor('https://audit.example.test/elsewhere', '?code=x'),
    /Sign-in could not be completed/,
  )
  assert.throws(
    () => callbackUrlFor(REDIRECT_URI, `?code=${'x'.repeat(8192)}`),
    /Sign-in could not be completed/,
  )
})

test('an arbitrary thrown value collapses to one bounded failure', () => {
  // The guarantee that matters: whatever a token exchange throws — a response
  // body, a URL with a code in it, a client id — none of it survives.
  const leaky = new Error(
    'token endpoint 400: {"error":"invalid_grant"} code=4/0AX secret=s3cret',
  )
  const bounded = boundedFlowFailure(leaky)
  assert.equal(bounded.code, 'OIDC_EXCHANGE_FAILED')
  assert.equal(bounded.message, 'Sign-in could not be completed')
  assert.equal(bounded.cause, undefined)
  assert.equal(/invalid_grant|4\/0AX|s3cret/.test(bounded.message), false)
  assert.equal(
    /invalid_grant|4\/0AX|s3cret/.test(JSON.stringify(bounded, Object.getOwnPropertyNames(bounded))),
    false,
  )
  // An already-bounded failure keeps its own code.
  const known = new OidcBrowserFlowError('OIDC_PROVIDER_REFUSED')
  assert.equal(boundedFlowFailure(known), known)
})

test('every failure is a fixed code with a fixed title and no interpolation', () => {
  for (const [code, failure] of Object.entries(OIDC_BROWSER_FLOW_FAILURES)) {
    assert.match(code, /^OIDC_[A-Z_]+$/)
    assert.ok([400, 401, 404, 502].includes(failure.status))
    // No placeholder, no punctuation that would suggest an embedded value.
    assert.match(failure.title, /^[A-Za-z ][A-Za-z -]+$/)
    assert.equal(new OidcBrowserFlowError(
      code as keyof typeof OIDC_BROWSER_FLOW_FAILURES,
    ).message, failure.title)
  }
})
