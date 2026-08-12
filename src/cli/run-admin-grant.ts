import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import mysql, {
  type PoolConnection,
  type RowDataPacket,
} from 'mysql2/promise'
import { recordAuditEventInTransaction } from '../audit/transactionalAuditWriter.ts'
import {
  planAdminGrant,
  targetAdminAccessState,
  type ExistingAdminIdentity,
} from '../identity/adminGrant.ts'
import { sha256Hex } from '../lib/hash.ts'

interface UserRow extends RowDataPacket {
  id: string
  email: string
  status: string
  max_sensitivity_tier: string
}

interface RoleRow extends RowDataPacket {
  role_code: string
}

function required(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`${name} is required`)
  return value
}

function stateHash(value: unknown): string {
  return sha256Hex(JSON.stringify(value))
}

async function loadIdentity(
  connection: PoolConnection,
  email: string,
): Promise<ExistingAdminIdentity | null> {
  const [users] = await connection.execute<UserRow[]>(
    `SELECT id, email, status, max_sensitivity_tier
     FROM kaudit_user
     WHERE email = ?
     LIMIT 1
     FOR UPDATE`,
    [email],
  )
  const user = users[0]
  if (!user) return null
  const [roles] = await connection.execute<RoleRow[]>(
    `SELECT role_code
     FROM kaudit_user_role
     WHERE user_id = ?
     ORDER BY role_code`,
    [user.id],
  )
  return {
    id: user.id,
    email: user.email,
    status: user.status,
    maxSensitivityTier: user.max_sensitivity_tier,
    roles: roles.map((row) => row.role_code),
  }
}

async function main(): Promise<void> {
  const execute = process.env.KAUDIT_ADMIN_MODE?.trim() === 'EXECUTE'
  const emailInput = required('KAUDIT_ADMIN_EMAIL')
  const sslCaFile = process.env.DB_SSL_CA_FILE?.trim()
  const pool = mysql.createPool({
    host: required('DB_HOST'),
    port: Number(process.env.DB_PORT || 3306),
    database: required('DB_NAME'),
    user: required('DB_USER'),
    password: required('DB_PASSWORD'),
    // Both flags, always: mysql2 skips the hostname check unless
    // `verifyIdentity` is set, so a CA-only pool would accept any host holding
    // any certificate the configured authority ever issued.
    ssl: sslCaFile
      ? {
          ca: fs.readFileSync(sslCaFile, 'utf8'),
          rejectUnauthorized: true,
          verifyIdentity: true,
        }
      : undefined,
    connectionLimit: 2,
    connectTimeout: 30_000,
  })
  const connection = await pool.getConnection()

  try {
    await connection.beginTransaction()
    const normalizedEmail = emailInput.trim().toLowerCase()
    const current = await loadIdentity(connection, normalizedEmail)
    const plan = planAdminGrant(emailInput, current)
    const target = targetAdminAccessState(
      plan.email,
      current?.roles ?? [],
    )

    if (!execute) {
      await connection.rollback()
      console.log(
        JSON.stringify(
          {
            mode: 'dry-run',
            plan,
            target,
            passwordStoredByApplication: false,
          },
          null,
          2,
        ),
      )
      return
    }

    if (plan.alreadyFullyAuthorized) {
      await connection.rollback()
      console.log(
        JSON.stringify(
          {
            mode: 'execute',
            result: 'no-op',
            userId: current!.id,
            email: plan.email,
            status: 'active',
            roles: target.roles,
            maxSensitivityTier: target.maxSensitivityTier,
            passwordStoredByApplication: false,
          },
          null,
          2,
        ),
      )
      return
    }

    const userId = current?.id ?? randomUUID()
    if (!current) {
      await connection.execute(
        `INSERT INTO kaudit_user
           (id, kind, email, max_sensitivity_tier, status)
         VALUES (?, 'user', ?, 'K3', 'active')`,
        [userId, plan.email],
      )
    } else {
      await connection.execute(
        `UPDATE kaudit_user
         SET kind = 'user',
             status = 'active',
             max_sensitivity_tier = 'K3',
             updated_at = CURRENT_TIMESTAMP(6)
         WHERE id = ?`,
        [userId],
      )
    }

    await connection.execute(
      `INSERT INTO kaudit_user_role
         (id, user_id, role_code, granted_by)
       VALUES (?, ?, 'admin', ?)
       ON DUPLICATE KEY UPDATE
         granted_by = VALUES(granted_by),
         granted_at = CURRENT_TIMESTAMP(6)`,
      [randomUUID(), userId, `bootstrap:${plan.email}`],
    )

    const occurredAt = new Date()
    const auditMode = await recordAuditEventInTransaction(connection, {
      actorUserId: userId,
      actorEmail: plan.email,
      action: 'USER_ADMIN_ACCESS_GRANTED',
      resourceType: 'kaudit_user',
      resourceId: userId,
      outcome: 'success',
      purpose: 'identity_provisioning',
      correlationId: randomUUID(),
      ipAddress: null,
      client: 'w1:grant-admin',
      beforeHash: current ? stateHash(current) : null,
      afterHash: stateHash(target),
      occurredAt,
    })
    await connection.commit()

    console.log(
      JSON.stringify(
        {
          mode: 'execute',
          userId,
          email: plan.email,
          status: 'active',
          roles: target.roles,
          maxSensitivityTier: target.maxSensitivityTier,
          auditMode,
          passwordStoredByApplication: false,
        },
        null,
        2,
      ),
    )
  } catch (error) {
    await connection.rollback()
    throw error
  } finally {
    connection.release()
    await pool.end()
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : 'Admin grant failed')
  process.exit(1)
})
