import { randomUUID } from 'node:crypto'
import type { Pool, RowDataPacket } from 'mysql2/promise'
import {
  AUDIT_GENESIS_HASH,
  hashAuditEntry,
} from '../audit/hashChain.ts'
import type { AuditSink } from '../audit/types.ts'

interface HeadRow extends RowDataPacket {
  head_hash: string
}

export function createMysqlAuditSink(pool: Pool): AuditSink {
  return {
    async record(event) {
      const connection = await pool.getConnection()
      const id = randomUUID()
      try {
        await connection.beginTransaction()
        await connection.execute(
          `INSERT INTO kaudit_audit_chain_head
             (chain_name, head_hash, head_event_id)
           VALUES ('primary', ?, NULL)
           ON DUPLICATE KEY UPDATE chain_name = chain_name`,
          [AUDIT_GENESIS_HASH],
        )
        const [rows] = await connection.execute<HeadRow[]>(
          `SELECT head_hash FROM kaudit_audit_chain_head
           WHERE chain_name = 'primary' FOR UPDATE`,
        )
        const previousHash =
          rows[0]?.head_hash ?? AUDIT_GENESIS_HASH
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
        await connection.commit()
      } catch (error) {
        await connection.rollback()
        throw error
      } finally {
        connection.release()
      }
    },

    async readiness() {
      const [rows] = await pool.query<RowDataPacket[]>(
        `SELECT COUNT(*) AS n
         FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE()
           AND TABLE_NAME = 'kaudit_audit_log'
           AND COLUMN_NAME IN
             ('actor_user_id','outcome','purpose','previous_hash','entry_hash')`,
      )
      return Number(rows[0]?.n) === 5
    },
  }
}
