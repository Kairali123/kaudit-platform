export type AuthMode = 'oidc' | 'local' | 'preview'

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
    sslCaFile: string | null
  }
  auth:
    | {
        mode: 'preview'
      }
    | {
        mode: 'local'
        email: string
      }
    | {
        mode: 'oidc'
        issuer: string
        audience: string
        jwksUri: string
        tokenCookie: string | null
        algorithms: string[]
      }
  releaseGates: {
    calibrationComplete: boolean
    k23AutomationEnabled: boolean
    clinicalSafetyOwner: string | null
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

function safeCookieName(value: string | null): string | null {
  if (value == null) return null
  if (!/^[A-Za-z0-9_.-]{1,80}$/.test(value)) {
    throw new ConfigurationError('KAUDIT_OIDC_TOKEN_COOKIE contains unsafe characters')
  }
  return value
}

export function loadRuntimeConfig(env: NodeJS.ProcessEnv): RuntimeConfig {
  const rawEnvironment = env.NODE_ENV?.trim() || 'development'
  if (!['development', 'test', 'production'].includes(rawEnvironment)) {
    throw new ConfigurationError('NODE_ENV must be development, test, or production')
  }
  const environment = rawEnvironment as RuntimeConfig['environment']
  const mode = (env.KAUDIT_AUTH_MODE?.trim() || 'oidc') as AuthMode
  if (mode !== 'oidc' && mode !== 'local' && mode !== 'preview') {
    throw new ConfigurationError(
      'KAUDIT_AUTH_MODE must be oidc, local, or preview',
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

  const sslCaFile = optional(env, 'DB_SSL_CA_FILE')
  if (environment === 'production' && !sslCaFile) {
    throw new ConfigurationError('DB_SSL_CA_FILE is required in production')
  }

  const database = {
    host: required(env, 'DB_HOST'),
    port: integer(env, 'DB_PORT', 3306, 1, 65535),
    name: required(env, 'DB_NAME'),
    user: required(env, 'DB_USER'),
    password: required(env, 'DB_PASSWORD'),
    sslCaFile,
  }

  const auth: RuntimeConfig['auth'] =
    mode === 'preview'
      ? { mode }
      : mode === 'local'
      ? {
          mode,
          email: required(env, 'KAUDIT_DEV_USER_EMAIL').toLowerCase(),
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
          tokenCookie: safeCookieName(optional(env, 'KAUDIT_OIDC_TOKEN_COOKIE')),
          algorithms: (env.KAUDIT_OIDC_ALGORITHMS || 'RS256,PS256,ES256')
            .split(',')
            .map((value) => value.trim())
            .filter(Boolean),
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

  const releaseGates = {
    calibrationComplete: bool(env, 'KAUDIT_CALIBRATION_COMPLETE'),
    k23AutomationEnabled: bool(env, 'KAUDIT_K23_AUTOMATION_ENABLED'),
    clinicalSafetyOwner: optional(env, 'KAUDIT_K23_CLINICAL_SAFETY_OWNER'),
    reportingApproved: bool(env, 'KAUDIT_REPORTING_APPROVED'),
  }
  if (
    releaseGates.k23AutomationEnabled &&
    (!releaseGates.calibrationComplete ||
      !releaseGates.clinicalSafetyOwner)
  ) {
    throw new ConfigurationError(
      'K2/K3 automation requires completed calibration and KAUDIT_K23_CLINICAL_SAFETY_OWNER',
    )
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
