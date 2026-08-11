import * as oidc from 'openid-client'
import {
  OIDC_CALLBACK_ROUTE,
  OIDC_SCOPE,
  OidcBrowserFlowError,
  type OidcTransaction,
} from './oidcBrowserFlow.ts'
import { createOidcTransactionSeal } from './oidcTransactionSeal.ts'

/**
 * The narrow protocol edge of the authorization-code browser flow.
 *
 * This is the only file that imports an OIDC library, the only file that holds
 * the client secret, and the only file that talks to the identity provider.
 * Nothing about the protocol is re-implemented here: `openid-client` (by the
 * author of `jose`, which this repository already uses for per-request token
 * verification) performs discovery, builds the authorization request, runs the
 * code exchange, and validates the ID token's signature, issuer, audience,
 * expiry, and nonce. This module only supplies inputs and shapes outputs.
 *
 * Standards-based on purpose: the provider is described by an issuer URL and
 * discovered through `/.well-known/openid-configuration`, so no Google endpoint
 * and no deployment hostname is written down anywhere in this repository. The
 * same code works against any conforming provider.
 *
 * ## Secret handling
 *
 * The secret arrives as a constructor argument, is handed straight to the
 * library's `Configuration`, and is never stored on an exported object, copied
 * into runtime configuration, included in a returned value, or reachable from a
 * thrown error. `RuntimeConfig` deliberately has no field for it.
 *
 * It is also the key material the transaction envelope is authenticated with,
 * through the domain-separated HKDF in `oidcTransactionSeal.ts`. That is why
 * sealing lives behind this edge rather than in the transport module or the
 * HTTP server: the derived HMAC key stays inside the same closure as the
 * secret it came from, and the server only ever handles the opaque result.
 *
 * ## Output discipline
 *
 * Every failure below is re-thrown as a bounded {@link OidcBrowserFlowError}
 * with the original discarded unread. A library error legitimately carries the
 * token endpoint's response body, the authorization code, the client id, and
 * the full callback URL; none of that may reach a log line or a browser.
 */

/** What a validated callback yields. An ID token and its expiry — nothing else. */
export interface VerifiedIdToken {
  /** The compact JWT, handed to the identity cookie and never persisted. */
  idToken: string
  /** The `exp` claim, in seconds, used only to bound the cookie's lifetime. */
  expiresAtSeconds: number
}

export interface OidcAuthorizationStart {
  /** Where the browser is sent. Built by the library from discovered metadata. */
  authorizationUrl: URL
  /** The material the callback must present back. */
  transaction: OidcTransaction
  /**
   * The same material, sealed. This — and only this — is what the caller puts
   * in the transaction cookie; the raw {@link transaction} above never leaves
   * the server.
   */
  transactionCookie: string
}

export interface OidcCallbackExchange {
  /** Rebuilt from configuration by `callbackUrlFor`, never from a `Host` header. */
  callbackUrl: URL
  expectedState: string
  expectedNonce: string
  codeVerifier: string
}

export interface OidcAuthorizationClient {
  beginAuthorization(): Promise<OidcAuthorizationStart>
  /**
   * Opens a transaction cookie, or throws the flow's single bounded
   * `OIDC_TRANSACTION_MISSING`. A cookie this deployment's key did not
   * authenticate — injected by a sibling host under a shared parent domain,
   * tampered with, truncated, of another version, or expired — is refused here,
   * which is before {@link exchange} presents a code to any token endpoint.
   */
  openTransaction(cookieValue: string | null): OidcTransaction
  exchange(input: OidcCallbackExchange): Promise<VerifiedIdToken>
}

export interface OidcAuthorizationClientOptions {
  /** Issuer identifier. Provider metadata is discovered from it. */
  issuer: string
  clientId: string
  /** Held only by the library `Configuration` this creates. */
  clientSecret: string
  /** Same-origin HTTPS callback; its path must be the callback route. */
  redirectUri: string
  /**
   * Injected by tests so the constructor performs no discovery request. The
   * default is the library's own discovery, which is the production path.
   */
  loadConfiguration?: () => Promise<oidc.Configuration>
}

function assertCallbackRedirectUri(redirectUri: string): void {
  const url = new URL(redirectUri)
  if (url.protocol !== 'https:' || url.pathname !== OIDC_CALLBACK_ROUTE) {
    throw new OidcBrowserFlowError('OIDC_BROWSER_LOGIN_UNAVAILABLE')
  }
}

/**
 * Builds the client. Constructing it opens nothing.
 *
 * Discovery is deferred to the first sign-in and then memoized, so a warm
 * serverless instance fetches provider metadata once. A failed discovery drops
 * the memo rather than caching the rejection: a provider that was briefly
 * unreachable must not disable sign-in for the life of the instance.
 */
export function createOidcAuthorizationClient(
  options: OidcAuthorizationClientOptions,
): OidcAuthorizationClient {
  assertCallbackRedirectUri(options.redirectUri)

  // Derived once, held only here. Constructing this is also what refuses a
  // deployment whose client secret is too weak to authenticate a transaction.
  const seal = createOidcTransactionSeal(options.clientSecret)

  const load =
    options.loadConfiguration ??
    (() =>
      oidc.discovery(
        new URL(options.issuer),
        options.clientId,
        options.clientSecret,
      ))

  let pending: Promise<oidc.Configuration> | null = null
  const configuration = (): Promise<oidc.Configuration> => {
    if (!pending) {
      pending = load().catch((error: unknown) => {
        pending = null
        throw error
      })
    }
    return pending
  }

  return {
    async beginAuthorization(): Promise<OidcAuthorizationStart> {
      try {
        const config = await configuration()
        // Generated by the library, from the platform CSPRNG: 32 random bytes
        // base64url-encoded apiece.
        const state = oidc.randomState()
        const nonce = oidc.randomNonce()
        const codeVerifier = oidc.randomPKCECodeVerifier()
        const codeChallenge =
          await oidc.calculatePKCECodeChallenge(codeVerifier)
        const authorizationUrl = oidc.buildAuthorizationUrl(config, {
          redirect_uri: options.redirectUri,
          scope: OIDC_SCOPE,
          state,
          nonce,
          code_challenge: codeChallenge,
          // S256 only. `plain` is a downgrade and is never offered.
          code_challenge_method: 'S256',
        })
        const transaction: OidcTransaction = { state, nonce, codeVerifier }
        return {
          authorizationUrl,
          transaction,
          transactionCookie: seal.seal(transaction),
        }
      } catch (error) {
        // Typically an unreachable or non-conforming discovery document. The
        // thrown value can carry the issuer URL and the response body, so it is
        // discarded here rather than anywhere further up.
        throw error instanceof OidcBrowserFlowError
          ? error
          : new OidcBrowserFlowError('OIDC_LOGIN_START_FAILED')
      }
    },

    openTransaction(cookieValue: string | null): OidcTransaction {
      return seal.open(cookieValue)
    },

    async exchange(input: OidcCallbackExchange): Promise<VerifiedIdToken> {
      let tokens: oidc.TokenEndpointResponse & oidc.TokenEndpointResponseHelpers
      try {
        const config = await configuration()
        tokens = await oidc.authorizationCodeGrant(config, input.callbackUrl, {
          // All three are exact-match checks inside the library. `expectedNonce`
          // additionally makes an ID Token mandatory in the response, so a
          // provider answering with an access token alone is a failure, not a
          // silently unauthenticated success.
          expectedState: input.expectedState,
          expectedNonce: input.expectedNonce,
          pkceCodeVerifier: input.codeVerifier,
          idTokenExpected: true,
        })
      } catch {
        // Unread by construction. See the module note on output discipline.
        throw new OidcBrowserFlowError('OIDC_EXCHANGE_FAILED')
      }
      // `claims()` is the already-validated ID Token payload; it returns
      // `undefined` when the response carried no ID Token at all.
      const claims = tokens.claims()
      if (
        !claims ||
        typeof claims.sub !== 'string' ||
        !claims.sub ||
        typeof claims.exp !== 'number' ||
        !Number.isFinite(claims.exp) ||
        typeof tokens.id_token !== 'string' ||
        !tokens.id_token
      ) {
        throw new OidcBrowserFlowError('OIDC_IDENTITY_UNVERIFIED')
      }
      // Only these two fields leave this module. `tokens` also holds the access
      // token and, for a provider that issues one unasked, a refresh token —
      // neither is read, returned, stored, or used to call anything.
      return { idToken: tokens.id_token, expiresAtSeconds: claims.exp }
    },
  }
}
