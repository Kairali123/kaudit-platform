import { test } from 'node:test'
import assert from 'node:assert/strict'
import { can, canGrantSensitivity, canViewCallContent } from './access.ts'

test('admin can do everything', () => {
  for (const p of ['user:manage', 'billing:approve', 'call:review', 'sensitivity:grant', 'anything:at:all']) {
    assert.equal(can(['admin'], p), true)
  }
})

test('user gets operational permissions but not admin actions', () => {
  assert.equal(can(['user'], 'call:review'), true)
  assert.equal(can(['user'], 'invoice:reconcile'), true)
  assert.equal(can(['user'], 'snapshot:read'), true)
  assert.equal(can(['user'], 'user:manage'), false)
  assert.equal(can(['user'], 'billing:approve'), false)
  assert.equal(can(['user'], 'sensitivity:grant'), false)
})

test('unassigned / unknown / no role grants nothing', () => {
  assert.equal(can(['unassigned'], 'call:read'), false)
  assert.equal(can([], 'call:read'), false)
  assert.equal(can(['whatever'], 'call:read'), false)
})

test('only admin may grant/change a health-content ceiling', () => {
  assert.equal(canGrantSensitivity(['admin']), true)
  assert.equal(canGrantSensitivity(['user']), false)
  assert.equal(canGrantSensitivity(['unassigned']), false)
})

test('sensitivity gate: K2/K3 content requires an elevated ceiling', () => {
  assert.equal(canViewCallContent('K1', 'K1'), true)
  assert.equal(canViewCallContent('K1', 'K2'), false) // health denied by default
  assert.equal(canViewCallContent('K3', 'K2'), true)
  assert.equal(canViewCallContent('K2', 'K3'), false)
  assert.equal(canViewCallContent('K3', 'K0'), true)
})

test('K4 is never viewable, and unknown tiers deny', () => {
  assert.equal(canViewCallContent('K3', 'K4'), false)
  assert.equal(canViewCallContent('K1', 'K9'), false)
  assert.equal(canViewCallContent('bogus', 'K1'), false)
})

test('roles and content access are orthogonal: an operational user still cannot open health audio', () => {
  assert.equal(can(['user'], 'call:review'), true)
  assert.equal(canViewCallContent('K1', 'K2'), false)
})
