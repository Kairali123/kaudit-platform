import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'

const commandPath = new URL(
  '../../scripts/report-billing-read-performance.mjs',
  import.meta.url,
)
const command = await readFile(commandPath, 'utf8')

test('billing read diagnostic fails closed with bounded output', () => {
  const result = spawnSync(process.execPath, [commandPath.pathname], {
    env: {},
    encoding: 'utf8',
  })
  assert.equal(result.status, 1)
  assert.equal(result.stdout, '')
  assert.equal(
    result.stderr.trim(),
    JSON.stringify({
      operation: 'billing-read-performance',
      result: 'failed',
      stage: 'runtime',
      reason: 'missing:KAUDIT_DIAGNOSTIC_MONTH',
      elapsed: 'under-250ms',
    }),
  )
})

test('billing read diagnostic is aggregate-only and model-free', () => {
  assert.match(command, /await collectBilling\(diagnosticPool, period\)/)
  assert.match(command, /FROM information_schema\.STATISTICS/)
  assert.match(command, /COLUMN_NAME, COLLATION/)
  assert.match(command, /EXPLAIN FORMAT=JSON/)
  assert.match(command, /boundedSelect\(sql, detectedEngine, 45\)/)
  assert.match(command, /databaseEngine\(version\)/)
  assert.match(command, /rows_examined_per_scan/)
  assert.match(command, /while \(pending\.size > 0\)/)
  assert.doesNotMatch(
    command,
    /OPENAI_API_KEY|source_url|transcript_text|audio_bytes|recording_url/i,
  )
  assert.doesNotMatch(
    command,
    /[`'"]\s*(?:INSERT|UPDATE|DELETE|ALTER|CREATE|DROP|REPLACE|TRUNCATE)\b/i,
  )
  assert.doesNotMatch(command, /console\.(?:log|error)\([^\n]*parameters/)
})
