import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildOidcBindingAuditEvent,
  normalizeOidcBinding,
  oidcBindingHash,
  OidcBindingInputError,
  OIDC_BINDING_AUDIT_ACTION,
  OIDC_BINDING_AUDIT_CLIENT,
  OIDC_BIND_ENV,
  OIDC_BIND_EXECUTE_MODE,
  OIDC_BIND_INPUT_CODES,
  OIDC_BIND_REFUSAL_CODES,
  planOidcBinding,
  type NormalizedOidcBinding,
  type OidcBindingTargetUser,
} from './oidcBinding.ts'

// ---------------------------------------------------------------------------
// Synthetic fixtures. No real identity, provider account, or subject anywhere.
// ---------------------------------------------------------------------------

const EMAIL = 'dme@kairali.com'
const ISSUER = 'https://accounts.example.test'
const SUBJECT = '100000000000000000001'

const REQUEST: NormalizedOidcBinding = {
  email: EMAIL,
  issuer: ISSUER,
  subject: SUBJECT,
}

function input(overrides: Partial<Record<'email' | 'issuer' | 'subject', string | undefined>> = {}) {
  return {
    email: EMAIL,
    issuer: ISSUER,
    subject: SUBJECT,
    ...overrides,
  }
}

function user(
  overrides: Partial<OidcBindingTargetUser> = {},
): OidcBindingTargetUser {
  return {
    id: 'user-1',
    kind: 'user',
    status: 'active',
    oidcIssuer: null,
    oidcSubject: null,
    ...overrides,
  }
}

/** The bounded code and the field name of a rejected input, and nothing else. */
function rejection(value: Parameters<typeof normalizeOidcBinding>[0]) {
  try {
    normalizeOidcBinding(value)
  } catch (error) {
    assert.ok(error instanceof OidcBindingInputError)
    return { code: error.code, field: error.field, message: error.message }
  }
  return assert.fail('the input should have been rejected')
}

// ---------------------------------------------------------------------------
// 1. Validation
// ---------------------------------------------------------------------------

test('accepts three explicit values and trims only surrounding whitespace', () => {
  assert.deepEqual(
    normalizeOidcBinding(
      input({ email: `  DME@KAIRALI.COM `, issuer: `  ${ISSUER} `, subject: `  ${SUBJECT} ` }),
    ),
    REQUEST,
  )
})

test('each missing or blank input is named, not guessed', () => {
  for (const [field, name] of [
    ['email', OIDC_BIND_ENV.email],
    ['issuer', OIDC_BIND_ENV.issuer],
    ['subject', OIDC_BIND_ENV.subject],
  ] as const) {
    for (const empty of [undefined, '', '   ']) {
      assert.deepEqual(
        rejection(input({ [field]: empty })),
        {
          code: OIDC_BIND_INPUT_CODES.missing,
          field: name,
          message: OIDC_BIND_INPUT_CODES.missing,
        },
      )
    }
  }
})

test('the email follows the repository administrator policy exactly', () => {
  for (const value of [
    'not-an-email',
    'admin@example.test',
    'admin@sub.kairali.com',
    'admin@kairali.com.attacker.test',
    `${'a'.repeat(250)}@kairali.com`,
  ]) {
    assert.equal(
      rejection(input({ email: value })).code,
      OIDC_BIND_INPUT_CODES.invalidEmail,
      `${value} must not be accepted as an administrator email`,
    )
  }
})

test('the issuer must be HTTPS with no credentials, query, or fragment', () => {
  for (const value of [
    'http://accounts.example.test',
    'accounts.example.test',
    'ftp://accounts.example.test',
    'https://user:pass@accounts.example.test',
    'https://accounts.example.test#fragment',
    'https://accounts.example.test?state=x',
    'https://accounts.example.test/a b',
    `https://accounts.example.test/${'p'.repeat(300)}`,
  ]) {
    assert.equal(
      rejection(input({ issuer: value })).code,
      OIDC_BIND_INPUT_CODES.invalidIssuer,
      `${value} must not be accepted as an issuer`,
    )
  }
})

test('the issuer is stored exactly as supplied, not URL-normalized', () => {
  // A round trip through `URL` would append a trailing slash that the provider
  // never sends, producing a binding that matches no token at sign-in.
  assert.equal(normalizeOidcBinding(input()).issuer, ISSUER)
  assert.equal(
    normalizeOidcBinding(input({ issuer: 'https://accounts.example.test/' })).issuer,
    'https://accounts.example.test/',
  )
  assert.equal(
    normalizeOidcBinding(input({ issuer: 'https://Accounts.Example.Test' })).issuer,
    'https://Accounts.Example.Test',
  )
})

test('the subject must be an opaque, bounded, printable token', () => {
  for (const value of [
    'has space',
    'tab\tseparated',
    'new\nline',
    'p'.repeat(256),
  ]) {
    assert.equal(
      rejection(input({ subject: value })).code,
      OIDC_BIND_INPUT_CODES.invalidSubject,
      `${JSON.stringify(value)} must not be accepted as a subject`,
    )
  }
  // Opaque means opaque: a provider that issues a URN or a base64url token is
  // accepted, because the shape of a `sub` is not this module's business.
  for (const value of [
    'urn:example:9f2c',
    'AbCd-1234_xyz',
    'a',
    'p'.repeat(255),
  ]) {
    assert.equal(normalizeOidcBinding(input({ subject: value })).subject, value)
  }
})

test('a subject that could have been typed from the email is refused', () => {
  // The whole failure mode this command exists to prevent: a `sub` nobody read
  // off a validated token.
  for (const value of [EMAIL, 'DME@KAIRALI.COM', 'dme@kairali.com.', 'dme@']) {
    assert.equal(
      rejection(input({ subject: value })).code,
      OIDC_BIND_INPUT_CODES.subjectDerivedFromEmail,
      `${value} must be refused as a derived subject`,
    )
  }
})

test('no rejection carries the value that was rejected', () => {
  const secretish = 'https://user:hunter2@accounts.example.test'
  const rejected = rejection(input({ issuer: secretish }))
  assert.equal(rejected.message.includes('hunter2'), false)
  assert.equal(rejected.message.includes('accounts.example.test'), false)
  assert.equal(rejected.field, OIDC_BIND_ENV.issuer)

  const emailRejected = rejection(input({ email: 'someone@example.test' }))
  assert.equal(emailRejected.message.includes('someone'), false)
  assert.equal(emailRejected.message.includes('example.test'), false)
})

test('the execute word is a bare uppercase constant', () => {
  assert.equal(OIDC_BIND_EXECUTE_MODE, 'EXECUTE')
})

// ---------------------------------------------------------------------------
// 2. The decision
// ---------------------------------------------------------------------------

test('an unbound user with a free identity is bound', () => {
  assert.deepEqual(
    planOidcBinding(REQUEST, { user: user(), identityOwnerUserId: null }),
    { action: 'bind', userId: 'user-1' },
  )
})

test('a missing user is refused, never created', () => {
  assert.deepEqual(
    planOidcBinding(REQUEST, { user: null, identityOwnerUserId: null }),
    {
      action: 'refuse',
      code: OIDC_BIND_REFUSAL_CODES.userNotFound,
      userId: null,
    },
  )
})

test('a system actor row is never bound to a login identity', () => {
  assert.deepEqual(
    planOidcBinding(REQUEST, {
      user: user({ kind: 'system' }),
      identityOwnerUserId: null,
    }),
    {
      action: 'refuse',
      code: OIDC_BIND_REFUSAL_CODES.userNotBindable,
      userId: 'user-1',
    },
  )
})

test('the same binding again is an idempotent no-op', () => {
  assert.deepEqual(
    planOidcBinding(REQUEST, {
      user: user({ oidcIssuer: ISSUER, oidcSubject: SUBJECT }),
      identityOwnerUserId: 'user-1',
    }),
    { action: 'no-op', userId: 'user-1' },
  )
})

test('a different complete binding on the target is refused', () => {
  assert.deepEqual(
    planOidcBinding(REQUEST, {
      user: user({
        oidcIssuer: 'https://other.example.test',
        oidcSubject: '999',
      }),
      identityOwnerUserId: null,
    }),
    {
      action: 'refuse',
      code: OIDC_BIND_REFUSAL_CODES.userAlreadyBound,
      userId: 'user-1',
    },
  )
})

test('a partial binding on the target is refused, either column', () => {
  for (const partial of [
    { oidcIssuer: ISSUER, oidcSubject: null },
    { oidcIssuer: null, oidcSubject: SUBJECT },
    { oidcIssuer: 'https://other.example.test', oidcSubject: null },
    { oidcIssuer: null, oidcSubject: 'other-subject' },
  ]) {
    assert.deepEqual(
      planOidcBinding(REQUEST, {
        user: user(partial),
        identityOwnerUserId: null,
      }),
      {
        action: 'refuse',
        code: OIDC_BIND_REFUSAL_CODES.userAlreadyBound,
        userId: 'user-1',
      },
      `${JSON.stringify(partial)} is a repair, not a binding`,
    )
  }
})

test('an identity already owned by another user is refused', () => {
  assert.deepEqual(
    planOidcBinding(REQUEST, {
      user: user(),
      identityOwnerUserId: 'user-2',
    }),
    {
      action: 'refuse',
      code: OIDC_BIND_REFUSAL_CODES.identityTaken,
      userId: 'user-1',
    },
  )
})

test('a matching binding owned elsewhere is refused rather than reported done', () => {
  // Impossible under `uq_user_oidc`; checked because a no-op is the one refusal
  // outcome that reports success.
  assert.deepEqual(
    planOidcBinding(REQUEST, {
      user: user({ oidcIssuer: ISSUER, oidcSubject: SUBJECT }),
      identityOwnerUserId: 'user-2',
    }),
    {
      action: 'refuse',
      code: OIDC_BIND_REFUSAL_CODES.identityTaken,
      userId: 'user-1',
    },
  )
})

test('a disabled or role-less user is still bindable', () => {
  // Binding is authorization plumbing. It neither grants nor withholds access,
  // so account state is reported by the caller, not used as a gate here.
  for (const status of ['disabled', 'invited', 'suspended']) {
    assert.deepEqual(
      planOidcBinding(REQUEST, {
        user: user({ status }),
        identityOwnerUserId: null,
      }),
      { action: 'bind', userId: 'user-1' },
    )
  }
})

test('the issuer and subject match byte for byte, with no folding', () => {
  for (const near of [
    { oidcIssuer: ISSUER.toUpperCase(), oidcSubject: SUBJECT },
    { oidcIssuer: `${ISSUER}/`, oidcSubject: SUBJECT },
    { oidcIssuer: ISSUER, oidcSubject: ` ${SUBJECT}` },
  ]) {
    const plan = planOidcBinding(REQUEST, {
      user: user(near),
      identityOwnerUserId: null,
    })
    assert.equal(
      plan.action,
      'refuse',
      `${JSON.stringify(near)} is a different binding, not the same one`,
    )
  }
})

// ---------------------------------------------------------------------------
// 3. The audit event
// ---------------------------------------------------------------------------

test('the binding hash is stable, and distinct per pair', () => {
  assert.match(oidcBindingHash(REQUEST), /^[0-9a-f]{64}$/)
  assert.equal(oidcBindingHash(REQUEST), oidcBindingHash({ ...REQUEST }))
  assert.notEqual(
    oidcBindingHash(REQUEST),
    oidcBindingHash({ ...REQUEST, subject: `${SUBJECT}2` }),
  )
  assert.notEqual(
    oidcBindingHash(REQUEST),
    oidcBindingHash({ ...REQUEST, issuer: `${ISSUER}/x` }),
  )
  // Concatenation ambiguity would let two different pairs hash alike.
  assert.notEqual(
    oidcBindingHash({ email: EMAIL, issuer: 'https://a.test', subject: 'bc' }),
    oidcBindingHash({ email: EMAIL, issuer: 'https://a.testb', subject: 'c' }),
  )
})

const AUDIT_EVENT_INPUT = {
  targetUserId: 'user-1',
  bindingHash: oidcBindingHash(REQUEST),
  correlationId: 'correlation-1',
  occurredAt: new Date('2026-08-11T09:00:00.000Z'),
}

test('the audit event carries identifiers and hashes only', () => {
  const event = buildOidcBindingAuditEvent(AUDIT_EVENT_INPUT)

  assert.equal(event.action, OIDC_BINDING_AUDIT_ACTION)
  assert.equal(event.purpose, 'identity_provisioning')
  assert.equal(event.outcome, 'success')
  assert.equal(event.resourceType, 'kaudit_user')
  assert.equal(event.resourceId, 'user-1')
  assert.equal(event.client, OIDC_BINDING_AUDIT_CLIENT)
  assert.equal(event.correlationId, 'correlation-1')
  // Nothing existed before the guarded UPDATE's precondition.
  assert.equal(event.beforeHash, null)
  assert.equal(event.afterHash, oidcBindingHash(REQUEST))
  assert.equal(event.occurredAt, AUDIT_EVENT_INPUT.occurredAt)
  assert.equal(event.ipAddress, null)

  const serialized = JSON.stringify(event)
  for (const supplied of [EMAIL, ISSUER, SUBJECT, 'kairali.com', 'example.test']) {
    assert.equal(
      serialized.includes(supplied),
      false,
      `the audit event must not carry ${supplied}`,
    )
  }
})

test('the event names no actor: the bound user did not do this', () => {
  const event = buildOidcBindingAuditEvent(AUDIT_EVENT_INPUT)

  // The target has not authenticated — that is precisely why a binding is being
  // written — and is not necessarily the person who ran the command. Recording
  // them as the actor would put a false attribution in the permanent trail.
  assert.equal(event.actorUserId, null)
  assert.equal(event.actorEmail, null)
  assert.notEqual(event.actorUserId, AUDIT_EVENT_INPUT.targetUserId)

  // The target is still fully present, as what it actually is: the resource.
  assert.equal(event.resourceId, AUDIT_EVENT_INPUT.targetUserId)
  // And the trail still says which command made the change.
  assert.equal(event.client, OIDC_BINDING_AUDIT_CLIENT)
  assert.equal(event.client, 'w1:bind-oidc')
})

test('no identifier reaches an actor column for any target', () => {
  // Not a property of the one fixture: no input value can become an actor.
  for (const targetUserId of ['user-1', 'user-2', 'SYSTEM', '']) {
    const event = buildOidcBindingAuditEvent({
      ...AUDIT_EVENT_INPUT,
      targetUserId,
    })
    assert.equal(event.actorUserId, null)
    assert.equal(event.actorEmail, null)
    assert.equal(event.resourceId, targetUserId)
  }
})
