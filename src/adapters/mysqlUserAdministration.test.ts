import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isStoredPasswordHashValid } from '../auth/passwordHash.ts'
import {
  UserAdminError,
  USER_ADMIN_AUDIT_ACTIONS,
  USER_ADMIN_FAULT_CODES,
  USER_ADMIN_INPUT_CODES,
  USER_ADMIN_REFUSAL_CODES,
} from '../identity/userAdministration.ts'
import {
  createMysqlUserAdministration,
  USER_ADMIN_SQL,
  type MysqlUserAdministrationOptions,
  type UserAdminConnection,
  type UserAdminPool,
} from './mysqlUserAdministration.ts'

// ---------------------------------------------------------------------------
// Recording fake pool. No database is ever contacted.
// ---------------------------------------------------------------------------

interface Call {
  sql: string
  parameters: unknown[]
}

interface RowRule {
  match: string
  rows: unknown[]
}

interface AffectedRule {
  match: string
  affectedRows: number
}

interface FakeOptions {
  /** Rows returned for the first SELECT whose text contains `match`. */
  rows?: RowRule[]
  /** Row count reported by the first write whose text contains `match`. */
  affected?: AffectedRule[]
  failOn?: { match: string; error: unknown }
  failCommit?: boolean
  failGetConnection?: boolean
}

/** Substrings that identify one statement without restating it. */
const MATCH = {
  account: 'LEFT JOIN kaudit_user_credential',
  roles: 'SELECT role_code',
  otherAdmins: "r.role_code = 'admin'",
  usernameOwner: 'SELECT user_id',
  emailOwner: 'WHERE email = ?',
  insertUser: 'INSERT INTO kaudit_user\n',
  insertCredential: 'INSERT INTO kaudit_user_credential',
  insertRole: 'INSERT INTO kaudit_user_role',
  deleteRoles: 'DELETE FROM kaudit_user_role',
  auditLogInsert: 'INSERT INTO kaudit_audit_log',
} as const

/** Statements `recordAuditEventInTransaction` runs on the chained path. */
const AUDIT_STATEMENT_COUNT = 5

function fakePool(options: FakeOptions = {}) {
  const calls: Call[] = []
  const journal: string[] = []

  async function run(sql: string, parameters: unknown[] = []): Promise<unknown> {
    calls.push({ sql, parameters })
    journal.push('sql')
    if (options.failOn && sql.includes(options.failOn.match)) {
      throw options.failOn.error
    }
    if (/^\s*SELECT/i.test(sql)) {
      const configured = options.rows?.find((rule) => sql.includes(rule.match))
      if (configured) return [configured.rows, []]
      // Defaults the audit writer needs: migration 0004 is present, and the
      // chain has a head.
      if (sql.includes('information_schema')) return [[{ n: 5 }], []]
      if (sql.includes('SELECT head_hash')) {
        return [[{ head_hash: 'a'.repeat(64) }], []]
      }
      return [[], []]
    }
    const affected = options.affected?.find((rule) => sql.includes(rule.match))
    return [{ affectedRows: affected ? affected.affectedRows : 1 }, []]
  }

  const connection: UserAdminConnection = {
    execute: run,
    query: run,
    async beginTransaction() {
      journal.push('begin')
    },
    async commit() {
      journal.push('commit')
      if (options.failCommit) throw new Error('commit refused by the fake')
    },
    async rollback() {
      journal.push('rollback')
    },
    release() {
      journal.push('release')
    },
  }

  const pool: UserAdminPool = {
    query: run,
    async getConnection() {
      if (options.failGetConnection) throw new Error('pool exhausted in the fake')
      journal.push('acquire')
      return connection
    },
  }

  return {
    pool,
    calls,
    journal,
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
        /^\s*(INSERT|UPDATE|DELETE|REPLACE|ALTER|DROP|TRUNCATE)/i.test(call.sql),
      )
    },
    /** Writes to the user tables — the audit chain's own writes excluded. */
    domainWrites() {
      return this.writes().filter(
        (call) =>
          !call.sql.includes('kaudit_audit_log') &&
          !call.sql.includes('kaudit_audit_chain_head'),
      )
    },
    /** Everything the adapter handed the driver, as one searchable string. */
    everything() {
      return JSON.stringify(calls)
    },
  }
}

/** The transaction shape for a run of `n` statements that was kept. */
function committed(n: number): string[] {
  return ['acquire', 'begin', ...Array.from({ length: n }, () => 'sql'), 'commit', 'release']
}

/** The transaction shape for a run of `n` statements that was abandoned. */
function rolledBack(n: number): string[] {
  return ['acquire', 'begin', ...Array.from({ length: n }, () => 'sql'), 'rollback', 'release']
}

// ---------------------------------------------------------------------------
// Synthetic fixtures. Nothing here is a real person, handle, or secret.
// ---------------------------------------------------------------------------

const ACTOR_ID = 'usr-admin-0001'
const TARGET_ID = 'usr-target-0002'
const NOW = new Date('2026-08-12T10:30:00.000Z')

const USERNAME = 'reviewer.one'
const EMAIL = 'reviewer.one@example.test'
/** Synthetic and policy-clean: never a real credential. */
const PASSWORD = 'Synthetic#Pass7key'
/** What the injected hasher returns, so no test buys real scrypt work. */
const FAKE_HASH =
  'scrypt$N=16384,r=8,p=1$c2FsdHNhbHRzYWx0c2FsdA$ZGlnZXN0ZGlnZXN0ZGlnZXN0ZGlnZXN0'

function accountRow(overrides: Record<string, unknown> = {}) {
  return {
    id: TARGET_ID,
    kind: 'user',
    user_status: 'active',
    email: EMAIL,
    username_normalized: USERNAME,
    credential_status: 'active',
    session_version: 4,
    ...overrides,
  }
}

function ids() {
  let n = 0
  return () => `id-${(n += 1)}`
}

interface HasherRecord {
  password: string
  identity: unknown
}

function service(fake: ReturnType<typeof fakePool>, hashes: HasherRecord[] = []) {
  const options: MysqlUserAdministrationOptions = {
    now: () => NOW,
    newId: ids(),
    async hashPassword(password, identity) {
      hashes.push({ password, identity })
      return FAKE_HASH
    },
  }
  return createMysqlUserAdministration(fake.pool, options)
}

/** The bounded code an operation failed with, or a marker that it did not. */
async function codeOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run()
    return 'DID_NOT_THROW'
  } catch (error) {
    return error instanceof UserAdminError ? error.code : 'WRONG_ERROR_TYPE'
  }
}

// ---------------------------------------------------------------------------
// Statement hygiene.
// ---------------------------------------------------------------------------

test('every statement touches only the Kaudit user tables', () => {
  const allowed = new Set([
    'kaudit_user',
    'kaudit_user_credential',
    'kaudit_user_role',
  ])
  for (const sql of Object.values(USER_ADMIN_SQL)) {
    for (const match of sql.matchAll(
      /\b(?:FROM|JOIN|INTO|UPDATE)\s+`?([A-Za-z_][A-Za-z0-9_.]*)`?/g,
    )) {
      assert.ok(
        allowed.has(match[1]),
        `unexpected table in a user-administration statement: ${match[1]}`,
      )
    }
    // Never the external lead table, never CRM-owned anything.
    assert.ok(!/ai_voice_leads_received|kcrm/i.test(sql))
    // No statement may physically remove a person or a credential.
    assert.ok(!/DELETE\s+FROM\s+kaudit_user\b/i.test(sql))
    assert.ok(!/DELETE\s+FROM\s+kaudit_user_credential\b/i.test(sql))
    assert.ok(!/\b(DROP|TRUNCATE|ALTER)\b/i.test(sql))
  }
})

test('the list projection carries no credential or session material', () => {
  assert.ok(!USER_ADMIN_SQL.listUsers.includes('password_hash'))
  assert.ok(!USER_ADMIN_SQL.listUsers.includes('session_version'))
  assert.ok(!USER_ADMIN_SQL.listUsers.includes('*'))
  // An explicit projection, not a wildcard, and bounded by a placeholder.
  assert.ok(USER_ADMIN_SQL.listUsers.includes('LIMIT ? OFFSET ?'))
})

test('the state-changing statements lock what they decide from', () => {
  for (const sql of [
    USER_ADMIN_SQL.selectTargetForUpdate,
    USER_ADMIN_SQL.selectTargetRolesForUpdate,
    USER_ADMIN_SQL.countOtherActiveAdminsForUpdate,
    USER_ADMIN_SQL.selectUsernameOwnerForUpdate,
    USER_ADMIN_SQL.selectEmailOwnerForUpdate,
  ]) {
    assert.ok(sql.includes('FOR UPDATE'))
  }
  // Every revocation write advances the session generation.
  for (const sql of [
    USER_ADMIN_SQL.disableCredential,
    USER_ADMIN_SQL.enableCredential,
    USER_ADMIN_SQL.updatePassword,
    USER_ADMIN_SQL.tombstoneCredential,
  ]) {
    assert.ok(sql.includes('session_version = session_version + 1'))
  }
  assert.ok(USER_ADMIN_SQL.enableCredential.includes('disabled_at = NULL'))
})

// ---------------------------------------------------------------------------
// listUsers
// ---------------------------------------------------------------------------

test('listUsers returns a bounded projection with no credential material', async () => {
  const fake = fakePool({
    rows: [
      {
        match: 'GROUP_CONCAT',
        rows: [
          {
            id: TARGET_ID,
            email: EMAIL,
            display_name: 'Reviewer One',
            user_status: 'active',
            max_sensitivity_tier: 'K1',
            last_login_at: new Date('2026-08-11T08:00:00.000Z'),
            created_at: new Date('2026-08-01T08:00:00.000Z'),
            username_normalized: USERNAME,
            credential_status: 'active',
            password_changed_at: new Date('2026-08-02T08:00:00.000Z'),
            disabled_at: null,
            roles: 'user',
          },
        ],
      },
    ],
  })
  const page = await service(fake).listUsers({
    actorUserId: ACTOR_ID,
    limit: 25,
    offset: 0,
  })

  assert.equal(page.limit, 25)
  assert.equal(page.offset, 0)
  assert.equal(page.users.length, 1)
  const [user] = page.users
  assert.deepEqual(user.roles, ['user'])
  assert.equal(user.username, USERNAME)
  assert.equal(user.credentialStatus, 'active')
  assert.equal(user.lastLoginAt, '2026-08-11T08:00:00.000Z')
  assert.equal(user.disabledAt, null)
  for (const forbidden of ['passwordHash', 'password_hash', 'sessionVersion']) {
    assert.ok(!(forbidden in user))
  }

  // Read-only: no transaction, and the window travels as parameters.
  assert.deepEqual(fake.journal, ['sql'])
  assert.deepEqual(fake.calls[0].parameters, [25, 0])
  assert.equal(fake.writes().length, 0)
})

test('listUsers refuses a bad actor or window before it reads anything', async () => {
  for (const input of [
    { actorUserId: '' },
    { actorUserId: 'has space' },
    { actorUserId: ACTOR_ID, limit: 0 },
    { actorUserId: ACTOR_ID, limit: 5000 },
    { actorUserId: ACTOR_ID, offset: -1 },
  ]) {
    const fake = fakePool()
    const code = await codeOf(() => service(fake).listUsers(input as never))
    assert.ok(code.startsWith('USER_ADMIN_'))
    assert.equal(code, code.toUpperCase())
    assert.equal(fake.calls.length, 0)
  }
})

// ---------------------------------------------------------------------------
// createUser
// ---------------------------------------------------------------------------

test('createUser writes one user, one credential, and exactly one role', async () => {
  const fake = fakePool()
  const hashes: HasherRecord[] = []
  const result = await service(fake, hashes).createUser({
    actorUserId: ACTOR_ID,
    username: USERNAME,
    email: EMAIL,
    password: PASSWORD,
    role: 'user',
  })

  // Two locked uniqueness reads, three writes, five audit statements — all
  // inside one transaction that was then committed.
  assert.deepEqual(fake.journal, committed(5 + AUDIT_STATEMENT_COUNT))
  const writes = fake.domainWrites()
  assert.equal(writes.length, 3)
  assert.equal(writes[0].sql, USER_ADMIN_SQL.insertUser)
  assert.equal(writes[1].sql, USER_ADMIN_SQL.insertCredential)
  assert.equal(writes[2].sql, USER_ADMIN_SQL.insertRole)

  const userId = writes[0].parameters[0]
  assert.deepEqual(writes[0].parameters, [userId, EMAIL])
  assert.deepEqual(writes[1].parameters, [userId, USERNAME, FAKE_HASH])
  assert.deepEqual(writes[2].parameters, [
    writes[2].parameters[0],
    userId,
    'user',
    ACTOR_ID,
  ])

  assert.equal(result.userId, userId)
  assert.equal(result.role, 'user')
  assert.equal(result.sessionVersion, 1)
  assert.equal(result.changed, true)
  assert.equal(result.action, USER_ADMIN_AUDIT_ACTIONS.created)
  assert.equal(result.auditMode, 'hash-chained')

  // The plaintext was read exactly once, by the hasher, and never bound.
  assert.equal(hashes.length, 1)
  assert.equal(hashes[0].password, PASSWORD)
  assert.deepEqual(hashes[0].identity, { username: USERNAME, email: EMAIL })
  assert.ok(!fake.everything().includes(PASSWORD))
})

test('createUser audits the creation in the same transaction', async () => {
  const fake = fakePool()
  await service(fake).createUser({
    actorUserId: ACTOR_ID,
    username: USERNAME,
    email: EMAIL,
    password: PASSWORD,
    role: 'admin',
  })

  const auditInsert = fake.find(MATCH.auditLogInsert)
  assert.ok(auditInsert)
  // Written before the commit, so a later failure takes it down with the change.
  assert.ok(fake.journal.indexOf('commit') === fake.journal.length - 2)

  const [, actorEmail, actorUserId, action, resourceType] =
    auditInsert.parameters as string[]
  assert.equal(actorEmail, null)
  assert.equal(actorUserId, ACTOR_ID)
  assert.equal(action, USER_ADMIN_AUDIT_ACTIONS.created)
  assert.equal(resourceType, 'kaudit_user')

  // The audit row carries no identity value and no password material.
  const audited = JSON.stringify(auditInsert.parameters)
  for (const secret of [USERNAME, EMAIL, PASSWORD, FAKE_HASH, 'scrypt']) {
    assert.ok(!audited.includes(secret))
  }
})

test('createUser refuses a taken or retired username before it writes', async () => {
  for (const owner of [
    { user_id: 'usr-other-0003' },
    // A tombstoned account still holds its row, so its handle stays retired.
    { user_id: 'usr-closed-0004' },
  ]) {
    const fake = fakePool({
      rows: [{ match: MATCH.usernameOwner, rows: [owner] }],
    })
    assert.equal(
      await codeOf(() =>
        service(fake).createUser({
          actorUserId: ACTOR_ID,
          username: USERNAME,
          email: EMAIL,
          password: PASSWORD,
          role: 'user',
        }),
      ),
      USER_ADMIN_REFUSAL_CODES.usernameTaken,
    )
    assert.deepEqual(fake.journal, rolledBack(1))
    assert.equal(fake.writes().length, 0)
  }
})

test('createUser refuses a taken email before it writes', async () => {
  const fake = fakePool({
    rows: [{ match: MATCH.emailOwner, rows: [{ id: 'usr-other-0003' }] }],
  })
  assert.equal(
    await codeOf(() =>
      service(fake).createUser({
        actorUserId: ACTOR_ID,
        username: USERNAME,
        email: EMAIL,
        password: PASSWORD,
        role: 'user',
      }),
    ),
    USER_ADMIN_REFUSAL_CODES.emailTaken,
  )
  assert.deepEqual(fake.journal, rolledBack(2))
  assert.equal(fake.writes().length, 0)
})

test('a unique key firing under the write is a bounded conflict, not a driver error', async () => {
  const duplicate = Object.assign(
    new Error(`Duplicate entry '${USERNAME}' for key 'uq_user_credential_username'`),
    { code: 'ER_DUP_ENTRY', sqlMessage: `Duplicate entry '${USERNAME}'` },
  )
  const fake = fakePool({
    failOn: { match: MATCH.insertCredential, error: duplicate },
  })
  let thrown: unknown
  try {
    await service(fake).createUser({
      actorUserId: ACTOR_ID,
      username: USERNAME,
      email: EMAIL,
      password: PASSWORD,
      role: 'user',
    })
  } catch (error) {
    thrown = error
  }
  assert.ok(thrown instanceof UserAdminError)
  assert.equal(thrown.code, USER_ADMIN_REFUSAL_CODES.identifierConflict)
  // The driver's message quoted the username; ours quotes nothing.
  assert.equal(thrown.message, thrown.code)
  assert.ok(!JSON.stringify(thrown.message).includes(USERNAME))
  assert.equal(fake.journal.at(-2), 'rollback')
})

test('createUser rejects bad input before a connection is even taken', async () => {
  const cases: Array<[Record<string, unknown>, string]> = [
    [{ actorUserId: '' }, USER_ADMIN_INPUT_CODES.actorInvalid],
    [{ username: 'no' }, USER_ADMIN_INPUT_CODES.usernameMalformed],
    [{ username: 'has space' }, USER_ADMIN_INPUT_CODES.usernameMalformed],
    [{ email: 'not-an-email' }, USER_ADMIN_INPUT_CODES.emailMalformed],
    [{ role: 'superadmin' }, USER_ADMIN_INPUT_CODES.roleInvalid],
    [{ role: undefined }, USER_ADMIN_INPUT_CODES.roleInvalid],
    [{ password: 'short' }, USER_ADMIN_INPUT_CODES.passwordPolicy],
    [{ password: 'alllowercase123' }, USER_ADMIN_INPUT_CODES.passwordPolicy],
  ]
  for (const [override, expected] of cases) {
    const fake = fakePool()
    const code = await codeOf(() =>
      service(fake).createUser({
        actorUserId: ACTOR_ID,
        username: USERNAME,
        email: EMAIL,
        password: PASSWORD,
        role: 'user',
        ...override,
      } as never),
    )
    assert.equal(code, expected)
    assert.deepEqual(fake.journal, [])
    assert.equal(fake.calls.length, 0)
  }
})

// ---------------------------------------------------------------------------
// updateUser
// ---------------------------------------------------------------------------

test('updateUser changes username, email, and role atomically', async () => {
  const fake = fakePool({
    rows: [
      { match: MATCH.account, rows: [accountRow()] },
      { match: MATCH.roles, rows: [{ role_code: 'user' }] },
    ],
  })
  const result = await service(fake).updateUser({
    actorUserId: ACTOR_ID,
    targetUserId: TARGET_ID,
    username: 'reviewer.two',
    email: 'reviewer.two@example.test',
    role: 'admin',
  })

  const writes = fake.domainWrites()
  assert.equal(writes.length, 4)
  assert.equal(writes[0].sql, USER_ADMIN_SQL.updateUsername)
  assert.deepEqual(writes[0].parameters, ['reviewer.two', TARGET_ID, USERNAME])
  assert.equal(writes[1].sql, USER_ADMIN_SQL.updateEmail)
  assert.deepEqual(writes[1].parameters, [
    'reviewer.two@example.test',
    TARGET_ID,
  ])
  // Roles are replaced, so the account ends with exactly the one requested.
  assert.equal(writes[2].sql, USER_ADMIN_SQL.deleteRoles)
  assert.deepEqual(writes[2].parameters, [TARGET_ID])
  assert.equal(writes[3].sql, USER_ADMIN_SQL.insertRole)
  assert.equal(writes[3].parameters[2], 'admin')

  assert.equal(fake.journal.at(-2), 'commit')
  assert.equal(result.changed, true)
  // A promotion does not rotate the generation: roles are re-read per request.
  assert.equal(result.sessionVersion, 4)
})

test('updateUser writes nothing when nothing differs, and still records it', async () => {
  const fake = fakePool({
    rows: [
      { match: MATCH.account, rows: [accountRow()] },
      { match: MATCH.roles, rows: [{ role_code: 'user' }] },
    ],
  })
  const result = await service(fake).updateUser({
    actorUserId: ACTOR_ID,
    targetUserId: TARGET_ID,
    username: USERNAME,
    email: EMAIL,
    role: 'user',
  })
  assert.equal(result.changed, false)
  assert.equal(fake.domainWrites().length, 0)
  assert.ok(fake.find(MATCH.auditLogInsert))
  assert.equal(fake.journal.at(-2), 'commit')
})

test('updateUser refuses a username already held by someone else', async () => {
  const fake = fakePool({
    rows: [
      { match: MATCH.account, rows: [accountRow()] },
      { match: MATCH.roles, rows: [{ role_code: 'user' }] },
      { match: MATCH.usernameOwner, rows: [{ user_id: 'usr-other-0003' }] },
    ],
  })
  assert.equal(
    await codeOf(() =>
      service(fake).updateUser({
        actorUserId: ACTOR_ID,
        targetUserId: TARGET_ID,
        username: 'reviewer.two',
        email: EMAIL,
        role: 'user',
      }),
    ),
    USER_ADMIN_REFUSAL_CODES.usernameTaken,
  )
  assert.equal(fake.domainWrites().length, 0)
  assert.equal(fake.journal.at(-2), 'rollback')
})

test('an administrator cannot demote their own account', async () => {
  const fake = fakePool({
    rows: [
      { match: MATCH.account, rows: [accountRow({ id: ACTOR_ID })] },
      { match: MATCH.roles, rows: [{ role_code: 'admin' }] },
    ],
  })
  assert.equal(
    await codeOf(() =>
      service(fake).updateUser({
        actorUserId: ACTOR_ID,
        targetUserId: ACTOR_ID,
        username: USERNAME,
        email: EMAIL,
        role: 'user',
      }),
    ),
    USER_ADMIN_REFUSAL_CODES.selfDemote,
  )
  assert.equal(fake.writes().length, 0)
  assert.equal(fake.journal.at(-2), 'rollback')
})

test('demoting the last active administrator is refused', async () => {
  const fake = fakePool({
    rows: [
      { match: MATCH.account, rows: [accountRow()] },
      { match: MATCH.roles, rows: [{ role_code: 'admin' }] },
      { match: MATCH.otherAdmins, rows: [{ n: 0 }] },
    ],
  })
  assert.equal(
    await codeOf(() =>
      service(fake).updateUser({
        actorUserId: ACTOR_ID,
        targetUserId: TARGET_ID,
        username: USERNAME,
        email: EMAIL,
        role: 'user',
      }),
    ),
    USER_ADMIN_REFUSAL_CODES.lastAdmin,
  )
  assert.equal(fake.writes().length, 0)
  assert.ok(fake.find(MATCH.otherAdmins)?.sql.includes('FOR UPDATE'))
})

test('demoting an administrator is allowed while another active one remains', async () => {
  const fake = fakePool({
    rows: [
      { match: MATCH.account, rows: [accountRow()] },
      { match: MATCH.roles, rows: [{ role_code: 'admin' }] },
      { match: MATCH.otherAdmins, rows: [{ n: 1 }] },
    ],
  })
  const result = await service(fake).updateUser({
    actorUserId: ACTOR_ID,
    targetUserId: TARGET_ID,
    username: USERNAME,
    email: EMAIL,
    role: 'user',
  })
  assert.equal(result.changed, true)
  const writes = fake.domainWrites()
  assert.equal(writes.length, 2)
  assert.equal(writes[0].sql, USER_ADMIN_SQL.deleteRoles)
  assert.equal(writes[1].parameters[2], 'user')
  assert.equal(fake.journal.at(-2), 'commit')
})

// ---------------------------------------------------------------------------
// Targets that are not manageable at all.
// ---------------------------------------------------------------------------

test('a system actor, a missing user, and a closed account are never managed', async () => {
  const cases: Array<[Record<string, unknown>[], string]> = [
    [[], USER_ADMIN_REFUSAL_CODES.userNotFound],
    [
      [accountRow({ kind: 'system' })],
      USER_ADMIN_REFUSAL_CODES.userNotManageable,
    ],
    [
      [accountRow({ credential_status: null, session_version: null })],
      USER_ADMIN_REFUSAL_CODES.credentialNotFound,
    ],
    [
      [accountRow({ credential_status: 'tombstoned' })],
      USER_ADMIN_REFUSAL_CODES.accountTombstoned,
    ],
    [
      [accountRow({ user_status: 'tombstoned' })],
      USER_ADMIN_REFUSAL_CODES.accountTombstoned,
    ],
  ]

  for (const [rows, expected] of cases) {
    for (const operate of [
      (port: ReturnType<typeof service>) =>
        port.updateUser({
          actorUserId: ACTOR_ID,
          targetUserId: TARGET_ID,
          username: USERNAME,
          email: EMAIL,
          role: 'user',
        }),
      (port: ReturnType<typeof service>) =>
        port.setUserActivation({
          actorUserId: ACTOR_ID,
          targetUserId: TARGET_ID,
          active: true,
        }),
      (port: ReturnType<typeof service>) =>
        port.resetUserPassword({
          actorUserId: ACTOR_ID,
          targetUserId: TARGET_ID,
          password: PASSWORD,
        }),
      (port: ReturnType<typeof service>) =>
        port.tombstoneUser({ actorUserId: ACTOR_ID, targetUserId: TARGET_ID }),
    ]) {
      const fake = fakePool({ rows: [{ match: MATCH.account, rows }] })
      assert.equal(await codeOf(() => operate(service(fake))), expected)
      assert.equal(fake.writes().length, 0)
      assert.equal(fake.journal.at(-2), 'rollback')
    }
  }
})

// ---------------------------------------------------------------------------
// setUserActivation
// ---------------------------------------------------------------------------

test('deactivation revokes every session by advancing the generation', async () => {
  const fake = fakePool({
    rows: [
      { match: MATCH.account, rows: [accountRow()] },
      { match: MATCH.roles, rows: [{ role_code: 'user' }] },
      { match: MATCH.otherAdmins, rows: [{ n: 2 }] },
    ],
  })
  const result = await service(fake).setUserActivation({
    actorUserId: ACTOR_ID,
    targetUserId: TARGET_ID,
    active: false,
  })

  const writes = fake.domainWrites()
  assert.equal(writes.length, 2)
  assert.equal(writes[0].sql, USER_ADMIN_SQL.disableCredential)
  assert.deepEqual(writes[0].parameters, [TARGET_ID])
  assert.equal(writes[1].sql, USER_ADMIN_SQL.disableUser)
  assert.equal(result.sessionVersion, 5)
  assert.equal(result.action, USER_ADMIN_AUDIT_ACTIONS.deactivated)
  assert.equal(fake.journal.at(-2), 'commit')
})

test('activation rotates the generation and clears disabled_at', async () => {
  const fake = fakePool({
    rows: [
      {
        match: MATCH.account,
        rows: [
          accountRow({ user_status: 'disabled', credential_status: 'disabled' }),
        ],
      },
      { match: MATCH.roles, rows: [{ role_code: 'user' }] },
    ],
  })
  const result = await service(fake).setUserActivation({
    actorUserId: ACTOR_ID,
    targetUserId: TARGET_ID,
    active: true,
  })
  const writes = fake.domainWrites()
  assert.equal(writes.length, 2)
  assert.equal(writes[0].sql, USER_ADMIN_SQL.enableCredential)
  assert.equal(writes[1].sql, USER_ADMIN_SQL.enableUser)
  assert.equal(result.sessionVersion, 5)
  assert.equal(result.action, USER_ADMIN_AUDIT_ACTIONS.activated)
  // No admin count is taken: enabling an account cannot remove an admin.
  assert.equal(fake.find(MATCH.otherAdmins), undefined)
})

test('an activation that changes nothing writes nothing and audits nothing', async () => {
  const fake = fakePool({
    rows: [
      { match: MATCH.account, rows: [accountRow()] },
      { match: MATCH.roles, rows: [{ role_code: 'user' }] },
    ],
  })
  const result = await service(fake).setUserActivation({
    actorUserId: ACTOR_ID,
    targetUserId: TARGET_ID,
    active: true,
  })
  assert.equal(result.changed, false)
  assert.equal(result.auditMode, null)
  assert.equal(result.sessionVersion, 4)
  assert.equal(fake.writes().length, 0)
  assert.equal(fake.find(MATCH.auditLogInsert), undefined)
  assert.deepEqual(fake.journal, rolledBack(2))
})

test('an administrator cannot deactivate their own account', async () => {
  const fake = fakePool({
    rows: [
      { match: MATCH.account, rows: [accountRow({ id: ACTOR_ID })] },
      { match: MATCH.roles, rows: [{ role_code: 'admin' }] },
    ],
  })
  assert.equal(
    await codeOf(() =>
      service(fake).setUserActivation({
        actorUserId: ACTOR_ID,
        targetUserId: ACTOR_ID,
        active: false,
      }),
    ),
    USER_ADMIN_REFUSAL_CODES.selfDeactivate,
  )
  assert.equal(fake.writes().length, 0)
})

test('deactivating the last active administrator is refused', async () => {
  const fake = fakePool({
    rows: [
      { match: MATCH.account, rows: [accountRow()] },
      { match: MATCH.roles, rows: [{ role_code: 'admin' }] },
      { match: MATCH.otherAdmins, rows: [{ n: 0 }] },
    ],
  })
  assert.equal(
    await codeOf(() =>
      service(fake).setUserActivation({
        actorUserId: ACTOR_ID,
        targetUserId: TARGET_ID,
        active: false,
      }),
    ),
    USER_ADMIN_REFUSAL_CODES.lastAdmin,
  )
  assert.equal(fake.writes().length, 0)
  assert.equal(fake.journal.at(-2), 'rollback')
})

// ---------------------------------------------------------------------------
// resetUserPassword
// ---------------------------------------------------------------------------

test('a password reset stores only a hash and advances the generation', async () => {
  const fake = fakePool({
    rows: [
      { match: MATCH.account, rows: [accountRow()] },
      { match: MATCH.roles, rows: [{ role_code: 'user' }] },
    ],
  })
  const hashes: HasherRecord[] = []
  const result = await service(fake, hashes).resetUserPassword({
    actorUserId: ACTOR_ID,
    targetUserId: TARGET_ID,
    password: PASSWORD,
  })

  const writes = fake.domainWrites()
  assert.equal(writes.length, 1)
  assert.equal(writes[0].sql, USER_ADMIN_SQL.updatePassword)
  assert.deepEqual(writes[0].parameters, [FAKE_HASH, TARGET_ID])
  assert.equal(result.sessionVersion, 5)
  assert.equal(result.action, USER_ADMIN_AUDIT_ACTIONS.passwordReset)

  // The identity context comes from the locked row, not from the caller.
  assert.equal(hashes.length, 1)
  assert.deepEqual(hashes[0].identity, { username: USERNAME, email: EMAIL })
  // Neither the plaintext nor the hash reached the audit row.
  assert.ok(!fake.everything().includes(PASSWORD))
  const audited = JSON.stringify(fake.find(MATCH.auditLogInsert)?.parameters)
  assert.ok(!audited.includes(FAKE_HASH))
  assert.ok(!audited.includes(USERNAME))
})

test('a reset password that restates the account handle is refused after the read', async () => {
  const fake = fakePool({
    rows: [
      { match: MATCH.account, rows: [accountRow()] },
      { match: MATCH.roles, rows: [{ role_code: 'user' }] },
    ],
  })
  const hashes: HasherRecord[] = []
  assert.equal(
    await codeOf(() =>
      service(fake, hashes).resetUserPassword({
        actorUserId: ACTOR_ID,
        targetUserId: TARGET_ID,
        password: `${USERNAME}-Aa1!x`,
      }),
    ),
    USER_ADMIN_INPUT_CODES.passwordPolicy,
  )
  // Refused before any KDF work and before any write.
  assert.equal(hashes.length, 0)
  assert.equal(fake.writes().length, 0)
  assert.equal(fake.journal.at(-2), 'rollback')
})

test('a structurally weak password never reaches a connection', async () => {
  for (const password of ['short1!A', 'nouppercase123!', 'NoDigits!!!!!', 12345]) {
    const fake = fakePool()
    assert.equal(
      await codeOf(() =>
        service(fake).resetUserPassword({
          actorUserId: ACTOR_ID,
          targetUserId: TARGET_ID,
          password: password as never,
        }),
      ),
      USER_ADMIN_INPUT_CODES.passwordPolicy,
    )
    assert.deepEqual(fake.journal, [])
  }
})

// ---------------------------------------------------------------------------
// tombstoneUser
// ---------------------------------------------------------------------------

test('a tombstone is a state change: nothing is deleted, and no hash survives', async () => {
  const fake = fakePool({
    rows: [
      { match: MATCH.account, rows: [accountRow()] },
      { match: MATCH.roles, rows: [{ role_code: 'user' }] },
      { match: MATCH.otherAdmins, rows: [{ n: 1 }] },
    ],
  })
  const result = await service(fake).tombstoneUser({
    actorUserId: ACTOR_ID,
    targetUserId: TARGET_ID,
  })

  const writes = fake.domainWrites()
  assert.equal(writes.length, 2)
  assert.equal(writes[0].sql, USER_ADMIN_SQL.tombstoneCredential)
  assert.equal(writes[1].sql, USER_ADMIN_SQL.tombstoneUser)
  assert.equal(writes[1].parameters[0], TARGET_ID)

  // No DELETE of any kind ran: the user row and its history are retained.
  for (const call of fake.calls) {
    assert.ok(!/^\s*DELETE/i.test(call.sql))
  }

  const sentinel = writes[0].parameters[0] as string
  assert.ok(sentinel.startsWith('revoked$'))
  assert.ok(sentinel.length >= 40)
  assert.equal(isStoredPasswordHashValid(sentinel), false)
  assert.notEqual(sentinel, FAKE_HASH)

  assert.equal(result.sessionVersion, 5)
  assert.equal(result.action, USER_ADMIN_AUDIT_ACTIONS.tombstoned)
  assert.equal(fake.journal.at(-2), 'commit')
})

test('an administrator cannot tombstone themselves or the last active admin', async () => {
  const self = fakePool({
    rows: [
      { match: MATCH.account, rows: [accountRow({ id: ACTOR_ID })] },
      { match: MATCH.roles, rows: [{ role_code: 'admin' }] },
    ],
  })
  assert.equal(
    await codeOf(() =>
      service(self).tombstoneUser({
        actorUserId: ACTOR_ID,
        targetUserId: ACTOR_ID,
      }),
    ),
    USER_ADMIN_REFUSAL_CODES.selfTombstone,
  )
  assert.equal(self.writes().length, 0)

  const last = fakePool({
    rows: [
      { match: MATCH.account, rows: [accountRow()] },
      { match: MATCH.roles, rows: [{ role_code: 'admin' }] },
      { match: MATCH.otherAdmins, rows: [{ n: 0 }] },
    ],
  })
  assert.equal(
    await codeOf(() =>
      service(last).tombstoneUser({
        actorUserId: ACTOR_ID,
        targetUserId: TARGET_ID,
      }),
    ),
    USER_ADMIN_REFUSAL_CODES.lastAdmin,
  )
  assert.equal(last.writes().length, 0)
})

// ---------------------------------------------------------------------------
// Failure paths. Everything fails closed, and everything rolls back.
// ---------------------------------------------------------------------------

test('an unauditable change is rolled back rather than committed', async () => {
  const fake = fakePool({
    rows: [
      { match: MATCH.account, rows: [accountRow()] },
      { match: MATCH.roles, rows: [{ role_code: 'user' }] },
      { match: MATCH.otherAdmins, rows: [{ n: 2 }] },
    ],
    failOn: {
      match: MATCH.auditLogInsert,
      error: new Error('audit chain unavailable: host db-01 user kaudit'),
    },
  })
  const code = await codeOf(() =>
    service(fake).setUserActivation({
      actorUserId: ACTOR_ID,
      targetUserId: TARGET_ID,
      active: false,
    }),
  )
  assert.equal(code, USER_ADMIN_FAULT_CODES.auditFailed)
  assert.ok(!fake.journal.includes('commit'))
  assert.equal(fake.journal.at(-2), 'rollback')
  assert.equal(fake.journal.at(-1), 'release')
})

test('a commit that fails rolls back and reports a commit fault', async () => {
  const fake = fakePool({
    rows: [
      { match: MATCH.account, rows: [accountRow()] },
      { match: MATCH.roles, rows: [{ role_code: 'user' }] },
    ],
    failCommit: true,
  })
  assert.equal(
    await codeOf(() =>
      service(fake).resetUserPassword({
        actorUserId: ACTOR_ID,
        targetUserId: TARGET_ID,
        password: PASSWORD,
      }),
    ),
    USER_ADMIN_FAULT_CODES.commitFailed,
  )
  assert.equal(fake.journal.at(-2), 'rollback')
})

test('a guarded write that matches the wrong number of rows abandons the change', async () => {
  const fake = fakePool({
    rows: [
      { match: MATCH.account, rows: [accountRow()] },
      { match: MATCH.roles, rows: [{ role_code: 'user' }] },
    ],
    // The guard held against a row that moved after the read.
    affected: [{ match: 'UPDATE kaudit_user_credential', affectedRows: 0 }],
  })
  assert.equal(
    await codeOf(() =>
      service(fake).resetUserPassword({
        actorUserId: ACTOR_ID,
        targetUserId: TARGET_ID,
        password: PASSWORD,
      }),
    ),
    USER_ADMIN_FAULT_CODES.writeCountUnexpected,
  )
  assert.ok(!fake.journal.includes('commit'))
  assert.equal(fake.journal.at(-2), 'rollback')
})

test('a role replacement that removes more rows than it read is abandoned', async () => {
  const fake = fakePool({
    rows: [
      { match: MATCH.account, rows: [accountRow()] },
      { match: MATCH.roles, rows: [{ role_code: 'user' }] },
      { match: MATCH.otherAdmins, rows: [{ n: 3 }] },
    ],
    affected: [{ match: MATCH.deleteRoles, affectedRows: 2 }],
  })
  assert.equal(
    await codeOf(() =>
      service(fake).updateUser({
        actorUserId: ACTOR_ID,
        targetUserId: TARGET_ID,
        username: USERNAME,
        email: EMAIL,
        role: 'admin',
      }),
    ),
    USER_ADMIN_FAULT_CODES.writeCountUnexpected,
  )
  assert.ok(!fake.journal.includes('commit'))
})

test('a failed read is a bounded fault that quotes nothing', async () => {
  const fake = fakePool({
    failOn: {
      match: MATCH.account,
      error: new Error(
        "Access denied for user 'kaudit'@'10.0.0.4' (using password: YES)",
      ),
    },
  })
  let thrown: unknown
  try {
    await service(fake).tombstoneUser({
      actorUserId: ACTOR_ID,
      targetUserId: TARGET_ID,
    })
  } catch (error) {
    thrown = error
  }
  assert.ok(thrown instanceof UserAdminError)
  assert.equal(thrown.code, USER_ADMIN_FAULT_CODES.readFailed)
  assert.equal(thrown.message, thrown.code)
  assert.equal(thrown.kind, 'fault')
  for (const secret of ['kaudit', '10.0.0.4', 'password']) {
    assert.ok(!thrown.message.includes(secret))
  }
  assert.equal(fake.journal.at(-2), 'rollback')
})

test('a hasher that returns something unstorable writes nothing', async () => {
  const fake = fakePool({
    rows: [
      { match: MATCH.account, rows: [accountRow()] },
      { match: MATCH.roles, rows: [{ role_code: 'user' }] },
    ],
  })
  const port = createMysqlUserAdministration(fake.pool, {
    now: () => NOW,
    newId: ids(),
    async hashPassword() {
      return 'too-short'
    },
  })
  assert.equal(
    await codeOf(() =>
      port.resetUserPassword({
        actorUserId: ACTOR_ID,
        targetUserId: TARGET_ID,
        password: PASSWORD,
      }),
    ),
    USER_ADMIN_FAULT_CODES.hashUnusable,
  )
  assert.equal(fake.writes().length, 0)
})

test('a connection that cannot be taken is a bounded fault', async () => {
  const fake = fakePool({ failGetConnection: true })
  assert.equal(
    await codeOf(() =>
      service(fake).tombstoneUser({
        actorUserId: ACTOR_ID,
        targetUserId: TARGET_ID,
      }),
    ),
    USER_ADMIN_FAULT_CODES.unexpected,
  )
  assert.equal(fake.calls.length, 0)
})

test('every state-changing operation requires an authenticated actor', async () => {
  const port = (fake: ReturnType<typeof fakePool>) => service(fake)
  const operations: Array<(p: ReturnType<typeof service>) => Promise<unknown>> = [
    (p) =>
      p.createUser({
        actorUserId: '' as never,
        username: USERNAME,
        email: EMAIL,
        password: PASSWORD,
        role: 'user',
      }),
    (p) =>
      p.updateUser({
        actorUserId: '' as never,
        targetUserId: TARGET_ID,
        username: USERNAME,
        email: EMAIL,
        role: 'user',
      }),
    (p) =>
      p.setUserActivation({
        actorUserId: '' as never,
        targetUserId: TARGET_ID,
        active: false,
      }),
    (p) =>
      p.resetUserPassword({
        actorUserId: '' as never,
        targetUserId: TARGET_ID,
        password: PASSWORD,
      }),
    (p) => p.tombstoneUser({ actorUserId: '' as never, targetUserId: TARGET_ID }),
    (p) => p.listUsers({ actorUserId: '' as never }),
  ]
  for (const operate of operations) {
    const fake = fakePool()
    assert.equal(
      await codeOf(() => operate(port(fake))),
      USER_ADMIN_INPUT_CODES.actorInvalid,
    )
    assert.deepEqual(fake.journal, [])
  }
})

test('nothing the adapter runs reaches a table outside the Kaudit user schema', async () => {
  const fake = fakePool({
    rows: [
      { match: MATCH.account, rows: [accountRow()] },
      { match: MATCH.roles, rows: [{ role_code: 'user' }] },
      { match: MATCH.otherAdmins, rows: [{ n: 1 }] },
    ],
  })
  await service(fake).tombstoneUser({
    actorUserId: ACTOR_ID,
    targetUserId: TARGET_ID,
  })
  const allowed = new Set([
    'kaudit_user',
    'kaudit_user_credential',
    'kaudit_user_role',
    // Reached only through recordAuditEventInTransaction.
    'kaudit_audit_log',
    'kaudit_audit_chain_head',
    'information_schema.COLUMNS',
  ])
  for (const statement of fake.statements()) {
    // `ON DUPLICATE KEY UPDATE <column> = ...` names a column, not a table.
    const sql = statement.replace(/ON DUPLICATE KEY UPDATE[\s\S]*/i, '')
    for (const match of sql.matchAll(
      /\b(?:FROM|JOIN|INTO|UPDATE)\s+`?([A-Za-z_][A-Za-z0-9_.]*)`?/g,
    )) {
      assert.ok(allowed.has(match[1]), `unexpected table at runtime: ${match[1]}`)
    }
  }
  assert.ok(!/ai_voice_leads_received|kcrm/i.test(fake.everything()))
})
