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
const workflowRunbook = readFileSync(
  new URL('../../docs/runbooks/GITHUB_ACTIONS_AUDIT_WORKER.md', import.meta.url),
  'utf8',
)
const packageJson = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
) as { scripts: Record<string, string> }

test('hosted worker is manual, bounded, and serialized per audit system', () => {
  assert.match(workflow, /workflow_dispatch:/)
  assert.match(workflow, /type: choice/)
  assert.match(workflow, /- billing/)
  assert.match(workflow, /- call/)
  assert.match(workflow, /group: kaudit-audit-worker-\$\{\{ inputs\.system \}\}/)
  assert.match(workflow, /cancel-in-progress: false/)
  assert.match(workflow, /timeout-minutes: 330/)
  assert.match(workflow, /KAUDIT_WORKER_DEADLINE_SECONDS: "19200"/)
  assert.match(workflow, /KAUDIT_AUDIT_LOCK_WAIT_SECONDS: "30"/)
  assert.match(
    workflow,
    /run-name: "\$\{\{ inputs\.mode \|\| 'new' \}\} \/ \$\{\{ inputs\.system \}\} audit workflow"/,
  )
})

test('monitor diagnostics are visibly read-only and require an explicit month', () => {
  assert.match(
    workflow,
    /AUDIT_MODE" == "diagnose-monitor"[\s\S]{0,260}diagnose-monitor is read-only and requires diagnostic_month in YYYY-MM format[\s\S]{0,180}report-audit-monitor-health\.mjs/,
  )
})

test('hosted worker drains through existing CLIs and never runs a model test', () => {
  assert.match(workflow, /KAUDIT_AUDIT_DRAIN=true/)
  assert.match(workflow, /KAUDIT_AUDIT_CONCURRENCY=1/)
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

test('hosted Billing concurrency is bounded by mode in workflow and runbook', () => {
  assert.equal(workflow.match(/KAUDIT_AUDIT_CONCURRENCY=1(?!0)/g)?.length, 3)
  assert.equal(workflow.match(/KAUDIT_AUDIT_CONCURRENCY=10/g)?.length, 1)
  assert.match(
    workflow,
    /AUDIT_MODE" == "new"[\s\S]{0,180}KAUDIT_AUDIT_BATCH=10[\s\S]{0,80}KAUDIT_AUDIT_CONCURRENCY=10/,
  )
  assert.match(workflowRunbook, /new-call drain uses[^.]+concurrency `10`/i)
  assert.match(
    workflowRunbook,
    /Targeted and requested\s+re-audits remain[^.]+`1`/i,
  )
  assert.match(workflowRunbook, /BILLING_AUDIT_LOCK_BUSY/)
  assert.match(workflowRunbook, /30 seconds/)
})

test('hosted spend lease migration is explicit, guarded, and billing-only', () => {
  assert.match(workflow, /- migration-0017/)
  assert.match(
    workflow,
    /AUDIT_MODE" == "migration-0017"[\s\S]{0,200}MIGRATION_CONFIRMATION_INPUT" != "APPLY_0017"/,
  )
  assert.match(workflow, /KAUDIT_MIGRATION_CONFIRM=APPLY_0017/)
  assert.match(workflow, /npm run migration:billing-spend-lease/)
  assert.match(
    workflow,
    /elif \[\[ "\$AUDIT_SYSTEM" == "call" \]\]; then\s+if \[\[ "\$AUDIT_MODE" != "new" \]\]; then\s+exit 2/,
  )
})

test('billing read indexes have a separately confirmed supervised mode', () => {
  assert.match(workflow, /- migration-billing-read-indexes/)
  assert.match(
    workflow,
    /AUDIT_MODE" == "migration-billing-read-indexes"[\s\S]{0,220}APPLY_BILLING_READ_INDEXES[\s\S]{0,220}node scripts\/apply-billing-read-indexes\.mjs/,
  )
})

test('June signed-URL retry repair is exact, guarded, and model-free', () => {
  assert.match(workflow, /- repair-june-signed-url-retries/)
  assert.match(
    workflow,
    /AUDIT_MODE" == "repair-june-signed-url-retries"[\s\S]{0,260}MIGRATION_CONFIRMATION_INPUT" != "RESET_JUNE_SIGNED_URL_RETRIES"[\s\S]{0,360}unset OPENAI_API_KEY[\s\S]{0,360}KAUDIT_RETRY_REPAIR_CONFIRM=RESET_JUNE_SIGNED_URL_RETRIES/,
  )
  assert.match(workflow, /node scripts\/repair-june-signed-url-retries\.mjs/)
})

test('June nested-URL requeue is exact, guarded, and model-free', () => {
  assert.match(workflow, /- requeue-june-nested-url-retries/)
  assert.match(
    workflow,
    /AUDIT_MODE" == "requeue-june-nested-url-retries"[\s\S]{0,260}MIGRATION_CONFIRMATION_INPUT" != "REQUEUE_JUNE_NESTED_URL_RETRIES"[\s\S]{0,360}unset OPENAI_API_KEY[\s\S]{0,360}KAUDIT_NESTED_URL_REQUEUE_CONFIRM=REQUEUE_JUNE_NESTED_URL_RETRIES/,
  )
  assert.match(workflow, /node scripts\/requeue-june-nested-url-retries\.mjs/)
})

test('June pending-review reset is exact, guarded, and model-free', () => {
  assert.match(workflow, /- reset-june-pending-reviews/)
  assert.match(
    workflow,
    /AUDIT_MODE" == "reset-june-pending-reviews"[\s\S]{0,260}MIGRATION_CONFIRMATION_INPUT" != "RESET_JUNE_278_PENDING_REVIEWS"[\s\S]{0,360}unset OPENAI_API_KEY[\s\S]{0,360}KAUDIT_JUNE_PENDING_RESET_CONFIRM=RESET_JUNE_278_PENDING_REVIEWS/,
  )
  assert.match(workflow, /node scripts\/reset-june-pending-review-cohort\.mjs/)
})

test('June pending recovery uses a low-concurrency drain', () => {
  assert.match(workflow, /- recover-june-pending/)
  assert.match(
    workflow,
    /AUDIT_MODE" == "recover-june-pending"[\s\S]{0,180}KAUDIT_AUDIT_BATCH=2[\s\S]{0,80}KAUDIT_AUDIT_CONCURRENCY=2[\s\S]{0,180}KAUDIT_AUDIT_DRAIN=true/,
  )
})

test('June recovery canary processes one bounded batch', () => {
  assert.match(workflow, /- recover-june-canary/)
  assert.match(
    workflow,
    /AUDIT_MODE" == "recover-june-canary"[\s\S]{0,180}KAUDIT_AUDIT_BATCH=2[\s\S]{0,80}KAUDIT_AUDIT_CONCURRENCY=1[\s\S]{0,180}KAUDIT_AUDIT_DRAIN=false/,
  )
})

test('reusable workflow callers cannot route unknown modes into a worker', () => {
  assert.match(
    workflow,
    /workflow_call:[\s\S]{0,500}migration_confirmation:[\s\S]{0,160}type: string/,
  )
  assert.match(
    workflow,
    /elif \[\[ "\$AUDIT_MODE" == "new" \]\]; then[\s\S]{0,300}npm run audit:worker\s+else\s+exit 2/,
  )
  assert.match(
    workflow,
    /AUDIT_SYSTEM" == "call"[\s\S]{0,120}AUDIT_MODE" != "new"/,
  )
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
  assert.match(workflow, /KAUDIT_AUDIT_BATCH=1/)
  assert.match(workflow, /KAUDIT_AUDIT_CONCURRENCY=1/)
  assert.match(
    workflow,
    /elif \[\[ "\$AUDIT_SYSTEM" == "call" \]\]; then\s+if \[\[ "\$AUDIT_MODE" != "new" \]\]; then\s+exit 2/,
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
  assert.match(
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
    /elif \[\[ "\$AUDIT_SYSTEM" == "call" \]\]; then[\s\S]{0,200}if \[\[ "\$AUDIT_MODE" != "new" \]\]; then\s+exit 2/,
  )
  // Serialized with every other Billing Audit run by the same group.
  assert.match(workflow, /group: kaudit-audit-worker-\$\{\{ inputs\.system \}\}/)
})

test('failure diagnostic is read-only, billing-only, and model-free', () => {
  assert.match(workflow, /- diagnose-failures/)
  assert.match(
    workflow,
    /AUDIT_MODE" == "diagnose-failures"[\s\S]{0,120}node scripts\/report-billing-failure-breakdown\.mjs/,
  )
  assert.match(
    workflow,
    /elif \[\[ "\$AUDIT_SYSTEM" == "call" \]\]; then[\s\S]{0,200}if \[\[ "\$AUDIT_MODE" != "new" \]\]; then\s+exit 2/,
  )
})

test('OpenAI transcription diagnostic cannot read the database or customer audio', () => {
  assert.match(workflow, /- diagnose-openai-transcription/)
  assert.match(
    workflow,
    /AUDIT_MODE" == "diagnose-openai-transcription"[\s\S]{0,180}unset DB_HOST DB_PORT DB_NAME DB_USER DB_PASSWORD[\s\S]{0,320}diagnose-openai-transcription\.mjs/,
  )
  const command = readFileSync(
    new URL('../../scripts/diagnose-openai-transcription.mjs', import.meta.url),
    'utf8',
  )
  assert.match(command, /synthetic-silence\.wav/)
  assert.doesNotMatch(
    command,
    /DB_HOST|mysql|source_url|recording_url|kaudit_call|transcript_text/i,
  )
})

test('billing performance diagnostic is read-only and month-scoped', () => {
  assert.match(workflow, /- diagnose-billing-performance/)
  assert.match(
    workflow,
    /AUDIT_MODE" == "diagnose-billing-performance"[\s\S]{0,300}unset OPENAI_API_KEY[\s\S]{0,300}KAUDIT_DIAGNOSTIC_MONTH="\$DIAGNOSTIC_MONTH_INPUT"[\s\S]{0,120}node scripts\/report-billing-read-performance\.mjs/,
  )
  assert.match(
    workflow,
    /DIAGNOSTIC_MONTH_INPUT: \$\{\{ inputs\.diagnostic_month \}\}/,
  )
  assert.match(
    workflow,
    /elif \[\[ "\$AUDIT_SYSTEM" == "call" \]\]; then[\s\S]{0,200}if \[\[ "\$AUDIT_MODE" != "new" \]\]; then\s+exit 2/,
  )
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

test('scheduled workers run Billing Audit only', () => {
  assert.match(scheduledWorkflow, /name: Kaudit scheduled audit workers/)
  assert.match(scheduledWorkflow, /cron: '47 \*\/6 \* \* \*'/)
  assert.match(
    scheduledWorkflow,
    /billing-audit:[\s\S]{0,160}system: billing[\s\S]{0,80}mode: new/,
  )
  assert.match(scheduledWorkflow, /secrets: inherit/)
  assert.doesNotMatch(scheduledWorkflow, /system: call/)
  assert.doesNotMatch(scheduledWorkflow, /call-audit:/)
  assert.doesNotMatch(scheduledWorkflow, /cron: '17 \*\/12 \* \* \*'/)
})

test('automatic local operate command does not start Call Audit', () => {
  const operate = packageJson.scripts['app:operate']
  assert.ok(operate, 'package.json must define app:operate')
  assert.match(operate, /npm run audit:worker/)
  assert.match(operate, /npm run report:email-worker/)
  assert.doesNotMatch(operate, /npm run callaudit:worker/)
  assert.doesNotMatch(operate, /\bcall-audit\b/)
})
