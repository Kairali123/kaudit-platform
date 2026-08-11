import mysql from 'mysql2/promise'
import { loadRuntimeConfig } from '../config/runtime.ts'
import { resolveDatabaseTls } from '../runtime/databaseTls.ts'
import {
  bindOidcIdentity,
  OidcBindingWriteError,
  type OidcBindingResult,
} from '../adapters/mysqlOidcBinding.ts'
import {
  normalizeOidcBinding,
  OidcBindingInputError,
  OIDC_BIND_ENV,
  OIDC_BIND_EXECUTE_MODE,
} from '../identity/oidcBinding.ts'

/**
 * ONE-SHOT operator command: bind a pre-provisioned `kaudit_user` to the OIDC
 * issuer and subject an operator supplies explicitly.
 *
 *   npm run w1:bind-oidc                      # dry-run, the default
 *   KAUDIT_OIDC_BIND_MODE=EXECUTE npm run w1:bind-oidc
 *
 * This file owns process concerns only — environment, TLS, a pool, one line of
 * stdout, an exit code, and the one check that needs runtime configuration: the
 * supplied issuer must be the issuer this deployment authenticates against.
 * Validation lives in `identity/oidcBinding.ts` and the transaction in
 * `adapters/mysqlOidcBinding.ts`, both of which are tested without a database.
 *
 * What it deliberately is not: it does not create a user, activate or disable
 * one, grant or revoke a role, change a sensitivity ceiling, rename anybody, or
 * bind an identity by matching an email at login. Every one of those is a
 * separate, reviewed act. Binding only decides which provider identity resolves
 * to an account that already exists.
 *
 * The subject is an input, never a derivation. Take it from the `sub` claim of a
 * validated Google ID token or from the provider's identity-admin surface — see
 * docs/runbooks/ADMIN_ACCESS.md. Nothing here can tell you whether a guessed
 * `sub` is right, and a wrong one binds the account to whoever really owns it.
 *
 * Privacy boundary: no supplied value is printed, and no thrown value is read.
 * The email, issuer, and subject reach the driver as bound parameters and reach
 * the audit log only as a hash. Failures are bounded codes chosen in this file.
 */

// ---------------------------------------------------------------------------
// Failure vocabulary
// ---------------------------------------------------------------------------

const BIND_CLI_ERROR_CODES = {
  /** Runtime configuration or MySQL TLS could not be resolved. */
  configUnavailable: 'OIDC_BIND_CONFIG_UNAVAILABLE',
  /**
   * This run is not configured for OIDC authentication, or the supplied issuer
   * is not the one this deployment authenticates against. One fixed code covers
   * both: it says a binding was refused, never which issuer was involved.
   */
  issuerMismatch: 'OIDC_BIND_ISSUER_MISMATCH',
  /** No connection could be taken from the pool. */
  connectionUnavailable: 'OIDC_BIND_CONNECTION_UNAVAILABLE',
  /** Anything else. Deliberately opaque: the thrown value is never read. */
  unexpected: 'OIDC_BIND_UNEXPECTED_FAILURE',
} as const

class OidcBindCliError extends Error {
  readonly code: string

  constructor(code: string) {
    super(code)
    this.name = 'OidcBindCliError'
    this.code = code
  }
}

// ---------------------------------------------------------------------------
// Safe output
// ---------------------------------------------------------------------------

/**
 * The whole of stdout: one line, a fixed set of keys, every value a closed enum,
 * a bounded code, or a boolean.
 *
 * An explicit allowlist rather than a spread, and no identifier of any kind —
 * not the user id, not the email, not the issuer or subject. An operator reading
 * this line, or a ticket quoting it, learns what the command decided and nothing
 * about who or what it decided it for.
 */
function safeSummaryLine(result: OidcBindingResult): string {
  return `${JSON.stringify({
    command: 'w1:bind-oidc',
    mode: result.mode,
    outcome: result.outcome,
    refusalCode: result.refusalCode,
    userFound: result.userFound,
    userActive: result.userActive,
    userHasRole: result.userHasRole,
    bindingWritten: result.bindingWritten,
    auditMode: result.auditMode,
  })}\n`
}

/** The bounded code for a stopped run, chosen WITHOUT reading the value. */
function safeFailureCode(error: unknown): string {
  if (error instanceof OidcBindingInputError) return error.code
  if (error instanceof OidcBindingWriteError) return error.code
  if (error instanceof OidcBindCliError) return error.code
  return BIND_CLI_ERROR_CODES.unexpected
}

/** The offending input NAME, when the failure was an input mistake. */
function safeFailureField(error: unknown): string | null {
  return error instanceof OidcBindingInputError ? error.field : null
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

async function main(): Promise<OidcBindingResult> {
  // Deny by default, compared byte for byte. No trim, no case fold, no
  // fallback: ` EXECUTE `, `execute`, and `true` are all dry-runs, because a
  // near-miss on consent must fail toward doing nothing.
  const execute = process.env[OIDC_BIND_ENV.mode] === OIDC_BIND_EXECUTE_MODE

  // Validated before a pool exists, so a mistyped issuer or a subject copied
  // from an email costs a round trip to nothing.
  const request = normalizeOidcBinding({
    email: process.env[OIDC_BIND_ENV.email],
    issuer: process.env[OIDC_BIND_ENV.issuer],
    subject: process.env[OIDC_BIND_ENV.subject],
  })

  let config: ReturnType<typeof loadRuntimeConfig>
  let ssl: ReturnType<typeof resolveDatabaseTls>
  try {
    config = loadRuntimeConfig(process.env)
    // Both CA sources, one resolver: a path for the hosts that mount one and an
    // inline PEM for those that do not. It throws rather than returning
    // undefined in production, so a missing CA cannot degrade this command to a
    // plaintext connection carrying an administrator's identity.
    ssl = resolveDatabaseTls(config, process.env)
  } catch {
    // A configuration error can quote a path or a value.
    throw new OidcBindCliError(BIND_CLI_ERROR_CODES.configUnavailable)
  }

  // The binding has to name the issuer this deployment actually authenticates
  // against, or it writes a pair no login here can ever present. So the two are
  // compared byte for byte, and a run not configured for OIDC at all stops for
  // the same reason: there is no configured issuer to agree with.
  //
  // Compared, never derived. Copying the configured value into the request
  // would make any misconfiguration self-consistent and silently bind the
  // wrong provider; requiring the operator to state it means the mistake shows
  // up here, before a connection exists, instead of at someone's sign-in.
  //
  // Neither value is read for the report: the stop is one fixed code.
  if (config.auth.mode !== 'oidc' || config.auth.issuer !== request.issuer) {
    throw new OidcBindCliError(BIND_CLI_ERROR_CODES.issuerMismatch)
  }

  const pool = mysql.createPool({
    host: config.database.host,
    port: config.database.port,
    database: config.database.name,
    user: config.database.user,
    password: config.database.password,
    ssl,
    connectionLimit: 2,
    connectTimeout: 10_000,
  })

  try {
    let connection
    try {
      connection = await pool.getConnection()
    } catch {
      throw new OidcBindCliError(BIND_CLI_ERROR_CODES.connectionUnavailable)
    }
    try {
      return await bindOidcIdentity(connection, request, { execute })
    } finally {
      // Before the pool closes, and on every path: a connection still checked
      // out is one `pool.end()` waits on forever.
      connection.release()
    }
  } finally {
    await pool.end()
  }
}

main().then(
  (result) => {
    process.stdout.write(safeSummaryLine(result))
    // A refusal is not a success. `no-op` is: the binding the operator asked
    // for is already in place, which is what re-running the command means.
    process.exitCode = result.outcome === 'refused' ? 1 : 0
  },
  (error: unknown) => {
    const field = safeFailureField(error)
    process.stderr.write(
      `[oidc-bind] stopped ${safeFailureCode(error)}${
        field ? ` field=${field}` : ''
      }\n`,
    )
    process.exitCode = 1
  },
)
