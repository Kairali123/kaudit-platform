import { AsyncLocalStorage } from 'node:async_hooks'
import { performance } from 'node:perf_hooks'
import type { Pool, PoolConnection } from 'mysql2/promise'

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

function recordSql(ms: number): void {
  const timing = storage.getStore()
  if (!timing) return
  timing.sqlCount += 1
  timing.sqlMs += ms
  timing.maxSqlMs = Math.max(timing.maxSqlMs, ms)
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
          recordSql(elapsedSince(startedAt))
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
          } finally {
            recordSql(elapsedSince(startedAt))
          }
        }
      }
      return typeof value === 'function' ? value.bind(target) : value
    },
  }) as unknown as Pool
}
