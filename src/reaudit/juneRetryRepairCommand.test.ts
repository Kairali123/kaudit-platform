import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'

const commandPath = new URL(
  '../../scripts/repair-june-signed-url-retries.mjs',
  import.meta.url,
)
const command = await readFile(commandPath, 'utf8')

test('June retry repair requires its exact confirmation before connecting', () => {
  const result = spawnSync(process.execPath, [commandPath.pathname], {
    env: {},
    encoding: 'utf8',
  })
  assert.equal(result.status, 1)
  assert.equal(result.stdout, '')
  assert.equal(
    result.stderr.trim(),
    JSON.stringify({
      operation: 'june-signed-url-retry-repair',
      result: 'failed',
      stage: 'confirmation',
      matched: 0,
      updated: 0,
    }),
  )
})

test('June retry repair is exact, transactional, and evidence-blind', () => {
  assert.match(command, /EXPECTED_ROWS = 19/)
  assert.match(command, /PERIOD_START = '2026-06-01'/)
  assert.match(command, /PERIOD_END = '2026-07-01'/)
  assert.match(command, /RESET_JUNE_SIGNED_URL_RETRIES/)
  assert.match(command, /beginTransaction\(\)/)
  assert.match(command, /FOR UPDATE/)
  assert.match(command, /rollback\(\)/)
  assert.match(command, /audio_processing_status = 'fetch_failed'/)
  assert.match(command, /audio_last_error LIKE 'non_audio_response type=application\/json%'/)
  assert.match(command, /SET audio_next_attempt_at = NULL/)
  assert.doesNotMatch(command, /2026-05|OPENAI_API_KEY|source_url|transcript/i)
  assert.doesNotMatch(command, /\b(?:INSERT|DELETE|DROP|TRUNCATE|REPLACE)\b/i)
  assert.equal(command.match(/UPDATE kaudit_call_artifact/g)?.length, 1)
})
