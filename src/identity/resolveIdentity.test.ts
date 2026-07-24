import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveIdentity } from './resolveIdentity.ts'

test('a real email resolves to a user, normalized to lowercase', () => {
  const r = resolveIdentity('  Sysadmin@Kairali.com ')
  assert.equal(r.kind, 'user')
  assert.equal(r.normalized, 'sysadmin@kairali.com')
  assert.equal(r.key, 'user:sysadmin@kairali.com')
})

test('a no-@ service string resolves to a system actor', () => {
  const r = resolveIdentity('w3-backfill')
  assert.equal(r.kind, 'system')
  assert.equal(r.key, 'system:w3-backfill')
})

test('null / blank is empty', () => {
  assert.equal(resolveIdentity(null).kind, 'empty')
  assert.equal(resolveIdentity('   ').kind, 'empty')
  assert.equal(resolveIdentity(undefined).kind, 'empty')
})

test('a malformed @-string is invalid (not minted as a user)', () => {
  assert.equal(resolveIdentity('not-an-email@').kind, 'invalid')
  assert.equal(resolveIdentity('foo@bar').kind, 'invalid') // no TLD
  assert.equal(resolveIdentity('a@@b.com').kind, 'invalid')
})

test('case variants of the same email produce the same dedup key', () => {
  assert.equal(resolveIdentity('A@B.com').key, resolveIdentity('a@b.COM').key)
})
