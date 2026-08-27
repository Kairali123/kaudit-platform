import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash, createHmac } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import type { Pool } from 'mysql2/promise'
import type { AccessRepository } from '../auth/types.ts'
import type { AuditEvent, AuditSink } from '../audit/types.ts'
import type { RuntimeConfig } from '../config/runtime.ts'
import {
  createLocalPasswordHash,
  issueLocalSession,
} from '../auth/localSession.ts'
import { createEnterpriseDashboardServer } from './enterpriseDashboardServer.ts'
import { createMysqlCycleImportService } from '../adapters/mysqlCycleImport.ts'
import type { ImportObjectStore } from '../imports/objectStore.ts'
import { gasImportSigningPayload } from '../imports/gasImportAuth.ts'

/**
 * Bounded validation contract for the GAS usage-import endpoint.
 *
 * A batch containing permanently invalid rows is refused atomically with
 * per-row descriptors (batch row index, canonical field, allowlisted code).
 * The offending cell values must never appear anywhere in the response.
 * Everything here is synthetic: no database is touched because prevalidation
 * runs before a single query.
 */

const config: RuntimeConfig = {
  environment: 'test',
  host: '127.0.0.1',
  port: 4175,
  trustProxy: false,
  database: {
    host: 'synthetic',
    port: 3306,
    name: 'synthetic',
    user: 'synthetic',
    password: 'synthetic',
    tlsMode: 'required',
    sslCaFile: null,
    sslCaInline: false,
  },
  auth: {
    mode: 'local',
    email: 'admin@example.test',
    passwordHash: createLocalPasswordHash(
      'synthetic-password',
      Buffer.alloc(16, 5),
    ),
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

const access: AccessRepository = {
  async findByOidc() {
    return null
  },
  async findByEmail(email) {
    return email === 'admin@example.test'
      ? {
          id: 'user-admin',
          email,
          status: 'active',
          maxSensitivityTier: 'K1',
          roles: ['admin'],
        }
      : null
  },
  async readiness() {
    return true
  },
}

const objectStore: ImportObjectStore = {
  storageBoundary: 'synthetic-boundary',
  async preserve() {
    throw new Error('no byte may be preserved for an invalid batch')
  },
}

const refusingPool = {
  async getConnection() {
    throw new Error('no database work may happen before prevalidation')
  },
  async query() {
    throw new Error('no database work may happen before prevalidation')
  },
} as unknown as Pool

async function withServer(
  run: (baseUrl: string, events: AuditEvent[]) => Promise<void>,
): Promise<void> {
  const events: AuditEvent[] = []
  const audit: AuditSink = {
    async record(event) {
      events.push(event)
    },
    async readiness() {
      return true
    },
  }
  const server = createEnterpriseDashboardServer({
    config,
    pool: refusingPool,
    access,
    audit,
      verifier: null,
      gasImportSecret: GAS_SECRET,
      imports: createMysqlCycleImportService(refusingPool, {
      objectStore,
      sourceConnectionId: null,
      allowedRecordingHosts: ['s3.example.test'],
    }),
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as AddressInfo
  try {
    await run(`http://127.0.0.1:${address.port}`, events)
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    )
  }
}

const HEADER =
  'Task ID,Destination Number,Call Start Time,Call Connected Time,' +
  'Call End Time,Duration (Seconds) With Ringing,' +
  'Duration (Seconds) Without Ringing,' +
  'Duration (Minutes) - Actual Billing Mins,Actual Billing Amount,' +
  'Recording URL'

const GAS_SECRET = 'synthetic-gas-import-secret-32-characters'

function gasHeaders(options: {
  body: string
  filename?: string
  periodStart?: string
  periodEnd?: string
  signedBody?: string
}): Record<string, string> {
  const filename = options.filename ?? 'synthetic-usage.csv'
  const periodStart = options.periodStart ?? '2026-06-01'
  const periodEnd = options.periodEnd ?? '2026-06-30'
  const bodySha256 = createHash('sha256')
    .update(options.signedBody ?? options.body)
    .digest('hex')
  const timestamp = String(Date.now())
  const signature = createHmac('sha256', GAS_SECRET)
    .update(gasImportSigningPayload({
      method: 'POST',
      pathname: '/api/v1/imports/usage',
      timestamp,
      bodySha256,
      filename,
      periodStart,
      periodEnd,
    }))
    .digest('hex')
  return {
    'x-kaudit-filename': filename,
    'x-kaudit-period-start': periodStart,
    'x-kaudit-period-end': periodEnd,
    'x-kaudit-content-sha256': bodySha256,
    'x-kaudit-import-timestamp': timestamp,
    'x-kaudit-import-signature': signature,
    'content-type': 'text/csv',
  }
}

test('a usage batch with malformed rows returns bounded per-row issues', async () => {
  await withServer(async (baseUrl) => {
    const secretUrl = 'https://blocked-host.example.test/very-secret-file.ogg'
    const csv = [
      HEADER,
      'task-good,+91,2026-06-01 10:00:00,2026-06-01 10:00:04,2026-06-01 10:00:34,34,30,0.5,,',
      `task-bad-url,+91,2026-06-01 10:00:00,2026-06-01 10:00:04,2026-06-01 10:00:34,34,30,0.5,,${secretUrl}`,
      'task-bad-duration,+91,2026-06-01 10:00:00,2026-06-01 10:00:04,2026-06-01 10:00:34,not-a-number,30,0.5,,',
    ].join('\n')
    const response = await fetch(`${baseUrl}/api/v1/imports/usage`, {
      method: 'POST',
      headers: {
        cookie: adminCookie(),
        'x-kaudit-filename': 'synthetic-usage.csv',
        'x-kaudit-period-start': '2026-06-01',
        'x-kaudit-period-end': '2026-06-30',
        'content-type': 'text/csv',
      },
      body: csv,
    })
    assert.equal(response.status, 400)
    const body = (await response.json()) as {
      code: string
      issues?: Array<{ rowIndex: number; field: string; code: string }>
    }
    assert.equal(body.code, 'INVALID_IMPORT_ROWS')
    assert.deepEqual(body.issues, [
      { rowIndex: 2, field: 'durationWithRingingSec', code: 'DURATION_INVALID' },
      { rowIndex: 1, field: 'recordingUrl', code: 'RECORDING_URL_INVALID' },
    ])
    // No offending value ever appears in the response.
    const raw = JSON.stringify(body)
    assert.ok(!raw.includes('blocked-host.example.test'))
    assert.ok(!raw.includes('very-secret-file'))
    assert.ok(!raw.includes('not-a-number'))
  })
})

test('GAS usage import authenticates by HMAC without a browser cookie', async () => {
  await withServer(async (baseUrl, events) => {
    const csv = [
      HEADER,
      'task-bad-duration,+91,2026-06-01 10:00:00,2026-06-01 10:00:04,2026-06-01 10:00:34,not-a-number,30,0.5,,',
    ].join('\n')
    const response = await fetch(`${baseUrl}/api/v1/imports/usage`, {
      method: 'POST',
      headers: gasHeaders({ body: csv }),
      body: csv,
    })
    assert.equal(response.status, 400)
    const body = await response.json() as Record<string, unknown>
    assert.equal(body.code, 'INVALID_IMPORT_ROWS')
    assert.equal(events.at(-1)?.actorUserId, null)
    assert.equal(events.at(-1)?.outcome, 'failure')
  })
})

test('GAS usage import rejects a signature whose body hash is not exact', async () => {
  await withServer(async (baseUrl) => {
    const csv = [
      HEADER,
      'task-bad-duration,+91,2026-06-01 10:00:00,2026-06-01 10:00:04,2026-06-01 10:00:34,not-a-number,30,0.5,,',
    ].join('\n')
    const response = await fetch(`${baseUrl}/api/v1/imports/usage`, {
      method: 'POST',
      headers: gasHeaders({ body: csv, signedBody: `${csv}\n` }),
      body: csv,
    })
    assert.equal(response.status, 401)
    const body = await response.json() as Record<string, unknown>
    assert.equal(body.code, 'AUTH_INVALID')
  })
})

function adminCookie(): string {
  if (config.auth.mode !== 'local') throw new Error('local config required')
  const token = issueLocalSession(
    config.auth.email,
    config.auth.sessionSecret,
    config.auth.sessionTtlSeconds,
  )
  return `${config.auth.sessionCookie}=${encodeURIComponent(token)}`
}
