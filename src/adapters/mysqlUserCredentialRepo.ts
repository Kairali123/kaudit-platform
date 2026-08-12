import type { Pool, RowDataPacket } from 'mysql2/promise'
import { normalizeLogin } from '../auth/credentialIdentity.ts'
import type {
  CredentialRepository,
  CredentialSessionState,
  CredentialUser,
} from '../auth/credentialTypes.ts'

/**
 * Read-only mysql2 adapter for database-backed login (migration 0009).
 *
 * Every statement is a module constant with bound placeholders — no table,
 * column, or filter is ever assembled from a caller value, so there is no
 * dynamic SQL identifier anywhere in this file. The repository performs no
 * write of any kind: creating, disabling, or tombstoning an account is a
 * separate, audited command.
 */

const USER_KIND = 'user'
const MAX_USER_ID_LENGTH = 40

/** Only what authentication and authorization actually need. */
const CREDENTIAL_COLUMNS = `
    u.id                    AS id,
    u.email                 AS email,
    u.status                AS status,
    u.max_sensitivity_tier  AS max_sensitivity_tier,
    c.username_normalized   AS username_normalized,
    c.password_hash         AS password_hash,
    c.session_version       AS session_version,
    c.status                AS credential_status,
    GROUP_CONCAT(DISTINCT r.role_code ORDER BY r.role_code SEPARATOR ',') AS roles`

export const USER_CREDENTIAL_SQL = {
  // A username can never contain '@' (migration 0009 CHECK + normalizeUsername),
  // and both columns are unique, so this OR can match at most one row.
  selectByLogin: `SELECT${CREDENTIAL_COLUMNS}
  FROM kaudit_user u
  JOIN kaudit_user_credential c ON c.user_id = u.id
  LEFT JOIN kaudit_user_role r ON r.user_id = u.id
  WHERE u.kind = ?
    AND (c.username_normalized = ? OR u.email = ?)
  GROUP BY u.id, u.email, u.status, u.max_sensitivity_tier,
           c.username_normalized, c.password_hash, c.session_version, c.status
  LIMIT 1`,

  selectSessionState: `SELECT
    u.id              AS id,
    u.status          AS status,
    c.status          AS credential_status,
    c.session_version AS session_version
  FROM kaudit_user u
  JOIN kaudit_user_credential c ON c.user_id = u.id
  WHERE u.kind = ? AND u.id = ?
  LIMIT 1`,

  readiness: `SELECT COUNT(*) AS n
  FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'kaudit_user_credential'
    AND COLUMN_NAME IN (
      'user_id', 'username_normalized', 'password_hash',
      'session_version', 'status', 'password_changed_at'
    )`,
} as const

/** Every column the readiness probe requires migration 0009 to have created. */
export const REQUIRED_CREDENTIAL_COLUMN_COUNT = 6

interface CredentialRow extends RowDataPacket {
  id: string
  email: string | null
  status: string
  max_sensitivity_tier: string
  username_normalized: string
  password_hash: string
  session_version: number | string
  credential_status: string
  roles: string | null
}

interface SessionStateRow extends RowDataPacket {
  id: string
  status: string
  credential_status: string
  session_version: number | string
}

function isUserId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_USER_ID_LENGTH &&
    /^[A-Za-z0-9_-]+$/.test(value)
  )
}

/** The column is `int unsigned`, so this is its full declared range. */
const MAX_SESSION_VERSION = 4294967295

/**
 * A session generation is only usable if it is a whole positive number. The
 * driver may hand back a number or a string depending on connection flags, so
 * both are accepted — but `Number()` alone would turn NULL into 0, text into
 * NaN, and '3.5' into a fraction, and each of those would silently mint a
 * session that no `session_version` increment could ever revoke.
 */
function toSessionVersion(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isInteger(value) &&
      value >= 1 &&
      value <= MAX_SESSION_VERSION
      ? value
      : null
  }
  if (typeof value === 'string' && /^[0-9]{1,10}$/.test(value)) {
    const parsed = Number(value)
    return parsed >= 1 && parsed <= MAX_SESSION_VERSION ? parsed : null
  }
  return null
}

/**
 * Maps a row, or FAILS CLOSED. A row whose id or session generation is not a
 * production shape is corrupt, not a login: it is refused here rather than
 * handed on as an authenticatable user.
 *
 * An inactive, disabled, or tombstoned row still maps. That is deliberate —
 * the authorization step must be able to deny it as a decision, which it can
 * only do if the state reaches it.
 */
function mapCredential(row: CredentialRow | undefined): CredentialUser | null {
  if (!row) return null
  const sessionVersion = toSessionVersion(row.session_version)
  if (!isUserId(row.id) || sessionVersion === null) return null
  return {
    id: row.id,
    usernameNormalized: row.username_normalized,
    email: row.email ?? null,
    status: row.status,
    credentialStatus: row.credential_status,
    passwordHash: row.password_hash,
    sessionVersion,
    maxSensitivityTier: row.max_sensitivity_tier,
    roles: row.roles ? row.roles.split(',').filter(Boolean) : [],
  }
}

/** The same fail-closed rule for the per-request revocation read. */
function mapSessionState(
  row: SessionStateRow | undefined,
): CredentialSessionState | null {
  if (!row) return null
  const sessionVersion = toSessionVersion(row.session_version)
  if (!isUserId(row.id) || sessionVersion === null) return null
  return {
    id: row.id,
    status: row.status,
    credentialStatus: row.credential_status,
    sessionVersion,
  }
}

export function createMysqlUserCredentialRepository(
  pool: Pool,
): CredentialRepository {
  return {
    async findByLogin(login) {
      // A login that cannot be normalized is an authentication failure, not a
      // query: it never reaches the database.
      const normalized = normalizeLogin(login)
      if (!normalized) return null
      const [rows] = await pool.execute<CredentialRow[]>(
        USER_CREDENTIAL_SQL.selectByLogin,
        [USER_KIND, normalized, normalized],
      )
      return mapCredential(rows[0])
    },

    async getSessionState(userId) {
      if (!isUserId(userId)) return null
      const [rows] = await pool.execute<SessionStateRow[]>(
        USER_CREDENTIAL_SQL.selectSessionState,
        [USER_KIND, userId],
      )
      return mapSessionState(rows[0])
    },

    async readiness() {
      const [rows] = await pool.query<RowDataPacket[]>(
        USER_CREDENTIAL_SQL.readiness,
      )
      return Number(rows[0]?.n) === REQUIRED_CREDENTIAL_COLUMN_COUNT
    },
  }
}
