import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  recordAuditEventInTransaction,
  supportsHashChainedAudit,
  type TransactionalAuditConnection,
} from './transactionalAuditWriter.ts'
import { AUDIT_GENESIS_HASH, hashAuditEntry } from './hashChain.ts'
import type { AuditEvent } from './types.ts'

/**
 * The audit append that two operator commands share.
 *
 * It was `recordGrantAudit` inside `run-admin-grant.ts`, where an entry point
 * that opens a pool at module scope made it untestable. Lifting it out changed
 * no behaviour — these tests pin the behaviour it must keep — and it is what
 * `bindOidcIdentity` now records through, so the chain-head locking order and
 * the pre-0004 fallback have exactly one implementation.
 */

interface Call {
  sql: string
  parameters: unknown[]
}

function fakeConnection(columnCount: number, failOn?: string) {
  const calls: Call[] = []
  const transaction: string[] = []

  async function run(sql: string, parameters: unknown[] = []) {
    calls.push({ sql, parameters })
    if (failOn && sql.includes(failOn)) throw new Error('driver fault')
    if (sql.includes('information_schema.COLUMNS')) {
      return [[{ n: columnCount }], []]
    }
    if (sql.includes('SELECT head_hash')) {
      return [[{ head_hash: HEAD }], []]
    }
    return [[], []]
  }

  const connection: TransactionalAuditConnection & {
    beginTransaction(): Promise<void>
    commit(): Promise<void>
    rollback(): Promise<void>
  } = {
    execute: run,
    query: run,
    async beginTransaction() {
      transaction.push('begin')
    },
    async commit() {
      transaction.push('commit')
    },
    async rollback() {
      transaction.push('rollback')
    },
  }

  return {
    connection,
    calls,
    transaction,
    find(match: string) {
      return calls.find((call) => call.sql.includes(match))
    },
  }
}

const HEAD = 'a'.repeat(64)
const OCCURRED_AT = new Date('2026-08-11T09:00:00.000Z')

const EVENT: AuditEvent = {
  actorUserId: 'user-1',
  actorEmail: null,
  action: 'USER_OIDC_IDENTITY_BOUND',
  resourceType: 'kaudit_user',
  resourceId: 'user-1',
  outcome: 'success',
  purpose: 'identity_provisioning',
  correlationId: 'correlation-1',
  ipAddress: null,
  client: 'w1:bind-oidc',
  beforeHash: null,
  afterHash: 'b'.repeat(64),
  occurredAt: OCCURRED_AT,
}

test('migration 0004 is detected by all five columns, never a subset', async () => {
  for (const [columns, expected] of [
    [5, true],
    [4, false],
    [0, false],
  ] as const) {
    const fake = fakeConnection(columns)
    assert.equal(await supportsHashChainedAudit(fake.connection), expected)
  }
})

test('a chained event locks the head, links to it, and advances it', async () => {
  const fake = fakeConnection(5)
  const mode = await recordAuditEventInTransaction(
    fake.connection,
    EVENT,
    'event-1',
  )

  assert.equal(mode, 'hash-chained')
  // The head row is ensured, then locked, before any hash is computed.
  assert.ok(fake.find('INSERT INTO kaudit_audit_chain_head'))
  assert.match(fake.find('SELECT head_hash')?.sql ?? '', /FOR UPDATE/)

  const entryHash = hashAuditEntry('event-1', HEAD, EVENT)
  const insert = fake.find('INSERT INTO kaudit_audit_log')
  assert.ok(insert)
  assert.equal(insert.parameters[0], 'event-1')
  assert.ok(insert.parameters.includes(HEAD))
  assert.ok(insert.parameters.includes(entryHash))

  const advance = fake.find('UPDATE kaudit_audit_chain_head')
  assert.ok(advance)
  assert.deepEqual(advance.parameters, [entryHash, 'event-1', OCCURRED_AT])
})

test('an empty chain starts from the genesis hash', async () => {
  const fake = fakeConnection(5)
  // The head select returns nothing when the ensure-row insert has not yet been
  // seen by this transaction.
  const connection: TransactionalAuditConnection = {
    ...fake.connection,
    async execute(sql: string, values?: unknown[]) {
      if (sql.includes('SELECT head_hash')) {
        fake.calls.push({ sql, parameters: values ?? [] })
        return [[], []]
      }
      return fake.connection.execute(sql, values)
    },
  }

  await recordAuditEventInTransaction(connection, EVENT, 'event-1')
  const insert = fake.find('INSERT INTO kaudit_audit_log')
  assert.ok(insert?.parameters.includes(AUDIT_GENESIS_HASH))
})

test('before 0004 the event is still recorded, on the legacy columns', async () => {
  const fake = fakeConnection(0)
  const mode = await recordAuditEventInTransaction(
    fake.connection,
    EVENT,
    'event-1',
  )

  assert.equal(mode, 'legacy')
  const insert = fake.find('INSERT INTO kaudit_audit_log')
  assert.ok(insert)
  assert.equal(/previous_hash|entry_hash|outcome|purpose/.test(insert.sql), false)
  assert.equal(fake.find('kaudit_audit_chain_head'), undefined)
})

test('the caller owns the transaction; this function never ends one', async () => {
  for (const columns of [5, 0]) {
    const fake = fakeConnection(columns)
    await recordAuditEventInTransaction(fake.connection, EVENT, 'event-1')
    assert.deepEqual(fake.transaction, [])
  }
})

test('a failed append propagates so the caller can roll back', async () => {
  const fake = fakeConnection(5, 'INSERT INTO kaudit_audit_log')
  await assert.rejects(
    recordAuditEventInTransaction(fake.connection, EVENT, 'event-1'),
  )
  assert.deepEqual(fake.transaction, [])
})
