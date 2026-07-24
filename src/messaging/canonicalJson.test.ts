import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  canonicalJson,
  canonicalJsonSha256,
} from './canonicalJson.ts'

test('canonical JSON is stable across object key order', () => {
  const left = { z: 1, a: { y: true, x: 'value' } }
  const right = { a: { x: 'value', y: true }, z: 1 }
  assert.equal(canonicalJson(left), canonicalJson(right))
  assert.equal(
    canonicalJsonSha256(left),
    canonicalJsonSha256(right),
  )
})

test('canonical JSON preserves array order and rejects non-finite numbers', () => {
  assert.notEqual(
    canonicalJsonSha256([1, 2]),
    canonicalJsonSha256([2, 1]),
  )
  assert.throws(
    () => canonicalJson({ amount: Number.NaN }),
    /non-finite/,
  )
})
