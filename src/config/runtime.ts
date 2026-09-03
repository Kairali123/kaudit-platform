import { OIDC_CALLBACK_ROUTE } from '../auth/oidcBrowserFlow.ts'

export type AuthMode = 'database' | 'oidc' | 'local' | 'preview'

/**
 * How this deployment connects to MySQL, as an explicit operator decision.
 *
 * `required` is the default and the only mode that verifies anything: exactly
 * one CA source, verified, for this host. Production refuses to boot without a
 * CA in this mode.
 *
 * `disabled` is a plaintext connection, chosen to match the transport the CRM
 * already uses against the same database. It is deliberately NOT inferable: a
 * missing CA never means "plaintext", in any environment. Only the exact word
 * below turns TLS off, so the downgrade is a line in a configuration an
 * operator can be shown rather than the absence of one.
 */
export type DatabaseTlsMode = 'required' | 'disabled'

/** The variable that carries {@link DatabaseTlsMode}. */
export const DB_TLS_MODE = 'DB_TLS_MODE'
export const BILLING_READ_TIMEOUT_VARIABLE =
  'KAUDIT_BILLING_READ_TIMEOUT_SECONDS'

export function configuredBillingReadTimeoutSeconds(
  env: NodeJS.ProcessEnv,
): number | null {
  const raw = env[BILLING_READ_TIMEOUT_VARIABLE]?.trim()
  if (!raw) return null
  const timeout = Number(raw)
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 25) {
    throw new ConfigurationError(
      `${BILLING_READ_TIMEOUT_VARIABLE} must be an integer from 1 to 25`,
    )
  }
  return timeout
}

/**
 * The browser half of OIDC: this application runs the authorization-code flow
 * itself instead of receiving a token from an identity-aware proxy.
 *
 * The client secret is deliberately absent. Like the MySQL CA PEM above, this
 * object reaches the HTTP server and every CLI, so the secret is read straight
 * from the environment into the auth client in `runtime/dashboardRuntime.ts`
 * and exists nowhere else. `secretConfigured` records the fact only.
 */
export interface OidcBrowserFlowConfig {
  clientId: string
  /** Same-origin HTTPS URL whose path is the fixed callback route. */
  redirectUri: string
  secretConfigured: true
}

export interface RuntimeConfig {
  environment: 'development' | 'test' | 'production'
  host: string
  port: number
  trustProxy: boolean
  database: {
    host: string
    port: number
    name: string
    user: string
    password: string
    /**
     * The transport decision, resolved from `DB_TLS_MODE`. See
     * {@link DatabaseTlsMode}. Never inferred from whether a CA happens to be
     * configured, in either direction.
     */
    tlsMode: DatabaseTlsMode
    sslCaFile: string | null
    /**
     * Whether an inline CA PEM (`DB_SSL_CA_PEM`) is configured — the fact only.
     *
     * The PEM itself is deliberately NOT carried in configuration. This object is
     * handed to the HTTP server and to every CLI, so anything stored here is one
     * careless `JSON.stringify` away from a log line. The bootstrap reads the PEM
     * straight from the environment into the driver's TLS options and nowhere
     * else. See `src/runtime/databaseTls.ts`.
     */
    sslCaInline: boolean
  }
  auth:
    | {
        mode: 'preview'
      }
    | {
        mode: 'local'
        email: string
        passwordHash: string
        sessionSecret: string
        sessionCookie: string
        sessionTtlSeconds: number
      }
    | {
        mode: 'database'
        sessionSecret: string
        sessionCookie: string
        sessionTtlSeconds: number
      }
    | {
        mode: 'oidc'
        issuer: string
        audience: string
        jwksUri: string
        loginUrl: string | null
        logoutUrl: string | null
        tokenCookie: string | null
        algorithms: string[]
        /**
         * Maximum accepted age of a presented ID token, in seconds.
         *
         * This bounds `iat`; `exp` and the signature are verified regardless and
         * cannot be turned off. See {@link resolveMaxTokenAgeSeconds}.
         */
        maxTokenAgeSeconds: number
        /** Null when this deployment only accepts a proxy-supplied token. */
        browserFlow: OidcBrowserFlowConfig | null
      }
  releaseGates: {
    calibrationComplete: boolean
    automatedValidationApproved: boolean
    reportingApproved: boolean
  }
}

export class ConfigurationError extends Error {
  readonly code = 'INVALID_CONFIGURATION'
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim()
  if (!value) throw new ConfigurationError(`${name} is required`)
  return value
}

function optional(env: NodeJS.ProcessEnv, name: string): string | null {
  return env[name]?.trim() || null
}

function integer(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const raw = env[name]?.trim()
  const value = raw ? Number(raw) : fallback
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new ConfigurationError(`${name} must be an integer from ${minimum} to ${maximum}`)
  }
  return value
}

function bool(env: NodeJS.ProcessEnv, name: string, fallback = false): boolean {
  const raw = env[name]?.trim().toLowerCase()
  if (!raw) return fallback
  if (raw === 'true') return true
  if (raw === 'false') return false
  throw new ConfigurationError(`${name} must be true or false`)
}

/**
 * The transport mode, from the one variable that decides it.
 *
 * Unset or blank is `required`, so an environment that says nothing keeps the
 * verified-TLS posture it has today — the default is the closed one, and every
 * other value is a typo rather than a guess to be resolved. `Disabled` and
 * `DISABLED` are accepted for the same reason the other flags in this file
 * accept them: case is not a second decision. Nothing else is.
 */
function databaseTlsMode(env: NodeJS.ProcessEnv): DatabaseTlsMode {
  const raw = env[DB_TLS_MODE]?.trim().toLowerCase()
  if (!raw) return 'required'
  if (raw === 'required' || raw === 'disabled') return raw
  throw new ConfigurationError(`${DB_TLS_MODE} must be required or disabled`)
}

function httpsUrl(value: string, name: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new ConfigurationError(`${name} must be a valid URL`)
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) {
    throw new ConfigurationError(`${name} must be an HTTPS URL without credentials or a fragment`)
  }
  return url.toString()
}

function safeCookieName(
  value: string | null,
  name = 'KAUDIT_OIDC_TOKEN_COOKIE',
): string | null {
  if (value == null) return null
  if (!/^[A-Za-z0-9_.-]{1,80}$/.test(value)) {
    throw new ConfigurationError(`${name} contains unsafe characters`)
  }
  return value
}

/**
 * The three operator-supplied names that describe this application as an OAuth
 * client. All three, or none — see {@link resolveOidcBrowserFlow}.
 */
export const OIDC_BROWSER_FLOW_VARIABLES: readonly string[] = Object.freeze([
  'KAUDIT_OIDC_CLIENT_ID',
  'KAUDIT_OIDC_CLIENT_SECRET',
  'KAUDIT_OIDC_REDIRECT_URI',
])

/** The dedicated gate. Deny by default; nothing else turns the flow on. */
export const OIDC_BROWSER_FLOW_GATE = 'KAUDIT_OIDC_BROWSER_FLOW'

/**
 * Decides whether this deployment runs the browser flow, and refuses to guess.
 *
 * Two failure modes are being avoided, and they pull in opposite directions.
 * Inferring "enabled" from the presence of a client id would let one variable
 * pasted into a project's settings silently arm a browser-facing login on a
 * deployment reviewed as token-only. Inferring "disabled" from a missing secret
 * would leave an operator who set the gate staring at a 404 with nothing said.
 *
 * So the gate alone decides, and the variables must agree with it:
 *
 * - gate unset/`false`, none of the three set — token-only. The existing
 *   identity-proxy deployment is unchanged and this returns null.
 * - gate unset/`false`, any of the three set — rejected as ambiguous.
 * - gate `true`, all three set — enabled.
 * - gate `true`, any missing — rejected, naming what is missing.
 *
 * The secret is only tested for presence. Its value is never read here.
 */
function resolveOidcBrowserFlow(
  env: NodeJS.ProcessEnv,
): OidcBrowserFlowConfig | null {
  const gate = env[OIDC_BROWSER_FLOW_GATE]?.trim().toLowerCase()
  if (gate && gate !== 'true' && gate !== 'false') {
    throw new ConfigurationError(`${OIDC_BROWSER_FLOW_GATE} must be true or false`)
  }
  const present = OIDC_BROWSER_FLOW_VARIABLES.filter((name) =>
    Boolean(env[name]?.trim()),
  )
  if (gate !== 'true') {
    if (present.length > 0) {
      throw new ConfigurationError(
        `${present.join(', ')} require ${OIDC_BROWSER_FLOW_GATE}=true`,
      )
    }
    return null
  }
  const missing = OIDC_BROWSER_FLOW_VARIABLES.filter(
    (name) => !env[name]?.trim(),
  )
  if (missing.length > 0) {
    throw new ConfigurationError(
      `${missing.join(', ')} is required when ${OIDC_BROWSER_FLOW_GATE} is true`,
    )
  }
  const clientId = required(env, 'KAUDIT_OIDC_CLIENT_ID')
  if (clientId.length > 512) {
    throw new ConfigurationError('KAUDIT_OIDC_CLIENT_ID is too long')
  }
  const redirectUri = httpsUrl(
    required(env, 'KAUDIT_OIDC_REDIRECT_URI'),
    'KAUDIT_OIDC_REDIRECT_URI',
  )
  // The callback is a route this server owns, so the registered redirect URI
  // has to be that exact route. Checked here rather than at request time
  // because a mismatch is a deployment mistake, and because the token exchange
  // derives its `redirect_uri` from this value.
  const parsed = new URL(redirectUri)
  if (parsed.pathname !== OIDC_CALLBACK_ROUTE || parsed.search) {
    throw new ConfigurationError(
      `KAUDIT_OIDC_REDIRECT_URI must end in ${OIDC_CALLBACK_ROUTE} with no query`,
    )
  }
  return { clientId, redirectUri, secretConfigured: true }
}

/**
 * Bounds how old a presented ID token may be, and states the policy explicitly.
 *
 * The accepted runtime pinned this at 15 minutes, which suits a token an
 * identity-aware proxy re-mints continuously. It does not suit a token this
 * application obtained itself and parked in a cookie: conforming providers
 * (Google among them) issue ID tokens with a one-hour lifetime, so a 15-minute
 * `iat` ceiling would bounce the operator back through the provider four times
 * an hour for no security gain — the token's own `exp` has not passed.
 *
 * The rule, therefore: the operator's explicit value wins; otherwise the
 * default is one hour when this deployment runs the browser flow and the
 * existing 15 minutes when it does not. The ceiling is one hour in both cases,
 * the floor is one minute, and neither this value nor anything else can switch
 * off signature or `exp` verification.
 */
function resolveMaxTokenAgeSeconds(
  env: NodeJS.ProcessEnv,
  browserFlow: OidcBrowserFlowConfig | null,
): number {
  return integer(
    env,
    'KAUDIT_OIDC_MAX_TOKEN_AGE_SEC',
    browserFlow ? 3_600 : 900,
    60,
    3_600,
  )
}

export function loadRuntimeConfig(env: NodeJS.ProcessEnv): RuntimeConfig {
  configuredBillingReadTimeoutSeconds(env)
  const rawEnvironment = env.NODE_ENV?.trim() || 'development'
  if (!['development', 'test', 'production'].includes(rawEnvironment)) {
    throw new ConfigurationError('NODE_ENV must be development, test, or production')
  }
  const environment = rawEnvironment as RuntimeConfig['environment']
  const mode = (env.KAUDIT_AUTH_MODE?.trim() || 'oidc') as AuthMode
  if (
    mode !== 'database' &&
    mode !== 'oidc' &&
    mode !== 'local' &&
    mode !== 'preview'
  ) {
    throw new ConfigurationError(
      'KAUDIT_AUTH_MODE must be database, oidc, local, or preview',
    )
  }

  const host =
    env.KAUDIT_SECURE_HOST?.trim() ||
    (environment === 'production' ? '0.0.0.0' : '127.0.0.1')
  if (
    (mode === 'local' || mode === 'preview') &&
    (environment === 'production' || !['127.0.0.1', '::1', 'localhost'].includes(host))
  ) {
    throw new ConfigurationError(
      'Local/preview authentication is allowed only on a loopback host outside production',
    )
  }

  /**
   * The transport, then the authority — in that order, because the first
   * question decides whether the second one is asked at all.
   *
   * In `required` mode: exactly one MySQL CA source. `DB_SSL_CA_FILE` is a path
   * mounted by the host, which a persistent server or worker has. A Vercel
   * Function does not: nothing mounts a secret file there, so the CA arrives as
   * an inline PEM in `DB_SSL_CA_PEM` instead.
   *
   * Both at once is rejected everywhere rather than silently preferring one. If
   * an operator rotates the CA in one place and the runtime happens to read the
   * other, the deployment keeps trusting a stale authority and nothing says so.
   *
   * In `disabled` mode there is no handshake, so a CA is not merely unnecessary
   * — it is a contradiction. Either variable is rejected rather than ignored:
   * an operator who supplied trust material believes it is being used, and a
   * plaintext connection that quietly discards it is exactly the gap between
   * what a configuration looks like and what it does.
   */
  const tlsMode = databaseTlsMode(env)
  const sslCaFile = optional(env, 'DB_SSL_CA_FILE')
  const sslCaInline = Boolean(env.DB_SSL_CA_PEM?.trim())
  if (tlsMode === 'disabled') {
    const configuredCa = [
      sslCaFile ? 'DB_SSL_CA_FILE' : null,
      sslCaInline ? 'DB_SSL_CA_PEM' : null,
    ].filter((name): name is string => name !== null)
    if (configuredCa.length > 0) {
      throw new ConfigurationError(
        `${DB_TLS_MODE}=disabled connects in plaintext and cannot use ${configuredCa.join(
          ' or ',
        )}; unset it or set ${DB_TLS_MODE}=required`,
      )
    }
  } else {
    if (sslCaFile && sslCaInline) {
      throw new ConfigurationError(
        'DB_SSL_CA_FILE and DB_SSL_CA_PEM are both set; configure exactly one MySQL CA source',
      )
    }
    if (environment === 'production' && !sslCaFile && !sslCaInline) {
      throw new ConfigurationError(
        `DB_SSL_CA_FILE or DB_SSL_CA_PEM is required in production unless ${DB_TLS_MODE}=disabled is set explicitly`,
      )
    }
  }

  const database = {
    host: required(env, 'DB_HOST'),
    port: integer(env, 'DB_PORT', 3306, 1, 65535),
    name: required(env, 'DB_NAME'),
    user: required(env, 'DB_USER'),
    password: required(env, 'DB_PASSWORD'),
    tlsMode,
    sslCaFile,
    sslCaInline,
  }

  // Database auth deliberately leaves OIDC values dormant so an operator can
  // roll back by changing one mode variable. Local and preview retain their
  // strict development-only ambiguity checks.
  const browserFlow =
    mode === 'database' ? null : resolveOidcBrowserFlow(env)
  if (browserFlow && mode !== 'oidc') {
    throw new ConfigurationError(
      `${OIDC_BROWSER_FLOW_GATE} requires KAUDIT_AUTH_MODE=oidc`,
    )
  }

  const auth: RuntimeConfig['auth'] =
    mode === 'preview'
      ? { mode }
      : mode === 'database'
      ? {
          mode,
          sessionSecret: required(env, 'KAUDIT_DATABASE_SESSION_SECRET'),
          sessionCookie: safeCookieName(
            optional(env, 'KAUDIT_DATABASE_SESSION_COOKIE') ??
              'kaudit_user_session',
            'KAUDIT_DATABASE_SESSION_COOKIE',
          ) as string,
          sessionTtlSeconds: integer(
            env,
            'KAUDIT_DATABASE_SESSION_TTL_SEC',
            28_800,
            300,
            43_200,
          ),
        }
      : mode === 'local'
      ? {
          mode,
          email: required(env, 'KAUDIT_DEV_USER_EMAIL').toLowerCase(),
          passwordHash: required(
            env,
            'KAUDIT_LOCAL_PASSWORD_HASH',
          ),
          sessionSecret: required(
            env,
            'KAUDIT_LOCAL_SESSION_SECRET',
          ),
          sessionCookie: safeCookieName(
            optional(env, 'KAUDIT_LOCAL_SESSION_COOKIE') ??
              'kaudit_local_session',
          ) as string,
          sessionTtlSeconds: integer(
            env,
            'KAUDIT_LOCAL_SESSION_TTL_SEC',
            28_800,
            300,
            86_400,
          ),
        }
      : {
          mode,
          issuer: httpsUrl(
            required(env, 'KAUDIT_OIDC_ISSUER'),
            'KAUDIT_OIDC_ISSUER',
          ),
          audience: required(env, 'KAUDIT_OIDC_AUDIENCE'),
          jwksUri: httpsUrl(
            required(env, 'KAUDIT_OIDC_JWKS_URI'),
            'KAUDIT_OIDC_JWKS_URI',
          ),
          loginUrl: optional(env, 'KAUDIT_OIDC_LOGIN_URL')
            ? httpsUrl(
                required(env, 'KAUDIT_OIDC_LOGIN_URL'),
                'KAUDIT_OIDC_LOGIN_URL',
              )
            : null,
          logoutUrl: optional(env, 'KAUDIT_OIDC_LOGOUT_URL')
            ? httpsUrl(
                required(env, 'KAUDIT_OIDC_LOGOUT_URL'),
                'KAUDIT_OIDC_LOGOUT_URL',
              )
            : null,
          tokenCookie: safeCookieName(optional(env, 'KAUDIT_OIDC_TOKEN_COOKIE')),
          algorithms: (env.KAUDIT_OIDC_ALGORITHMS || 'RS256,PS256,ES256')
            .split(',')
            .map((value) => value.trim())
            .filter(Boolean),
          maxTokenAgeSeconds: resolveMaxTokenAgeSeconds(env, browserFlow),
          browserFlow,
        }

  if (
    auth.mode === 'oidc' &&
    (auth.algorithms.length === 0 ||
      auth.algorithms.some(
        (algorithm) => !['RS256', 'PS256', 'ES256'].includes(algorithm),
      ))
  ) {
    throw new ConfigurationError(
      'KAUDIT_OIDC_ALGORITHMS contains an unapproved algorithm',
    )
  }
  if (auth.mode === 'oidc' && auth.browserFlow) {
    // The callback's only durable output is this cookie. Without a name for it
    // a successful sign-in would have nowhere to put the token it just
    // validated, so the flow is refused at load rather than at redirect time.
    if (!auth.tokenCookie) {
      throw new ConfigurationError(
        `KAUDIT_OIDC_TOKEN_COOKIE is required when ${OIDC_BROWSER_FLOW_GATE} is true`,
      )
    }
    // Two login entry points is the ambiguous state: the dashboard advertises
    // exactly one, and silently preferring either would make the deployment's
    // behaviour depend on which line of this file ran last.
    if (auth.loginUrl) {
      throw new ConfigurationError(
        `KAUDIT_OIDC_LOGIN_URL cannot be combined with ${OIDC_BROWSER_FLOW_GATE}=true`,
      )
    }
  }
  if (
    (auth.mode === 'local' || auth.mode === 'database') &&
    auth.sessionSecret.length < 32
  ) {
    throw new ConfigurationError(
      `${
        auth.mode === 'database'
          ? 'KAUDIT_DATABASE_SESSION_SECRET'
          : 'KAUDIT_LOCAL_SESSION_SECRET'
      } must contain at least 32 characters`,
    )
  }

  const releaseGates = {
    calibrationComplete: bool(env, 'KAUDIT_CALIBRATION_COMPLETE'),
    automatedValidationApproved: bool(
      env,
      'KAUDIT_AUTOMATED_VALIDATION_APPROVED',
    ),
    reportingApproved: bool(env, 'KAUDIT_REPORTING_APPROVED'),
  }

  return {
    environment,
    host,
    port: integer(env, 'KAUDIT_SECURE_PORT', 4175, 1, 65535),
    trustProxy: bool(env, 'KAUDIT_TRUST_PROXY'),
    database,
    auth,
    releaseGates,
  }
}
