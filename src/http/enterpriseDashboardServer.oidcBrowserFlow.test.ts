import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { AddressInfo } from 'node:net'
import type { Pool } from 'mysql2/promise'
import type { AuditEvent, AuditSink } from '../audit/types.ts'
import type { AccessRepository, TokenVerifier } from '../auth/types.ts'
import type { RuntimeConfig } from '../config/runtime.ts'
import {
  OidcBrowserFlowError,
  OIDC_CALLBACK_ROUTE,
  OIDC_LOGIN_ROUTE,
  OIDC_TRANSACTION_COOKIE,
  OIDC_TRANSACTION_TTL_SECONDS,
} from '../auth/oidcBrowserFlow.ts'
import { createOidcTransactionSeal } from '../auth/oidcTransactionSeal.ts'
import type {
  OidcAuthorizationClient,
  OidcCallbackExchange,
} from '../auth/oidcAuthorizationClient.ts'
import { createEnterpriseDashboardServer } from './enterpriseDashboardServer.ts'

/**
 * HTTP behaviour of the OIDC authorization-code browser flow.
 *
 * The protocol edge is injected, so nothing here reaches a provider, a socket,
 * or a database: `src/auth/oidcAuthorizationClient.test.ts` covers the real
 * library against a synthetic authorization server, and this file covers what
 * the server does with it — routing, cookies, redirects, refusals, the audit
 * write, and what is allowed to appear in a response.
 *
 * Every value is synthetic. `CLIENT_SECRET` is a fixed string invented here to
 * be searched for in output; it is not a credential.
 */

const CLIENT_ID = 'synthetic-client-id.apps.example.test'
const CLIENT_SECRET = 'synthetic-client-secret-not-a-credential'
const TOKEN_COOKIE = 'kaudit_id_token'
const REDIRECT_URI = `https://audit.example.test${OIDC_CALLBACK_ROUTE}`
const AUTHORIZATION_ENDPOINT = 'https://identity.example.test/o/oauth2/v2/auth'

const STATE = 'synthetic-state-value-000000000000000000000'
const NONCE = 'synthetic-nonce-value-000000000000000000000'
const VERIFIER = 'synthetic-verifier-value-00000000000000000'
const ID_TOKEN = 'synthetic.header.payload'

function oidcConfig(browserFlow: boolean): RuntimeConfig {
  return {
    environment: 'test',
    host: '127.0.0.1',
    port: 4175,
    trustProxy: false,
    database: {
      host: 'synthetic',
      port: 3306,
      name: 'synthetic',
      user: 'synthetic',
      password: 'synthetic',
      tlsMode: 'required',
      sslCaFile: null,
      sslCaInline: false,
    },
    auth: {
      mode: 'oidc',
      issuer: 'https://identity.example.test',
      audience: CLIENT_ID,
      jwksUri: 'https://identity.example.test/jwks',
      loginUrl: browserFlow ? null : 'https://identity.example.test/start',
      logoutUrl: null,
      tokenCookie: TOKEN_COOKIE,
      algorithms: ['ES256'],
      maxTokenAgeSeconds: 3600,
      browserFlow: browserFlow
        ? {
            clientId: CLIENT_ID,
            redirectUri: REDIRECT_URI,
            secretConfigured: true,
          }
        : null,
    },
    releaseGates: {
      automatedValidationApproved: false,
      calibrationComplete: false,
      reportingApproved: false,
    },
  }
}

interface SyntheticClient extends OidcAuthorizationClient {
  exchanges: OidcCallbackExchange[]
  starts: number
}

interface ClientBehaviour {
  /** Rejects `beginAuthorization` as an unreachable provider would. */
  startFails?: boolean
  /** Rejects `exchange`; the value is the bounded code the edge would throw. */
  exchangeFailure?: OidcBrowserFlowError
  /** Seconds from now for the returned ID token's `exp`. */
  lifetimeSeconds?: number
}

/**
 * The real envelope, keyed the way the production client keys it.
 *
 * Only the provider round trip is synthetic here: sealing and opening are the
 * shipping implementation, so the tamper and forgery cases below exercise what
 * a deployment actually runs rather than a test double's idea of it.
 */
const transactionSeal = createOidcTransactionSeal(CLIENT_SECRET)

function syntheticClient(behaviour: ClientBehaviour = {}): SyntheticClient {
  const client: SyntheticClient = {
    exchanges: [],
    starts: 0,
    async beginAuthorization() {
      client.starts += 1
      if (behaviour.startFails) {
        throw new OidcBrowserFlowError('OIDC_LOGIN_START_FAILED')
      }
      const authorizationUrl = new URL(AUTHORIZATION_ENDPOINT)
      authorizationUrl.searchParams.set('client_id', CLIENT_ID)
      authorizationUrl.searchParams.set('state', STATE)
      authorizationUrl.searchParams.set('nonce', NONCE)
      authorizationUrl.searchParams.set('code_challenge_method', 'S256')
      const transaction = { state: STATE, nonce: NONCE, codeVerifier: VERIFIER }
      return {
        authorizationUrl,
        transaction,
        transactionCookie: transactionSeal.seal(transaction),
      }
    },
    openTransaction(cookieValue) {
      return transactionSeal.open(cookieValue)
    },
    async exchange(input) {
      client.exchanges.push(input)
      if (behaviour.exchangeFailure) throw behaviour.exchangeFailure
      return {
        idToken: ID_TOKEN,
        expiresAtSeconds:
          Math.floor(Date.now() / 1000) + (behaviour.lifetimeSeconds ?? 3600),
      }
    },
  }
  return client
}

const emptyAccess: AccessRepository = {
  async findByOidc() {
    return null
  },
  async findByEmail() {
    return null
  },
  async readiness() {
    return true
  },
}

const acceptingVerifier: TokenVerifier = {
  async verify(token) {
    if (token !== ID_TOKEN) throw new Error('unexpected token')
    return {
      issuer: 'https://identity.example.test',
      subject: 'synthetic-subject-1',
      email: 'synthetic.operator@example.test',
    }
  },
}

interface Harness {
  baseUrl: string
  client: SyntheticClient
  events: AuditEvent[]
}

async function withFlowServer(
  run: (harness: Harness) => Promise<void>,
  options: {
    config?: RuntimeConfig
    client?: SyntheticClient | null
    access?: AccessRepository
    verifier?: TokenVerifier
    /**
     * Runs inside the audit sink's `record`, after the event is captured and
     * before it resolves. Throwing here is an unavailable audit store; a slow
     * resolution here is what proves the response waits for the write.
     */
    onAudit?: (event: AuditEvent) => Promise<void>
  } = {},
): Promise<void> {
  const events: AuditEvent[] = []
  const audit: AuditSink = {
    async record(event) {
      events.push(event)
      if (options.onAudit) await options.onAudit(event)
    },
    async readiness() {
      return true
    },
  }
  const client =
    options.client === undefined ? syntheticClient() : options.client
  const server = createEnterpriseDashboardServer({
    config: options.config ?? oidcConfig(true),
    pool: {
      async query() {
        return [[{ one: 1 }], []]
      },
    } as unknown as Pool,
    access: options.access ?? emptyAccess,
    audit,
    verifier: options.verifier ?? acceptingVerifier,
    oidcAuthorizationClient: client ?? undefined,
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as AddressInfo
  try {
    await run({
      baseUrl: `http://127.0.0.1:${address.port}`,
      client: client ?? syntheticClient(),
      events,
    })
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    )
  }
}

/** Every `Set-Cookie` on a response, in order. */
function setCookies(response: Response): string[] {
  return response.headers.getSetCookie()
}

function cookieNamed(response: Response, name: string): string | undefined {
  return setCookies(response).find((header) => header.startsWith(`${name}=`))
}

/** Starts a sign-in and returns the transaction cookie to send back. */
async function startLogin(baseUrl: string): Promise<string> {
  const response = await fetch(`${baseUrl}${OIDC_LOGIN_ROUTE}`, {
    redirect: 'manual',
  })
  assert.equal(response.status, 302)
  const header = cookieNamed(response, OIDC_TRANSACTION_COOKIE)
  assert.ok(header, 'login must set the transaction cookie')
  return header.slice(0, header.indexOf(';'))
}

// ---------------------------------------------------------------------------
// Success
// ---------------------------------------------------------------------------

test('login redirects to the provider and parks the transaction in one cookie', async () => {
  await withFlowServer(async ({ baseUrl, client }) => {
    const response = await fetch(`${baseUrl}${OIDC_LOGIN_ROUTE}`, {
      redirect: 'manual',
    })
    assert.equal(response.status, 302)
    assert.equal(client.starts, 1)
    assert.equal(
      response.headers.get('location')?.startsWith(AUTHORIZATION_ENDPOINT),
      true,
    )

    const cookies = setCookies(response)
    assert.equal(cookies.length, 1)
    const transaction = cookies[0] as string
    assert.match(transaction, /^kaudit_oidc_tx=/)
    assert.match(transaction, /; Secure(;|$)/)
    assert.match(transaction, /; HttpOnly(;|$)/)
    assert.match(transaction, /; SameSite=Lax(;|$)/)
    assert.match(transaction, /; Path=\/api\/v1\/auth\/oidc;/)
    assert.match(transaction, /; Max-Age=600;/)

    // No identity cookie is set before an identity exists.
    assert.equal(cookieNamed(response, TOKEN_COOKIE), undefined)
    // The transaction cookie is opaque: neither the state nor the verifier is
    // readable from it as a bare value, and no secret rides along.
    assert.equal(transaction.includes(CLIENT_SECRET), false)
    assert.equal(transaction.includes(VERIFIER), false)
    assert.equal(response.headers.get('cache-control'), 'no-store, max-age=0')
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer')
  })
})

test('a valid callback sets only the configured token cookie and redirects to a fixed path', async () => {
  await withFlowServer(async ({ baseUrl, client, events }) => {
    const transaction = await startLogin(baseUrl)
    const response = await fetch(
      `${baseUrl}${OIDC_CALLBACK_ROUTE}?code=synthetic-code&state=${STATE}`,
      { redirect: 'manual', headers: { cookie: transaction } },
    )

    assert.equal(response.status, 302)
    assert.equal(response.headers.get('location'), '/overview')

    const cookies = setCookies(response)
    assert.equal(cookies.length, 2)
    // The transaction is consumed on the way out.
    const cleared = cookieNamed(response, OIDC_TRANSACTION_COOKIE) as string
    assert.match(cleared, /^kaudit_oidc_tx=; Path=\/api\/v1\/auth\/oidc; Max-Age=0;/)
    // Exactly one identity cookie, and it is the configured name.
    const identity = cookieNamed(response, TOKEN_COOKIE) as string
    assert.equal(identity.startsWith(`${TOKEN_COOKIE}=${ID_TOKEN};`), true)
    assert.match(identity, /; Path=\/;/)
    assert.match(identity, /; Secure(;|$)/)
    assert.match(identity, /; HttpOnly(;|$)/)
    assert.match(identity, /; SameSite=Lax(;|$)/)
    // Bounded by the policy ceiling, never open-ended.
    const maxAge = Number(/; Max-Age=(\d+);/.exec(identity)?.[1])
    assert.ok(maxAge > 0 && maxAge <= 3600)
    assert.equal(/Expires=/.test(identity), false)

    // The exchange was bound to the configured redirect URI, not to the Host
    // header this request actually carried.
    const [exchange] = client.exchanges
    assert.equal(client.exchanges.length, 1)
    assert.equal(exchange?.callbackUrl.origin, 'https://audit.example.test')
    assert.equal(exchange?.callbackUrl.pathname, OIDC_CALLBACK_ROUTE)
    assert.equal(exchange?.expectedState, STATE)
    assert.equal(exchange?.expectedNonce, NONCE)
    assert.equal(exchange?.codeVerifier, VERIFIER)

    // Audited with no actor and no claim.
    const audited = events.filter(
      (event) => event.action === 'auth.oidc_callback',
    )
    assert.equal(audited.length, 1)
    assert.equal(audited[0]?.outcome, 'success')
    assert.equal(audited[0]?.actorUserId, null)
    assert.equal(audited[0]?.actorEmail, null)
  })
})

test('an ID token already at its expiry produces no cookie', async () => {
  await withFlowServer(
    async ({ baseUrl }) => {
      const transaction = await startLogin(baseUrl)
      const response = await fetch(
        `${baseUrl}${OIDC_CALLBACK_ROUTE}?code=synthetic-code&state=${STATE}`,
        { redirect: 'manual', headers: { cookie: transaction } },
      )
      assert.equal(response.status, 401)
      const body = (await response.json()) as { code: string }
      assert.equal(body.code, 'OIDC_IDENTITY_UNVERIFIED')
      assert.equal(cookieNamed(response, TOKEN_COOKIE), undefined)
    },
    { client: syntheticClient({ lifetimeSeconds: -1 }) },
  )
})

// ---------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------

test('a callback with no state, a wrong state, or no transaction is refused before any exchange', async () => {
  const cases: Array<{
    name: string
    query: string
    sendCookie: boolean
    code: string
  }> = [
    {
      name: 'missing state',
      query: '?code=synthetic-code',
      sendCookie: true,
      code: 'OIDC_STATE_MISMATCH',
    },
    {
      name: 'wrong state',
      query: '?code=synthetic-code&state=synthetic-attacker-state-00000000000',
      sendCookie: true,
      code: 'OIDC_STATE_MISMATCH',
    },
    {
      name: 'no transaction cookie',
      query: `?code=synthetic-code&state=${STATE}`,
      sendCookie: false,
      code: 'OIDC_TRANSACTION_MISSING',
    },
  ]
  for (const scenario of cases) {
    await withFlowServer(async ({ baseUrl, client, events }) => {
      const transaction = await startLogin(baseUrl)
      const response = await fetch(
        `${baseUrl}${OIDC_CALLBACK_ROUTE}${scenario.query}`,
        {
          redirect: 'manual',
          headers: scenario.sendCookie ? { cookie: transaction } : {},
        },
      )
      assert.equal(response.status, 400, scenario.name)
      const body = (await response.json()) as { code: string; title: string }
      assert.equal(body.code, scenario.code, scenario.name)
      assert.equal(client.exchanges.length, 0, scenario.name)
      assert.equal(cookieNamed(response, TOKEN_COOKIE), undefined)
      // The dead transaction is cleared even while refusing.
      assert.match(
        cookieNamed(response, OIDC_TRANSACTION_COOKIE) as string,
        /Max-Age=0/,
      )
      assert.equal(
        events.filter((event) => event.action === 'auth.oidc_callback')[0]
          ?.outcome,
        'denied',
        scenario.name,
      )
    })
  }
})

test('a provider refusal never reflects the provider error or its description', async () => {
  await withFlowServer(async ({ baseUrl, client }) => {
    const transaction = await startLogin(baseUrl)
    const response = await fetch(
      `${baseUrl}${OIDC_CALLBACK_ROUTE}?error=access_denied` +
        `&error_description=${encodeURIComponent('user "operator" declined <b>consent</b>')}` +
        `&error_uri=${encodeURIComponent('https://attacker.example.invalid/x')}` +
        `&state=${STATE}`,
      { redirect: 'manual', headers: { cookie: transaction } },
    )
    assert.equal(response.status, 401)
    const text = await response.text()
    const body = JSON.parse(text) as { code: string; title: string }
    assert.equal(body.code, 'OIDC_PROVIDER_REFUSED')
    assert.equal(body.title, 'Identity provider refused the sign-in')
    for (const forbidden of [
      'access_denied',
      'declined',
      'operator',
      '<b>',
      'attacker.example.invalid',
    ]) {
      assert.equal(
        text.includes(forbidden),
        false,
        `the refusal must not carry ${forbidden}`,
      )
    }
    // Refused before the code path that would contact a provider.
    assert.equal(client.exchanges.length, 0)
  })
})

test('an exchange failure is bounded and carries nothing from the provider', async () => {
  await withFlowServer(
    async ({ baseUrl }) => {
      const transaction = await startLogin(baseUrl)
      const response = await fetch(
        `${baseUrl}${OIDC_CALLBACK_ROUTE}?code=synthetic-code&state=${STATE}`,
        { redirect: 'manual', headers: { cookie: transaction } },
      )
      assert.equal(response.status, 502)
      const text = await response.text()
      assert.equal(
        (JSON.parse(text) as { code: string }).code,
        'OIDC_EXCHANGE_FAILED',
      )
      assert.deepEqual(Object.keys(JSON.parse(text) as object).sort(), [
        'code',
        'correlationId',
        'status',
        'title',
        'type',
      ])
      assert.equal(cookieNamed(response, TOKEN_COOKIE), undefined)
    },
    {
      client: syntheticClient({
        exchangeFailure: new OidcBrowserFlowError('OIDC_EXCHANGE_FAILED'),
      }),
    },
  )
})

test('a replayed callback finds a consumed transaction', async () => {
  await withFlowServer(async ({ baseUrl, client }) => {
    const transaction = await startLogin(baseUrl)
    const url = `${baseUrl}${OIDC_CALLBACK_ROUTE}?code=synthetic-code&state=${STATE}`
    const first = await fetch(url, {
      redirect: 'manual',
      headers: { cookie: transaction },
    })
    assert.equal(first.status, 302)

    // The browser obeyed the clearing cookie, so the replay arrives with none.
    const replay = await fetch(url, { redirect: 'manual' })
    assert.equal(replay.status, 400)
    assert.equal(
      ((await replay.json()) as { code: string }).code,
      'OIDC_TRANSACTION_MISSING',
    )
    assert.equal(cookieNamed(replay, TOKEN_COOKIE), undefined)
    assert.equal(client.exchanges.length, 1)
  })
})

test('a provider that cannot be reached fails the login start, bounded', async () => {
  await withFlowServer(
    async ({ baseUrl }) => {
      const response = await fetch(`${baseUrl}${OIDC_LOGIN_ROUTE}`, {
        redirect: 'manual',
      })
      assert.equal(response.status, 502)
      assert.equal(
        ((await response.json()) as { code: string }).code,
        'OIDC_LOGIN_START_FAILED',
      )
      assert.equal(response.headers.get('location'), null)
    },
    { client: syntheticClient({ startFails: true }) },
  )
})

test('the flow routes accept GET only', async () => {
  await withFlowServer(async ({ baseUrl }) => {
    for (const route of [OIDC_LOGIN_ROUTE, OIDC_CALLBACK_ROUTE]) {
      const response = await fetch(`${baseUrl}${route}`, {
        method: 'POST',
        redirect: 'manual',
      })
      assert.equal(response.status, 405)
    }
  })
})

// ---------------------------------------------------------------------------
// The transaction cookie is authenticated, not merely well-formed
// ---------------------------------------------------------------------------

/** The cookie header for a transaction sealed with the given issuance time. */
function sealedCookie(
  transaction: { state: string; nonce: string; codeVerifier: string },
  issuedAtSeconds?: number,
): string {
  return `${OIDC_TRANSACTION_COOKIE}=${transactionSeal.seal(transaction, issuedAtSeconds)}`
}

test('a one-byte change to the transaction cookie is refused before any exchange', async () => {
  await withFlowServer(async ({ baseUrl, client, events }) => {
    const transaction = await startLogin(baseUrl)
    // Every position in the sealed value, one at a time. Whichever byte moves —
    // version label, payload, or authenticator — the callback refuses.
    const value = transaction.slice(`${OIDC_TRANSACTION_COOKIE}=`.length)
    for (const index of [0, 4, Math.floor(value.length / 2), value.length - 1]) {
      const original = value[index] as string
      const mutated =
        value.slice(0, index) +
        (original === 'A' ? 'B' : 'A') +
        value.slice(index + 1)
      const response = await fetch(
        `${baseUrl}${OIDC_CALLBACK_ROUTE}?code=synthetic-code&state=${STATE}`,
        {
          redirect: 'manual',
          headers: { cookie: `${OIDC_TRANSACTION_COOKIE}=${mutated}` },
        },
      )
      assert.equal(response.status, 400, `byte ${index}`)
      assert.equal(
        ((await response.json()) as { code: string }).code,
        'OIDC_TRANSACTION_MISSING',
        `byte ${index}`,
      )
      assert.equal(cookieNamed(response, TOKEN_COOKIE), undefined)
      assert.match(
        cookieNamed(response, OIDC_TRANSACTION_COOKIE) as string,
        /Max-Age=0/,
      )
    }
    // Not one code was presented to the exchange.
    assert.equal(client.exchanges.length, 0)
    assert.equal(
      events
        .filter((event) => event.action === 'auth.oidc_callback')
        .every((event) => event.outcome === 'denied'),
      true,
    )
  })
})

test('a field-level edit inside the transaction envelope is refused before any exchange', async () => {
  await withFlowServer(async ({ baseUrl, client }) => {
    const transaction = await startLogin(baseUrl)
    const value = transaction.slice(`${OIDC_TRANSACTION_COOKIE}=`.length)
    const [version, payload, mac] = value.split('.') as [string, string, string]
    const decoded = JSON.parse(
      Buffer.from(payload, 'base64url').toString('utf8'),
    ) as Record<string, unknown>
    // The attack the envelope exists to stop: substitute a state and verifier
    // the attacker chose, keeping the JSON well-formed and the grammar valid.
    const swapped = Buffer.from(
      JSON.stringify({
        ...decoded,
        s: 'synthetic-attacker-state-000000000000000',
        v: 'synthetic-attacker-verifier-00000000000',
      }),
      'utf8',
    ).toString('base64url')
    const response = await fetch(
      `${baseUrl}${OIDC_CALLBACK_ROUTE}?code=synthetic-code` +
        `&state=synthetic-attacker-state-000000000000000`,
      {
        redirect: 'manual',
        headers: {
          cookie: `${OIDC_TRANSACTION_COOKIE}=${version}.${swapped}.${mac}`,
        },
      },
    )
    assert.equal(response.status, 400)
    assert.equal(
      ((await response.json()) as { code: string }).code,
      'OIDC_TRANSACTION_MISSING',
    )
    assert.equal(client.exchanges.length, 0)
    assert.equal(cookieNamed(response, TOKEN_COOKIE), undefined)
  })
})

test('an attacker-created envelope with no valid authenticator is refused', async () => {
  await withFlowServer(async ({ baseUrl, client }) => {
    // The parent-domain injection case: a sibling host writes a structurally
    // perfect `kaudit_oidc_tx` for a transaction it controls end to end, and
    // returns a state that matches it exactly. Without this deployment's key
    // the envelope is not openable, so the code is never exchanged.
    const attacker = createOidcTransactionSeal(
      'synthetic-attacker-key-not-a-credential',
    )
    const state = 'synthetic-attacker-state-000000000000000'
    const forged = attacker.seal({
      state,
      nonce: 'synthetic-attacker-nonce-000000000000000',
      codeVerifier: 'synthetic-attacker-verifier-00000000000',
    })
    for (const cookie of [
      `${OIDC_TRANSACTION_COOKIE}=${forged}`,
      // And the format the rejected implementation would have accepted: bare
      // base64url JSON with no authenticator at all.
      `${OIDC_TRANSACTION_COOKIE}=${Buffer.from(
        JSON.stringify({ s: state, n: state, v: state }),
        'utf8',
      ).toString('base64url')}`,
    ]) {
      const response = await fetch(
        `${baseUrl}${OIDC_CALLBACK_ROUTE}?code=synthetic-code&state=${state}`,
        { redirect: 'manual', headers: { cookie } },
      )
      assert.equal(response.status, 400)
      assert.equal(
        ((await response.json()) as { code: string }).code,
        'OIDC_TRANSACTION_MISSING',
      )
      assert.equal(cookieNamed(response, TOKEN_COOKIE), undefined)
    }
    assert.equal(client.exchanges.length, 0)
  })
})

test('an expired transaction is refused server-side, not left to the browser', async () => {
  await withFlowServer(async ({ baseUrl, client }) => {
    const now = Math.floor(Date.now() / 1000)
    const transaction = { state: STATE, nonce: NONCE, codeVerifier: VERIFIER }
    // A browser that ignored `Max-Age` — or anything replaying the cookie that
    // is not a browser — still presents an intact, correctly sealed value.
    const stale = sealedCookie(
      transaction,
      now - OIDC_TRANSACTION_TTL_SECONDS - 1,
    )
    const response = await fetch(
      `${baseUrl}${OIDC_CALLBACK_ROUTE}?code=synthetic-code&state=${STATE}`,
      { redirect: 'manual', headers: { cookie: stale } },
    )
    assert.equal(response.status, 400)
    assert.equal(
      ((await response.json()) as { code: string }).code,
      'OIDC_TRANSACTION_MISSING',
    )
    assert.equal(client.exchanges.length, 0)
    assert.equal(cookieNamed(response, TOKEN_COOKIE), undefined)

    // The same transaction inside its window still completes, so the refusal
    // above is the expiry and not a broken envelope.
    const fresh = await fetch(
      `${baseUrl}${OIDC_CALLBACK_ROUTE}?code=synthetic-code&state=${STATE}`,
      { redirect: 'manual', headers: { cookie: sealedCookie(transaction, now) } },
    )
    assert.equal(fresh.status, 302)
    assert.equal(client.exchanges.length, 1)
  })
})

// ---------------------------------------------------------------------------
// The access audit is a precondition of the session, not a footnote to it
// ---------------------------------------------------------------------------

test('a successful callback whose audit cannot be recorded issues nothing', async () => {
  await withFlowServer(
    async ({ baseUrl, client, events }) => {
      const transaction = await startLogin(baseUrl)
      const response = await fetch(
        `${baseUrl}${OIDC_CALLBACK_ROUTE}?code=synthetic-code&state=${STATE}`,
        { redirect: 'manual', headers: { cookie: transaction } },
      )
      // The exchange did happen and the ID token did validate...
      assert.equal(client.exchanges.length, 1)
      assert.equal(
        events.filter((event) => event.action === 'auth.oidc_callback').length,
        1,
      )
      // ...and none of it became a session.
      assert.equal(response.status, 502)
      assert.equal(response.headers.get('location'), null)
      assert.equal(cookieNamed(response, TOKEN_COOKIE), undefined)
      const text = await response.text()
      const body = JSON.parse(text) as { code: string; title: string }
      assert.equal(body.code, 'OIDC_ACCESS_NOT_RECORDED')
      assert.equal(body.title, 'Sign-in could not be recorded')
      // Bounded: the same fixed problem shape as every other refusal, with
      // nothing from the sink's own failure in it.
      assert.deepEqual(Object.keys(JSON.parse(text) as object).sort(), [
        'code',
        'correlationId',
        'status',
        'title',
        'type',
      ])
      for (const forbidden of [
        'synthetic audit outage',
        ID_TOKEN,
        'synthetic-code',
        CLIENT_SECRET,
      ]) {
        assert.equal(text.includes(forbidden), false, forbidden)
      }
      // The dead transaction is consumed, so the code cannot be re-presented.
      assert.match(
        cookieNamed(response, OIDC_TRANSACTION_COOKIE) as string,
        /Max-Age=0/,
      )
    },
    {
      onAudit: async () => {
        // Deliberately loaded with something that must never resurface.
        throw new Error(`synthetic audit outage for ${ID_TOKEN}`)
      },
    },
  )
})

test('the success response is not committed until the audit write has completed', async () => {
  let release: (() => void) | null = null
  const recorded = new Promise<void>((resolve) => {
    release = resolve
  })
  await withFlowServer(
    async ({ baseUrl, events }) => {
      const transaction = await startLogin(baseUrl)
      const pending = fetch(
        `${baseUrl}${OIDC_CALLBACK_ROUTE}?code=synthetic-code&state=${STATE}`,
        { redirect: 'manual', headers: { cookie: transaction } },
      )
      // While the audit write is in flight the browser has nothing: no status,
      // no redirect, and above all no identity cookie.
      const raced = await Promise.race([
        pending.then(() => 'responded'),
        new Promise<string>((resolve) =>
          setTimeout(() => resolve('still waiting'), 150),
        ),
      ])
      assert.equal(raced, 'still waiting')
      assert.equal(
        events.filter((event) => event.action === 'auth.oidc_callback').length,
        1,
        'the audit write is the thing being waited on',
      )

      ;(release as () => void)()
      const response = await pending
      assert.equal(response.status, 302)
      assert.equal(response.headers.get('location'), '/overview')
      assert.ok(cookieNamed(response, TOKEN_COOKIE))
    },
    { onAudit: async () => recorded },
  )
})

test('a refusal whose audit also fails stays the same bounded refusal', async () => {
  await withFlowServer(
    async ({ baseUrl }) => {
      // An unavailable audit store cannot turn a denial into a success, and
      // cannot turn it into an unbounded failure either.
      const response = await fetch(
        `${baseUrl}${OIDC_CALLBACK_ROUTE}?code=synthetic-code&state=wrong`,
        { redirect: 'manual' },
      )
      assert.equal(response.status, 400)
      const text = await response.text()
      assert.equal(
        (JSON.parse(text) as { code: string }).code,
        'OIDC_TRANSACTION_MISSING',
      )
      assert.equal(text.includes('synthetic audit outage'), false)
      assert.equal(cookieNamed(response, TOKEN_COOKIE), undefined)
    },
    {
      onAudit: async () => {
        throw new Error('synthetic audit outage')
      },
    },
  )
})

test('an exchange failure is audited as a failure, a refused caller as denied', async () => {
  // The same split the local password login makes: a 4xx the caller caused is
  // `denied`, a dependency that did not work is `failure`.
  await withFlowServer(
    async ({ baseUrl, events }) => {
      const transaction = await startLogin(baseUrl)
      await fetch(
        `${baseUrl}${OIDC_CALLBACK_ROUTE}?code=synthetic-code&state=${STATE}`,
        { redirect: 'manual', headers: { cookie: transaction } },
      )
      assert.equal(
        events.find((event) => event.action === 'auth.oidc_callback')?.outcome,
        'failure',
      )
    },
    {
      client: syntheticClient({
        exchangeFailure: new OidcBrowserFlowError('OIDC_EXCHANGE_FAILED'),
      }),
    },
  )
  await withFlowServer(async ({ baseUrl, events }) => {
    await fetch(`${baseUrl}${OIDC_CALLBACK_ROUTE}?error=access_denied`, {
      redirect: 'manual',
    })
    assert.equal(
      events.find((event) => event.action === 'auth.oidc_callback')?.outcome,
      'denied',
    )
  })
})

// ---------------------------------------------------------------------------
// The flow is off unless it is on
// ---------------------------------------------------------------------------

test('a token-only deployment does not have these routes at all', async () => {
  await withFlowServer(
    async ({ baseUrl }) => {
      for (const route of [OIDC_LOGIN_ROUTE, OIDC_CALLBACK_ROUTE]) {
        const response = await fetch(`${baseUrl}${route}?code=x&state=y`, {
          redirect: 'manual',
        })
        assert.equal(response.status, 404)
        assert.equal(
          ((await response.json()) as { code: string }).code,
          'NOT_FOUND',
        )
      }
      // And it keeps advertising the identity provider's own entry point.
      const config = (await (
        await fetch(`${baseUrl}/api/v1/auth/config`)
      ).json()) as Record<string, unknown>
      assert.equal(config.loginUrl, 'https://identity.example.test/start')
    },
    { config: oidcConfig(false), client: null },
  )
})

test('a gated deployment with no client wired up also has no routes', async () => {
  // Configuration says yes, the dependency is absent: deny, do not half-enable.
  await withFlowServer(
    async ({ baseUrl }) => {
      const response = await fetch(`${baseUrl}${OIDC_LOGIN_ROUTE}`, {
        redirect: 'manual',
      })
      assert.equal(response.status, 404)
    },
    { config: oidcConfig(true), client: null },
  )
})

test('the public auth config advertises the local login route when the flow is on', async () => {
  await withFlowServer(async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/api/v1/auth/config`)
    const text = await response.text()
    const config = JSON.parse(text) as Record<string, unknown>
    assert.equal(config.loginUrl, OIDC_LOGIN_ROUTE)
    assert.equal(config.logoutUrl, '/login')
    assert.equal(config.accessControlEnforced, true)
    // The public document names no client, no secret, and no provider endpoint.
    for (const forbidden of [CLIENT_ID, CLIENT_SECRET, REDIRECT_URI]) {
      assert.equal(text.includes(forbidden), false)
    }
  })
})

// ---------------------------------------------------------------------------
// Sign-out and the unchanged authorization boundary
// ---------------------------------------------------------------------------

test('logout clears the identity cookie locally before redirecting', async () => {
  await withFlowServer(async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/logout`, { redirect: 'manual' })
    assert.equal(response.status, 302)
    assert.equal(response.headers.get('location'), '/login')
    const identity = cookieNamed(response, TOKEN_COOKIE) as string
    assert.match(identity, /^kaudit_id_token=; Path=\/; Max-Age=0;/)
    assert.match(identity, /; Secure(;|$)/)
    assert.match(identity, /; HttpOnly(;|$)/)
    assert.match(
      cookieNamed(response, OIDC_TRANSACTION_COOKIE) as string,
      /Max-Age=0/,
    )
  })
})

test('a token-only deployment also clears its configured token cookie on logout', async () => {
  const config = oidcConfig(false)
  if (config.auth.mode !== 'oidc') throw new Error('synthetic config')
  config.auth.logoutUrl = 'https://identity.example.test/logout'
  await withFlowServer(
    async ({ baseUrl }) => {
      const response = await fetch(`${baseUrl}/logout`, { redirect: 'manual' })
      assert.equal(response.status, 302)
      assert.equal(
        response.headers.get('location'),
        'https://identity.example.test/logout',
      )
      // Cleared here rather than trusting the provider round trip to come back.
      assert.match(
        cookieNamed(response, TOKEN_COOKIE) as string,
        /^kaudit_id_token=; Path=\/; Max-Age=0;/,
      )
      assert.equal(cookieNamed(response, OIDC_TRANSACTION_COOKIE), undefined)
    },
    { config, client: null },
  )
})

test('the cookie a successful callback sets still has to be a provisioned user', async () => {
  await withFlowServer(async ({ baseUrl }) => {
    const transaction = await startLogin(baseUrl)
    const callback = await fetch(
      `${baseUrl}${OIDC_CALLBACK_ROUTE}?code=synthetic-code&state=${STATE}`,
      { redirect: 'manual', headers: { cookie: transaction } },
    )
    const identity = cookieNamed(callback, TOKEN_COOKIE) as string
    const cookie = identity.slice(0, identity.indexOf(';'))

    // The access repository provisions nobody. Signing in is not authorization,
    // and the callback deliberately did not create, grant, or assume anything.
    const me = await fetch(`${baseUrl}/api/v1/me`, { headers: { cookie } })
    assert.equal(me.status, 403)
    assert.equal(
      ((await me.json()) as { code: string }).code,
      'USER_NOT_PROVISIONED',
    )
  })
})

test('a provisioned user reaches the dashboard with the cookie the callback set', async () => {
  await withFlowServer(
    async ({ baseUrl }) => {
      const transaction = await startLogin(baseUrl)
      const callback = await fetch(
        `${baseUrl}${OIDC_CALLBACK_ROUTE}?code=synthetic-code&state=${STATE}`,
        { redirect: 'manual', headers: { cookie: transaction } },
      )
      const identity = cookieNamed(callback, TOKEN_COOKIE) as string
      const me = await fetch(`${baseUrl}/api/v1/me`, {
        headers: { cookie: identity.slice(0, identity.indexOf(';')) },
      })
      assert.equal(me.status, 200)
      const profile = (await me.json()) as Record<string, unknown>
      assert.equal(profile.authMode, 'oidc')
      assert.equal(profile.accessControlEnforced, true)
    },
    {
      access: {
        ...emptyAccess,
        async findByOidc(issuer, subject) {
          return issuer === 'https://identity.example.test' &&
            subject === 'synthetic-subject-1'
            ? {
                id: 'user-1',
                email: 'synthetic.operator@example.test',
                status: 'active',
                maxSensitivityTier: 'K1',
                roles: ['user'],
              }
            : null
        },
      },
    },
  )
})

test('a disabled account is still refused after a successful sign-in', async () => {
  await withFlowServer(
    async ({ baseUrl }) => {
      const transaction = await startLogin(baseUrl)
      const callback = await fetch(
        `${baseUrl}${OIDC_CALLBACK_ROUTE}?code=synthetic-code&state=${STATE}`,
        { redirect: 'manual', headers: { cookie: transaction } },
      )
      const identity = cookieNamed(callback, TOKEN_COOKIE) as string
      const me = await fetch(`${baseUrl}/api/v1/me`, {
        headers: { cookie: identity.slice(0, identity.indexOf(';')) },
      })
      assert.equal(me.status, 403)
      assert.equal(
        ((await me.json()) as { code: string }).code,
        'USER_DISABLED',
      )
    },
    {
      access: {
        ...emptyAccess,
        async findByOidc() {
          return {
            id: 'user-2',
            email: 'synthetic.disabled@example.test',
            status: 'disabled',
            maxSensitivityTier: 'K0',
            roles: ['user'],
          }
        },
      },
    },
  )
})

// ---------------------------------------------------------------------------
// Nothing sensitive leaves the server
// ---------------------------------------------------------------------------

/** Body, headers and cookies of a response as one searchable string. */
async function rendered(response: Response): Promise<string> {
  return [
    await response.text(),
    // Headers included: a redirect says everything in its Location.
    [...response.headers.entries()]
      .map(([name, value]) => `${name}: ${value}`)
      .join('\n'),
  ].join('\n')
}

test('no response on any flow path carries the secret, the verifier, or a code', async () => {
  await withFlowServer(async ({ baseUrl }) => {
    const transaction = await startLogin(baseUrl)
    const responses = [
      await fetch(`${baseUrl}${OIDC_LOGIN_ROUTE}`, { redirect: 'manual' }),
      await fetch(
        `${baseUrl}${OIDC_CALLBACK_ROUTE}?code=synthetic-code&state=${STATE}`,
        { redirect: 'manual', headers: { cookie: transaction } },
      ),
      await fetch(`${baseUrl}${OIDC_CALLBACK_ROUTE}?code=leaked-code&state=bad`, {
        redirect: 'manual',
      }),
      await fetch(`${baseUrl}/api/v1/auth/config`),
      await fetch(`${baseUrl}/logout`, { redirect: 'manual' }),
    ]
    for (const response of responses) {
      const text = await rendered(response)
      for (const forbidden of [
        CLIENT_SECRET,
        // The PKCE verifier is the one transaction value that must never leave
        // the cookie and the back-channel token request.
        VERIFIER,
        'leaked-code',
        'synthetic-code',
      ]) {
        assert.equal(
          text.includes(forbidden),
          false,
          `${response.url} must not carry ${forbidden}`,
        )
      }
    }
  })
})

test('the process log carries a code and a correlation id, and nothing else', async () => {
  const captured: string[] = []
  const original = process.stderr.write.bind(process.stderr)
  // The flow logs to stderr synchronously and in-process, so this sees exactly
  // what a deployment's log collector would.
  process.stderr.write = ((chunk: string | Uint8Array) => {
    captured.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'))
    return true
  }) as typeof process.stderr.write
  try {
    await withFlowServer(async ({ baseUrl }) => {
      const transaction = await startLogin(baseUrl)
      const cookieValue = transaction.slice(
        `${OIDC_TRANSACTION_COOKIE}=`.length,
      )
      // Every path that logs: a start, a success, a forged envelope, a provider
      // refusal, and an exchange that fails.
      await fetch(
        `${baseUrl}${OIDC_CALLBACK_ROUTE}?code=synthetic-code&state=${STATE}`,
        { redirect: 'manual', headers: { cookie: transaction } },
      )
      await fetch(
        `${baseUrl}${OIDC_CALLBACK_ROUTE}?code=synthetic-code&state=${STATE}`,
        {
          redirect: 'manual',
          headers: { cookie: `${OIDC_TRANSACTION_COOKIE}=v1.forged.forged` },
        },
      )
      await fetch(
        `${baseUrl}${OIDC_CALLBACK_ROUTE}?error=access_denied&error_description=prose`,
        { redirect: 'manual' },
      )
      const log = captured.join('')
      assert.ok(log.length > 0, 'the flow does log')
      for (const forbidden of [
        CLIENT_SECRET,
        CLIENT_ID,
        // Transaction material, raw and sealed. The whole envelope is listed
        // because logging it would hand a log reader a usable transaction.
        STATE,
        NONCE,
        VERIFIER,
        cookieValue,
        ID_TOKEN,
        'synthetic-code',
        // Provider prose and the audit sink's own words.
        'access_denied',
        'prose',
      ]) {
        assert.equal(log.includes(forbidden), false, `the log must not carry ${forbidden}`)
      }
      // What it does carry: a fixed event name, a bounded code, a correlation
      // id, and a timestamp.
      for (const line of log.split('\n').filter(Boolean)) {
        assert.deepEqual(Object.keys(JSON.parse(line) as object).sort(), [
          'code',
          'correlationId',
          'event',
          'level',
          'occurredAt',
        ])
        assert.match(
          (JSON.parse(line) as { code: string }).code,
          /^OIDC_[A-Z_]+$/,
        )
      }
    })
  } finally {
    process.stderr.write = original
  }
})

test('state and nonce travel in the authorization request and nowhere back', async () => {
  await withFlowServer(async ({ baseUrl }) => {
    // Both are authorization-request parameters, so the outbound redirect is
    // required to carry them. What matters is that neither comes back out of a
    // callback response, where they would only serve to confirm a guess.
    const login = await fetch(`${baseUrl}${OIDC_LOGIN_ROUTE}`, {
      redirect: 'manual',
    })
    const location = new URL(login.headers.get('location') as string)
    assert.equal(location.searchParams.get('state'), STATE)
    assert.equal(location.searchParams.get('nonce'), NONCE)

    const transaction = await startLogin(baseUrl)
    for (const response of [
      await fetch(
        `${baseUrl}${OIDC_CALLBACK_ROUTE}?code=synthetic-code&state=${STATE}`,
        { redirect: 'manual', headers: { cookie: transaction } },
      ),
      await fetch(`${baseUrl}${OIDC_CALLBACK_ROUTE}?state=guessed-state`, {
        redirect: 'manual',
      }),
    ]) {
      const text = await rendered(response)
      assert.equal(text.includes(NONCE), false)
      assert.equal(text.includes(STATE), false)
      assert.equal(text.includes('guessed-state'), false)
    }
  })
})
