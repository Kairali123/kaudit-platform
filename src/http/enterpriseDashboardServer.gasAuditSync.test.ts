import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash, createHmac } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import type { Pool } from 'mysql2/promise'
import type { AccessRepository } from '../auth/types.ts'
import type { AuditEvent, AuditSink } from '../audit/types.ts'
import type { RuntimeConfig } from '../config/runtime.ts'
import { gasAuditSyncSigningPayload } from '../integrations/gasAuditSyncAuth.ts'
import type {
  GasAuditSyncRequest,
  GasAuditSyncReceipt,
} from '../integrations/gasAuditResultSync.ts'
import { createEnterpriseDashboardServer } from './enterpriseDashboardServer.ts'

const secret = 'synthetic-audit-sync-secret-32-characters'
const config: RuntimeConfig = {
  environment: 'test',
  host: '127.0.0.1',
  port: 4175,
  trustProxy: false,
  database: {
    host: 'synthetic', port: 3306, name: 'synthetic', user: 'synthetic',
    password: 'synthetic', tlsMode: 'required', sslCaFile: null,
    sslCaInline: false,
  },
  auth: {
    mode: 'local', email: 'admin@example.test', passwordHash: 'unused',
    sessionSecret: 'synthetic-session-secret-at-least-32-characters',
    sessionCookie: 'synthetic', sessionTtlSeconds: 3_600,
  },
  releaseGates: {
    automatedValidationApproved: false,
    calibrationComplete: false,
    reportingApproved: false,
  },
}

const access: AccessRepository = {
  async findByOidc() { return null },
  async findByEmail() { return null },
  async readiness() { return true },
}

async function withServer(
  sync: (input: GasAuditSyncRequest) => Promise<GasAuditSyncReceipt>,
  run: (baseUrl: string, events: AuditEvent[]) => Promise<void>,
): Promise<void> {
  const events: AuditEvent[] = []
  const audit: AuditSink = {
    async record(event) { events.push(event) },
    async readiness() { return true },
  }
  const server = createEnterpriseDashboardServer({
    config,
    pool: {} as Pool,
    access,
    audit,
    verifier: null,
    gasAuditSyncSecret: secret,
    gasAuditSyncRateCardId: 'rc-synthetic',
    gasAuditResultSync: { sync },
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as AddressInfo
  try {
    await run(`http://127.0.0.1:${address.port}`, events)
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve()),
    )
  }
}

function signedRequest(body: string, bodyOverride = body): {
  headers: Record<string, string>
  body: string
} {
  const timestamp = String(Date.now())
  const bodySha256 = createHash('sha256').update(body).digest('hex')
  const billMonth = '2026-08'
  const batchId = 'batch-20260831-abcdef'
  const signature = createHmac('sha256', secret)
    .update(gasAuditSyncSigningPayload({
      method: 'POST',
      pathname: '/api/v1/imports/gas-audit-results',
      timestamp,
      bodySha256,
      billMonth,
      batchId,
    }))
    .digest('hex')
  return {
    headers: {
      'content-type': 'application/json',
      'x-kaudit-audit-sync-timestamp': timestamp,
      'x-kaudit-content-sha256': bodySha256,
      'x-kaudit-audit-sync-signature': signature,
      'x-kaudit-bill-month': billMonth,
      'x-kaudit-batch-id': batchId,
    },
    body: bodyOverride,
  }
}

test('signed GAS audit results reach only the dedicated sync service', async () => {
  const body = JSON.stringify({
    schema_version: '1', batch_id: 'batch-20260831-abcdef',
    bill_month: '2026-08', items: [{ task_id: 'T-synthetic' }],
  })
  const calls: GasAuditSyncRequest[] = []
  await withServer(async (input) => {
    calls.push(input)
    return { batchId: input.batchId, items: [{ taskId: 'T-synthetic', status: 'imported' }] }
  }, async (baseUrl, events) => {
    const signed = signedRequest(body)
    const response = await fetch(`${baseUrl}/api/v1/imports/gas-audit-results`, {
      method: 'POST', headers: signed.headers, body: signed.body,
    })
    assert.equal(response.status, 200)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].rateCardId, 'rc-synthetic')
    assert.equal(calls[0].bodySha256, signed.headers['x-kaudit-content-sha256'])
    assert.ok(events.some((event) => event.action === 'gas_audit_result.sync'))
  })
})

test('a signed hash for different bytes is rejected before sync', async () => {
  const body = JSON.stringify({ schema_version: '1', items: [] })
  let called = false
  await withServer(async () => {
    called = true
    return { batchId: 'never', items: [] }
  }, async (baseUrl) => {
    const signed = signedRequest(body, `${body} `)
    const response = await fetch(`${baseUrl}/api/v1/imports/gas-audit-results`, {
      method: 'POST', headers: signed.headers, body: signed.body,
    })
    assert.equal(response.status, 401)
    assert.equal(called, false)
  })
})
