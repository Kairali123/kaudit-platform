import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
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
import { gasImportSigningPayload } from '../imports/gasImportAuth.ts'
import { sha256Hex } from '../lib/hash.ts'
import type { CycleImportService } from '../imports/types.ts'

/**
 * Import endpoints on a runtime that has no cycle import service.
 *
 * This remains a supported fail-closed shape for deployments with no durable
 * import store. What must follow is a bounded refusal that happens BEFORE the
 * upload is read — accepting up to 25 MB of an operator's usage CSV or invoice
 * PDF only to discard it is work that deployment has no reason to do, and bytes
 * it has no reason to hold.
 *
 * Every dependency here is synthetic: no database, no network, no model.
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

/** `import:write` is an administrator permission. */
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

function adminCookie(): string {
  if (config.auth.mode !== 'local') throw new Error('local config required')
  const token = issueLocalSession(
    config.auth.email,
    config.auth.sessionSecret,
    config.auth.sessionTtlSeconds,
  )
  return `${config.auth.sessionCookie}=${encodeURIComponent(token)}`
}

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
  const pool = {
    async query() {
      return [[{ one: 1 }], []]
    },
  } as unknown as Pool
  // No `imports`, no `importAnalysis`: the fail-closed bootstrap shape.
  const server = createEnterpriseDashboardServer({
    config,
    pool,
    access,
    audit,
    verifier: null,
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

const IMPORT_WRITE_ROUTES = [
  '/api/v1/imports/usage',
  '/api/v1/imports/invoice',
]
const IMPORT_ANALYSIS_ROUTES = [
  '/api/v1/imports/analyze-usage',
  '/api/v1/imports/analyze-invoice',
]
const ALL_IMPORT_POST_ROUTES = [
  ...IMPORT_WRITE_ROUTES,
  ...IMPORT_ANALYSIS_ROUTES,
]

test('an unavailable import refuses before it reads the body', async () => {
  await withServer(async (baseUrl) => {
    for (const route of ALL_IMPORT_POST_ROUTES) {
      // An empty body is the proof. `readRequestBody` rejects a zero-length
      // upload with 400 EMPTY_UPLOAD, and the missing `x-kaudit-filename`
      // header would be a 400 straight after it. A 503 can only mean neither
      // ran — the availability check came first.
      const response = await fetch(`${baseUrl}${route}`, {
        method: 'POST',
        headers: { cookie: adminCookie() },
      })
      assert.equal(response.status, 503, route)
      const body = (await response.json()) as Record<string, unknown>
      assert.equal(body.status, 503)
      assert.notEqual(body.code, 'EMPTY_UPLOAD')
      assert.notEqual(body.code, 'INVALID_IMPORT_REQUEST')
    }
  })
})

test('a real upload is refused without the bytes being consumed', async () => {
  await withServer(async (baseUrl) => {
    for (const route of ALL_IMPORT_POST_ROUTES) {
      const response = await fetch(`${baseUrl}${route}`, {
        method: 'POST',
        headers: {
          cookie: adminCookie(),
          'x-kaudit-filename': 'synthetic-usage.csv',
          'x-kaudit-period-start': '2026-07-01',
          'x-kaudit-period-end': '2026-07-31',
          'content-type': 'text/csv',
        },
        body: 'Call ID,Duration\nsynthetic-call-1,42\n',
      })
      assert.equal(response.status, 503, route)
    }
  })
})

test('the refusal returns no uploaded content and no error detail', async () => {
  await withServer(async (baseUrl) => {
    for (const route of ALL_IMPORT_POST_ROUTES) {
      const response = await fetch(`${baseUrl}${route}`, {
        method: 'POST',
        headers: {
          cookie: adminCookie(),
          'x-kaudit-filename': 'july-invoice-9910.pdf',
          'x-kaudit-invoice-number': 'INV-9910',
          'x-kaudit-total-amount': '412345.67',
        },
        body: 'synthetic-invoice-bytes-4f3a1b2c',
      })
      const raw = await response.text()
      for (const leaked of [
        'synthetic-invoice-bytes',
        '4f3a1b2c',
        'july-invoice-9910',
        'INV-9910',
        '412345.67',
        'KAUDIT_IMPORT_ROOT',
        '.data/imports',
        'ENOENT',
        'OPENAI',
      ]) {
        assert.equal(
          raw.includes(leaked),
          false,
          `${route} must not echo ${leaked}`,
        )
      }
      const body = JSON.parse(raw) as Record<string, unknown>
      assert.deepEqual(Object.keys(body).sort(), [
        'code',
        'correlationId',
        'status',
        'title',
        'type',
      ])
      assert.ok(raw.length < 512, 'the refusal must stay bounded')
    }
  })
})

test('the refusal is distinct per dependency and never a generic failure', async () => {
  await withServer(async (baseUrl) => {
    for (const route of IMPORT_WRITE_ROUTES) {
      const body = (await (
        await fetch(`${baseUrl}${route}`, {
          method: 'POST',
          headers: { cookie: adminCookie() },
        })
      ).json()) as Record<string, unknown>
      assert.equal(body.code, 'IMPORT_NOT_AVAILABLE')
    }
    for (const route of IMPORT_ANALYSIS_ROUTES) {
      const body = (await (
        await fetch(`${baseUrl}${route}`, {
          method: 'POST',
          headers: { cookie: adminCookie() },
        })
      ).json()) as Record<string, unknown>
      assert.equal(body.code, 'IMPORT_ANALYSIS_NOT_CONFIGURED')
    }
  })
})

test('the attempt is still recorded in the access audit', async () => {
  await withServer(async (baseUrl, events) => {
    await fetch(`${baseUrl}/api/v1/imports/usage`, {
      method: 'POST',
      headers: { cookie: adminCookie() },
    })
    const recorded = events.filter(
      (event) => event.action === 'usage_import.create',
    )
    assert.equal(recorded.length, 1)
    assert.equal(recorded[0]?.outcome, 'failure')
    assert.equal(recorded[0]?.actorEmail, 'admin@example.test')
  })
})

test('the import status read reports unavailable rather than failing', async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/v1/imports`, {
      headers: { cookie: adminCookie() },
    })
    // Never a 200 that advertises imports as enabled, and never an opaque 500.
    assert.equal(response.status, 503)
    const body = (await response.json()) as Record<string, unknown>
    assert.equal(body.code, 'IMPORT_NOT_AVAILABLE')
  })
})

test('authorization is still checked before availability', async () => {
  await withServer(async (baseUrl) => {
    // No session: an unauthenticated caller must not learn the deployment's
    // import capability.
    const response = await fetch(`${baseUrl}/api/v1/imports/usage`, {
      method: 'POST',
    })
    assert.equal(response.status, 401)
    const body = (await response.json()) as Record<string, unknown>
    assert.notEqual(body.code, 'IMPORT_NOT_AVAILABLE')
  })
})

test('a signed GAS request reaches usage import without a browser session', async () => {
  const events: AuditEvent[] = []
  const bytes = Buffer.from('synthetic,csv')
  const timestamp = String(Date.now())
  const secret = 'synthetic-gas-import-secret-32-characters'
  const filename = 'synthetic-usage.csv'
  const periodStart = '2026-06-01'
  const periodEnd = '2026-06-30'
  const bodySha256 = sha256Hex(bytes)
  const signature = createHmac('sha256', secret).update(
    gasImportSigningPayload({
      method: 'POST',
      pathname: '/api/v1/imports/usage',
      timestamp,
      bodySha256,
      filename,
      periodStart,
      periodEnd,
    }),
  ).digest('hex')
  let importCalls = 0
  let storageUnavailable = false
  const imports = {
    async status() { throw new Error('not used') },
    async importInvoice() { throw new Error('not used') },
    async importUsage(request) {
      importCalls += 1
      assert.deepEqual(request.bytes, bytes)
      if (storageUnavailable) {
        throw Object.assign(new Error('synthetic provider prose'), {
          status: 503,
          code: 'GOOGLE_DRIVE_IMPORT_LOOKUP_FAILED',
        })
      }
      return {
        outcome: 'imported' as const,
        referenceId: 'synthetic-batch',
        received: 1,
        accepted: 1,
        duplicates: 0,
        auditJobsQueued: 0,
        missingRecordingUrls: 1,
      }
    },
  } satisfies CycleImportService
  const server = createEnterpriseDashboardServer({
    config,
    pool: { async query() { return [[{ one: 1 }], []] } } as unknown as Pool,
    access,
    audit: {
      async record(event) { events.push(event) },
      async readiness() { return true },
    },
    verifier: null,
    imports,
    gasImportSecret: secret,
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const address = server.address() as AddressInfo
    const response = await fetch(
      `http://127.0.0.1:${address.port}/api/v1/imports/usage`,
      {
        method: 'POST',
        body: bytes,
        headers: {
          'x-kaudit-filename': filename,
          'x-kaudit-period-start': periodStart,
          'x-kaudit-period-end': periodEnd,
          'x-kaudit-content-sha256': bodySha256,
          'x-kaudit-import-timestamp': timestamp,
          'x-kaudit-import-signature': signature,
        },
      },
    )
    assert.equal(response.status, 200)
    assert.equal((await response.json() as { accepted: number }).accepted, 1)
    const event = events.find((item) => item.action === 'usage_import.create')
    assert.equal(event?.outcome, 'success')
    assert.equal(event?.actorUserId, null)
    assert.equal(event?.actorEmail, 'gas-import@kaudit.invalid')

    const tampered = await fetch(
      `http://127.0.0.1:${address.port}/api/v1/imports/usage`,
      {
        method: 'POST',
        body: Buffer.from('changed,csv'),
        headers: {
          'x-kaudit-filename': filename,
          'x-kaudit-period-start': periodStart,
          'x-kaudit-period-end': periodEnd,
          'x-kaudit-content-sha256': bodySha256,
          'x-kaudit-import-timestamp': timestamp,
          'x-kaudit-import-signature': signature,
        },
      },
    )
    assert.equal(tampered.status, 401)
    assert.equal(importCalls, 1)

    storageUnavailable = true
    const unavailable = await fetch(
      `http://127.0.0.1:${address.port}/api/v1/imports/usage`,
      {
        method: 'POST',
        body: bytes,
        headers: {
          'x-kaudit-filename': filename,
          'x-kaudit-period-start': periodStart,
          'x-kaudit-period-end': periodEnd,
          'x-kaudit-content-sha256': bodySha256,
          'x-kaudit-import-timestamp': timestamp,
          'x-kaudit-import-signature': signature,
        },
      },
    )
    assert.equal(unavailable.status, 503)
    const unavailableRaw = await unavailable.text()
    assert.equal(unavailableRaw.includes('synthetic provider prose'), false)
    assert.equal(
      (JSON.parse(unavailableRaw) as { code: string }).code,
      'GOOGLE_DRIVE_IMPORT_LOOKUP_FAILED',
    )
    assert.equal(importCalls, 2)
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve()))
  }
})
