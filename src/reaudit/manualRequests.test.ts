import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ManualReauditError,
  MANUAL_REAUDIT_ROUTE,
  MAX_MANUAL_REAUDIT_CALLS,
  manualReauditBaselineDecision,
  manualReauditDigest,
  manualReauditId,
  manualReauditOutboxMessageId,
  manualReauditRowStatus,
  parseManualReauditRequest,
  safeManualReauditErrorCode,
} from './manualRequests.ts'

/**
 * Domain rules for administrator-requested Billing Audit re-audits.
 *
 * Every fixture here is SYNTHETIC. No real call, task id, recording, amount,
 * or secret appears in this file, and nothing in it contacts a database, a
 * provider, or the network.
 */

const KEY = 'rea-0123456789abcdef'

function body(overrides: Record<string, unknown> = {}): unknown {
  return {
    callReferences: ['synthetic-task-1', 'synthetic-task-2'],
    idempotencyKey: KEY,
    ...overrides,
  }
}

test('the route is admin-scoped and the ceiling is stated once', () => {
  assert.equal(MANUAL_REAUDIT_ROUTE, '/api/v1/audits/re-audit')
  assert.equal(MAX_MANUAL_REAUDIT_CALLS, 100)
})

test('an exact bounded selection is accepted and trimmed', () => {
  const parsed = parseManualReauditRequest(
    body({ callReferences: ['  synthetic-task-1 ', 'synthetic-task-2'] }),
  )
  assert.deepEqual(parsed.callReferences, [
    'synthetic-task-1',
    'synthetic-task-2',
  ])
  assert.equal(parsed.idempotencyKey, KEY)
})

test('a selection at the ceiling is accepted and one past it is not', () => {
  const atLimit = Array.from(
    { length: MAX_MANUAL_REAUDIT_CALLS },
    (_unused, index) => `synthetic-task-${index}`,
  )
  assert.equal(
    parseManualReauditRequest(body({ callReferences: atLimit }))
      .callReferences.length,
    MAX_MANUAL_REAUDIT_CALLS,
  )
  assert.throws(
    () =>
      parseManualReauditRequest(
        body({ callReferences: [...atLimit, 'synthetic-task-overflow'] }),
      ),
    ManualReauditError,
  )
})

test('an empty, non-array, duplicated, or malformed selection is refused', () => {
  for (const invalid of [
    body({ callReferences: [] }),
    body({ callReferences: 'synthetic-task-1' }),
    body({ callReferences: ['synthetic-task-1', 'synthetic-task-1'] }),
    body({ callReferences: [' '] }),
    body({ callReferences: [42] }),
    body({ callReferences: ['a'.repeat(192)] }),
    body({ callReferences: ['synthetic\u0000task'] }),
    body({ callReferences: ['synthetic\ntask'] }),
    ['synthetic-task-1'],
    null,
    'synthetic',
  ]) {
    assert.throws(
      () => parseManualReauditRequest(invalid),
      ManualReauditError,
    )
  }
})

test('a missing or malformed retry key is refused', () => {
  for (const key of [undefined, '', 'short', 'a'.repeat(81), 'has space']) {
    assert.throws(
      () => parseManualReauditRequest(body({ idempotencyKey: key })),
      ManualReauditError,
    )
  }
})

test('a refusal names a rule and never echoes a submitted value', () => {
  const secret = 'synthetic-reference-that-must-not-appear'
  try {
    parseManualReauditRequest(
      body({ callReferences: [secret, secret] }),
    )
    assert.fail('a duplicated selection must be refused')
  } catch (error) {
    assert.ok(error instanceof ManualReauditError)
    assert.equal(error.code, 'INVALID_REAUDIT_REQUEST')
    assert.equal(error.status, 400)
    assert.equal(error.message.includes(secret), false)
    assert.equal(error.message.includes(KEY), false)
  }
})

test('the digest is order independent but selection sensitive', () => {
  const digest = manualReauditDigest(['synthetic-b', 'synthetic-a'])
  assert.equal(digest, manualReauditDigest(['synthetic-a', 'synthetic-b']))
  assert.notEqual(
    digest,
    manualReauditDigest(['synthetic-a', 'synthetic-b', 'synthetic-c']),
  )
  assert.notEqual(digest, manualReauditDigest(['synthetic-a']))
  assert.match(digest, /^[0-9a-f]{64}$/)
})

test('request and item identities are distinct and prefixed', () => {
  assert.match(manualReauditId('brr'), /^brr_[0-9a-f-]{36}$/)
  assert.match(manualReauditId('bri'), /^bri_[0-9a-f-]{36}$/)
  assert.notEqual(manualReauditId('brr'), manualReauditId('brr'))
})

test('an unchanged baseline proceeds and any change skips instead of spending', () => {
  assert.equal(
    manualReauditBaselineDecision({
      baselineAuditRunId: 'synthetic-run-1',
      latestAuditRunId: 'synthetic-run-1',
    }),
    'proceed',
  )
  assert.equal(
    manualReauditBaselineDecision({
      baselineAuditRunId: 'synthetic-run-1',
      latestAuditRunId: 'synthetic-run-2',
    }),
    'skip_baseline_changed',
  )
  // A call whose pointer was cleared is not the call that was selected either.
  assert.equal(
    manualReauditBaselineDecision({
      baselineAuditRunId: 'synthetic-run-1',
      latestAuditRunId: null,
    }),
    'skip_baseline_changed',
  )
})

test('a same-ruleset rerun gets its own outbox identity', () => {
  const manifest = 'a'.repeat(64)
  const first = manualReauditOutboxMessageId({
    itemId: 'bri_synthetic-1',
    inputManifestSha256: manifest,
  })
  const second = manualReauditOutboxMessageId({
    itemId: 'bri_synthetic-2',
    inputManifestSha256: manifest,
  })
  // Identical manifest — same call, same evidence, same ruleset — and still two
  // distinct messages, which is exactly what a manual rerun needs.
  assert.notEqual(first, second)
  assert.notEqual(first, `audit-completed:${manifest}`)
  // Replaying the SAME item stays one message.
  assert.equal(
    first,
    manualReauditOutboxMessageId({
      itemId: 'bri_synthetic-1',
      inputManifestSha256: manifest,
    }),
  )
})

test('only a bounded code is stored against a failed item', () => {
  assert.equal(
    safeManualReauditErrorCode('CLASSIFIER_OUTPUT_INVALID'),
    'CLASSIFIER_OUTPUT_INVALID',
  )
  for (const unsafe of [
    'https://recordings.example.test/synthetic.ogg',
    'Error: connect ECONNREFUSED 10.0.0.1:3306',
    'provider said the transcript was unusable',
    'lowercase_code',
    '',
    null,
    undefined,
    12,
  ]) {
    assert.equal(safeManualReauditErrorCode(unsafe), 'REAUDIT_ITEM_FAILED')
  }
})

test('a row in flight reports processing, never merely queued', () => {
  assert.equal(manualReauditRowStatus(['queued']), 'queued')
  assert.equal(manualReauditRowStatus(['processing']), 'processing')
  assert.equal(manualReauditRowStatus(['queued', 'processing']), 'processing')
  assert.equal(manualReauditRowStatus([]), null)
  assert.equal(manualReauditRowStatus(['completed', 'skipped']), null)
})
