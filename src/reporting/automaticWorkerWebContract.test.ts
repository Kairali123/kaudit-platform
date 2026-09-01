import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = (relative: string) =>
  readFileSync(new URL(`../../${relative}`, import.meta.url), 'utf8')

const component = read('apps/web/src/components/AuditWorkerControl.tsx')
const billingPage = read('apps/web/src/pages/AuditMonitorPage.tsx')
const callPage = read('apps/web/src/pages/CallAuditReportPage.tsx')
const server = read('src/http/enterpriseDashboardServer.ts')

test('each audit report surface owns only its matching worker control', () => {
  assert.match(billingPage, /<AuditWorkerControl system="billing" \/>/)
  assert.match(callPage, /<AuditWorkerControl system="call" \/>/)
  assert.match(component, /'Stop audit'/)
  assert.match(component, /'Resume audit'/)
  assert.match(component, /'Run audit'/)
  assert.match(component, />Terminal failures</)
  assert.doesNotMatch(component, />Failures</)
})

test('browser controls change durable intent and never invoke a model or batch', () => {
  assert.match(component, /\/api\/v1\/audit-workers\/control/)
  for (const forbidden of [
    /OPENAI_API_KEY/,
    /callaudit:batch/,
    /audit:worker/,
    /transcript/i,
    /sourceRowId/,
    /checkpoint/i,
  ]) {
    assert.doesNotMatch(component, forbidden)
  }
})

test('worker control routes are administrator-only and audited', () => {
  assert.match(server, /pathname === '\/api\/v1\/audit-workers'[\s\S]{0,180}return 'audit:control'/)
  assert.match(server, /requirePermission\(context, 'audit:control'\)/)
  assert.match(server, /'audit_worker\.pause'/)
  assert.match(server, /'audit_worker\.resume'/)
})
