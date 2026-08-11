import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  isCanonicalSourceRowId,
  MAX_SIGNED_BIGINT,
  normalizeSourceRowId,
} from './sourceRowId.ts'

test('accepts a canonical positive decimal string', () => {
  for (const value of ['1', '42', '4021', '999999999999']) {
    assert.ok(isCanonicalSourceRowId(value))
    assert.equal(normalizeSourceRowId(value), value)
  }
})

test('preserves a BIGINT beyond the safe-integer range exactly', () => {
  // 9007199254740993 is 2^53 + 1: Number cannot represent it, so any code path
  // through a JavaScript number would silently return 9007199254740992.
  const beyondSafe = '9007199254740993'
  assert.equal(normalizeSourceRowId(beyondSafe), beyondSafe)
  assert.notEqual(normalizeSourceRowId(beyondSafe), '9007199254740992')
  assert.equal(String(Number(beyondSafe)), '9007199254740992')

  for (const value of [
    '9007199254740992',
    '9007199254740993',
    '9007199254740994',
  ]) {
    assert.equal(normalizeSourceRowId(value), value)
  }
})

test('accepts the signed BIGINT maximum and rejects one above it', () => {
  assert.equal(normalizeSourceRowId(MAX_SIGNED_BIGINT), '9223372036854775807')
  assert.equal(normalizeSourceRowId('9223372036854775806'), '9223372036854775806')
  assert.equal(normalizeSourceRowId('9223372036854775808'), null)
  assert.equal(normalizeSourceRowId('9999999999999999999'), null)
  assert.equal(normalizeSourceRowId('99999999999999999999'), null)
})

test('rejects zero, negatives, and explicit signs', () => {
  for (const value of ['0', '00', '-1', '-9007199254740993', '+1', '+0']) {
    assert.equal(
      normalizeSourceRowId(value),
      null,
      `${value} must be rejected`,
    )
    assert.equal(isCanonicalSourceRowId(value), false)
  }
})

test('rejects decimals, exponents, and leading zeros', () => {
  for (const value of [
    '1.0',
    '1.5',
    '1e3',
    '0x10',
    '007',
    '0042',
    '1_000',
    ' 1 2 ',
  ]) {
    assert.equal(
      normalizeSourceRowId(value),
      null,
      `${value} must be rejected`,
    )
  }
})

test('trims surrounding whitespace but nothing else', () => {
  assert.equal(normalizeSourceRowId('  4021  '), '4021')
  assert.equal(normalizeSourceRowId('\t4021\n'), '4021')
})

test('rejects blank and non-numeric text', () => {
  for (const value of ['', '   ', 'abc', 'null', 'NaN', 'Infinity']) {
    assert.equal(normalizeSourceRowId(value), null)
  }
})

test('converts a safe positive number for test ergonomics', () => {
  assert.equal(normalizeSourceRowId(1), '1')
  assert.equal(normalizeSourceRowId(4021), '4021')
  assert.equal(
    normalizeSourceRowId(Number.MAX_SAFE_INTEGER),
    '9007199254740991',
  )
})

test('rejects an unsafe number rather than trusting a rounded value', () => {
  for (const value of [
    0,
    -1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 1,
    Number.MAX_SAFE_INTEGER + 2,
    Number.MAX_VALUE,
    9007199254740993,
  ]) {
    assert.equal(
      normalizeSourceRowId(value),
      null,
      `${value} must be rejected as an unsafe number`,
    )
  }
})

test('accepts a bigint within range', () => {
  assert.equal(normalizeSourceRowId(9007199254740993n), '9007199254740993')
  assert.equal(normalizeSourceRowId(0n), null)
  assert.equal(normalizeSourceRowId(-5n), null)
  assert.equal(normalizeSourceRowId(9223372036854775808n), null)
})

test('rejects values that are not strings, numbers, or bigints', () => {
  for (const value of [null, undefined, {}, [], true, false, Symbol('1')]) {
    assert.equal(normalizeSourceRowId(value), null)
  }
})

test('is deterministic', () => {
  assert.equal(
    normalizeSourceRowId('9007199254740993'),
    normalizeSourceRowId('9007199254740993'),
  )
})
