import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const workflow = readFileSync(
  new URL('../../.github/workflows/audit-worker.yml', import.meta.url),
  'utf8',
)

test('hosted worker is manual, bounded, and serialized per audit system', () => {
  assert.match(workflow, /workflow_dispatch:/)
  assert.match(workflow, /type: choice/)
  assert.match(workflow, /- billing/)
  assert.match(workflow, /- call/)
  assert.match(workflow, /group: kaudit-audit-worker-\$\{\{ inputs\.system \}\}/)
  assert.match(workflow, /cancel-in-progress: false/)
  assert.match(workflow, /timeout-minutes: 330/)
  assert.match(workflow, /KAUDIT_WORKER_DEADLINE_SECONDS: "19200"/)
})

test('hosted worker drains through existing CLIs and never runs a model test', () => {
  assert.match(workflow, /KAUDIT_AUDIT_DRAIN=true/)
  assert.match(workflow, /npm run audit:worker/)
  assert.match(workflow, /KAUDIT_CALL_AUDIT_DRAIN=true/)
  assert.match(workflow, /npm run callaudit:worker/)
  for (const forbidden of [
    /callaudit:batch/,
    /reaudit:sample/,
    /RULE_TEST/,
    /curl\b/,
    /upload-artifact/,
  ]) {
    assert.doesNotMatch(workflow, forbidden)
  }
})

test('workflow configuration is secret-backed and minimally permissioned', () => {
  assert.match(workflow, /permissions:\n  contents: read/)
  for (const name of [
    'DB_HOST',
    'DB_NAME',
    'DB_USER',
    'DB_PASSWORD',
    'DB_SSL_CA_PEM',
    'OPENAI_API_KEY',
    'KAUDIT_ALLOWED_RECORDING_HOSTS',
    'KAUDIT_UNPOD_PROXY_BASE',
    'KAUDIT_CALL_AUDIT_AUTO_START',
  ]) {
    assert.match(workflow, new RegExp(`${name}: \\$\\{\\{ secrets\\.${name} \\}\\}`))
  }
  assert.doesNotMatch(workflow, /write-all|contents: write|pull-requests: write/)
})
