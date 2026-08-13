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
  assert.match(callWorker, /shouldContinue: async \(\) => !drain \|\| Date\.now\(\) < deadline/)
  assert.match(billingWorker, /KAUDIT_AUDIT_DRAIN/)
  assert.match(billingWorker, /!drain \|\| Date\.now\(\) < deadline/)
  for (const source of [callWorker, billingWorker]) {
    assert.match(source, /KAUDIT_WORKER_DEADLINE_SECONDS/)
  }
})

test('bounded Billing Audit drains batches but cannot also watch forever', () => {
  assert.match(billingWorker, /watch && drain/)
  assert.match(billingWorker, /summary\.selected > 0 && Date\.now\(\) < deadline/)
  assert.match(billingWorker, /observedState: 'idle'/)
})

test('bounded Call Audit exits on idle, pause, or fault instead of polling', () => {
  assert.match(callWorker, /if \(drain\) \{[\s\S]*result\.outcome === 'faulted'/)
  assert.match(callWorker, /break[\s\S]*await wait\(pollMs\)/)
})
