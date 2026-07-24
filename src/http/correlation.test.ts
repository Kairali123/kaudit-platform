import { test } from 'node:test'
import assert from 'node:assert/strict'
import { correlationId } from './correlation.ts'

test('preserves only bounded safe incoming correlation IDs', () => {
  assert.equal(correlationId('request-1234'), 'request-1234')
  assert.notEqual(correlationId('bad value'), 'bad value')
  assert.notEqual(correlationId('x'), 'x')
})
