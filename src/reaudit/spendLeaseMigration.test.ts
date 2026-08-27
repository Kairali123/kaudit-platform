import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const migration = await readFile(
  new URL('../../migrations/0017_billing_spend_lease.sql', import.meta.url),
  'utf8',
)

test('billing spend lease migration supports staged result recovery', () => {
  assert.match(migration, /CREATE TABLE `kaudit_billing_spend_lease`/)
  assert.match(migration, /`staged_result_json` json DEFAULT NULL/)
  assert.match(migration, /`staged_at` datetime\(6\) DEFAULT NULL/)
  assert.match(migration, /`worker_id` varchar\(80\) NOT NULL/)
  assert.match(migration, /`manual_item_id` varchar\(40\) DEFAULT NULL/)
  assert.match(migration, /persisting that staged result; it never calls the model/)
})

test('billing spend lease migration does not allow automatic extra paid calls', () => {
  assert.doesNotMatch(migration, /extra paid call/i)
  assert.doesNotMatch(migration, /at most .* paid call/i)
  assert.match(migration, /never calls the model again automatically/)
  assert.match(migration, /CHECK \(`attempt_count` = 1\)/)
  assert.doesNotMatch(migration, /bounded attempt budget/i)
})

test('temporary spend staging excludes unnecessary sensitive fields', () => {
  assert.match(migration, /no URLs, prompts, raw responses\/errors/i)
  assert.match(migration, /money projections/i)
  assert.match(migration, /staging is cleared after/i)
})
