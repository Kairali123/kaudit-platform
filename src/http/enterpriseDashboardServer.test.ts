import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { AddressInfo } from 'node:net'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { Pool } from 'mysql2/promise'
import type {
  AccessRepository,
  TokenVerifier,
} from '../auth/types.ts'
import type { AuditEvent, AuditSink } from '../audit/types.ts'
import type { RuntimeConfig } from '../config/runtime.ts'
import {
  createLocalPasswordHash,
  issueLocalSession,
} from '../auth/localSession.ts'
import { createEnterpriseDashboardServer } from './enterpriseDashboardServer.ts'

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
    email: 'operator@example.test',
    passwordHash: createLocalPasswordHash(
      'synthetic-password',
      Buffer.alloc(16, 3),
    ),
    sessionSecret:
      'synthetic-session-secret-at-least-32-characters',
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
    return email === 'operator@example.test'
      ? {
          id: 'user-1',
          email,
          status: 'active',
          maxSensitivityTier: 'K1',
          roles: ['user'],
        }
      : null
  },
  async readiness() {
    return true
  },
}

function localCookie(runtimeConfig: RuntimeConfig = config): string {
  if (runtimeConfig.auth.mode !== 'local') {
    throw new Error('Synthetic local config is required')
  }
  const token = issueLocalSession(
    runtimeConfig.auth.email,
    runtimeConfig.auth.sessionSecret,
    runtimeConfig.auth.sessionTtlSeconds,
  )
  return `${runtimeConfig.auth.sessionCookie}=${encodeURIComponent(token)}`
}

async function withServer(
  audit: AuditSink,
  run: (baseUrl: string) => Promise<void>,
  webDistRoot?: string,
  runtimeConfig: RuntimeConfig = config,
  verifier: TokenVerifier | null = null,
  accessRepository: AccessRepository = access,
): Promise<void> {
  const pool = {
    async query() {
      return [[{ one: 1 }], []]
    },
  } as unknown as Pool
  const server = createEnterpriseDashboardServer({
    config: runtimeConfig,
    pool,
    access: accessRepository,
    audit,
    verifier,
    webDistRoot,
  })
  await new Promise<void>((resolve) =>
    server.listen(0, '127.0.0.1', resolve),
  )
  const address = server.address() as AddressInfo
  try {
    await run(`http://127.0.0.1:${address.port}`)
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) =>
        error ? reject(error) : resolve(),
      ),
    )
  }
}

test('liveness is public but emits hardened no-store headers', async () => {
  const events: AuditEvent[] = []
  await withServer(
    {
      async record(event) {
        events.push(event)
      },
      async readiness() {
        return true
      },
    },
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/health/live`)
      assert.equal(response.status, 200)
      assert.equal(response.headers.get('cache-control'), 'no-store, max-age=0')
      assert.equal(response.headers.get('x-frame-options'), 'DENY')
      assert.equal(events.length, 0)
    },
  )
})

test('preview mode uses a non-authorizing identity and never writes access audit', async () => {
  let auditWrites = 0
  await withServer(
    {
      async record() {
        auditWrites += 1
      },
      async readiness() {
        return false
      },
    },
    async (baseUrl) => {
      const authConfig = await fetch(
        `${baseUrl}/api/v1/auth/config`,
      )
      assert.equal(authConfig.status, 200)
      const publicConfig =
        (await authConfig.json()) as Record<string, unknown>
      assert.equal(publicConfig.mode, 'preview')
      assert.equal(publicConfig.passwordLoginSupported, false)
      assert.equal(publicConfig.logoutUrl, '/login')

      const logout = await fetch(`${baseUrl}/logout`, {
        redirect: 'manual',
      })
      assert.equal(logout.status, 302)
      assert.equal(logout.headers.get('location'), '/login')

      const me = await fetch(`${baseUrl}/api/v1/me`)
      assert.equal(me.status, 200)
      const profile = (await me.json()) as Record<string, unknown>
      assert.equal(profile.authMode, 'preview')
      assert.equal(profile.accessControlEnforced, false)
      assert.equal('maxSensitivityTier' in profile, false)

      const overview = await fetch(`${baseUrl}/api/v1/overview`)
      assert.equal(overview.status, 200)
      const body = (await overview.json()) as {
        gates: Array<{ code: string; status: string }>
      }
      assert.equal(
        body.gates.find((gate) => gate.code === 'access')?.status,
        'blocked',
      )
      assert.equal(auditWrites, 0)
    },
    undefined,
    {
      ...config,
      auth: { mode: 'preview' },
    },
  )
})

test('authenticated app routes serve the built shell with a script-safe CSP', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kaudit-web-test-'))
  await mkdir(path.join(root, 'assets'))
  await writeFile(
    path.join(root, 'index.html'),
    '<!doctype html><div id="root"></div><script src="/assets/app.js"></script>',
  )
  await writeFile(path.join(root, 'assets/app.js'), 'void 0')
  await withServer(
    {
      async record() {},
      async readiness() {
        return true
      },
    },
    async (baseUrl) => {
      const login = await fetch(`${baseUrl}/login`)
      assert.equal(login.status, 200)
      const unauthenticated = await fetch(`${baseUrl}/billing`, {
        redirect: 'manual',
      })
      assert.equal(unauthenticated.status, 302)
      assert.equal(unauthenticated.headers.get('location'), '/login')

      const signIn = await fetch(`${baseUrl}/api/v1/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          email: 'operator@example.test',
          password: 'synthetic-password',
        }),
      })
      assert.equal(signIn.status, 200)
      const cookie = signIn.headers
        .get('set-cookie')
        ?.split(';')[0]
      assert.ok(cookie)

      const page = await fetch(`${baseUrl}/billing`, {
        headers: { cookie },
      })
      assert.equal(page.status, 200)
      const imports = await fetch(`${baseUrl}/imports/new`, {
        headers: { cookie },
      })
      assert.equal(imports.status, 403)
      assert.match(
        page.headers.get('content-security-policy') ?? '',
        /script-src 'self'/,
      )
      assert.match(
        page.headers.get('content-security-policy') ?? '',
        /media-src 'self'/,
      )
      const asset = await fetch(`${baseUrl}/assets/app.js`)
      assert.equal(asset.status, 200)
      assert.equal(
        asset.headers.get('content-type'),
        'text/javascript; charset=utf-8',
      )

      const logout = await fetch(`${baseUrl}/logout`, {
        redirect: 'manual',
        headers: { cookie },
      })
      assert.equal(logout.status, 302)
      assert.match(
        logout.headers.get('set-cookie') ?? '',
        /Max-Age=0/,
      )
    },
    root,
  )
})

test('local login rejects an invalid password without issuing a session', async () => {
  await withServer(
    {
      async record() {},
      async readiness() {
        return true
      },
    },
    async (baseUrl) => {
      const authConfig = await fetch(
        `${baseUrl}/api/v1/auth/config`,
      )
      const publicConfig =
        (await authConfig.json()) as Record<string, unknown>
      assert.equal(publicConfig.passwordLoginSupported, true)

      const response = await fetch(
        `${baseUrl}/api/v1/auth/login`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            email: 'operator@example.test',
            password: 'wrong-password',
          }),
        },
      )
      assert.equal(response.status, 401)
      assert.equal(response.headers.get('set-cookie'), null)
    },
  )
})

test('unauthenticated OIDC browser navigation redirects to the public login page', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kaudit-login-test-'))
  await mkdir(path.join(root, 'assets'))
  await writeFile(
    path.join(root, 'index.html'),
    '<!doctype html><div id="root"></div>',
  )
  const oidcConfig: RuntimeConfig = {
    ...config,
    auth: {
      mode: 'oidc',
      issuer: 'https://identity.example.test/',
      audience: 'kaudit',
      jwksUri: 'https://identity.example.test/jwks',
      loginUrl: 'https://identity.example.test/login',
      logoutUrl: 'https://identity.example.test/logout',
      tokenCookie: 'kaudit_session',
      algorithms: ['RS256'],
      maxTokenAgeSeconds: 900,
      browserFlow: null,
    },
  }
  await withServer(
    {
      async record() {},
      async readiness() {
        return true
      },
    },
    async (baseUrl) => {
      const login = await fetch(`${baseUrl}/login`)
      assert.equal(login.status, 200)

      const app = await fetch(`${baseUrl}/overview`, {
        redirect: 'manual',
      })
      assert.equal(app.status, 302)
      assert.equal(app.headers.get('location'), '/login')

      const api = await fetch(`${baseUrl}/api/v1/me`)
      assert.equal(api.status, 401)

      const logout = await fetch(`${baseUrl}/logout`, {
        redirect: 'manual',
      })
      assert.equal(logout.status, 302)
      assert.equal(
        logout.headers.get('location'),
        'https://identity.example.test/logout',
      )
    },
    root,
    oidcConfig,
    {
      async verify() {
        throw new Error('no token expected')
      },
    },
  )
})

test('local authenticated me endpoint enforces role lookup and audits access', async () => {
  const events: AuditEvent[] = []
  await withServer(
    {
      async record(event) {
        events.push(event)
      },
      async readiness() {
        return true
      },
    },
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/v1/me`, {
        headers: {
          'x-correlation-id': 'synthetic-request-1',
          cookie: localCookie(),
        },
      })
      assert.equal(response.status, 200)
      assert.equal(response.headers.get('x-correlation-id'), 'synthetic-request-1')
      const body = (await response.json()) as Record<string, unknown>
      assert.equal(body.email, 'operator@example.test')
      assert.deepEqual(body.roles, ['user'])
      assert.equal(events.length, 1)
      assert.equal(events[0]?.action, 'identity.read')
      assert.equal(events[0]?.outcome, 'success')
    },
  )
})

test('protected response fails closed when the audit sink is unavailable', async () => {
  await withServer(
    {
      async record() {
        throw new Error('synthetic audit outage')
      },
      async readiness() {
        return false
      },
    },
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/v1/me`, {
        headers: { cookie: localCookie() },
      })
      assert.equal(response.status, 500)
      const body = (await response.json()) as Record<string, unknown>
      assert.equal(body.code, 'INTERNAL_ERROR')
      assert.equal(JSON.stringify(body).includes('synthetic audit outage'), false)
    },
  )
})

test('overview API is page-scoped and never exposes raw call content', async () => {
  const events: AuditEvent[] = []
  await withServer(
    {
      async record(event) {
        events.push(event)
      },
      async readiness() {
        return true
      },
    },
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/v1/overview`, {
        headers: { cookie: localCookie() },
      })
      assert.equal(response.status, 200)
      const body = (await response.json()) as Record<string, unknown>
      assert.ok(Array.isArray(body.tiles))
      assert.ok(Array.isArray(body.gates))
      assert.equal('quality' in body, false)
      assert.equal('billing' in body, false)
      assert.equal('snapshots' in body, false)
      assert.equal(JSON.stringify(body).includes('transcript'), false)
      assert.equal(events.at(-1)?.action, 'overview.read')
    },
  )
})

test('audit monitor is admin-only and excludes raw content fields', async () => {
  const deniedEvents: AuditEvent[] = []
  await withServer(
    {
      async record(event) {
        deniedEvents.push(event)
      },
      async readiness() {
        return true
      },
    },
    async (baseUrl) => {
      const deniedPage = await fetch(`${baseUrl}/audits`, {
        redirect: 'manual',
        headers: { cookie: localCookie() },
      })
      assert.equal(deniedPage.status, 403)
      const denied = await fetch(`${baseUrl}/api/v1/audits`, {
        headers: { cookie: localCookie() },
      })
      assert.equal(denied.status, 403)
      const problem = (await denied.json()) as Record<string, unknown>
      assert.equal(problem.code, 'PERMISSION_DENIED')
      const deniedCall = await fetch(
        `${baseUrl}/api/v1/audit-call?task=synthetic-task`,
        { headers: { cookie: localCookie() } },
      )
      assert.equal(deniedCall.status, 403)
      const deniedAudio = await fetch(
        `${baseUrl}/api/v1/audit-audio?task=synthetic-task`,
        { headers: { cookie: localCookie() } },
      )
      assert.equal(deniedAudio.status, 403)
      assert.equal(deniedEvents.at(-1)?.outcome, 'denied')
    },
  )

  const adminEvents: AuditEvent[] = []
  const adminAccess: AccessRepository = {
    ...access,
    async findByEmail(email) {
      return {
        id: 'admin-1',
        email,
        status: 'active',
        maxSensitivityTier: 'K3',
        roles: ['admin'],
      }
    },
  }
  await withServer(
    {
      async record(event) {
        adminEvents.push(event)
      },
      async readiness() {
        return true
      },
    },
    async (baseUrl) => {
      const allowed = await fetch(`${baseUrl}/api/v1/audits`, {
        headers: { cookie: localCookie() },
      })
      assert.equal(allowed.status, 200)
      const body = await allowed.json()
      const keys = new Set<string>()
      const visit = (value: unknown): void => {
        if (Array.isArray(value)) {
          value.forEach(visit)
        } else if (value && typeof value === 'object') {
          for (const [key, item] of Object.entries(value)) {
            keys.add(key)
            visit(item)
          }
        }
      }
      visit(body)
      for (const forbidden of [
        'transcript',
        'sourceUrl',
        'recordingUrl',
        'phone',
        'remarks',
        'explanation',
      ]) {
        assert.equal(keys.has(forbidden), false)
      }
      assert.equal(adminEvents.at(-1)?.action, 'audits.read')
      assert.equal(adminEvents.at(-1)?.outcome, 'success')
    },
    undefined,
    config,
    null,
    adminAccess,
  )
})
