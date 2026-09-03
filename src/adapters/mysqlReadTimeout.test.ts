import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Pool } from 'mysql2/promise'
import {
  boundedSelect,
  databaseEngine,
  isDatabaseStatementTimeout,
  withDatabaseSelectTimeout,
} from './mysqlReadTimeout.ts'
import {
  BILLING_READ_TIMEOUT_VARIABLE,
  configuredBillingReadTimeoutSeconds,
} from '../config/runtime.ts'

test('billing SELECTs receive one engine-specific per-statement timeout', async () => {
  const statements: unknown[] = []
  const source = {
    async query(sql: unknown) {
      statements.push(sql)
      if (sql === 'SELECT VERSION() AS version') {
        return [[{ version: '10.11.8-MariaDB' }], []]
      }
      return [[], []]
    },
  } as unknown as Pool
  const pool = withDatabaseSelectTimeout(source, 20)

  await pool.query('SELECT COUNT(*) FROM kaudit_call')

  assert.deepEqual(statements, [
    'SELECT VERSION() AS version',
    'SET STATEMENT max_statement_time=20 FOR SELECT COUNT(*) FROM kaudit_call',
  ])
})

test('MySQL SELECTs use its millisecond optimizer hint', () => {
  assert.equal(databaseEngine('8.4.0 MySQL Community Server'), 'mysql')
  assert.equal(
    boundedSelect('SELECT 1', 'mysql', 20),
    'SELECT /*+ MAX_EXECUTION_TIME(20000) */ 1',
  )
  assert.equal(databaseEngine('10.11.8-MariaDB'), 'mariadb')
  assert.equal(databaseEngine('unknown'), null)
})

test('the production timeout is explicit and bounded by configuration', () => {
  assert.equal(configuredBillingReadTimeoutSeconds({}), null)
  assert.equal(
    configuredBillingReadTimeoutSeconds({
      [BILLING_READ_TIMEOUT_VARIABLE]: '20',
    }),
    20,
  )
  assert.throws(
    () => configuredBillingReadTimeoutSeconds({
      [BILLING_READ_TIMEOUT_VARIABLE]: '30',
    }),
    new RegExp(BILLING_READ_TIMEOUT_VARIABLE),
  )
})

test('the timeout wrapper does not alter writes or session state', async () => {
  const statements: unknown[] = []
  const source = {
    async query(sql: unknown) {
      statements.push(sql)
      return [[], []]
    },
  } as unknown as Pool
  const pool = withDatabaseSelectTimeout(source, 20)

  await pool.query('INSERT INTO synthetic_table (id) VALUES (?)', [1])
  await pool.query('SET @synthetic = 1')

  assert.deepEqual(statements, [
    'INSERT INTO synthetic_table (id) VALUES (?)',
    'SET @synthetic = 1',
  ])
})

test('only bounded database timeout codes are classified', () => {
  assert.equal(
    isDatabaseStatementTimeout({ code: 'ER_STATEMENT_TIMEOUT' }),
    true,
  )
  assert.equal(isDatabaseStatementTimeout({ code: 'ER_QUERY_TIMEOUT' }), true)
  assert.equal(isDatabaseStatementTimeout({ code: 'ER_PARSE_ERROR' }), false)
  assert.equal(isDatabaseStatementTimeout(new Error('timeout prose')), false)
})

test('a timed-out bounded SELECT is tagged as statement execution', async () => {
  const timeout = Object.assign(new Error('synthetic timeout'), {
    code: 'ER_STATEMENT_TIMEOUT',
  })
  const source = {
    async query(sql: string) {
      if (sql === 'SELECT VERSION() AS version') {
        return [[{ version: '10.11.8-MariaDB' }], []]
      }
      throw timeout
    },
  } as unknown as Pool

  await assert.rejects(
    withDatabaseSelectTimeout(source, 20).query('SELECT 1'),
    (error) => error === timeout,
  )
  assert.equal(
    (timeout as Error & { kauditPhase?: string }).kauditPhase,
    'statement_execution',
  )
  assert.equal(Object.keys(timeout).includes('kauditPhase'), false)
})
