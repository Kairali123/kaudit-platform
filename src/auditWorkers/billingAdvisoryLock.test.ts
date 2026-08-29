import assert from 'node:assert/strict'
import test from 'node:test'
import {
  acquireBillingAuditLock,
  BILLING_AUDIT_LOCK_ERROR_CODE,
} from './billingAdvisoryLock.ts'

test('acquires the Billing lock immediately without sleeping', async () => {
  let waits = 0
  const acquired = await acquireBillingAuditLock({
    tryAcquire: async () => true,
    timeoutMs: 30_000,
    retryMs: 1_000,
    wait: async () => {
      waits += 1
    },
  })
  assert.equal(acquired, true)
  assert.equal(waits, 0)
})

test('retries a busy lock and acquires it within the bound', async () => {
  let attempts = 0
  let nowMs = 0
  const waits: number[] = []
  const acquired = await acquireBillingAuditLock({
    tryAcquire: async () => {
      attempts += 1
      return attempts === 3
    },
    timeoutMs: 30_000,
    retryMs: 1_000,
    now: () => nowMs,
    wait: async (ms) => {
      waits.push(ms)
      nowMs += ms
    },
  })
  assert.equal(acquired, true)
  assert.equal(attempts, 3)
  assert.deepEqual(waits, [1_000, 1_000])
})

test('a persistently busy lock stops at the timeout', async () => {
  let attempts = 0
  let nowMs = 0
  const acquired = await acquireBillingAuditLock({
    tryAcquire: async () => {
      attempts += 1
      return false
    },
    timeoutMs: 2_500,
    retryMs: 1_000,
    now: () => nowMs,
    wait: async (ms) => {
      nowMs += ms
    },
  })
  assert.equal(acquired, false)
  assert.equal(attempts, 4)
  assert.equal(nowMs, 2_500)
})

test('lock contention has one bounded public error code', () => {
  assert.equal(BILLING_AUDIT_LOCK_ERROR_CODE, 'BILLING_AUDIT_LOCK_BUSY')
  assert.match(BILLING_AUDIT_LOCK_ERROR_CODE, /^[A-Z0-9_]{1,80}$/)
})

test('invalid retry bounds fail before an acquisition attempt', async () => {
  let attempts = 0
  await assert.rejects(
    acquireBillingAuditLock({
      tryAcquire: async () => {
        attempts += 1
        return true
      },
      timeoutMs: -1,
      retryMs: 0,
      wait: async () => undefined,
    }),
    /lock timeout/,
  )
  assert.equal(attempts, 0)
})
