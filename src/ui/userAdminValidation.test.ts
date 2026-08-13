import { test } from 'node:test'
import assert from 'node:assert/strict'
import { userPasswordValidationMessage } from '../../apps/web/src/lib/userAdminValidation.ts'

const identity = {
  username: 'synthetic.reviewer',
  email: 'synthetic-reviewer@example.test',
}

test('accepts a strong password unrelated to the account identity', () => {
  assert.equal(
    userPasswordValidationMessage('Cobalt!River7Glass', identity),
    null,
  )
})

test('reports structural password requirements without echoing the password', () => {
  const password = 'alllowercase'
  const message = userPasswordValidationMessage(password, identity)

  assert.match(message ?? '', /uppercase letter/)
  assert.match(message ?? '', /number/)
  assert.match(message ?? '', /symbol/)
  assert.equal(message?.includes(password), false)
})

test('rejects identity reuse without echoing the identity', () => {
  for (const password of [
    'Synthetic.reviewer!7A',
    'Synthetic-reviewer!7A',
  ]) {
    const message = userPasswordValidationMessage(password, identity)
    assert.match(message ?? '', /not contain the username or email name/)
    assert.equal(message?.includes(identity.username), false)
    assert.equal(message?.includes(identity.email), false)
  }
})
