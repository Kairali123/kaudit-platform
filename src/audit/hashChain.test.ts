import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  AUDIT_GENESIS_HASH,
  hashAuditEntry,
} from './hashChain.ts'
import type { AuditEvent } from './types.ts'

const event: AuditEvent = {
  actorUserId: 'user-1',
  actorEmail: 'operator@example.test',
  action: 'dashboard.read',
  resourceType: 'dashboard',
  resourceId: null,
  outcome: 'success',
  purpose: 'audit_operations',
  correlationId: 'corr-1',
  ipAddress: '127.0.0.1',
  client: 'synthetic-test',
  occurredAt: new Date('2026-07-24T10:00:00.000Z'),
}

test('audit hash is deterministic and binds the previous entry', () => {
  const first = hashAuditEntry(
    'event-1',
    AUDIT_GENESIS_HASH,
    event,
  )
  assert.equal(first.length, 64)
  assert.equal(
    first,
    hashAuditEntry('event-1', AUDIT_GENESIS_HASH, event),
  )
  assert.notEqual(
    first,
    hashAuditEntry('event-1', '1'.repeat(64), event),
  )
})

test('audit hash changes when the recorded decision changes', () => {
  assert.notEqual(
    hashAuditEntry('event-1', AUDIT_GENESIS_HASH, event),
    hashAuditEntry('event-1', AUDIT_GENESIS_HASH, {
      ...event,
      outcome: 'denied',
    }),
  )
})
