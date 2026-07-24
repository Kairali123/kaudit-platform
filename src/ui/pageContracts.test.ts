import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildBillingView,
  buildQualityView,
  buildRevenueSnapshots,
} from './fullDashboard.ts'
import { sampleFullRaw } from '../fixtures/fullDashboardSample.ts'

test('billing remains provisional when the newest rate card is not formally approved', () => {
  const view = buildBillingView(sampleFullRaw.billing)
  assert.equal(view.rateCardApproved, false)
  assert.match(view.rateCardApprovalLabel, /D-03 open/)
})

test('quality confidence is explicitly labeled as self-reported and uncalibrated', () => {
  const view = buildQualityView(
    sampleFullRaw.quality,
    sampleFullRaw.monitor.calls,
  )
  assert.equal(view.tiles[2]?.value, '90.2%')
  assert.match(view.tiles[2]?.sub ?? '', /not calibrated accuracy/)
})

test('D-12 contracts retain all four management cadences', () => {
  const views = buildRevenueSnapshots(sampleFullRaw.snapshots)
  assert.deepEqual(
    views.map((view) => view.cadence),
    ['weekly', 'monthly', 'quarterly', 'yearly'],
  )
})
