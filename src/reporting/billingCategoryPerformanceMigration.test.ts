import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const sql = readFileSync(
  new URL(
    '../../migrations/0016_billing_category_analysis_indexes.sql',
    import.meta.url,
  ),
  'utf8',
)
const executable = sql.replace(/^\s*--.*$/gm, '')

test('category analysis migration adds only query-shaped read indexes', () => {
  const expected = new Map<string, RegExp>([
    [
      'kaudit_call',
      /`billing_period_date`, `canonical_outcome_code`, `source_started_at`, `id`/,
    ],
    [
      'kaudit_call_artifact',
      /`call_id`, `artifact_type`, `is_final`/,
    ],
    [
      'kaudit_provider_cost',
      /`call_id`, `provider_sku`, `is_final`/,
    ],
    [
      'kaudit_media_analysis',
      /`call_artifact_id`, `status`, `classification_status`,[\s\S]*`created_at` DESC, `id` DESC/,
    ],
    [
      'kaudit_transcript',
      /`call_artifact_id`, `status`, `call_id`/,
    ],
    [
      'kaudit_call_external_reference',
      /`call_id`, `reference_type`, `id`/,
    ],
    [
      'kaudit_audit_finding',
      /`call_id`, `finding_code`, `created_at` DESC, `id` DESC/,
    ],
  ])

  const statements = [
    ...executable.matchAll(
      /ALTER TABLE `([^`]+)`([\s\S]*?);/g,
    ),
  ]
  assert.equal(statements.length, expected.size)
  for (const statement of statements) {
    const table = statement[1]!
    const columns = expected.get(table)
    assert.ok(columns, `unexpected index target ${table}`)
    assert.match(statement[0], columns)
    expected.delete(table)
  }
  assert.deepEqual([...expected.keys()], [])
})

test('category analysis migration is additive and Kaudit-owned', () => {
  assert.doesNotMatch(
    executable,
    /\b(?:INSERT|UPDATE|DELETE|REPLACE|DROP|TRUNCATE|LOCK)\b/i,
  )
  assert.doesNotMatch(sql, /ai_voice_leads_received/i)
  assert.doesNotMatch(sql, /kaudit_call_audit_/i)
  assert.match(sql, /approved, supervised schema operation/i)
  assert.match(sql, /EXPLAIN ANALYZE/)
})
