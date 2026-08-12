import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  evaluateVercelReleasePreflight,
  formatPreflightReport,
  PREFLIGHT_CHECKS,
  REPORTABLE_VARIABLES,
  type PreflightErrorCode,
  type PreflightReport,
  type VercelPreflightInput,
} from './releasePreflight.ts'

/**
 * Every environment below is synthetic. Nothing here is a real host, issuer,
 * credential, certificate, or key, and nothing is sent anywhere: the subject is
 * a pure function over an environment object.
 */

/** Synthetic; not a certificate, and never handed to a TLS stack. */
const SYNTHETIC_CA_PEM = [
  '-----BEGIN CERTIFICATE-----',
  'c3ludGhldGljLWZpeHR1cmUtbm90LWEtY2VydGlmaWNhdGU=',
  '-----END CERTIFICATE-----',
].join('\n')

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
  }
}

function evaluate(
  env: NodeJS.ProcessEnv,
  overrides: Partial<VercelPreflightInput> = {},
): PreflightReport {
  return evaluateVercelReleasePreflight({ env, ...NODE_INPUT, ...overrides })
}

function codes(report: PreflightReport): PreflightErrorCode[] {
  return report.findings.map((finding) => finding.code)
}

function variablesFor(
  report: PreflightReport,
  code: PreflightErrorCode,
): readonly string[] {
  const finding = report.findings.find((entry) => entry.code === code)
  assert.ok(finding, `expected a ${code} finding`)
  return finding.variables
}

// ---------------------------------------------------------------------------
// Success
// ---------------------------------------------------------------------------

test('a complete production candidate passes with no findings', () => {
  const report = evaluate(productionEnv())
  assert.deepEqual(report.findings, [])
  assert.equal(report.ok, true)
  assert.equal(report.checks, PREFLIGHT_CHECKS.length)
  assert.deepEqual(report.optionalFeatures, [])
})

test('a database-auth production candidate passes without OIDC settings', () => {
  const env = productionEnv()
  env.KAUDIT_AUTH_MODE = 'database'
  env.KAUDIT_DATABASE_SESSION_SECRET =
    'synthetic-database-session-secret-at-least-32-characters'
  delete env.KAUDIT_OIDC_ISSUER
  delete env.KAUDIT_OIDC_AUDIENCE
  delete env.KAUDIT_OIDC_JWKS_URI
  const report = evaluate(env)
  assert.equal(report.ok, true)
  assert.deepEqual(report.findings, [])
})

test('database auth may retain dormant OIDC settings for one-variable rollback', () => {
  const env = productionEnv()
  env.KAUDIT_AUTH_MODE = 'database'
  env.KAUDIT_DATABASE_SESSION_SECRET =
    'synthetic-database-session-secret-at-least-32-characters'
  env.KAUDIT_OIDC_BROWSER_FLOW = 'true'
  env.KAUDIT_OIDC_CLIENT_ID = 'dormant-client'
  env.KAUDIT_OIDC_CLIENT_SECRET = 'dormant-secret'
  env.KAUDIT_OIDC_REDIRECT_URI =
    'https://audit.example.test/api/v1/auth/oidc/callback'
  assert.equal(evaluate(env).ok, true)
})

test('success output is a small fixed JSON object', () => {
  assert.equal(
    formatPreflightReport(evaluate(productionEnv())),
    '{"preflight":"vercel-release","result":"pass","checks":13,"optionalFeatures":[]}',
  )
})

test('the same environment produces byte-identical output twice', () => {
  const first = formatPreflightReport(evaluate(productionEnv()))
  const second = formatPreflightReport(evaluate(productionEnv()))
  assert.equal(first, second)
})

test('optional variables the runtime treats as optional are not required', () => {
  const env = productionEnv()
  delete env.KAUDIT_OIDC_LOGIN_URL
  delete env.KAUDIT_OIDC_LOGOUT_URL
  delete env.KAUDIT_OIDC_TOKEN_COOKIE
  delete env.DB_PORT
  assert.equal(evaluate(env).ok, true)
})

// ---------------------------------------------------------------------------
// Node runtime contract
// ---------------------------------------------------------------------------

test('a Node major other than the engine contract fails', () => {
  const report = evaluate(productionEnv(), { nodeVersion: '22.14.0' })
  assert.deepEqual(codes(report), ['NODE_RUNTIME_UNSUPPORTED'])
  assert.deepEqual(variablesFor(report, 'NODE_RUNTIME_UNSUPPORTED'), [])
})

test('the matching Node major passes whatever the minor and patch are', () => {
  assert.equal(evaluate(productionEnv(), { nodeVersion: '24.0.0' }).ok, true)
  assert.equal(evaluate(productionEnv(), { nodeVersion: 'v24.99.1' }).ok, true)
})

test('a >= engine range accepts a newer major', () => {
  assert.equal(
    evaluate(productionEnv(), {
      engineNodeRange: '>=24',
      nodeVersion: '26.0.0',
    }).ok,
    true,
  )
  assert.deepEqual(
    codes(
      evaluate(productionEnv(), {
        engineNodeRange: '>=24',
        nodeVersion: '22.0.0',
      }),
    ),
    ['NODE_RUNTIME_UNSUPPORTED'],
  )
})

test('an unreadable engine contract is reported, not guessed at', () => {
  assert.deepEqual(codes(evaluate(productionEnv(), { engineNodeRange: '' })), [
    'NODE_ENGINE_CONTRACT_UNREADABLE',
  ])
})

test('an unparseable running version is reported', () => {
  assert.deepEqual(codes(evaluate(productionEnv(), { nodeVersion: 'unknown' })), [
    'NODE_RUNTIME_UNSUPPORTED',
  ])
})

test('the engine contract in package.json is the one the preflight uses', () => {
  const manifest = JSON.parse(
    readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
  ) as { engines?: { node?: string } }
  const engineNodeRange = manifest.engines?.node ?? ''
  assert.equal(evaluate(productionEnv(), { engineNodeRange }).ok, true)
})

// ---------------------------------------------------------------------------
// Runtime mode
// ---------------------------------------------------------------------------

test('a non-production NODE_ENV fails', () => {
  for (const value of ['development', 'test']) {
    const report = evaluate({ ...productionEnv(), NODE_ENV: value })
    assert.ok(codes(report).includes('NODE_ENV_NOT_PRODUCTION'))
    assert.deepEqual(variablesFor(report, 'NODE_ENV_NOT_PRODUCTION'), ['NODE_ENV'])
  }
})

test('an absent NODE_ENV fails rather than defaulting', () => {
  const env = productionEnv()
  delete env.NODE_ENV
  assert.ok(codes(evaluate(env)).includes('NODE_ENV_NOT_PRODUCTION'))
})

test('the proxy hop must be trusted, so the audit records the caller', () => {
  for (const env of [
    { ...productionEnv(), KAUDIT_TRUST_PROXY: 'false' },
    (() => {
      const missing = productionEnv()
      delete missing.KAUDIT_TRUST_PROXY
      return missing
    })(),
  ]) {
    const report = evaluate(env)
    assert.deepEqual(codes(report), ['TRUST_PROXY_NOT_ENABLED'])
    assert.deepEqual(variablesFor(report, 'TRUST_PROXY_NOT_ENABLED'), [
      'KAUDIT_TRUST_PROXY',
    ])
  }
})

// ---------------------------------------------------------------------------
// Database settings
// ---------------------------------------------------------------------------

test('missing database variables are named, all of them at once', () => {
  const env = productionEnv()
  delete env.DB_HOST
  delete env.DB_USER
  const report = evaluate(env)
  assert.deepEqual(variablesFor(report, 'REQUIRED_VARIABLE_MISSING'), [
    'DB_HOST',
    'DB_USER',
  ])
})

test('a blank database variable counts as missing', () => {
  const report = evaluate({ ...productionEnv(), DB_PASSWORD: '   ' })
  assert.deepEqual(variablesFor(report, 'REQUIRED_VARIABLE_MISSING'), [
    'DB_PASSWORD',
  ])
})

test('an out-of-range DB_PORT is caught by the accepted parser', () => {
  const report = evaluate({ ...productionEnv(), DB_PORT: '70000' })
  assert.deepEqual(variablesFor(report, 'RUNTIME_CONFIG_INVALID'), ['DB_PORT'])
})

// ---------------------------------------------------------------------------
// Exactly one CA source
// ---------------------------------------------------------------------------

test('an inline CA alone passes', () => {
  assert.equal(evaluate(productionEnv()).ok, true)
})

test('a mounted CA path alone passes', () => {
  const env = productionEnv()
  delete env.DB_SSL_CA_PEM
  env.DB_SSL_CA_FILE = '/run/secrets/db-ca.pem'
  assert.equal(evaluate(env).ok, true)
})

test('both CA sources at once fail', () => {
  const report = evaluate({
    ...productionEnv(),
    DB_SSL_CA_FILE: '/run/secrets/db-ca.pem',
  })
  assert.ok(codes(report).includes('DB_CA_SOURCE_AMBIGUOUS'))
  assert.deepEqual(variablesFor(report, 'DB_CA_SOURCE_AMBIGUOUS'), [
    'DB_SSL_CA_FILE',
    'DB_SSL_CA_PEM',
  ])
})

test('neither CA source fails', () => {
  const env = productionEnv()
  delete env.DB_SSL_CA_PEM
  const report = evaluate(env)
  assert.ok(codes(report).includes('DB_CA_SOURCE_MISSING'))
  assert.deepEqual(variablesFor(report, 'DB_CA_SOURCE_MISSING'), [
    'DB_SSL_CA_FILE',
    'DB_SSL_CA_PEM',
  ])
})

test('a truncated inline CA is rejected on shape alone', () => {
  const report = evaluate({
    ...productionEnv(),
    DB_SSL_CA_PEM: 'c3ludGhldGljLXRydW5jYXRlZC1wYXN0ZQ==',
  })
  assert.deepEqual(codes(report), ['DB_CA_PEM_MALFORMED'])
  assert.deepEqual(variablesFor(report, 'DB_CA_PEM_MALFORMED'), ['DB_SSL_CA_PEM'])
})

// ---------------------------------------------------------------------------
// DB_TLS_MODE — the transport a release is being made with
// ---------------------------------------------------------------------------

test('an explicitly disabled transport passes production with no CA at all', () => {
  // The accepted downgrade, released deliberately: plaintext to the same MySQL
  // instance the CRM connects to. It passes only because the environment states
  // the mode — the case immediately below is the same environment without it.
  const env = productionEnv()
  delete env.DB_SSL_CA_PEM
  env.DB_TLS_MODE = 'disabled'
  const report = evaluate(env)
  assert.deepEqual(report.findings, [])
  assert.equal(report.ok, true)
})

test('a missing CA without the explicit mode still fails production', () => {
  const env = productionEnv()
  delete env.DB_SSL_CA_PEM
  for (const mode of [undefined, 'required']) {
    if (mode) env.DB_TLS_MODE = mode
    else delete env.DB_TLS_MODE
    assert.ok(codes(evaluate(env)).includes('DB_CA_SOURCE_MISSING'))
  }
})

test('the required mode is what an unset mode already was', () => {
  const report = evaluate({ ...productionEnv(), DB_TLS_MODE: 'required' })
  assert.deepEqual(report.findings, [])
  assert.equal(report.ok, true)
})

test('a CA set beside the disabled mode is reported, not ignored', () => {
  for (const [source, expected] of [
    [{ DB_SSL_CA_PEM: SYNTHETIC_CA_PEM }, ['DB_TLS_MODE', 'DB_SSL_CA_PEM']],
    [
      { DB_SSL_CA_FILE: '/run/secrets/db-ca.pem' },
      ['DB_TLS_MODE', 'DB_SSL_CA_FILE'],
    ],
  ] as const) {
    const env = productionEnv()
    delete env.DB_SSL_CA_PEM
    const report = evaluate({ ...env, ...source, DB_TLS_MODE: 'disabled' })
    assert.ok(codes(report).includes('DB_TLS_DISABLED_WITH_CA'))
    assert.deepEqual(variablesFor(report, 'DB_TLS_DISABLED_WITH_CA'), expected)
    // Names only, as everywhere else in this report.
    assert.equal(
      JSON.stringify(report).includes('BEGIN CERTIFICATE'),
      false,
    )
    assert.equal(JSON.stringify(report).includes('/run/secrets'), false)
  }
})

test('an unrecognised transport mode is a stop, not a fallback', () => {
  for (const written of ['off', 'false', '0', 'none', 'prefer']) {
    const report = evaluate({ ...productionEnv(), DB_TLS_MODE: written })
    assert.ok(
      codes(report).includes('DB_TLS_MODE_INVALID'),
      `${written} must be reported`,
    )
    assert.deepEqual(variablesFor(report, 'DB_TLS_MODE_INVALID'), ['DB_TLS_MODE'])
    // And the accepted parser refuses the same environment for the same reason,
    // so the preflight is not passing a deployment the runtime would reject.
    assert.ok(codes(report).includes('RUNTIME_CONFIG_INVALID'))
    assert.deepEqual(variablesFor(report, 'RUNTIME_CONFIG_INVALID'), [
      'DB_TLS_MODE',
    ])
  }
})

test('an invalid mode is never treated as the disabled one', () => {
  // `off` means plaintext to whoever wrote it. It must not act like it.
  const env = productionEnv()
  delete env.DB_SSL_CA_PEM
  const report = evaluate({ ...env, DB_TLS_MODE: 'off' })
  assert.equal(report.ok, false)
  assert.ok(codes(report).includes('DB_CA_SOURCE_MISSING'))
})

test('a single-line CA with escaped separators is accepted', () => {
  // What a secret manager hands back when it flattens the PEM.
  const report = evaluate({
    ...productionEnv(),
    DB_SSL_CA_PEM: SYNTHETIC_CA_PEM.replaceAll('\n', '\\n'),
  })
  assert.equal(report.ok, true)
})

test('a CA path is never opened, so an absent file still passes', () => {
  // Proof the command does no filesystem read: this path does not exist, and a
  // preflight that resolved the CA would have failed here.
  const env = productionEnv()
  delete env.DB_SSL_CA_PEM
  env.DB_SSL_CA_FILE = '/nonexistent/kaudit-preflight-fixture/db-ca.pem'
  assert.equal(evaluate(env).ok, true)
})

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

test('local and preview identity modes fail for a production candidate', () => {
  for (const mode of ['local', 'preview']) {
    const report = evaluate({ ...productionEnv(), KAUDIT_AUTH_MODE: mode })
    assert.ok(codes(report).includes('AUTH_MODE_NOT_OIDC'))
    assert.deepEqual(variablesFor(report, 'AUTH_MODE_NOT_OIDC'), [
      'KAUDIT_AUTH_MODE',
    ])
  }
})

test('an absent identity mode fails rather than relying on the default', () => {
  const env = productionEnv()
  delete env.KAUDIT_AUTH_MODE
  assert.deepEqual(codes(evaluate(env)), ['AUTH_MODE_NOT_OIDC'])
})

test('missing OIDC settings are named', () => {
  const env = productionEnv()
  delete env.KAUDIT_OIDC_AUDIENCE
  delete env.KAUDIT_OIDC_JWKS_URI
  const report = evaluate(env)
  assert.deepEqual(variablesFor(report, 'REQUIRED_VARIABLE_MISSING'), [
    'KAUDIT_OIDC_AUDIENCE',
    'KAUDIT_OIDC_JWKS_URI',
  ])
})

test('a non-HTTPS issuer is rejected by the accepted parser', () => {
  const report = evaluate({
    ...productionEnv(),
    KAUDIT_OIDC_ISSUER: 'http://identity.invalid.test/',
  })
  assert.deepEqual(variablesFor(report, 'RUNTIME_CONFIG_INVALID'), [
    'KAUDIT_OIDC_ISSUER',
  ])
})

// ---------------------------------------------------------------------------
// Cryptographic and session configuration
// ---------------------------------------------------------------------------

test('an unapproved signing algorithm fails', () => {
  const report = evaluate({
    ...productionEnv(),
    KAUDIT_OIDC_ALGORITHMS: 'RS256,HS256',
  })
  assert.deepEqual(variablesFor(report, 'RUNTIME_CONFIG_INVALID'), [
    'KAUDIT_OIDC_ALGORITHMS',
  ])
})

test('the approved algorithm set passes', () => {
  assert.equal(
    evaluate({ ...productionEnv(), KAUDIT_OIDC_ALGORITHMS: 'RS256,PS256,ES256' })
      .ok,
    true,
  )
})

test('an unsafe session cookie name fails', () => {
  const report = evaluate({
    ...productionEnv(),
    KAUDIT_OIDC_TOKEN_COOKIE: 'kaudit session;Path=/',
  })
  assert.deepEqual(variablesFor(report, 'RUNTIME_CONFIG_INVALID'), [
    'KAUDIT_OIDC_TOKEN_COOKIE',
  ])
})

test('local password credentials must not exist on a web deployment', () => {
  const report = evaluate({
    ...productionEnv(),
    KAUDIT_DEV_USER_EMAIL: 'operator@example.test',
    KAUDIT_LOCAL_SESSION_SECRET:
      'synthetic-session-secret-at-least-32-characters',
    KAUDIT_IMPORT_ROOT: '.data/imports',
  })
  assert.deepEqual(variablesFor(report, 'UNSUPPORTED_VARIABLE_SET'), [
    'KAUDIT_DEV_USER_EMAIL',
    'KAUDIT_LOCAL_SESSION_SECRET',
    'KAUDIT_IMPORT_ROOT',
  ])
})

// ---------------------------------------------------------------------------
// Optional feature gating
// ---------------------------------------------------------------------------

test('the rule test lab off leaves the deployment passing with no features', () => {
  for (const flag of [undefined, 'false', 'FALSE']) {
    const env = productionEnv()
    if (flag !== undefined) env.KAUDIT_CALL_AUDIT_RULE_TEST_ENABLED = flag
    const report = evaluate(env)
    assert.equal(report.ok, true)
    assert.deepEqual(report.optionalFeatures, [])
  }
})

test('the rule test lab enabled requires its key', () => {
  const report = evaluate({
    ...productionEnv(),
    KAUDIT_CALL_AUDIT_RULE_TEST_ENABLED: 'true',
  })
  assert.deepEqual(codes(report), ['FEATURE_CONFIG_INCOMPLETE'])
  assert.deepEqual(variablesFor(report, 'FEATURE_CONFIG_INCOMPLETE'), [
    'OPENAI_API_KEY',
  ])
})

test('a blank key does not satisfy the enabled rule test lab', () => {
  const report = evaluate({
    ...productionEnv(),
    KAUDIT_CALL_AUDIT_RULE_TEST_ENABLED: 'true',
    OPENAI_API_KEY: '  ',
  })
  assert.deepEqual(codes(report), ['FEATURE_CONFIG_INCOMPLETE'])
})

test('the rule test lab enabled with its key passes and is reported by name', () => {
  const report = evaluate({
    ...productionEnv(),
    KAUDIT_CALL_AUDIT_RULE_TEST_ENABLED: 'true',
    OPENAI_API_KEY: 'sk' + '-synthetic-fixture-key',
  })
  assert.equal(report.ok, true)
  assert.deepEqual(report.optionalFeatures, ['callAuditRuleTest'])
})

test('an ambiguous feature flag fails instead of silently meaning off', () => {
  for (const flag of ['yes', '1', 'enabled']) {
    const report = evaluate({
      ...productionEnv(),
      KAUDIT_CALL_AUDIT_RULE_TEST_ENABLED: flag,
    })
    assert.deepEqual(codes(report), ['FEATURE_FLAG_INVALID'])
    assert.deepEqual(variablesFor(report, 'FEATURE_FLAG_INVALID'), [
      'KAUDIT_CALL_AUDIT_RULE_TEST_ENABLED',
    ])
  }
})

test('the model key is not read at all while its gate is off', () => {
  // The gate is the consent. A preflight that consulted the key regardless
  // would be reading a paid provider credential nothing has opted into.
  const reads: string[] = []
  const env = new Proxy(productionEnv(), {
    get(target, property) {
      reads.push(String(property))
      return Reflect.get(target, property)
    },
  }) as NodeJS.ProcessEnv
  assert.equal(evaluate(env).ok, true)
  assert.equal(reads.includes('OPENAI_API_KEY'), false)
})

test('the model key value never reaches the output when the gate is on', () => {
  const secret = 'sk' + '-synthetic-fixture-must-not-be-printed'
  const report = evaluate({
    ...productionEnv(),
    KAUDIT_CALL_AUDIT_RULE_TEST_ENABLED: 'true',
    OPENAI_API_KEY: secret,
  })
  assert.equal(formatPreflightReport(report).includes(secret), false)
  assert.equal(JSON.stringify(report).includes(secret), false)
})

test('the recording proxy without an allow-list fails', () => {
  const report = evaluate({
    ...productionEnv(),
    KAUDIT_UNPOD_PROXY_BASE: 'https://recordings.invalid.test/signed/',
  })
  assert.deepEqual(codes(report), ['FEATURE_CONFIG_INCOMPLETE'])
  assert.deepEqual(variablesFor(report, 'FEATURE_CONFIG_INCOMPLETE'), [
    'KAUDIT_ALLOWED_RECORDING_HOSTS',
  ])
})

test('the recording proxy with an allow-list passes and is reported', () => {
  const report = evaluate({
    ...productionEnv(),
    KAUDIT_UNPOD_PROXY_BASE: 'https://recordings.invalid.test/signed/',
    KAUDIT_ALLOWED_RECORDING_HOSTS: 'recordings.invalid.test',
  })
  assert.equal(report.ok, true)
  assert.deepEqual(report.optionalFeatures, ['recordingProxy'])
})

// ---------------------------------------------------------------------------
// Output safety
// ---------------------------------------------------------------------------

test('failure output carries codes and variable names only', () => {
  const env = productionEnv()
  delete env.DB_SSL_CA_PEM
  delete env.KAUDIT_OIDC_JWKS_URI
  env.NODE_ENV = 'development'
  const output = formatPreflightReport(evaluate(env))
  const parsed = JSON.parse(output) as {
    preflight: string
    result: string
    checks: number
    errors: Array<{ code: string; variables: string[] }>
    optionalFeatures?: unknown
  }
  assert.equal(parsed.preflight, 'vercel-release')
  assert.equal(parsed.result, 'fail')
  assert.equal(parsed.checks, PREFLIGHT_CHECKS.length)
  // A failure states nothing about what was configured, only what is wrong.
  assert.equal('optionalFeatures' in parsed, false)
  assert.deepEqual(Object.keys(parsed), [
    'preflight',
    'result',
    'checks',
    'errors',
  ])
  for (const entry of parsed.errors) {
    assert.deepEqual(Object.keys(entry), ['code', 'variables'])
    for (const name of entry.variables) {
      assert.ok(
        REPORTABLE_VARIABLES.includes(name),
        `${name} is not a reportable variable name`,
      )
    }
  }
})

test('no configured value appears in the output of a thoroughly broken env', () => {
  const values = {
    DB_HOST: 'db-secret-host.invalid.test',
    DB_NAME: 'kaudit_secret_schema',
    DB_USER: 'secret_reader',
    DB_PASSWORD: 'synthetic-secret-password-value',
    DB_SSL_CA_PEM: 'not-a-certificate-but-still-secret-text',
    DB_SSL_CA_FILE: '/run/secrets/secret-ca-path.pem',
    KAUDIT_AUTH_MODE: 'local',
    KAUDIT_OIDC_ISSUER: 'http://issuer-secret.invalid.test/',
    KAUDIT_OIDC_AUDIENCE: 'secret-audience',
    KAUDIT_OIDC_JWKS_URI: 'http://jwks-secret.invalid.test/keys',
    KAUDIT_OIDC_ALGORITHMS: 'HS256',
    KAUDIT_LOCAL_SESSION_SECRET: 'short',
    KAUDIT_DEV_USER_EMAIL: 'person@example.test',
    KAUDIT_IMPORT_ROOT: '/srv/secret-imports',
    KAUDIT_CALL_AUDIT_RULE_TEST_ENABLED: 'sure',
    OPENAI_API_KEY: 'sk' + '-synthetic-secret-key',
    KAUDIT_UNPOD_PROXY_BASE: 'https://proxy-secret.invalid.test/',
    NODE_ENV: 'staging',
    KAUDIT_TRUST_PROXY: 'maybe',
    DB_PORT: '-1',
  }
  const report = evaluate({ ...values })
  const output = formatPreflightReport(report)
  assert.equal(report.ok, false)
  for (const value of Object.values(values)) {
    assert.equal(
      output.includes(value),
      false,
      'a configured value must never be echoed',
    )
  }
  for (const finding of report.findings) {
    for (const name of finding.variables) {
      assert.ok(REPORTABLE_VARIABLES.includes(name))
    }
  }
})

test('an unknown thrown error is reported as a code and nothing else', () => {
  // `KAUDIT_CALIBRATION_COMPLETE` is read by the runtime parser and by no check
  // above it, so this throw can only surface from inside the parser call.
  const marker = 'synthetic-unexpected-failure-detail'
  const env = new Proxy(productionEnv(), {
    get(target, property) {
      if (property === 'KAUDIT_CALIBRATION_COMPLETE') throw new Error(marker)
      return Reflect.get(target, property)
    },
  }) as NodeJS.ProcessEnv
  const report = evaluate(env)
  assert.deepEqual(codes(report), ['RUNTIME_CONFIG_UNAVAILABLE'])
  assert.deepEqual(variablesFor(report, 'RUNTIME_CONFIG_UNAVAILABLE'), [])
  const output = formatPreflightReport(report)
  assert.equal(output.includes(marker), false)
  assert.equal(/stack|Error|at /.test(output), false)
})

test('a configuration error message is reduced to the names it mentions', () => {
  const report = evaluate({
    ...productionEnv(),
    KAUDIT_SECURE_PORT: '0',
  })
  const variables = variablesFor(report, 'RUNTIME_CONFIG_INVALID')
  assert.deepEqual(variables, ['KAUDIT_SECURE_PORT'])
  // The parser's prose ("must be an integer from 1 to 65535") is not forwarded.
  assert.equal(formatPreflightReport(report).includes('integer'), false)
})

// ---------------------------------------------------------------------------
// The preflight starts nothing
// ---------------------------------------------------------------------------

const source = (relative: string): string =>
  readFileSync(new URL(relative, import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')

const PREFLIGHT_SOURCE = source('./releasePreflight.ts')
const CLI_SOURCE = source('../cli/run-vercel-preflight.ts')

test('the preflight constructs no runtime dependency', () => {
  for (const text of [PREFLIGHT_SOURCE, CLI_SOURCE]) {
    for (const forbidden of [
      /createDashboardRuntime/,
      /createPool/,
      /mysql/i,
      // The provider client, not the variable name: the gated key is checked
      // for presence, and no model is ever constructed from it.
      /createOpenAiCallAuditModel/,
      /new OpenAI/,
      /from '[^']*openai/i,
      /createOidcVerifier/,
      /createEnterpriseDashboardServer/,
      /createMysqlCycleImportService/,
      /createImportAnalysisService/,
      /createProxyResolvingFetcher/,
    ]) {
      assert.equal(
        forbidden.test(text),
        false,
        `a validation-only preflight must not reference ${forbidden}`,
      )
    }
  }
})

test('the preflight opens no socket, listener, or connection', () => {
  for (const text of [PREFLIGHT_SOURCE, CLI_SOURCE]) {
    for (const forbidden of [
      /\bfetch\(/,
      /\.listen\(/,
      /node:https?/,
      /node:net/,
      /node:tls/,
      /node:dns/,
      /XMLHttpRequest/,
      /setInterval/,
      /setTimeout/,
      /child_process/,
      /\bexecSync\b/,
      /\bspawn\b/,
      // Git and Vercel state are operator checks: they need network or mutable
      // CLI state, so the application preflight must not shell out for them.
      /['"`]git['"`]/,
      /vercel\s+(?:link|deploy|env)/,
    ]) {
      assert.equal(forbidden.test(text), false, `must not reference ${forbidden}`)
    }
  }
})

test('the preflight mutates no environment and no file', () => {
  for (const text of [PREFLIGHT_SOURCE, CLI_SOURCE]) {
    assert.equal(/process\.env\.\w+\s*=[^=]/.test(text), false)
    assert.equal(/process\.env\[[^\]]+\]\s*=[^=]/.test(text), false)
    assert.equal(/\bdelete\s+process\.env/.test(text), false)
    assert.equal(/writeFile|appendFile|mkdir|rm\(|unlink|rename/.test(text), false)
  }
  // The evaluator touches the filesystem in no way at all.
  assert.equal(/node:fs|readFile/.test(PREFLIGHT_SOURCE), false)
})

test('the command reads exactly one file, the repository manifest', () => {
  const reads = CLI_SOURCE.match(/readFileSync\([^)]*\)/g) ?? []
  assert.equal(reads.length, 1)
  assert.match(reads[0] as string, /package\.json/)
})

test('the command exits nonzero only when the contract fails', () => {
  // One exit-code site, and it is the runner's return value — which is 0 only
  // for a passing report. The runner's own behaviour is covered in
  // `releasePreflightCli.test.ts`.
  assert.match(
    CLI_SOURCE,
    /if \(import\.meta\.main\) process\.exitCode = runVercelPreflightCli\(\)/,
  )
  // No unconditional exit and no swallowed failure: the report decides.
  assert.equal((CLI_SOURCE.match(/process\.exitCode/g) ?? []).length, 1)
  assert.equal(/process\.exit\(/.test(CLI_SOURCE), false)
  // Importing the module must not run the command, or a test that imports it
  // would read the real environment and print a line.
  assert.equal((CLI_SOURCE.match(/import\.meta\.main/g) ?? []).length, 1)
})

test('npm run vercel:preflight is wired to this command', () => {
  const manifest = JSON.parse(
    readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
  ) as { scripts?: Record<string, string> }
  assert.equal(
    manifest.scripts?.['vercel:preflight'],
    'node src/cli/run-vercel-preflight.ts',
  )
})
