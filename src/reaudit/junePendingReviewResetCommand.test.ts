import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'

const commandPath = new URL(
  '../../scripts/reset-june-pending-review-cohort.mjs',
  import.meta.url,
)
const command = await readFile(commandPath, 'utf8')

test('June pending-review reset requires exact confirmation', () => {
  const result = spawnSync(process.execPath, [commandPath.pathname], {
    env: {},
    encoding: 'utf8',
  })
  assert.equal(result.status, 1)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /"stage":"confirmation"/)
})

test('June pending-review reset is exact and preserves source evidence', () => {
  assert.match(command, /EXPECTED_ROWS = 278/)
  assert.match(command, /PERIOD_START = '2026-06-01'/)
  assert.match(command, /PERIOD_END = '2026-07-01'/)
  assert.match(command, /RESET_JUNE_278_PENDING_REVIEWS/)
  assert.match(command, /GET_LOCK\('kaudit-independent-reaudit-v2', 0\)/)
  assert.match(command, /FOR UPDATE/)
  assert.match(command, /unexpected:invalid-state/)
  assert.match(command, /GET_LOCK[\s\S]*beginTransaction[\s\S]*FOR UPDATE/)
  assert.match(
    command,
    /SET audio_processing_status = 'pending',\s+audio_attempt_count = 0,\s+audio_last_attempt_at = NULL,\s+audio_next_attempt_at = NULL,\s+audio_last_error = NULL/,
  )
  assert.match(command, /SET processing_status = 'pending'/)
  assert.doesNotMatch(command, /SET\s+source_url|2026-05|OPENAI_API_KEY/i)
  assert.doesNotMatch(command, /\b(?:INSERT|DELETE|DROP|TRUNCATE|REPLACE)\b/i)
})
