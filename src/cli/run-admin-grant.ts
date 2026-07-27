import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import mysql, {
  type PoolConnection,
  type RowDataPacket,
} from 'mysql2/promise'
import {
  AUDIT_GENESIS_HASH,
  hashAuditEntry,
} from '../audit/hashChain.ts'
import type { AuditEvent } from '../audit/types.ts'
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

interface CountRow extends RowDataPacket {
  n: number | string
}

interface HeadRow extends RowDataPacket {
  head_hash: string
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

async function supportsHashChainedAudit(
  connection: PoolConnection,
): Promise<boolean> {
  const [rows] = await connection.query<CountRow[]>(
    `SELECT COUNT(*) AS n
     FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = 'kaudit_audit_log'
       AND COLUMN_NAME IN
         ('actor_user_id','outcome','purpose','previous_hash','entry_hash')`,
  )
  return Number(rows[0]?.n) === 5
}

async function recordGrantAudit(
  connection: PoolConnection,
  event: AuditEvent,
): Promise<'hash-chained' | 'legacy'> {
  const id = randomUUID()
  if (await supportsHashChainedAudit(connection)) {
    await connection.execute(
      `INSERT INTO kaudit_audit_chain_head
         (chain_name, head_hash, head_event_id)
       VALUES ('primary', ?, NULL)
       ON DUPLICATE KEY UPDATE chain_name = chain_name`,
      [AUDIT_GENESIS_HASH],
    )
    const [rows] = await connection.execute<HeadRow[]>(
      `SELECT head_hash
       FROM kaudit_audit_chain_head
       WHERE chain_name = 'primary'
       FOR UPDATE`,
    )
    const previousHash = rows[0]?.head_hash ?? AUDIT_GENESIS_HASH
    const entryHash = hashAuditEntry(id, previousHash, event)
    await connection.execute(
      `INSERT INTO kaudit_audit_log
         (id, actor_email, actor_user_id, action, resource_type, resource_id,
          before_hash, after_hash, ip_address, client, correlation_id,
          outcome, purpose, previous_hash, entry_hash, occurred_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        event.actorEmail,
        event.actorUserId,
        event.action,
        event.resourceType,
        event.resourceId,
        event.beforeHash ?? null,
        event.afterHash ?? null,
        event.ipAddress,
        event.client,
        event.correlationId,
        event.outcome,
        event.purpose,
        previousHash,
        entryHash,
        event.occurredAt,
      ],
    )
    await connection.execute(
      `UPDATE kaudit_audit_chain_head
       SET head_hash = ?, head_event_id = ?, updated_at = ?
       WHERE chain_name = 'primary'`,
      [entryHash, id, event.occurredAt],
    )
    return 'hash-chained'
  }

  await connection.execute(
    `INSERT INTO kaudit_audit_log
       (id, actor_email, action, resource_type, resource_id, before_hash,
        after_hash, ip_address, client, correlation_id, occurred_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      event.actorEmail,
      event.action,
      event.resourceType,
      event.resourceId,
      event.beforeHash ?? null,
      event.afterHash ?? null,
      event.ipAddress,
      event.client,
      event.correlationId,
      event.occurredAt,
    ],
  )
  return 'legacy'
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
    ssl: sslCaFile
      ? {
          ca: fs.readFileSync(sslCaFile, 'utf8'),
          rejectUnauthorized: true,
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
    const auditMode = await recordGrantAudit(connection, {
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
