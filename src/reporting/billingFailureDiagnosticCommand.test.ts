import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'

const commandPath = new URL(
  '../../scripts/report-billing-failure-breakdown.mjs',
  import.meta.url,
)
const command = await readFile(commandPath, 'utf8')

test('billing failure diagnostic fails closed with bounded output', () => {
  const result = spawnSync(process.execPath, [commandPath.pathname], {
    env: {},
    encoding: 'utf8',
  })
  assert.equal(result.status, 1)
  assert.equal(result.stdout, '')
  assert.equal(
    result.stderr.trim(),
    JSON.stringify({
      operation: 'billing-failure-breakdown',
      result: 'failed',
    }),
  )
})

test('billing failure diagnostic selects only aggregate operational fields', () => {
  assert.match(command, /COUNT\(DISTINCT run\.id\) AS lifetime/)
  assert.match(command, /OTHER_CLASSIFICATION_FAILURE/)
  assert.match(command, /OTHER_FAILURE/)
  assert.match(command, /WHEN last_error_code IS NULL THEN 'NONE'/)
  assert.match(command, /COUNT\(DISTINCT call_id\) AS calls/)
  assert.doesNotMatch(
    command,
    /\b(?:source_url|transcript|explanation|request_id|total_amount)\b|\bsegment\.text\b|\b(?:call_id|artifact_id)\s+AS\b/i,
  )
  assert.doesNotMatch(command, /console\.(?:error|log)\([^\n]*error/i)
})

test('billing failure diagnostic is read-only', () => {
  assert.doesNotMatch(
    command,
    /\b(?:INSERT|UPDATE|DELETE|REPLACE|ALTER|CREATE|DROP|TRUNCATE)\b/i,
  )
})
