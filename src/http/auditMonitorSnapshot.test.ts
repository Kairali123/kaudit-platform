import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Pool } from 'mysql2/promise'
import type { PageSnapshotStore } from '../adapters/mysqlPageSnapshot.ts'
import { createMysqlPageSnapshotStore } from '../adapters/mysqlPageSnapshot.ts'
import {
  AUDIT_MONITOR_SNAPSHOT_DEFINITION,
  auditMonitorSnapshotKey,
  snapshotSummary,
} from './auditMonitorSnapshot.ts'

/** In-memory store with the same claim semantics as the MySQL one. */
function memoryStore() {
  const rows = new Map<string, { payload?: unknown; computedAt?: string; claimed: boolean }>()
  const store: PageSnapshotStore = {
    async read(key) {
      const row = rows.get(key)
      return row?.payload === undefined
        ? null
        : { payload: row.payload, computedAt: row.computedAt!, refreshing: row.claimed }
    },
    async claimRefresh(key) {
      const row = rows.get(key) ?? { claimed: false }
      rows.set(key, row)
      if (row.claimed) return false
      row.claimed = true
      return true
    },
    async write(key, _definition, payload) {
      rows.set(key, { payload, computedAt: '2026-09-30T11:00:00.000Z', claimed: false })
    },
    async release(key) {
      const row = rows.get(key)
      if (row) row.claimed = false
    },
  }
  return { store, rows }
}

test('only unfiltered month summaries are snapshotted', () => {
  const base = { section: 'summary-core', month: '2026-06', category: null, taskId: null }
  assert.equal(auditMonitorSnapshotKey(base), 'audit-monitor:summary-core:2026-06')
  assert.equal(auditMonitorSnapshotKey({ ...base, section: 'rows' }), null)
  assert.equal(auditMonitorSnapshotKey({ ...base, category: 'OK' }), null)
  assert.equal(auditMonitorSnapshotKey({ ...base, taskId: 'T1' }), null)
  assert.equal(auditMonitorSnapshotKey({ ...base, month: null }), null)
})

test('a page read never computes; it reports a missing snapshot', async () => {
  const { store } = memoryStore()
  let computed = 0
  const result = await snapshotSummary({
    store, key: 'k', refresh: false,
    compute: async () => { computed += 1; return {} },
  })
  assert.equal(computed, 0)
  assert.deepEqual(result.snapshot, { computedAt: null, refreshing: false, missing: true })
})

test('a refresh computes once, stores it, and later reads are served from it', async () => {
  const { store } = memoryStore()
  let computed = 0
  const compute = async () => {
    computed += 1
    return { generatedAt: '2026-09-30T10:59:00.000Z', summary: { total: 7 } }
  }
  const fresh = await snapshotSummary({ store, key: 'k', refresh: true, compute })
  assert.equal(computed, 1)
  assert.deepEqual(fresh.summary, { total: 7 })
  assert.equal(fresh.snapshot.refreshing, false)
  const read = await snapshotSummary({ store, key: 'k', refresh: false, compute })
  assert.equal(computed, 1)
  assert.deepEqual(read.summary, { total: 7 })
  assert.equal(read.generatedAt, '2026-09-30T11:00:00.000Z')
})

test('a second refresh while one runs does not compute again', async () => {
  const { store } = memoryStore()
  await store.claimRefresh('k', 300)
  let computed = 0
  const result = await snapshotSummary({
    store, key: 'k', refresh: true,
    compute: async () => { computed += 1; return {} },
  })
  assert.equal(computed, 0)
  assert.equal(result.snapshot.refreshing, true)
})

test('a failed refresh releases its claim so the next one can run', async () => {
  const { store } = memoryStore()
  await assert.rejects(snapshotSummary({
    store, key: 'k', refresh: true,
    compute: async () => { throw new Error('synthetic aggregate failure') },
  }))
  assert.equal(await store.claimRefresh('k', 300), true)
})

test('the MySQL store ignores rows of another definition or with a bad digest', async () => {
  const reply = { payload_json: '{"a":1}', payload_sha256: 'x'.repeat(64),
    definition: AUDIT_MONITOR_SNAPSHOT_DEFINITION, computed_at: '2026-09-30 11:00:00.000000', refreshing: 0 }
  const pool = { query: async () => [[reply], []] } as unknown as Pool
  const store = createMysqlPageSnapshotStore(pool)
  assert.equal(await store.read('k', AUDIT_MONITOR_SNAPSHOT_DEFINITION), null)
  reply.payload_sha256 = (await import('node:crypto'))
    .createHash('sha256').update('{"a":1}').digest('hex')
  const good = await store.read('k', AUDIT_MONITOR_SNAPSHOT_DEFINITION)
  assert.deepEqual(good?.payload, { a: 1 })
  assert.equal(good?.computedAt, '2026-09-30T11:00:00.000Z')
  assert.equal(await store.read('k', 'another-definition/1'), null)
})

test('without the table the MySQL store degrades to live computing', async () => {
  const pool = {
    query: async () => { throw Object.assign(new Error('no table'), { code: 'ER_NO_SUCH_TABLE' }) },
  } as unknown as Pool
  const store = createMysqlPageSnapshotStore(pool)
  assert.equal(await store.read('k', AUDIT_MONITOR_SNAPSHOT_DEFINITION), null)
  assert.equal(await store.claimRefresh('k', 300), true)
  await store.write('k', AUDIT_MONITOR_SNAPSHOT_DEFINITION, {})
  await store.release('k')
})
