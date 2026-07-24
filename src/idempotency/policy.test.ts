import { test } from 'node:test'
import assert from 'node:assert/strict'
import { classifyIdempotencyAttempt } from './policy.ts'

const now = new Date('2026-07-24T10:00:00Z')
const requestHash = 'a'.repeat(64)

test('same key plus different request is a conflict', () => {
  assert.equal(
    classifyIdempotencyAttempt({
      existing: {
        requestHash: 'b'.repeat(64),
        status: 'completed',
        responseReference: 'response-1',
        httpStatus: 200,
        responseHash: 'c'.repeat(64),
        lockOwner: null,
        lockedUntil: null,
      },
      requestHash,
      owner: 'request-1',
      now,
    }).outcome,
    'conflict',
  )
})

test('completed same request replays the stored response reference', () => {
  assert.deepEqual(
    classifyIdempotencyAttempt({
      existing: {
        requestHash,
        status: 'completed',
        responseReference: 'response-1',
        httpStatus: 201,
        responseHash: 'c'.repeat(64),
        lockOwner: null,
        lockedUntil: null,
      },
      requestHash,
      owner: 'request-2',
      now,
    }),
    {
      outcome: 'replay',
      responseReference: 'response-1',
      httpStatus: 201,
      responseHash: 'c'.repeat(64),
    },
  )
})

test('active foreign lock remains in progress; failed or expired work can reacquire', () => {
  assert.equal(
    classifyIdempotencyAttempt({
      existing: {
        requestHash,
        status: 'processing',
        responseReference: null,
        httpStatus: null,
        responseHash: null,
        lockOwner: 'request-2',
        lockedUntil: new Date(now.getTime() + 30_000),
      },
      requestHash,
      owner: 'request-1',
      now,
    }).outcome,
    'in_progress',
  )
  for (const existing of [
    {
      requestHash,
      status: 'failed',
      responseReference: null,
      httpStatus: null,
      responseHash: null,
      lockOwner: null,
      lockedUntil: null,
    },
    {
      requestHash,
      status: 'processing',
      responseReference: null,
      httpStatus: null,
      responseHash: null,
      lockOwner: 'request-2',
      lockedUntil: new Date(now.getTime() - 1),
    },
  ]) {
    assert.equal(
      classifyIdempotencyAttempt({
        existing,
        requestHash,
        owner: 'request-1',
        now,
      }).outcome,
      'acquired',
    )
  }
})
