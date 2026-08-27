import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  asReauditFatalError,
  classifyErrorCategory,
  REAUDIT_ERROR_CATEGORIES,
  ReauditFatalError,
} from './failures.ts'

test('driver codes map onto the allowlisted categories', () => {
  const cases: Array<[string, string]> = [
    ['ER_CON_COUNT_ERROR', 'DB_CONNECTION_LIMIT'],
    ['ER_TOO_MANY_USER_CONNECTIONS', 'DB_CONNECTION_LIMIT'],
    ['ETIMEDOUT', 'DB_CONNECTION_TIMEOUT'],
    ['PROTOCOL_CONNECTION_LOST', 'DB_CONNECTION_TIMEOUT'],
    ['ECONNREFUSED', 'DB_CONNECTION_TIMEOUT'],
    ['ER_LOCK_WAIT_TIMEOUT', 'DB_LOCK_TIMEOUT'],
    ['ER_LOCK_DEADLOCK', 'DB_DEADLOCK'],
    ['ER_DUP_ENTRY', 'DB_CONSTRAINT'],
  ]
  for (const [code, expected] of cases) {
    const error = Object.assign(new Error('synthetic driver detail'), { code })
    assert.equal(classifyErrorCategory(error), expected, code)
  }
})

test('errno fallbacks classify lock waits and deadlocks', () => {
  assert.equal(
    classifyErrorCategory(Object.assign(new Error('x'), { errno: 1205 })),
    'DB_LOCK_TIMEOUT',
  )
  assert.equal(
    classifyErrorCategory(Object.assign(new Error('x'), { errno: 1213 })),
    'DB_DEADLOCK',
  )
})

test('unknown failures collapse to a bounded catch-all, never the raw message', () => {
  const category = classifyErrorCategory(
    new Error('secret host db-7.internal.example: value 42 leaked'),
  )
  assert.equal(category, 'DB_UNKNOWN')
  assert.ok(REAUDIT_ERROR_CATEGORIES.includes(category))
})

test('fatal errors carry phase + category only', () => {
  const raw = Object.assign(new Error('synthetic'), {
    code: 'ER_LOCK_WAIT_TIMEOUT',
  })
  const fatal = asReauditFatalError('persist', raw)
  assert.ok(fatal instanceof ReauditFatalError)
  assert.equal(fatal.phase, 'persist')
  assert.equal(fatal.category, 'DB_LOCK_TIMEOUT')
  // The bounded message never quotes the original.
  assert.ok(!String(fatal).includes('synthetic'))
})

test('a pool-acquisition tag reassigns the phase', () => {
  const raw = Object.assign(new Error('synthetic'), {
    code: 'ETIMEDOUT',
  })
  ;(raw as { kauditPhase?: string }).kauditPhase = 'pool_acquisition'
  const fatal = asReauditFatalError('claim', raw)
  assert.equal(fatal.phase, 'pool_acquisition')
  assert.equal(fatal.category, 'DB_CONNECTION_TIMEOUT')
})
