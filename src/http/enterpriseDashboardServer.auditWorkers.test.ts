import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { AddressInfo } from 'node:net'
import type { Pool } from 'mysql2/promise'
import type { AccessRepository } from '../auth/types.ts'
import type { AuditEvent } from '../audit/types.ts'
import type { RuntimeConfig } from '../config/runtime.ts'
import { createLocalPasswordHash, issueLocalSession } from '../auth/localSession.ts'
import type { AuditWorkerControlPort, AuditWorkerPublicState } from '../auditWorkers/control.ts'
import { createEnterpriseDashboardServer } from './enterpriseDashboardServer.ts'

const config: RuntimeConfig = {
  environment: 'test',
  host: '127.0.0.1',
  port: 4175,
  trustProxy: false,
  database: {
    host: 'synthetic', port: 3306, name: 'synthetic', user: 'synthetic',
    password: 'synthetic', tlsMode: 'required', sslCaFile: null, sslCaInline: false,
  },
  auth: {
    mode: 'local',
    email: 'operator@example.test',
    passwordHash: createLocalPasswordHash('synthetic-password', Buffer.alloc(16, 4)),
    sessionSecret: 'synthetic-session-secret-at-least-32-characters',
    sessionCookie: 'kaudit_local_session',
    sessionTtlSeconds: 3600,
  },
  releaseGates: {
    automatedValidationApproved: false,
    calibrationComplete: false,
    reportingApproved: false,
  },
}
const ADMIN_EMAIL = 'operator@example.test'

function cookie(): string {
  if (config.auth.mode !== 'local') throw new Error('local test config required')
  return `${config.auth.sessionCookie}=${encodeURIComponent(
    issueLocalSession(
      config.auth.email,
      config.auth.sessionSecret,
      config.auth.sessionTtlSeconds,
    ),
  )}`
}

function state(
  system: 'billing' | 'call',
  desiredState: 'running' | 'paused' = 'running',
): AuditWorkerPublicState {
  return {
    system,
    desiredState,
    observedState: desiredState === 'running' ? 'idle' : 'paused',
    stateVersion: 1,
    lastHeartbeatAt: null,
    lastProgressAt: null,
    lastErrorCode: null,
    processedTotal: 0,
    failedTotal: 0,
  }
}

test('administrators can read, stop, and resume only safe worker state', async () => {
  const rows = [state('billing'), state('call')]
  const writes: Array<{ system: string; desiredState: string }> = []
  const events: AuditEvent[] = []
  const control: AuditWorkerControlPort = {
    async listPublicStates() { return rows },
    async setDesiredState(input) {
      writes.push(input)
      const row = rows.find((item) => item.system === input.system)!
      row.desiredState = input.desiredState
      row.observedState = input.desiredState === 'paused' ? 'pausing' : 'idle'
      return row
    },
    async getDesiredState() { return 'running' },
    async recordObservation() {},
    async getCallCheckpoint() { return null },
    async initializeCallCheckpoint() {},
    async advanceCallCheckpoint() {},
    async nextWorkSequence() { return 1 },
  }
  const access: AccessRepository = {
    async findByOidc() { return null },
    async findByEmail(email) {
      return email === ADMIN_EMAIL
        ? {
            id: 'usr_synthetic_admin',
            email,
            status: 'active',
            maxSensitivityTier: 'K0',
            roles: ['admin'],
          }
        : null
    },
    async readiness() { return true },
  }
  const server = createEnterpriseDashboardServer({
    config,
    pool: { async query() { return [[{ one: 1 }], []] } } as unknown as Pool,
    access,
    audit: {
      async record(event) { events.push(event) },
      async readiness() { return true },
    },
    verifier: null,
    auditWorkerControl: control,
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as AddressInfo
  const base = `http://127.0.0.1:${address.port}`
  try {
    const read = await fetch(`${base}/api/v1/audit-workers`, {
      headers: { cookie: cookie() },
    })
    assert.equal(read.status, 200)
    const body = await read.json() as Record<string, unknown>
    assert.deepEqual(
      (body.systems as AuditWorkerPublicState[]).map((item) => item.system),
      ['billing', 'call'],
    )
    assert.equal(JSON.stringify(body).includes('checkpoint'), false)
    assert.equal(JSON.stringify(body).includes('sourceRowId'), false)

    const stop = await fetch(`${base}/api/v1/audit-workers/control`, {
      method: 'POST',
      headers: { cookie: cookie(), 'content-type': 'application/json' },
      body: JSON.stringify({ system: 'call', desiredState: 'paused' }),
    })
    assert.equal(stop.status, 200)
    assert.deepEqual(writes, [{ system: 'call', desiredState: 'paused' }])
    assert.equal(events.at(-1)?.action, 'audit_worker.pause')
    assert.equal(events.at(-1)?.resourceId, 'call')
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve()),
    )
  }
})
