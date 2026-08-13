import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Pool } from 'mysql2/promise'
import { createMysqlAuditWorkerControl } from './mysqlAuditWorkerControl.ts'

function row(overrides: Record<string, unknown> = {}) {
  return {
    audit_system: 'call',
    desired_state: 'running',
    observed_state: 'idle',
    state_version: 1,
    last_heartbeat_at: null,
    last_progress_at: null,
    last_error_code: null,
    processed_total: 0,
    failed_total: 0,
    ...overrides,
  }
}

test('public worker state omits checkpoints and internal work sequence', async () => {
  const pool = {
    async query() {
      return [[row({ checkpoint_at: '2026-08-01 00:00:00', checkpoint_source_row_id: '99', work_sequence: 7 })]]
    },
  } as unknown as Pool
  const states = await createMysqlAuditWorkerControl(pool).listPublicStates()
  assert.equal(states.length, 1)
  assert.equal('checkpointAt' in states[0], false)
  assert.equal('sourceRowId' in states[0], false)
  assert.equal('workSequence' in states[0], false)
})

test('desired-state revision compares the old state before assigning the new state', async () => {
  const calls: Array<{ sql: string; parameters: unknown[] }> = []
  const pool = {
    async execute(sql: string, parameters: unknown[]) {
      calls.push({ sql, parameters })
      if (/^SELECT/.test(sql)) {
        return [[row({ desired_state: 'paused', observed_state: 'pausing', state_version: 2 })]]
      }
      return [{ affectedRows: 1 }]
    },
  } as unknown as Pool
  const result = await createMysqlAuditWorkerControl(pool).setDesiredState({
    system: 'call',
    desiredState: 'paused',
  })

  assert.equal(result.desiredState, 'paused')
  const update = calls[0]
  assert.ok(update.sql.indexOf('state_version =') < update.sql.indexOf('desired_state = ?'))
  assert.deepEqual(update.parameters, [
    'paused',
    'paused',
    'paused',
    'paused',
    'call',
  ])
  assert.match(update.sql, /WHEN \? = 'running' THEN 'running'/)
  assert.match(update.sql, /last_heartbeat_at = CASE/)
})

test('a start request becomes active immediately while dispatch is queued', async () => {
  const calls: Array<{ sql: string; parameters: unknown[] }> = []
  const pool = {
    async execute(sql: string, parameters: unknown[]) {
      calls.push({ sql, parameters })
      if (/^SELECT/.test(sql)) {
        return [[row({ observed_state: 'running' })]]
      }
      return [{ affectedRows: 1 }]
    },
  } as unknown as Pool
  const result = await createMysqlAuditWorkerControl(pool).setDesiredState({
    system: 'call',
    desiredState: 'running',
  })

  assert.equal(result.observedState, 'running')
  assert.match(calls[0]?.sql ?? '', /WHEN \? = 'running' THEN 'running'/)
})

test('a repeated stop preserves pausing until the active item settles', async () => {
  const pool = {
    async execute(sql: string) {
      if (/^SELECT/.test(sql)) {
        return [[row({ desired_state: 'paused', observed_state: 'pausing' })]]
      }
      return [{ affectedRows: 1 }]
    },
  } as unknown as Pool
  const result = await createMysqlAuditWorkerControl(pool).setDesiredState({
    system: 'call',
    desiredState: 'paused',
  })
  assert.equal(result.observedState, 'pausing')
})

test('Call Audit checkpoint preserves MySQL naive wall-clock digits', async () => {
  const local = new Date(2026, 7, 1, 9, 20, 30, 123)
  const pool = {
    async execute() {
      return [[{ checkpoint_at: local, checkpoint_source_row_id: '4021' }]]
    },
  } as unknown as Pool
  const checkpoint = await createMysqlAuditWorkerControl(pool).getCallCheckpoint()
  assert.deepEqual(checkpoint, {
    changedAt: '2026-08-01 09:20:30.123000',
    sourceRowId: '4021',
  })
})
