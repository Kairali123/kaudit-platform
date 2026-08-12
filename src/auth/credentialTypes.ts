/**
 * Framework-neutral contracts for database-backed user login (migration 0009).
 *
 * Nothing here knows about HTTP, cookies, or a request object: these are the
 * value types a future sign-in route, CLI, or worker would all share. The OIDC
 * path in `types.ts` is untouched and remains the production entry point.
 */

/** Login-relevant projection of a `kaudit_user` + `kaudit_user_credential` pair. */
export interface CredentialUser {
  /** Stable `kaudit_user.id`. The only user identifier a session carries. */
  id: string
  usernameNormalized: string
  email: string | null
  /** `kaudit_user.status` — the directory-level state. */
  status: string
  /** `kaudit_user_credential.status` — active | disabled | tombstoned. */
  credentialStatus: string
  /** Self-describing one-way hash; never a plaintext or reversible value. */
  passwordHash: string
  sessionVersion: number
  maxSensitivityTier: string
  roles: string[]
}

/** The per-request revocation check: is this user still allowed, at this generation? */
export interface CredentialSessionState {
  id: string
  status: string
  credentialStatus: string
  sessionVersion: number
}

/**
 * Narrow read port. Deliberately has no create/update/delete method: user
 * administration is a separate, audited task, not a side effect of login.
 */
export interface CredentialRepository {
  /**
   * Resolves one credential by normalized username OR normalized email.
   * A username can never contain '@', so the two spaces cannot collide.
   * Returns null for an unknown, malformed, or oversized login.
   */
  findByLogin(login: string): Promise<CredentialUser | null>
  /** Current status + session generation for an already-identified user. */
  getSessionState(userId: string): Promise<CredentialSessionState | null>
  /** True when migration 0009's columns are present. */
  readiness(): Promise<boolean>
}

export type CredentialFailureCode =
  | 'LOGIN_MALFORMED'
  | 'USERNAME_MALFORMED'
  | 'EMAIL_MALFORMED'
  | 'PASSWORD_POLICY'
  | 'PASSWORD_OVERSIZE'
  | 'HASHING_FAILED'
  | 'STORED_HASH_MALFORMED'
  | 'SESSION_SECRET_WEAK'
  | 'SESSION_TTL_OUT_OF_RANGE'
  | 'SESSION_INVALID'

/**
 * Carries a stable code only. The message is a fixed sentence: never a
 * password, hash, token, username, email, or thrown provider text.
 */
export class CredentialError extends Error {
  readonly code: CredentialFailureCode

  constructor(code: CredentialFailureCode, message: string) {
    super(message)
    this.name = 'CredentialError'
    this.code = code
  }
}
