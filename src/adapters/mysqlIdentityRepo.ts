import type { Pool } from 'mysql2/promise'
import { randomUUID } from 'node:crypto'
import type { IdentityRepo } from '../identity/ports.ts'
import type { ResolvedUser } from '../identity/buildUserSet.ts'

// Idempotent writes of the identity foundation. Requires migration 0003 applied.
export function createMysqlIdentityRepo(pool: Pool): IdentityRepo {
  return {
    async ensureTenant(id, name): Promise<void> {
      await pool.query(
        `INSERT INTO kaudit_tenant (id, name) VALUES (?, ?)
         ON DUPLICATE KEY UPDATE name = VALUES(name)`,
        [id, name],
      )
    },

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

    async upsertMemberships(tenantId, userKeys, defaultRole): Promise<number> {
      // Resolve each user key back to its kaudit_user.id, then upsert a membership.
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
          `INSERT INTO kaudit_membership (id, tenant_id, user_id, role_code) VALUES (?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE id = id`,
          [randomUUID(), tenantId, userId, defaultRole],
        )
        count += 1
      }
      return count
    },
  }
}
