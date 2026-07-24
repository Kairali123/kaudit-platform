import { sha256Hex } from '../lib/hash.ts'
import type { AuditEvent } from './types.ts'

export const AUDIT_GENESIS_HASH = '0'.repeat(64)

export function hashAuditEntry(
  id: string,
  previousHash: string,
  event: AuditEvent,
): string {
  return sha256Hex(
    JSON.stringify([
      id,
      previousHash,
      event.actorUserId,
      event.actorEmail,
      event.action,
      event.resourceType,
      event.resourceId,
      event.outcome,
      event.purpose,
      event.correlationId,
      event.ipAddress,
      event.client,
      event.beforeHash ?? null,
      event.afterHash ?? null,
      event.occurredAt.toISOString(),
    ]),
  )
}
