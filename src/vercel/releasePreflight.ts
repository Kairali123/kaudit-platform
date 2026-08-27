import {
  ConfigurationError,
  DB_TLS_MODE,
  loadRuntimeConfig,
  OIDC_BROWSER_FLOW_GATE,
  OIDC_BROWSER_FLOW_VARIABLES,
} from '../config/runtime.ts'
import { looksLikePemCertificate } from '../runtime/databaseTls.ts'

/**
 * Validation-only preflight for the Vercel web/API production candidate.
 *
 * This module answers exactly one question: *does the environment handed to it
 * satisfy the contract the accepted runtime already enforces?* It therefore
 * does nothing else. No pool, no socket, no listener, no model client, no file
 * read, no write of any kind, and no mutation of the environment it is given.
 * `loadRuntimeConfig` is the only existing code it calls, because that function
 * is the repository's single definition of runtime configuration and re-stating
 * its rules here is how a preflight ends up passing a deployment the runtime
 * then rejects.
 *
 * What it can prove is bounded, and the runbook says so: an environment is
 * shaped correctly. It proves nothing about a Vercel account, a project link, a
 * Git remote, migration state, database reachability, or preview routing — all
 * of which need network or mutable CLI state and stay operator checks.
 *
 * ## Output discipline
 *
 * Every value below stays inside this function. A finding carries a fixed error
 * code and environment variable *names* drawn from {@link REPORTABLE_VARIABLES}
 * — never a value, never a thrown error's message or stack, never CA text, a
 * URL, an issuer, a client id, or a secret. A name that is not on that list
 * cannot be reported at all, so no future edit can turn a value into output by
 * accident.
 */

export type PreflightErrorCode =
  | 'NODE_ENGINE_CONTRACT_UNREADABLE'
  | 'NODE_RUNTIME_UNSUPPORTED'
  | 'NODE_ENV_NOT_PRODUCTION'
  | 'TRUST_PROXY_NOT_ENABLED'
  | 'REQUIRED_VARIABLE_MISSING'
  | 'DB_TLS_MODE_INVALID'
  | 'DB_TLS_DISABLED_WITH_CA'
  | 'DB_CA_SOURCE_MISSING'
  | 'DB_CA_SOURCE_AMBIGUOUS'
  | 'DB_CA_PEM_MALFORMED'
  | 'AUTH_MODE_NOT_OIDC'
  | 'UNSUPPORTED_VARIABLE_SET'
  | 'FEATURE_FLAG_INVALID'
  | 'FEATURE_CONFIG_INCOMPLETE'
  | 'RUNTIME_CONFIG_INVALID'
  | 'RUNTIME_CONFIG_UNAVAILABLE'

/** Optional capabilities that were deliberately switched on. Fixed identifiers. */
export type OptionalFeatureId =
  | 'callAuditRuleTest'
  | 'recordingProxy'
  | 'oidcBrowserFlow'
  | 'auditWorkerDispatch'
  | 'persistentAuditWorkers'

export interface PreflightFinding {
  code: PreflightErrorCode
  /** Environment variable names only; always a subset of REPORTABLE_VARIABLES. */
  variables: readonly string[]
}

export interface PreflightReport {
  ok: boolean
  checks: number
  findings: readonly PreflightFinding[]
  optionalFeatures: readonly OptionalFeatureId[]
}

export interface VercelPreflightInput {
  /** Read only; never mutated, never copied into the report. */
  env: NodeJS.ProcessEnv
  /** Typically `process.versions.node`. */
  nodeVersion: string
  /** `engines.node` from the repository manifest — the single Node contract. */
  engineNodeRange: string
}

/**
 * The checks, in the order they are evaluated and reported.
 *
 * Order is fixed so two runs of the same environment produce byte-identical
 * output, which is what makes the command usable as a CI gate.
 */
export const PREFLIGHT_CHECKS = [
  'node-runtime',
  'node-env-production',
  'trust-proxy',
  'database-settings',
  'database-tls-mode',
  'database-ca-source',
  'auth-mode-oidc',
  'oidc-settings',
  'oidc-browser-flow',
  'local-auth-variables-absent',
  'google-drive-import-storage',
  'gas-usage-import-auth',
  'call-audit-rule-test',
  'recording-proxy',
  'audit-worker-dispatch',
  'runtime-config',
] as const

const DATABASE_VARIABLES = ['DB_HOST', 'DB_NAME', 'DB_USER', 'DB_PASSWORD'] as const

const OIDC_VARIABLES = [
  'KAUDIT_OIDC_ISSUER',
  'KAUDIT_OIDC_AUDIENCE',
  'KAUDIT_OIDC_JWKS_URI',
] as const

/**
 * Variables that must NOT be present on a Vercel web deployment.
 *
 * The local password credentials belong to a loopback development mode that
 * production rejects outright, so their presence is a leaked secret rather than
 * a setting. `KAUDIT_IMPORT_ROOT` would suggest the cycle import service is
 * wired up; on a function it is deliberately not constructed at all.
 */
const UNSUPPORTED_VARIABLES = [
  'KAUDIT_DEV_USER_EMAIL',
  'KAUDIT_LOCAL_PASSWORD_HASH',
  'KAUDIT_LOCAL_SESSION_SECRET',
  'KAUDIT_IMPORT_ROOT',
] as const

const DATABASE_AUTH_VARIABLES = [
  'KAUDIT_DATABASE_SESSION_SECRET',
] as const

/**
 * The only variable names this command may ever print.
 *
 * `loadRuntimeConfig` reports a problem by naming the variable in an error
 * message. Rather than forwarding that message — which a future edit could
 * widen — the message is intersected with this list, so output stays names.
 */
export const REPORTABLE_VARIABLES: readonly string[] = Object.freeze([
  'NODE_ENV',
  'DB_HOST',
  'DB_PORT',
  'DB_NAME',
  'DB_USER',
  'DB_PASSWORD',
  DB_TLS_MODE,
  'DB_SSL_CA_FILE',
  'DB_SSL_CA_PEM',
  'KAUDIT_AUTH_MODE',
  'KAUDIT_SECURE_HOST',
  'KAUDIT_SECURE_PORT',
  'KAUDIT_TRUST_PROXY',
  'KAUDIT_OIDC_ISSUER',
  'KAUDIT_OIDC_AUDIENCE',
  'KAUDIT_OIDC_JWKS_URI',
  'KAUDIT_OIDC_LOGIN_URL',
  'KAUDIT_OIDC_LOGOUT_URL',
  'KAUDIT_OIDC_TOKEN_COOKIE',
  'KAUDIT_OIDC_ALGORITHMS',
  'KAUDIT_OIDC_MAX_TOKEN_AGE_SEC',
  OIDC_BROWSER_FLOW_GATE,
  ...OIDC_BROWSER_FLOW_VARIABLES,
  'KAUDIT_DEV_USER_EMAIL',
  'KAUDIT_LOCAL_PASSWORD_HASH',
  'KAUDIT_LOCAL_SESSION_SECRET',
  'KAUDIT_LOCAL_SESSION_COOKIE',
  'KAUDIT_LOCAL_SESSION_TTL_SEC',
  'KAUDIT_DATABASE_SESSION_SECRET',
  'KAUDIT_DATABASE_SESSION_COOKIE',
  'KAUDIT_DATABASE_SESSION_TTL_SEC',
  'KAUDIT_CALIBRATION_COMPLETE',
  'KAUDIT_AUTOMATED_VALIDATION_APPROVED',
  'KAUDIT_REPORTING_APPROVED',
  'KAUDIT_IMPORT_ROOT',
  'KAUDIT_GOOGLE_DRIVE_CLIENT_ID',
  'KAUDIT_GOOGLE_DRIVE_CLIENT_SECRET',
  'KAUDIT_GOOGLE_DRIVE_REFRESH_TOKEN',
  'KAUDIT_GOOGLE_DRIVE_SHARED_DRIVE_ID',
  'KAUDIT_GOOGLE_DRIVE_ROOT_FOLDER_ID',
  'KAUDIT_GAS_IMPORT_SECRET',
  'KAUDIT_CALL_AUDIT_RULE_TEST_ENABLED',
  'KAUDIT_UNPOD_PROXY_BASE',
  'KAUDIT_ALLOWED_RECORDING_HOSTS',
  'OPENAI_API_KEY',
  'KAUDIT_AUDIT_WORKER_CONTROL_MODE',
  'KAUDIT_GITHUB_WORKER_ENABLED',
  'KAUDIT_GITHUB_WORKER_REPOSITORY',
  'KAUDIT_GITHUB_WORKER_REF',
  'KAUDIT_GITHUB_WORKER_TOKEN',
])

/** Present and non-blank. Whitespace-only is treated as unset, as elsewhere. */
function set(env: NodeJS.ProcessEnv, name: string): boolean {
  return Boolean(env[name]?.trim())
}

function majorOf(version: string): number | null {
  const match = /^v?(\d+)(?:\.|$)/.exec(version.trim())
  return match ? Number(match[1]) : null
}

function requiredMajorOf(range: string): number | null {
  const match = /(\d+)/.exec(range.trim())
  return match ? Number(match[1]) : null
}

function safeGoogleDriveId(value: string): boolean {
  return /^[A-Za-z0-9_-]{10,200}$/.test(value.trim())
}

/** Names this error mentions, and nothing else it says. */
function reportableVariablesIn(message: string): readonly string[] {
  return REPORTABLE_VARIABLES.filter((name) => message.includes(name))
}

export function evaluateVercelReleasePreflight(
  input: VercelPreflightInput,
): PreflightReport {
  const { env } = input
  const findings: PreflightFinding[] = []
  const optionalFeatures: OptionalFeatureId[] = []
  const fail = (code: PreflightErrorCode, ...variables: string[]): void => {
    findings.push({ code, variables: Object.freeze([...variables]) })
  }

  // node-runtime — the platform must run the major this repository targets, and
  // the target comes from `engines.node` so there is one Node contract, not two.
  const requiredMajor = requiredMajorOf(input.engineNodeRange)
  const runningMajor = majorOf(input.nodeVersion)
  if (requiredMajor === null) {
    fail('NODE_ENGINE_CONTRACT_UNREADABLE')
  } else if (
    runningMajor === null ||
    (input.engineNodeRange.trim().startsWith('>=')
      ? runningMajor < requiredMajor
      : runningMajor !== requiredMajor)
  ) {
    fail('NODE_RUNTIME_UNSUPPORTED')
  }

  // node-env-production — a production candidate is validated as production, so
  // the runtime applies its production rules (CA required, no loopback auth).
  if (env.NODE_ENV?.trim() !== 'production') {
    fail('NODE_ENV_NOT_PRODUCTION', 'NODE_ENV')
  }

  // trust-proxy — every request arrives through the platform's edge. Left off,
  // the access audit records the proxy hop instead of the caller.
  if (env.KAUDIT_TRUST_PROXY?.trim().toLowerCase() !== 'true') {
    fail('TRUST_PROXY_NOT_ENABLED', 'KAUDIT_TRUST_PROXY')
  }

  // database-settings
  const missingDatabase = DATABASE_VARIABLES.filter((name) => !set(env, name))
  if (missingDatabase.length > 0) {
    fail('REQUIRED_VARIABLE_MISSING', ...missingDatabase)
  }

  // database-tls-mode — which transport this deployment is being released with,
  // asked before anything about a CA because it decides whether a CA is even
  // the right question. Unset is `required`, the mode the runtime defaults to.
  //
  // A value that is neither word is a stop, not a fallback: an operator who
  // wrote `off` or `false` intended plaintext and would otherwise be told only
  // that a CA is missing.
  const tlsMode = env[DB_TLS_MODE]?.trim().toLowerCase()
  const tlsModeValid = !tlsMode || tlsMode === 'required' || tlsMode === 'disabled'
  if (!tlsModeValid) {
    fail('DB_TLS_MODE_INVALID', DB_TLS_MODE)
  }

  // database-ca-source — exactly one trusted authority, in the mode that has
  // one. Checked here on the raw variables so the operator gets the specific
  // reason; `loadRuntimeConfig` enforces the same rules for the runtime itself.
  //
  // The CA is never read. A path is only observed to be set: opening it would
  // be a filesystem read this command has no business doing, and on Vercel the
  // path would not exist anyway because nothing mounts a secret file there.
  const caFile = set(env, 'DB_SSL_CA_FILE')
  const caInline = set(env, 'DB_SSL_CA_PEM')
  if (tlsMode === 'disabled') {
    // Plaintext by explicit decision, so a missing CA is the expected state and
    // is not reported. A CA that IS set contradicts the stated transport and is
    // reported with the mode beside it, because the pair is the finding.
    const configuredCa = ['DB_SSL_CA_FILE', 'DB_SSL_CA_PEM'].filter((name) =>
      set(env, name),
    )
    if (configuredCa.length > 0) {
      fail('DB_TLS_DISABLED_WITH_CA', DB_TLS_MODE, ...configuredCa)
    }
  } else if (caFile && caInline) {
    fail('DB_CA_SOURCE_AMBIGUOUS', 'DB_SSL_CA_FILE', 'DB_SSL_CA_PEM')
  } else if (!caFile && !caInline) {
    fail('DB_CA_SOURCE_MISSING', 'DB_SSL_CA_FILE', 'DB_SSL_CA_PEM')
  } else if (caInline && !looksLikePemCertificate(env.DB_SSL_CA_PEM ?? '')) {
    // Shape only. The value is inspected, never retained and never printed —
    // this catches the truncated paste before a TLS handshake fails opaquely.
    fail('DB_CA_PEM_MALFORMED', 'DB_SSL_CA_PEM')
  }

  // Production supports either database credentials or OIDC. The choice must
  // be explicit so the deployed identity boundary is visible in settings.
  const authMode = env.KAUDIT_AUTH_MODE?.trim()
  if (authMode !== 'oidc' && authMode !== 'database') {
    fail('AUTH_MODE_NOT_OIDC', 'KAUDIT_AUTH_MODE')
  }

  // oidc-settings
  const missingOidc =
    authMode === 'oidc'
      ? OIDC_VARIABLES.filter((name) => !set(env, name))
      : []
  if (missingOidc.length > 0) {
    fail('REQUIRED_VARIABLE_MISSING', ...missingOidc)
  }

  if (authMode === 'database') {
    const missingDatabaseAuth = DATABASE_AUTH_VARIABLES.filter(
      (name) => !set(env, name),
    )
    if (missingDatabaseAuth.length > 0) {
      fail('REQUIRED_VARIABLE_MISSING', ...missingDatabaseAuth)
    }
  }

  // oidc-browser-flow — an optional capability with a dedicated gate, checked
  // the same deny-by-default way as the rule test lab above.
  //
  // Presence only. `KAUDIT_OIDC_CLIENT_SECRET` is never read, compared, shaped,
  // or counted beyond "non-blank", and only its NAME can appear in a finding.
  const browserFlowGate = env[OIDC_BROWSER_FLOW_GATE]?.trim().toLowerCase()
  if (authMode === 'database') {
    // Dormant by contract. Retaining the previous OIDC values makes rollback a
    // one-variable operation and database mode never constructs the client.
  } else if (
    browserFlowGate &&
    browserFlowGate !== 'true' &&
    browserFlowGate !== 'false'
  ) {
    fail('FEATURE_FLAG_INVALID', OIDC_BROWSER_FLOW_GATE)
  } else if (browserFlowGate === 'true') {
    const missingBrowserFlow = [
      ...OIDC_BROWSER_FLOW_VARIABLES,
      // The callback's only output. The runtime refuses the gate without it.
      'KAUDIT_OIDC_TOKEN_COOKIE',
    ].filter((name) => !set(env, name))
    if (authMode !== 'oidc') {
      fail('FEATURE_CONFIG_INCOMPLETE', OIDC_BROWSER_FLOW_GATE)
    } else if (missingBrowserFlow.length > 0) {
      fail('FEATURE_CONFIG_INCOMPLETE', ...missingBrowserFlow)
    } else {
      optionalFeatures.push('oidcBrowserFlow')
    }
  } else {
    // Gate off with client variables present is the ambiguous half-enabled
    // state the runtime rejects. Reported here so the operator sees which
    // names caused it rather than a generic config failure at boot.
    const strayBrowserFlow = OIDC_BROWSER_FLOW_VARIABLES.filter((name) =>
      set(env, name),
    )
    if (strayBrowserFlow.length > 0) {
      fail('FEATURE_CONFIG_INCOMPLETE', OIDC_BROWSER_FLOW_GATE, ...strayBrowserFlow)
    }
  }

  // local-auth-variables-absent
  const unsupported = UNSUPPORTED_VARIABLES.filter((name) => set(env, name))
  if (unsupported.length > 0) {
    fail('UNSUPPORTED_VARIABLE_SET', ...unsupported)
  }

  // google-drive-import-storage — Vercel has no durable local filesystem, so
  // imports are backed by one explicit Shared Drive boundary. The OAuth
  // credential values are checked for presence and coarse shape only; only
  // variable names can reach the report.
  const googleDriveVariables = [
    'KAUDIT_GOOGLE_DRIVE_CLIENT_ID',
    'KAUDIT_GOOGLE_DRIVE_CLIENT_SECRET',
    'KAUDIT_GOOGLE_DRIVE_REFRESH_TOKEN',
    'KAUDIT_GOOGLE_DRIVE_SHARED_DRIVE_ID',
  ] as const
  const missingGoogleDrive = googleDriveVariables.filter((name) => !set(env, name))
  if (missingGoogleDrive.length > 0) {
    fail('REQUIRED_VARIABLE_MISSING', ...missingGoogleDrive)
  } else {
    const invalidGoogleDrive: string[] = []
    const clientId = env.KAUDIT_GOOGLE_DRIVE_CLIENT_ID?.trim() || ''
    const clientSecret = env.KAUDIT_GOOGLE_DRIVE_CLIENT_SECRET?.trim() || ''
    const refreshToken = env.KAUDIT_GOOGLE_DRIVE_REFRESH_TOKEN?.trim() || ''
    const sharedDriveId =
      env.KAUDIT_GOOGLE_DRIVE_SHARED_DRIVE_ID?.trim() || ''
    const rootFolderId =
      env.KAUDIT_GOOGLE_DRIVE_ROOT_FOLDER_ID?.trim() || ''
    if (clientId.length > 512 || /\s/.test(clientId)) {
      invalidGoogleDrive.push('KAUDIT_GOOGLE_DRIVE_CLIENT_ID')
    }
    if (clientSecret.length > 4096 || /\s/.test(clientSecret)) {
      invalidGoogleDrive.push('KAUDIT_GOOGLE_DRIVE_CLIENT_SECRET')
    }
    if (refreshToken.length > 4096 || /\s/.test(refreshToken)) {
      invalidGoogleDrive.push('KAUDIT_GOOGLE_DRIVE_REFRESH_TOKEN')
    }
    if (!safeGoogleDriveId(sharedDriveId)) {
      invalidGoogleDrive.push('KAUDIT_GOOGLE_DRIVE_SHARED_DRIVE_ID')
    }
    if (rootFolderId && !safeGoogleDriveId(rootFolderId)) {
      invalidGoogleDrive.push('KAUDIT_GOOGLE_DRIVE_ROOT_FOLDER_ID')
    }
    if (invalidGoogleDrive.length > 0) {
      fail('FEATURE_CONFIG_INCOMPLETE', ...invalidGoogleDrive)
    }
  }

  // gas-usage-import-auth — the automated spreadsheet importer is a service
  // principal, not a browser. A production candidate must carry its dedicated
  // HMAC secret so the exact body/route/period/filename contract is usable.
  const gasImportSecret = env.KAUDIT_GAS_IMPORT_SECRET?.trim() || ''
  if (!gasImportSecret) {
    fail('REQUIRED_VARIABLE_MISSING', 'KAUDIT_GAS_IMPORT_SECRET')
  } else if (!/^[A-Za-z0-9._~-]{32,256}$/.test(gasImportSecret)) {
    fail('FEATURE_CONFIG_INCOMPLETE', 'KAUDIT_GAS_IMPORT_SECRET')
  }

  // call-audit-rule-test — an optional feature, deny by default. Its key is
  // consulted only once the flag has opted in, and then only for presence.
  const ruleTestFlag = env.KAUDIT_CALL_AUDIT_RULE_TEST_ENABLED?.trim().toLowerCase()
  if (ruleTestFlag && ruleTestFlag !== 'true' && ruleTestFlag !== 'false') {
    // The runtime treats anything but `true` as off. An operator who wrote
    // `yes` or `1` believes the opposite, so the ambiguity is a failure here.
    fail('FEATURE_FLAG_INVALID', 'KAUDIT_CALL_AUDIT_RULE_TEST_ENABLED')
  } else if (ruleTestFlag === 'true') {
    if (set(env, 'OPENAI_API_KEY')) {
      optionalFeatures.push('callAuditRuleTest')
    } else {
      // Without the key the runtime leaves the endpoint reporting itself
      // unavailable, silently. Enabled-but-unusable is reported, not tolerated.
      fail('FEATURE_CONFIG_INCOMPLETE', 'OPENAI_API_KEY')
    }
  }

  // recording-proxy — the fetcher without an allow-list resolves nothing.
  if (set(env, 'KAUDIT_UNPOD_PROXY_BASE')) {
    if (set(env, 'KAUDIT_ALLOWED_RECORDING_HOSTS')) {
      optionalFeatures.push('recordingProxy')
    } else {
      fail('FEATURE_CONFIG_INCOMPLETE', 'KAUDIT_ALLOWED_RECORDING_HOSTS')
    }
  }

  // audit-worker-dispatch — a dashboard-held provider credential, armed only
  // by its dedicated gate. Values are shaped here but never retained or
  // reported; findings carry variable names only.
  const workerMode =
    env.KAUDIT_AUDIT_WORKER_CONTROL_MODE?.trim().toLowerCase() || null
  const workerFlag = env.KAUDIT_GITHUB_WORKER_ENABLED?.trim().toLowerCase()
  const workerVariables = [
    'KAUDIT_GITHUB_WORKER_REPOSITORY',
    'KAUDIT_GITHUB_WORKER_REF',
    'KAUDIT_GITHUB_WORKER_TOKEN',
  ] as const
  const validWorkerModes = ['disabled', 'github', 'persistent']
  if (workerMode && !validWorkerModes.includes(workerMode)) {
    fail('FEATURE_FLAG_INVALID', 'KAUDIT_AUDIT_WORKER_CONTROL_MODE')
  } else if (workerMode === 'persistent') {
    optionalFeatures.push('persistentAuditWorkers')
  } else if (workerFlag && workerFlag !== 'true' && workerFlag !== 'false') {
    fail('FEATURE_FLAG_INVALID', 'KAUDIT_GITHUB_WORKER_ENABLED')
  } else if (workerMode === 'github' || (!workerMode && workerFlag === 'true')) {
    const missing = workerVariables.filter((name) => !set(env, name))
    const repository = env.KAUDIT_GITHUB_WORKER_REPOSITORY?.trim() || ''
    const ref = env.KAUDIT_GITHUB_WORKER_REF?.trim() || ''
    const token = env.KAUDIT_GITHUB_WORKER_TOKEN?.trim() || ''
    if (missing.length > 0) {
      fail('FEATURE_CONFIG_INCOMPLETE', ...missing)
    } else if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
      fail('FEATURE_CONFIG_INCOMPLETE', 'KAUDIT_GITHUB_WORKER_REPOSITORY')
    } else if (
      !/^[A-Za-z0-9._\/-]{1,200}$/.test(ref) ||
      ref.includes('..')
    ) {
      fail('FEATURE_CONFIG_INCOMPLETE', 'KAUDIT_GITHUB_WORKER_REF')
    } else if (token.length > 1024 || /\s/.test(token)) {
      fail('FEATURE_CONFIG_INCOMPLETE', 'KAUDIT_GITHUB_WORKER_TOKEN')
    } else {
      optionalFeatures.push('auditWorkerDispatch')
    }
  } else {
    const stray = workerVariables.filter((name) => set(env, name))
    if (stray.length > 0) {
      fail(
        'FEATURE_CONFIG_INCOMPLETE',
        'KAUDIT_GITHUB_WORKER_ENABLED',
        ...stray,
      )
    }
  }

  // runtime-config — the accepted parser, run last, as the authority on
  // everything the targeted checks above do not spell out: URL shape and scheme,
  // integer ranges, approved signing algorithms, cookie-name safety, and the
  // production rules it already owns.
  try {
    loadRuntimeConfig(env)
  } catch (error) {
    if (error instanceof ConfigurationError) {
      fail('RUNTIME_CONFIG_INVALID', ...reportableVariablesIn(error.message))
    } else {
      // Deliberately opaque. An unexpected throw can carry anything in its
      // message or stack, so nothing about it is serialized — the exit code and
      // the code below are the whole report.
      fail('RUNTIME_CONFIG_UNAVAILABLE')
    }
  }

  return {
    ok: findings.length === 0,
    checks: PREFLIGHT_CHECKS.length,
    findings: Object.freeze(findings),
    optionalFeatures: Object.freeze(optionalFeatures),
  }
}

/**
 * The command's entire output: one JSON line with a fixed set of keys.
 *
 * A pass states what was checked and which optional features were on. A failure
 * states codes and variable names. Neither carries a value.
 */
export function formatPreflightReport(report: PreflightReport): string {
  if (report.ok) {
    return JSON.stringify({
      preflight: 'vercel-release',
      result: 'pass',
      checks: report.checks,
      optionalFeatures: report.optionalFeatures,
    })
  }
  return JSON.stringify({
    preflight: 'vercel-release',
    result: 'fail',
    checks: report.checks,
    errors: report.findings.map((finding) => ({
      code: finding.code,
      variables: finding.variables,
    })),
  })
}
