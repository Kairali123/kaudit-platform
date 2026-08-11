import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  BillingMonthError,
  parseBillingMonth,
  previousBillingMonth,
} from './billingMonth.ts'

test('resolves a billing month to exact calendar boundaries', () => {
  assert.deepEqual(parseBillingMonth('2026-04'), {
    month: '2026-04',
    start: '2026-04-01',
    end: '2026-04-30',
    label: 'April 2026',
  })
  assert.equal(parseBillingMonth('all'), null)
  assert.equal(parseBillingMonth(null), null)
})

test('handles previous-month year boundaries and rejects malformed values', () => {
  assert.equal(
    previousBillingMonth(parseBillingMonth('2026-01')!).month,
    '2025-12',
  )
  assert.throws(() => parseBillingMonth('April-2026'), BillingMonthError)
  assert.throws(() => parseBillingMonth('2026-13'), BillingMonthError)
})
