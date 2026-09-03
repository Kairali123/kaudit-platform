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
  assert.match(billingWorker, /observedState: 'idle'/)
})

test('a drain stops only on an explicit drained/deadline/hand-over condition', () => {
  // An empty batch is not a drained queue: work parked behind a retry backoff
  // is invisible to the eligibility read and claimable again minutes later.
  assert.match(billingWorker, /decideDrainContinuation\(\{/)
  assert.match(
    billingWorker,
    /let deferredDueInMs[\s\S]{0,200}candidates\.deferredWorkDueInMs/,
  )
  assert.match(billingWorker, /DRAIN_DEFERRED_HORIZON_MS/)
  assert.match(billingWorker, /2 \* 60 \* 60_000/)
  assert.match(billingWorker, /continuation\.action === 'wait'/)
  // The wait idles on the control plane only: re-scanning candidates every
  // tick would turn a deliberate backoff into a polling load, and skipping the
  // heartbeat would make the monitor report a live worker as stale.
  assert.match(billingWorker, /const deferredHeartbeat = startActiveHeartbeat/)
  assert.match(billingWorker, /await deferredHeartbeat\.stop\(\)/)
  assert.match(billingWorker, /billing_audit_queue_inspection_failed/)
  assert.match(billingWorker, /const inspectionHeartbeat = startActiveHeartbeat/)
  assert.match(
    billingWorker,
    /drain stopped \(\$\{continuation\.reason\}\)/,
  )
})

test('a transient database fault does not end a bounded Billing drain', () => {
  assert.match(billingWorker, /const retryBatchFaults = drain \|\| requestedMode/)
  assert.match(billingWorker, /decideBatchFaultResponse\(\{/)
  assert.match(billingWorker, /MAX_CONSECUTIVE_BATCH_FAULTS/)
  assert.match(billingWorker, /consecutiveBatchFaults = 0/)
  // A run that is going to retry stays honest about being alive and does not
  // inflate the monitor's terminal-failure count.
  assert.match(
    billingWorker,
    /faultResponse\.action === 'retry' \? 'running' : 'faulted'/,
  )
  assert.match(
    billingWorker,
    /faultResponse\.action === 'retry' \? \{\} : \{ failedDelta: 1 \}/,
  )
  // The fault publication must never replace the classified diagnosis with a
  // second, unclassified failure from the same outage.
  assert.match(
    billingWorker,
    /try \{\s*await control\.recordObservation\(\{[\s\S]{0,400}\}\)\s*\} catch \{/,
  )
  assert.match(billingWorker, /const faultHeartbeat = startActiveHeartbeat/)
  assert.match(billingWorker, /await faultHeartbeat\.stop\(\)/)
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
  assert.match(billingWorker, /const failures = progress\.terminalFailures/)
  assert.doesNotMatch(
    billingWorker,
    /const failures =[^\n]*retriesScheduled/,
  )
  assert.match(billingWorker, /await control\.recordObservation/)
})

test('Billing Audit cannot report success when every attempted item failed', () => {
  assert.match(billingWorker, /billing_audit_no_completions/)
  assert.match(
    billingWorker,
    /selected === 0 \|\| completed > 0 \|\| failedOutcomes === 0/,
  )
  assert.match(billingWorker, /process\.exitCode = 2/)
  assert.match(billingWorker, /publishNoCompletionFailure\(\)/)
})

test('Billing Audit heartbeats independently while a batch is in flight', () => {
  assert.match(billingWorker, /ACTIVE_HEARTBEAT_INTERVAL_MS = 60_000/)
  assert.match(billingWorker, /startActiveHeartbeat\(\{/)
  assert.match(
    billingWorker,
    /record: \(\) => control\.recordObservation\(\{[\s\S]{0,100}observedState: 'running'/,
  )
  assert.match(billingWorker, /await activeHeartbeat\.stop\(\)/)
})

test('provider parallelism cannot widen the Billing work pool', () => {
  assert.match(billingWorker, /connectionLimit: 4/)
  assert.doesNotMatch(billingWorker, /connectionLimit:.*concurrency/)
})

test('Billing control and heartbeat traffic has an isolated connection', () => {
  assert.match(
    billingWorker,
    /const controlPool =[^]*connectionLimit: 1/,
  )
  assert.match(
    billingWorker,
    /createMysqlAuditWorkerControl\(controlPool\)/,
  )
  assert.match(
    billingWorker,
    /Promise\.all\(\[pool\.end\(\), controlPool\.end\(\)\]\)/,
  )
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

test('Billing Audit does not fail a completed drain when its lock connection has closed', () => {
  assert.match(billingWorker, /billing_audit_lock_release_skipped/)
  assert.match(
    billingWorker,
    /try \{\s*await lockConnection\.query\([\s\S]{0,180}RELEASE_LOCK[\s\S]{0,180}catch \{/,
  )
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
