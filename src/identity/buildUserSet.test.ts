import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildUserSet, type IdentityRef } from './buildUserSet.ts'

test('dedupes users across sources and case, and separates system actors', () => {
  const refs: IdentityRef[] = [
    { source: 'kaudit_review.reviewer_email', raw: 'alice@kairali.com' },
    { source: 'kaudit_rate_card_version.approved_by', raw: 'Alice@Kairali.com' }, // dup
    { source: 'kaudit_rate_card_version.created_by', raw: 'bob@kairali.com' },
    { source: 'kaudit_audit_log.actor_email', raw: 'w3-backfill' }, // system
    { source: 'kaudit_audit_log.actor_email', raw: 'w3-backfill' }, // dup system
    { source: 'kaudit_review.reviewer_email', raw: null }, // empty
    { source: 'kaudit_review.reviewer_email', raw: 'broken@' }, // invalid
  ]

  const res = buildUserSet(refs)

  const emails = res.users.filter((u) => u.kind === 'user').map((u) => u.identity).sort()
  const systems = res.users.filter((u) => u.kind === 'system').map((u) => u.identity)
  assert.deepEqual(emails, ['alice@kairali.com', 'bob@kairali.com']) // Alice deduped
  assert.deepEqual(systems, ['w3-backfill'])
  assert.equal(res.counts.user, 3) // 3 user-kind refs (alice x2 + bob)
  assert.equal(res.counts.system, 2)
  assert.equal(res.counts.empty, 1)
  assert.equal(res.counts.invalid, 1)
  assert.deepEqual(res.invalidSamples, ['broken@'])
})

test('per-source breakdown is reported', () => {
  const refs: IdentityRef[] = [
    { source: 'kaudit_review.reviewer_email', raw: 'a@b.com' },
    { source: 'kaudit_review.reviewer_email', raw: null },
    { source: 'kaudit_audit_log.actor_email', raw: 'w3-url-verify' },
  ]
  const res = buildUserSet(refs)
  assert.equal(res.bySource['kaudit_review.reviewer_email']?.user, 1)
  assert.equal(res.bySource['kaudit_review.reviewer_email']?.empty, 1)
  assert.equal(res.bySource['kaudit_audit_log.actor_email']?.system, 1)
})

test('mapping resolves a normalized value to its user key', () => {
  const res = buildUserSet([{ source: 's', raw: 'X@Y.com' }])
  assert.equal(res.mapping['x@y.com'], 'user:x@y.com')
})

test('empty input yields no users and zero counts', () => {
  const res = buildUserSet([])
  assert.equal(res.users.length, 0)
  assert.equal(res.counts.user, 0)
})
