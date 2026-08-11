import { createHmac, hkdfSync, timingSafeEqual } from 'node:crypto'
import {
  isOidcTransactionValue,
  OidcBrowserFlowError,
  OIDC_TRANSACTION_TTL_SECONDS,
  type OidcTransaction,
} from './oidcBrowserFlow.ts'

/**
 * The authenticated envelope the transaction cookie actually carries.
 *
 * ## Why an authenticator, not just cookie flags
 *
 * `HttpOnly`, `Secure` and `SameSite` describe who may *read* and *send* a
 * cookie; none of them says anything about who *wrote* it. Cookies are also not
 * origin-scoped: a sibling host under a shared registrable domain — a future
 * `*.kairali.com` custom domain, a compromised subdomain, a proxy that sets
 * cookies — can write `kaudit_oidc_tx` for the parent domain, and the browser
 * will then present it here, sometimes shadowing the host-only cookie this
 * server set. A base64url JSON blob would let that injected value become the
 * state, nonce and PKCE verifier a callback is validated against, which is the
 * whole of the CSRF and code-injection protection the flow rests on.
 *
 * So the cookie is opaque and authenticated: only a value produced by this
 * process's key is accepted, and a value produced by anything else is refused
 * before a code is presented to the token endpoint.
 *
 * ## Key material
 *
 * HMAC-SHA256 under a key derived with HKDF-SHA256 from the OAuth client
 * secret, which the deployment already holds and which is high-entropy by
 * construction (a conforming provider issues it). The derivation is
 * domain-separated by a fixed salt and info string, so the HMAC key is not the
 * client secret, cannot be used as one, and reveals nothing about it.
 *
 * The key exists only inside the closure {@link createOidcTransactionSeal}
 * returns. It is not stored on the returned object as data, not placed in
 * `RuntimeConfig`, not passed to the HTTP server's dependencies, not returned
 * from any function here, and not reachable from any thrown value — the only
 * things that leave this module are an opaque string and an
 * {@link OidcTransaction}.
 *
 * ## Output discipline
 *
 * Every rejection — absent, oversized, wrong version, structurally malformed,
 * truncated, tampered, forged under another key, shape-wrong, or expired — is
 * the same bounded `OIDC_TRANSACTION_MISSING`. One code, one fixed title, no
 * interpolation: a caller learns that the transaction is not usable and nothing
 * about which check refused it.
 */

/** The only envelope version this build produces or accepts. */
const ENVELOPE_VERSION = 'v1'

/**
 * Domain separation for the derivation. Neither value is secret — publishing
 * them is what makes the separation meaningful rather than obscure — and
 * changing either invalidates every envelope in flight, which is why they are
 * versioned alongside the format.
 */
export const OIDC_TRANSACTION_KEY_SALT = 'kaudit.oidc.transaction.salt.v1'
export const OIDC_TRANSACTION_KEY_INFO =
  'kaudit.oidc.transaction.hmac-sha256.v1'

/** HMAC-SHA256 key length, in bytes. */
const KEY_BYTES = 32

/** base64url of a 32-byte digest. */
const MAC_CHARACTERS = 43

/**
 * Floor on the key material handed to the derivation.
 *
 * A conforming provider's client secret is far longer than this; the floor only
 * refuses a deployment that has substituted a placeholder, in which case the
 * flow is unavailable rather than authenticated by something guessable.
 */
const MIN_KEY_MATERIAL_LENGTH = 16

/** Cookie values above this are refused unparsed. A sealed one is ~320 bytes. */
const MAX_ENVELOPE_LENGTH = 1024

/** A future `iat` beyond this is a clock the server will not reason about. */
const MAX_CLOCK_SKEW_SECONDS = 60

const BASE64URL_SEGMENT = /^[A-Za-z0-9_-]+$/

export interface OidcTransactionSeal {
  /**
   * Produces the cookie value. `issuedAtSeconds` is authenticated along with
   * the transaction, so the expiry below cannot be extended by the browser.
   */
  seal(transaction: OidcTransaction, issuedAtSeconds?: number): string
  /** Returns the sealed transaction, or throws the one bounded refusal. */
  open(cookieValue: string | null, nowSeconds?: number): OidcTransaction
}

function refuse(): never {
  throw new OidcBrowserFlowError('OIDC_TRANSACTION_MISSING')
}

function nowInSeconds(): number {
  return Math.floor(Date.now() / 1000)
}

/**
 * Builds a seal over the supplied key material.
 *
 * Called once, from the authorization client, with the client secret. Nothing
 * else in the application constructs one against real material.
 */
export function createOidcTransactionSeal(
  keyMaterial: string,
): OidcTransactionSeal {
  if (
    typeof keyMaterial !== 'string' ||
    keyMaterial.length < MIN_KEY_MATERIAL_LENGTH
  ) {
    // Refused at construction, so a deployment either has an authenticated
    // transaction or has no browser sign-in — never an unauthenticated one.
    throw new OidcBrowserFlowError('OIDC_BROWSER_LOGIN_UNAVAILABLE')
  }
  const key = Buffer.from(
    hkdfSync(
      'sha256',
      Buffer.from(keyMaterial, 'utf8'),
      Buffer.from(OIDC_TRANSACTION_KEY_SALT, 'utf8'),
      Buffer.from(OIDC_TRANSACTION_KEY_INFO, 'utf8'),
      KEY_BYTES,
    ),
  )

  /** MAC over the version and the payload together, so neither can be swapped. */
  const authenticator = (payload: string): Buffer =>
    createHmac('sha256', key)
      .update(`${ENVELOPE_VERSION}.${payload}`, 'utf8')
      .digest()

  return {
    seal(transaction, issuedAtSeconds = nowInSeconds()): string {
      if (
        !isOidcTransactionValue(transaction.state) ||
        !isOidcTransactionValue(transaction.nonce) ||
        !isOidcTransactionValue(transaction.codeVerifier) ||
        !Number.isSafeInteger(issuedAtSeconds)
      ) {
        // Nothing outside the generator's grammar is ever sealed, so `open`
        // can trust the grammar it enforces on the way back in.
        refuse()
      }
      const payload = Buffer.from(
        JSON.stringify({
          s: transaction.state,
          n: transaction.nonce,
          v: transaction.codeVerifier,
          t: issuedAtSeconds,
        }),
        'utf8',
      ).toString('base64url')
      return `${ENVELOPE_VERSION}.${payload}.${authenticator(payload).toString('base64url')}`
    },

    open(cookieValue, nowSeconds = nowInSeconds()): OidcTransaction {
      if (!cookieValue || cookieValue.length > MAX_ENVELOPE_LENGTH) refuse()
      const parts = cookieValue.split('.')
      if (parts.length !== 3) refuse()
      const [version, payload, mac] = parts as [string, string, string]
      // Version first: a future format is refused as a whole rather than
      // half-read under this one's assumptions.
      if (version !== ENVELOPE_VERSION) refuse()
      if (
        !BASE64URL_SEGMENT.test(payload) ||
        !BASE64URL_SEGMENT.test(mac) ||
        mac.length !== MAC_CHARACTERS
      ) {
        refuse()
      }
      // Authenticate before decoding. A tampered or truncated payload is never
      // handed to `JSON.parse`, and a forged one never reaches the grammar
      // checks below, let alone the token endpoint.
      //
      // Compared as the encoded text, not as decoded bytes: base64url's last
      // character carries unused bits, so four distinct spellings of the same
      // 32 bytes exist. Comparing bytes would accept all four and make the
      // envelope malleable — a distinguishable value with the same meaning is
      // exactly what an opaque token must not have. Constant-time regardless,
      // over two buffers whose length the grammar check above already fixed.
      const supplied = Buffer.from(mac, 'utf8')
      const expected = Buffer.from(
        authenticator(payload).toString('base64url'),
        'utf8',
      )
      if (
        supplied.byteLength !== expected.byteLength ||
        !timingSafeEqual(supplied, expected)
      ) {
        refuse()
      }
      let parsed: unknown
      try {
        parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
      } catch {
        refuse()
      }
      const record = parsed as Record<string, unknown> | null
      if (
        !record ||
        typeof record !== 'object' ||
        !isOidcTransactionValue(record.s) ||
        !isOidcTransactionValue(record.n) ||
        !isOidcTransactionValue(record.v) ||
        typeof record.t !== 'number' ||
        !Number.isSafeInteger(record.t)
      ) {
        refuse()
      }
      // Verified here as well as by the cookie's `Max-Age`, because `Max-Age`
      // is a request the browser may ignore, and a cookie replayed by anything
      // other than a browser has no expiry at all. The issuance time is inside
      // the authenticated payload, so it cannot be moved forward.
      const age = nowSeconds - (record.t as number)
      if (age > OIDC_TRANSACTION_TTL_SECONDS || age < -MAX_CLOCK_SKEW_SECONDS) {
        refuse()
      }
      return {
        state: record.s as string,
        nonce: record.n as string,
        codeVerifier: record.v as string,
      }
    },
  }
}
