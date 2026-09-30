import { createHash } from 'node:crypto'
import { AsyncLocalStorage } from 'node:async_hooks'
import { performance } from 'node:perf_hooks'
import type { Pool, PoolConnection } from 'mysql2/promise'
import { tagKnownPoolAcquisitionFailure } from '../adapters/mysqlPoolAcquisition.ts'

type TimingPhase = 'auditMs' | 'sqlMs'
type CacheResult = 'bypass' | 'hit' | 'miss'

interface RequestTiming {
  startedAt: number
  operation: string
  method: string
  sqlCount: number
  sqlMs: number
  maxSqlMs: number
  auditMs: number
  dbAcquireCount: number
  dbAcquireMs: number
  cache: CacheResult | null
  slowSql: SlowStatement[]
}

/**
 * Identifies a slow statement without its text: the verb, the kaudit_* tables
 * it names, and a fingerprint of the whitespace-normalized SQL. Values are
 * bound parameters and never part of the text, but the text itself is still
 * not logged.
 */
interface SlowStatement {
  ms: number
  op: string
  tables: string[]
  sqlSha: string
}

function slowSqlMs(): number {
  const raw = Number(process.env.KAUDIT_PERF_SLOW_SQL_MS ?? 2_000)
  return Number.isFinite(raw) && raw >= 0 ? raw : 2_000
}
const MAX_SLOW_SQL = 3

function describeSql(argument: unknown, ms: number): SlowStatement | null {
  const text = typeof argument === 'string'
    ? argument
    : typeof (argument as { sql?: unknown })?.sql === 'string'
      ? (argument as { sql: string }).sql
      : null
  if (!text) return null
  const normalized = text.replace(/\s+/g, ' ').trim()
  return {
    ms: Math.round(ms),
    op: (normalized.match(/^[A-Za-z]+/)?.[0] ?? 'UNKNOWN').toUpperCase(),
    tables: [...new Set(normalized.match(/\bkaudit_[a-z0-9_]+/g) ?? [])].slice(0, 12),
    sqlSha: createHash('sha256').update(normalized).digest('hex').slice(0, 12),
  }
}

const storage = new AsyncLocalStorage<RequestTiming>()

function elapsedSince(startedAt: number): number {
  return performance.now() - startedAt
}

function rounded(value: number): number {
  return Math.round(value)
}

function thresholdMs(): number {
  const raw = Number(process.env.KAUDIT_PERF_SLOW_MS ?? 1_000)
  return Number.isFinite(raw) && raw >= 0 ? raw : 1_000
}

function alwaysLog(): boolean {
  return process.env.KAUDIT_PERF_LOGS?.trim().toLowerCase() === 'true'
}

function recordPhase(phase: TimingPhase, ms: number): void {
  const timing = storage.getStore()
  if (!timing) return
  timing[phase] += ms
}

function recordSql(ms: number, sql?: unknown): void {
  const timing = storage.getStore()
  if (!timing) return
  timing.sqlCount += 1
  timing.sqlMs += ms
  timing.maxSqlMs = Math.max(timing.maxSqlMs, ms)
  if (ms < slowSqlMs()) return
  const slow = describeSql(sql, ms)
  if (!slow) return
  timing.slowSql.push(slow)
  timing.slowSql.sort((left, right) => right.ms - left.ms)
  timing.slowSql.length = Math.min(timing.slowSql.length, MAX_SLOW_SQL)
}

function recordDbAcquire(ms: number): void {
  const timing = storage.getStore()
  if (!timing) return
  timing.dbAcquireCount += 1
  timing.dbAcquireMs += ms
}

export function recordApiCache(result: CacheResult): void {
  const timing = storage.getStore()
  if (timing) timing.cache = result
}

async function timed<T>(phase: TimingPhase, run: () => Promise<T>): Promise<T> {
  const startedAt = performance.now()
  try {
    return await run()
  } finally {
    recordPhase(phase, elapsedSince(startedAt))
  }
}

export async function timeAudit<T>(run: () => Promise<T>): Promise<T> {
  return timed('auditMs', run)
}

export function timeRuntimeBootstrap<T>(run: () => T): T {
  const startedAt = performance.now()
  try {
    return run()
  } finally {
    const bootstrapMs = elapsedSince(startedAt)
    if (alwaysLog() || bootstrapMs >= thresholdMs()) {
      process.stderr.write(`${JSON.stringify({
        level: bootstrapMs >= thresholdMs() ? 'warn' : 'info',
        event: 'dashboard_runtime_bootstrap_timing',
        bootstrapMs: rounded(bootstrapMs),
        occurredAt: new Date().toISOString(),
      })}\n`)
    }
  }
}

export function startRequestTiming(options: {
  operation: string
  method: string
  onComplete?: (entry: Record<string, unknown>) => void
}): (statusCode?: number) => void {
  const timing: RequestTiming = {
    startedAt: performance.now(),
    operation: options.operation,
    method: options.method,
    sqlCount: 0,
    sqlMs: 0,
    maxSqlMs: 0,
    auditMs: 0,
    dbAcquireCount: 0,
    dbAcquireMs: 0,
    cache: null,
    slowSql: [],
  }
  storage.enterWith(timing)
  const complete = options.onComplete ?? ((entry) => {
    process.stderr.write(`${JSON.stringify(entry)}\n`)
  })
  let completed = false
  return (statusCode?: number) => {
    if (completed) return
    completed = true
    const totalMs = elapsedSince(timing.startedAt)
    if (!alwaysLog() && totalMs < thresholdMs()) return
    complete({
      level: totalMs >= thresholdMs() ? 'warn' : 'info',
      event: 'dashboard_request_timing',
      operation: timing.operation,
      method: timing.method,
      totalMs: rounded(totalMs),
      sqlCount: timing.sqlCount,
      sqlMs: rounded(timing.sqlMs),
      maxSqlMs: rounded(timing.maxSqlMs),
      auditMs: rounded(timing.auditMs),
      dbAcquireCount: timing.dbAcquireCount,
      dbAcquireMs: rounded(timing.dbAcquireMs),
      cache: timing.cache,
      ...(timing.slowSql.length ? { slowSql: timing.slowSql } : {}),
      status: statusCode ?? null,
      occurredAt: new Date().toISOString(),
    })
  }
}

function wrapConnection(connection: PoolConnection): PoolConnection {
  return new Proxy(connection as unknown as Record<PropertyKey, unknown>, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver)
      if (property !== 'query' && property !== 'execute') {
        return typeof value === 'function' ? value.bind(target) : value
      }
      if (typeof value !== 'function') return value
      return async (...args: unknown[]) => {
        const startedAt = performance.now()
        try {
          return await value.apply(target, args)
        } finally {
          recordSql(elapsedSince(startedAt), args[0])
        }
      }
    },
  }) as unknown as PoolConnection
}

export function instrumentMysqlPool(pool: Pool): Pool {
  return new Proxy(pool as unknown as Record<PropertyKey, unknown>, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver)
      if (property === 'getConnection' && typeof value === 'function') {
        return async (...args: unknown[]) => {
          const startedAt = performance.now()
          try {
            return wrapConnection(await value.apply(target, args))
          } finally {
            recordDbAcquire(elapsedSince(startedAt))
          }
        }
      }
      if (
        (property === 'query' || property === 'execute') &&
        typeof value === 'function'
      ) {
        return async (...args: unknown[]) => {
          const startedAt = performance.now()
          try {
            return await value.apply(target, args)
          } catch (error) {
            tagKnownPoolAcquisitionFailure(error)
            throw error
          } finally {
            recordSql(elapsedSince(startedAt), args[0])
          }
        }
      }
      return typeof value === 'function' ? value.bind(target) : value
    },
  }) as unknown as Pool
}
