import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DeadlineExceededError,
  isDeadlineExceeded,
  withDeadline,
} from './deadline.ts'

test('work that finishes in time is returned untouched', async () => {
  assert.equal(await withDeadline(Promise.resolve('value'), 1_000), 'value')
})

test('a genuine failure is reported as itself, not as a deadline', async () => {
  const failure = Object.assign(new Error('read failed'), { code: 'ER_X' })
  await assert.rejects(
    withDeadline(Promise.reject(failure), 1_000),
    (error) => error === failure,
  )
})

test('work that overruns rejects with a deadline error', async () => {
  const slow = new Promise((resolve) => setTimeout(resolve, 5_000).unref?.())
  await assert.rejects(
    withDeadline(slow, 20),
    (error) => error instanceof DeadlineExceededError &&
      isDeadlineExceeded(error),
  )
})

test('a read failing AFTER its deadline does not become an unhandled rejection', async () => {
  // This is the whole point. An unhandled rejection in a strict runtime ends
  // the process, which would turn one degraded card into an outage -- exactly
  // what the deadline exists to prevent.
  let rejectLate: ((reason: unknown) => void) | undefined
  const late = new Promise((_resolve, reject) => {
    rejectLate = reject
  })
  await assert.rejects(withDeadline(late, 20), isDeadlineExceeded)

  const unhandled: unknown[] = []
  const listener = (reason: unknown): void => {
    unhandled.push(reason)
  }
  process.on('unhandledRejection', listener)
  rejectLate?.(new Error('the read failed, long after anyone was waiting'))
  await new Promise((resolve) => setTimeout(resolve, 50))
  process.off('unhandledRejection', listener)
  assert.deepEqual(unhandled, [])
})

test('a non-positive deadline is a programming error, not a zero wait', async () => {
  await assert.rejects(
    () => withDeadline(Promise.resolve(1), 0),
    TypeError,
  )
})
