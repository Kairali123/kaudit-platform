import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { mkdtemp, writeFile } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import type { Pool } from 'mysql2/promise'
import { exportJWK, generateKeyPair, SignJWT } from 'jose'
import type { AuditEvent, AuditSink } from '../audit/types.ts'
import type { AccessRepository } from '../auth/types.ts'
import { createOidcVerifier } from '../auth/oidcVerifier.ts'
import type { OidcAuthorizationClient } from '../auth/oidcAuthorizationClient.ts'
import { createOidcTransactionSeal } from '../auth/oidcTransactionSeal.ts'
import {
  OIDC_CALLBACK_ROUTE,
  OIDC_LOGIN_ROUTE,
  OIDC_LOGIN_SUCCESS_PATH,
  OIDC_TRANSACTION_COOKIE,
} from '../auth/oidcBrowserFlow.ts'
import { loadRuntimeConfig } from '../config/runtime.ts'
import { createEnterpriseDashboardServer } from './enterpriseDashboardServer.ts'

/**
 * The seam between the two halves of a browser sign-in: the callback validates an
 * ID token and puts it in a cookie, and the very next request has to verify that
 * same cookie and establish the protected shell.
 *
 * `enterpriseDashboardServer.oidcBrowserFlow.test.ts` covers the callback itself
 * with an injected verifier and a hand-written `RuntimeConfig`. Both of those
 * substitutions sit exactly where the two halves have to agree, so this file
 * removes them: the configuration comes from `loadRuntimeConfig`, and the
 * verifier is the shipping `createOidcVerifier` wired the way
 * `runtime/dashboardRuntime.ts` wires it. What is left synthetic is only the
 * provider — a keypair generated in this process, a local JWKS endpoint, and an
 * authorization client that returns a token signed by that key.
 *
 * The property under test is the one an operator experiences: after a successful
 * callback, a protected page is served rather than redirecting to `/login`.
 *
 * Every value here is synthetic and matches nothing. There is no real issuer,
 * no real client, no real token, no real subject, and no real identity: the
 * issuer is an `.invalid`-adjacent test host, and the ID token is minted below
 * from a keypair that exists only for the duration of this file.
 */

/**
 * An origin-only issuer identifier — the shape a provider that lives at the root
 * of a host publishes, and the shape whose `iss` claim carries no trailing path.
 * The gap this file exists to cover only appears for this shape, so the fixture
 * has to have it.
 */
const ISSUER = 'https://identity.example.test'
const CLIENT_ID = 'synthetic-client-id.apps.example.test'
const CLIENT_SECRET = 'synthetic-client-secret-not-a-credential'
const TOKEN_COOKIE = 'kaudit_id_token'
const SUBJECT = 'synthetic-subject-1'
const EMAIL = 'synthetic.operator@example.test'
const REDIRECT_URI = `https://audit.example.test${OIDC_CALLBACK_ROUTE}`

const STATE = 'synthetic-state-value-000000000000000000000'
const NONCE = 'synthetic-nonce-value-000000000000000000000'
const VERIFIER = 'synthetic-verifier-value-00000000000000000'

const keys = await generateKeyPair('ES256', { extractable: true })
const publicJwk = {
  ...(await exportJWK(keys.publicKey)),
  kid: 'synthetic-1',
  alg: 'ES256',
}

/**
 * The environment an operator sets, and nothing more.
 *
 * Read through `loadRuntimeConfig` on purpose: whatever that function does to
 * these values is what the deployment runs, so a rewrite it performs has to be
 * survivable here rather than assumed away by a literal config object.
 */
const ENV: NodeJS.ProcessEnv = {
  NODE_ENV: 'test',
  KAUDIT_AUTH_MODE: 'oidc',
  KAUDIT_SECURE_HOST: '127.0.0.1',
  DB_HOST: 'synthetic',
  DB_NAME: 'synthetic',
  DB_USER: 'synthetic',
  DB_PASSWORD: 'synthetic',
  DB_TLS_MODE: 'disabled',
  KAUDIT_OIDC_ISSUER: ISSUER,
  KAUDIT_OIDC_AUDIENCE: CLIENT_ID,
  KAUDIT_OIDC_JWKS_URI: `${ISSUER}/jwks`,
  KAUDIT_OIDC_TOKEN_COOKIE: TOKEN_COOKIE,
  KAUDIT_OIDC_ALGORITHMS: 'ES256',
  KAUDIT_OIDC_BROWSER_FLOW: 'true',
  KAUDIT_OIDC_CLIENT_ID: CLIENT_ID,
  KAUDIT_OIDC_CLIENT_SECRET: CLIENT_SECRET,
  KAUDIT_OIDC_REDIRECT_URI: REDIRECT_URI,
}

/** The real envelope, keyed the way the production client keys it. */
const transactionSeal = createOidcTransactionSeal(CLIENT_SECRET)

/**
 * An ID token as a provider issues one: `iss` is the issuer identifier the
 * provider published, verbatim, with no trailing path added to it.
 */
async function providerIdToken(): Promise<{
  idToken: string
  expiresAtSeconds: number
}> {
  const now = Math.floor(Date.now() / 1000)
  const expiresAtSeconds = now + 3600
  const idToken = await new SignJWT({ nonce: NONCE, email: EMAIL })
    .setProtectedHeader({ alg: 'ES256', kid: 'synthetic-1' })
    .setIssuer(ISSUER)
    .setAudience(CLIENT_ID)
    .setSubject(SUBJECT)
    .setIssuedAt(now)
    .setExpirationTime(expiresAtSeconds)
    .sign(keys.privateKey)
  return { idToken, expiresAtSeconds }
}

/**
 * The protocol edge, synthetic. Only the provider round trip is replaced: the
 * transaction envelope is sealed and opened by the shipping implementation, and
 * the token it hands back is a real signed JWT the verifier has to accept.
 */
function syntheticClient(): OidcAuthorizationClient {
  return {
    async beginAuthorization() {
      const transaction = { state: STATE, nonce: NONCE, codeVerifier: VERIFIER }
      return {
        authorizationUrl: new URL(`${ISSUER}/o/oauth2/v2/auth`),
        transaction,
        transactionCookie: transactionSeal.seal(transaction),
      }
    },
    openTransaction(cookieValue) {
      return transactionSeal.open(cookieValue)
    },
    async exchange() {
      return providerIdToken()
    },
  }
}

/** Serves the synthetic signing key. Nothing else, and only over loopback. */
async function withJwks(
  run: (jwksUri: string) => Promise<void>,
): Promise<void> {
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ keys: [publicJwk] }))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  try {
    await run(`http://127.0.0.1:${port}/jwks`)
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    )
  }
}

/** A built web application, reduced to the one file `serveApp` reads. */
async function syntheticWebDist(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kaudit-oidc-session-'))
  await writeFile(
    path.join(root, 'index.html'),
    '<!doctype html><div id="root"></div>',
  )
  return root
}

interface Harness {
  baseUrl: string
  events: AuditEvent[]
  /** The issuer this deployment resolves a verified identity under. */
  configuredIssuer: string
}

/**
 * The deployment, assembled from configuration exactly as the runtime does.
 *
 * The one substitution is the JWKS URL, because `loadRuntimeConfig` requires an
 * HTTPS one and this file contacts no network. Every other verifier input —
 * issuer, audience, algorithms, freshness ceiling — is the loaded configuration's
 * own value, which is the point.
 */
async function withDeployment(
  run: (harness: Harness) => Promise<void>,
  options: { provisioned?: boolean } = {},
): Promise<void> {
  const config = loadRuntimeConfig(ENV)
  assert.equal(config.auth.mode, 'oidc')
  if (config.auth.mode !== 'oidc') return
  const configuredIssuer = config.auth.issuer
  const webDistRoot = await syntheticWebDist()

  await withJwks(async (jwksUri) => {
    const verifier = createOidcVerifier({
      issuer: config.auth.mode === 'oidc' ? config.auth.issuer : '',
      audience: config.auth.mode === 'oidc' ? config.auth.audience : '',
      jwksUri,
      algorithms: config.auth.mode === 'oidc' ? config.auth.algorithms : [],
      maxTokenAgeSeconds:
        config.auth.mode === 'oidc' ? config.auth.maxTokenAgeSeconds : 60,
    })
    const events: AuditEvent[] = []
    const audit: AuditSink = {
      async record(event) {
        events.push(event)
      },
      async readiness() {
        return true
      },
    }
    /**
     * The binding an operator wrote with `w1:bind-oidc`, which requires the
     * issuer it stores to equal this deployment's configured issuer. Matching on
     * that value rather than on a literal is what keeps this fixture honest
     * about which key the lookup uses.
     */
    const access: AccessRepository = {
      async findByOidc(issuer, subject) {
        if (!options.provisioned) return null
        return issuer === configuredIssuer && subject === SUBJECT
          ? {
              id: 'user-1',
              email: EMAIL,
              status: 'active',
              maxSensitivityTier: 'K1',
              roles: ['user'],
            }
          : null
      },
      async findByEmail() {
        return null
      },
      async readiness() {
        return true
      },
    }
    const server = createEnterpriseDashboardServer({
      config,
      pool: {
        async query() {
          return [[{ one: 1 }], []]
        },
      } as unknown as Pool,
      access,
      audit,
      verifier,
      oidcAuthorizationClient: syntheticClient(),
      webDistRoot,
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address() as AddressInfo
    try {
      await run({
        baseUrl: `http://127.0.0.1:${port}`,
        events,
        configuredIssuer,
      })
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      )
    }
  })
}

/**
 * Signs in the way a browser does, and returns the cookie jar it would hold.
 *
 * The transaction cookie goes back on the callback, the callback's `Set-Cookie`
 * headers are applied in order, and a cookie cleared with `Max-Age=0` is dropped
 * rather than carried forward — so what the next request sends is what a browser
 * would actually have after the redirect, not a value picked out of the response
 * by name.
 */
async function signIn(baseUrl: string): Promise<{
  callback: Response
  cookieHeader: string
}> {
  const login = await fetch(`${baseUrl}${OIDC_LOGIN_ROUTE}`, {
    redirect: 'manual',
  })
  assert.equal(login.status, 302)
  const transaction = login.headers
    .getSetCookie()
    .find((header) => header.startsWith(`${OIDC_TRANSACTION_COOKIE}=`))
  assert.ok(transaction, 'login must set the transaction cookie')

  const callback = await fetch(
    `${baseUrl}${OIDC_CALLBACK_ROUTE}?code=synthetic-code&state=${STATE}`,
    {
      redirect: 'manual',
      headers: { cookie: transaction.slice(0, transaction.indexOf(';')) },
    },
  )

  const jar = new Map<string, string>()
  for (const header of callback.headers.getSetCookie()) {
    const pair = header.slice(0, header.indexOf(';'))
    const name = pair.slice(0, pair.indexOf('='))
    const value = pair.slice(pair.indexOf('=') + 1)
    if (/;\s*Max-Age=0(;|$)/i.test(header) || value === '') {
      jar.delete(name)
      continue
    }
    jar.set(name, value)
  }
  return {
    callback,
    cookieHeader: [...jar].map(([name, value]) => `${name}=${value}`).join('; '),
  }
}

// ---------------------------------------------------------------------------
// The contract the two halves of the flow have to agree on
// ---------------------------------------------------------------------------

test('the cookie a successful callback issues establishes the protected shell', async () => {
  await withDeployment(
    async ({ baseUrl, events }) => {
      const { callback, cookieHeader } = await signIn(baseUrl)

      // The callback half: completed, and pointing at the protected shell.
      assert.equal(callback.status, 302)
      assert.equal(
        callback.headers.get('location'),
        OIDC_LOGIN_SUCCESS_PATH,
      )
      assert.equal(
        events.filter((event) => event.action === 'auth.oidc_callback')
          .length,
        1,
      )
      // The transaction was consumed, so the jar carries the identity cookie
      // alone — the same thing the browser takes into the next request.
      assert.equal(cookieHeader.startsWith(`${TOKEN_COOKIE}=`), true)
      assert.equal(cookieHeader.includes(OIDC_TRANSACTION_COOKIE), false)

      /**
       * The request half, and the whole point of this file. This is the exact
       * navigation the success redirect causes. A deployment where the
       * per-request verifier does not accept what the callback just validated
       * answers it with `302 /login`, which is a sign-in that reports success
       * and then loops.
       */
      const shell = await fetch(`${baseUrl}${OIDC_LOGIN_SUCCESS_PATH}`, {
        redirect: 'manual',
        headers: { cookie: cookieHeader },
      })
      assert.equal(shell.status, 200)
      assert.match(shell.headers.get('content-type') ?? '', /text\/html/)

      // And the API the shell then calls resolves the same identity.
      const me = await fetch(`${baseUrl}/api/v1/me`, {
        headers: { cookie: cookieHeader },
      })
      assert.equal(me.status, 200)
      const profile = (await me.json()) as Record<string, unknown>
      assert.equal(profile.authMode, 'oidc')
      assert.equal(profile.accessControlEnforced, true)
    },
    { provisioned: true },
  )
})

test('an unauthenticated navigation to the shell is what produces the login redirect', async () => {
  // The other side of the assertion above: `302 /login` is a real behaviour of
  // this route, so the test proves the cookie is what avoids it rather than
  // proving the route never redirects.
  await withDeployment(async ({ baseUrl }) => {
    const shell = await fetch(`${baseUrl}${OIDC_LOGIN_SUCCESS_PATH}`, {
      redirect: 'manual',
    })
    assert.equal(shell.status, 302)
    assert.equal(shell.headers.get('location'), '/login')
  })
})

test('signing in is still not authorization: an unbound identity is refused', async () => {
  // The verifier accepting the token must not be mistaken for access. The
  // access repository provisions nobody here, and the callback deliberately
  // created no binding on its way through.
  await withDeployment(async ({ baseUrl }) => {
    const { cookieHeader } = await signIn(baseUrl)
    const me = await fetch(`${baseUrl}/api/v1/me`, {
      headers: { cookie: cookieHeader },
    })
    assert.equal(me.status, 403)
    assert.equal(
      ((await me.json()) as { code: string }).code,
      'USER_NOT_PROVISIONED',
    )
  })
})

test('a token from another issuer is refused, however it is spelled', async () => {
  /**
   * The bound above. Accepting the configured issuer identifier under the
   * spelling the provider published must not become accepting a neighbouring
   * host, a sibling path, or plain HTTP.
   */
  await withDeployment(
    async ({ baseUrl, configuredIssuer }) => {
      const now = Math.floor(Date.now() / 1000)
      const foreign = [
        'https://identity.example.test.attacker.test',
        'https://attacker.test/identity.example.test',
        'https://identity.example.test/tenant-2',
        'http://identity.example.test',
      ]
      for (const issuer of foreign) {
        assert.notEqual(issuer, configuredIssuer)
        const token = await new SignJWT({ email: EMAIL })
          .setProtectedHeader({ alg: 'ES256', kid: 'synthetic-1' })
          .setIssuer(issuer)
          .setAudience(CLIENT_ID)
          .setSubject(SUBJECT)
          .setIssuedAt(now)
          .setExpirationTime(now + 3600)
          .sign(keys.privateKey)
        const me = await fetch(`${baseUrl}/api/v1/me`, {
          headers: { cookie: `${TOKEN_COOKIE}=${token}` },
        })
        assert.equal(me.status, 401)
        assert.equal(
          ((await me.json()) as { code: string }).code,
          'AUTH_INVALID',
        )
      }
    },
    { provisioned: true },
  )
})
