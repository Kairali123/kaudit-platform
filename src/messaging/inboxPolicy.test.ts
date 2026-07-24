import { test } from 'node:test'
import assert from 'node:assert/strict'
import { classifyInboxAttempt } from './inboxPolicy.ts'

const now = new Date('2026-07-24T10:00:00Z')
const hash = 'a'.repeat(64)

test('same message ID with different bytes is an integrity conflict', () => {
  assert.equal(
    classifyInboxAttempt({
      existing: {
        payloadSha256: 'b'.repeat(64),
        status: 'completed',
        leaseOwner: null,
        leaseExpiresAt: null,
      },
      incomingPayloadSha256: hash,
      owner: 'worker-1',
      now,
    }).outcome,
    'integrity_conflict',
  )
})

test('completed duplicate is a no-op and active foreign lease stays in progress', () => {
  assert.equal(
    classifyInboxAttempt({
      existing: {
        payloadSha256: hash,
        status: 'completed',
        leaseOwner: null,
        leaseExpiresAt: null,
      },
      incomingPayloadSha256: hash,
      owner: 'worker-1',
      now,
    }).outcome,
    'duplicate_completed',
  )
  assert.equal(
    classifyInboxAttempt({
      existing: {
        payloadSha256: hash,
        status: 'processing',
        leaseOwner: 'worker-2',
        leaseExpiresAt: new Date(now.getTime() + 30_000),
      },
      incomingPayloadSha256: hash,
      owner: 'worker-1',
      now,
    }).outcome,
    'in_progress',
  )
})

test('expired lease or same owner may safely reacquire', () => {
  for (const existing of [
    {
      payloadSha256: hash,
      status: 'processing',
      leaseOwner: 'worker-2',
      leaseExpiresAt: new Date(now.getTime() - 1),
    },
    {
      payloadSha256: hash,
      status: 'processing',
      leaseOwner: 'worker-1',
      leaseExpiresAt: new Date(now.getTime() + 30_000),
    },
    {
      payloadSha256: hash,
      status: 'failed',
      leaseOwner: null,
      leaseExpiresAt: null,
    },
  ]) {
    assert.equal(
      classifyInboxAttempt({
        existing,
        incomingPayloadSha256: hash,
        owner: 'worker-1',
        now,
      }).outcome,
      'acquired',
    )
  }
})
