import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto'
import { CredentialError } from './credentialTypes.ts'

/**
 * One-way password hashing for database users, on Node's built-in scrypt — no
 * native dependency is added. Every request-capable entry point uses the
 * ASYNCHRONOUS form, so a deliberately expensive KDF never blocks the event
 * loop for concurrent requests.
 *
 * Stored encoding (self-describing, so parameters can be raised later without a
 * schema change and old hashes keep verifying):
 *
 *   scrypt$N=16384,r=8,p=1$<salt base64url>$<digest base64url>
 */

const ALGORITHM = 'scrypt'
const KEY_LENGTH = 32
const SALT_BYTES = 16

/** ~16 MiB of memory per hash: costly for an attacker, fine for an admin login. */
const DEFAULT_COST = 16384
const DEFAULT_BLOCK_SIZE = 8
const DEFAULT_PARALLELIZATION = 1

// Ceilings applied to PARSED parameters, and checked BEFORE any KDF work is
// bought. A tampered or corrupted row could otherwise name N=2^20 and turn one
// unauthenticated login attempt into hundreds of megabytes and seconds of CPU.
//
// The envelope sits close to the parameters above — four times the memory and
// four times the CPU of a current hash — so a future cost rotation still
// verifies without a code change, while no single row can ever name a
// verification that costs more than 64 MiB.

/** scrypt's dominant allocation is 128 * N * r bytes; this caps it at 64 MiB. */
export const MAX_VERIFY_MEMORY_BYTES = 64 * 1024 * 1024
/** N * r * p — the CPU proxy — capped at 4x the current 16384 * 8 * 1. */
export const MAX_VERIFY_WORK_UNITS =
  4 * DEFAULT_COST * DEFAULT_BLOCK_SIZE * DEFAULT_PARALLELIZATION

// Structural per-parameter bounds. The two envelope ceilings above are what
// actually binds; these keep any single value from being absurd on its own.
const MAX_COST = 1 << 17
const MAX_BLOCK_SIZE = 16
const MAX_PARALLELIZATION = 4

/**
 * Handed to Node as `maxmem`, so the C++ layer refuses independently of the
 * checks above. It is the envelope plus the small 128 * r * p working buffer
 * that OpenSSL allocates alongside the 128 * N * r one.
 */
const MAX_MEMORY_BYTES =
  MAX_VERIFY_MEMORY_BYTES + 128 * MAX_BLOCK_SIZE * MAX_PARALLELIZATION

export const PASSWORD_MIN_LENGTH = 12
export const PASSWORD_MAX_LENGTH = 256
/** Independent byte ceiling: one emoji is a single character but four bytes. */
export const PASSWORD_MAX_BYTES = 1024

export type PasswordPolicyViolation =
  | 'TOO_SHORT'
  | 'TOO_LONG'
  | 'MISSING_LOWERCASE'
  | 'MISSING_UPPERCASE'
  | 'MISSING_DIGIT'
  | 'MISSING_SYMBOL'
  | 'CONTAINS_CONTROL_CHARACTER'
  | 'CONTAINS_IDENTITY'

export interface PasswordIdentityContext {
  username?: string | null
  email?: string | null
}

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/

/**
 * Policy for human administrators: long enough to resist offline cracking of a
 * leaked hash, mixed enough to rule out a single dictionary word, and never a
 * restatement of the account's own username or email local part.
 *
 * Returns codes only — the password itself is never echoed back.
 */
export function checkPasswordPolicy(
  password: unknown,
  identity: PasswordIdentityContext = {},
): PasswordPolicyViolation[] {
  if (typeof password !== 'string') return ['TOO_SHORT']

  const violations: PasswordPolicyViolation[] = []
  if (password.length < PASSWORD_MIN_LENGTH) violations.push('TOO_SHORT')
  if (
    password.length > PASSWORD_MAX_LENGTH ||
    Buffer.byteLength(password, 'utf8') > PASSWORD_MAX_BYTES
  ) {
    violations.push('TOO_LONG')
  }
  if (!/[a-z]/.test(password)) violations.push('MISSING_LOWERCASE')
  if (!/[A-Z]/.test(password)) violations.push('MISSING_UPPERCASE')
  if (!/[0-9]/.test(password)) violations.push('MISSING_DIGIT')
  if (!/[^A-Za-z0-9]/.test(password)) violations.push('MISSING_SYMBOL')
  if (CONTROL_CHARACTERS.test(password)) {
    violations.push('CONTAINS_CONTROL_CHARACTER')
  }

  const lowered = password.toLowerCase()
  const parts = [identity.username, identity.email?.split('@')[0]]
  for (const part of parts) {
    // Only meaningful fragments count; a two-character handle would match
    // almost anything.
    if (part && part.length >= 3 && lowered.includes(part.toLowerCase())) {
      violations.push('CONTAINS_IDENTITY')
      break
    }
  }
  return violations
}

interface ScryptParameters {
  cost: number
  blockSize: number
  parallelization: number
}

function derive(
  password: string,
  salt: Buffer,
  parameters: ScryptParameters,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(
      password,
      salt,
      KEY_LENGTH,
      {
        N: parameters.cost,
        r: parameters.blockSize,
        p: parameters.parallelization,
        maxmem: MAX_MEMORY_BYTES,
      },
      (error, derivedKey) => {
        // The thrown value is never surfaced: it can carry parameter detail.
        if (error) {
          reject(
            new CredentialError('HASHING_FAILED', 'Password hashing failed'),
          )
        } else {
          resolve(derivedKey)
        }
      },
    )
  })
}

/**
 * Hashes a password that has already been accepted by the policy. Throws
 * PASSWORD_POLICY (codes attached to nothing but the code) if it has not.
 */
export async function hashPassword(
  password: string,
  identity: PasswordIdentityContext = {},
  salt: Buffer = randomBytes(SALT_BYTES),
): Promise<string> {
  if (checkPasswordPolicy(password, identity).length > 0) {
    throw new CredentialError(
      'PASSWORD_POLICY',
      'Password does not meet the administrator password policy',
    )
  }
  const parameters: ScryptParameters = {
    cost: DEFAULT_COST,
    blockSize: DEFAULT_BLOCK_SIZE,
    parallelization: DEFAULT_PARALLELIZATION,
  }
  const digest = await derive(password, salt, parameters)
  return [
    ALGORITHM,
    `N=${parameters.cost},r=${parameters.blockSize},p=${parameters.parallelization}`,
    salt.toString('base64url'),
    digest.toString('base64url'),
  ].join('$')
}

interface ParsedHash {
  parameters: ScryptParameters
  salt: Buffer
  digest: Buffer
}

function decodeBase64Url(value: string): Buffer | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null
  return Buffer.from(value, 'base64url')
}

function isPowerOfTwo(value: number): boolean {
  return value > 1 && (value & (value - 1)) === 0
}

/**
 * Validates the stored encoding and FAILS CLOSED: any unexpected shape,
 * parameter, or length yields null rather than a lenient fallback. Kept private
 * so no caller can hold the decoded salt or digest.
 */
function parseStoredPasswordHash(storedHash: unknown): ParsedHash | null {
  if (typeof storedHash !== 'string' || storedHash.length > 512) return null
  const segments = storedHash.split('$')
  if (segments.length !== 4) return null
  const [algorithm, parameterText, saltText, digestText] = segments
  if (algorithm !== ALGORITHM) return null

  const matched = /^N=(\d{1,7}),r=(\d{1,3}),p=(\d{1,3})$/.exec(parameterText)
  if (!matched) return null
  const parameters: ScryptParameters = {
    cost: Number(matched[1]),
    blockSize: Number(matched[2]),
    parallelization: Number(matched[3]),
  }
  if (
    !isPowerOfTwo(parameters.cost) ||
    parameters.cost > MAX_COST ||
    parameters.blockSize < 1 ||
    parameters.blockSize > MAX_BLOCK_SIZE ||
    parameters.parallelization < 1 ||
    parameters.parallelization > MAX_PARALLELIZATION
  ) {
    return null
  }
  // The envelope, so no combination of individually-legal parameters adds up to
  // an expensive verification. Rejecting here — arithmetic only, before scrypt
  // is called — is what keeps an over-ceiling row cheap to refuse.
  if (
    128 * parameters.cost * parameters.blockSize > MAX_VERIFY_MEMORY_BYTES ||
    parameters.cost * parameters.blockSize * parameters.parallelization >
      MAX_VERIFY_WORK_UNITS
  ) {
    return null
  }

  const salt = decodeBase64Url(saltText)
  const digest = decodeBase64Url(digestText)
  if (!salt || !digest) return null
  if (salt.byteLength < 8 || salt.byteLength > 64) return null
  if (digest.byteLength !== KEY_LENGTH) return null
  return { parameters, salt, digest }
}

/**
 * True only when a stored value is a hash this module can verify. Useful for a
 * readiness or data-quality check; it reveals nothing about the password.
 */
export function isStoredPasswordHashValid(storedHash: unknown): boolean {
  return parseStoredPasswordHash(storedHash) !== null
}

/**
 * Verifies a candidate password against a stored hash in constant time.
 *
 * Never throws and never reports WHY it failed: a malformed stored hash, an
 * oversized input, and a wrong password are all indistinguishable `false`.
 */
export async function verifyPassword(
  password: unknown,
  storedHash: unknown,
): Promise<boolean> {
  if (typeof password !== 'string' || password.length === 0) return false
  // Bound BEFORE hashing: an unbounded input would let one request buy an
  // arbitrary amount of KDF work.
  if (
    password.length > PASSWORD_MAX_LENGTH ||
    Buffer.byteLength(password, 'utf8') > PASSWORD_MAX_BYTES
  ) {
    return false
  }
  const parsed = parseStoredPasswordHash(storedHash)
  if (!parsed) return false
  try {
    const candidate = await derive(password, parsed.salt, parsed.parameters)
    return (
      candidate.byteLength === parsed.digest.byteLength &&
      timingSafeEqual(candidate, parsed.digest)
    )
  } catch {
    return false
  }
}
