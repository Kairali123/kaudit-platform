export interface VerifiedIdentity {
  issuer: string
  subject: string
  email: string | null
}

export interface AccessUser {
  id: string
  email: string
  status: string
  maxSensitivityTier: string
  roles: string[]
}

export interface AuthContext {
  user: AccessUser
  issuer: string
  subject: string
}

export interface TokenVerifier {
  verify(token: string): Promise<VerifiedIdentity>
}

export interface AccessRepository {
  findByOidc(issuer: string, subject: string): Promise<AccessUser | null>
  findByEmail(email: string): Promise<AccessUser | null>
  readiness(): Promise<boolean>
}
