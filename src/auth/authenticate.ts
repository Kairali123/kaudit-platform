import { can } from '../identity/access.ts'
import type {
  AccessRepository,
  AuthContext,
  TokenVerifier,
  VerifiedIdentity,
} from './types.ts'

export type AuthFailureCode =
  | 'AUTH_REQUIRED'
  | 'AUTH_INVALID'
  | 'USER_NOT_PROVISIONED'
  | 'USER_DISABLED'
  | 'PERMISSION_DENIED'

export class AuthFailure extends Error {
  readonly status: 401 | 403
  readonly code: AuthFailureCode

  constructor(
    status: 401 | 403,
    code: AuthFailureCode,
    message: string,
  ) {
    super(message)
    this.status = status
    this.code = code
  }
}

function parseCookie(header: string | undefined, name: string): string | null {
  if (!header) return null
  for (const part of header.split(';')) {
    const index = part.indexOf('=')
    if (index < 1 || part.slice(0, index).trim() !== name) continue
    try {
      return decodeURIComponent(part.slice(index + 1).trim())
    } catch {
      return null
    }
  }
  return null
}

export function extractBearerToken(
  authorization: string | undefined,
  cookieHeader: string | undefined,
  tokenCookie: string | null,
): string | null {
  if (authorization) {
    const match = /^Bearer ([A-Za-z0-9._~-]+)$/.exec(authorization.trim())
    return match?.[1] ?? null
  }
  return tokenCookie ? parseCookie(cookieHeader, tokenCookie) : null
}

async function resolveIdentity(
  identity: VerifiedIdentity,
  repository: AccessRepository,
): Promise<AuthContext> {
  const user = await repository.findByOidc(
    identity.issuer,
    identity.subject,
  )
  if (!user) {
    throw new AuthFailure(
      403,
      'USER_NOT_PROVISIONED',
      'Identity is not provisioned',
    )
  }
  if (user.status !== 'active') {
    throw new AuthFailure(403, 'USER_DISABLED', 'User is not active')
  }
  return { user, issuer: identity.issuer, subject: identity.subject }
}

export async function authenticateOidc(
  token: string | null,
  verifier: TokenVerifier,
  repository: AccessRepository,
): Promise<AuthContext> {
  if (!token) {
    throw new AuthFailure(
      401,
      'AUTH_REQUIRED',
      'Authentication is required',
    )
  }
  let identity: VerifiedIdentity
  try {
    identity = await verifier.verify(token)
  } catch {
    throw new AuthFailure(
      401,
      'AUTH_INVALID',
      'Authentication token is invalid',
    )
  }
  return resolveIdentity(identity, repository)
}

export async function authenticateLocal(
  email: string,
  repository: AccessRepository,
): Promise<AuthContext> {
  const user = await repository.findByEmail(email.toLowerCase())
  if (!user) {
    throw new AuthFailure(
      403,
      'USER_NOT_PROVISIONED',
      'Development identity is not provisioned',
    )
  }
  if (user.status !== 'active') {
    throw new AuthFailure(403, 'USER_DISABLED', 'User is not active')
  }
  return {
    user,
    issuer: 'local-development',
    subject: user.email,
  }
}

export function requirePermission(
  context: AuthContext,
  permission: string,
): void {
  if (!can(context.user.roles, permission)) {
    throw new AuthFailure(403, 'PERMISSION_DENIED', 'Permission denied')
  }
}
