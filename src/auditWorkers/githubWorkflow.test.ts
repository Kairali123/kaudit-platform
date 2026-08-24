import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const workflow = readFileSync(
  new URL('../../.github/workflows/audit-worker.yml', import.meta.url),
  'utf8',
)
const scheduledWorkflow = readFileSync(
  new URL('../../.github/workflows/scheduled-audit-workers.yml', import.meta.url),
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
  assert.match(workflow, /KAUDIT_AUDIT_CONCURRENCY=10/)
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

test('targeted hosted re-audit is private, scope-bound, and billing-only', () => {
  assert.match(workflow, /- targeted/)
  assert.match(
    workflow,
    /KAUDIT_TARGETED_REAUDIT_SCOPE_B64: \$\{\{ secrets\.KAUDIT_TARGETED_REAUDIT_SCOPE_B64 \}\}/,
  )
  assert.match(workflow, /base64 --decode/)
  assert.match(workflow, /KAUDIT_AUDIT_REQUIRE_SCOPE=true/)
  assert.match(workflow, /KAUDIT_AUDIT_REAUDIT_MODE=APPEND/)
  assert.match(workflow, /KAUDIT_AUDIT_BATCH=100/)
  assert.match(
    workflow,
    /elif \[\[ "\$AUDIT_SYSTEM" == "call" \]\]; then\s+if \[\[ "\$AUDIT_MODE" == "targeted" \]\]; then\s+exit 2/,
  )
  assert.match(workflow, /if: always\(\)/)
  assert.match(workflow, /rm -f "\$RUNNER_TEMP\/kaudit-targeted-reaudit\.json"/)
  assert.doesNotMatch(workflow, /echo .*KAUDIT_TARGETED_REAUDIT_SCOPE/)
})

test('requested re-audit mode is billing-only, bounded, and queue-driven', () => {
  assert.match(workflow, /- requested/)
  // It reads the durable Kaudit-owned queue, so it takes no scope secret and
  // writes no file to the runner.
  assert.match(
    workflow,
    /elif \[\[ "\$AUDIT_MODE" == "requested" \]\]; then\s+KAUDIT_AUDIT_REQUESTED_MODE=true/,
  )
  assert.match(
    workflow,
    /KAUDIT_AUDIT_REQUESTED_MODE=true[\s\S]{0,200}KAUDIT_AUDIT_BATCH=1/,
  )
  assert.doesNotMatch(
    workflow,
    /KAUDIT_AUDIT_REQUESTED_MODE=true[\s\S]{0,200}KAUDIT_AUDIT_CONCURRENCY=/,
  )
  assert.match(
    workflow,
    /KAUDIT_AUDIT_REQUESTED_MODE=true[\s\S]{0,200}KAUDIT_AUDIT_WATCH=false/,
  )
  // Call Audit has no request queue, so the combination exits non-zero.
  assert.match(
    workflow,
    /elif \[\[ "\$AUDIT_SYSTEM" == "call" \]\]; then[\s\S]{0,200}if \[\[ "\$AUDIT_MODE" == "requested" \]\]; then\s+exit 2/,
  )
  // Serialized with every other Billing Audit run by the same group.
  assert.match(workflow, /group: kaudit-audit-worker-\$\{\{ inputs\.system \}\}/)
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
    'KAUDIT_TARGETED_REAUDIT_SCOPE_B64',
  ]) {
    assert.match(workflow, new RegExp(`${name}: \\$\\{\\{ secrets\\.${name} \\}\\}`))
  }
  assert.doesNotMatch(workflow, /write-all|contents: write|pull-requests: write/)
})

test('Call Audit starts at the approved July 2026 UTC boundary', () => {
  assert.match(
    workflow,
    /KAUDIT_CALL_AUDIT_AUTO_START: "2026-07-01 00:00:00\.000000"/,
  )
  assert.doesNotMatch(
    workflow,
    /secrets\.KAUDIT_CALL_AUDIT_AUTO_START/,
  )
})

test('disabled database TLS cannot retain dormant CA material', () => {
  assert.match(workflow, /if \[\[ "\$DB_TLS_MODE" == "disabled" \]\]/)
  assert.match(workflow, /unset DB_SSL_CA_PEM/)
})

test('scheduled workers prioritize Billing Audit while still running Call Audit', () => {
  assert.match(scheduledWorkflow, /name: Kaudit scheduled audit workers/)
  assert.match(scheduledWorkflow, /cron: '47 \*\/6 \* \* \*'/)
  assert.match(scheduledWorkflow, /cron: '17 \*\/12 \* \* \*'/)
  assert.match(
    scheduledWorkflow,
    /billing-audit:[\s\S]{0,160}system: billing[\s\S]{0,80}mode: new/,
  )
  assert.match(
    scheduledWorkflow,
    /call-audit:[\s\S]{0,160}system: call[\s\S]{0,80}mode: new/,
  )
  assert.match(scheduledWorkflow, /secrets: inherit/)
})
