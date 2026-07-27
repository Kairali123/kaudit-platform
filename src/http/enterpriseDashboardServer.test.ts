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
  },
  auth: {
    mode: 'local',
    email: 'operator@example.test',
  },
  releaseGates: {
    calibrationComplete: false,
    k23AutomationEnabled: false,
    clinicalSafetyOwner: null,
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

async function withServer(
  audit: AuditSink,
  run: (baseUrl: string) => Promise<void>,
  webDistRoot?: string,
  runtimeConfig: RuntimeConfig = config,
  verifier: TokenVerifier | null = null,
): Promise<void> {
  const pool = {
    async query() {
      return [[{ one: 1 }], []]
    },
  } as unknown as Pool
  const server = createEnterpriseDashboardServer({
    config: runtimeConfig,
    pool,
    access,
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
      assert.equal(profile.maxSensitivityTier, 'K0')

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
      const page = await fetch(`${baseUrl}/billing`)
      assert.equal(page.status, 200)
      assert.match(
        page.headers.get('content-security-policy') ?? '',
        /script-src 'self'/,
      )
      const asset = await fetch(`${baseUrl}/assets/app.js`)
      assert.equal(asset.status, 200)
      assert.equal(
        asset.headers.get('content-type'),
        'text/javascript; charset=utf-8',
      )
    },
    root,
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
        headers: { 'x-correlation-id': 'synthetic-request-1' },
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
      const response = await fetch(`${baseUrl}/api/v1/me`)
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
      const response = await fetch(`${baseUrl}/api/v1/overview`)
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
