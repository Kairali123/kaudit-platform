import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { AddressInfo } from 'node:net'
import type { Pool } from 'mysql2/promise'
import type { CredentialRepository } from '../auth/credentialTypes.ts'
import type { LoginServicePort } from '../auth/loginService.ts'
import type { AccessRepository } from '../auth/types.ts'
import type { AuditSink } from '../audit/types.ts'
import type { RuntimeConfig } from '../config/runtime.ts'
import { createEnterpriseDashboardServer } from './enterpriseDashboardServer.ts'

const SECRET = 'synthetic-database-session-secret-32-characters'
const USER_ID = 'usr_database_test'

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
    tlsMode: 'disabled',
    sslCaFile: null,
    sslCaInline: false,
  },
  auth: {
    mode: 'database',
    sessionSecret: SECRET,
    sessionCookie: 'kaudit_user_session',
    sessionTtlSeconds: 3600,
  },
  releaseGates: {
    calibrationComplete: false,
    automatedValidationApproved: false,
    reportingApproved: false,
  },
}

function dependencies(stateVersion = 7) {
  const credentials: CredentialRepository = {
    async findByLogin() {
      return null
    },
    async getSessionState() {
      return {
        id: USER_ID,
        status: 'active',
        credentialStatus: 'active',
        sessionVersion: stateVersion,
      }
    },
    async readiness() {
      return true
    },
  }
  const loginService: LoginServicePort = {
    async authenticate() {
      return {
        ok: true,
        authorization: {
          userId: USER_ID,
          sessionVersion: 7,
          roles: ['admin'],
          maxSensitivityTier: 'K1',
        },
      }
    },
  }
  const access: AccessRepository = {
    async findByOidc() {
      return null
    },
    async findByEmail() {
      return null
    },
    async findById(userId) {
      return userId === USER_ID
        ? {
            id: USER_ID,
            email: 'operator@example.invalid',
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
  const audit: AuditSink = {
    async record() {},
    async readiness() {
      return true
    },
  }
  const pool = {
    async query() {
      return [[{ n: 5 }], []]
    },
  } as unknown as Pool
  return { credentials, loginService, access, audit, pool }
}

async function withServer(
  stateVersion: number,
  run: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const server = createEnterpriseDashboardServer({
    config,
    ...dependencies(stateVersion),
    verifier: null,
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as AddressInfo
  try {
    await run(`http://127.0.0.1:${address.port}`)
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    )
  }
}

test('database login issues a secure session accepted by the next request', async () => {
  await withServer(7, async (baseUrl) => {
    const login = await fetch(`${baseUrl}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ login: 'synthetic.operator', password: 'Synthetic-9!' }),
    })
    assert.equal(login.status, 200)
    const cookie = login.headers.get('set-cookie') ?? ''
    assert.ok(cookie.startsWith('kaudit_user_session='))
    assert.match(cookie, /; HttpOnly;/)
    assert.match(cookie, /; Secure;/)
    assert.match(cookie, /; SameSite=Strict;/)

    const sessionCookie = cookie.split(';', 1)[0]
    const me = await fetch(`${baseUrl}/api/v1/me`, {
      headers: { cookie: sessionCookie },
    })
    assert.equal(me.status, 200)
    const profile = (await me.json()) as { id: string; authMode: string }
    assert.equal(profile.id, USER_ID)
    assert.equal(profile.authMode, 'database')
  })
})

test('a session-version change revokes the issued session immediately', async () => {
  let cookie = ''
  await withServer(7, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ login: 'synthetic.operator', password: 'Synthetic-9!' }),
    })
    cookie = response.headers.get('set-cookie')?.split(';', 1)[0] ?? ''
  })
  await withServer(8, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/v1/me`, {
      headers: { cookie },
    })
    assert.equal(response.status, 401)
  })
})
