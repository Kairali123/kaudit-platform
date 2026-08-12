import fs from 'node:fs'
import { ConfigurationError, type RuntimeConfig } from '../config/runtime.ts'

/**
 * MySQL TLS options for the driver, resolved from exactly one CA source.
 *
 * `rejectUnauthorized` is fixed true and is not configurable: a CA that is not
 * actually verified against is decoration.
 *
 * `verifyIdentity` is fixed true for the same reason, and it is a second
 * decision rather than a restatement of the first: mysql2 replaces Node's
 * `checkServerIdentity` with a function that returns `undefined` whenever this
 * flag is absent, so `rejectUnauthorized` alone proves only that the peer
 * certificate chains to the configured CA — not that it was issued for
 * `DB_HOST`. Any other host holding a certificate from the same authority would
 * satisfy the connection. Both flags are required to make a host-specific leaf
 * certificate mean what it looks like it means.
 */
export interface DatabaseTlsOptions {
  ca: string
  rejectUnauthorized: true
  verifyIdentity: true
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
 * Returns `undefined` in exactly two cases, and they are different decisions:
 * `DB_TLS_MODE=disabled`, which an operator stated; and, outside production
 * only, no CA source configured, which is the existing loopback-development
 * behaviour. Production never reaches the second case.
 */
export function resolveDatabaseTls(
  config: RuntimeConfig,
  env: NodeJS.ProcessEnv,
  readCaFile: CaFileReader = defaultReadCaFile,
): DatabaseTlsOptions | undefined {
  const { tlsMode, sslCaFile, sslCaInline } = config.database

  // Plaintext, because the environment says so in as many words. No mysql2 `ssl`
  // option is produced at all — an empty or partial one would still start a
  // handshake, and the point of this mode is that there isn't one.
  //
  // Configured trust material contradicts the mode and is refused rather than
  // dropped, for the same reason `loadRuntimeConfig` refuses it: a CA that is
  // present and unused looks, in a settings page, exactly like a CA in force.
  if (tlsMode === 'disabled') {
    if (sslCaFile || sslCaInline) {
      throw new ConfigurationError(
        'DB_TLS_MODE=disabled connects in plaintext and cannot use DB_SSL_CA_FILE or DB_SSL_CA_PEM',
      )
    }
    return undefined
  }

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
      // A missing CA is never read as consent to plaintext. `DB_TLS_MODE` is
      // the only thing that says that, and it did not.
      throw new ConfigurationError(
        'DB_SSL_CA_FILE or DB_SSL_CA_PEM is required in production unless DB_TLS_MODE=disabled is set explicitly',
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
    return { ca, rejectUnauthorized: true, verifyIdentity: true }
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
  return { ca, rejectUnauthorized: true, verifyIdentity: true }
}
