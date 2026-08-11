import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { exportJWK, generateKeyPair, SignJWT } from 'jose'
import * as oidc from 'openid-client'
import { createOidcAuthorizationClient } from './oidcAuthorizationClient.ts'
import {
  callbackUrlFor,
  OidcBrowserFlowError,
  OIDC_CALLBACK_ROUTE,
} from './oidcBrowserFlow.ts'

/**
 * The protocol edge, exercised against the real `openid-client`.
 *
 * No network, no real provider, and no socket: a synthetic authorization server
 * is injected through the library's own `customFetch` hook, and its ID tokens
 * are signed with a keypair generated in this process. Everything the library
 * checks — signature, issuer, audience, expiry, nonce, state, PKCE — therefore
 * runs for real against material this file controls.
 *
 * Every value below is synthetic. `CLIENT_SECRET` is a fixed string invented
 * here; it is not a credential and matches nothing.
 */

const ISSUER = 'https://identity.example.test'
const CLIENT_ID = 'synthetic-client-id.apps.example.test'
const CLIENT_SECRET = 'synthetic-client-secret-not-a-credential'
const REDIRECT_URI = `https://audit.example.test${OIDC_CALLBACK_ROUTE}`
const SUBJECT = 'synthetic-subject-1'

const keys = await generateKeyPair('ES256', { extractable: true })
const publicJwk = { ...(await exportJWK(keys.publicKey)), kid: 'synthetic-1', alg: 'ES256' }

const METADATA: oidc.ServerMetadata = {
  issuer: ISSUER,
  authorization_endpoint: `${ISSUER}/o/oauth2/v2/auth`,
  token_endpoint: `${ISSUER}/token`,
  jwks_uri: `${ISSUER}/jwks`,
  id_token_signing_alg_values_supported: ['ES256'],
  code_challenge_methods_supported: ['S256'],
  response_types_supported: ['code'],
  grant_types_supported: ['authorization_code'],
}

interface ProviderOptions {
  /** Nonce placed in the issued ID token. Defaults to the requested one. */
  nonceOverride?: string
  /** Seconds from now for the ID token's `exp`. */
  lifetimeSeconds?: number
  /** Refuses the token request as an unhappy provider would. */
  refuse?: boolean
}

interface Provider {
  configuration: () => Promise<oidc.Configuration>
  /** What the token endpoint actually received. Assertions read this. */
  tokenRequests: Array<Record<string, string>>
  issuedNonce: string | null
}

function syntheticProvider(options: ProviderOptions = {}): Provider {
  const provider: Provider = {
    tokenRequests: [],
    issuedNonce: null,
    configuration: async () => {
      const configuration = new oidc.Configuration(
        METADATA,
        CLIENT_ID,
        CLIENT_SECRET,
      )
      configuration[oidc.customFetch] = async (input, init) => {
        const url = typeof input === 'string' ? input : String(input)
        if (url.startsWith(METADATA.jwks_uri as string)) {
          return Response.json({ keys: [publicJwk] })
        }
        if (url.startsWith(METADATA.token_endpoint as string)) {
          const body = new URLSearchParams(String(init?.body ?? ''))
          const received = Object.fromEntries(body.entries())
          provider.tokenRequests.push(received)
          if (options.refuse) {
            return Response.json(
              // Deliberately loaded with things that must never resurface.
              {
                error: 'invalid_grant',
                error_description: `code 4/0AXsynthetic for ${CLIENT_ID}`,
              },
              { status: 400 },
            )
          }
          // A real provider binds the code to the challenge it was issued
          // with; the synthetic one does the same so a wrong verifier fails.
          const expected = createHash('sha256')
            .update(received.code_verifier ?? '')
            .digest('base64url')
          if (received.code !== `code-for-${expected}`) {
            return Response.json({ error: 'invalid_grant' }, { status: 400 })
          }
          const nonce = options.nonceOverride ?? provider.issuedNonce ?? ''
          const now = Math.floor(Date.now() / 1000)
          const idToken = await new SignJWT({
            nonce,
            email: 'synthetic.operator@example.test',
          })
            .setProtectedHeader({ alg: 'ES256', kid: 'synthetic-1' })
            .setIssuer(ISSUER)
            .setAudience(CLIENT_ID)
            .setSubject(SUBJECT)
            .setIssuedAt(now)
            .setExpirationTime(now + (options.lifetimeSeconds ?? 3600))
            .sign(keys.privateKey)
          return Response.json({
            access_token: 'synthetic-access-token',
            token_type: 'bearer',
            expires_in: 3600,
            id_token: idToken,
          })
        }
        throw new Error(`synthetic provider has no route for ${url}`)
      }
      return configuration
    },
  }
  return provider
}

function client(provider: Provider) {
  return createOidcAuthorizationClient({
    issuer: ISSUER,
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    redirectUri: REDIRECT_URI,
    loadConfiguration: provider.configuration,
  })
}

/** The callback a compliant provider would produce for this transaction. */
function callbackFor(
  transaction: { state: string; codeVerifier: string },
): URL {
  const challenge = createHash('sha256')
    .update(transaction.codeVerifier)
    .digest('base64url')
  return callbackUrlFor(
    REDIRECT_URI,
    `?code=${encodeURIComponent(`code-for-${challenge}`)}&state=${encodeURIComponent(transaction.state)}`,
  )
}

test('the authorization request carries strong state, nonce and PKCE S256', async () => {
  const provider = syntheticProvider()
  const subject = client(provider)
  const first = await subject.beginAuthorization()
  const second = await subject.beginAuthorization()

  const parameters = first.authorizationUrl.searchParams
  assert.equal(first.authorizationUrl.origin, ISSUER)
  assert.equal(parameters.get('response_type'), 'code')
  assert.equal(parameters.get('redirect_uri'), REDIRECT_URI)
  assert.equal(parameters.get('scope'), 'openid email profile')
  assert.equal(parameters.get('code_challenge_method'), 'S256')
  // No refresh token is requested, by any spelling.
  assert.equal(parameters.get('access_type'), null)
  assert.equal(parameters.has('prompt'), false)
  assert.equal(/offline/.test(first.authorizationUrl.toString()), false)

  // Each value is 32 random bytes, base64url. Distinct across transactions.
  for (const value of [
    first.transaction.state,
    first.transaction.nonce,
    first.transaction.codeVerifier,
  ]) {
    assert.match(value, /^[A-Za-z0-9_-]{43,}$/)
  }
  assert.notEqual(first.transaction.state, second.transaction.state)
  assert.notEqual(first.transaction.nonce, second.transaction.nonce)
  assert.notEqual(first.transaction.codeVerifier, second.transaction.codeVerifier)
  assert.notEqual(first.transaction.state, first.transaction.nonce)

  // The URL carries the challenge; only the cookie carries the verifier.
  assert.equal(parameters.get('state'), first.transaction.state)
  assert.equal(parameters.get('nonce'), first.transaction.nonce)
  assert.equal(
    parameters.get('code_challenge'),
    createHash('sha256').update(first.transaction.codeVerifier).digest('base64url'),
  )
  assert.equal(
    first.authorizationUrl.toString().includes(first.transaction.codeVerifier),
    false,
  )
  // Nor the client secret.
  assert.equal(
    first.authorizationUrl.toString().includes(CLIENT_SECRET),
    false,
  )
})

test('a valid callback exchanges server to server and yields a validated ID token', async () => {
  const provider = syntheticProvider()
  const subject = client(provider)
  const start = await subject.beginAuthorization()
  provider.issuedNonce = start.transaction.nonce

  const verified = await subject.exchange({
    callbackUrl: callbackFor(start.transaction),
    expectedState: start.transaction.state,
    expectedNonce: start.transaction.nonce,
    codeVerifier: start.transaction.codeVerifier,
  })

  assert.equal(typeof verified.idToken, 'string')
  assert.equal(verified.idToken.split('.').length, 3)
  assert.ok(verified.expiresAtSeconds > Math.floor(Date.now() / 1000))

  // The token request is a back-channel POST carrying the verifier and the
  // redirect URI the library derived from the configured callback URL.
  const [sent] = provider.tokenRequests
  assert.equal(provider.tokenRequests.length, 1)
  assert.equal(sent?.grant_type, 'authorization_code')
  assert.equal(sent?.code_verifier, start.transaction.codeVerifier)
  assert.equal(sent?.redirect_uri, REDIRECT_URI)
})

test('a replayed or mismatched state never reaches the token endpoint', async () => {
  const provider = syntheticProvider()
  const subject = client(provider)
  const start = await subject.beginAuthorization()
  const other = await subject.beginAuthorization()
  provider.issuedNonce = start.transaction.nonce

  await assert.rejects(
    subject.exchange({
      callbackUrl: callbackFor(start.transaction),
      expectedState: other.transaction.state,
      expectedNonce: start.transaction.nonce,
      codeVerifier: start.transaction.codeVerifier,
    }),
    (error: unknown) => {
      assert.ok(error instanceof OidcBrowserFlowError)
      assert.equal(error.code, 'OIDC_EXCHANGE_FAILED')
      return true
    },
  )
  assert.equal(provider.tokenRequests.length, 0)
})

test('an ID token whose nonce does not match the transaction is refused', async () => {
  const provider = syntheticProvider({
    nonceOverride: 'synthetic-attacker-supplied-nonce-value',
  })
  const subject = client(provider)
  const start = await subject.beginAuthorization()

  await assert.rejects(
    subject.exchange({
      callbackUrl: callbackFor(start.transaction),
      expectedState: start.transaction.state,
      expectedNonce: start.transaction.nonce,
      codeVerifier: start.transaction.codeVerifier,
    }),
    /Sign-in could not be completed/,
  )
})

test('a wrong PKCE verifier is refused by the provider and stays bounded', async () => {
  const provider = syntheticProvider()
  const subject = client(provider)
  const start = await subject.beginAuthorization()
  const other = await subject.beginAuthorization()
  provider.issuedNonce = start.transaction.nonce

  await assert.rejects(
    subject.exchange({
      // Code bound to this transaction's challenge, verifier from another.
      callbackUrl: callbackFor(start.transaction),
      expectedState: start.transaction.state,
      expectedNonce: start.transaction.nonce,
      codeVerifier: other.transaction.codeVerifier,
    }),
    /Sign-in could not be completed/,
  )
})

test('a provider refusal surfaces one code and none of its prose', async () => {
  const provider = syntheticProvider({ refuse: true })
  const subject = client(provider)
  const start = await subject.beginAuthorization()
  provider.issuedNonce = start.transaction.nonce

  await assert.rejects(
    subject.exchange({
      callbackUrl: callbackFor(start.transaction),
      expectedState: start.transaction.state,
      expectedNonce: start.transaction.nonce,
      codeVerifier: start.transaction.codeVerifier,
    }),
    (error: unknown) => {
      assert.ok(error instanceof OidcBrowserFlowError)
      assert.equal(error.code, 'OIDC_EXCHANGE_FAILED')
      assert.equal(error.message, 'Sign-in could not be completed')
      assert.equal(error.cause, undefined)
      const serialized = JSON.stringify(
        error,
        Object.getOwnPropertyNames(error),
      )
      for (const forbidden of [
        'invalid_grant',
        '4/0AXsynthetic',
        CLIENT_ID,
        CLIENT_SECRET,
        start.transaction.codeVerifier,
        start.transaction.state,
      ]) {
        assert.equal(
          serialized.includes(forbidden),
          false,
          `the bounded failure must not carry ${forbidden.slice(0, 24)}`,
        )
      }
      return true
    },
  )
})

test('an already-expired ID token is validated as expired, not accepted', async () => {
  const provider = syntheticProvider({ lifetimeSeconds: -60 })
  const subject = client(provider)
  const start = await subject.beginAuthorization()
  provider.issuedNonce = start.transaction.nonce

  await assert.rejects(
    subject.exchange({
      callbackUrl: callbackFor(start.transaction),
      expectedState: start.transaction.state,
      expectedNonce: start.transaction.nonce,
      codeVerifier: start.transaction.codeVerifier,
    }),
    /Sign-in could not be completed/,
  )
})

test('the transaction leaves the edge sealed, and only reopens behind it', async () => {
  const provider = syntheticProvider()
  const subject = client(provider)
  const start = await subject.beginAuthorization()

  // What the server is handed for the cookie is opaque: none of the three
  // values, and no key material, is readable from it.
  for (const secret of [
    start.transaction.state,
    start.transaction.nonce,
    start.transaction.codeVerifier,
    CLIENT_SECRET,
  ]) {
    assert.equal(start.transactionCookie.includes(secret), false)
  }
  assert.deepEqual(
    subject.openTransaction(start.transactionCookie),
    start.transaction,
  )

  // A deployment with a different client secret derives a different key, so a
  // cookie from elsewhere is refused rather than adopted.
  const other = createOidcAuthorizationClient({
    issuer: ISSUER,
    clientId: CLIENT_ID,
    clientSecret: 'synthetic-other-client-secret-not-a-credential',
    redirectUri: REDIRECT_URI,
    loadConfiguration: provider.configuration,
  })
  assert.throws(
    () => other.openTransaction(start.transactionCookie),
    (error: unknown) => {
      assert.ok(error instanceof OidcBrowserFlowError)
      assert.equal(error.code, 'OIDC_TRANSACTION_MISSING')
      return true
    },
  )
})

test('a tampered cookie is refused before the token endpoint is contacted', async () => {
  const provider = syntheticProvider()
  const subject = client(provider)
  const start = await subject.beginAuthorization()
  const sealed = start.transactionCookie
  // Last character of the authenticator, changed.
  const last = sealed.slice(-1) === 'A' ? 'B' : 'A'
  assert.throws(
    () => subject.openTransaction(`${sealed.slice(0, -1)}${last}`),
    /Sign-in request has expired/,
  )
  assert.equal(provider.tokenRequests.length, 0)
})

test('a redirect URI that is not the callback route is refused at construction', () => {
  for (const redirectUri of [
    'https://audit.example.test/api/v1/auth/oidc/elsewhere',
    `http://audit.example.test${OIDC_CALLBACK_ROUTE}`,
  ]) {
    assert.throws(
      () =>
        createOidcAuthorizationClient({
          issuer: ISSUER,
          clientId: CLIENT_ID,
          clientSecret: CLIENT_SECRET,
          redirectUri,
        }),
      /Browser sign-in is not available/,
    )
  }
})

test('an unreachable provider fails bounded and stays retryable', async () => {
  let attempts = 0
  const subject = createOidcAuthorizationClient({
    issuer: ISSUER,
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    redirectUri: REDIRECT_URI,
    loadConfiguration: async () => {
      attempts += 1
      if (attempts === 1) {
        throw new Error(`discovery failed for ${ISSUER} secret=${CLIENT_SECRET}`)
      }
      return syntheticProvider().configuration()
    },
  })

  await assert.rejects(
    subject.beginAuthorization(),
    (error: unknown) => {
      assert.ok(error instanceof OidcBrowserFlowError)
      assert.equal(error.code, 'OIDC_LOGIN_START_FAILED')
      assert.equal(error.message.includes(CLIENT_SECRET), false)
      return true
    },
  )
  // The rejection is not memoized: a transient outage must not disable sign-in
  // for the life of the instance.
  const start = await subject.beginAuthorization()
  assert.equal(attempts, 2)
  assert.ok(start.transaction.state.length >= 43)
})
