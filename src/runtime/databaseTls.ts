import fs from 'node:fs'
import { ConfigurationError, type RuntimeConfig } from '../config/runtime.ts'

/**
 * MySQL TLS options for the driver, resolved from exactly one CA source.
 *
 * `rejectUnauthorized` is fixed true and is not configurable: a CA that is not
 * actually verified against is decoration.
 */
export interface DatabaseTlsOptions {
  ca: string
  rejectUnauthorized: true
}

export type CaFileReader = (filePath: string) => string

const PEM_HEADER = '-----BEGIN CERTIFICATE-----'

/**
 * Whether a value carries a certificate at all.
 *
 * Shape, not validity — the authority is verified by the TLS handshake, not
 * here. Exported so the release preflight can reject a truncated paste using
 * this definition rather than a second copy of it, and it deliberately returns
 * a boolean so no caller can end up holding the CA text.
 */
export function looksLikePemCertificate(value: string): boolean {
  return value.includes(PEM_HEADER)
}

function defaultReadCaFile(filePath: string): string {
  return fs.readFileSync(filePath, 'utf8')
}

/**
 * Secret managers and dashboards that hand back a single-line value turn the
 * PEM's newlines into the two characters `\` and `n`. Node's TLS stack will not
 * parse that, and the failure surfaces much later as an opaque handshake error.
 * Restoring the newlines here is the one normalization applied to CA input.
 */
function restoreNewlines(value: string): string {
  // A real PEM is multi-line. Absence of any newline is the reliable signal that
  // the separators survived as escape sequences, and it cannot be confused with
  // a genuine certificate.
  return value.includes('\n') ? value : value.replaceAll('\\n', '\n')
}

/**
 * Resolves the MySQL CA for a runtime.
 *
 * The CA is read here and handed straight to the driver. It is never returned to
 * a caller that logs, never copied into `RuntimeConfig`, never hashed, and never
 * written anywhere — so every error raised below names the *variable*, never any
 * part of its value.
 *
 * Returns `undefined` only outside production with no CA source configured,
 * which is the existing loopback-development behaviour.
 */
export function resolveDatabaseTls(
  config: RuntimeConfig,
  env: NodeJS.ProcessEnv,
  readCaFile: CaFileReader = defaultReadCaFile,
): DatabaseTlsOptions | undefined {
  const { sslCaFile, sslCaInline } = config.database

  // `loadRuntimeConfig` already rejects both-at-once and a production runtime
  // with neither. Re-checked here because this function is what actually decides
  // whether a connection gets a verified authority, and a future caller that
  // assembles a config by hand must not be able to skip past that.
  if (sslCaFile && sslCaInline) {
    throw new ConfigurationError(
      'DB_SSL_CA_FILE and DB_SSL_CA_PEM are both set; configure exactly one MySQL CA source',
    )
  }
  if (!sslCaFile && !sslCaInline) {
    if (config.environment === 'production') {
      throw new ConfigurationError(
        'DB_SSL_CA_FILE or DB_SSL_CA_PEM is required in production',
      )
    }
    return undefined
  }

  if (sslCaInline) {
    const ca = restoreNewlines(env.DB_SSL_CA_PEM?.trim() ?? '')
    if (!looksLikePemCertificate(ca)) {
      throw new ConfigurationError(
        'DB_SSL_CA_PEM does not contain a PEM certificate',
      )
    }
    return { ca, rejectUnauthorized: true }
  }

  let ca: string
  try {
    ca = readCaFile(sslCaFile as string)
  } catch {
    // The underlying error can carry the path and, on some platforms, buffered
    // content. Only the variable name is reported.
    throw new ConfigurationError('DB_SSL_CA_FILE could not be read')
  }
  if (!looksLikePemCertificate(ca)) {
    throw new ConfigurationError(
      'DB_SSL_CA_FILE does not contain a PEM certificate',
    )
  }
  return { ca, rejectUnauthorized: true }
}
