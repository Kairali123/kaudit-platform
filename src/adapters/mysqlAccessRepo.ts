import type { Pool, RowDataPacket } from 'mysql2/promise'
import type {
  AccessRepository,
  AccessUser,
} from '../auth/types.ts'

interface UserRow extends RowDataPacket {
  id: string
  email: string
  status: string
  max_sensitivity_tier: string
  roles: string | null
}

function mapUser(row: UserRow | undefined): AccessUser | null {
  if (!row) return null
  return {
    id: row.id,
    email: row.email,
    status: row.status,
    maxSensitivityTier: row.max_sensitivity_tier,
    roles: row.roles ? row.roles.split(',').filter(Boolean) : [],
  }
}

const USER_SELECT = `
  SELECT u.id, u.email, u.status, u.max_sensitivity_tier,
         GROUP_CONCAT(DISTINCT r.role_code ORDER BY r.role_code SEPARATOR ',') AS roles
  FROM kaudit_user u
  LEFT JOIN kaudit_user_role r ON r.user_id = u.id
`

export function createMysqlAccessRepository(
  pool: Pool,
): AccessRepository {
  return {
    async findByOidc(issuer, subject) {
      const [rows] = await pool.execute<UserRow[]>(
        `${USER_SELECT}
         WHERE u.kind = 'user' AND u.oidc_issuer = ? AND u.oidc_subject = ?
         GROUP BY u.id, u.email, u.status, u.max_sensitivity_tier
         LIMIT 1`,
        [issuer, subject],
      )
      return mapUser(rows[0])
    },

    async findByEmail(email) {
      const [rows] = await pool.execute<UserRow[]>(
        `${USER_SELECT}
         WHERE u.kind = 'user' AND u.email = ?
         GROUP BY u.id, u.email, u.status, u.max_sensitivity_tier
         LIMIT 1`,
        [email],
      )
      return mapUser(rows[0])
    },

    async readiness() {
      const [rows] = await pool.query<RowDataPacket[]>(
        `SELECT COUNT(*) AS n
         FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE()
           AND (
             (TABLE_NAME = 'kaudit_user' AND COLUMN_NAME IN
               ('id','email','oidc_issuer','oidc_subject','status','max_sensitivity_tier'))
             OR
             (TABLE_NAME = 'kaudit_user_role' AND COLUMN_NAME IN ('user_id','role_code'))
           )`,
      )
      return Number(rows[0]?.n) === 8
    },
  }
}
