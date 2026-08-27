import type { Pool } from 'mysql2/promise'

/**
 * Tags pool-acquisition failures so the worker's classifier can attribute
 * them to the right lifecycle phase.
 *
 * The original error object is rethrown untouched — the tag is additive and
 * nothing about the driver message is read, transformed, or logged here.
 */
export function tagPoolAcquisitionFailures(pool: Pool): Pool {
  const originalGetConnection = pool.getConnection.bind(pool)
  const tagged = new Proxy(pool, {
    get(target, property, receiver) {
      if (property === 'getConnection') {
        return async () => {
          try {
            return await originalGetConnection()
          } catch (error) {
            if (typeof error === 'object' && error !== null) {
              Object.defineProperty(error, 'kauditPhase', {
                value: 'pool_acquisition',
                enumerable: false,
                configurable: true,
              })
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
