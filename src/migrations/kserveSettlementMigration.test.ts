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
