import { timingSafeEqual } from 'node:crypto'

/**
 * The transport half of the OIDC authorization-code browser flow.
 *
 * Everything here is pure and keyless: routes, cookie construction, the
 * transaction value grammar, and the redirect binding. No protocol validation
 * happens in this file and no provider is contacted from it — the authorization
 * request, the code exchange, and every signature/issuer/audience/nonce check
 * belong to `oidcAuthorizationClient.ts`, which is the only place a maintained
 * OIDC library and the client secret exist.
 *
 * The transaction cookie's *contents* are likewise not built here. Sealing and
 * opening the authenticated envelope needs key material, so it lives in
 * `oidcTransactionSeal.ts` behind the authorization client; this module only
 * wraps whatever opaque string that produces in the cookie's attributes.
 *
 * The split is deliberate. `config/runtime.ts` needs the callback route to
 * validate `KAUDIT_OIDC_REDIRECT_URI`, and configuration loading must not drag
 * a network-capable client into every CLI that reads it.
 *
 * ## Output discipline
 *
 * Nothing in this module accepts, stores, or returns a code, a token, a
 * provider message, or an identity claim in a reportable position. A failure is
 * one of the fixed {@link OIDC_BROWSER_FLOW_FAILURES} entries: a stable code and
 * a fixed title, with no interpolation point.
 */

/** Public GET that starts the flow. Same-origin; no body, no parameters. */
export const OIDC_LOGIN_ROUTE = '/api/v1/auth/oidc/login'

/** Public GET the provider redirects back to. Must equal the redirect URI path. */
export const OIDC_CALLBACK_ROUTE = '/api/v1/auth/oidc/callback'

/**
 * Cookie path shared by both routes, and the narrowest prefix that covers them.
 *
 * Path matching is per segment, so this is sent to `/api/v1/auth/oidc/login`
 * and `/api/v1/auth/oidc/callback` and to nothing else in the application — the
 * transaction material never rides along with a dashboard read.
 */
export const OIDC_TRANSACTION_COOKIE_PATH = '/api/v1/auth/oidc'

export const OIDC_TRANSACTION_COOKIE = 'kaudit_oidc_tx'

/**
 * How long a started login may stay resumable. Long enough for a real consent
 * screen, short enough that an abandoned transaction is not sitting in a
 * browser for the rest of the day.
 */
export const OIDC_TRANSACTION_TTL_SECONDS = 600

/**
 * The one place a successful callback may send the browser.
 *
 * A fixed same-origin path, not a parameter. A `returnTo`/`next` parameter is
 * the standard way this endpoint becomes an open redirect, and the dashboard
 * router restores the intended page on its own.
 */
export const OIDC_LOGIN_SUCCESS_PATH = '/overview'

/**
 * Requested scopes, fixed.
 *
 * Identity only. No `access_type=offline`, no `prompt=consent`, no Google API
 * scope: the flow proves who the caller is and stops there, so there is no
 * refresh token to store and no provider data this application can reach.
 */
export const OIDC_SCOPE = 'openid email profile'

/** A bound on the callback query, so nothing pathological is ever parsed. */
const MAX_CALLBACK_QUERY_LENGTH = 4096

/**
 * Random material generated per transaction. base64url, as every maintained
 * generator emits — the bound rejects a truncated or crafted value before it
 * reaches the exchange, underneath the envelope's authenticator.
 */
const TRANSACTION_VALUE = /^[A-Za-z0-9_-]{32,128}$/

export interface OidcTransaction {
  /** CSRF binding between the authorization request and this browser. */
  state: string
  /** Replay binding between the authorization request and the ID token. */
  nonce: string
  /** RFC 7636 PKCE verifier. Never leaves the cookie or the token request. */
  codeVerifier: string
}

export type OidcBrowserFlowFailureCode =
  | 'OIDC_BROWSER_LOGIN_UNAVAILABLE'
  | 'OIDC_LOGIN_START_FAILED'
  | 'OIDC_TRANSACTION_MISSING'
  | 'OIDC_STATE_MISMATCH'
  | 'OIDC_PROVIDER_REFUSED'
  | 'OIDC_EXCHANGE_FAILED'
  | 'OIDC_IDENTITY_UNVERIFIED'
  | 'OIDC_ACCESS_NOT_RECORDED'

/**
 * Every failure this flow can express, and the entire text any of them produce.
 *
 * A caller learns which stage refused and nothing else. In particular the
 * provider's own `error`/`error_description` is never read, so a redirect that
 * carries prose back from the authorization server cannot be reflected.
 */
export const OIDC_BROWSER_FLOW_FAILURES: Readonly<
  Record<
    OidcBrowserFlowFailureCode,
    { readonly status: 400 | 401 | 404 | 502; readonly title: string }
  >
> = Object.freeze({
  OIDC_BROWSER_LOGIN_UNAVAILABLE: {
    status: 404,
    title: 'Browser sign-in is not available',
  },
  OIDC_LOGIN_START_FAILED: {
    status: 502,
    title: 'Sign-in could not be started',
  },
  OIDC_TRANSACTION_MISSING: {
    status: 400,
    title: 'Sign-in request has expired',
  },
  OIDC_STATE_MISMATCH: {
    status: 400,
    title: 'Sign-in request could not be verified',
  },
  OIDC_PROVIDER_REFUSED: {
    status: 401,
    title: 'Identity provider refused the sign-in',
  },
  OIDC_EXCHANGE_FAILED: {
    status: 502,
    title: 'Sign-in could not be completed',
  },
  OIDC_IDENTITY_UNVERIFIED: {
    status: 401,
    title: 'Identity could not be verified',
  },
  /**
   * The exchange succeeded and the durable access audit did not.
   *
   * A sign-in that cannot be recorded is not completed: this is the code the
   * callback fails closed with, having issued no identity cookie.
   */
  OIDC_ACCESS_NOT_RECORDED: {
    status: 502,
    title: 'Sign-in could not be recorded',
  },
})

/**
 * The only error this flow throws.
 *
 * It carries a code and the fixed title for that code — never a `cause`, never
 * a wrapped provider error, never a value from the request. Constructing it
 * from a code rather than a message is what makes that structural.
 */
export class OidcBrowserFlowError extends Error {
  readonly code: OidcBrowserFlowFailureCode
  readonly status: 400 | 401 | 404 | 502

  constructor(code: OidcBrowserFlowFailureCode) {
    const failure = OIDC_BROWSER_FLOW_FAILURES[code]
    super(failure.title)
    this.name = 'OidcBrowserFlowError'
    this.code = code
    this.status = failure.status
  }
}

/**
 * Re-shapes anything thrown below the flow into a bounded failure.
 *
 * A thrown value from a token exchange can hold a response body, a client id,
 * or a URL with a code in it. Only an already-bounded {@link
 * OidcBrowserFlowError} survives; everything else collapses to one code and is
 * dropped, unread.
 */
export function boundedFlowFailure(error: unknown): OidcBrowserFlowError {
  return error instanceof OidcBrowserFlowError
    ? error
    : new OidcBrowserFlowError('OIDC_EXCHANGE_FAILED')
}

/**
 * Whether a value is inside the grammar every maintained generator emits.
 *
 * Enforced on the way into the authenticated envelope and again on the way out,
 * so `oidcTransactionSeal.ts` never seals — and never returns — something the
 * exchange would then send to a token endpoint.
 */
export function isOidcTransactionValue(value: unknown): value is string {
  return typeof value === 'string' && TRANSACTION_VALUE.test(value)
}

/**
 * Constant-time comparison of the returned `state` against the cookie's.
 *
 * The library performs this check again during the exchange; doing it here too
 * means a mismatched state is refused before a code is ever sent to the
 * provider, and it is what makes the "invalid state" path observable without a
 * network round trip.
 */
export function stateMatches(
  supplied: string | null,
  expected: string,
): boolean {
  if (!isOidcTransactionValue(supplied)) return false
  const left = Buffer.from(supplied, 'utf8')
  const right = Buffer.from(expected, 'utf8')
  return left.byteLength === right.byteLength && timingSafeEqual(left, right)
}

/**
 * Rebuilds the callback URL the exchange validates, from configuration.
 *
 * The origin and path come from the configured redirect URI, never from the
 * `Host` header — a forwarded host would otherwise decide what this server
 * claims its own redirect URI was, and the library derives the token request's
 * `redirect_uri` from exactly this URL by stripping the query. Only the query
 * comes from the request, and only within a bound.
 */
export function callbackUrlFor(redirectUri: string, rawQuery: string): URL {
  if (rawQuery.length > MAX_CALLBACK_QUERY_LENGTH) {
    throw new OidcBrowserFlowError('OIDC_EXCHANGE_FAILED')
  }
  const url = new URL(redirectUri)
  if (url.pathname !== OIDC_CALLBACK_ROUTE) {
    throw new OidcBrowserFlowError('OIDC_EXCHANGE_FAILED')
  }
  url.search = rawQuery
  url.hash = ''
  return url
}

function cookie(
  name: string,
  value: string,
  attributes: {
    path: string
    maxAgeSeconds: number
  },
): string {
  return [
    `${name}=${value}`,
    `Path=${attributes.path}`,
    `Max-Age=${attributes.maxAgeSeconds}`,
    'Secure',
    'HttpOnly',
    // Lax, not Strict: the provider's redirect back into this application is a
    // cross-site top-level GET, and Strict would withhold the cookie on exactly
    // the request that needs it, turning every sign-in into a silent loop.
    'SameSite=Lax',
  ].join('; ')
}

export function oidcTransactionCookie(value: string): string {
  return cookie(OIDC_TRANSACTION_COOKIE, value, {
    path: OIDC_TRANSACTION_COOKIE_PATH,
    maxAgeSeconds: OIDC_TRANSACTION_TTL_SECONDS,
  })
}

/**
 * Consumes the transaction. Emitted on every callback outcome, success or
 * failure, so a code can never be presented against the same transaction twice.
 */
export function clearOidcTransactionCookie(): string {
  return cookie(OIDC_TRANSACTION_COOKIE, '', {
    path: OIDC_TRANSACTION_COOKIE_PATH,
    maxAgeSeconds: 0,
  })
}

/**
 * The configured OIDC token cookie — the only cookie a successful callback
 * sets, and the same one the per-request verifier already reads.
 */
export function oidcIdentityCookie(
  name: string,
  idToken: string,
  maxAgeSeconds: number,
): string {
  return cookie(name, encodeURIComponent(idToken), {
    path: '/',
    maxAgeSeconds,
  })
}

export function clearOidcIdentityCookie(name: string): string {
  return cookie(name, '', { path: '/', maxAgeSeconds: 0 })
}

/**
 * How long the identity cookie may live: the shorter of the ID token's own
 * remaining lifetime and the deployment's `maxTokenAge` policy.
 *
 * Never longer than either. A cookie outliving the token it holds only produces
 * a request the verifier rejects, and outliving the policy would let the cookie
 * quietly become the session length instead of the token.
 */
export function identityCookieMaxAge(
  expiresAtSeconds: number,
  maxTokenAgeSeconds: number,
  nowSeconds: number,
): number {
  const remaining = Math.floor(expiresAtSeconds - nowSeconds)
  return Math.max(0, Math.min(maxTokenAgeSeconds, remaining))
}
