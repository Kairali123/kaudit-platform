import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  bindOidcIdentity,
  OidcBindingWriteError,
  OIDC_BINDING_SQL,
  OIDC_BIND_WRITE_CODES,
  type OidcBindingConnection,
} from './mysqlOidcBinding.ts'
import {
  oidcBindingHash,
  OIDC_BINDING_AUDIT_ACTION,
  OIDC_BINDING_AUDIT_CLIENT,
  OIDC_BIND_REFUSAL_CODES,
  type NormalizedOidcBinding,
} from '../identity/oidcBinding.ts'

// ---------------------------------------------------------------------------
// Recording fake connection. No database is ever contacted.
// ---------------------------------------------------------------------------

interface Call {
  sql: string
  parameters: unknown[]
}

interface RowRule {
  match: string
  rows: unknown[]
}

interface FakeOptions {
  rows?: RowRule[]
  /** Result header returned by the guarded UPDATE. */
  affectedRows?: number
  /** Throw when a statement containing this substring runs. */
  failOn?: { match: string; error: unknown }
}

function fakeConnection(options: FakeOptions = {}) {
  const calls: Call[] = []
  const transaction: string[] = []

  async function run(sql: string, parameters: unknown[] = []) {
    calls.push({ sql, parameters })
    if (options.failOn && sql.includes(options.failOn.match)) {
      throw options.failOn.error
    }
    if (sql.includes('UPDATE kaudit_user\n')) {
      return [{ affectedRows: options.affectedRows ?? 1 }, []]
    }
    const configured = options.rows?.find((entry) => sql.includes(entry.match))
    return [configured ? configured.rows : [], []]
  }

  const connection: OidcBindingConnection = {
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
    statements() {
      return calls.map((call) => call.sql)
    },
    find(match: string) {
      return calls.find((call) => call.sql.includes(match))
    },
    all(match: string) {
      return calls.filter((call) => call.sql.includes(match))
    },
    /** Every statement that could change a row. */
    writes() {
      return calls.filter((call) =>
        /^\s*(INSERT|UPDATE|DELETE|REPLACE|ALTER|DROP)/i.test(call.sql),
      )
    },
  }
}

// ---------------------------------------------------------------------------
// Synthetic fixtures.
// ---------------------------------------------------------------------------

const REQUEST: NormalizedOidcBinding = {
  email: 'dme@kairali.com',
  issuer: 'https://accounts.example.test',
  subject: '100000000000000000001',
}

const NOW = new Date('2026-08-11T09:00:00.000Z')

/** Deterministic ids so an assertion never races a UUID. */
function ids() {
  let n = 0
  return () => `id-${(n += 1)}`
}

const FIXED = { now: () => NOW, newId: ids() }

/** The target row as MySQL returns it. */
function userRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'user-1',
    kind: 'user',
    status: 'active',
    oidc_issuer: null,
    oidc_subject: null,
    ...overrides,
  }
}

/** Migration 0004 present: the information_schema probe counts five columns. */
const CHAINED = { match: 'information_schema.COLUMNS', rows: [{ n: 5 }] }
const UNCHAINED = { match: 'information_schema.COLUMNS', rows: [{ n: 0 }] }
const ROLE_COUNT = { match: 'kaudit_user_role', rows: [{ n: 1 }] }
const NO_OWNER = { match: 'WHERE oidc_issuer = ?', rows: [] }

function target(overrides: Record<string, unknown> = {}) {
  return { match: 'WHERE email = ?', rows: [userRow(overrides)] }
}

// ---------------------------------------------------------------------------
// 1. The locking reads
// ---------------------------------------------------------------------------

test('the target and the requested identity are both read FOR UPDATE', async () => {
  const fake = fakeConnection({ rows: [target(), NO_OWNER, ROLE_COUNT, CHAINED] })
  await bindOidcIdentity(fake.connection, REQUEST, { execute: false, ...FIXED })

  const byEmail = fake.find('WHERE email = ?')
  assert.ok(byEmail)
  assert.match(byEmail.sql, /FOR UPDATE/)
  assert.deepEqual(byEmail.parameters, [REQUEST.email])

  const byIdentity = fake.find('WHERE oidc_issuer = ? AND oidc_subject = ?')
  assert.ok(byIdentity)
  assert.match(byIdentity.sql, /FOR UPDATE/)
  assert.deepEqual(byIdentity.parameters, [REQUEST.issuer, REQUEST.subject])

  // The user is located by email only — never by a subject derived from one.
  assert.equal(
    fake.statements().some((sql) => /email\s*=\s*\?[\s\S]*oidc_subject\s*=/.test(sql)),
    false,
  )
})

test('everything happens inside one transaction', async () => {
  const fake = fakeConnection({ rows: [target(), NO_OWNER, ROLE_COUNT, CHAINED] })
  await bindOidcIdentity(fake.connection, REQUEST, { execute: true, ...FIXED })
  assert.deepEqual(fake.transaction, ['begin', 'commit'])
})

// ---------------------------------------------------------------------------
// 2. Dry-run
// ---------------------------------------------------------------------------

test('dry-run reads, rolls back, and writes nothing', async () => {
  const fake = fakeConnection({ rows: [target(), NO_OWNER, ROLE_COUNT, CHAINED] })
  const result = await bindOidcIdentity(fake.connection, REQUEST, {
    execute: false,
    ...FIXED,
  })

  assert.deepEqual(result, {
    mode: 'dry-run',
    outcome: 'bind',
    refusalCode: null,
    userFound: true,
    userActive: true,
    userHasRole: true,
    bindingWritten: false,
    auditMode: null,
  })
  assert.deepEqual(fake.transaction, ['begin', 'rollback'])
  assert.deepEqual(fake.writes(), [])
})

test('dry-run is the default: only an explicit execute flag writes', async () => {
  const fake = fakeConnection({ rows: [target(), NO_OWNER, ROLE_COUNT, CHAINED] })
  const result = await bindOidcIdentity(fake.connection, REQUEST, {
    execute: false,
  })
  assert.equal(result.bindingWritten, false)
  assert.deepEqual(fake.writes(), [])
})

// ---------------------------------------------------------------------------
// 3. Execute
// ---------------------------------------------------------------------------

test('execute writes exactly one guarded UPDATE and the audit event', async () => {
  const fake = fakeConnection({ rows: [target(), NO_OWNER, ROLE_COUNT, CHAINED] })
  const result = await bindOidcIdentity(fake.connection, REQUEST, {
    execute: true,
    ...FIXED,
  })

  assert.deepEqual(result, {
    mode: 'execute',
    outcome: 'bind',
    refusalCode: null,
    userFound: true,
    userActive: true,
    userHasRole: true,
    bindingWritten: true,
    auditMode: 'hash-chained',
  })

  const updates = fake.all('UPDATE kaudit_user\n')
  assert.equal(updates.length, 1)
  assert.deepEqual(updates[0].parameters, [
    REQUEST.issuer,
    REQUEST.subject,
    'user-1',
    REQUEST.email,
  ])
  assert.deepEqual(fake.transaction, ['begin', 'commit'])
})

test('the UPDATE changes the binding and nothing else about the account', async () => {
  const setClause = OIDC_BINDING_SQL.guardedUpdate.slice(
    OIDC_BINDING_SQL.guardedUpdate.indexOf('SET'),
    OIDC_BINDING_SQL.guardedUpdate.indexOf('WHERE'),
  )
  for (const column of [
    'status',
    'kind',
    'max_sensitivity_tier',
    'display_name',
    'email',
    'last_login_at',
  ]) {
    assert.equal(
      new RegExp(`\\b${column}\\s*=`).test(setClause),
      false,
      `the binding must not set ${column}`,
    )
  }
  assert.match(setClause, /oidc_issuer = \?/)
  assert.match(setClause, /oidc_subject = \?/)

  // And no statement in the module touches roles or the external source table.
  assert.equal(/INSERT INTO kaudit_user_role|DELETE FROM kaudit_user_role/.test(
    Object.values(OIDC_BINDING_SQL).join('\n'),
  ), false)
  assert.equal(
    /ai_voice_leads_received/.test(Object.values(OIDC_BINDING_SQL).join('\n')),
    false,
  )
})

test('the UPDATE re-states every precondition the plan relied on', async () => {
  const where = OIDC_BINDING_SQL.guardedUpdate.slice(
    OIDC_BINDING_SQL.guardedUpdate.indexOf('WHERE'),
  )
  assert.match(where, /id = \?/)
  assert.match(where, /email = \?/)
  assert.match(where, /kind = 'user'/)
  assert.match(where, /oidc_issuer IS NULL/)
  assert.match(where, /oidc_subject IS NULL/)
})

test('the audit event joins the hash chain and carries no supplied value', async () => {
  const fake = fakeConnection({ rows: [target(), NO_OWNER, ROLE_COUNT, CHAINED] })
  await bindOidcIdentity(fake.connection, REQUEST, { execute: true, ...FIXED })

  const insert = fake.find('INSERT INTO kaudit_audit_log')
  assert.ok(insert)
  assert.match(insert.sql, /previous_hash, entry_hash/)
  assert.ok(insert.parameters.includes(OIDC_BINDING_AUDIT_ACTION))
  assert.ok(insert.parameters.includes('identity_provisioning'))
  assert.ok(insert.parameters.includes(oidcBindingHash(REQUEST)))

  // The chain head is locked before the entry hash is computed, and advanced.
  assert.ok(fake.find('kaudit_audit_chain_head'))
  assert.match(
    fake.find('SELECT head_hash')?.sql ?? '',
    /FOR UPDATE/,
  )
  assert.ok(fake.find('UPDATE kaudit_audit_chain_head'))

  const serialized = JSON.stringify(insert.parameters)
  for (const supplied of [REQUEST.email, REQUEST.issuer, REQUEST.subject]) {
    assert.equal(
      serialized.includes(supplied),
      false,
      `the audit row must not carry ${supplied}`,
    )
  }
})

test('the written audit row records the target as resource, not as actor', async () => {
  const fake = fakeConnection({ rows: [target(), NO_OWNER, ROLE_COUNT, CHAINED] })
  await bindOidcIdentity(fake.connection, REQUEST, { execute: true, ...FIXED })

  const insert = fake.find('INSERT INTO kaudit_audit_log')
  assert.ok(insert)
  // Positional, against the column list in the statement itself, so a reordered
  // INSERT cannot quietly move the user id into an actor column.
  const columns = insert.sql
    .slice(insert.sql.indexOf('(') + 1, insert.sql.indexOf(')'))
    .split(',')
    .map((name) => name.trim())
  const at = (column: string) => {
    const index = columns.indexOf(column)
    assert.notEqual(index, -1, `the INSERT must write ${column}`)
    return insert.parameters[index]
  }

  // The user has not authenticated and is not necessarily the operator.
  assert.equal(at('actor_user_id'), null)
  assert.equal(at('actor_email'), null)
  // The target is recorded, as the resource it is.
  assert.equal(at('resource_id'), 'user-1')
  assert.equal(at('resource_type'), 'kaudit_user')
  assert.equal(at('client'), OIDC_BINDING_AUDIT_CLIENT)
  assert.equal(at('purpose'), 'identity_provisioning')
  assert.equal(at('action'), OIDC_BINDING_AUDIT_ACTION)
  assert.equal(at('after_hash'), oidcBindingHash(REQUEST))
  assert.ok(at('correlation_id'))
})

test('before migration 0004 the event still records, using legacy columns', async () => {
  const fake = fakeConnection({
    rows: [target(), NO_OWNER, ROLE_COUNT, UNCHAINED],
  })
  const result = await bindOidcIdentity(fake.connection, REQUEST, {
    execute: true,
    ...FIXED,
  })

  assert.equal(result.auditMode, 'legacy')
  assert.equal(result.bindingWritten, true)
  const insert = fake.find('INSERT INTO kaudit_audit_log')
  assert.ok(insert)
  assert.equal(/previous_hash/.test(insert.sql), false)
  assert.equal(fake.find('kaudit_audit_chain_head'), undefined)
})

// ---------------------------------------------------------------------------
// 4. Idempotence and every refusal
// ---------------------------------------------------------------------------

test('re-running the identical binding is a no-op that writes nothing', async () => {
  for (const execute of [false, true]) {
    const fake = fakeConnection({
      rows: [
        target({ oidc_issuer: REQUEST.issuer, oidc_subject: REQUEST.subject }),
        { match: 'WHERE oidc_issuer = ?', rows: [{ id: 'user-1' }] },
        ROLE_COUNT,
        CHAINED,
      ],
    })
    const result = await bindOidcIdentity(fake.connection, REQUEST, {
      execute,
      ...FIXED,
    })
    assert.equal(result.outcome, 'no-op')
    assert.equal(result.refusalCode, null)
    assert.equal(result.bindingWritten, false)
    assert.equal(result.auditMode, null)
    assert.deepEqual(fake.writes(), [])
    assert.deepEqual(fake.transaction, ['begin', 'rollback'])
  }
})

test('a missing user is refused without a write, even under execute', async () => {
  const fake = fakeConnection({
    rows: [{ match: 'WHERE email = ?', rows: [] }, NO_OWNER, CHAINED],
  })
  const result = await bindOidcIdentity(fake.connection, REQUEST, {
    execute: true,
    ...FIXED,
  })

  assert.equal(result.outcome, 'refused')
  assert.equal(result.refusalCode, OIDC_BIND_REFUSAL_CODES.userNotFound)
  assert.equal(result.userFound, false)
  assert.equal(result.userActive, false)
  assert.equal(result.userHasRole, false)
  assert.deepEqual(fake.writes(), [])
  assert.deepEqual(fake.transaction, ['begin', 'rollback'])
  // No user row means no role lookup either.
  assert.equal(fake.find('kaudit_user_role'), undefined)
})

test('an inactive or role-less user is bound, and reported as such', async () => {
  const fake = fakeConnection({
    rows: [
      target({ status: 'disabled' }),
      NO_OWNER,
      { match: 'kaudit_user_role', rows: [{ n: 0 }] },
      CHAINED,
    ],
  })
  const result = await bindOidcIdentity(fake.connection, REQUEST, {
    execute: true,
    ...FIXED,
  })

  assert.equal(result.outcome, 'bind')
  assert.equal(result.bindingWritten, true)
  // The binding does not activate or grant. The operator is told plainly that
  // this account still cannot sign in or do anything once it can.
  assert.equal(result.userActive, false)
  assert.equal(result.userHasRole, false)
  assert.equal(fake.all('UPDATE kaudit_user\n').length, 1)
})

test('a system actor, a taken identity, and an existing binding are all refused', async () => {
  const cases = [
    {
      name: 'system actor',
      rows: [target({ kind: 'system' }), NO_OWNER, ROLE_COUNT],
      code: OIDC_BIND_REFUSAL_CODES.userNotBindable,
    },
    {
      name: 'identity owned elsewhere',
      rows: [
        target(),
        { match: 'WHERE oidc_issuer = ?', rows: [{ id: 'user-2' }] },
        ROLE_COUNT,
      ],
      code: OIDC_BIND_REFUSAL_CODES.identityTaken,
    },
    {
      name: 'different complete binding',
      rows: [
        target({ oidc_issuer: 'https://other.example.test', oidc_subject: '9' }),
        NO_OWNER,
        ROLE_COUNT,
      ],
      code: OIDC_BIND_REFUSAL_CODES.userAlreadyBound,
    },
    {
      name: 'partial binding',
      rows: [target({ oidc_issuer: REQUEST.issuer }), NO_OWNER, ROLE_COUNT],
      code: OIDC_BIND_REFUSAL_CODES.userAlreadyBound,
    },
  ]

  for (const scenario of cases) {
    const fake = fakeConnection({ rows: [...scenario.rows, CHAINED] })
    const result = await bindOidcIdentity(fake.connection, REQUEST, {
      execute: true,
      ...FIXED,
    })
    assert.equal(result.outcome, 'refused', scenario.name)
    assert.equal(result.refusalCode, scenario.code, scenario.name)
    assert.equal(result.bindingWritten, false, scenario.name)
    assert.deepEqual(fake.writes(), [], scenario.name)
    assert.deepEqual(fake.transaction, ['begin', 'rollback'], scenario.name)
  }
})

// ---------------------------------------------------------------------------
// 5. Races
// ---------------------------------------------------------------------------

test('a lost race fails the guard instead of overwriting a binding', async () => {
  // The row was unbound when read and bound by the time the UPDATE ran, so the
  // guard matches nothing.
  const fake = fakeConnection({
    rows: [target(), NO_OWNER, ROLE_COUNT, CHAINED],
    affectedRows: 0,
  })
  const result = await bindOidcIdentity(fake.connection, REQUEST, {
    execute: true,
    ...FIXED,
  })

  assert.equal(result.outcome, 'refused')
  assert.equal(result.refusalCode, OIDC_BIND_REFUSAL_CODES.updateGuardFailed)
  assert.equal(result.bindingWritten, false)
  assert.deepEqual(fake.transaction, ['begin', 'rollback'])
  // Nothing was audited, because nothing changed.
  assert.equal(fake.find('INSERT INTO kaudit_audit_log'), undefined)
})

test('the unique key is the final defense, reported without reading the error', async () => {
  const duplicate = Object.assign(
    new Error('Duplicate entry https://accounts.example.test-100000000000000000001'),
    { code: 'ER_DUP_ENTRY' },
  )
  const fake = fakeConnection({
    rows: [target(), NO_OWNER, ROLE_COUNT, CHAINED],
    failOn: { match: 'UPDATE kaudit_user\n', error: duplicate },
  })
  const result = await bindOidcIdentity(fake.connection, REQUEST, {
    execute: true,
    ...FIXED,
  })

  assert.equal(result.outcome, 'refused')
  assert.equal(result.refusalCode, OIDC_BIND_REFUSAL_CODES.identityTaken)
  assert.equal(result.bindingWritten, false)
  assert.deepEqual(fake.transaction, ['begin', 'rollback'])
  // The driver message quoted the values; none of it reaches the result.
  const serialized = JSON.stringify(result)
  for (const supplied of [REQUEST.issuer, REQUEST.subject, REQUEST.email]) {
    assert.equal(serialized.includes(supplied), false)
  }
})

// ---------------------------------------------------------------------------
// 6. Faults roll back, and say nothing
// ---------------------------------------------------------------------------

test('an unauditable binding is rolled back', async () => {
  const fake = fakeConnection({
    rows: [target(), NO_OWNER, ROLE_COUNT, CHAINED],
    failOn: {
      match: 'INSERT INTO kaudit_audit_log',
      error: new Error('audit log write failed for dme@kairali.com'),
    },
  })

  await assert.rejects(
    bindOidcIdentity(fake.connection, REQUEST, { execute: true, ...FIXED }),
    (error: unknown) => {
      assert.ok(error instanceof OidcBindingWriteError)
      assert.equal(error.code, OIDC_BIND_WRITE_CODES.auditFailed)
      assert.equal(error.message, OIDC_BIND_WRITE_CODES.auditFailed)
      return true
    },
  )
  // The UPDATE ran, and then went back with the failed audit.
  assert.equal(fake.all('UPDATE kaudit_user\n').length, 1)
  assert.deepEqual(fake.transaction, ['begin', 'rollback'])
})

test('a failed read rolls back and reports a bounded code', async () => {
  const fake = fakeConnection({
    failOn: {
      match: 'WHERE email = ?',
      error: new Error("Unknown column 'dme@kairali.com' in kaudit_user"),
    },
  })

  await assert.rejects(
    bindOidcIdentity(fake.connection, REQUEST, { execute: true, ...FIXED }),
    (error: unknown) => {
      assert.ok(error instanceof OidcBindingWriteError)
      assert.equal(error.code, OIDC_BIND_WRITE_CODES.readFailed)
      assert.equal(error.message.includes('kairali'), false)
      return true
    },
  )
  assert.deepEqual(fake.transaction, ['begin', 'rollback'])
})

test('a failed write rolls back and reports a bounded code', async () => {
  const fake = fakeConnection({
    rows: [target(), NO_OWNER, ROLE_COUNT, CHAINED],
    failOn: {
      match: 'UPDATE kaudit_user\n',
      error: new Error('deadlock on kaudit_user'),
    },
  })

  await assert.rejects(
    bindOidcIdentity(fake.connection, REQUEST, { execute: true, ...FIXED }),
    (error: unknown) => {
      assert.ok(error instanceof OidcBindingWriteError)
      assert.equal(error.code, OIDC_BIND_WRITE_CODES.updateFailed)
      return true
    },
  )
  assert.deepEqual(fake.transaction, ['begin', 'rollback'])
})

test('a failed commit rolls back and reports a bounded code', async () => {
  const fake = fakeConnection({ rows: [target(), NO_OWNER, ROLE_COUNT, CHAINED] })
  const connection: OidcBindingConnection = {
    ...fake.connection,
    async commit() {
      throw new Error('commit failed')
    },
  }

  await assert.rejects(
    bindOidcIdentity(connection, REQUEST, { execute: true, ...FIXED }),
    (error: unknown) => {
      assert.ok(error instanceof OidcBindingWriteError)
      assert.equal(error.code, OIDC_BIND_WRITE_CODES.commitFailed)
      return true
    },
  )
  assert.deepEqual(fake.transaction, ['begin', 'rollback'])
})

test('every bounded code is an uppercase machine token', () => {
  for (const code of [
    ...Object.values(OIDC_BIND_WRITE_CODES),
    ...Object.values(OIDC_BIND_REFUSAL_CODES),
  ]) {
    assert.match(code, /^[A-Z][A-Z0-9_]*$/)
  }
})
