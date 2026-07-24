import { test } from 'node:test'
import assert from 'node:assert/strict'
import { toScaled, fromScaled, subtract, trend, trendWithDeadband, formatMoney } from './decimal.ts'

test('toScaled / fromScaled round-trip (no float drift)', () => {
  assert.equal(fromScaled(toScaled('82450.00000000')!), '82450')
  assert.equal(fromScaled(toScaled('0.10000000')!), '0.1')
  assert.equal(fromScaled(toScaled('-12.34')!), '-12.34')
  assert.equal(toScaled(null), null)
  assert.equal(toScaled('not-a-number'), null)
})

test('subtract is exact', () => {
  assert.equal(subtract('82450.00000000', '80310.00000000'), '2140')
  assert.equal(subtract('0.30', '0.10'), '0.2') // the classic float trap, exact here
  assert.equal(subtract('100', null), null)
})

test('trend compares without float', () => {
  assert.equal(trend('100', '90'), 'up')
  assert.equal(trend('90', '100'), 'down')
  assert.equal(trend('100', '100'), 'flat')
  assert.equal(trend('100', null), 'unknown')
})

test('trendWithDeadband treats movement within 2% as flat', () => {
  assert.equal(trendWithDeadband('101.50', '100'), 'flat')
  assert.equal(trendWithDeadband('102.01', '100'), 'up')
  assert.equal(trendWithDeadband('97.99', '100'), 'down')
  assert.equal(trendWithDeadband('0', '0'), 'flat')
  assert.equal(trendWithDeadband('1', '0'), 'up')
})

test('formatMoney rounds to 2dp with Indian grouping', () => {
  assert.equal(formatMoney('82450.00000000'), 'INR 82,450.00')
  assert.equal(formatMoney('1234567.5'), 'INR 12,34,567.50')
  assert.equal(formatMoney('-875.00000000'), '-INR 875.00')
  assert.equal(formatMoney(null), '—')
})
