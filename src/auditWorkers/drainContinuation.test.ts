import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  decideBatchFaultResponse,
  decideDrainContinuation,
  isRetryableInfrastructureCategory,
} from './drainContinuation.ts'
import { REAUDIT_ERROR_CATEGORIES } from '../reaudit/failures.ts'

const BASE = {
  selected: 0,
  deferredDueInMs: null as number | null,
  remainingMs: 60 * 60_000,
  maxWaitMs: 15_000,
  horizonMs: 60 * 60_000,
}

test('a batch that claimed work always goes round again', () => {
  assert.deepEqual(
    decideDrainContinuation({ ...BASE, selected: 10 }),
    { action: 'continue' },
  )
})

test('an empty queue with no deferred retry is a real drain', () => {
  assert.deepEqual(
    decideDrainContinuation({ ...BASE, selected: 0, deferredDueInMs: null }),
    { action: 'stop', reason: 'drained' },
  )
})

test('an empty batch with a deferred retry waits instead of reporting drained', () => {
  // The exact production shape: every remaining recording-backed call is
  // serving a retry backoff, so the eligibility read returns nothing.
  assert.deepEqual(
    decideDrainContinuation({
      ...BASE,
      selected: 0,
      deferredDueInMs: 8 * 60_000,
    }),
    { action: 'wait', waitMs: 15_000 },
  )
})

test('one wait never outlasts the control heartbeat window', () => {
  const decision = decideDrainContinuation({
    ...BASE,
    deferredDueInMs: 30 * 60_000,
    maxWaitMs: 15_000,
  })
  assert.deepEqual(decision, { action: 'wait', waitMs: 15_000 })
})

test('a retry already due is claimed immediately', () => {
  assert.deepEqual(
    decideDrainContinuation({ ...BASE, deferredDueInMs: 0 }),
    { action: 'continue' },
  )
  assert.deepEqual(
    decideDrainContinuation({ ...BASE, deferredDueInMs: -5_000 }),
    { action: 'continue' },
  )
})

test('a shorter deferral than the heartbeat window is waited exactly', () => {
  assert.deepEqual(
    decideDrainContinuation({ ...BASE, deferredDueInMs: 4_200 }),
    { action: 'wait', waitMs: 4_200 },
  )
})

test('deferred work beyond the hand-over horizon ends the run explicitly', () => {
  assert.deepEqual(
    decideDrainContinuation({
      ...BASE,
      deferredDueInMs: 6 * 60 * 60_000,
      horizonMs: 60 * 60_000,
      remainingMs: 5 * 60 * 60_000,
    }),
    { action: 'stop', reason: 'deferred_beyond_horizon' },
  )
})

test('the host deadline wins over both claimed and deferred work', () => {
  assert.deepEqual(
    decideDrainContinuation({ ...BASE, selected: 10, remainingMs: 0 }),
    { action: 'stop', reason: 'deadline' },
  )
  assert.deepEqual(
    decideDrainContinuation({
      ...BASE,
      deferredDueInMs: 10 * 60_000,
      remainingMs: 9 * 60_000,
    }),
    { action: 'stop', reason: 'deadline' },
  )
})

test('a wait never runs past the deadline', () => {
  assert.deepEqual(
    decideDrainContinuation({
      ...BASE,
      deferredDueInMs: 5_000,
      remainingMs: 6_000,
      maxWaitMs: 15_000,
    }),
    { action: 'wait', waitMs: 5_000 },
  )
})

test('continuation inputs are validated rather than silently coerced', () => {
  assert.throws(
    () => decideDrainContinuation({ ...BASE, selected: -1 }),
    RangeError,
  )
  assert.throws(
    () => decideDrainContinuation({ ...BASE, maxWaitMs: 0 }),
    RangeError,
  )
  assert.throws(
    () => decideDrainContinuation({ ...BASE, horizonMs: -1 }),
    RangeError,
  )
  assert.throws(
    () =>
      decideDrainContinuation({ ...BASE, deferredDueInMs: Number.NaN }),
    RangeError,
  )
})

const FAULT = {
  category: 'DB_CONNECTION_TIMEOUT' as const,
  consecutiveFaults: 1,
  maxConsecutiveFaults: 5,
  remainingMs: 60 * 60_000,
  baseBackoffMs: 15_000,
  maxBackoffMs: 120_000,
}

test('only contention and connectivity categories are retryable', () => {
  const retryable = REAUDIT_ERROR_CATEGORIES.filter(
    isRetryableInfrastructureCategory,
  )
  assert.deepEqual(retryable, [
    'DB_CONNECTION_LIMIT',
    'DB_CONNECTION_TIMEOUT',
    'DB_LOCK_TIMEOUT',
    'DB_DEADLOCK',
  ])
})

test('a transient database fault does not end a bounded drain', () => {
  assert.deepEqual(
    decideBatchFaultResponse(FAULT),
    { action: 'retry', waitMs: 15_000 },
  )
})

test('repeated faults back off exponentially up to the cap', () => {
  const waits = [1, 2, 3, 4].map(
    (consecutiveFaults) =>
      decideBatchFaultResponse({ ...FAULT, consecutiveFaults }),
  )
  assert.deepEqual(waits, [
    { action: 'retry', waitMs: 15_000 },
    { action: 'retry', waitMs: 30_000 },
    { action: 'retry', waitMs: 60_000 },
    { action: 'retry', waitMs: 120_000 },
  ])
})

test('a deterministic failure is never retried', () => {
  for (const category of ['DB_CONSTRAINT', 'DB_UNKNOWN', 'WORKER_LOCK_BUSY', 'WORKER_LIFECYCLE'] as const) {
    assert.deepEqual(
      decideBatchFaultResponse({ ...FAULT, category }),
      { action: 'stop' },
      category,
    )
  }
})

test('retrying is bounded by a consecutive-fault ceiling and the deadline', () => {
  assert.deepEqual(
    decideBatchFaultResponse({ ...FAULT, consecutiveFaults: 5 }),
    { action: 'stop' },
  )
  assert.deepEqual(
    decideBatchFaultResponse({ ...FAULT, remainingMs: 0 }),
    { action: 'stop' },
  )
})

test('a backoff never runs past the deadline', () => {
  assert.deepEqual(
    decideBatchFaultResponse({ ...FAULT, remainingMs: 3_000 }),
    { action: 'retry', waitMs: 3_000 },
  )
})

test('fault inputs are validated rather than silently coerced', () => {
  assert.throws(
    () => decideBatchFaultResponse({ ...FAULT, consecutiveFaults: 0 }),
    RangeError,
  )
  assert.throws(
    () => decideBatchFaultResponse({ ...FAULT, baseBackoffMs: 0 }),
    RangeError,
  )
  assert.throws(
    () => decideBatchFaultResponse({ ...FAULT, maxConsecutiveFaults: 0 }),
    RangeError,
  )
})
