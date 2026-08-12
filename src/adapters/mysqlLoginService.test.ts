import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import type {
  CredentialRepository,
  CredentialUser,
} from '../auth/credentialTypes.ts'
import {
  deriveLoginGuardDigest,
  deriveLoginGuardSecret,
  LoginError,
  LOGIN_DENIAL_REASONS,
  LOGIN_DENIED_CODE,
  LOGIN_FAULT_CODES,
  LOGIN_GUARD_MAX_FAILURE_COUNT,
  LOGIN_GUARD_SCOPES,
  SYNTHETIC_PASSWORD_HASH,
  type LoginDenialEvent,
  type LoginResult,
} from '../auth/loginService.ts'
import { isStoredPasswordHashValid } from '../auth/passwordHash.ts'
import {
  createMysqlLoginService,
  LOGIN_SQL,
  type LoginConnection,
  type LoginPool,
} from './mysqlLoginService.ts'

// ---------------------------------------------------------------------------
// Synthetic values. No database is ever contacted and nothing here is real.
// ---------------------------------------------------------------------------

const SECRET = 'synthetic-login-guard-secret-0123456789'
const LOGIN = 'sample.operator'
const SUBMITTED_LOGIN = '  Sample.Operator  '
const EMAIL = 'sample.operator@example.invalid'
const SOURCE = '203.0.113.7'
const PASSWORD = 'Synthetic-Passphrase-9!'
const USER_ID = 'usr_synthetic_1'
const AT = new Date('2026-08-12T09:00:00.000Z')

/** A structurally valid hash derived from fixed labels; it matches no password. */
function syntheticStoredHash(label: string): string {
  const bytes = (suffix: string, size: number) =>
    createHash('sha256')
      .update(`${label}.${suffix}`)
      .digest()
      .subarray(0, size)
      .toString('base64url')
  return `scrypt$N=16384,r=8,p=1$${bytes('salt', 16)}$${bytes('digest', 32)}`
}

const STORED_HASH = syntheticStoredHash('kaudit.test.account')
/** The deliberately unparseable value migration 0009 writes over a tombstone. */
const REVOKED_SENTINEL = `revoked$${'0123456789abcdef'.repeat(3)}`

const guardSecret = deriveLoginGuardSecret(SECRET)
const LOGIN_DIGEST = deriveLoginGuardDigest(
  LOGIN_GUARD_SCOPES.login,
  LOGIN,
  guardSecret,
)
const SOURCE_DIGEST = deriveLoginGuardDigest(
  LOGIN_GUARD_SCOPES.source,
  SOURCE,
  guardSecret,
)

function account(overrides: Partial<CredentialUser> = {}): CredentialUser {
  return {
    id: USER_ID,
    usernameNormalized: LOGIN,
    email: EMAIL,
    status: 'active',
    credentialStatus: 'active',
    passwordHash: STORED_HASH,
    sessionVersion: 3,
    maxSensitivityTier: 'K1',
    roles: ['user'],
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Recording fakes
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
  affected?: { match: string; affectedRows: number }[]
  failOn?: { match: string; error: unknown }
  failCommit?: boolean
}

/** Substrings that identify one statement without restating it. */
const MATCH = {
  guardSelect: 'FROM kaudit_login_guard',
  guardUpsert: 'INSERT INTO kaudit_login_guard',
  guardDelete: 'DELETE FROM kaudit_login_guard',
  // Not 'FOR UPDATE': the audit writer locks the chain head with the same
  // words, and these matchers have to name exactly one statement each.
  lockAccount: 'AS max_sensitivity_tier',
  roles: 'SELECT role_code',
  lastLogin: 'UPDATE kaudit_user',
  auditInsert: 'INSERT INTO kaudit_audit_log',
} as const

function fakePool(options: FakeOptions = {}) {
  const calls: Call[] = []
  const journal: string[] = []
  /** Statements and transaction boundaries in ONE order, so a test can ask
   *  whether a statement really ran before the commit rather than merely
   *  before another statement. */
  const timeline: string[] = []

  function mark(event: string): void {
    journal.push(event)
    timeline.push(event)
  }

  async function run(sql: string, parameters: unknown[] = []): Promise<unknown> {
    calls.push({ sql, parameters })
    timeline.push(sql)
    if (options.failOn && sql.includes(options.failOn.match)) {
      throw options.failOn.error
    }
    if (/^\s*SELECT/i.test(sql)) {
      const configured = options.rows?.find((rule) => sql.includes(rule.match))
      if (configured) return [configured.rows, []]
      // Defaults the audit writer needs: migration 0004 is applied, and the
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

  const connection: LoginConnection = {
    execute: run,
    query: run,
    async beginTransaction() {
      mark('begin')
    },
    async commit() {
      mark('commit')
      if (options.failCommit) throw new Error('commit refused by the fake')
    },
    async rollback() {
      mark('rollback')
    },
    release() {
      mark('release')
    },
  }

  const pool: LoginPool = {
    execute: run,
    async getConnection() {
      mark('acquire')
      return connection
    },
  }

  return {
    pool,
    calls,
    journal,
    timeline,
    matching(match: string): Call[] {
      return calls.filter((call) => call.sql.includes(match))
    },
    /** Where a statement or a transaction boundary first appears. */
    step(match: string): number {
      return timeline.findIndex((entry) => entry.includes(match))
    },
  }
}

/** Records the login it was asked for, which is what proves normalize-once. */
function fakeRepository(found: CredentialUser | null) {
  const logins: unknown[] = []
  const repository: CredentialRepository = {
    async findByLogin(login) {
      logins.push(login)
      return found
    },
    async getSessionState() {
      return null
    },
    async readiness() {
      return true
    },
  }
  return { repository, logins }
}

/** Counts verifications and records what each was charged against. */
function fakeVerifier(result: boolean) {
  const hashes: unknown[] = []
  return {
    hashes,
    async verify(_password: unknown, storedHash: unknown) {
      hashes.push(storedHash)
      return result
    },
  }
}

interface HarnessOptions extends FakeOptions {
  found?: CredentialUser | null
  verified?: boolean
  guardRows?: unknown[]
}

function harness(options: HarnessOptions = {}) {
  const pool = fakePool({
    ...options,
    rows: [
      { match: MATCH.guardSelect, rows: options.guardRows ?? [] },
      ...(options.rows ?? []),
    ],
  })
  const repository = fakeRepository(options.found ?? null)
  const verifier = fakeVerifier(options.verified ?? false)
  const denials: LoginDenialEvent[] = []
  const service = createMysqlLoginService(pool.pool, repository.repository, {
    sessionSecret: SECRET,
    now: () => AT,
    newId: () => 'id_synthetic_1',
    verifyPassword: verifier.verify,
    denialSink: {
      record(event) {
        denials.push(event)
      },
    },
  })
  return { ...pool, ...repository, ...verifier, denials, service }
}

function assertDenied(result: LoginResult): void {
  assert.deepEqual(result, { ok: false, code: LOGIN_DENIED_CODE })
}

/** Nothing a caller submitted may appear in any statement or bound parameter. */
function assertNoRawValues(calls: Call[]): void {
  const serialized = JSON.stringify(calls)
  for (const value of [
    LOGIN,
    SUBMITTED_LOGIN.trim(),
    EMAIL,
    SOURCE,
    PASSWORD,
    SECRET,
    STORED_HASH,
    guardSecret.toString('hex'),
    guardSecret.toString('base64'),
  ]) {
    assert.ok(!serialized.includes(value), `raw value reached SQL: ${value}`)
  }
}

// ---------------------------------------------------------------------------
// Normalization and lookup
// ---------------------------------------------------------------------------

test('the submitted login is normalized once and looked up once', async () => {
  const fake = harness({ found: null })
  await fake.service.authenticate({
    login: SUBMITTED_LOGIN,
    password: PASSWORD,
    clientSource: SOURCE,
  })
  assert.deepEqual(fake.logins, [LOGIN])
})

test('a login that is not a login shape never reaches the repository', async () => {
  const fake = harness()
  const result = await fake.service.authenticate({
    login: '..',
    password: PASSWORD,
    clientSource: SOURCE,
  })
  assertDenied(result)
  assert.deepEqual(fake.logins, [])
  assert.deepEqual(
    fake.denials.map((denial) => denial.reason),
    [LOGIN_DENIAL_REASONS.loginMalformed],
  )
})

test('an oversize field is refused before any statement or verification', async () => {
  const fake = harness()
  const result = await fake.service.authenticate({
    login: 'x'.repeat(500),
    password: PASSWORD,
    clientSource: SOURCE,
  })
  assertDenied(result)
  assert.deepEqual(fake.calls, [])
  assert.equal(fake.hashes.length, 0)
  assert.deepEqual(
    fake.denials.map((denial) => denial.reason),
    [LOGIN_DENIAL_REASONS.loginOversize],
  )
})

// ---------------------------------------------------------------------------
// Exactly one verification, whatever the outcome
// ---------------------------------------------------------------------------

test('an unknown account is charged one verification against the synthetic hash', async () => {
  const fake = harness({ found: null })
  const result = await fake.service.authenticate({
    login: LOGIN,
    password: PASSWORD,
    clientSource: SOURCE,
  })
  assertDenied(result)
  assert.deepEqual(fake.hashes, [SYNTHETIC_PASSWORD_HASH])
  assert.deepEqual(
    fake.denials.map((denial) => denial.reason),
    [LOGIN_DENIAL_REASONS.accountUnknown],
  )
})

test('an unresolvable login is charged the same one verification', async () => {
  const fake = harness()
  await fake.service.authenticate({
    login: '..',
    password: PASSWORD,
    clientSource: SOURCE,
  })
  assert.deepEqual(fake.hashes, [SYNTHETIC_PASSWORD_HASH])
})

test('a known account is verified exactly once, against its own hash', async () => {
  const fake = harness({ found: account(), verified: false })
  const result = await fake.service.authenticate({
    login: LOGIN,
    password: PASSWORD,
    clientSource: SOURCE,
  })
  assertDenied(result)
  assert.deepEqual(fake.hashes, [STORED_HASH])
  assert.deepEqual(
    fake.denials.map((denial) => denial.reason),
    [LOGIN_DENIAL_REASONS.passwordMismatch],
  )
})

test('an unparseable stored hash still costs one real verification', async () => {
  // A tombstoned row carries an unparseable sentinel. Verifying against it
  // would return false without a KDF, which would make a closed account
  // measurably faster than a live one.
  assert.equal(isStoredPasswordHashValid(REVOKED_SENTINEL), false)
  const fake = harness({
    found: account({
      passwordHash: REVOKED_SENTINEL,
      credentialStatus: 'tombstoned',
    }),
  })
  await fake.service.authenticate({
    login: LOGIN,
    password: PASSWORD,
    clientSource: SOURCE,
  })
  assert.deepEqual(fake.hashes, [SYNTHETIC_PASSWORD_HASH])
})

test('the stored hash used for a live account is one this module can verify', () => {
  assert.equal(isStoredPasswordHashValid(STORED_HASH), true)
})

// ---------------------------------------------------------------------------
// A dummy verification decides nothing
// ---------------------------------------------------------------------------

test('an active account with a malformed stored hash fails closed, whatever the verifier answers', async () => {
  // The account is ACTIVE — nothing about its state would refuse it — and the
  // verifier is the hostile case: it answers true for everything it is handed,
  // including the synthetic hash the dummy verification is charged against.
  const fake = harness({
    found: account({ passwordHash: REVOKED_SENTINEL }),
    verified: true,
    rows: successRows(),
  })
  const result = await fake.service.authenticate({
    login: LOGIN,
    password: PASSWORD,
    clientSource: SOURCE,
  })

  assertDenied(result)
  // Still exactly one verification, and it was the dummy: timing parity is
  // kept, and its answer is not what the decision was made on.
  assert.deepEqual(fake.hashes, [SYNTHETIC_PASSWORD_HASH])
  assert.deepEqual(
    fake.denials.map((denial) => denial.reason),
    [LOGIN_DENIAL_REASONS.credentialUnusable],
  )
  // Both guards still count it, exactly as a wrong password would.
  assert.equal(fake.matching(MATCH.guardUpsert).length, 2)
  // And the success transaction is never entered.
  assert.equal(fake.matching(MATCH.lockAccount).length, 0)
  assert.equal(fake.matching(MATCH.roles).length, 0)
  assert.equal(fake.matching(MATCH.lastLogin).length, 0)
  assert.equal(fake.matching(MATCH.guardDelete).length, 0)
  assert.equal(fake.matching(MATCH.auditInsert).length, 0)
})

test('a malformed stored hash denies exactly as a wrong password does', async () => {
  const observed: LoginResult[] = []
  for (const [found, verified] of [
    [account({ passwordHash: REVOKED_SENTINEL }), true],
    [account(), false],
  ] as [CredentialUser, boolean][]) {
    const fake = harness({ found, verified, rows: successRows() })
    observed.push(
      await fake.service.authenticate({
        login: LOGIN,
        password: PASSWORD,
        clientSource: SOURCE,
      }),
    )
    assert.equal(fake.hashes.length, 1)
    assert.equal(fake.matching(MATCH.guardUpsert).length, 2)
  }
  assert.deepEqual(observed[0], observed[1])
  assertDenied(observed[0])
})

test('a tombstoned sentinel still reports the state an operator can act on', async () => {
  const fake = harness({
    found: account({
      passwordHash: REVOKED_SENTINEL,
      credentialStatus: 'tombstoned',
    }),
    verified: true,
    rows: successRows(),
  })
  assertDenied(
    await fake.service.authenticate({
      login: LOGIN,
      password: PASSWORD,
      clientSource: SOURCE,
    }),
  )
  assert.deepEqual(
    fake.denials.map((denial) => denial.reason),
    [LOGIN_DENIAL_REASONS.credentialTombstoned],
  )
  assert.equal(fake.matching(MATCH.lockAccount).length, 0)
})

// ---------------------------------------------------------------------------
// One uniform public denial
// ---------------------------------------------------------------------------

test('every denial is the same value, and only the internal reason differs', async () => {
  const cases: [string, CredentialUser | null, boolean, string][] = [
    ['unknown', null, false, LOGIN_DENIAL_REASONS.accountUnknown],
    ['wrong password', account(), false, LOGIN_DENIAL_REASONS.passwordMismatch],
    [
      'inactive user',
      account({ status: 'disabled' }),
      true,
      LOGIN_DENIAL_REASONS.accountInactive,
    ],
    [
      'disabled credential',
      account({ credentialStatus: 'disabled' }),
      true,
      LOGIN_DENIAL_REASONS.credentialDisabled,
    ],
    [
      'tombstoned credential',
      account({ credentialStatus: 'tombstoned' }),
      true,
      LOGIN_DENIAL_REASONS.credentialTombstoned,
    ],
  ]
  const results: LoginResult[] = []
  for (const [label, found, verified, reason] of cases) {
    const fake = harness({ found, verified })
    const result = await fake.service.authenticate({
      login: LOGIN,
      password: PASSWORD,
      clientSource: SOURCE,
    })
    assertDenied(result)
    results.push(result)
    assert.deepEqual(
      fake.denials.map((denial) => denial.reason),
      [reason],
      label,
    )
    // Every one of them is still exactly one verification.
    assert.equal(fake.hashes.length, 1, label)
  }
  // Indistinguishable as values, not merely as messages.
  for (const result of results) {
    assert.deepEqual(result, results[0])
  }
})

// ---------------------------------------------------------------------------
// Persistent throttling
// ---------------------------------------------------------------------------

test('a failure records both guards inside one transaction', async () => {
  const fake = harness({ found: null })
  await fake.service.authenticate({
    login: LOGIN,
    password: PASSWORD,
    clientSource: SOURCE,
  })
  const upserts = fake.matching(MATCH.guardUpsert)
  assert.equal(upserts.length, 2)
  assert.deepEqual(fake.journal, ['acquire', 'begin', 'commit', 'release'])
  assert.deepEqual(
    upserts.map((call) => call.parameters[0]),
    [LOGIN_GUARD_SCOPES.login, LOGIN_GUARD_SCOPES.source],
  )
  assert.deepEqual(
    upserts.map((call) => call.parameters[1]),
    [LOGIN_DIGEST, SOURCE_DIGEST],
  )
})

test('an unknown account still counts against the network source', async () => {
  const fake = harness({ found: null })
  await fake.service.authenticate({
    login: 'never.registered',
    password: PASSWORD,
    clientSource: SOURCE,
  })
  const upserts = fake.matching(MATCH.guardUpsert)
  assert.equal(upserts.length, 2)
  assert.ok(
    upserts.some((call) => call.parameters[1] === SOURCE_DIGEST),
    'the source guard must be counted for an account that does not exist',
  )
})

test('an unresolvable login counts only the network source', async () => {
  const fake = harness()
  await fake.service.authenticate({
    login: '..',
    password: PASSWORD,
    clientSource: SOURCE,
  })
  const upserts = fake.matching(MATCH.guardUpsert)
  assert.equal(upserts.length, 1)
  assert.equal(upserts[0].parameters[0], LOGIN_GUARD_SCOPES.source)
})

test('the failure statement is an atomic upsert, never a read-modify-write', async () => {
  const fake = harness({ found: null })
  await fake.service.authenticate({
    login: LOGIN,
    password: PASSWORD,
    clientSource: SOURCE,
  })
  for (const call of fake.matching(MATCH.guardUpsert)) {
    assert.match(call.sql, /ON DUPLICATE KEY UPDATE/)
    assert.match(call.sql, /failure_count\s*\+\s*1/)
    // The new count is never computed in JavaScript and sent back.
    assert.ok(!/failure_count\s*=\s*\?/.test(call.sql))
  }
  // Nothing reads a counter in order to write one.
  assert.equal(
    fake.calls.filter((call) => /^\s*SELECT/i.test(call.sql)).length,
    1,
  )
})

test('concurrent failures each issue their own increment, with identical SQL', async () => {
  const fake = harness({ found: null })
  await Promise.all([
    fake.service.authenticate({
      login: LOGIN,
      password: PASSWORD,
      clientSource: SOURCE,
    }),
    fake.service.authenticate({
      login: LOGIN,
      password: PASSWORD,
      clientSource: SOURCE,
    }),
  ])
  const upserts = fake.matching(MATCH.guardUpsert)
  // Two attempts, two guards each: no increment is coalesced or dropped.
  assert.equal(upserts.length, 4)
  const statements = new Set(upserts.map((call) => call.sql))
  assert.equal(statements.size, 1)
  assert.equal([...statements][0], LOGIN_SQL.upsertGuard)
})

test('a blocked guard denies before the KDF and buys no further work', async () => {
  for (const scope of [LOGIN_GUARD_SCOPES.login, LOGIN_GUARD_SCOPES.source]) {
    const fake = harness({
      found: account(),
      verified: true,
      guardRows: [
        {
          guard_scope: scope,
          failure_count: 5,
          blocked_until: new Date(AT.getTime() + 60_000),
        },
      ],
    })
    const result = await fake.service.authenticate({
      login: LOGIN,
      password: PASSWORD,
      clientSource: SOURCE,
    })
    assertDenied(result)
    assert.equal(fake.hashes.length, 0, 'no KDF for a blocked attempt')
    assert.deepEqual(fake.logins, [], 'no lookup for a blocked attempt')
    // Not counted: knocking while blocked must not extend the block.
    assert.equal(fake.matching(MATCH.guardUpsert).length, 0)
    assert.equal(fake.calls.length, 1)
  }
})

test('an expired block does not deny', async () => {
  const fake = harness({
    found: account(),
    verified: false,
    guardRows: [
      {
        guard_scope: LOGIN_GUARD_SCOPES.login,
        failure_count: 5,
        blocked_until: new Date(AT.getTime() - 1),
      },
    ],
  })
  await fake.service.authenticate({
    login: LOGIN,
    password: PASSWORD,
    clientSource: SOURCE,
  })
  assert.equal(fake.hashes.length, 1)
})

test('a guard write that fails is a bounded fault, not a denial', async () => {
  const fake = harness({
    found: null,
    failOn: { match: MATCH.guardUpsert, error: new Error('driver text') },
  })
  await assert.rejects(
    fake.service.authenticate({
      login: LOGIN,
      password: PASSWORD,
      clientSource: SOURCE,
    }),
    (error: unknown) =>
      error instanceof LoginError &&
      error.code === LOGIN_FAULT_CODES.guardWriteFailed &&
      error.message === LOGIN_FAULT_CODES.guardWriteFailed,
  )
})

test('a guard read that fails is a bounded fault carrying no driver text', async () => {
  const fake = harness({
    failOn: { match: MATCH.guardSelect, error: new Error('driver text') },
  })
  await assert.rejects(
    fake.service.authenticate({
      login: LOGIN,
      password: PASSWORD,
      clientSource: SOURCE,
    }),
    (error: unknown) =>
      error instanceof LoginError &&
      error.code === LOGIN_FAULT_CODES.guardReadFailed &&
      !error.message.includes('driver text'),
  )
})

// ---------------------------------------------------------------------------
// A guard row that is not a guard row
// ---------------------------------------------------------------------------

/** A marker that must never appear in anything this module raises or records. */
const CORRUPT_MARKER = 'corrupt-guard-marker'

function guardRow(overrides: Record<string, unknown> = {}) {
  return {
    guard_scope: LOGIN_GUARD_SCOPES.login,
    failure_count: 1,
    blocked_until: null,
    ...overrides,
  }
}

test('a corrupt guard row is one bounded fault, and never a decision', async () => {
  const cases: [string, unknown[]][] = [
    ['an unknown scope', [guardRow({ guard_scope: CORRUPT_MARKER })]],
    ['a missing scope', [guardRow({ guard_scope: null })]],
    ['a fractional counter', [guardRow({ failure_count: 1.5 })]],
    ['a counter that is not a number', [guardRow({ failure_count: CORRUPT_MARKER })]],
    ['a null counter', [guardRow({ failure_count: null })]],
    ['a negative counter', [guardRow({ failure_count: -1 })]],
    [
      'a counter past the column bound',
      [guardRow({ failure_count: LOGIN_GUARD_MAX_FAILURE_COUNT + 1 })],
    ],
    [
      'an unreadable block instant',
      [guardRow({ blocked_until: CORRUPT_MARKER })],
    ],
    [
      'an invalid block instant',
      [guardRow({ blocked_until: new Date(Number.NaN) })],
    ],
    [
      'two rows for one scope',
      [guardRow(), guardRow({ failure_count: 2 })],
    ],
  ]

  for (const [label, guardRows] of cases) {
    const fake = harness({ found: account(), verified: true, guardRows })
    await assert.rejects(
      fake.service.authenticate({
        login: LOGIN,
        password: PASSWORD,
        clientSource: SOURCE,
      }),
      (error: unknown) =>
        error instanceof LoginError &&
        error.code === LOGIN_FAULT_CODES.guardStateMalformed &&
        // The fault names the installation, never the row it was read from.
        error.message === LOGIN_FAULT_CODES.guardStateMalformed &&
        !JSON.stringify([error.message, error.name]).includes(CORRUPT_MARKER),
      label,
    )
    // Failing closed: nothing is skipped, coerced, or treated as unblocked, so
    // no KDF is bought, no account is looked up, and no counter is written.
    assert.equal(fake.hashes.length, 0, label)
    assert.deepEqual(fake.logins, [], label)
    assert.equal(fake.matching(MATCH.guardUpsert).length, 0, label)
    assert.equal(fake.matching(MATCH.lockAccount).length, 0, label)
    assert.equal(fake.denials.length, 0, label)
  }
})

test('a guard row with no block instant is a valid, counting guard', async () => {
  const fake = harness({
    found: account(),
    verified: false,
    guardRows: [
      guardRow({ failure_count: 2, blocked_until: null }),
      guardRow({ guard_scope: LOGIN_GUARD_SCOPES.source, failure_count: 0 }),
    ],
  })
  assertDenied(
    await fake.service.authenticate({
      login: LOGIN,
      password: PASSWORD,
      clientSource: SOURCE,
    }),
  )
  // Not blocked, so the attempt proceeds and is charged its one verification.
  assert.equal(fake.hashes.length, 1)
  assert.deepEqual(
    fake.denials.map((denial) => denial.reason),
    [LOGIN_DENIAL_REASONS.passwordMismatch],
  )
})

test('guard timestamps accept only strict MariaDB DATETIME values', async () => {
  for (const blockedUntil of [
    '1',
    '2026-02-30 10:00:00.000000',
    '2026-08-12T10:00:00.000000Z',
    '2026-08-12 25:00:00.000000',
    '2026-08-12 10:00:00.0000000',
  ]) {
    const fake = harness({ guardRows: [guardRow({ blocked_until: blockedUntil })] })
    await assert.rejects(
      fake.service.authenticate({
        login: LOGIN,
        password: PASSWORD,
        clientSource: SOURCE,
      }),
      (error: unknown) =>
        error instanceof LoginError &&
        error.code === LOGIN_FAULT_CODES.guardStateMalformed,
    )
  }

  for (const blockedUntil of [
    '2026-08-12 09:00:00',
    '2026-08-12 09:00:00.123456',
    new Date('2026-08-12T09:00:00.000Z'),
  ]) {
    const fake = harness({
      verified: false,
      found: account(),
      guardRows: [guardRow({ blocked_until: blockedUntil })],
    })
    assertDenied(
      await fake.service.authenticate({
        login: LOGIN,
        password: PASSWORD,
        clientSource: SOURCE,
      }),
    )
  }
})

// ---------------------------------------------------------------------------
// The trusted clock
// ---------------------------------------------------------------------------

/** Construction with a given clock, over fakes that would record any work. */
function withClock(clock: () => Date) {
  const pool = fakePool()
  const repository = fakeRepository(account())
  const verifier = fakeVerifier(true)
  const build = () =>
    createMysqlLoginService(pool.pool, repository.repository, {
      sessionSecret: SECRET,
      now: clock,
      verifyPassword: verifier.verify,
    })
  return { ...pool, ...repository, ...verifier, build }
}

test('a clock that cannot answer with a usable instant fails at construction', () => {
  const clocks: [string, () => Date][] = [
    ['an invalid Date', () => new Date(Number.NaN)],
    ['a parsed non-instant', () => new Date('not-an-instant')],
    ['a number instead of a Date', () => AT.getTime() as unknown as Date],
    ['a string instead of a Date', () => AT.toISOString() as unknown as Date],
    ['nothing at all', () => undefined as unknown as Date],
    [
      'an instant whose derived guard dates overflow',
      () => new Date(8_640_000_000_000_000),
    ],
    [
      'a clock that throws',
      () => {
        throw new Error('driver text from a broken clock')
      },
    ],
  ]
  for (const [label, clock] of clocks) {
    const fake = withClock(clock)
    assert.throws(
      fake.build,
      (error: unknown) =>
        error instanceof LoginError &&
        error.code === LOGIN_FAULT_CODES.configInvalid &&
        error.message === LOGIN_FAULT_CODES.configInvalid,
      label,
    )
    assert.deepEqual(fake.calls, [], label)
    assert.equal(fake.hashes.length, 0, label)
  }
})

test('a clock that goes bad later refuses the attempt before any HMAC, KDF, or statement', async () => {
  const answers: Date[] = [AT]
  const fake = withClock(() => answers.shift() ?? new Date(Number.NaN))
  const service = fake.build()
  await assert.rejects(
    service.authenticate({
      login: LOGIN,
      password: PASSWORD,
      clientSource: SOURCE,
    }),
    (error: unknown) =>
      error instanceof LoginError &&
      error.code === LOGIN_FAULT_CODES.configInvalid,
  )
  assert.deepEqual(fake.calls, [])
  assert.equal(fake.hashes.length, 0)
  assert.deepEqual(fake.logins, [])
})

test('a usable clock is accepted and its instant is the one every step uses', async () => {
  const fake = harness({
    found: account(),
    verified: true,
    rows: successRows(),
  })
  await fake.service.authenticate({
    login: LOGIN,
    password: PASSWORD,
    clientSource: SOURCE,
  })
  const [update] = fake.matching(MATCH.lastLogin)
  assert.equal(update.parameters[0], AT)
})

test('no raw identifier, address, or credential is ever bound to a statement', async () => {
  const fake = harness({ found: account(), verified: false })
  await fake.service.authenticate({
    login: SUBMITTED_LOGIN,
    password: PASSWORD,
    clientSource: SOURCE,
  })
  assert.ok(fake.calls.length > 0)
  assertNoRawValues(fake.calls)
  // What IS bound is a keyed digest and fixed scalars.
  for (const call of fake.matching(MATCH.guardUpsert)) {
    assert.match(String(call.parameters[1]), /^[0-9a-f]{64}$/)
  }
})

// ---------------------------------------------------------------------------
// Success
// ---------------------------------------------------------------------------

function successRows(overrides: Record<string, unknown> = {}) {
  return [
    {
      match: MATCH.lockAccount,
      rows: [
        {
          id: USER_ID,
          user_status: 'active',
          max_sensitivity_tier: 'K1',
          credential_status: 'active',
          session_version: 3,
          ...overrides,
        },
      ],
    },
    { match: MATCH.roles, rows: [{ role_code: 'user' }] },
  ]
}

test('a success locks, re-reads, stamps, resets, audits, and commits — in that order', async () => {
  const fake = harness({
    found: account(),
    verified: true,
    rows: successRows(),
  })
  const result = await fake.service.authenticate({
    login: SUBMITTED_LOGIN,
    password: PASSWORD,
    clientSource: SOURCE,
  })
  assert.deepEqual(result, {
    ok: true,
    authorization: {
      userId: USER_ID,
      sessionVersion: 3,
      roles: ['user'],
      maxSensitivityTier: 'K1',
    },
  })

  const order = fake.calls
    .map((call) => {
      if (call.sql.includes(MATCH.lockAccount)) return 'lock'
      if (call.sql.includes(MATCH.roles)) return 'roles'
      if (call.sql.includes(MATCH.lastLogin)) return 'last-login'
      if (call.sql.includes(MATCH.guardDelete)) return 'reset-guards'
      if (call.sql.includes(MATCH.auditInsert)) return 'audit'
      return null
    })
    .filter((step) => step !== null)
  assert.deepEqual(order, [
    'lock',
    'roles',
    'last-login',
    'reset-guards',
    'audit',
  ])
  // One transaction, committed once, and only after the audit row is appended.
  assert.deepEqual(fake.journal, ['acquire', 'begin', 'commit', 'release'])
  assert.equal(fake.matching(MATCH.guardUpsert).length, 0)
  assertNoRawValues(fake.calls)
})

test('the roles authorization is built from are locked, inside the transaction', async () => {
  // A role read that is not locked lets a grant or a revoke land between the
  // read and the session built from it: the session would then carry an
  // authorization that no longer matches the row it was read from.
  assert.match(LOGIN_SQL.selectRoles, /\bFOR UPDATE\s*$/)

  const fake = harness({
    found: account(),
    verified: true,
    rows: successRows(),
  })
  await fake.service.authenticate({
    login: LOGIN,
    password: PASSWORD,
    clientSource: SOURCE,
  })

  const [roles] = fake.matching(MATCH.roles)
  assert.equal(roles.sql, LOGIN_SQL.selectRoles)
  assert.match(roles.sql, /\bFOR UPDATE\b/)

  // Locked after the account lock, and held across everything the transaction
  // still has to do: the stamp, the audit append, and the commit.
  const begin = fake.step('begin')
  const lock = fake.step(MATCH.lockAccount)
  const rolesStep = fake.step(MATCH.roles)
  for (const [label, step] of [
    ['begin', begin],
    ['account lock', lock],
    ['roles', rolesStep],
  ] as [string, number][]) {
    assert.notEqual(step, -1, `${label} never happened`)
  }
  assert.ok(begin < lock, 'the account lock must be inside the transaction')
  assert.ok(lock < rolesStep, 'the account is locked before the roles are read')
  for (const later of [MATCH.lastLogin, MATCH.auditInsert, 'commit']) {
    const step = fake.step(later)
    assert.notEqual(step, -1, `${later} never happened`)
    assert.ok(rolesStep < step, `the role lock must precede ${later}`)
  }
  assert.deepEqual(fake.journal, ['acquire', 'begin', 'commit', 'release'])
})

test('the success result carries no credential material', async () => {
  const fake = harness({
    found: account(),
    verified: true,
    rows: successRows(),
  })
  const result = await fake.service.authenticate({
    login: LOGIN,
    password: PASSWORD,
    clientSource: SOURCE,
  })
  assert.equal(result.ok, true)
  assert.deepEqual(
    result.ok ? Object.keys(result.authorization).sort() : [],
    ['maxSensitivityTier', 'roles', 'sessionVersion', 'userId'],
  )
  const serialized = JSON.stringify(result)
  for (const value of [PASSWORD, STORED_HASH, EMAIL, SOURCE, LOGIN, SECRET]) {
    assert.ok(!serialized.includes(value), value)
  }
})

test('last_login_at is stamped from the trusted clock, guarded on active state', async () => {
  const fake = harness({
    found: account(),
    verified: true,
    rows: successRows(),
  })
  await fake.service.authenticate({
    login: LOGIN,
    password: PASSWORD,
    clientSource: SOURCE,
  })
  const [update] = fake.matching(MATCH.lastLogin)
  assert.deepEqual(update.parameters, [AT, USER_ID, 'user', 'active'])
})

test('both guards are cleared in the same transaction as the login', async () => {
  const fake = harness({
    found: account(),
    verified: true,
    rows: successRows(),
  })
  await fake.service.authenticate({
    login: LOGIN,
    password: PASSWORD,
    clientSource: SOURCE,
  })
  const [reset] = fake.matching(MATCH.guardDelete)
  assert.deepEqual(reset.parameters, [
    LOGIN_GUARD_SCOPES.login,
    LOGIN_DIGEST,
    LOGIN_GUARD_SCOPES.source,
    SOURCE_DIGEST,
  ])
})

test('a stale row count on the stamp abandons the login', async () => {
  const fake = harness({
    found: account(),
    verified: true,
    rows: successRows(),
    affected: [{ match: MATCH.lastLogin, affectedRows: 0 }],
  })
  await assert.rejects(
    fake.service.authenticate({
      login: LOGIN,
      password: PASSWORD,
      clientSource: SOURCE,
    }),
    (error: unknown) =>
      error instanceof LoginError &&
      error.code === LOGIN_FAULT_CODES.writeCountUnexpected,
  )
  assert.ok(fake.journal.includes('rollback'))
  assert.equal(fake.matching(MATCH.auditInsert).length, 0)
})

// ---------------------------------------------------------------------------
// The race between verification and the locked re-read
// ---------------------------------------------------------------------------

test('a generation that moved after verification denies instead of issuing', async () => {
  const fake = harness({
    found: account({ sessionVersion: 3 }),
    verified: true,
    rows: successRows({ session_version: 4 }),
  })
  const result = await fake.service.authenticate({
    login: LOGIN,
    password: PASSWORD,
    clientSource: SOURCE,
  })
  assertDenied(result)
  assert.deepEqual(
    fake.denials.map((denial) => denial.reason),
    [LOGIN_DENIAL_REASONS.stateChanged],
  )
  assert.ok(fake.journal.includes('rollback'))
  assert.ok(!fake.journal.includes('commit'))
  assert.equal(fake.matching(MATCH.lastLogin).length, 0)
  assert.equal(fake.matching(MATCH.guardDelete).length, 0)
  assert.equal(fake.matching(MATCH.auditInsert).length, 0)
})

test('an account disabled after verification denies instead of issuing', async () => {
  for (const overrides of [
    { user_status: 'disabled' },
    { credential_status: 'disabled' },
    { credential_status: 'tombstoned' },
  ]) {
    const fake = harness({
      found: account(),
      verified: true,
      rows: successRows(overrides),
    })
    assertDenied(
      await fake.service.authenticate({
        login: LOGIN,
        password: PASSWORD,
        clientSource: SOURCE,
      }),
    )
    assert.ok(!fake.journal.includes('commit'))
  }
})

test('an account that vanished between the read and the lock denies', async () => {
  const fake = harness({
    found: account(),
    verified: true,
    rows: [
      { match: MATCH.lockAccount, rows: [] },
      { match: MATCH.roles, rows: [] },
    ],
  })
  assertDenied(
    await fake.service.authenticate({
      login: LOGIN,
      password: PASSWORD,
      clientSource: SOURCE,
    }),
  )
  assert.ok(!fake.journal.includes('commit'))
})

test('an unusable stored generation is a fault, and mints nothing', async () => {
  const fake = harness({
    found: account(),
    verified: true,
    rows: successRows({ session_version: '3.5' }),
  })
  await assert.rejects(
    fake.service.authenticate({
      login: LOGIN,
      password: PASSWORD,
      clientSource: SOURCE,
    }),
    (error: unknown) =>
      error instanceof LoginError &&
      error.code === LOGIN_FAULT_CODES.stateMalformed,
  )
  assert.ok(!fake.journal.includes('commit'))
})

// ---------------------------------------------------------------------------
// A login that cannot be audited or committed is not a login
// ---------------------------------------------------------------------------

test('an audit failure rolls the whole login back', async () => {
  const fake = harness({
    found: account(),
    verified: true,
    rows: successRows(),
    failOn: { match: MATCH.auditInsert, error: new Error('driver text') },
  })
  await assert.rejects(
    fake.service.authenticate({
      login: LOGIN,
      password: PASSWORD,
      clientSource: SOURCE,
    }),
    (error: unknown) =>
      error instanceof LoginError &&
      error.code === LOGIN_FAULT_CODES.auditFailed &&
      !error.message.includes('driver text'),
  )
  assert.ok(fake.journal.includes('rollback'))
  assert.ok(!fake.journal.includes('commit'))
})

test('a commit failure yields no authorization', async () => {
  const fake = harness({
    found: account(),
    verified: true,
    rows: successRows(),
    failCommit: true,
  })
  await assert.rejects(
    fake.service.authenticate({
      login: LOGIN,
      password: PASSWORD,
      clientSource: SOURCE,
    }),
    (error: unknown) =>
      error instanceof LoginError &&
      error.code === LOGIN_FAULT_CODES.commitFailed,
  )
  assert.ok(fake.journal.includes('rollback'))
})

test('a lookup failure is a bounded fault carrying no driver text', async () => {
  const failing: CredentialRepository = {
    async findByLogin() {
      throw new Error('driver text quoting a statement')
    },
    async getSessionState() {
      return null
    },
    async readiness() {
      return true
    },
  }
  const pool = fakePool()
  const service = createMysqlLoginService(pool.pool, failing, {
    sessionSecret: SECRET,
    now: () => AT,
  })
  await assert.rejects(
    service.authenticate({
      login: LOGIN,
      password: PASSWORD,
      clientSource: SOURCE,
    }),
    (error: unknown) =>
      error instanceof LoginError &&
      error.code === LOGIN_FAULT_CODES.readFailed &&
      !error.message.includes('driver text'),
  )
})

test('a sink that throws never changes the decision', async () => {
  const pool = fakePool()
  const repository = fakeRepository(null)
  const verifier = fakeVerifier(false)
  const service = createMysqlLoginService(pool.pool, repository.repository, {
    sessionSecret: SECRET,
    now: () => AT,
    verifyPassword: verifier.verify,
    denialSink: {
      record() {
        throw new Error('sink is broken')
      },
    },
  })
  assertDenied(
    await service.authenticate({
      login: LOGIN,
      password: PASSWORD,
      clientSource: SOURCE,
    }),
  )
})

test('a denial event carries a bounded reason and an instant, and nothing else', async () => {
  const fake = harness({ found: null })
  await fake.service.authenticate({
    login: LOGIN,
    password: PASSWORD,
    clientSource: SOURCE,
  })
  assert.equal(fake.denials.length, 1)
  assert.deepEqual(Object.keys(fake.denials[0]).sort(), [
    'occurredAt',
    'reason',
  ])
  assert.equal(fake.denials[0].occurredAt, AT)
  const serialized = JSON.stringify(fake.denials)
  for (const value of [LOGIN, EMAIL, SOURCE, PASSWORD, LOGIN_DIGEST, SOURCE_DIGEST]) {
    assert.ok(!serialized.includes(value), value)
  }
})

test('no failed attempt writes an audit-log row', async () => {
  // Deliberate: the audit chain serializes on one head row, so an append that
  // an unauthenticated request could force would be a denial-of-service lever.
  const fake = harness({ found: account(), verified: false })
  await fake.service.authenticate({
    login: LOGIN,
    password: PASSWORD,
    clientSource: SOURCE,
  })
  assert.equal(fake.matching(MATCH.auditInsert).length, 0)
  assert.equal(fake.matching('kaudit_audit_chain_head').length, 0)
})

// ---------------------------------------------------------------------------
// Statement inventory
// ---------------------------------------------------------------------------

test('every statement is fixed text against Kaudit-owned tables only', () => {
  const allowed = [
    'kaudit_login_guard',
    'kaudit_user',
    'kaudit_user_credential',
    'kaudit_user_role',
  ]
  const references = [
    /\b(?:FROM|JOIN|INTO)\s+`?([a-z_][a-z0-9_]*)`?/gi,
    // Only a leading UPDATE names a table; `ON DUPLICATE KEY UPDATE` does not.
    /^\s*UPDATE\s+`?([a-z_][a-z0-9_]*)`?/gim,
  ]
  for (const sql of Object.values(LOGIN_SQL)) {
    assert.ok(!sql.includes('${'), 'no interpolation')
    for (const reference of references) {
      for (const [, table] of sql.matchAll(reference)) {
        assert.ok(allowed.includes(table), `unexpected table: ${table}`)
      }
    }
  }
})

test('nothing in this feature references CRM or external lead tables', () => {
  const files = [
    'src/auth/loginService.ts',
    'src/adapters/mysqlLoginService.ts',
    'migrations/0010_create_login_guard.sql',
  ]
  const forbidden = ['kcrm', 'ai_voice_leads_received', 'crm_']
  for (const file of files) {
    const source = readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8')
    for (const needle of forbidden) {
      assert.ok(
        !source.toLowerCase().includes(needle),
        `${file} must not reference ${needle}`,
      )
    }
  }
})
