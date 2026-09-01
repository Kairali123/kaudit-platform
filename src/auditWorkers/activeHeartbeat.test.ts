import { test } from 'node:test'
import assert from 'node:assert/strict'
import { startActiveHeartbeat } from './activeHeartbeat.ts'

test('active heartbeat records on the configured cadence and stops cleanly', async () => {
  let tick: (() => void) | undefined
  let canceled = false
  let records = 0
  const heartbeat = startActiveHeartbeat({
    intervalMs: 60_000,
    async record() { records += 1 },
    schedule(callback, intervalMs) {
      assert.equal(intervalMs, 60_000)
      tick = callback
      return 'timer'
    },
    cancel(timer) {
      assert.equal(timer, 'timer')
      canceled = true
    },
  })

  tick?.()
  await heartbeat.stop()
  tick?.()

  assert.equal(records, 1)
  assert.equal(canceled, true)
})

test('active heartbeat serializes writes and survives a failed tick', async () => {
  let tick: (() => void) | undefined
  let active = 0
  let maximumActive = 0
  let calls = 0
  let releaseFirst: (() => void) | undefined
  const first = new Promise<void>((resolve) => { releaseFirst = resolve })
  const heartbeat = startActiveHeartbeat({
    intervalMs: 1,
    async record() {
      calls += 1
      active += 1
      maximumActive = Math.max(maximumActive, active)
      if (calls === 1) await first
      active -= 1
      if (calls === 2) throw new Error('synthetic')
    },
    schedule(callback) {
      tick = callback
      return 'timer'
    },
    cancel() {},
  })

  tick?.()
  tick?.()
  releaseFirst?.()
  await heartbeat.stop()

  assert.equal(calls, 2)
  assert.equal(maximumActive, 1)
})

test('active heartbeat rejects an unsafe interval', () => {
  assert.throws(
    () => startActiveHeartbeat({ intervalMs: 0, async record() {} }),
    /heartbeat interval/,
  )
})
