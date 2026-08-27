import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'

const commandPath = new URL(
  '../../scripts/report-audit-monitor-health.mjs',
  import.meta.url,
)
const command = await readFile(commandPath, 'utf8')

test('audit monitor diagnostic fails closed with bounded output', () => {
  const result = spawnSync(process.execPath, [commandPath.pathname], {
    env: {},
    encoding: 'utf8',
  })
  assert.equal(result.status, 1)
  assert.equal(result.stdout, '')
  assert.equal(
    result.stderr.trim(),
    JSON.stringify({
      operation: 'audit-monitor-health',
      result: 'failed',
      stage: 'runtime',
      elapsed: 'under-5s',
    }),
  )
})

test('audit monitor diagnostic exposes only aggregate allowlisted fields', () => {
  assert.match(command, /data: result\.summary\.totalCalls > 0 \? 'present' : 'absent'/)
  assert.match(command, /error instanceof MonitorQueryFailure \? error\.stage : 'runtime'/)
  assert.match(command, /operation: 'audit-monitor-query'/)
  assert.doesNotMatch(command, /console\.(?:error|log)\([^\n]*error/i)
})
