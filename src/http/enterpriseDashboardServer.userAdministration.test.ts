import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { AddressInfo } from 'node:net'
import type { Pool } from 'mysql2/promise'
import type { CredentialRepository } from '../auth/credentialTypes.ts'
import { issueUserSession } from '../auth/userSession.ts'
import type { AccessRepository } from '../auth/types.ts'
import type { AuditSink } from '../audit/types.ts'
import type { RuntimeConfig } from '../config/runtime.ts'
import {
  inputError,
  USER_ADMIN_INPUT_CODES,
  type UserAdministrationPort,
} from '../identity/userAdministration.ts'
import { createEnterpriseDashboardServer } from './enterpriseDashboardServer.ts'

const SECRET = 'synthetic-user-admin-session-secret-32-chars'
const USER_ID = 'usr_admin_http_test'
const COOKIE = 'kaudit_user_session'

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
    sessionCookie: COOKIE,
    sessionTtlSeconds: 3600,
  },
  releaseGates: {
    calibrationComplete: false,
    automatedValidationApproved: false,
    reportingApproved: false,
  },
}

function sessionCookie(): string {
  const token = issueUserSession(
    { userId: USER_ID, sessionVersion: 1 },
    SECRET,
    3600,
  )
  return `${COOKIE}=${token}`
}

function administration(
  overrides: Partial<UserAdministrationPort> = {},
): UserAdministrationPort {
  const change = {
    userId: 'usr_target_test',
    action: 'USER_ACCOUNT_UPDATED' as const,
    changed: true,
    sessionVersion: 2,
    auditMode: 'hash-chained' as const,
  }
  return {
    async listUsers(input) {
      return { users: [], limit: input.limit ?? 50, offset: input.offset ?? 0 }
    },
    async createUser() {
      return { ...change, action: 'USER_ACCOUNT_CREATED', role: 'user' }
    },
    async updateUser() {
      return change
    },
    async setUserActivation() {
      return { ...change, action: 'USER_ACCOUNT_DEACTIVATED' }
    },
    async resetUserPassword() {
      return { ...change, action: 'USER_ACCOUNT_PASSWORD_RESET' }
    },
    async tombstoneUser() {
      return { ...change, action: 'USER_ACCOUNT_TOMBSTONED' }
    },
    ...overrides,
  }
}

async function withServer(
  roles: string[],
  userAdministration: UserAdministrationPort,
  run: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const credentials: CredentialRepository = {
    async findByLogin() { return null },
    async getSessionState() {
      return {
        id: USER_ID,
        status: 'active',
        credentialStatus: 'active',
        sessionVersion: 1,
      }
    },
    async readiness() { return true },
  }
  const access: AccessRepository = {
    async findByOidc() { return null },
    async findByEmail() { return null },
    async findById(userId) {
      return userId === USER_ID
        ? {
            id: USER_ID,
            email: 'admin@example.invalid',
            status: 'active',
            maxSensitivityTier: 'K1',
            roles,
          }
        : null
    },
    async readiness() { return true },
  }
  const audit: AuditSink = {
    async record() {},
    async readiness() { return true },
  }
  const pool = { async query() { return [[{ n: 5 }], []] } } as unknown as Pool
  const server = createEnterpriseDashboardServer({
    config,
    pool,
    access,
    audit,
    verifier: null,
    credentials,
    userAdministration,
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as AddressInfo
  try {
    await run(`http://127.0.0.1:${address.port}`)
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve()),
    )
  }
}

test('admin can list users through the bounded administration port', async () => {
  let received: unknown = null
  const port = administration({
    async listUsers(input) {
      received = input
      return { users: [], limit: 25, offset: 50 }
    },
  })
  await withServer(['admin'], port, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/v1/users?limit=25&offset=50`, {
      headers: { cookie: sessionCookie() },
    })
    assert.equal(response.status, 200)
    assert.deepEqual(received, { actorUserId: USER_ID, limit: 25, offset: 50 })
    assert.deepEqual(await response.json(), { users: [], limit: 25, offset: 50 })
  })
})

test('non-admin is denied before the administration port is called', async () => {
  let called = false
  const port = administration({
    async listUsers() {
      called = true
      return { users: [], limit: 50, offset: 0 }
    },
  })
  await withServer(['user'], port, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/v1/users`, {
      headers: { cookie: sessionCookie() },
    })
    assert.equal(response.status, 403)
    assert.equal(called, false)
  })
})

test('create forwards the authenticated actor and returns no password', async () => {
  let received: { actorUserId: string; password: string } | null = null
  const port = administration({
    async createUser(input) {
      received = input
      return {
        userId: 'usr_created_test',
        role: 'user',
        action: 'USER_ACCOUNT_CREATED',
        changed: true,
        sessionVersion: 1,
        auditMode: 'hash-chained',
      }
    },
  })
  await withServer(['admin'], port, async (baseUrl) => {
    const password = 'Synthetic-Pass-42!'
    const response = await fetch(`${baseUrl}/api/v1/users/create`, {
      method: 'POST',
      headers: {
        cookie: sessionCookie(),
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        username: 'synthetic.user',
        email: 'synthetic.user@example.invalid',
        password,
        role: 'user',
      }),
    })
    assert.equal(response.status, 200)
    assert.equal(received?.actorUserId, USER_ID)
    assert.equal(received?.password, password)
    const text = await response.text()
    assert.doesNotMatch(text, /Synthetic-Pass-42/)
    assert.match(text, /USER_ACCOUNT_CREATED/)
  })
})

test('typed user input errors return only a bounded problem', async () => {
  const port = administration({
    async createUser() {
      throw inputError(USER_ADMIN_INPUT_CODES.passwordPolicy, ['TOO_SHORT'])
    },
  })
  await withServer(['admin'], port, async (baseUrl) => {
    const submitted = 'private-submitted-value'
    const response = await fetch(`${baseUrl}/api/v1/users/create`, {
      method: 'POST',
      headers: {
        cookie: sessionCookie(),
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        username: 'synthetic.user',
        email: 'synthetic.user@example.invalid',
        password: submitted,
        role: 'user',
      }),
    })
    assert.equal(response.status, 400)
    const text = await response.text()
    assert.match(text, /USER_ADMIN_PASSWORD_POLICY/)
    assert.doesNotMatch(text, new RegExp(submitted))
    assert.doesNotMatch(text, /TOO_SHORT/)
  })
})
