import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseMysqlTimeToSeconds } from './mysqlTime.ts'

test('parses a normal HH:MM:SS duration', () => {
  assert.equal(parseMysqlTimeToSeconds('00:00:00'), 0)
  assert.equal(parseMysqlTimeToSeconds('00:00:01'), 1)
  assert.equal(parseMysqlTimeToSeconds('00:01:30'), 90)
  assert.equal(parseMysqlTimeToSeconds('01:00:00'), 3600)
  assert.equal(parseMysqlTimeToSeconds('02:03:04'), 7384)
})

test('accepts MySQL TIME hours beyond a single day', () => {
  assert.equal(parseMysqlTimeToSeconds('24:00:00'), 86_400)
  assert.equal(parseMysqlTimeToSeconds('838:59:59'), 3_020_399)
})

test('truncates a fractional second to whole seconds', () => {
  assert.equal(parseMysqlTimeToSeconds('00:00:01.500000'), 1)
  assert.equal(parseMysqlTimeToSeconds('00:01:30.999999'), 90)
  assert.equal(parseMysqlTimeToSeconds('00:00:00.1'), 0)
})

test('always returns a whole non-negative integer', () => {
  for (const value of ['00:00:07', '00:02:13.750000', '10:10:10']) {
    const seconds = parseMysqlTimeToSeconds(value)
    assert.notEqual(seconds, null)
    assert.ok(Number.isInteger(seconds as number))
    assert.ok((seconds as number) >= 0)
  }
})

test('returns null for a missing or blank duration', () => {
  assert.equal(parseMysqlTimeToSeconds(null), null)
  assert.equal(parseMysqlTimeToSeconds(undefined), null)
  assert.equal(parseMysqlTimeToSeconds(''), null)
  assert.equal(parseMysqlTimeToSeconds('   '), null)
})

test('returns null for a negative duration rather than coercing it', () => {
  assert.equal(parseMysqlTimeToSeconds('-00:01:30'), null)
  assert.equal(parseMysqlTimeToSeconds('-1'), null)
})

test('returns null for malformed values instead of guessing', () => {
  for (const value of [
    '90',
    '1:2',
    '00:60:00',
    '00:00:60',
    '00:00',
    'abc',
    '00:0a:00',
    '0000:00:00',
    '00:00:00.',
    '2026-08-01 00:01:30',
  ]) {
    assert.equal(
      parseMysqlTimeToSeconds(value),
      null,
      `${value} must not parse as a duration`,
    )
  }
})

test('never confuses an unknown duration with zero', () => {
  assert.equal(parseMysqlTimeToSeconds(null), null)
  assert.notEqual(parseMysqlTimeToSeconds(null), 0)
  assert.equal(parseMysqlTimeToSeconds('00:00:00'), 0)
})

test('is deterministic', () => {
  assert.equal(
    parseMysqlTimeToSeconds('00:04:05'),
    parseMysqlTimeToSeconds('00:04:05'),
  )
})
