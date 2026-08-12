import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isStoredPasswordHashValid } from '../auth/passwordHash.ts'
import {
  accountLifecycleFacts,
  ASSIGNABLE_ROLES,
  buildRevokedPasswordSentinel,
  buildUserAdministrationAuditEvent,
  isActiveAdmin,
  isTombstoned,
  MAX_PASSWORD_HASH_LENGTH,
  MAX_SESSION_VERSION,
  MIN_PASSWORD_HASH_LENGTH,
  nextSessionVersion,
  refuseLastActiveAdmin,
  refuseSelfTarget,
  removesAdminRole,
  requireAcceptablePassword,
  requireActivationFlag,
  requireActorUserId,
  requireAssignableRole,
  requireEmail,
  requireListWindow,
  requireManageableAccount,
  requireSessionVersion,
  requireStorablePasswordHash,
  requireTargetUserId,
  requireUsername,
  userLifecycleHash,
  UserAdminError,
  USER_ADMIN_AUDIT_ACTIONS,
  USER_ADMIN_AUDIT_CLIENT,
  USER_ADMIN_AUDIT_PURPOSE,
  USER_ADMIN_INPUT_CODES,
  USER_ADMIN_REFUSAL_CODES,
  USER_ADMIN_FAULT_CODES,
  USER_LIST_DEFAULT_LIMIT,
  USER_LIST_MAX_LIMIT,
  USER_LIST_MAX_OFFSET,
  type ManagedAccount,
} from './userAdministration.ts'

// ---------------------------------------------------------------------------
// Synthetic fixtures. Nothing here is a real person, handle, or secret.
// ---------------------------------------------------------------------------

const ACTOR_ID = 'usr-admin-0001'
const TARGET_ID = 'usr-target-0001'

function account(overrides: Partial<ManagedAccount> = {}): ManagedAccount {
  return {
    userId: TARGET_ID,
    kind: 'user',
    userStatus: 'active',
    email: 'reviewer@example.test',
    username: 'reviewer.one',
    credentialStatus: 'active',
    sessionVersion: 4,
    roles: ['user'],
    ...overrides,
  }
}

/** The code a synchronous call fails with, or a marker that it did not fail. */
function codeOf(run: () => unknown): string {
  try {
    run()
    return 'DID_NOT_THROW'
  } catch (error) {
    return error instanceof UserAdminError ? error.code : 'WRONG_ERROR_TYPE'
  }
}

function errorOf(run: () => unknown): UserAdminError {
  try {
    run()
    throw new Error('expected a UserAdminError')
  } catch (error) {
    assert.ok(error instanceof UserAdminError)
    return error
  }
}

// ---------------------------------------------------------------------------
// Input validation — every rejection happens here, before any statement.
// ---------------------------------------------------------------------------

test('an actor id is required, and must be an id shape', () => {
  assert.equal(requireActorUserId(ACTOR_ID), ACTOR_ID)
  for (const bad of [
    undefined,
    null,
    '',
    '   ',
    42,
    'has space',
    "'; DROP TABLE kaudit_user; --",
    'a'.repeat(41),
  ]) {
    assert.equal(
      codeOf(() => requireActorUserId(bad)),
      USER_ADMIN_INPUT_CODES.actorInvalid,
    )
  }
})

test('a target id is validated with the same rule but its own code', () => {
  assert.equal(requireTargetUserId(TARGET_ID), TARGET_ID)
  assert.equal(
    codeOf(() => requireTargetUserId('has space')),
    USER_ADMIN_INPUT_CODES.targetInvalid,
  )
})

test('the assignable roles are exactly the two that already exist', () => {
  assert.deepEqual([...ASSIGNABLE_ROLES], ['admin', 'user'])
  assert.equal(requireAssignableRole('admin'), 'admin')
  assert.equal(requireAssignableRole('user'), 'user')
  for (const bad of ['Admin', 'ADMIN', 'superadmin', 'unassigned', '', null]) {
    assert.equal(
      codeOf(() => requireAssignableRole(bad)),
      USER_ADMIN_INPUT_CODES.roleInvalid,
    )
  }
})

test('a malformed username or email is refused with a code, not the value', () => {
  assert.equal(requireUsername('  Reviewer.One  '), 'reviewer.one')
  assert.equal(requireEmail('  Reviewer@Example.test '), 'reviewer@example.test')

  const bad = '.reviewer-'
  const usernameError = errorOf(() => requireUsername(bad))
  assert.equal(usernameError.code, USER_ADMIN_INPUT_CODES.usernameMalformed)
  assert.equal(usernameError.message, usernameError.code)
  assert.ok(!usernameError.message.includes(bad))

  const badEmail = 'reviewer at example.test'
  const emailError = errorOf(() => requireEmail(badEmail))
  assert.equal(emailError.code, USER_ADMIN_INPUT_CODES.emailMalformed)
  assert.ok(!emailError.message.includes('reviewer'))
})

test('the password policy returns bounded codes and never the password', () => {
  const password = 'reviewer.one-IS-the-handle-9!'
  const error = errorOf(() =>
    requireAcceptablePassword(password, {
      username: 'reviewer.one',
      email: 'reviewer@example.test',
    }),
  )
  assert.equal(error.code, USER_ADMIN_INPUT_CODES.passwordPolicy)
  assert.equal(error.message, error.code)
  assert.ok(error.violations.includes('CONTAINS_IDENTITY'))
  const serialized = JSON.stringify({
    message: error.message,
    code: error.code,
    violations: error.violations,
  })
  assert.ok(!serialized.includes(password))
  assert.ok(!serialized.includes('reviewer'))

  assert.equal(
    codeOf(() => requireAcceptablePassword('short1!A', {})),
    USER_ADMIN_INPUT_CODES.passwordPolicy,
  )
  assert.equal(
    codeOf(() => requireAcceptablePassword(undefined, {})),
    USER_ADMIN_INPUT_CODES.passwordPolicy,
  )
  // An acceptable password is returned unchanged, and only here.
  const accepted = 'Synthetic#Pass7key'
  assert.equal(requireAcceptablePassword(accepted, {}), accepted)
})

test('the list window defaults, and is bounded in both directions', () => {
  assert.deepEqual(requireListWindow({}), {
    limit: USER_LIST_DEFAULT_LIMIT,
    offset: 0,
  })
  assert.deepEqual(requireListWindow({ limit: 10, offset: 20 }), {
    limit: 10,
    offset: 20,
  })
  for (const bad of [
    { limit: 0 },
    { limit: -1 },
    { limit: 1.5 },
    { limit: USER_LIST_MAX_LIMIT + 1 },
    { limit: '10' },
    { offset: -1 },
    { offset: USER_LIST_MAX_OFFSET + 1 },
    { offset: 2.5 },
  ]) {
    assert.equal(
      codeOf(() => requireListWindow(bad)),
      USER_ADMIN_INPUT_CODES.listWindowInvalid,
    )
  }
})

test('the activation flag is a boolean, not a truthy value', () => {
  assert.equal(requireActivationFlag(true), true)
  assert.equal(requireActivationFlag(false), false)
  for (const bad of ['true', 1, 0, null, undefined]) {
    assert.equal(
      codeOf(() => requireActivationFlag(bad)),
      USER_ADMIN_INPUT_CODES.activationFlagInvalid,
    )
  }
})

test('a session generation is a whole positive number within the column range', () => {
  assert.equal(requireSessionVersion(7), 7)
  assert.equal(requireSessionVersion('7'), 7)
  for (const bad of [0, -1, 3.5, '', 'x', null, undefined, MAX_SESSION_VERSION + 1]) {
    assert.equal(
      codeOf(() => requireSessionVersion(bad)),
      USER_ADMIN_FAULT_CODES.stateMalformed,
    )
  }
  assert.equal(nextSessionVersion(4), 5)
  assert.equal(
    codeOf(() => nextSessionVersion(MAX_SESSION_VERSION)),
    USER_ADMIN_REFUSAL_CODES.sessionVersionExhausted,
  )
})

// ---------------------------------------------------------------------------
// Lifecycle invariants.
// ---------------------------------------------------------------------------

test('only a real, credentialed, open account is manageable', () => {
  assert.equal(
    codeOf(() => requireManageableAccount(null)),
    USER_ADMIN_REFUSAL_CODES.userNotFound,
  )
  assert.equal(
    codeOf(() => requireManageableAccount(account({ kind: 'system' }))),
    USER_ADMIN_REFUSAL_CODES.userNotManageable,
  )
  assert.equal(
    codeOf(() =>
      requireManageableAccount(
        account({ credentialStatus: null, sessionVersion: null }),
      ),
    ),
    USER_ADMIN_REFUSAL_CODES.credentialNotFound,
  )
  for (const closed of [
    account({ credentialStatus: 'tombstoned' }),
    account({ userStatus: 'tombstoned' }),
  ]) {
    assert.equal(
      codeOf(() => requireManageableAccount(closed)),
      USER_ADMIN_REFUSAL_CODES.accountTombstoned,
    )
  }
  // A disabled account is recoverable, so it stays manageable.
  const disabled = account({
    userStatus: 'disabled',
    credentialStatus: 'disabled',
  })
  assert.equal(requireManageableAccount(disabled), disabled)
})

test('a tombstoned account is terminal on either side of the pair', () => {
  assert.equal(isTombstoned(account()), false)
  assert.equal(isTombstoned(account({ userStatus: 'tombstoned' })), true)
  assert.equal(isTombstoned(account({ credentialStatus: 'tombstoned' })), true)
})

test('an active admin is active on both rows, of kind user, and holds the role', () => {
  assert.equal(isActiveAdmin(account({ roles: ['admin'] })), true)
  assert.equal(isActiveAdmin(account({ roles: ['user'] })), false)
  assert.equal(
    isActiveAdmin(account({ roles: ['admin'], userStatus: 'disabled' })),
    false,
  )
  assert.equal(
    isActiveAdmin(account({ roles: ['admin'], credentialStatus: 'disabled' })),
    false,
  )
  assert.equal(isActiveAdmin(account({ roles: ['admin'], kind: 'system' })), false)
})

test('an administrator cannot deactivate, close, or demote their own account', () => {
  for (const code of [
    USER_ADMIN_REFUSAL_CODES.selfDeactivate,
    USER_ADMIN_REFUSAL_CODES.selfTombstone,
    USER_ADMIN_REFUSAL_CODES.selfDemote,
  ]) {
    assert.equal(codeOf(() => refuseSelfTarget(ACTOR_ID, ACTOR_ID, code)), code)
  }
  assert.equal(
    codeOf(() =>
      refuseSelfTarget(
        ACTOR_ID,
        TARGET_ID,
        USER_ADMIN_REFUSAL_CODES.selfDeactivate,
      ),
    ),
    'DID_NOT_THROW',
  )
})

test('the last active administrator is never removed from the installation', () => {
  const admin = account({ roles: ['admin'] })
  assert.equal(
    codeOf(() => refuseLastActiveAdmin(admin, 0)),
    USER_ADMIN_REFUSAL_CODES.lastAdmin,
  )
  assert.equal(codeOf(() => refuseLastActiveAdmin(admin, 1)), 'DID_NOT_THROW')
  // Someone who is not currently an active admin cannot be the last one.
  assert.equal(
    codeOf(() => refuseLastActiveAdmin(account({ roles: ['user'] }), 0)),
    'DID_NOT_THROW',
  )
  assert.equal(
    codeOf(() =>
      refuseLastActiveAdmin(
        account({ roles: ['admin'], credentialStatus: 'disabled' }),
        0,
      ),
    ),
    'DID_NOT_THROW',
  )
})

test('only a change that takes the admin role away counts as a demotion', () => {
  assert.equal(removesAdminRole(account({ roles: ['admin'] }), 'user'), true)
  assert.equal(removesAdminRole(account({ roles: ['admin'] }), 'admin'), false)
  assert.equal(removesAdminRole(account({ roles: ['user'] }), 'user'), false)
  assert.equal(removesAdminRole(account({ roles: ['user'] }), 'admin'), false)
})

// ---------------------------------------------------------------------------
// The audit representation.
// ---------------------------------------------------------------------------

test('the lifecycle hash covers control facts and no identity value', () => {
  const withOneIdentity = accountLifecycleFacts(account())
  const withAnother = accountLifecycleFacts(
    account({ username: 'someone.else', email: 'someone.else@example.test' }),
  )
  // Same lifecycle state, different person-identifying values: same hash. The
  // username and email are not inputs to it, and cannot be recovered from it.
  assert.equal(
    userLifecycleHash(withOneIdentity),
    userLifecycleHash(withAnother),
  )
  assert.match(userLifecycleHash(withOneIdentity), /^[0-9a-f]{64}$/)

  // Every fact it DOES cover moves it.
  const base = accountLifecycleFacts(account())
  for (const changed of [
    { ...base, userStatus: 'disabled' },
    { ...base, credentialStatus: 'tombstoned' },
    { ...base, roles: ['admin'] },
    { ...base, sessionVersion: base.sessionVersion + 1 },
    { ...base, userId: 'usr-other-0002' },
  ]) {
    assert.notEqual(userLifecycleHash(base), userLifecycleHash(changed))
  }
  // Role order is not a fact.
  assert.equal(
    userLifecycleHash({ ...base, roles: ['admin', 'user'] }),
    userLifecycleHash({ ...base, roles: ['user', 'admin'] }),
  )
})

test('the audit event names ids, an action, and nothing about the person', () => {
  const occurredAt = new Date('2026-08-12T10:00:00.000Z')
  const event = buildUserAdministrationAuditEvent({
    action: USER_ADMIN_AUDIT_ACTIONS.deactivated,
    actorUserId: ACTOR_ID,
    targetUserId: TARGET_ID,
    beforeHash: userLifecycleHash(accountLifecycleFacts(account())),
    afterHash: userLifecycleHash(
      accountLifecycleFacts(account({ credentialStatus: 'disabled' })),
    ),
    correlationId: 'corr-0001',
    occurredAt,
  })
  assert.equal(event.actorUserId, ACTOR_ID)
  assert.equal(event.actorEmail, null)
  assert.equal(event.ipAddress, null)
  assert.equal(event.resourceType, 'kaudit_user')
  assert.equal(event.resourceId, TARGET_ID)
  assert.equal(event.outcome, 'success')
  assert.equal(event.purpose, USER_ADMIN_AUDIT_PURPOSE)
  assert.equal(event.client, USER_ADMIN_AUDIT_CLIENT)
  assert.equal(event.occurredAt, occurredAt)

  const serialized = JSON.stringify(event)
  for (const identity of ['reviewer.one', 'reviewer@example.test', 'scrypt']) {
    assert.ok(!serialized.includes(identity))
  }
})

// ---------------------------------------------------------------------------
// The revocation sentinel.
// ---------------------------------------------------------------------------

test('the tombstone sentinel is random, storable, and unverifiable', () => {
  const first = buildRevokedPasswordSentinel()
  const second = buildRevokedPasswordSentinel()
  assert.notEqual(first, second)
  assert.ok(first.startsWith('revoked$'))
  assert.ok(first.length >= MIN_PASSWORD_HASH_LENGTH)
  assert.ok(first.length <= MAX_PASSWORD_HASH_LENGTH)
  // The whole point: nothing can parse it, so nothing can verify against it.
  assert.equal(isStoredPasswordHashValid(first), false)
})

test('a hash that the column would reject is a fault, not a write', () => {
  const usable = 'scrypt$N=16384,r=8,p=1$c2FsdHNhbHRzYWx0c2E$ZGlnZXN0ZGlnZXN0ZGln'
  assert.equal(requireStorablePasswordHash(usable), usable)
  for (const bad of ['', 'too-short', 'x'.repeat(MAX_PASSWORD_HASH_LENGTH + 1)]) {
    assert.equal(
      codeOf(() => requireStorablePasswordHash(bad)),
      USER_ADMIN_FAULT_CODES.hashUnusable,
    )
  }
})
