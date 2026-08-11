import { test } from 'node:test'
import assert from 'node:assert/strict'
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

/**
 * Import endpoints on a runtime that has no cycle import service.
 *
 * That is the Vercel Function's shape: the only import implementation writes the
 * uploaded bytes under `KAUDIT_IMPORT_ROOT`, and a function has no durable
 * filesystem, so the dependency is simply absent. What must follow is a bounded
 * refusal that happens BEFORE the upload is read — accepting up to 25 MB of an
 * operator's usage CSV or invoice PDF only to discard it is work this deployment
 * has no reason to do, and bytes it has no reason to hold.
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
  // No `imports`, no `importAnalysis`: exactly what the Vercel bootstrap builds.
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
