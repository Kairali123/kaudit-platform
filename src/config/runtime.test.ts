import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ConfigurationError, loadRuntimeConfig } from './runtime.ts'

function base(): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'test',
    DB_HOST: 'db.internal',
    DB_NAME: 'kaudit',
    DB_USER: 'reader',
    DB_PASSWORD: 'synthetic-secret',
    KAUDIT_AUTH_MODE: 'local',
    KAUDIT_DEV_USER_EMAIL: 'operator@example.test',
    KAUDIT_LOCAL_PASSWORD_HASH:
      'scrypt$c3ludGhldGljLXNhbHQ$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    KAUDIT_LOCAL_SESSION_SECRET:
      'synthetic-session-secret-at-least-32-characters',
    KAUDIT_SECURE_HOST: '127.0.0.1',
  }
}

test('accepts loopback-only local authentication outside production', () => {
  const config = loadRuntimeConfig(base())
  assert.equal(config.auth.mode, 'local')
  assert.equal(config.host, '127.0.0.1')
  assert.equal(config.database.password, 'synthetic-secret')
  assert.equal(
    config.auth.mode === 'local'
      ? config.auth.sessionTtlSeconds
      : null,
    28_800,
  )
})

test('accepts explicit loopback-only preview without OIDC or a user email', () => {
  const env = base()
  delete env.KAUDIT_DEV_USER_EMAIL
  env.KAUDIT_AUTH_MODE = 'preview'
  const config = loadRuntimeConfig(env)
  assert.equal(config.auth.mode, 'preview')
  assert.equal(config.host, '127.0.0.1')
})

test('rejects local authentication in production', () => {
  assert.throws(
    () =>
      loadRuntimeConfig({
        ...base(),
        NODE_ENV: 'production',
        DB_SSL_CA_FILE: '/run/secrets/db-ca.pem',
      }),
    ConfigurationError,
  )
})

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

/** Synthetic; not a certificate, and never sent to anything. */
const SYNTHETIC_CA_PEM =
  '-----BEGIN CERTIFICATE-----\nc3ludGhldGljLWNh\n-----END CERTIFICATE-----\n'

test('requires database TLS CA and OIDC in production', () => {
  const env = productionOidc()
  assert.throws(() => loadRuntimeConfig(env), /DB_SSL_CA_FILE/)
  const config = loadRuntimeConfig({
    ...env,
    DB_SSL_CA_FILE: '/run/secrets/db-ca.pem',
  })
  assert.equal(config.auth.mode, 'oidc')
  assert.equal(config.database.sslCaFile, '/run/secrets/db-ca.pem')
  assert.equal(config.database.sslCaInline, false)
})

test('accepts an inline CA PEM as the production TLS source', () => {
  const config = loadRuntimeConfig({
    ...productionOidc(),
    DB_SSL_CA_PEM: SYNTHETIC_CA_PEM,
  })
  assert.equal(config.database.sslCaInline, true)
  assert.equal(config.database.sslCaFile, null)
})

test('configuration carries the fact of an inline CA, never its content', () => {
  const config = loadRuntimeConfig({
    ...productionOidc(),
    DB_SSL_CA_PEM: SYNTHETIC_CA_PEM,
  })
  // The whole config is serialized because the risk being guarded is exactly
  // that: something stringifies it into a log line.
  const serialized = JSON.stringify(config)
  assert.equal(serialized.includes('BEGIN CERTIFICATE'), false)
  assert.equal(serialized.includes('c3ludGhldGljLWNh'), false)
})

test('names both CA sources when production has neither', () => {
  assert.throws(
    () => loadRuntimeConfig(productionOidc()),
    (error: Error) => {
      assert.ok(error instanceof ConfigurationError)
      assert.match(error.message, /DB_SSL_CA_FILE/)
      assert.match(error.message, /DB_SSL_CA_PEM/)
      return true
    },
  )
})

test('rejects a file CA and an inline CA configured at the same time', () => {
  for (const environment of ['production', 'development']) {
    assert.throws(
      () =>
        loadRuntimeConfig({
          ...(environment === 'production' ? productionOidc() : base()),
          NODE_ENV: environment,
          DB_SSL_CA_FILE: '/run/secrets/db-ca.pem',
          DB_SSL_CA_PEM: SYNTHETIC_CA_PEM,
        }),
      /exactly one MySQL CA source/,
      `ambiguous CA sources must be rejected in ${environment}`,
    )
  }
})

test('a blank inline CA is not a CA source', () => {
  // Otherwise an unset secret rendered as an empty string would satisfy the
  // production requirement and the connection would end up with no authority.
  assert.throws(
    () => loadRuntimeConfig({ ...productionOidc(), DB_SSL_CA_PEM: '   ' }),
    /required in production/,
  )
})

test('rejects weak or unapproved OIDC algorithms', () => {
  const env = {
    ...base(),
    KAUDIT_AUTH_MODE: 'oidc',
    KAUDIT_OIDC_ISSUER: 'https://identity.example.test',
    KAUDIT_OIDC_AUDIENCE: 'kaudit-api',
    KAUDIT_OIDC_JWKS_URI: 'https://identity.example.test/jwks',
    KAUDIT_OIDC_ALGORITHMS: 'RS256,none',
  }
  assert.throws(() => loadRuntimeConfig(env), /unapproved algorithm/)
})

test('validates an optional browser login URL as HTTPS', () => {
  const oidc = {
    ...base(),
    KAUDIT_AUTH_MODE: 'oidc',
    KAUDIT_OIDC_ISSUER: 'https://identity.example.test',
    KAUDIT_OIDC_AUDIENCE: 'kaudit-api',
    KAUDIT_OIDC_JWKS_URI: 'https://identity.example.test/jwks',
  }
  assert.throws(
    () =>
      loadRuntimeConfig({
        ...oidc,
        KAUDIT_OIDC_LOGIN_URL: 'http://identity.example.test/login',
      }),
    /KAUDIT_OIDC_LOGIN_URL must be an HTTPS URL/,
  )
  const config = loadRuntimeConfig({
    ...oidc,
    KAUDIT_OIDC_LOGIN_URL: 'https://identity.example.test/login',
  })
  assert.equal(
    config.auth.mode === 'oidc'
      ? config.auth.loginUrl
      : null,
    'https://identity.example.test/login',
  )
})

test('validates an optional browser logout URL as HTTPS', () => {
  const oidc = {
    ...base(),
    KAUDIT_AUTH_MODE: 'oidc',
    KAUDIT_OIDC_ISSUER: 'https://identity.example.test',
    KAUDIT_OIDC_AUDIENCE: 'kaudit-api',
    KAUDIT_OIDC_JWKS_URI: 'https://identity.example.test/jwks',
  }
  assert.throws(
    () =>
      loadRuntimeConfig({
        ...oidc,
        KAUDIT_OIDC_LOGOUT_URL:
          'http://identity.example.test/logout',
      }),
    /KAUDIT_OIDC_LOGOUT_URL must be an HTTPS URL/,
  )
  const config = loadRuntimeConfig({
    ...oidc,
    KAUDIT_OIDC_LOGOUT_URL:
      'https://identity.example.test/logout',
  })
  assert.equal(
    config.auth.mode === 'oidc'
      ? config.auth.logoutUrl
      : null,
    'https://identity.example.test/logout',
  )
})

test('legacy K2/K3 environment switches no longer affect runtime authority', () => {
  const config = loadRuntimeConfig({
    ...base(),
    KAUDIT_K23_AUTOMATION_ENABLED: 'true',
    KAUDIT_K23_CLINICAL_SAFETY_OWNER: 'synthetic-owner',
  })
  assert.equal(config.releaseGates.calibrationComplete, false)
  assert.equal(
    config.releaseGates.automatedValidationApproved,
    false,
  )
  assert.deepEqual(Object.keys(config.releaseGates).sort(), [
    'automatedValidationApproved',
    'calibrationComplete',
    'reportingApproved',
  ])
})
