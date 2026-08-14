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
