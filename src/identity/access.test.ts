import { test } from 'node:test'
import assert from 'node:assert/strict'
import { can, canViewCallContent } from './access.ts'

test('roles grant their own permissions; everything else is denied', () => {
  assert.equal(can(['call_auditor'], 'call:review'), true)
  assert.equal(can(['call_auditor'], 'billing:approve'), false)
  assert.equal(can(['finance_approver'], 'billing:approve'), true)
  assert.equal(can(['platform_admin'], 'user:manage'), true)
  assert.equal(can([], 'call:read'), false)
  assert.equal(can(['nonexistent_role'], 'call:read'), false)
})

test('multiple roles union their permissions', () => {
  assert.equal(can(['call_auditor', 'billing_analyst'], 'invoice:reconcile'), true)
  assert.equal(can(['call_auditor', 'billing_analyst'], 'call:review'), true)
})

test('a functional role does NOT by itself grant health-content access', () => {
  // billing_analyst can reconcile invoices, but content access is a separate control.
  assert.equal(can(['billing_analyst'], 'invoice:reconcile'), true)
  assert.equal(canViewCallContent('K1', 'K2'), false) // default ceiling can't open health audio
})

test('sensitivity gate: K2/K3 content requires an elevated ceiling', () => {
  assert.equal(canViewCallContent('K1', 'K1'), true) // general PII ok at default
  assert.equal(canViewCallContent('K1', 'K2'), false) // health denied by default
  assert.equal(canViewCallContent('K3', 'K2'), true)
  assert.equal(canViewCallContent('K3', 'K3'), true)
  assert.equal(canViewCallContent('K2', 'K3'), false) // ceiling below content tier
  assert.equal(canViewCallContent('K3', 'K0'), true)
})

test('K4 is never viewable, and unknown tiers deny', () => {
  assert.equal(canViewCallContent('K3', 'K4'), false)
  assert.equal(canViewCallContent('K1', 'K4'), false)
  assert.equal(canViewCallContent('K1', 'K9'), false)
  assert.equal(canViewCallContent('bogus', 'K1'), false)
})
