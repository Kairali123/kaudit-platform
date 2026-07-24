import { createRemoteJWKSet, jwtVerify } from 'jose'
import type { TokenVerifier, VerifiedIdentity } from './types.ts'

export interface OidcVerifierConfig {
  issuer: string
  audience: string
  jwksUri: string
  algorithms: string[]
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
        maxTokenAge: '15m',
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
