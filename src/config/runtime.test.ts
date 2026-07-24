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
    KAUDIT_SECURE_HOST: '127.0.0.1',
  }
}

test('accepts loopback-only local authentication outside production', () => {
  const config = loadRuntimeConfig(base())
  assert.equal(config.auth.mode, 'local')
  assert.equal(config.host, '127.0.0.1')
  assert.equal(config.database.password, 'synthetic-secret')
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

test('requires database TLS CA and OIDC in production', () => {
  const env = {
    ...base(),
    NODE_ENV: 'production',
    KAUDIT_AUTH_MODE: 'oidc',
    KAUDIT_SECURE_HOST: '0.0.0.0',
    KAUDIT_OIDC_ISSUER: 'https://identity.example.test/',
    KAUDIT_OIDC_AUDIENCE: 'kaudit-api',
    KAUDIT_OIDC_JWKS_URI:
      'https://identity.example.test/.well-known/jwks.json',
  }
  assert.throws(() => loadRuntimeConfig(env), /DB_SSL_CA_FILE/)
  const config = loadRuntimeConfig({
    ...env,
    DB_SSL_CA_FILE: '/run/secrets/db-ca.pem',
  })
  assert.equal(config.auth.mode, 'oidc')
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

test('K2/K3 automation fails closed without completed calibration and named owner', () => {
  const env = {
    ...base(),
    KAUDIT_K23_AUTOMATION_ENABLED: 'true',
  }
  assert.throws(
    () => loadRuntimeConfig(env),
    /K2\/K3 automation requires completed calibration/,
  )
})

test('K2/K3 automation can only enable with calibration and named owner', () => {
  const config = loadRuntimeConfig({
    ...base(),
    KAUDIT_K23_AUTOMATION_ENABLED: 'true',
    KAUDIT_CALIBRATION_COMPLETE: 'true',
    KAUDIT_K23_CLINICAL_SAFETY_OWNER: 'synthetic-owner',
  })
  assert.equal(config.releaseGates.k23AutomationEnabled, true)
  assert.equal(
    config.releaseGates.clinicalSafetyOwner,
    'synthetic-owner',
  )
})
