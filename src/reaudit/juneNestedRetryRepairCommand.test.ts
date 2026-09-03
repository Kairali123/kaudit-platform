import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'

const commandPath = new URL(
  '../../scripts/requeue-june-nested-url-retries.mjs',
  import.meta.url,
)
const command = await readFile(commandPath, 'utf8')

test('June nested-URL requeue requires exact confirmation', () => {
  const result = spawnSync(process.execPath, [commandPath.pathname], {
    env: {},
    encoding: 'utf8',
  })
  assert.equal(result.status, 1)
  assert.equal(result.stdout, '')
  assert.equal(
    result.stderr.trim(),
    JSON.stringify({
      operation: 'june-nested-url-requeue',
      result: 'failed',
      stage: 'confirmation',
      matched: 0,
      updated: 0,
    }),
  )
})

test('June nested-URL requeue changes only the approved queue state', () => {
  assert.match(command, /EXPECTED_ROWS = 19/)
  assert.match(command, /PERIOD_START = '2026-06-01'/)
  assert.match(command, /PERIOD_END = '2026-07-01'/)
  assert.match(command, /REQUEUE_JUNE_NESTED_URL_RETRIES/)
  assert.match(command, /beginTransaction\(\)/)
  assert.match(command, /FOR UPDATE/)
  assert.match(command, /rollback\(\)/)
  assert.match(command, /audio_processing_status = 'exhausted'/)
  assert.match(command, /audio_attempt_count = 8/)
  assert.match(command, /audio_last_error = 'proxy_signed_url_missing'/)
  assert.match(
    command,
    /SET audio_processing_status = 'fetch_failed',\s+audio_attempt_count = 7,\s+audio_next_attempt_at = NULL/,
  )
  assert.doesNotMatch(command, /2026-05|OPENAI_API_KEY|source_url|transcript/i)
  assert.doesNotMatch(command, /\b(?:INSERT|DELETE|DROP|TRUNCATE|REPLACE)\b/i)
  assert.equal(command.match(/UPDATE kaudit_call_artifact/g)?.length, 1)
})
