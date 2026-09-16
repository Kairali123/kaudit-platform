import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Pool } from 'mysql2/promise'
import { collectAutomatedValidationCandidates } from './mysqlAutomatedValidation.ts'

/**
 * Contract for the automated-validation candidate scope.
 *
 * The month-wide run must keep exactly the shape it had, and the exact-call
 * scope a late-recording correction uses must be able only to NARROW it. Every
 * identifier here is SYNTHETIC and no database is contacted.
 */

function capture(): {
  pool: Pool
  statements: Array<{ sql: string; parameters: unknown[] }>
} {
  const statements: Array<{ sql: string; parameters: unknown[] }> = []
  const pool = {
    async execute(sql: string, parameters: unknown[] = []) {
      statements.push({ sql, parameters })
      return [[], []] as never
    },
  } as unknown as Pool
  return { pool, statements }
}

test('the month-wide run is unchanged by the exact scope existing', async () => {
  const fixture = capture()
  await collectAutomatedValidationCandidates(fixture.pool, {
    start: '2026-06-01',
    end: '2026-06-30',
    limit: 10,
  })
  const statement = fixture.statements[0]
  assert.doesNotMatch(statement.sql, /c\.id IN \(/)
  assert.deepEqual(statement.parameters, ['2026-06-01', '2026-06-30', 10])
})

test('an exact scope narrows the month and never widens it', async () => {
  const fixture = capture()
  await collectAutomatedValidationCandidates(fixture.pool, {
    start: '2026-06-01',
    end: '2026-06-30',
    limit: 10,
    callIds: ['synthetic-call-1', 'synthetic-call-2'],
  })
  const statement = fixture.statements[0]
  // The month predicate is still there; the scope is added to it.
  assert.match(statement.sql, /billing_period_date BETWEEN \? AND \?/)
  assert.match(statement.sql, /c\.id IN \(\?,\?\)/)
  assert.deepEqual(statement.parameters, [
    '2026-06-01',
    '2026-06-30',
    'synthetic-call-1',
    'synthetic-call-2',
    10,
  ])
})

test('an empty exact scope selects nothing rather than everything', async () => {
  // The difference between "no scope given" and "a scope that resolved to
  // nothing" is the difference between a month-wide run and a no-op. Getting
  // it wrong would validate an entire month on an empty batch.
  const fixture = capture()
  assert.deepEqual(
    await collectAutomatedValidationCandidates(fixture.pool, {
      start: '2026-06-01',
      end: '2026-06-30',
      limit: 10,
      callIds: [],
    }),
    [],
  )
  assert.deepEqual(fixture.statements, [])
})
