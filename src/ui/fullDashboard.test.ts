import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildBillingView, buildFullDashboard } from './fullDashboard.ts'
import { sampleFullRaw } from '../fixtures/fullDashboardSample.ts'

test('builds all four dashboard sections and keeps gates visible', () => {
  const v = buildFullDashboard(sampleFullRaw)
  assert.equal(v.accessControlEnforced, false)
  assert.equal(v.overviewTiles.length, 8)
  assert.equal(v.quality.tiles[2].value, '90.2%')
  assert.equal(v.billing.rateCardApproved, false)
  assert.match(v.billing.rateCardApprovalLabel, /D-03/)
  assert.equal(v.snapshots[0].variance, 'Audit pending')
  assert.equal(v.snapshots[0].trend, 'unknown')
})

test('withholds billing values while the cycle audit is pending', () => {
  const raw = structuredClone(sampleFullRaw)
  raw.billing.calculatedTotal = null
  raw.billing.claimedSubtotal = null
  raw.billing.netVariance = null
  const v = buildFullDashboard(raw)
  assert.equal(v.billing.tiles[0].value, 'Audit pending')
  assert.equal(v.billing.tiles[2].value, '0 / 43,245')
  assert.equal(v.billing.tiles[3].value, '43,245')
})

function billingTilesFor(
  overrides: Record<string, unknown>,
): { label: string; value: string; sub?: string }[] {
  const raw = structuredClone(sampleFullRaw)
  // The money tiles only render once the cycle is resolved; the shipped
  // fixture is deliberately audit-pending.
  Object.assign(raw.billing.cycle, {
    completedAuditCalls: raw.billing.cycle.totalCalls,
    acceptedAsBilledCalls: 0,
    finalCalculationCalls: raw.billing.cycle.totalCalls,
    unresolvedDecisionCalls: 0,
    calculatedTotal: '134752.75',
    billableMinutes: '17104.5',
  })
  raw.billing.rateCardStatus = 'published'
  raw.billing.rateCardApprovedBy = 'finance@example.invalid'
  raw.billing.rateCardApprovedAt = '2026-06-30T12:00:00.000Z'
  raw.billing.calculatedTotal = '134752.75'
  raw.billing.verifiedSubtotal = '134752.75'
  Object.assign(raw.billing, overrides)
  // Calibration is an option to the view, not fixture data.
  return buildBillingView(raw.billing, { calibrationComplete: true }).tiles
}

test('a stored vendor invoice shows as the claim before any reconciliation', () => {
  // The claim is a fact recorded at invoice import; a reconciliation is a
  // later, separate act of agreeing it. Reading the claim only from the
  // reconciliation left a month with a perfectly good invoice showing no
  // vendor claim and, because the variance subtracts from it, no variance —
  // the two numbers the page exists to compare.
  const tiles = billingTilesFor({
    claimedSubtotal: '179108.25',
    claimedSubtotalBasis: 'vendor_invoice',
    reconciliationStatus: null,
    netVariance: null,
  })
  const claim = tiles.find((tile) => tile.label === 'Invoice / vendor claim')
  assert.ok(claim)
  assert.match(claim.value, /1,79,108\.25/)
  assert.equal(claim.sub, 'vendor invoice — reconciliation not started')

  const variance = tiles.find((tile) => tile.label === 'Variance identified')
  assert.ok(variance)
  assert.notEqual(variance.value, '—')
  // It must not be presented as a settled recovery.
  assert.equal(
    variance.sub,
    'claim minus verified — not a closed reconciliation',
  )
})

test('a closed reconciliation still wins over the raw invoice', () => {
  const tiles = billingTilesFor({
    claimedSubtotal: '175000.00',
    claimedSubtotalBasis: 'reconciled',
    reconciliationStatus: 'closed',
    netVariance: '40000.00',
  })
  assert.equal(
    tiles.find((tile) => tile.label === 'Invoice / vendor claim')?.sub,
    'reconciliation: closed',
  )
  assert.equal(
    tiles.find((tile) => tile.label === 'Variance identified')?.sub,
    'identified — not recovered savings',
  )
})

test('no invoice at all still says so plainly', () => {
  const tiles = billingTilesFor({
    claimedSubtotal: null,
    claimedSubtotalBasis: 'unavailable',
    reconciliationStatus: null,
  })
  const claim = tiles.find((tile) => tile.label === 'Invoice / vendor claim')
  assert.equal(claim?.value, '—')
  assert.equal(claim?.sub, 'no vendor invoice recorded')
})
