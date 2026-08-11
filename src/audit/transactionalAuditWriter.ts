import { randomUUID } from 'node:crypto'
import { AUDIT_GENESIS_HASH, hashAuditEntry } from './hashChain.ts'
import type { AuditEvent } from './types.ts'

/**
 * Writes one audit event on a connection whose transaction the CALLER owns.
 *
 * This is the shape an operator command needs and `createMysqlAuditSink` cannot
 * provide: the sink opens its own transaction and commits it, so an event
 * written through it would survive a rolled-back change. Here the event is
 * appended inside the caller's transaction, which means a failure anywhere after
 * it — including in this function — takes the change down with it, and a change
 * that cannot be audited is not made.
 *
 * The body is the one lifted out of `run-admin-grant.ts` unchanged; the grant
 * command now calls it instead of carrying its own copy, so the chain-head
 * locking order and the pre-0004 fallback have exactly one implementation.
 */

/** Whether the event joined the hash chain or used the legacy columns. */
export type AuditWriteMode = 'hash-chained' | 'legacy'

/**
 * The narrow slice of a pooled connection this module uses.
 *
 * Structural on purpose: it keeps the module testable against a recording fake,
 * and it makes visible that nothing here begins, commits, or rolls back — those
 * belong to the caller.
 */
export interface TransactionalAuditConnection {
  // The driver's own parameter type is narrower than `unknown[]` and its result
  // type is a union of six row shapes. Both are widened here so a real
  // `PoolConnection` and a recording fake satisfy this without a cast at the
  // call site; every result is narrowed defensively below before it is read.
  execute(sql: string, values?: any): Promise<unknown>
  query(sql: string, values?: any): Promise<unknown>
}

interface CountRow {
  n: number | string
}

interface HeadRow {
  head_hash: string
}

function firstRow<T>(result: unknown): T | undefined {
  const rows = Array.isArray(result) ? (result[0] as unknown) : undefined
  return Array.isArray(rows) ? (rows[0] as T | undefined) : undefined
}

/**
 * Whether migration 0004 has been applied.
 *
 * All five columns or none: a partially applied migration must not produce a
 * row that claims chain membership it does not have.
 */
export async function supportsHashChainedAudit(
  connection: TransactionalAuditConnection,
): Promise<boolean> {
  const result = await connection.query(
    `SELECT COUNT(*) AS n
     FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = 'kaudit_audit_log'
       AND COLUMN_NAME IN
         ('actor_user_id','outcome','purpose','previous_hash','entry_hash')`,
  )
  return Number(firstRow<CountRow>(result)?.n) === 5
}

/**
 * Appends the event, chaining it when the schema supports chaining.
 *
 * The chain head is locked `FOR UPDATE` before the entry hash is computed, so
 * two concurrent writers serialize on it rather than both extending the same
 * predecessor. Before 0004 the event is still recorded, using the legacy
 * columns — an unchained audit row is worth more than none.
 */
export async function recordAuditEventInTransaction(
  connection: TransactionalAuditConnection,
  event: AuditEvent,
  eventId: string = randomUUID(),
): Promise<AuditWriteMode> {
  if (await supportsHashChainedAudit(connection)) {
    await connection.execute(
      `INSERT INTO kaudit_audit_chain_head
         (chain_name, head_hash, head_event_id)
       VALUES ('primary', ?, NULL)
       ON DUPLICATE KEY UPDATE chain_name = chain_name`,
      [AUDIT_GENESIS_HASH],
    )
    const head = await connection.execute(
      `SELECT head_hash
       FROM kaudit_audit_chain_head
       WHERE chain_name = 'primary'
       FOR UPDATE`,
    )
    const previousHash = firstRow<HeadRow>(head)?.head_hash ?? AUDIT_GENESIS_HASH
    const entryHash = hashAuditEntry(eventId, previousHash, event)
    await connection.execute(
      `INSERT INTO kaudit_audit_log
         (id, actor_email, actor_user_id, action, resource_type, resource_id,
          before_hash, after_hash, ip_address, client, correlation_id,
          outcome, purpose, previous_hash, entry_hash, occurred_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        eventId,
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
      [entryHash, eventId, event.occurredAt],
    )
    return 'hash-chained'
  }

  await connection.execute(
    `INSERT INTO kaudit_audit_log
       (id, actor_email, action, resource_type, resource_id, before_hash,
        after_hash, ip_address, client, correlation_id, occurred_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      eventId,
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
