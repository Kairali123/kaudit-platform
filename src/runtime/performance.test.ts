import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Pool } from 'mysql2/promise'
import {
  instrumentMysqlPool,
  recordApiCache,
  startRequestTiming,
  timeAudit,
  timeRuntimeBootstrap,
} from './performance.ts'

/**
 * Privacy-safe request timing.
 *
 * The logger must be useful for diagnosing slow navigation without becoming a
 * second telemetry surface for query text, parameters, URLs, credentials, row
 * identifiers, amounts, transcripts, provider prose or thrown errors.
 */

test('request timing records counts and durations without SQL text, params, URLs, or IDs', async () => {
  const previous = process.env.KAUDIT_PERF_LOGS
  process.env.KAUDIT_PERF_LOGS = 'true'
  const entries: Record<string, unknown>[] = []
  const pool = instrumentMysqlPool({
    async query(_sql: string, _params?: unknown[]) {
      return [[{ synthetic: 1 }], []]
    },
    async execute(_sql: string, _params?: unknown[]) {
      return [[{ synthetic: 1 }], []]
    },
  } as unknown as Pool)

  try {
    const finish = startRequestTiming({
      operation: 'overview.read',
      method: 'GET',
      onComplete(entry) {
        entries.push(entry)
      },
    })
    await pool.query('SELECT secret_value FROM synthetic WHERE id = ?', [
      'sensitive-param',
    ])
    await pool.execute('SELECT another_secret FROM synthetic WHERE id = ?', [
      'another-param',
    ])
    recordApiCache('hit')
    await timeAudit(async () => {})
    finish(200)
  } finally {
    if (previous == null) delete process.env.KAUDIT_PERF_LOGS
    else process.env.KAUDIT_PERF_LOGS = previous
  }

  assert.equal(entries.length, 1)
  const entry = entries[0]
  assert.equal(entry.event, 'dashboard_request_timing')
  assert.equal(entry.operation, 'overview.read')
  assert.equal(entry.method, 'GET')
  assert.equal(entry.status, 200)
  assert.equal(entry.sqlCount, 2)
  assert.equal(entry.cache, 'hit')
  assert.equal('route' in entry, false)
  assert.equal('correlationId' in entry, false)
  assert.equal(typeof entry.sqlMs, 'number')
  assert.equal(typeof entry.maxSqlMs, 'number')
  assert.equal(typeof entry.auditMs, 'number')

  const serialized = JSON.stringify(entry)
  for (const forbidden of [
    'secret_value',
    'another_secret',
    'sensitive-param',
    'another-param',
    'synthetic WHERE',
    '?',
    '/api/',
    'correlation',
  ]) {
    assert.equal(serialized.includes(forbidden), false)
  }
})

test('instrumented connections count SQL without logging transaction details', async () => {
  const previous = process.env.KAUDIT_PERF_LOGS
  process.env.KAUDIT_PERF_LOGS = 'true'
  const entries: Record<string, unknown>[] = []
  const connection = {
    async execute() {
      return [[{ ok: 1 }], []]
    },
    release() {},
  }
  const pool = instrumentMysqlPool({
    async getConnection() {
      return connection
    },
  } as unknown as Pool)

  try {
    const finish = startRequestTiming({
      operation: 'identity.read',
      method: 'GET',
      onComplete(entry) {
        entries.push(entry)
      },
    })
    const acquired = await pool.getConnection()
    await acquired.execute('SELECT private_column FROM private_table')
    acquired.release()
    finish(200)
  } finally {
    if (previous == null) delete process.env.KAUDIT_PERF_LOGS
    else process.env.KAUDIT_PERF_LOGS = previous
  }

  assert.equal(entries.length, 1)
  assert.equal(entries[0].sqlCount, 1)
  assert.equal(entries[0].dbAcquireCount, 1)
  assert.equal(typeof entries[0].dbAcquireMs, 'number')
  assert.equal(JSON.stringify(entries[0]).includes('private_column'), false)
})

test('runtime bootstrap timing emits duration only', () => {
  const previous = process.env.KAUDIT_PERF_LOGS
  const originalWrite = process.stderr.write
  const output: string[] = []
  process.env.KAUDIT_PERF_LOGS = 'true'
  process.stderr.write = ((chunk: string | Uint8Array) => {
    output.push(String(chunk))
    return true
  }) as typeof process.stderr.write

  try {
    assert.equal(timeRuntimeBootstrap(() => 'ready'), 'ready')
  } finally {
    process.stderr.write = originalWrite
    if (previous == null) delete process.env.KAUDIT_PERF_LOGS
    else process.env.KAUDIT_PERF_LOGS = previous
  }

  assert.equal(output.length, 1)
  const entry = JSON.parse(output[0]) as Record<string, unknown>
  assert.equal(entry.event, 'dashboard_runtime_bootstrap_timing')
  assert.equal(typeof entry.bootstrapMs, 'number')
  assert.deepEqual(Object.keys(entry).sort(), [
    'bootstrapMs',
    'event',
    'level',
    'occurredAt',
  ])
})
