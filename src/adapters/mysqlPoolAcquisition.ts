import type { Pool } from 'mysql2/promise'

const KNOWN_POOL_FAILURES = new Map([
  ['Queue limit reached.', 'POOL_QUEUE_LIMIT'],
  ['No connections available.', 'POOL_NO_CONNECTION'],
  ['Pool is closed.', 'POOL_CLOSED'],
])

const EXACT_CONNECTION_CODES = new Set([
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'CERT_HAS_EXPIRED',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
])

const ACQUISITION_CODES = new Set([
  ...EXACT_CONNECTION_CODES,
  'ECONNREFUSED',
  'ETIMEDOUT',
])

export function isSafeDatabaseDriverCode(code: unknown): code is string {
  return typeof code === 'string' && code.length <= 72 && (
    /^(?:ER_|PROTOCOL_|ECONN|ETIMEDOUT|EPIPE|POOL_)[A-Z0-9_]*$/.test(code) ||
    EXACT_CONNECTION_CODES.has(code)
  )
}

function defineHidden(
  target: object,
  property: 'code' | 'kauditPhase',
  value: string,
): void {
  if (property in target) return
  Object.defineProperty(target, property, {
    value,
    enumerable: false,
    configurable: true,
  })
}

/** Classifies only exact mysql2 pool messages and never exposes their prose. */
export function tagKnownPoolAcquisitionFailure(error: unknown): void {
  if (typeof error !== 'object' || error === null) return
  const message = (error as { message?: unknown }).message
  const knownCode = typeof message === 'string'
    ? KNOWN_POOL_FAILURES.get(message)
    : undefined
  if (knownCode) {
    defineHidden(error, 'code', knownCode)
    defineHidden(error, 'kauditPhase', 'pool_acquisition')
    return
  }
  const existingCode = (error as { code?: unknown }).code
  if (typeof existingCode === 'string' && ACQUISITION_CODES.has(existingCode)) {
    defineHidden(error, 'kauditPhase', 'pool_acquisition')
  }
}

/**
 * Tags pool-acquisition failures so the worker's classifier can attribute
 * them to the right lifecycle phase.
 *
 * The original error object is rethrown untouched — the tag is additive and
 * nothing about the driver message is read, transformed, or logged here.
 */
export function tagPoolAcquisitionFailures(pool: Pool): Pool {
  if (typeof pool.getConnection !== 'function') return pool
  const originalGetConnection = pool.getConnection.bind(pool)
  const tagged = new Proxy(pool, {
    get(target, property, receiver) {
      if (property === 'getConnection') {
        return async () => {
          try {
            return await originalGetConnection()
          } catch (error) {
            tagKnownPoolAcquisitionFailure(error)
            if (typeof error === 'object' && error !== null) {
              defineHidden(error, 'kauditPhase', 'pool_acquisition')
            }
            throw error
          }
        }
      }
      return Reflect.get(target, property, receiver)
    },
  })
  return tagged as Pool
}
