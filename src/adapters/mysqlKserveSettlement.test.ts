import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { Pool } from 'mysql2/promise'
import {
  createMysqlKserveSettlementRepository,
  settlementTimestampOf,
  toSettlementVersion,
} from './mysqlKserveSettlement.ts'
import {
  KserveSettlementConflictError,
  KserveSettlementInputError,
  KserveSettlementUnavailableError,
  buildSettlementId,
  buildSettlementRequestDigest,
} from '../billing/kserveSettlement.ts'

/**
 * Persistence contract for the append-only monthly KServe settlement.
 *
 * Every fixture is SYNTHETIC: no real month, amount, user id, or key appears
 * here, and no test opens a database. The pool is a recorder that returns
 * scripted rows, so the assertions are about the STATEMENTS and the decisions
 * around them — which is exactly what an append-only financial table needs
 * pinned.
 */

const MONTH = '2026-08'
const KEY = 'set-0000-1111-2222'
const AMOUNT = '1500.25'
const NORMALIZED = '1500.25000000'
const ACTOR = 'user-synthetic-1'

interface Recorded {
  sql: string
  parameters: unknown[]
}

function versionRow(overrides: Record<string, unknown> = {}) {
  return {
    version_no: 1,
    final_paid_amount: NORMALIZED,
    currency: 'INR',
    recorded_at: '2026-09-01 10:00:00.000000',
    ...overrides,
  }
}

/**
 * A pool whose single connection scripts each statement by matching its text.
 * Transaction control is recorded so a rollback can be asserted.
 */
function poolWith(
  script: (sql: string, parameters: unknown[]) => unknown,
  calls: Recorded[] = [],
  lifecycle: string[] = [],
): { pool: Pool; calls: Recorded[]; lifecycle: string[] } {
  const connection = {
    async beginTransaction() {
      lifecycle.push('begin')
    },
    async commit() {
      lifecycle.push('commit')
    },
    async rollback() {
      lifecycle.push('rollback')
    },
    release() {
      lifecycle.push('release')
    },
    async execute(sql: string, parameters: unknown[]) {
      calls.push({ sql, parameters })
      return [script(sql, parameters), []]
    },
  }
  const pool = {
    async getConnection() {
      return connection
    },
    async execute(sql: string, parameters: unknown[]) {
      calls.push({ sql, parameters })
      return [script(sql, parameters), []]
    },
  } as unknown as Pool
  return { pool, calls, lifecycle }
}

function fixedClock(): Date {
  return new Date('2026-09-01T10:00:00.000Z')
}

/**
 * The locked idempotency-key lookup, distinguished from the INSERT — whose
 * column list also names `idempotency_key` — so a script cannot accidentally
 * answer a write as though it were the replay probe.
 */
function isKeyLookup(sql: string): boolean {
  return sql.startsWith('SELECT') && /`idempotency_key` = \?/.test(sql)
}

function isCurrentLookup(sql: string): boolean {
  return sql.startsWith('SELECT') && /ORDER BY `version_no` DESC/.test(sql)
}

// ---------------------------------------------------------------------------
// Statements
// ---------------------------------------------------------------------------

test('no statement updates, deletes, or touches another table', async () => {
  const source = readFileSync(
    fileURLToPath(new URL('./mysqlKserveSettlement.ts', import.meta.url)),
    'utf8',
  )
  // Comments legitimately name the statements the module refuses to contain,
  // so they are stripped first. `FOR UPDATE` is a locking READ and is expected,
  // so it goes too: what is left is code that writes.
  const writes = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('//'))
    .join('\n')
    .replaceAll('FOR UPDATE', '')
  for (const forbidden of [
    /\bUPDATE\b/,
    /\bDELETE\s+FROM\b/,
    /\bTRUNCATE\b/,
    /\bDROP\b/,
  ]) {
    assert.equal(forbidden.test(writes), false, `module contains ${forbidden}`)
  }
  // Exactly one table is named, through the one TABLE constant, and it is the
  // settlement table.
  assert.match(
    source,
    /const TABLE = '`kaudit_kserve_monthly_settlement`'/,
  )
  for (const [, named] of source.matchAll(
    /(?:FROM|INTO)\s+(?!\$\{TABLE\})([`\w]+)/g,
  )) {
    assert.fail(`a statement names ${named} instead of the TABLE constant`)
  }
  // The module's own prose names the external source table to state the
  // boundary; no STATEMENT may.
  assert.equal(writes.includes('ai_voice_leads_received'), false)
  assert.equal(/kaudit_call\b/.test(writes), false)
  assert.equal(/kaudit_provider_cost/.test(writes), false)
})

// ---------------------------------------------------------------------------
// Reading history
// ---------------------------------------------------------------------------

test('history is newest first, bounded, and marks only the tail as current', async () => {
  const { pool, calls } = poolWith(() => [
    versionRow({ version_no: 3, final_paid_amount: '900.00000000' }),
    versionRow({ version_no: 2, final_paid_amount: '950.00000000' }),
    versionRow({ version_no: 1, final_paid_amount: '1000.00000000' }),
  ])
  const history = await createMysqlKserveSettlementRepository(
    pool,
  ).readHistory(MONTH, 3)

  assert.deepEqual(
    history.versions.map((version) => [version.versionNo, version.isCurrent]),
    [
      [3, true],
      [2, false],
      [1, false],
    ],
  )
  assert.equal(history.truncated, false)
  assert.match(calls[0].sql, /ORDER BY `version_no` DESC/)
  assert.match(calls[0].sql, /LIMIT \?$/)
  // One extra row is asked for so truncation costs no second query.
  assert.deepEqual(calls[0].parameters, [MONTH, 4])
  assert.equal(calls.length, 1)
})

test('a limit beyond the server maximum is clamped, and overflow is reported', async () => {
  const { pool, calls } = poolWith(() =>
    Array.from({ length: 51 }, (_unused, index) =>
      versionRow({ version_no: 51 - index }),
    ),
  )
  const history = await createMysqlKserveSettlementRepository(
    pool,
  ).readHistory(MONTH, 9_999)
  assert.equal(calls[0].parameters[1], 51)
  assert.equal(history.versions.length, 50)
  assert.equal(history.truncated, true)
})

test('an empty month is empty, not a zero settlement', async () => {
  const { pool } = poolWith(() => [])
  const history = await createMysqlKserveSettlementRepository(
    pool,
  ).readHistory(MONTH, 10)
  assert.deepEqual(history, { versions: [], truncated: false })
})

// ---------------------------------------------------------------------------
// Recording: first version
// ---------------------------------------------------------------------------

test('the first version of a month is version 1 and supersedes nothing', async () => {
  const { pool, calls, lifecycle } = poolWith((sql) =>
    /^SELECT/.test(sql) ? [] : { affectedRows: 1 },
  )
  const result = await createMysqlKserveSettlementRepository(
    pool,
    fixedClock,
  ).recordSettlement({
    month: MONTH,
    finalPaidAmountInr: AMOUNT,
    idempotencyKey: KEY,
    recordedByUserId: ACTOR,
    correlationId: 'corr-synthetic',
  })

  assert.deepEqual(result, {
    versionNo: 1,
    finalPaidAmountInr: NORMALIZED,
    currency: 'INR',
    recordedAt: '2026-09-01 10:00:00.000000',
    outcome: 'recorded',
  })
  const insert = calls.find((call) => call.sql.startsWith('INSERT INTO'))
  assert.ok(insert)
  assert.deepEqual(insert.parameters, [
    buildSettlementId(MONTH, KEY),
    MONTH,
    '2026-08-01',
    '2026-08-31',
    'INR',
    NORMALIZED,
    1,
    null,
    KEY,
    buildSettlementRequestDigest({
      billMonth: MONTH,
      currency: 'INR',
      finalPaidAmountInr: NORMALIZED,
      idempotencyKey: KEY,
    }),
    ACTOR,
    'corr-synthetic',
    '2026-09-01 10:00:00.000000',
  ])
  assert.ok(lifecycle.includes('commit'))
})

// ---------------------------------------------------------------------------
// Recording: supersession
// ---------------------------------------------------------------------------

test('a correction appends a new version that supersedes the current one', async () => {
  const priorId = buildSettlementId(MONTH, 'set-prior-key-000000')
  const { pool, calls } = poolWith((sql) => {
    if (isKeyLookup(sql)) return []
    if (isCurrentLookup(sql)) return [{ id: priorId, version_no: 2 }]
    return { affectedRows: 1 }
  })
  const result = await createMysqlKserveSettlementRepository(
    pool,
    fixedClock,
  ).recordSettlement({
    month: MONTH,
    finalPaidAmountInr: AMOUNT,
    idempotencyKey: KEY,
  })

  assert.equal(result.versionNo, 3)
  assert.equal(result.outcome, 'recorded')
  const insert = calls.find((call) => call.sql.startsWith('INSERT INTO'))
  assert.ok(insert)
  assert.equal(insert.parameters[6], 3)
  assert.equal(insert.parameters[7], priorId)
  // The prior version was READ under a lock and never written to.
  const lockRead = calls.find((call) => isCurrentLookup(call.sql))
  assert.match(lockRead?.sql ?? '', /FOR UPDATE/)
  assert.equal(
    calls.some((call) => /^UPDATE/.test(call.sql)),
    false,
    'a prior version was rewritten',
  )
})

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------

test('an exact retry replays the stored version and writes nothing', async () => {
  const digest = buildSettlementRequestDigest({
    billMonth: MONTH,
    currency: 'INR',
    finalPaidAmountInr: NORMALIZED,
    idempotencyKey: KEY,
  })
  const { pool, calls, lifecycle } = poolWith((sql) =>
    isKeyLookup(sql)
      ? [versionRow({ version_no: 2, request_digest: digest })]
      : { affectedRows: 1 },
  )
  const result = await createMysqlKserveSettlementRepository(
    pool,
    fixedClock,
  ).recordSettlement({
    month: MONTH,
    finalPaidAmountInr: AMOUNT,
    idempotencyKey: KEY,
  })

  assert.equal(result.outcome, 'replayed')
  assert.equal(result.versionNo, 2)
  assert.equal(result.finalPaidAmountInr, NORMALIZED)
  assert.equal(
    calls.some((call) => call.sql.startsWith('INSERT INTO')),
    false,
    'a retry inserted a second version',
  )
  assert.ok(lifecycle.includes('rollback'))
  assert.equal(lifecycle.includes('commit'), false)
})

test('the same key carrying a different amount is a conflict, not a new version', async () => {
  const { pool, calls, lifecycle } = poolWith((sql) =>
    isKeyLookup(sql)
      ? [
          versionRow({
            request_digest: buildSettlementRequestDigest({
              billMonth: MONTH,
              currency: 'INR',
              finalPaidAmountInr: '999.00000000',
              idempotencyKey: KEY,
            }),
          }),
        ]
      : { affectedRows: 1 },
  )
  await assert.rejects(
    createMysqlKserveSettlementRepository(pool, fixedClock).recordSettlement({
      month: MONTH,
      finalPaidAmountInr: AMOUNT,
      idempotencyKey: KEY,
    }),
    (error: unknown) => {
      assert.ok(error instanceof KserveSettlementConflictError)
      assert.equal(error.status, 409)
      assert.equal(error.field, 'idempotencyKey')
      // Neither amount is echoed.
      assert.equal(error.message.includes('999'), false)
      assert.equal(error.message.includes('1500'), false)
      return true
    },
  )
  assert.equal(
    calls.some((call) => call.sql.startsWith('INSERT INTO')),
    false,
  )
  assert.ok(lifecycle.includes('rollback'))
})

// ---------------------------------------------------------------------------
// Concurrency
// ---------------------------------------------------------------------------

test('a lost race on the version key is a typed conflict, never a duplicate', async () => {
  const { pool, lifecycle } = poolWith((sql) => {
    if (isKeyLookup(sql)) return []
    if (isCurrentLookup(sql)) {
      return [
        { id: buildSettlementId(MONTH, 'set-other-key-00000'), version_no: 1 },
      ]
    }
    throw Object.assign(
      new Error(
        "Duplicate entry '2026-08-2' for key 'uq_kserve_settlement_month_version'",
      ),
      { code: 'ER_DUP_ENTRY' },
    )
  })
  await assert.rejects(
    createMysqlKserveSettlementRepository(pool, fixedClock).recordSettlement({
      month: MONTH,
      finalPaidAmountInr: AMOUNT,
      idempotencyKey: KEY,
    }),
    (error: unknown) => {
      assert.ok(error instanceof KserveSettlementConflictError)
      assert.equal(error.field, 'month')
      // The driver's own message, key name and value stay inside the adapter.
      assert.equal(error.message.includes('Duplicate entry'), false)
      assert.equal(error.message.includes('uq_kserve_settlement'), false)
      return true
    },
  )
  assert.ok(lifecycle.includes('rollback'))
  assert.ok(lifecycle.includes('release'))
})

// ---------------------------------------------------------------------------
// Bounded failure and privacy
// ---------------------------------------------------------------------------

test('an unknown database failure is bounded and carries no stored value', async () => {
  for (const method of ['read', 'write'] as const) {
    const { pool } = poolWith(() => {
      throw new Error(
        "ER_PARSE_ERROR near `final_paid_amount` = 1500.25 for kms_abc123",
      )
    })
    const repository = createMysqlKserveSettlementRepository(pool, fixedClock)
    await assert.rejects(
      method === 'read'
        ? repository.readHistory(MONTH, 10)
        : repository.recordSettlement({
            month: MONTH,
            finalPaidAmountInr: AMOUNT,
            idempotencyKey: KEY,
          }),
      (error: unknown) => {
        assert.ok(error instanceof KserveSettlementUnavailableError)
        assert.equal(error.status, 503)
        for (const leak of ['1500.25', 'kms_', 'final_paid_amount', 'ER_PARSE']) {
          assert.equal(error.message.includes(leak), false, leak)
        }
        return true
      },
    )
  }
})

test('malformed input is refused before any connection is taken', async () => {
  let opened = 0
  const pool = {
    async getConnection() {
      opened += 1
      throw new Error('no connection should be needed')
    },
  } as unknown as Pool
  await assert.rejects(
    createMysqlKserveSettlementRepository(pool).recordSettlement({
      month: 'all',
      finalPaidAmountInr: '-5.00',
      idempotencyKey: 'x',
    }),
    (error: unknown) => {
      assert.ok(error instanceof KserveSettlementInputError)
      assert.equal(error.field, 'month')
      return true
    },
  )
  assert.equal(opened, 0)
})

// ---------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------

test('a version is copied field by field and drops every internal column', () => {
  const version = toSettlementVersion(
    versionRow({
      request_digest: 'must-not-leak',
      id: 'kms_must_not_leak',
      idempotency_key: 'must-not-leak',
      recorded_by_user_id: 'must-not-leak',
      supersedes_settlement_id: 'must-not-leak',
      correlation_id: 'must-not-leak',
    }) as never,
    true,
  )
  assert.deepEqual(Object.keys(version).sort(), [
    'currency',
    'finalPaidAmountInr',
    'isCurrent',
    'recordedAt',
    'versionNo',
  ])
  assert.equal(JSON.stringify(version).includes('must-not-leak'), false)
})

test('the recorded stamp is a UTC-naive literal with six fractional digits', () => {
  assert.equal(
    settlementTimestampOf(new Date('2026-09-01T10:00:00.123Z')),
    '2026-09-01 10:00:00.123000',
  )
})
