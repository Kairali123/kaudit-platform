import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseAuditSystem,
  parseDesiredState,
  settleStaleWorker,
  AuditWorkerControlError,
  type AuditWorkerPublicState,
} from './control.ts'

test('worker control accepts only the two independent audit systems', () => {
  assert.equal(parseAuditSystem('billing'), 'billing')
  assert.equal(parseAuditSystem('call'), 'call')
  assert.throws(() => parseAuditSystem('all'), AuditWorkerControlError)
})

test('worker control accepts only running and paused administrator intent', () => {
  assert.equal(parseDesiredState('running'), 'running')
  assert.equal(parseDesiredState('paused'), 'paused')
  assert.throws(() => parseDesiredState('stopped'), AuditWorkerControlError)
})

test('a paused worker cannot remain stuck in a stale pausing observation', () => {
  const state: AuditWorkerPublicState = {
    system: 'call',
    desiredState: 'paused',
    observedState: 'pausing',
    stateVersion: 2,
    lastHeartbeatAt: '2026-08-13T08:00:00.000Z',
    lastProgressAt: null,
    lastErrorCode: null,
    processedTotal: 0,
    failedTotal: 0,
  }
  assert.equal(
    settleStaleWorker(state, Date.parse('2026-08-13T08:06:00.000Z'))
      .observedState,
    'paused',
  )
  assert.equal(
    settleStaleWorker(state, Date.parse('2026-08-13T08:01:00.000Z'))
      .observedState,
    'pausing',
  )
  assert.equal(
    settleStaleWorker({ ...state, lastHeartbeatAt: null }).observedState,
    'paused',
  )
  assert.equal(
    settleStaleWorker({
      ...state,
      observedState: 'idle',
      lastHeartbeatAt: null,
    }).observedState,
    'paused',
  )
})

test('a running intent with no worker heartbeat becomes retryable', () => {
  const state: AuditWorkerPublicState = {
    system: 'billing',
    desiredState: 'running',
    observedState: 'running',
    stateVersion: 2,
    lastHeartbeatAt: null,
    lastProgressAt: null,
    lastErrorCode: null,
    processedTotal: 0,
    failedTotal: 0,
  }
  assert.deepEqual(settleStaleWorker(state), {
    ...state,
    observedState: 'faulted',
    lastErrorCode: 'AUDIT_WORKER_HEARTBEAT_STALE',
  })
  assert.equal(
    settleStaleWorker({
      ...state,
      lastHeartbeatAt: '2026-08-13T08:00:00.000Z',
    }, Date.parse('2026-08-13T08:01:00.000Z')).observedState,
    'running',
  )
})
