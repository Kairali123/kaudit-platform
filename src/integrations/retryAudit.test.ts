import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Pool } from 'mysql2/promise'
import { prepareRetryAudit } from './retryAudit.ts'

/** Fake pool answering the state read; records every statement. SYNTHETIC ids. */
function fakePool(state: Record<string, unknown> | null) {
  const statements: Array<{ sql: string; parameters: unknown[] }> = []
  let committed = 0
  const run = async (sql: string, parameters: unknown[] = []) => {
    statements.push({ sql, parameters })
    if (/FROM kaudit_call_artifact ca/.test(sql)) return [state ? [state] : [], []]
    return [{ affectedRows: 1 }, []]
  }
  const connection = {
    execute: run, query: run,
    beginTransaction: async () => {}, commit: async () => { committed += 1 },
    rollback: async () => {}, release: () => {},
  }
  return {
    pool: { getConnection: async () => connection } as unknown as Pool,
    statements,
    writes: () => statements.filter(({ sql }) => /^\s*(UPDATE|INSERT)/.test(sql)),
    committed: () => committed,
  }
}

const NEVER_AUDITED = {
  artifact_id: 'artifact-1', has_source_url: 1, has_sha256: 0,
  audio_processing_status: 'exhausted', live_basis: 'accepted_as_billed_unverified',
  audit_completed: 0,
}

test('a never-fetched, exhausted call billed at the unverified claim is reset and retried', async () => {
  const fake = fakePool(NEVER_AUDITED)
  const result = await prepareRetryAudit(fake.pool, [{ taskId: 'T1', callId: 'call-1' }], 'corr')
  assert.deepEqual(result.eligible, ['T1'])
  const writes = fake.writes()
  assert.equal(writes.length, 3)
  // Guarded so only the exhausted, never-fetched state can be reset.
  assert.match(writes[0]!.sql, /audio_processing_status = 'pending'[\s\S]*WHERE id = \? AND audio_processing_status = 'exhausted' AND sha256 IS NULL/)
  // Only closed leases reopen; work in flight is never touched.
  assert.match(writes[1]!.sql, /status IN \('completed', 'expired'\)/)
  assert.match(writes[2]!.sql, /INSERT INTO kaudit_audit_log[\s\S]*'audit_retry_reset'/)
  assert.equal(fake.committed(), 1)
})

test('a replay after the reset is eligible without resetting again', async () => {
  const fake = fakePool({ ...NEVER_AUDITED, audio_processing_status: 'pending' })
  const result = await prepareRetryAudit(fake.pool, [{ taskId: 'T1', callId: 'call-1' }], null)
  assert.deepEqual(result.eligible, ['T1'])
  assert.equal(fake.writes().length, 0)
})

test('calls with real evidence or a verified bill are refused untouched', async () => {
  const cases: Array<[Record<string, unknown> | null, string]> = [
    [null, 'RETRY_NO_RECORDING'],
    [{ ...NEVER_AUDITED, has_source_url: 0 }, 'RETRY_NO_RECORDING'],
    [{ ...NEVER_AUDITED, audit_completed: 1 }, 'RETRY_AUDIT_ALREADY_COMPLETED'],
    [{ ...NEVER_AUDITED, has_sha256: 1 }, 'RETRY_RECORDING_ALREADY_FETCHED'],
    [{ ...NEVER_AUDITED, live_basis: 'independent_category_service_end' }, 'RETRY_CALL_ALREADY_VERIFIED'],
  ]
  for (const [state, code] of cases) {
    const fake = fakePool(state)
    const result = await prepareRetryAudit(fake.pool, [{ taskId: 'T1', callId: 'call-1' }], null)
    assert.deepEqual(result.eligible, [], code)
    assert.equal(result.refused.get('T1'), code)
    assert.equal(fake.writes().length, 0, code)
  }
})

test('an unbilled exhausted call is also eligible', async () => {
  const fake = fakePool({ ...NEVER_AUDITED, live_basis: null })
  const result = await prepareRetryAudit(fake.pool, [{ taskId: 'T1', callId: 'call-1' }], null)
  assert.deepEqual(result.eligible, ['T1'])
})
