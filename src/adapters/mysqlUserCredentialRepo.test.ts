import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Pool } from 'mysql2/promise'
import {
  REQUIRED_CREDENTIAL_COLUMN_COUNT,
  USER_CREDENTIAL_SQL,
  createMysqlUserCredentialRepository,
} from './mysqlUserCredentialRepo.ts'

/**
 * SQL contract of the read-only credential repository. No database is
 * contacted: a recording fake pool captures every statement and its bound
 * parameters, and every identity is synthetic.
 */

interface Call {
  sql: string
  parameters: unknown[]
}

function fakePool(rows: Record<string, unknown>[] = []) {
  const calls: Call[] = []
  const queries: Call[] = []
  const pool = {
    async execute(sql: string, parameters: unknown[] = []) {
      calls.push({ sql, parameters })
      return [rows]
    },
    async query(sql: string, parameters: unknown[] = []) {
      queries.push({ sql, parameters })
      return [rows]
    },
    async getConnection() {
      throw new Error('a read-only repository must never open a transaction')
    },
  } as unknown as Pool
  return { pool, calls, queries }
}

const SYNTHETIC_HASH =
  'scrypt$N=16384,r=8,p=1$c3ludGhldGljLXNhbHQtdmFsdWU$c3ludGhldGljLWRpZ2VzdC12YWx1ZS1mb3ItdGVzdHM'

function credentialRow(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: 'usr_synthetic0001',
    email: 'audit.admin@example.test',
    status: 'active',
    max_sensitivity_tier: 'K1',
    username_normalized: 'audit.admin',
    password_hash: SYNTHETIC_HASH,
    session_version: 3,
    credential_status: 'active',
    roles: 'call_audit_viewer,platform_admin',
    ...overrides,
  }
}

function sessionStateRow(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: 'usr_synthetic0001',
    status: 'active',
    credential_status: 'active',
    session_version: 4,
    ...overrides,
  }
}

/** A row shape no production write could produce: corrupt, tampered, or lost. */
const MALFORMED_ROW_OVERRIDES: Record<string, unknown>[] = [
  { session_version: 0 },
  { session_version: -1 },
  { session_version: 1.5 },
  { session_version: Number.NaN },
  { session_version: Number.POSITIVE_INFINITY },
  { session_version: '3.5' },
  { session_version: ' 3' },
  { session_version: 'three' },
  { session_version: '' },
  { session_version: null },
  { session_version: undefined },
  { session_version: 4294967296 }, // past the int unsigned column range
  { session_version: '99999999999' },
  { session_version: {} },
  { id: '' },
  { id: 'usr with space' },
  { id: "usr_1' OR '1'='1" },
  { id: 'a'.repeat(41) },
  { id: null },
  { id: 7 },
]

function describeOverride(overrides: Record<string, unknown>): string {
  const [key, value] = Object.entries(overrides)[0]
  return `${key}=${String(value)}`
}

const ALL_SQL = Object.values(USER_CREDENTIAL_SQL)

// ---------------------------------------------------------------------------
// Read-only, parameterized, no dynamic identifiers
// ---------------------------------------------------------------------------

test('the repository contains no write, lock, or external-table statement', () => {
  for (const sql of ALL_SQL) {
    for (const forbidden of [
      'INSERT',
      'UPDATE',
      'DELETE',
      'REPLACE',
      'ALTER',
      'FOR UPDATE',
      'LOCK',
      'ai_voice_leads_received',
      'kcrm',
    ]) {
      assert.equal(
        sql.toUpperCase().includes(forbidden.toUpperCase()),
        false,
        `${forbidden} appears in a read-only statement`,
      )
    }
  }
})

test('every statement names only kaudit_ tables and information_schema', () => {
  for (const sql of ALL_SQL) {
    for (const [, table] of sql.matchAll(/(?:FROM|JOIN)\s+([a-z_.]+)/gi)) {
      assert.ok(
        table.startsWith('kaudit_') || table === 'information_schema.COLUMNS',
        `unexpected table ${table}`,
      )
    }
  }
})

test('no statement selects a wildcard or concatenates a value', () => {
  for (const sql of ALL_SQL) {
    assert.equal(sql.includes('SELECT *'), false)
    // The only string literals are the fixed information_schema column names in
    // the readiness probe; no filter compares against an inlined value.
    if (sql !== USER_CREDENTIAL_SQL.readiness) {
      assert.equal(/=\s*'/.test(sql), false, sql)
    }
  }
})

test('the login lookup binds kind, username, and email as parameters', async () => {
  const { pool, calls } = fakePool([credentialRow()])
  const repository = createMysqlUserCredentialRepository(pool)
  await repository.findByLogin('  Audit.Admin  ')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].sql, USER_CREDENTIAL_SQL.selectByLogin)
  // The login is normalized once and bound to both columns; kind is bound too.
  assert.deepEqual(calls[0].parameters, ['user', 'audit.admin', 'audit.admin'])
  assert.match(calls[0].sql, /WHERE u\.kind = \?/)
  assert.match(
    calls[0].sql,
    /\(c\.username_normalized = \? OR u\.email = \?\)/,
  )
  assert.match(calls[0].sql, /LIMIT 1/)

  // An email login normalizes the same way and reaches the same statement.
  await repository.findByLogin('Audit.Admin@Example.TEST')
  assert.deepEqual(calls[1].parameters, [
    'user',
    'audit.admin@example.test',
    'audit.admin@example.test',
  ])
})

test('an unusable login never reaches a statement', async () => {
  const { pool, calls } = fakePool([credentialRow()])
  const repository = createMysqlUserCredentialRepository(pool)
  for (const login of [
    '',
    '   ',
    'ab',
    "admin' OR '1'='1",
    'admin; DROP TABLE kaudit_user_credential',
    'admin@@example.test',
    'a'.repeat(300),
    null,
    7,
  ]) {
    assert.equal(await repository.findByLogin(login as string), null, String(login))
  }
  assert.equal(calls.length, 0)
})

// ---------------------------------------------------------------------------
// Mapping: only what authentication and authorization need
// ---------------------------------------------------------------------------

test('an active credential maps to exactly the fields needed to authenticate', async () => {
  const { pool } = fakePool([credentialRow()])
  const user = await createMysqlUserCredentialRepository(pool).findByLogin(
    'audit.admin',
  )
  assert.deepEqual(user, {
    id: 'usr_synthetic0001',
    usernameNormalized: 'audit.admin',
    email: 'audit.admin@example.test',
    status: 'active',
    credentialStatus: 'active',
    passwordHash: SYNTHETIC_HASH,
    sessionVersion: 3,
    maxSensitivityTier: 'K1',
    roles: ['call_audit_viewer', 'platform_admin'],
  })
  // Nothing else about the person travels with a login result.
  for (const forbidden of [
    'displayName',
    'lastLoginAt',
    'oidcIssuer',
    'oidcSubject',
    'passwordChangedAt',
    'createdAt',
  ]) {
    assert.equal(forbidden in (user ?? {}), false, forbidden)
  }
})

test('an inactive user or credential still maps, so the caller can fail closed', async () => {
  // The repository reports state rather than hiding the row: a disabled account
  // must be distinguishable from a missing one in the AUTHORIZATION step, and
  // the caller decides what the login box is told.
  for (const overrides of [
    { status: 'disabled' },
    { credential_status: 'disabled' },
    { credential_status: 'tombstoned' },
  ]) {
    const { pool } = fakePool([credentialRow(overrides)])
    const user = await createMysqlUserCredentialRepository(pool).findByLogin(
      'audit.admin',
    )
    assert.ok(user)
    assert.equal(
      user.status === 'active' && user.credentialStatus === 'active',
      false,
      JSON.stringify(overrides),
    )
  }
})

test('a user with no roles and no email maps to empty and null, not to undefined', async () => {
  const { pool } = fakePool([credentialRow({ roles: null, email: null })])
  const user = await createMysqlUserCredentialRepository(pool).findByLogin(
    'audit.admin',
  )
  assert.deepEqual(user?.roles, [])
  assert.equal(user?.email, null)
})

test('an unknown login is absent, not an error', async () => {
  const { pool } = fakePool([])
  assert.equal(
    await createMysqlUserCredentialRepository(pool).findByLogin('no.such.user'),
    null,
  )
})

test('session_version is mapped as an integer whatever the driver returns', async () => {
  for (const raw of [3, '3']) {
    const { pool } = fakePool([credentialRow({ session_version: raw })])
    const user = await createMysqlUserCredentialRepository(pool).findByLogin(
      'audit.admin',
    )
    assert.equal(user?.sessionVersion, 3)
    assert.equal(Number.isInteger(user?.sessionVersion), true)
  }
})

test('a credential row with a malformed id or session version fails closed', async () => {
  // Number() would have turned NULL into 0, text into NaN, and '3.5' into a
  // fraction — each one a "user" whose session no session_version increment
  // could revoke. A row the database could not legally hold is not a login.
  for (const overrides of MALFORMED_ROW_OVERRIDES) {
    const { pool } = fakePool([credentialRow(overrides)])
    assert.equal(
      await createMysqlUserCredentialRepository(pool).findByLogin('audit.admin'),
      null,
      describeOverride(overrides),
    )
  }
})

// ---------------------------------------------------------------------------
// Per-request revocation read
// ---------------------------------------------------------------------------

test('the session state read binds a checked user id', async () => {
  const { pool, calls } = fakePool([
    {
      id: 'usr_synthetic0001',
      status: 'active',
      credential_status: 'active',
      session_version: 4,
    },
  ])
  const repository = createMysqlUserCredentialRepository(pool)
  const state = await repository.getSessionState('usr_synthetic0001')
  assert.equal(calls[0].sql, USER_CREDENTIAL_SQL.selectSessionState)
  assert.deepEqual(calls[0].parameters, ['user', 'usr_synthetic0001'])
  assert.deepEqual(state, {
    id: 'usr_synthetic0001',
    status: 'active',
    credentialStatus: 'active',
    sessionVersion: 4,
  })
  // The revocation check must never carry password material.
  assert.equal(calls[0].sql.includes('password_hash'), false)
})

test('an id that is not a user id never reaches a statement', async () => {
  const { pool, calls } = fakePool([])
  const repository = createMysqlUserCredentialRepository(pool)
  for (const id of [
    '',
    "usr_1' OR '1'='1",
    'usr_1; DROP TABLE kaudit_user_credential',
    'usr with space',
    'a'.repeat(41),
    null,
    7,
  ]) {
    assert.equal(await repository.getSessionState(id as string), null, String(id))
  }
  assert.equal(calls.length, 0)
})

test('a malformed session state row is refused, not rounded into a version', async () => {
  for (const overrides of MALFORMED_ROW_OVERRIDES) {
    const { pool } = fakePool([sessionStateRow(overrides)])
    assert.equal(
      await createMysqlUserCredentialRepository(pool).getSessionState(
        'usr_synthetic0001',
      ),
      null,
      describeOverride(overrides),
    )
  }
})

test('a disabled session state still maps, so the gate can deny it deliberately', async () => {
  // Fail-closed mapping must not swallow state: isSessionCurrent has to SEE a
  // disabled or tombstoned row to reject it, and a bumped version to revoke.
  for (const overrides of [
    { status: 'disabled' },
    { credential_status: 'tombstoned' },
    { session_version: 9 },
    { session_version: '9' },
  ]) {
    const { pool } = fakePool([sessionStateRow(overrides)])
    const state = await createMysqlUserCredentialRepository(
      pool,
    ).getSessionState('usr_synthetic0001')
    assert.ok(state, describeOverride(overrides))
    assert.equal(Number.isInteger(state.sessionVersion), true)
  }
})

test('a user with no credential row has no session state', async () => {
  const { pool } = fakePool([])
  assert.equal(
    await createMysqlUserCredentialRepository(pool).getSessionState(
      'usr_synthetic0002',
    ),
    null,
  )
})

// ---------------------------------------------------------------------------
// Readiness
// ---------------------------------------------------------------------------

test('readiness is true only when every migration 0009 column is present', async () => {
  const present = fakePool([{ n: REQUIRED_CREDENTIAL_COLUMN_COUNT }])
  assert.equal(
    await createMysqlUserCredentialRepository(present.pool).readiness(),
    true,
  )
  assert.equal(present.queries[0].sql, USER_CREDENTIAL_SQL.readiness)
  assert.match(present.queries[0].sql, /TABLE_SCHEMA = DATABASE\(\)/)
  assert.match(present.queries[0].sql, /'kaudit_user_credential'/)

  for (const rows of [
    [{ n: REQUIRED_CREDENTIAL_COLUMN_COUNT - 1 }],
    [{ n: 0 }],
    [{ n: null }],
    [],
  ]) {
    const { pool } = fakePool(rows)
    assert.equal(
      await createMysqlUserCredentialRepository(pool).readiness(),
      false,
      JSON.stringify(rows),
    )
  }
})
