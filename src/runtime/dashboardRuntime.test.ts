import { test } from 'node:test'
import assert from 'node:assert/strict'
import { hkdfSync } from 'node:crypto'
import type { Pool, PoolOptions } from 'mysql2/promise'
import {
  OIDC_TRANSACTION_KEY_INFO,
  OIDC_TRANSACTION_KEY_SALT,
} from '../auth/oidcTransactionSeal.ts'
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
    cycleImports?: 'local-disk' | 'google-drive' | 'unavailable'
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
    verifyIdentity: true,
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
    verifyIdentity: true,
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
    verifyIdentity: true,
  })
})

test('the pool the dashboard boots verifies the server identity, not just the CA', () => {
  // The bootstrap contract, stated separately from the CA-source cases above:
  // whichever source supplied the certificate, the options handed to the driver
  // must carry both flags. mysql2 skips the hostname check when `verifyIdentity`
  // is absent, so a CA-only pool would accept any certificate that authority
  // issued for any host.
  for (const [env, readCaFile] of [
    [{ ...productionOidc(), DB_SSL_CA_PEM: SYNTHETIC_CA_PEM }, undefined],
    [
      { ...productionOidc(), DB_SSL_CA_FILE: '/run/secrets/db-ca.pem' },
      () => SYNTHETIC_CA_PEM,
    ],
  ] as const) {
    const { options } = boot(env as NodeJS.ProcessEnv, {
      readCaFile: readCaFile as ((filePath: string) => string) | undefined,
    })
    const ssl = options.ssl as { rejectUnauthorized: unknown; verifyIdentity: unknown }
    assert.equal(ssl.verifyIdentity, true)
    assert.equal(ssl.rejectUnauthorized, true)
  }
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

test('the explicitly disabled transport boots a pool with no ssl option', () => {
  // The accepted downgrade: production, no CA, plaintext — and reachable only
  // because the environment says so in as many words. `ssl` is absent from the
  // options rather than present holding `undefined`, so the object the driver
  // receives states the transport instead of leaving it to be inferred.
  const { options, runtime } = boot({
    ...productionOidc(),
    DB_TLS_MODE: 'disabled',
  })
  assert.equal('ssl' in options, false)
  assert.equal(options.ssl, undefined)
  assert.equal(runtime.config.database.tlsMode, 'disabled')
  // The rest of the pool is untouched by the transport decision.
  assert.equal(options.host, 'db.internal')
  assert.equal(options.connectionLimit, 2)
})

test('a verified transport still carries its ssl option', () => {
  // The other half of the assertion above: `ssl` is omitted for plaintext and
  // for nothing else.
  const { options } = boot({
    ...productionOidc(),
    DB_SSL_CA_PEM: SYNTHETIC_CA_PEM,
  })
  assert.equal('ssl' in options, true)
})

test('production without a CA and without the explicit mode is still refused', () => {
  // A missing CA never means plaintext. Only `DB_TLS_MODE` says that.
  const capture = capturingPool()
  assert.throws(
    () =>
      createDashboardRuntime({
        poolProfile: 'serverless',
        cycleImports: 'unavailable',
        env: productionOidc(),
        createPool: capture.createPool,
      }),
    /DB_SSL_CA_FILE or DB_SSL_CA_PEM is required in production/,
  )
  assert.equal(capture.options.length, 0)
})

test('a CA configured beside the disabled mode refuses before a pool exists', () => {
  for (const source of [
    { DB_SSL_CA_PEM: SYNTHETIC_CA_PEM },
    { DB_SSL_CA_FILE: '/run/secrets/db-ca.pem' },
  ]) {
    const capture = capturingPool()
    assert.throws(
      () =>
        createDashboardRuntime({
          poolProfile: 'serverless',
          cycleImports: 'unavailable',
          env: { ...productionOidc(), ...source, DB_TLS_MODE: 'disabled' },
          createPool: capture.createPool,
          readCaFile: () => SYNTHETIC_CA_PEM,
        }),
      (error: Error) => {
        assert.ok(error instanceof ConfigurationError)
        assert.match(error.message, /DB_TLS_MODE/)
        assert.equal(error.message.includes('BEGIN CERTIFICATE'), false)
        return true
      },
    )
    assert.equal(capture.options.length, 0)
  }
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

test('a serverless runtime with Google Drive constructs the import services', () => {
  const { runtime } = boot(
    {
      ...productionOidc(),
      DB_SSL_CA_PEM: SYNTHETIC_CA_PEM,
      KAUDIT_GOOGLE_DRIVE_CLIENT_ID: 'synthetic-client-id',
      KAUDIT_GOOGLE_DRIVE_CLIENT_SECRET: 'synthetic-client-secret',
      KAUDIT_GOOGLE_DRIVE_REFRESH_TOKEN: 'synthetic-refresh-token',
      KAUDIT_GOOGLE_DRIVE_SHARED_DRIVE_ID: 'shared_drive_0123456789',
      KAUDIT_GOOGLE_DRIVE_ROOT_FOLDER_ID: 'folder_0123456789',
    },
    { poolProfile: 'serverless', cycleImports: 'google-drive' },
  )
  assert.equal(runtime.capabilities.cycleImports, true)
  assert.equal(runtime.capabilities.importAnalysis, true)
})

test('Google Drive imports are all-or-nothing at runtime', () => {
  assert.throws(
    () =>
      boot(
        {
          ...productionOidc(),
          DB_SSL_CA_PEM: SYNTHETIC_CA_PEM,
          KAUDIT_GOOGLE_DRIVE_CLIENT_ID: 'synthetic-client-id',
          KAUDIT_GOOGLE_DRIVE_CLIENT_SECRET: 'synthetic-client-secret',
          KAUDIT_GOOGLE_DRIVE_REFRESH_TOKEN: 'synthetic-refresh-token',
        },
        { cycleImports: 'google-drive' },
      ),
    /Import storage is unavailable/,
  )
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

// ---------------------------------------------------------------------------
// OIDC authorization-code browser flow
// ---------------------------------------------------------------------------

/**
 * Synthetic; invented here to be searched for in the runtime's own output. It
 * is not a credential and authenticates to nothing.
 */
const SYNTHETIC_CLIENT_SECRET = 'synthetic-client-secret-not-a-credential'

function browserFlowEnv(): NodeJS.ProcessEnv {
  return {
    ...productionOidc(),
    DB_SSL_CA_PEM: SYNTHETIC_CA_PEM,
    KAUDIT_OIDC_TOKEN_COOKIE: 'kaudit_id_token',
    KAUDIT_OIDC_BROWSER_FLOW: 'true',
    KAUDIT_OIDC_CLIENT_ID: 'synthetic-client-id.apps.example.test',
    KAUDIT_OIDC_CLIENT_SECRET: SYNTHETIC_CLIENT_SECRET,
    KAUDIT_OIDC_REDIRECT_URI:
      'https://audit.example.test/api/v1/auth/oidc/callback',
  }
}

test('the browser flow is constructed only behind its dedicated gate', () => {
  // Constructing the client opens nothing: discovery is deferred to the first
  // sign-in, so no request leaves this test.
  const { runtime } = boot(browserFlowEnv())
  assert.equal(runtime.capabilities.oidcBrowserFlow, true)

  const off = browserFlowEnv()
  delete off.KAUDIT_OIDC_BROWSER_FLOW
  delete off.KAUDIT_OIDC_CLIENT_ID
  delete off.KAUDIT_OIDC_CLIENT_SECRET
  delete off.KAUDIT_OIDC_REDIRECT_URI
  assert.equal(boot(off).runtime.capabilities.oidcBrowserFlow, false)
})

test('a half-configured browser flow refuses to boot rather than half-enable', () => {
  for (const name of [
    'KAUDIT_OIDC_CLIENT_ID',
    'KAUDIT_OIDC_CLIENT_SECRET',
    'KAUDIT_OIDC_REDIRECT_URI',
    'KAUDIT_OIDC_TOKEN_COOKIE',
  ]) {
    const env = browserFlowEnv()
    delete env[name]
    assert.throws(() => boot(env), ConfigurationError, `${name} must be required`)
  }
  // And the mirror image: a client variable with the gate off.
  const stray = browserFlowEnv()
  delete stray.KAUDIT_OIDC_BROWSER_FLOW
  delete stray.KAUDIT_OIDC_CLIENT_SECRET
  delete stray.KAUDIT_OIDC_REDIRECT_URI
  assert.throws(() => boot(stray), ConfigurationError)
})

test('neither the client secret nor the transaction key is carried on the runtime', () => {
  const { runtime } = boot(browserFlowEnv())
  // The risk being guarded is that something stringifies the runtime or the
  // configuration it exposes into a log line.
  const serialized = JSON.stringify({
    config: runtime.config,
    capabilities: runtime.capabilities,
  })
  assert.equal(serialized.includes(SYNTHETIC_CLIENT_SECRET), false)
  assert.equal(serialized.includes('KAUDIT_OIDC_CLIENT_SECRET'), false)

  // The transaction envelope's HMAC key is derived from that secret inside the
  // authorization client. It must be no more reachable than the secret was:
  // not in the configuration, not on the runtime, not in a capability flag.
  const derived = Buffer.from(
    hkdfSync(
      'sha256',
      Buffer.from(SYNTHETIC_CLIENT_SECRET, 'utf8'),
      Buffer.from(OIDC_TRANSACTION_KEY_SALT, 'utf8'),
      Buffer.from(OIDC_TRANSACTION_KEY_INFO, 'utf8'),
      32,
    ),
  )
  for (const encoding of ['base64url', 'base64', 'hex'] as const) {
    assert.equal(serialized.includes(derived.toString(encoding)), false)
  }
  // And the configuration's OIDC section names only what an operator set.
  const auth = runtime.config.auth
  assert.equal(auth.mode, 'oidc')
  if (auth.mode !== 'oidc') throw new Error('synthetic config')
  assert.deepEqual(Object.keys(auth.browserFlow ?? {}).sort(), [
    'clientId',
    'redirectUri',
    'secretConfigured',
  ])
})
