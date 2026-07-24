import { test } from 'node:test'
import assert from 'node:assert/strict'
import { completedPeriods } from './periods.ts'

test('completed periods use ISO weeks and Apr-Mar fiscal boundaries', () => {
  const byCadence = Object.fromEntries(completedPeriods('2026-07-24').map((p) => [p.cadence, p]))
  assert.deepEqual(
    [byCadence.weekly.start, byCadence.weekly.end],
    ['2026-07-13', '2026-07-19'],
  )
  assert.deepEqual(
    [byCadence.monthly.start, byCadence.monthly.end],
    ['2026-06-01', '2026-06-30'],
  )
  assert.deepEqual(
    [byCadence.quarterly.start, byCadence.quarterly.end],
    ['2026-04-01', '2026-06-30'],
  )
  assert.deepEqual(
    [byCadence.yearly.start, byCadence.yearly.end],
    ['2025-04-01', '2026-03-31'],
  )
})

test('January resolves to the previous completed Oct-Dec quarter and prior FY', () => {
  const byCadence = Object.fromEntries(completedPeriods('2026-01-02').map((p) => [p.cadence, p]))
  assert.deepEqual(
    [byCadence.quarterly.start, byCadence.quarterly.end],
    ['2025-10-01', '2025-12-31'],
  )
  assert.deepEqual(
    [byCadence.yearly.start, byCadence.yearly.end],
    ['2024-04-01', '2025-03-31'],
  )
})
