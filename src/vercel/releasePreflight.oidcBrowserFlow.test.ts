import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  evaluateVercelReleasePreflight,
  formatPreflightReport,
  REPORTABLE_VARIABLES,
  type PreflightReport,
} from './releasePreflight.ts'
import {
  OIDC_BROWSER_FLOW_GATE,
  OIDC_BROWSER_FLOW_VARIABLES,
} from '../config/runtime.ts'
import { OIDC_CALLBACK_ROUTE } from '../auth/oidcBrowserFlow.ts'

/**
 * Preflight coverage for the OIDC browser-flow gate.
 *
 * Every environment is synthetic and the subject is a pure function over an
 * environment object: no file is read, no `.env` is loaded, and nothing is
 * sent anywhere. `SYNTHETIC_SECRET` exists to be searched for in the report.
 */

const SYNTHETIC_CA_PEM = [
  '-----BEGIN CERTIFICATE-----',
  'c3ludGhldGljLWZpeHR1cmUtbm90LWEtY2VydGlmaWNhdGU=',
  '-----END CERTIFICATE-----',
].join('\n')

const SYNTHETIC_SECRET = 'synthetic-client-secret-not-a-credential'
const NODE_INPUT = { nodeVersion: '24.3.0', engineNodeRange: '24.x' }

function productionEnv(): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'production',
    KAUDIT_AUTH_MODE: 'oidc',
    KAUDIT_TRUST_PROXY: 'true',
    DB_HOST: 'db.invalid.test',
    DB_NAME: 'kaudit',
    DB_USER: 'kaudit_web',
    DB_PASSWORD: 'synthetic-fixture-password',
    DB_SSL_CA_PEM: SYNTHETIC_CA_PEM,
    KAUDIT_OIDC_ISSUER: 'https://identity.invalid.test/',
    KAUDIT_OIDC_AUDIENCE: 'kaudit-web',
    KAUDIT_OIDC_JWKS_URI: 'https://identity.invalid.test/.well-known/jwks.json',
    KAUDIT_GOOGLE_DRIVE_CLIENT_ID: 'synthetic-drive-client-id',
    KAUDIT_GOOGLE_DRIVE_CLIENT_SECRET: 'synthetic-drive-client-secret',
    KAUDIT_GOOGLE_DRIVE_REFRESH_TOKEN: 'synthetic-drive-refresh-token',
    KAUDIT_GOOGLE_DRIVE_SHARED_DRIVE_ID: 'shared_drive_0123456789',
    KAUDIT_GAS_IMPORT_SECRET: 'synthetic-gas-import-secret-32-characters',
  }
}

function browserFlowEnv(): NodeJS.ProcessEnv {
  return {
    ...productionEnv(),
    KAUDIT_OIDC_TOKEN_COOKIE: 'kaudit_id_token',
    [OIDC_BROWSER_FLOW_GATE]: 'true',
    KAUDIT_OIDC_CLIENT_ID: 'synthetic-client-id.apps.invalid.test',
    KAUDIT_OIDC_CLIENT_SECRET: SYNTHETIC_SECRET,
    KAUDIT_OIDC_REDIRECT_URI: `https://audit.invalid.test${OIDC_CALLBACK_ROUTE}`,
  }
}

function evaluate(env: NodeJS.ProcessEnv): PreflightReport {
  return evaluateVercelReleasePreflight({ env, ...NODE_INPUT })
}

test('a token-only production candidate still passes with no browser-flow feature', () => {
  const report = evaluate(productionEnv())
  assert.deepEqual(report.findings, [])
  assert.deepEqual(report.optionalFeatures, [])
})

test('a complete browser-flow candidate passes and reports the capability', () => {
  const report = evaluate(browserFlowEnv())
  assert.deepEqual(report.findings, [])
  assert.deepEqual(report.optionalFeatures, ['oidcBrowserFlow'])
})

test('the gate on with a missing variable fails, naming only names', () => {
  for (const name of [
    ...OIDC_BROWSER_FLOW_VARIABLES,
    'KAUDIT_OIDC_TOKEN_COOKIE',
  ]) {
    const env = browserFlowEnv()
    delete env[name]
    const report = evaluate(env)
    assert.equal(report.ok, false)
    const finding = report.findings.find(
      (entry) => entry.code === 'FEATURE_CONFIG_INCOMPLETE',
    )
    assert.ok(finding, `expected an incomplete finding for ${name}`)
    assert.deepEqual(finding.variables, [name])
    assert.equal(report.optionalFeatures.includes('oidcBrowserFlow'), false)
  }
})

test('a client variable with the gate off is reported, not ignored', () => {
  for (const name of OIDC_BROWSER_FLOW_VARIABLES) {
    const report = evaluate({ ...productionEnv(), [name]: 'synthetic-value' })
    assert.equal(report.ok, false)
    const finding = report.findings.find(
      (entry) => entry.code === 'FEATURE_CONFIG_INCOMPLETE',
    )
    assert.ok(finding)
    assert.deepEqual([...finding.variables], [OIDC_BROWSER_FLOW_GATE, name])
  }
})

test('an ambiguous gate value is a flag failure, like the other gates', () => {
  const report = evaluate({ ...productionEnv(), [OIDC_BROWSER_FLOW_GATE]: '1' })
  const finding = report.findings.find(
    (entry) => entry.code === 'FEATURE_FLAG_INVALID',
  )
  assert.ok(finding)
  assert.deepEqual([...finding.variables], [OIDC_BROWSER_FLOW_GATE])
})

test('a malformed redirect URI is caught by the runtime parser, by name', () => {
  const report = evaluate({
    ...browserFlowEnv(),
    KAUDIT_OIDC_REDIRECT_URI: 'https://audit.invalid.test/wrong-route',
  })
  const finding = report.findings.find(
    (entry) => entry.code === 'RUNTIME_CONFIG_INVALID',
  )
  assert.ok(finding)
  assert.deepEqual([...finding.variables], ['KAUDIT_OIDC_REDIRECT_URI'])
})

test('every reportable name is a name, and the secret value is never one', () => {
  // The whole point of the list: a finding can name `KAUDIT_OIDC_CLIENT_SECRET`
  // and can never carry what it is set to.
  for (const name of [
    OIDC_BROWSER_FLOW_GATE,
    ...OIDC_BROWSER_FLOW_VARIABLES,
    'KAUDIT_OIDC_MAX_TOKEN_AGE_SEC',
  ]) {
    assert.ok(
      REPORTABLE_VARIABLES.includes(name),
      `${name} must be reportable by name`,
    )
  }
  const failing = browserFlowEnv()
  delete failing.KAUDIT_OIDC_CLIENT_ID
  const outputs = [
    formatPreflightReport(evaluate(failing)),
    formatPreflightReport(evaluate(browserFlowEnv())),
    JSON.stringify(evaluate(failing)),
  ]
  for (const output of outputs) {
    assert.equal(output.includes(SYNTHETIC_SECRET), false)
    assert.equal(output.includes('synthetic-client-id.apps.invalid.test'), false)
    assert.equal(output.includes('audit.invalid.test'), false)
    assert.equal(output.includes('identity.invalid.test'), false)
    assert.equal(output.includes('BEGIN CERTIFICATE'), false)
  }
})
