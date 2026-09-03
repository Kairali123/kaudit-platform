import type { Pool, RowDataPacket } from 'mysql2/promise'

export type DatabaseEngine = 'mariadb' | 'mysql'

const TIMEOUT_CODES = new Set([
  'ER_STATEMENT_TIMEOUT',
  'ER_QUERY_TIMEOUT',
])

export function isDatabaseStatementTimeout(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' && TIMEOUT_CODES.has(code)
}

function tagStatementExecution(error: unknown): void {
  if (!isDatabaseStatementTimeout(error)) return
  if (typeof error !== 'object' || error === null) return
  if ('kauditPhase' in error) return
  Object.defineProperty(error, 'kauditPhase', {
    value: 'statement_execution',
    enumerable: false,
    configurable: true,
  })
}

export function databaseEngine(version: string): DatabaseEngine | null {
  if (/mariadb/i.test(version)) return 'mariadb'
  if (/mysql/i.test(version) || /^\d+\.\d+/.test(version)) return 'mysql'
  return null
}

export function boundedSelect(
  sql: string,
  engine: DatabaseEngine,
  timeoutSeconds: number,
): string {
  if (!/^\s*SELECT\b/i.test(sql)) return sql
  if (engine === 'mariadb') {
    return `SET STATEMENT max_statement_time=${timeoutSeconds} FOR ${sql}`
  }
  return sql.replace(
    /^(\s*SELECT)\b/i,
    `$1 /*+ MAX_EXECUTION_TIME(${timeoutSeconds * 1_000}) */`,
  )
}

/**
 * Applies an engine-specific per-statement limit to direct pool SELECTs only.
 *
 * Billing reads use `pool.query`, so they are bounded without changing the
 * session or affecting writes, transactions, and audit-chain statements.
 */
export function withDatabaseSelectTimeout(
  pool: Pool,
  timeoutSeconds: number,
): Pool {
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds <= 0) {
    throw new TypeError('timeoutSeconds must be a positive integer')
  }
  let enginePromise: Promise<DatabaseEngine> | null = null
  const target = pool as unknown as Record<PropertyKey, unknown>
  const query = Reflect.get(target, 'query', target)
  if (typeof query !== 'function') throw new TypeError('pool query is required')

  const detectEngine = async (): Promise<DatabaseEngine> => {
    if (!enginePromise) {
      enginePromise = (async () => {
        const [rows] = await query.apply(target, [
          'SELECT VERSION() AS version',
        ]) as [RowDataPacket[], unknown]
        const detected = databaseEngine(String(rows[0]?.version ?? ''))
        if (!detected) {
          throw Object.assign(new Error('unsupported database engine'), {
            code: 'DB_ENGINE_UNSUPPORTED',
          })
        }
        return detected
      })()
      enginePromise.catch(() => {
        enginePromise = null
      })
    }
    return enginePromise
  }

  return new Proxy(target, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver)
      if (property !== 'query' || typeof value !== 'function') {
        return typeof value === 'function' ? value.bind(target) : value
      }
      return async (sql: unknown, ...args: unknown[]) => {
        if (typeof sql !== 'string' || !/^\s*SELECT\b/i.test(sql)) {
          return value.apply(target, [sql, ...args])
        }
        try {
          const engine = await detectEngine()
          const statement = boundedSelect(sql, engine, timeoutSeconds)
          return await value.apply(target, [statement, ...args])
        } catch (error) {
          tagStatementExecution(error)
          throw error
        }
      }
    },
  }) as unknown as Pool
}
