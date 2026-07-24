import type { Pool } from 'mysql2/promise'
import { randomUUID } from 'node:crypto'
import type { IdentityRepo } from '../identity/ports.ts'

// Idempotent writes of the user directory + role assignments. Requires migration 0003.
export function createMysqlIdentityRepo(pool: Pool): IdentityRepo {
  return {
    async upsertUsers(users): Promise<{ inserted: number; existing: number }> {
      let inserted = 0
      let existing = 0
      for (const u of users) {
        // Real users keyed by email; system actors keyed by ('system', name).
        const isUser = u.kind === 'user'
        const [res] = (await pool.query(
          isUser
            ? `INSERT INTO kaudit_user (id, kind, email) VALUES (?, 'user', ?)
               ON DUPLICATE KEY UPDATE id = id`
            : `INSERT INTO kaudit_user (id, kind, oidc_issuer, oidc_subject) VALUES (?, 'system', 'system', ?)
               ON DUPLICATE KEY UPDATE id = id`,
          [randomUUID(), u.identity],
        )) as any
        if (res.affectedRows === 1) inserted += 1
        else existing += 1
      }
      return { inserted, existing }
    },

    async assignRole(userKeys, roleCode): Promise<number> {
      let count = 0
      for (const key of userKeys) {
        const isUser = key.startsWith('user:')
        const identity = key.slice(key.indexOf(':') + 1)
        const [userRows] = (await pool.query(
          isUser
            ? `SELECT id FROM kaudit_user WHERE email = ? LIMIT 1`
            : `SELECT id FROM kaudit_user WHERE oidc_issuer = 'system' AND oidc_subject = ? LIMIT 1`,
          [identity],
        )) as any
        const userId = userRows[0]?.id
        if (!userId) continue
        await pool.query(
          `INSERT INTO kaudit_user_role (id, user_id, role_code) VALUES (?, ?, ?)
           ON DUPLICATE KEY UPDATE id = id`,
          [randomUUID(), userId, roleCode],
        )
        count += 1
      }
      return count
    },
  }
}
