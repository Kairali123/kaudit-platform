import { CredentialError } from './credentialTypes.ts'

/**
 * Login-handle normalization. Every write and every lookup goes through these,
 * so "Admin", "admin ", and "admin" can never become two accounts.
 *
 * Usernames are deliberately ASCII-only: a Unicode handle invites homoglyph
 * look-alikes (Cyrillic 'a' vs Latin 'a') that read identically in an audit log
 * but resolve to different people.
 */

export const USERNAME_MIN_LENGTH = 3
export const USERNAME_MAX_LENGTH = 64
export const EMAIL_MAX_LENGTH = 255
/** The widest thing a login box may accept before it is classified. */
export const LOGIN_MAX_LENGTH = EMAIL_MAX_LENGTH

// Lowercase alphanumerics plus dot, underscore, hyphen; must start and end
// alphanumeric. No '@', so a username can never look like an email address.
const USERNAME_PATTERN = /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])$/
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/
const EMAIL_PATTERN = /^[^@\s]+@[^@\s]+\.[^@\s]+$/

function prepare(value: unknown): string | null {
  if (typeof value !== 'string') return null
  // Bound before any further work so a hostile input cannot force a large scan.
  if (value.length > LOGIN_MAX_LENGTH) return null
  const trimmed = value.trim()
  if (!trimmed || CONTROL_CHARACTERS.test(trimmed)) return null
  return trimmed.toLowerCase()
}

function isUsernameShape(candidate: string): boolean {
  return (
    candidate.length >= USERNAME_MIN_LENGTH &&
    candidate.length <= USERNAME_MAX_LENGTH &&
    USERNAME_PATTERN.test(candidate)
  )
}

function isEmailShape(candidate: string): boolean {
  return candidate.length <= EMAIL_MAX_LENGTH && EMAIL_PATTERN.test(candidate)
}

/** Strict form for storage and account administration. Throws on anything else. */
export function normalizeUsername(value: unknown): string {
  const candidate = prepare(value)
  if (!candidate || !isUsernameShape(candidate)) {
    throw new CredentialError(
      'USERNAME_MALFORMED',
      'Username must be 3 to 64 characters of a-z, 0-9, dot, underscore, or hyphen',
    )
  }
  return candidate
}

/** Strict form for storage. Intentionally minimal: one '@', no whitespace. */
export function normalizeEmail(value: unknown): string {
  const candidate = prepare(value)
  if (!candidate || !isEmailShape(candidate)) {
    throw new CredentialError(
      'EMAIL_MALFORMED',
      'Email address is not a valid address',
    )
  }
  return candidate
}

/**
 * Lenient form for the single login box, which accepts either a username or an
 * email. Returns null instead of throwing: an unparseable login is simply an
 * authentication failure, and must not be distinguishable from a wrong password.
 */
export function normalizeLogin(value: unknown): string | null {
  const candidate = prepare(value)
  if (!candidate) return null
  if (candidate.includes('@')) {
    return isEmailShape(candidate) ? candidate : null
  }
  return isUsernameShape(candidate) ? candidate : null
}

/** True when a normalized login is an email rather than a username handle. */
export function looksLikeEmail(normalizedLogin: string): boolean {
  return normalizedLogin.includes('@')
}
