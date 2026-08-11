import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ConfigurationError,
  loadRuntimeConfig,
  OIDC_BROWSER_FLOW_GATE,
  OIDC_BROWSER_FLOW_VARIABLES,
} from './runtime.ts'
import { OIDC_CALLBACK_ROUTE } from '../auth/oidcBrowserFlow.ts'

/**
 * The gate that decides whether this deployment runs the browser flow.
 *
 * Values are synthetic. `KAUDIT_OIDC_CLIENT_SECRET` below is a fixed invented
 * string used to prove it never reaches the loaded configuration; it is not a
 * credential and no `.env` file is read by any of these tests.
 */

const SYNTHETIC_SECRET = 'synthetic-client-secret-not-a-credential'
const REDIRECT_URI = `https://audit.example.test${OIDC_CALLBACK_ROUTE}`

function oidcEnv(): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'test',
    DB_HOST: 'db.internal',
    DB_NAME: 'kaudit',
    DB_USER: 'reader',
    DB_PASSWORD: 'synthetic-secret',
    KAUDIT_AUTH_MODE: 'oidc',
    KAUDIT_SECURE_HOST: '127.0.0.1',
    KAUDIT_OIDC_ISSUER: 'https://identity.example.test',
    KAUDIT_OIDC_AUDIENCE: 'synthetic-client-id.apps.example.test',
    KAUDIT_OIDC_JWKS_URI: 'https://identity.example.test/jwks',
    KAUDIT_OIDC_TOKEN_COOKIE: 'kaudit_id_token',
  }
}

function enabledEnv(): NodeJS.ProcessEnv {
  return {
    ...oidcEnv(),
    [OIDC_BROWSER_FLOW_GATE]: 'true',
    KAUDIT_OIDC_CLIENT_ID: 'synthetic-client-id.apps.example.test',
    KAUDIT_OIDC_CLIENT_SECRET: SYNTHETIC_SECRET,
    KAUDIT_OIDC_REDIRECT_URI: REDIRECT_URI,
  }
}

function browserFlowOf(env: NodeJS.ProcessEnv) {
  const auth = loadRuntimeConfig(env).auth
  return auth.mode === 'oidc' ? auth.browserFlow : null
}

test('the existing token-only OIDC deployment is unchanged', () => {
  const auth = loadRuntimeConfig(oidcEnv()).auth
  assert.equal(auth.mode, 'oidc')
  assert.equal(auth.mode === 'oidc' ? auth.browserFlow : 'wrong-mode', null)
  // The accepted 15-minute freshness ceiling still applies where nothing changed.
  assert.equal(auth.mode === 'oidc' ? auth.maxTokenAgeSeconds : 0, 900)
})

test('the gate alone enables the flow, with all three variables', () => {
  const browserFlow = browserFlowOf(enabledEnv())
  assert.equal(browserFlow?.clientId, 'synthetic-client-id.apps.example.test')
  assert.equal(browserFlow?.redirectUri, `${REDIRECT_URI}`)
  assert.equal(browserFlow?.secretConfigured, true)
})

test('a client variable without the gate is rejected, not silently ignored', () => {
  for (const name of OIDC_BROWSER_FLOW_VARIABLES) {
    // One stray variable pasted into a project's settings must not arm a
    // browser-facing login, and must not be quietly discarded either.
    assert.throws(
      () => loadRuntimeConfig({ ...oidcEnv(), [name]: 'synthetic-value' }),
      (error: Error) => {
        assert.ok(error instanceof ConfigurationError)
        assert.match(error.message, new RegExp(name))
        assert.match(error.message, new RegExp(OIDC_BROWSER_FLOW_GATE))
        return true
      },
      `${name} must not be accepted with the gate off`,
    )
  }
  // Explicitly false behaves exactly like absent.
  assert.equal(
    browserFlowOf({ ...oidcEnv(), [OIDC_BROWSER_FLOW_GATE]: 'false' }),
    null,
  )
})

test('the gate on with an incomplete client names what is missing', () => {
  for (const name of OIDC_BROWSER_FLOW_VARIABLES) {
    const env = enabledEnv()
    delete env[name]
    assert.throws(
      () => loadRuntimeConfig(env),
      (error: Error) => {
        assert.match(error.message, new RegExp(name))
        return true
      },
      `${name} must be required when the gate is on`,
    )
  }
})

test('an ambiguous gate value is rejected rather than read as off', () => {
  for (const value of ['yes', '1', 'TRUE ', 'enabled']) {
    if (value.trim().toLowerCase() === 'true') continue
    assert.throws(
      () => loadRuntimeConfig({ ...oidcEnv(), [OIDC_BROWSER_FLOW_GATE]: value }),
      /must be true or false/,
    )
  }
  // Whitespace and case around the real word are still the real word.
  assert.ok(
    browserFlowOf({ ...enabledEnv(), [OIDC_BROWSER_FLOW_GATE]: ' True ' }),
  )
})

test('the redirect URI must be this application HTTPS callback route', () => {
  for (const redirectUri of [
    `http://audit.example.test${OIDC_CALLBACK_ROUTE}`,
    'https://audit.example.test/api/v1/auth/oidc/return',
    'https://audit.example.test/',
    `https://audit.example.test${OIDC_CALLBACK_ROUTE}?next=/admin`,
    `https://user:pass@audit.example.test${OIDC_CALLBACK_ROUTE}`,
    'not-a-url',
  ]) {
    assert.throws(
      () =>
        loadRuntimeConfig({
          ...enabledEnv(),
          KAUDIT_OIDC_REDIRECT_URI: redirectUri,
        }),
      /KAUDIT_OIDC_REDIRECT_URI/,
      `${redirectUri} must be refused`,
    )
  }
})

test('the flow requires a token cookie to put the validated token in', () => {
  const env = enabledEnv()
  delete env.KAUDIT_OIDC_TOKEN_COOKIE
  assert.throws(() => loadRuntimeConfig(env), /KAUDIT_OIDC_TOKEN_COOKIE/)
})

test('two login entry points is rejected as ambiguous', () => {
  assert.throws(
    () =>
      loadRuntimeConfig({
        ...enabledEnv(),
        KAUDIT_OIDC_LOGIN_URL: 'https://identity.example.test/start',
      }),
    /KAUDIT_OIDC_LOGIN_URL cannot be combined/,
  )
})

test('the flow is refused outside OIDC mode', () => {
  assert.throws(
    () =>
      loadRuntimeConfig({
        ...enabledEnv(),
        KAUDIT_AUTH_MODE: 'preview',
      }),
    /requires KAUDIT_AUTH_MODE=oidc/,
  )
})

test('the client secret never reaches the loaded configuration', () => {
  // The whole object is serialized because the risk being guarded is exactly
  // that: something stringifies it into a log line.
  const serialized = JSON.stringify(loadRuntimeConfig(enabledEnv()))
  assert.equal(serialized.includes(SYNTHETIC_SECRET), false)
  assert.equal(serialized.includes('clientSecret'), false)
  assert.equal(serialized.includes('KAUDIT_OIDC_CLIENT_SECRET'), false)
  // The fact of it is recorded; the value is not.
  assert.match(serialized, /"secretConfigured":true/)
})

// ---------------------------------------------------------------------------
// Token freshness policy
// ---------------------------------------------------------------------------

test('the freshness ceiling defaults to one hour only when the flow is on', () => {
  const withFlow = loadRuntimeConfig(enabledEnv()).auth
  assert.equal(withFlow.mode === 'oidc' ? withFlow.maxTokenAgeSeconds : 0, 3600)
  const tokenOnly = loadRuntimeConfig(oidcEnv()).auth
  assert.equal(tokenOnly.mode === 'oidc' ? tokenOnly.maxTokenAgeSeconds : 0, 900)
})

test('an explicit freshness ceiling wins, within bounds', () => {
  const explicit = loadRuntimeConfig({
    ...enabledEnv(),
    KAUDIT_OIDC_MAX_TOKEN_AGE_SEC: '600',
  }).auth
  assert.equal(explicit.mode === 'oidc' ? explicit.maxTokenAgeSeconds : 0, 600)
  // Bounded in both directions: never unbounded, never effectively disabled.
  for (const value of ['0', '30', '3601', '86400', '-1', 'never', '900.5']) {
    assert.throws(
      () =>
        loadRuntimeConfig({
          ...enabledEnv(),
          KAUDIT_OIDC_MAX_TOKEN_AGE_SEC: value,
        }),
      /KAUDIT_OIDC_MAX_TOKEN_AGE_SEC must be an integer from 60 to 3600/,
      `${value} must be refused`,
    )
  }
})
