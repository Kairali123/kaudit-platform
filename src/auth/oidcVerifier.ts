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

export function createOidcVerifier(config: OidcVerifierConfig): TokenVerifier {
  const jwks = createRemoteJWKSet(new URL(config.jwksUri), {
    cooldownDuration: 30_000,
    cacheMaxAge: 10 * 60_000,
    timeoutDuration: 5_000,
  })

  return {
    async verify(token): Promise<VerifiedIdentity> {
      const { payload } = await jwtVerify(token, jwks, {
        issuer: config.issuer,
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
