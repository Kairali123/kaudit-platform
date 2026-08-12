import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ConfigurationError, loadRuntimeConfig } from '../config/runtime.ts'
import { resolveDatabaseTls } from './databaseTls.ts'

/**
 * Transport contract for the central runtime MySQL TLS resolver.
 *
 * It is not the only place a mysql2 TLS object is built: several operator CLIs
 * still assemble one inline, and their own contracts guard those. What is
 * settled here is the posture the resolver produces for the callers that do go
 * through it.
 *
 * Nothing here opens a socket, reads a file from disk, or touches a real
 * certificate: the CA below is synthetic and the file reader is a stub.
 */

/**
 * Synthetic; not a certificate, and never sent to anything.
 */
const SYNTHETIC_CA_PEM =
  '-----BEGIN CERTIFICATE-----\nc3ludGhldGljLWNh\n-----END CERTIFICATE-----'

function productionEnv(): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'production',
    DB_HOST: 'db.internal',
    DB_NAME: 'kaudit',
    DB_USER: 'reader',
    DB_PASSWORD: 'synthetic-secret',
    KAUDIT_AUTH_MODE: 'oidc',
    KAUDIT_SECURE_HOST: '0.0.0.0',
    KAUDIT_OIDC_ISSUER: 'https://identity.example.test/',
    KAUDIT_OIDC_AUDIENCE: 'kaudit-api',
    KAUDIT_OIDC_JWKS_URI: 'https://identity.example.test/.well-known/jwks.json',
  }
}

function resolve(
  env: NodeJS.ProcessEnv,
  readCaFile: (filePath: string) => string = () => SYNTHETIC_CA_PEM,
) {
  return resolveDatabaseTls(loadRuntimeConfig(env), env, readCaFile)
}

/**
 * Each case is one CA source, and both must produce the same posture. The
 * hostname check is the point: mysql2 installs a `checkServerIdentity` that
 * returns `undefined` unless `verifyIdentity` is set, so a resolution carrying
 * only `rejectUnauthorized` would accept any host presenting any certificate
 * the configured authority ever issued.
 */
const CA_SOURCES = [
  {
    name: 'an inline CA PEM',
    env: { DB_SSL_CA_PEM: SYNTHETIC_CA_PEM },
  },
  {
    name: 'a CA file',
    env: { DB_SSL_CA_FILE: '/run/secrets/db-ca.pem' },
  },
] as const

for (const source of CA_SOURCES) {
  test(`${source.name} resolves to a CA that is verified and an identity that is checked`, () => {
    const options = resolve({ ...productionEnv(), ...source.env })
    assert.deepEqual(options, {
      ca: SYNTHETIC_CA_PEM,
      rejectUnauthorized: true,
      verifyIdentity: true,
    })
    // Exactly `true`, not merely truthy: mysql2 branches on the value itself.
    assert.equal(options?.verifyIdentity, true)
    assert.equal(options?.rejectUnauthorized, true)
  })

  test(`${source.name} cannot have its identity check configured off`, () => {
    // No environment variable, and no shape of one, is read as consent to skip
    // the hostname check. These names are invented here precisely because none
    // of them may ever mean anything.
    for (const off of [
      { DB_SSL_VERIFY_IDENTITY: 'false' },
      { DB_SSL_VERIFY_IDENTITY: '0' },
      { DB_SSL_REJECT_UNAUTHORIZED: 'false' },
      { DB_SSL_INSECURE: 'true' },
      { MYSQL_SSL_VERIFY_IDENTITY: 'false' },
      { NODE_TLS_REJECT_UNAUTHORIZED: '0' },
    ]) {
      const options = resolve({ ...productionEnv(), ...source.env, ...off })
      assert.equal(
        options?.verifyIdentity,
        true,
        'no variable may weaken the hostname check',
      )
      assert.equal(options?.rejectUnauthorized, true)
    }
  })
}

test('loopback development with no CA source still resolves to no TLS options', () => {
  const env = productionEnv()
  const development: NodeJS.ProcessEnv = {
    ...env,
    NODE_ENV: 'development',
    KAUDIT_AUTH_MODE: 'preview',
    KAUDIT_SECURE_HOST: '127.0.0.1',
  }
  assert.equal(resolve(development), undefined)
})

// ---------------------------------------------------------------------------
// DB_TLS_MODE — the transport, as a stated decision
// ---------------------------------------------------------------------------

/**
 * The downgrade is deliberate: production connects to the same MySQL instance
 * the CRM does, over the transport that instance actually offers. What is under
 * guard below is not that plaintext is safe — it is that plaintext is only ever
 * reached by an operator writing the word, never by an omission.
 */

test('an unset mode is the required mode, so today’s environments are unchanged', () => {
  const env = { ...productionEnv(), DB_SSL_CA_PEM: SYNTHETIC_CA_PEM }
  assert.equal(loadRuntimeConfig(env).database.tlsMode, 'required')
  assert.deepEqual(resolve(env), {
    ca: SYNTHETIC_CA_PEM,
    rejectUnauthorized: true,
    verifyIdentity: true,
  })
})

test('the required mode, stated explicitly, resolves exactly as before', () => {
  for (const source of CA_SOURCES) {
    const options = resolve({
      ...productionEnv(),
      ...source.env,
      DB_TLS_MODE: 'required',
    })
    assert.deepEqual(options, {
      ca: SYNTHETIC_CA_PEM,
      rejectUnauthorized: true,
      verifyIdentity: true,
    })
  }
})

test('the required mode still refuses a production runtime with no CA', () => {
  assert.throws(
    () => resolve({ ...productionEnv(), DB_TLS_MODE: 'required' }),
    (error: Error) => {
      assert.ok(error instanceof ConfigurationError)
      assert.match(error.message, /DB_SSL_CA_FILE/)
      assert.match(error.message, /DB_SSL_CA_PEM/)
      return true
    },
  )
})

test('the disabled mode resolves to no mysql2 ssl option at all', () => {
  // Not an empty object and not a partial one: either would still start a
  // handshake. The absence is the mode.
  const options = resolve({ ...productionEnv(), DB_TLS_MODE: 'disabled' })
  assert.equal(options, undefined)
  assert.equal(
    loadRuntimeConfig({ ...productionEnv(), DB_TLS_MODE: 'disabled' }).database
      .tlsMode,
    'disabled',
  )
})

test('the disabled mode is accepted whatever the case of the word', () => {
  for (const written of ['disabled', 'Disabled', 'DISABLED', ' disabled ']) {
    assert.equal(
      resolve({ ...productionEnv(), DB_TLS_MODE: written }),
      undefined,
    )
  }
})

test('a configured CA is refused in the disabled mode, never ignored', () => {
  // An operator who supplied trust material believes it is in force. A
  // plaintext connection that silently discards it is exactly the gap between
  // what a settings page shows and what the socket does.
  for (const source of CA_SOURCES) {
    assert.throws(
      () =>
        resolve({
          ...productionEnv(),
          ...source.env,
          DB_TLS_MODE: 'disabled',
        }),
      (error: Error) => {
        assert.ok(error instanceof ConfigurationError)
        assert.match(error.message, /DB_TLS_MODE/)
        assert.match(error.message, /DB_SSL_CA_(FILE|PEM)/)
        // The refusal names the variable and never any part of its value.
        assert.equal(error.message.includes('BEGIN CERTIFICATE'), false)
        assert.equal(error.message.includes('c3ludGhldGljLWNh'), false)
        assert.equal(error.message.includes('/run/secrets/db-ca.pem'), false)
        return true
      },
    )
  }
})

test('the resolver refuses a hand-assembled disabled config carrying a CA', () => {
  // `loadRuntimeConfig` already rejects this pairing. Re-asserted at the
  // resolver because it is what actually decides the transport, and a caller
  // that builds a config by hand must not be able to reach past that.
  const config = loadRuntimeConfig({
    ...productionEnv(),
    DB_SSL_CA_PEM: SYNTHETIC_CA_PEM,
  })
  const smuggled = {
    ...config,
    database: { ...config.database, tlsMode: 'disabled' as const },
  }
  assert.throws(
    () => resolveDatabaseTls(smuggled, { DB_SSL_CA_PEM: SYNTHETIC_CA_PEM }),
    ConfigurationError,
  )
})

test('an unrecognised mode is refused rather than resolved either way', () => {
  // Every one of these was written by someone who meant plaintext. None of them
  // gets it, and none of them silently gets TLS either.
  for (const written of ['off', 'false', '0', 'none', 'disable', 'prefer', 'no']) {
    assert.throws(
      () =>
        resolve({
          ...productionEnv(),
          DB_SSL_CA_PEM: SYNTHETIC_CA_PEM,
          DB_TLS_MODE: written,
        }),
      (error: Error) => {
        assert.ok(error instanceof ConfigurationError)
        assert.match(error.message, /DB_TLS_MODE must be required or disabled/)
        return true
      },
      `${written} must not be read as a transport`,
    )
  }
})

test('a blank mode falls back to the closed default, not to plaintext', () => {
  for (const blank of ['', '   ', '\t']) {
    const env = {
      ...productionEnv(),
      DB_SSL_CA_PEM: SYNTHETIC_CA_PEM,
      DB_TLS_MODE: blank,
    }
    assert.equal(loadRuntimeConfig(env).database.tlsMode, 'required')
    assert.equal(resolve(env)?.verifyIdentity, true)
  }
  // And a blank mode with no CA is still a production refusal.
  assert.throws(
    () => resolve({ ...productionEnv(), DB_TLS_MODE: '  ' }),
    ConfigurationError,
  )
})
