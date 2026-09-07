import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * Migration 0013 was written, reviewed, committed — and never applied, so the
 * settlement card reported itself unreadable on every billing page load for as
 * long as it had shipped. These tests pin the properties that made that failure
 * both safe to fix and hard to repeat.
 */

function read(relative: string): string {
  return readFileSync(
    fileURLToPath(new URL(relative, import.meta.url)),
    'utf8',
  )
}

const script = read('../../scripts/apply-kserve-settlement-migration.mjs')
const migration = read('../../migrations/0013_kserve_monthly_settlement.sql')

function withoutComments(sql: string): string {
  return sql
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n')
}

/**
 * This schema documents itself heavily, and its COMMENT prose says things like
 * "a row is never updated or deleted". Scanning the file for destructive verbs
 * without removing the strings first reads that documentation as if it were
 * SQL — so the strings come out before anything is judged.
 */
function withoutStringLiterals(sql: string): string {
  return sql.replaceAll(/'(?:[^']|'')*'/g, "''")
}

test('the migration stays expand-only', () => {
  const executable = withoutStringLiterals(withoutComments(migration))
  assert.doesNotMatch(executable, /\b(DROP|TRUNCATE|DELETE|UPDATE|INSERT)\b/i)
  assert.match(executable, /CREATE TABLE `kaudit_kserve_monthly_settlement`/)
})

test('the applier reads the reviewed migration rather than restating it', () => {
  assert.match(script, /migrations\/0013_kserve_monthly_settlement\.sql/)
  // No second copy of the schema. The copy that drifts is the one nobody
  // reviewed.
  assert.doesNotMatch(script, /CREATE TABLE `kaudit/)
})

test('applying requires explicit confirmation and repeats safely', () => {
  assert.match(script, /KAUDIT_MIGRATION_CONFIRM !== 'APPLY_0013'/)
  assert.match(script, /confirmation:required/)
  // An operator unsure whether it already ran must be able to run it again.
  assert.match(script, /existedBefore/)
  assert.match(script, /already-present/)
  // Only expand statements may reach the database, whatever the file says.
  assert.match(script, /non-expand-statement/)
})

test('a semicolon inside a COMMENT string does not split a statement', () => {
  // The real schema documents itself with COMMENT strings that contain
  // semicolons; splitting naively turned one CREATE TABLE into nine fragments.
  assert.match(migration, /COMMENT '[^']*;[^']*'/)
  // So the applier must not split on the delimiter alone.
  assert.doesNotMatch(script, /\.split\(';'\)/)
  assert.match(script, /unexpected:unterminated-quote/)
})

test('the migration declares exactly the two statements the applier expects', () => {
  // The applier refuses any count other than two. If the migration ever grows
  // a third statement, this fails here rather than at 3am against production.
  const statements = withoutComments(migration)
    .split(/;(?=(?:[^']*'[^']*')*[^']*$)/)
    .map((statement) => statement.trim())
    .filter(Boolean)
  assert.equal(statements.length, 2)
  assert.match(statements[0] ?? '', /^CREATE TABLE/i)
  assert.match(statements[1] ?? '', /^ALTER TABLE/i)
})

const runner = read('../../scripts/apply-expand-migration.mjs')
const summary = read('../../migrations/0018_billing_month_summary.sql')

test('the generic runner only ever applies expand statements', () => {
  // It takes its migration from an environment variable, so what it refuses
  // matters more than what it accepts.
  assert.match(runner, /non-expand-statement/)
  assert.match(runner, /CREATE TABLE\|ALTER TABLE/)
  // And it cannot be pointed outside the reviewed migrations directory.
  assert.match(runner, /\^\[0-9\]\{4\}_\[a-z0-9_\]\+\\\.sql\$/)
  assert.match(runner, /invalid:migration-file/)
})

test('the runner names its own table and file rather than hard-coding one', () => {
  // A copy that kept another migration's table silently re-ran that migration
  // instead of the requested one.
  assert.match(runner, /required\('KAUDIT_MIGRATION_TABLE'\)/)
  assert.match(runner, /required\('KAUDIT_MIGRATION_FILE'\)/)
  assert.doesNotMatch(runner, /const TABLE = 'kaudit_/)
})

test('the month summary migration is expand-only and creates a cache', () => {
  const executable = withoutStringLiterals(withoutComments(summary))
    // `ON UPDATE current_timestamp` is a column clause, not a statement that
    // modifies data. The cache is the one table here that may be rewritten in
    // place, because it holds nothing worth a history.
    .replaceAll(/ON UPDATE current_timestamp\(\d\)/gi, '')
  assert.doesNotMatch(executable, /\b(DROP|TRUNCATE|DELETE|UPDATE|INSERT)\b/i)
  assert.match(executable, /CREATE TABLE `kaudit_billing_month_summary`/)
  // Amounts are stored as TEXT, so no cached money passes through a float.
  assert.match(summary, /`payload_json` longtext/)
  // Nothing may reference a cache: it must stay safe to truncate.
  assert.doesNotMatch(executable, /FOREIGN KEY/i)
})
