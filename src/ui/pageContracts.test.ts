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
  assert.match(view.rateCardApprovalLabel, /publication pending/)
})

test('a published card does not make legacy calculations authoritative', () => {
  const raw = structuredClone(sampleFullRaw.billing)
  raw.rateCardStatus = 'published'
  raw.rateCardApprovedBy = 'finance@example.test'
  raw.rateCardApprovedAt = '2026-07-27T10:00:00Z'
  raw.authoritativeCalculations = 0
  const view = buildBillingView(raw)
  assert.equal(view.rateCardApproved, true)
  assert.equal(view.calculationsAuthoritative, false)
  assert.equal(view.cycle.status, 'audit_pending')
  assert.match(view.calculationAuthorityLabel, /Migration 0006/)
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

test('D-12 withholds verified revenue and variance before audit completion', () => {
  const views = buildRevenueSnapshots(sampleFullRaw.snapshots, {
    releaseVerifiedValues: false,
  })
  assert.equal(views[0]?.verified, 'Audit pending')
  assert.equal(views[0]?.variance, 'Audit pending')
  assert.equal(views[0]?.vendorClaimed, 'INR 19,100.00')
  assert.equal(views[0]?.trend, 'unknown')
})
