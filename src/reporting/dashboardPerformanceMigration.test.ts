import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const sql = readFileSync(
  new URL(
    '../../migrations/0014_dashboard_read_indexes.sql',
    import.meta.url,
  ),
  'utf8',
)
const executable = sql.replace(/^\s*--.*$/gm, '')

test('dashboard performance migration adds only the measured read indexes', () => {
  assert.match(
    executable,
    /ALTER TABLE `kaudit_call`[\s\S]*`billing_period_date`, `id`/,
  )
  assert.match(
    executable,
    /ALTER TABLE `kaudit_billing_calculation`[\s\S]*`supersedes_calculation_id`/,
  )
  const targets = [...executable.matchAll(/ALTER TABLE `([^`]+)`/g)].map(
    (match) => match[1],
  )
  assert.deepEqual(targets, [
    'kaudit_call',
    'kaudit_billing_calculation',
  ])
})

test('dashboard performance migration is schema-only and stays inside Billing Audit', () => {
  assert.doesNotMatch(
    executable,
    /\b(?:INSERT|UPDATE|DELETE|REPLACE|DROP|TRUNCATE|LOCK)\b/i,
  )
  assert.doesNotMatch(sql, /ai_voice_leads_received/i)
  assert.doesNotMatch(sql, /kaudit_call_audit_/i)
})

test('0021 adds only the two leading-column Task ID lookup indexes', async () => {
  const { readFile } = await import('node:fs/promises')
  const sql = await readFile(
    new URL('../../migrations/0021_task_reference_lookup_indexes.sql', import.meta.url),
    'utf8',
  )
  const statements = sql
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n')
    .split(';')
    .map((statement) => statement.trim())
    .filter(Boolean)
  assert.equal(statements.length, 2)
  for (const statement of statements) {
    assert.match(statement, /^ALTER TABLE `kaudit_call(_external_reference)?`\s+ADD INDEX/)
    assert.match(statement, /ALGORITHM=INPLACE, LOCK=NONE$/)
    assert.doesNotMatch(statement, /\b(DROP|UPDATE|DELETE|INSERT|MODIFY)\b/i)
  }
  assert.match(statements[0]!, /\(`logical_call_key`, `billing_period_date`\)/)
  assert.match(statements[1]!, /\(`external_id`, `reference_type`, `call_id`\)/)
})

test('0022 only creates the page snapshot cache table', async () => {
  const { readFile } = await import('node:fs/promises')
  const sql = (await readFile(
    new URL('../../migrations/0022_page_snapshot.sql', import.meta.url),
    'utf8',
  )).split('\n').filter((line) => !line.trim().startsWith('--')).join('\n')
  // Column comments contain ';', so count statements by keyword.
  assert.equal(sql.match(/\bCREATE TABLE\b/g)?.length, 1)
  assert.match(sql.trim(), /^CREATE TABLE `kaudit_page_snapshot`/)
  // One statement, a CREATE TABLE ("ON UPDATE" is its timestamp column).
  assert.doesNotMatch(sql, /\b(ALTER|DROP|DELETE|INSERT)\b/i)
})
