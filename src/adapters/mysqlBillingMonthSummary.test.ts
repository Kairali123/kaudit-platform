import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Pool } from 'mysql2/promise'
import type { RawBillingMetrics } from '../ui/fullDashboard.ts'
import {
  BILLING_SUMMARY_DEFINITION,
  createMysqlBillingMonthSummaryStore,
  monthHasEnded,
  summaryDigest,
} from './mysqlBillingMonthSummary.ts'

/**
 * A cache of financial aggregates earns its place only if it cannot show a
 * number the ledger disagrees with. Every test here is about that, not about
 * speed: the point of each rule is that a miss is always available as the safe
 * answer, so the worst outcome of a bug is the slow page we already had.
 */

const JUNE = {
  month: '2026-06',
  start: '2026-06-01',
  end: '2026-06-30',
  label: 'June 2026',
}

const METRICS = {
  calculations: 39_094,
  calculatedTotal: '134752.75',
  billableMinutes: '17104.50000000',
  currency: 'INR',
} as unknown as RawBillingMetrics

function poolReturning(rows: object[]): {
  pool: Pool
  statements: Array<{ sql: string; parameters: unknown[] }>
} {
  const statements: Array<{ sql: string; parameters: unknown[] }> = []
  const pool = {
    async query(sql: string, parameters: unknown[]) {
      statements.push({ sql, parameters })
      return [rows, []]
    },
  } as unknown as Pool
  return { pool, statements }
}

function storedRow(metrics: RawBillingMetrics): object {
  const payload = JSON.stringify(metrics)
  return {
    payload_json: payload,
    payload_sha256: summaryDigest(payload),
    source_engine_version: BILLING_SUMMARY_DEFINITION,
    computed_at: '2026-07-01 03:41:00.000000',
  }
}

test('a finished month is served from the cache', async () => {
  const { pool, statements } = poolReturning([storedRow(METRICS)])
  const cached = await createMysqlBillingMonthSummaryStore(pool).read(JUNE)
  assert.equal(cached?.metrics.calculatedTotal, '134752.75')
  assert.equal(statements.length, 1)
  assert.deepEqual(statements[0]?.parameters, ['2026-06'])
})

test('a month that has not ended is never cached, read or written', async () => {
  // It is still receiving calls and audits, so any stored answer about it is a
  // guess about the past.
  const open = { ...JUNE, month: '2026-09', start: '2026-09-01', end: '2026-09-30' }
  const { pool, statements } = poolReturning([storedRow(METRICS)])
  const store = createMysqlBillingMonthSummaryStore(pool)
  assert.equal(await store.read(open), null)
  assert.equal(await store.write(open, METRICS), false)
  assert.equal(statements.length, 0, 'the database was not touched at all')
})

test('a summary computed by a different definition is not served', async () => {
  // A cache that outlives the meaning of its contents is worse than no cache:
  // it is confidently wrong rather than merely old.
  const stale = {
    ...storedRow(METRICS),
    source_engine_version: 'billing-month-summary/0.9.0',
  }
  const { pool } = poolReturning([stale])
  assert.equal(await createMysqlBillingMonthSummaryStore(pool).read(JUNE), null)
})

test('a row that does not match its own digest is ignored', async () => {
  // Something altered it outside this module. Recomputing is the honest
  // response; rendering it is not.
  const tampered = {
    ...storedRow(METRICS),
    payload_json: JSON.stringify({ ...METRICS, calculatedTotal: '999999.00' }),
  }
  const { pool } = poolReturning([tampered])
  assert.equal(await createMysqlBillingMonthSummaryStore(pool).read(JUNE), null)
})

test('an absent table reads as a miss, not as a failure', async () => {
  // The migration may not have been applied. That must degrade to a live read,
  // which is exactly what a null return causes.
  const pool = {
    async query() {
      throw Object.assign(new Error('no such table'), {
        code: 'ER_NO_SUCH_TABLE',
      })
    },
  } as unknown as Pool
  const store = createMysqlBillingMonthSummaryStore(pool)
  assert.equal(await store.read(JUNE), null)
  assert.equal(await store.write(JUNE, METRICS), false)
  // Eviction must not throw either: it runs after a settled money write.
  await store.invalidate('2026-06')
})

test('amounts survive the cache as exact decimal text', async () => {
  // The whole system carries money as fixed-precision strings. A cache that
  // turned one into a float would be a rounding bug with a long fuse.
  const { pool, statements } = poolReturning([])
  await createMysqlBillingMonthSummaryStore(pool).write(JUNE, METRICS)
  const payload = String(statements[0]?.parameters[3])
  assert.match(payload, /"calculatedTotal":"134752\.75"/)
  assert.match(payload, /"billableMinutes":"17104\.50000000"/)
  assert.equal(JSON.parse(payload).calculatedTotal, '134752.75')
})

test('a written row carries a digest of exactly what was stored', async () => {
  const { pool, statements } = poolReturning([])
  await createMysqlBillingMonthSummaryStore(pool).write(JUNE, METRICS)
  const [, , , payload, digest, definition] = statements[0]
    ?.parameters as string[]
  assert.equal(digest, summaryDigest(payload))
  assert.equal(definition, BILLING_SUMMARY_DEFINITION)
})

test('invalidation targets one month by identity', async () => {
  const { pool, statements } = poolReturning([])
  await createMysqlBillingMonthSummaryStore(pool).invalidate('2026-06')
  assert.match(statements[0]?.sql ?? '', /^DELETE FROM/)
  assert.deepEqual(statements[0]?.parameters, ['2026-06'])
})

test('the month boundary is the last day, compared as a date', () => {
  const during = new Date('2026-06-15T00:00:00Z')
  const lastDay = new Date('2026-06-30T23:59:59Z')
  const after = new Date('2026-07-01T00:00:00Z')
  assert.equal(monthHasEnded(JUNE, during), false)
  // Still inside the month on its final day: calls can still arrive.
  assert.equal(monthHasEnded(JUNE, lastDay), false)
  assert.equal(monthHasEnded(JUNE, after), true)
})
