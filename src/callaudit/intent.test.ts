import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isCallIntent, parseCallIntent } from './intent.ts'
import { CALL_INTENTS, type CallIntent } from './types.ts'

test('exposes exactly the four explicit intent values', () => {
  assert.deepEqual([...CALL_INTENTS], ['HIGH', 'WARM', 'LOW', 'NONE'])
})

test('accepts every explicit intent value', () => {
  for (const intent of CALL_INTENTS) {
    assert.ok(isCallIntent(intent))
    assert.equal(parseCallIntent(intent), intent)
  }
})

test('normalizes case and surrounding whitespace', () => {
  assert.equal(parseCallIntent(' warm '), 'WARM')
  assert.equal(parseCallIntent('High'), 'HIGH')
  assert.equal(parseCallIntent('none'), 'NONE')
})

test('never reads a missing or blank intent as WARM', () => {
  for (const value of [null, undefined, '', '   ', 0, false, {}, []]) {
    assert.equal(parseCallIntent(value), null)
    assert.notEqual(parseCallIntent(value), 'WARM')
  }
})

test('rejects intents outside the explicit set', () => {
  assert.equal(parseCallIntent('MEDIUM'), null)
  assert.equal(parseCallIntent('WARM_LEAD'), null)
  assert.equal(parseCallIntent('null'), null)
  assert.equal(isCallIntent('MEDIUM'), false)
  assert.equal(isCallIntent(null), false)
})

test('keeps NONE distinct from an unparseable intent', () => {
  const none: CallIntent = 'NONE'
  assert.equal(parseCallIntent('NONE'), none)
  assert.notEqual(parseCallIntent('NONE'), null)
})
