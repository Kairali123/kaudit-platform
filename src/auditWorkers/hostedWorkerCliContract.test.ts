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
  assert.match(billingWorker, /!drain \|\| Date\.now\(\) < deadline/)
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

test('Billing Audit publishes each settled candidate before continuing', () => {
  assert.match(billingWorker, /onProgress: async/)
  assert.match(billingWorker, /processedDelta: 1/)
  assert.match(billingWorker, /await control\.recordObservation/)
})
