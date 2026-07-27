import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  normalizeKairaliEmail,
  planAdminGrant,
  targetAdminAccessState,
} from './adminGrant.ts'

test('normalizes a Kairali administrator email', () => {
  assert.equal(
    normalizeKairaliEmail('  DME@KAIRALI.COM '),
    'dme@kairali.com',
  )
})

test('rejects malformed and non-Kairali administrator identities', () => {
  assert.throws(
    () => normalizeKairaliEmail('not-an-email'),
    /valid @kairali\.com/,
  )
  assert.throws(
    () => normalizeKairaliEmail('admin@example.test'),
    /valid @kairali\.com/,
  )
})

test('plans a full grant for a new identity', () => {
  assert.deepEqual(planAdminGrant('dme@kairali.com', null), {
    email: 'dme@kairali.com',
    userExists: false,
    activateUser: false,
    grantAdminRole: true,
    raiseSensitivityToK3: true,
    alreadyFullyAuthorized: false,
  })
})

test('plans only missing privileges for an existing user', () => {
  const plan = planAdminGrant('dme@kairali.com', {
    id: 'user-1',
    email: 'dme@kairali.com',
    status: 'active',
    maxSensitivityTier: 'K1',
    roles: ['user'],
  })
  assert.equal(plan.userExists, true)
  assert.equal(plan.activateUser, false)
  assert.equal(plan.grantAdminRole, true)
  assert.equal(plan.raiseSensitivityToK3, true)
  assert.equal(plan.alreadyFullyAuthorized, false)
})

test('recognizes an already fully authorized administrator', () => {
  const plan = planAdminGrant('dme@kairali.com', {
    id: 'user-1',
    email: 'dme@kairali.com',
    status: 'active',
    maxSensitivityTier: 'K3',
    roles: ['admin'],
  })
  assert.equal(plan.alreadyFullyAuthorized, true)
})

test('builds a deterministic full-access target state', () => {
  assert.deepEqual(
    targetAdminAccessState('dme@kairali.com', ['user', 'admin', 'user']),
    {
      email: 'dme@kairali.com',
      status: 'active',
      maxSensitivityTier: 'K3',
      roles: ['admin', 'user'],
    },
  )
})
