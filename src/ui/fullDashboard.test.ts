import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildFullDashboard } from './fullDashboard.ts'
import { sampleFullRaw } from '../fixtures/fullDashboardSample.ts'

test('builds all four dashboard sections and keeps gates visible', () => {
  const v = buildFullDashboard(sampleFullRaw)
  assert.equal(v.accessControlEnforced, false)
  assert.equal(v.overviewTiles.length, 8)
  assert.equal(v.quality.tiles[2].value, '90.2%')
  assert.equal(v.billing.rateCardApproved, false)
  assert.match(v.billing.rateCardApprovalLabel, /D-03/)
  assert.equal(v.snapshots[0].variance, 'INR 650.00')
  assert.equal(v.snapshots[0].trend, 'flat') // +1.37% is within 2% dead-band
})

test('does not fabricate unavailable billing values', () => {
  const raw = structuredClone(sampleFullRaw)
  raw.billing.calculatedTotal = null
  raw.billing.claimedSubtotal = null
  raw.billing.netVariance = null
  const v = buildFullDashboard(raw)
  assert.equal(v.billing.tiles[0].value, '—')
  assert.equal(v.billing.tiles[1].value, '—')
  assert.equal(v.billing.tiles[2].value, '—')
})
