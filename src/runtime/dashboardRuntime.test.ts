import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Pool, PoolOptions } from 'mysql2/promise'
import { ConfigurationError } from '../config/runtime.ts'
import { createDashboardRuntime } from './dashboardRuntime.ts'

/**
 * Bootstrap contract for the shared dashboard runtime.
 *
 * Every pool here is a stub: no MySQL socket is opened, no CA file has to exist,
 * no network call is made, and no paid model is constructed (the rule-test
 * opt-in stays off in every case below).
 */

/**
 * Synthetic; not a certificate, and never sent to anything. Written without a
 * trailing newline because the resolver trims the environment value — a blank
 * inline CA must not read as a configured one.
 */
const SYNTHETIC_CA_PEM =
  '-----BEGIN CERTIFICATE-----\nc3ludGhldGljLWNh\n-----END CERTIFICATE-----'

function base(): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'test',
    DB_HOST: 'db.internal',
    DB_NAME: 'kaudit',
    DB_USER: 'reader',
    DB_PASSWORD: 'synthetic-secret',
    KAUDIT_AUTH_MODE: 'preview',
    KAUDIT_SECURE_HOST: '127.0.0.1',
  }
}

function productionOidc(): NodeJS.ProcessEnv {
  return {
    ...base(),
    NODE_ENV: 'production',
    KAUDIT_AUTH_MODE: 'oidc',
    KAUDIT_SECURE_HOST: '0.0.0.0',
    KAUDIT_OIDC_ISSUER: 'https://identity.example.test/',
    KAUDIT_OIDC_AUDIENCE: 'kaudit-api',
    KAUDIT_OIDC_JWKS_URI:
      'https://identity.example.test/.well-known/jwks.json',
  }
}

interface Capture {
  options: PoolOptions[]
  createPool: (options: PoolOptions) => Pool
}

function capturingPool(): Capture {
  const options: PoolOptions[] = []
  return {
    options,
    createPool(received) {
      options.push(received)
      // Enough surface for the server factory, which only stores the pool.
      return {
        query: async () => [[], []],
        execute: async () => [[], []],
        end: async () => undefined,
      } as unknown as Pool
    },
  }
}

function boot(
  env: NodeJS.ProcessEnv,
  overrides: {
    poolProfile?: 'persistent' | 'serverless'
    cycleImports?: 'local-disk' | 'unavailable'
    readCaFile?: (filePath: string) => string
  } = {},
) {
  const capture = capturingPool()
  const runtime = createDashboardRuntime({
    poolProfile: overrides.poolProfile ?? 'serverless',
    cycleImports: overrides.cycleImports ?? 'unavailable',
    env,
    createPool: capture.createPool,
    readCaFile: overrides.readCaFile,
  })
  return { runtime, options: capture.options[0] as PoolOptions }
}

// ---------------------------------------------------------------------------
// MySQL CA sources
// ---------------------------------------------------------------------------

test('an inline CA PEM becomes the verified MySQL authority', () => {
  const { options } = boot({
    ...productionOidc(),
    DB_SSL_CA_PEM: SYNTHETIC_CA_PEM,
  })
  assert.deepEqual(options.ssl, {
    ca: SYNTHETIC_CA_PEM,
    rejectUnauthorized: true,
  })
})

test('a single-line inline CA PEM has its separators restored', () => {
  // Secret stores that hand back one line turn the newlines into `\` + `n`,
  // which Node's TLS parser rejects much later as an opaque handshake failure.
  const { options } = boot({
    ...productionOidc(),
    DB_SSL_CA_PEM: SYNTHETIC_CA_PEM.replaceAll('\n', '\\n'),
  })
  assert.deepEqual(options.ssl, {
    ca: SYNTHETIC_CA_PEM,
    rejectUnauthorized: true,
  })
})

test('a file CA keeps working and is read from the configured path', () => {
  const read: string[] = []
  const { options } = boot(
    { ...productionOidc(), DB_SSL_CA_FILE: '/run/secrets/db-ca.pem' },
    {
      poolProfile: 'persistent',
      cycleImports: 'local-disk',
      readCaFile: (filePath) => {
        read.push(filePath)
        return SYNTHETIC_CA_PEM
      },
    },
  )
  assert.deepEqual(read, ['/run/secrets/db-ca.pem'])
  assert.deepEqual(options.ssl, {
    ca: SYNTHETIC_CA_PEM,
    rejectUnauthorized: true,
  })
})

test('production with no CA source is refused before a pool exists', () => {
  const capture = capturingPool()
  assert.throws(
    () =>
      createDashboardRuntime({
        poolProfile: 'serverless',
        cycleImports: 'unavailable',
        env: productionOidc(),
        createPool: capture.createPool,
      }),
    ConfigurationError,
  )
  assert.equal(capture.options.length, 0)
})

test('production with both CA sources is refused before a pool exists', () => {
  const capture = capturingPool()
  assert.throws(
    () =>
      createDashboardRuntime({
        poolProfile: 'serverless',
        cycleImports: 'unavailable',
        env: {
          ...productionOidc(),
          DB_SSL_CA_FILE: '/run/secrets/db-ca.pem',
          DB_SSL_CA_PEM: SYNTHETIC_CA_PEM,
        },
        createPool: capture.createPool,
        readCaFile: () => SYNTHETIC_CA_PEM,
      }),
    /exactly one MySQL CA source/,
  )
  assert.equal(capture.options.length, 0)
})

test('a CA failure reports the variable and never any CA content', () => {
  for (const [env, readCaFile] of [
    [
      { ...productionOidc(), DB_SSL_CA_PEM: 'not-a-certificate' },
      undefined,
    ],
    [
      { ...productionOidc(), DB_SSL_CA_FILE: '/run/secrets/db-ca.pem' },
      () => {
        throw new Error(
          `ENOENT: no such file /run/secrets/db-ca.pem containing ${SYNTHETIC_CA_PEM}`,
        )
      },
    ],
  ] as const) {
    assert.throws(
      () =>
        boot(env as NodeJS.ProcessEnv, {
          readCaFile: readCaFile as ((filePath: string) => string) | undefined,
        }),
      (error: Error) => {
        assert.ok(error instanceof ConfigurationError)
        assert.match(error.message, /^DB_SSL_CA_(FILE|PEM)/)
        assert.equal(error.message.includes('BEGIN CERTIFICATE'), false)
        assert.equal(error.message.includes('c3ludGhldGljLWNh'), false)
        assert.equal(error.message.includes('not-a-certificate'), false)
        return true
      },
    )
  }
})

test('loopback development still runs with no CA source at all', () => {
  const { options } = boot(base(), { poolProfile: 'persistent' })
  assert.equal(options.ssl, undefined)
})

// ---------------------------------------------------------------------------
// Connection profiles
// ---------------------------------------------------------------------------

test('the serverless profile keeps one small, bounded pool', () => {
  const { options } = boot({
    ...productionOidc(),
    DB_SSL_CA_PEM: SYNTHETIC_CA_PEM,
  })
  // Every warm instance holds its own pool, so the per-instance ceiling is what
  // multiplies into the database's connection limit.
  assert.equal(options.connectionLimit, 2)
  assert.ok(
    typeof options.queueLimit === 'number' && options.queueLimit > 0,
    'a serverless pool must not queue callers without bound',
  )
  assert.equal(options.maxIdle, 1)
  assert.ok(
    typeof options.idleTimeout === 'number' && options.idleTimeout <= 60_000,
    'an instance that sits idle must release its connections',
  )
  // A frozen instance cannot answer keep-alive probes; the server would be left
  // holding a half-open connection.
  assert.equal(options.enableKeepAlive, false)
})

test('the persistent profile keeps its existing pool behaviour', () => {
  const { options } = boot(base(), {
    poolProfile: 'persistent',
    cycleImports: 'local-disk',
  })
  assert.equal(options.connectionLimit, 8)
  assert.equal(options.enableKeepAlive, true)
  assert.equal(options.connectTimeout, 10_000)
  assert.equal(options.decimalNumbers, false)
})

// ---------------------------------------------------------------------------
// What each runtime is allowed to do
// ---------------------------------------------------------------------------

test('a runtime without durable storage constructs no import services', () => {
  const { runtime } = boot(base(), { cycleImports: 'unavailable' })
  assert.equal(runtime.capabilities.cycleImports, false)
  // Analysis previews bytes that only the import service can accept, so it is
  // withheld too rather than spending a paid model on an unstorable file.
  assert.equal(runtime.capabilities.importAnalysis, false)
})

test('a runtime with local disk constructs the import services', () => {
  const { runtime } = boot(
    { ...base(), KAUDIT_IMPORT_ROOT: '.data/imports' },
    { poolProfile: 'persistent', cycleImports: 'local-disk' },
  )
  assert.equal(runtime.capabilities.cycleImports, true)
  assert.equal(runtime.capabilities.importAnalysis, true)
})

test('the Call Audit rule test lab stays off without its dedicated flag', () => {
  for (const env of [
    base(),
    { ...base(), OPENAI_API_KEY: 'synthetic-key' },
    { ...base(), KAUDIT_CALL_AUDIT_RULE_TEST_ENABLED: 'true' },
    {
      ...base(),
      KAUDIT_CALL_AUDIT_RULE_TEST_ENABLED: 'TRUE-ish',
      OPENAI_API_KEY: 'synthetic-key',
    },
  ]) {
    const { runtime } = boot(env)
    assert.equal(
      runtime.capabilities.callAuditRuleTest,
      false,
      'the key alone, the flag alone, and a near-miss flag must all leave it off',
    )
  }
})

test('the runtime binds no port', () => {
  const { runtime } = boot(base())
  assert.equal(runtime.server.listening, false)
  assert.equal(runtime.server.address(), null)
})
