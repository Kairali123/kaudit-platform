import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  AuthFailure,
  authenticateLocal,
  authenticateOidc,
  extractBearerToken,
  requirePermission,
} from './authenticate.ts'
import type { AccessRepository, TokenVerifier } from './types.ts'

const activeUser = {
  id: 'user-1',
  email: 'operator@example.test',
  status: 'active',
  maxSensitivityTier: 'K1',
  roles: ['user'],
}

const repository: AccessRepository = {
  async findByOidc(issuer, subject) {
    return issuer === 'https://id.example.test' &&
      subject === 'subject-1'
      ? activeUser
      : null
  },
  async findByEmail(email) {
    return email === activeUser.email ? activeUser : null
  },
  async readiness() {
    return true
  },
}

const verifier: TokenVerifier = {
  async verify(token) {
    if (token !== 'valid.token.value') throw new Error('invalid')
    return {
      issuer: 'https://id.example.test',
      subject: 'subject-1',
      email: activeUser.email,
    }
  },
}

test('extracts bearer token without accepting malformed authorization', () => {
  assert.equal(
    extractBearerToken('Bearer valid.token.value', undefined, null),
    'valid.token.value',
  )
  assert.equal(extractBearerToken('Basic abc', undefined, null), null)
  assert.equal(
    extractBearerToken(
      undefined,
      'other=x; oidc=valid.token.value',
      'oidc',
    ),
    'valid.token.value',
  )
})

test('authenticates a provisioned active OIDC identity and enforces role permission', async () => {
  const context = await authenticateOidc(
    'valid.token.value',
    verifier,
    repository,
  )
  assert.equal(context.user.id, activeUser.id)
  assert.doesNotThrow(() => requirePermission(context, 'metrics:read'))
  assert.throws(
    () => requirePermission(context, 'billing:approve'),
    (error) =>
      error instanceof AuthFailure &&
      error.code === 'PERMISSION_DENIED',
  )
})

test('denies missing, invalid, and unprovisioned identities', async () => {
  await assert.rejects(
    () => authenticateOidc(null, verifier, repository),
    /Authentication is required/,
  )
  await assert.rejects(
    () => authenticateOidc('invalid', verifier, repository),
    /token is invalid/,
  )
  await assert.rejects(
    () =>
      authenticateOidc(
        'anything',
        {
          async verify() {
            return {
              issuer: 'https://id.example.test',
              subject: 'unknown',
              email: null,
            }
          },
        },
        repository,
      ),
    /not provisioned/,
  )
})

test('local mode still requires a provisioned active user', async () => {
  assert.equal(
    (await authenticateLocal(activeUser.email, repository)).user.id,
    activeUser.id,
  )
  await assert.rejects(
    () => authenticateLocal('unknown@example.test', repository),
    /not provisioned/,
  )
})
