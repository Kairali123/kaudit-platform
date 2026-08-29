import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const callWorker = readFileSync(
  new URL('../cli/run-call-audit-worker.ts', import.meta.url),
  'utf8',
)
const billingWorker = readFileSync(
  new URL('../cli/run-reaudit-worker.ts', import.meta.url),
  'utf8',
)

test('both hosted workers use the shared verified TLS resolver', () => {
  for (const source of [callWorker, billingWorker]) {
    assert.match(source, /resolveDatabaseTls\(config, process\.env\)/)
    assert.doesNotMatch(source, /DB_SSL_CA_PEM/)
  }
})

test('both drain modes stop claiming work before the host deadline', () => {
  assert.match(callWorker, /KAUDIT_CALL_AUDIT_DRAIN/)
  assert.match(
    callWorker,
    /shouldContinue: async \(\) =>[\s\S]{0,100}!shutdownRequested[\s\S]{0,100}!drain \|\| Date\.now\(\) < deadline/,
  )
  assert.match(billingWorker, /KAUDIT_AUDIT_DRAIN/)
  // Both bounded Billing Audit modes stop claiming before the host deadline:
  // the general drain, and the administrator-requested queue drain.
  assert.match(
    billingWorker,
    /\(!drain && !requestedMode\) \|\| Date\.now\(\) < deadline/,
  )
  for (const source of [callWorker, billingWorker]) {
    assert.match(source, /KAUDIT_WORKER_DEADLINE_SECONDS/)
  }
})

test('both persistent workers finish the current item on termination', () => {
  for (const source of [callWorker, billingWorker]) {
    assert.match(source, /\['SIGINT', 'SIGTERM'\]/)
    assert.match(source, /shutdownRequested = true/)
    assert.match(source, /!shutdownRequested/)
    assert.match(source, /stopped gracefully/)
  }
})

test('bounded Billing Audit drains batches but cannot also watch forever', () => {
  assert.match(billingWorker, /watch && drain/)
  assert.match(billingWorker, /summary\.selected > 0 && Date\.now\(\) < deadline/)
  assert.match(billingWorker, /observedState: 'idle'/)
})

test('bounded Call Audit polls idle until deadline and exits on pause or fault', () => {
  assert.match(callWorker, /if \(drain\) \{[\s\S]*result\.outcome === 'faulted'/)
  assert.match(callWorker, /result\.outcome === 'paused'\) break/)
  assert.match(callWorker, /observedState: 'running'/)
  assert.match(callWorker, /await wait\(pollMs\)[\s\S]*continue/)
  assert.match(callWorker, /if \(drain && Date\.now\(\) >= deadline\)/)
})

test('Billing Audit publishes exact progress deltas before continuing', () => {
  assert.match(billingWorker, /onProgress: async/)
  assert.match(
    billingWorker,
    /const processed =[^]*progress\.spendGuardSkipped/,
  )
  assert.match(billingWorker, /processedDelta: processed - reportedProcessed/)
  assert.match(billingWorker, /await control\.recordObservation/)
})

test('Billing Audit retries a busy advisory lock and publishes a bounded fault', () => {
  assert.match(billingWorker, /KAUDIT_AUDIT_LOCK_WAIT_SECONDS/)
  assert.match(billingWorker, /acquireBillingAuditLock/)
  assert.match(billingWorker, /asReauditFatalError\('claim', error\)/)
  assert.match(billingWorker, /observedState: 'faulted'/)
  assert.match(billingWorker, /BILLING_AUDIT_LOCK_ERROR_CODE/)
  assert.match(billingWorker, /new ReauditFatalError\('claim', 'WORKER_LOCK_BUSY'\)/)
  assert.doesNotMatch(billingWorker, /KILL\s+(?:CONNECTION|QUERY)/i)
})

test('an exact append-only one-shot can run without waking a paused queue', () => {
  assert.match(
    billingWorker,
    /appendReaudit && taskIds !== null && taskIds\.length > 0 && !watch && !drain/,
  )
  assert.match(
    billingWorker,
    /desired === 'paused' && !targetedOneShot/,
  )
  assert.match(
    billingWorker,
    /targetedOneShot \|\|[\s\S]{0,100}getDesiredState\('billing'\)/,
  )
  assert.match(
    billingWorker,
    /targetedOneShot && desiredAfterBatch === 'paused'/,
  )
})

test('requested mode drains the durable queue and never widens the general one', () => {
  assert.match(billingWorker, /KAUDIT_AUDIT_REQUESTED_MODE/)
  // It reads the admin request queue, not the intake reader.
  assert.match(
    billingWorker,
    /requestedMode\s*\n?\s*\? createMysqlManualReauditCandidateRepository\(pool, \{[\s\S]{0,100}recoverInterruptedClaims: true/,
  )
  assert.match(billingWorker, /manualRequest: requestedMode/)
  // It is an exact one-shot, so a paused queue does not block it.
  assert.match(billingWorker, /const targetedOneShot =\s*\n?\s*requestedMode/)
  // And it is exclusive with every other mode, including a scope file.
  assert.match(billingWorker, /requestedMode && \(watch \|\| drain\)/)
  assert.match(billingWorker, /requestedMode && appendReaudit/)
  assert.match(
    billingWorker,
    /requestedMode && process\.env\.KAUDIT_AUDIT_SCOPE_FILE/,
  )
})
