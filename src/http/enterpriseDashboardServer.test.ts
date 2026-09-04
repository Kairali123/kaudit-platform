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
    tlsMode: 'required',
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
  poolOverride?: Pool,
): Promise<void> {
  const pool = {
    async query() {
      return [[{ one: 1 }], []]
    },
  } as unknown as Pool
  const server = createEnterpriseDashboardServer({
    config: runtimeConfig,
    pool: poolOverride ?? pool,
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

test('slow audit monitor reads survive TTL expiry and cache pruning', async (context) => {
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
  let queryCount = 0
  let nowMs = Date.now()
  context.mock.method(Date, 'now', () => nowMs)
  let releaseFirstQuery: (() => void) | null = null
  let resolveFirstQuery!: () => void
  const firstQueryStarted = new Promise<void>((resolve) => {
    resolveFirstQuery = resolve
  })
  const read = async () => {
    queryCount += 1
    if (queryCount === 1) {
      await new Promise<void>((release) => {
        releaseFirstQuery = release
        resolveFirstQuery()
      })
    }
    return [[], []]
  }
  const pool = {
    query: read,
    execute: read,
  } as unknown as Pool
  await withServer(
    {
      async record() {},
      async readiness() { return true },
    },
    async (baseUrl) => {
      const first = fetch(`${baseUrl}/api/v1/audits`, {
        headers: { cookie: localCookie() },
      })
      await firstQueryStarted
      await new Promise((resolve) => setTimeout(resolve, 0))
      nowMs += 6_000
      const pruningRead = await fetch(`${baseUrl}/api/v1/periods`, {
        headers: { cookie: localCookie() },
      })
      assert.equal(pruningRead.status, 200)
      const queriesBeforeSecond = queryCount
      const second = fetch(`${baseUrl}/api/v1/audits`, {
        headers: { cookie: localCookie() },
      })
      await new Promise((resolve) => setTimeout(resolve, 0))
      const queriesWhileBlocked = queryCount
      releaseFirstQuery?.()
      assert.equal((await first).status, 200)
      assert.equal((await second).status, 200)
      assert.equal(queriesWhileBlocked, queriesBeforeSecond)
    },
    undefined,
    config,
    null,
    adminAccess,
    pool,
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

test('protected response fails closed and logs bounded driver context', async () => {
  const originalWrite = process.stderr.write
  const writes: string[] = []
  process.stderr.write = ((chunk: string | Uint8Array) => {
    writes.push(String(chunk))
    return true
  }) as typeof process.stderr.write
  const outage = Object.assign(new Error('synthetic audit outage'), {
    code: 'ER_CON_COUNT_ERROR',
    kauditPhase: 'pool_acquisition',
  })
  try {
    await withServer(
      {
        async record() {
          throw outage
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
        assert.equal(JSON.stringify(body).includes('ER_CON_COUNT_ERROR'), false)
      },
    )
  } finally {
    process.stderr.write = originalWrite
  }
  const failure = writes
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .find((line) => line.event === 'dashboard_request_failed')
  assert.equal(failure?.code, 'INTERNAL_ERROR')
  assert.equal(failure?.driverCode, 'ER_CON_COUNT_ERROR')
  assert.equal(failure?.phase, 'pool_acquisition')
  assert.equal(JSON.stringify(failure).includes('synthetic audit outage'), false)
})

test('a bounded billing statement timeout returns a sanitized 504', async () => {
  const originalWrite = process.stderr.write
  const writes: string[] = []
  process.stderr.write = ((chunk: string | Uint8Array) => {
    writes.push(String(chunk))
    return true
  }) as typeof process.stderr.write
  const timeout = Object.assign(new Error('synthetic private timeout detail'), {
    code: 'ER_STATEMENT_TIMEOUT',
    kauditPhase: 'statement_execution',
  })
  const timeoutPool = {
    async query() {
      throw timeout
    },
  } as unknown as Pool
  const server = createEnterpriseDashboardServer({
    config,
    pool: timeoutPool,
    billingReadPool: timeoutPool,
    access,
    audit: {
      async record() {},
      async readiness() {
        return true
      },
    },
    verifier: null,
  })
  await new Promise<void>((resolve) =>
    server.listen(0, '127.0.0.1', resolve),
  )
  const address = server.address() as AddressInfo
  try {
    const response = await fetch(
      `http://127.0.0.1:${address.port}/api/v1/billing?month=2026-05`,
      { headers: { cookie: localCookie() } },
    )
    assert.equal(response.status, 504)
    const body = (await response.json()) as Record<string, unknown>
    assert.equal(body.code, 'QUERY_TIMEOUT')
    assert.equal(body.title, 'The request timed out. Try again.')
    assert.equal(JSON.stringify(body).includes('ER_STATEMENT_TIMEOUT'), false)
    assert.equal(
      JSON.stringify(body).includes('synthetic private timeout detail'),
      false,
    )
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve()),
    )
    process.stderr.write = originalWrite
  }
  const failure = writes
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .find((line) => line.event === 'dashboard_request_failed')
  assert.equal(failure?.code, 'QUERY_TIMEOUT')
  assert.equal(failure?.driverCode, 'ER_STATEMENT_TIMEOUT')
  assert.equal(failure?.phase, 'statement_execution')
  assert.equal(
    JSON.stringify(failure).includes('synthetic private timeout detail'),
    false,
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

test('the audit monitor reads through the bounded billing pool', async () => {
  /**
   * The monitor's aggregates are the heaviest reads in the application. Running
   * them on the unbounded pool let one slow aggregate hold a pooled connection
   * past the request that asked for it, starving the session and audit reads
   * that share the pool. They must honour the same per-statement bound as every
   * other dashboard read.
   */
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
  const unboundedStatements: string[] = []
  const boundedStatements: string[] = []
  const unboundedPool = {
    async query(sql: string) {
      unboundedStatements.push(sql)
      return [[], []]
    },
  } as unknown as Pool
  const boundedPool = {
    async query(sql: string) {
      boundedStatements.push(sql)
      return [[], []]
    },
  } as unknown as Pool
  const server = createEnterpriseDashboardServer({
    config,
    pool: unboundedPool,
    billingReadPool: boundedPool,
    access: adminAccess,
    audit: {
      async record() {},
      async readiness() {
        return true
      },
    },
    verifier: null,
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as AddressInfo
  try {
    for (const query of [
      'section=rows&table=pending',
      'section=rows&table=audited',
      'section=rows&table=no-recording',
      'section=summary-core',
      'section=summary-usage',
      'section=summary-financial',
    ]) {
      const response = await fetch(
        `http://127.0.0.1:${address.port}/api/v1/audits?${query}`,
        { headers: { cookie: localCookie() } },
      )
      assert.equal(response.status, 200, query)
    }
    assert.ok(boundedStatements.length > 0)
    assert.deepEqual(unboundedStatements, [])
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    )
  }
})

test('audit monitor Task ID search is exact and invalid input never reaches SQL', async () => {
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
  const calls: Array<{ sql: string; params: unknown[] }> = []
  const pool = {
    async query(sql: string, params: unknown[] = []) {
      calls.push({ sql, params })
      return [[], []]
    },
  } as unknown as Pool

  await withServer(
    {
      async record() {},
      async readiness() { return true },
    },
    async (baseUrl) => {
      const invalid = await fetch(
        `${baseUrl}/api/v1/audits?taskId=invalid%20task`,
        { headers: { cookie: localCookie() } },
      )
      assert.equal(invalid.status, 400)
      assert.equal(
        ((await invalid.json()) as { code?: string }).code,
        'INVALID_AUDIT_QUERY',
      )
      assert.equal(calls.length, 0)

      const invalidSection = await fetch(
        `${baseUrl}/api/v1/audits?section=synthetic-invalid`,
        { headers: { cookie: localCookie() } },
      )
      assert.equal(invalidSection.status, 400)
      assert.equal(
        ((await invalidSection.json()) as { code?: string }).code,
        'INVALID_AUDIT_QUERY',
      )
      assert.equal(calls.length, 0)

      const invalidTable = await fetch(
        `${baseUrl}/api/v1/audits?section=rows&table=synthetic-invalid`,
        { headers: { cookie: localCookie() } },
      )
      assert.equal(invalidTable.status, 400)
      assert.equal(
        ((await invalidTable.json()) as { code?: string }).code,
        'INVALID_AUDIT_QUERY',
      )
      assert.equal(calls.length, 0)

      const tableWithoutRows = await fetch(
        `${baseUrl}/api/v1/audits?section=summary&table=audited`,
        { headers: { cookie: localCookie() } },
      )
      assert.equal(tableWithoutRows.status, 400)
      assert.equal(calls.length, 0)

      for (const section of [
        'summary-core',
        'summary-usage',
        'summary-financial',
      ]) {
        const splitSummary = await fetch(
          `${baseUrl}/api/v1/audits?section=${section}`,
          { headers: { cookie: localCookie() } },
        )
        assert.equal(splitSummary.status, 200, section)
      }

      const taskId = 'synthetic-task-search'
      const valid = await fetch(
        `${baseUrl}/api/v1/audits?taskId=${taskId}`,
        { headers: { cookie: localCookie() } },
      )
      assert.equal(valid.status, 200)
      const body = (await valid.json()) as {
        filters: { taskId: string | null }
      }
      assert.equal(body.filters.taskId, taskId)
      assert.ok(
        calls.some(({ params }) => params.includes(taskId)),
      )
      assert.equal(
        calls.some(({ sql }) => sql.includes(taskId)),
        false,
      )
      // Task ID matching stays EXACT — never a wildcard search. A LIKE may
      // appear for the audit engine-family prefix, which matches an internal
      // version string, so the property under guard is that no caller-supplied
      // reference is ever matched by pattern.
      assert.equal(
        calls.some(({ sql }) =>
          /(task_ref\.external_id|logical_call_key)\s+LIKE/i.test(sql),
        ),
        false,
      )
      assert.equal(
        calls.some(({ params }) =>
          params.some(
            (value) =>
              typeof value === 'string' &&
              value.includes('%') &&
              value.includes(taskId),
          ),
        ),
        false,
      )
    },
    undefined,
    config,
    null,
    adminAccess,
    pool,
  )
})

test('audit monitor API exposes terminal re-audit lifecycle without queue internals', async () => {
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
  const pool = {
    async query(sql: string) {
      if (sql.includes('auditor_final_charge')) {
        return [[{
          audited_calls: 1,
          kserve_priced_calls: 0,
          kserve_charge: '0.00000000',
          auditor_final_priced_calls: 0,
          auditor_unfinalized_calls: 1,
          auditor_final_charge: '0.00000000',
        }], []]
      }
      if (sql.includes('grace_adjusted_duration_ms')) {
        return [[{
          internal_call_id: 'call-synthetic-1',
          call_reference: 'synthetic-task-1',
          billing_period_date: '2026-08-01',
          category: 'TIME_DURATION',
          outcome_taxonomy_version: 'v2',
          confidence: '0.95000000',
          confirmation_status: 'model_output',
          language: 'english',
          provider_name: 'synthetic-asr',
          model_name: 'synthetic-model',
          model_version: '1',
          engine_version: 'kairali-independent-reaudit/2.1.0',
          decoded_duration_ms: 190_000,
          speech_ms: 80_000,
          conversation_end_ms: 61_000,
          grace_adjusted_duration_ms: 121_000,
          vendor_connected_duration_ms: 180_000,
          evidence_sha256: 'f'.repeat(64),
          last_verified_at: '2026-08-02 00:00:00',
          audited_at: '2026-08-20 09:00:00',
          ai_input_tokens: 100,
          ai_output_tokens: 50,
          ai_total_tokens: 150,
          ai_audio_seconds: 190,
        }], []]
      }
      if (sql.includes('kaudit_billing_reaudit_item')) {
        return [[{
          call_id: 'call-synthetic-1',
          status: 'failed',
          created_at: '2026-08-20 09:00:00',
          completed_at: '2026-08-20 09:05:00',
        }], []]
      }
      return [[], []]
    },
  } as unknown as Pool

  await withServer(
    {
      async record() {},
      async readiness() {
        return true
      },
    },
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/v1/audits`, {
        headers: { cookie: localCookie() },
      })
      assert.equal(response.status, 200)
      const body = await response.json() as {
        rows: Array<Record<string, unknown>>
      }
      assert.equal(body.rows[0]?.reAuditStatus, 'failed')
      assert.match(String(body.rows[0]?.reAuditCompletedAt), /^2026-08-20T/)
      const serialized = JSON.stringify(body)
      const rowSerialized = JSON.stringify(body.rows[0])
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
      assert.equal(serialized.includes('call-synthetic-1'), false)
      for (const forbidden of [
        'requestId',
        'itemId',
        'baselineAuditRunId',
        'lastErrorCode',
      ]) {
        assert.equal(rowSerialized.includes(forbidden), false)
      }
      for (const forbidden of [
        'sourceUrl',
        'recordingUrl',
        'transcript',
      ]) {
        assert.equal(keys.has(forbidden), false)
      }
    },
    undefined,
    config,
    null,
    adminAccess,
    pool,
  )
})
