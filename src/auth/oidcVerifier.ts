import { createRemoteJWKSet, jwtVerify } from 'jose'
import type { TokenVerifier, VerifiedIdentity } from './types.ts'

export interface OidcVerifierConfig {
  issuer: string
  audience: string
  jwksUri: string
  algorithms: string[]
  /**
   * Maximum accepted `iat` age, in seconds. Bounded to 60..3600 by
   * `config/runtime.ts`, which also owns the default.
   *
   * This is a freshness ceiling layered on top of the signature, issuer,
   * audience and `exp` checks below — never a replacement for any of them, and
   * there is no value it can take that skips one.
   */
  maxTokenAgeSeconds: number
}

/**
 * Every spelling of the configured issuer identifier that denotes that issuer.
 *
 * `config/runtime.ts` validates `KAUDIT_OIDC_ISSUER` by parsing it as a URL and
 * keeps `URL.toString()`'s output — which gives an origin-only issuer identifier
 * a `/` path it was never published with: `https://accounts.google.com` becomes
 * `https://accounts.google.com/`. A provider sends its issuer identifier back in
 * `iss` exactly as it published it, and the check below is raw string equality,
 * so the rewritten value can never match. The result is the failure this function
 * exists to prevent: an ID token the callback validated a moment ago is refused
 * on the very next request, which presents itself as a sign-in that completes and
 * then lands back on the login page.
 *
 * The callback validator does not have the problem, which is why the two halves
 * of the flow disagreed: `oauth4webapi` compares issuer identifiers through
 * `new URL(value).href` and checks `iss` against the issuer string the provider
 * published in its own metadata, never against this deployment's rewrite of it.
 *
 * This applies that same equivalence to the per-request check, and only that.
 * The returned set is the configured value, its URL-normalized form, and — for an
 * origin-only identifier — that form without the added `/`. Scheme, host, port
 * and path are never altered, so no other issuer becomes acceptable, and nothing
 * else about verification changes: the signature, `aud`, `exp`, the freshness
 * ceiling and the required claims are all still checked exactly as before.
 */
export function acceptedIssuerIdentifiers(issuer: string): string[] {
  let url: URL
  try {
    url = new URL(issuer)
  } catch {
    // Not a URL, so there is no normalization to undo. The accepted set is the
    // single exact value, which is the comparison this function replaced.
    return [issuer]
  }
  const identifiers = new Set<string>([issuer, url.href])
  if (url.pathname === '/' && !url.search && !url.hash) {
    identifiers.add(url.href.slice(0, -1))
  }
  return [...identifiers]
}

export function createOidcVerifier(config: OidcVerifierConfig): TokenVerifier {
  const issuers = acceptedIssuerIdentifiers(config.issuer)
  const jwks = createRemoteJWKSet(new URL(config.jwksUri), {
    cooldownDuration: 30_000,
    cacheMaxAge: 10 * 60_000,
    timeoutDuration: 5_000,
  })

  return {
    async verify(token): Promise<VerifiedIdentity> {
      const { payload } = await jwtVerify(token, jwks, {
        issuer: issuers,
        audience: config.audience,
        algorithms: config.algorithms,
        clockTolerance: 5,
        maxTokenAge: config.maxTokenAgeSeconds,
        requiredClaims: ['sub', 'iat', 'exp'],
      })
      if (typeof payload.sub !== 'string' || !payload.sub) {
        throw new Error('OIDC token has no subject')
      }
      return {
        /**
         * The configured value, deliberately — not `payload.iss`.
         *
         * This is the key `authenticate` looks an account binding up by, and the
         * `oidc_issuer` column it is compared against was written by
         * `w1:bind-oidc`, which requires the operator's input to equal this same
         * configured value. Returning the accepted spelling from the token
         * instead would silently change that lookup for every already-bound
         * account, so widening which `iss` values verify above does not move
         * which issuer a verified identity resolves under.
         */
        issuer: config.issuer,
        subject: payload.sub,
        email:
          typeof payload.email === 'string'
            ? payload.email.toLowerCase()
            : null,
      }
    },
  }
}
