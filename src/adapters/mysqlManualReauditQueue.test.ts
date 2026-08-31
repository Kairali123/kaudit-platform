import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Pool, PoolConnection } from 'mysql2/promise'
import { ManualReauditError } from '../reaudit/manualRequests.ts'
import {
  createMysqlManualReauditCandidateRepository,
  createMysqlManualReauditRequestRepository,
  readManualReauditRowStatuses,
  selectedCalls,
  settleManualReauditItem,
} from './mysqlManualReauditQueue.ts'

/**
 * The durable re-audit queue, exercised through a recording fake pool.
 *
 * Nothing here opens a connection, runs a migration, calls a model, or reads a
 * real recording. Every id, reference, and hash is SYNTHETIC.
 */

interface Rule {
  match: RegExp
  rows?: unknown[]
  result?: unknown
  throws?: unknown
}

function fakePool(rules: Rule[]) {
  const statements: Array<{ sql: string; parameters: unknown[] }> = []
  let committed = 0
  let rolledBack = 0
  let released = 0
  const run = (sql: string, parameters: unknown[] = []) => {
    statements.push({ sql, parameters })
    const rule = rules.find((candidate) => candidate.match.test(sql))
    if (rule?.throws) throw rule.throws
    if (rule?.result) return [rule.result, []]
    if (!rule?.rows && /^\s*(?:INSERT|UPDATE)\b/i.test(sql)) {
      return [{ affectedRows: 1 }, []]
    }
    return [rule?.rows ?? [], []]
  }
  const connection = {
    async beginTransaction() {},
    async query(sql: string, parameters?: unknown[]) {
      return run(sql, parameters)
    },
    async execute(sql: string, parameters?: unknown[]) {
      return run(sql, parameters)
    },
    async commit() {
      committed += 1
    },
    async rollback() {
      rolledBack += 1
    },
    release() {
      released += 1
    },
  } as unknown as PoolConnection
  const pool = {
    async getConnection() {
      return connection
    },
    async query(sql: string, parameters?: unknown[]) {
      return run(sql, parameters)
    },
  } as unknown as Pool
  return {
    pool,
    connection,
    statements,
    committed: () => committed,
    rolledBack: () => rolledBack,
    released: () => released,
    find(pattern: RegExp) {
      return statements.find((entry) => pattern.test(entry.sql))
    },
    all(pattern: RegExp) {
      return statements.filter((entry) => pattern.test(entry.sql))
    },
  }
}

const LOCK: Rule = { match: /GET_LOCK/, rows: [{ acquired: 1 }] }
const RELEASE: Rule = { match: /RELEASE_LOCK/, rows: [{}] }

const REQUEST = {
  callReferences: ['synthetic-task-1', 'synthetic-task-2'],
  idempotencyKey: 'rea-0123456789abcdef',
  requestedByUserId: 'usr_synthetic_admin',
  correlationId: 'cor_synthetic',
  requestedAt: new Date('2026-08-17T00:00:00.000Z'),
}

const RESOLVED = [
  {
    call_reference: 'synthetic-task-1',
    call_id: 'call-synthetic-1',
    baseline_audit_run_id: 'run-synthetic-1',
  },
  {
    call_reference: 'synthetic-task-2',
    call_id: 'call-synthetic-2',
    baseline_audit_run_id: 'run-synthetic-2',
  },
]

// ---------------------------------------------------------------------------
// Resolving the exact selection
// ---------------------------------------------------------------------------

test('every submitted reference must resolve to exactly one auditable call', () => {
  assert.deepEqual(
    selectedCalls(['synthetic-task-1', 'synthetic-task-2'], RESOLVED),
    [
      { callId: 'call-synthetic-1', baselineAuditRunId: 'run-synthetic-1' },
      { callId: 'call-synthetic-2', baselineAuditRunId: 'run-synthetic-2' },
    ],
  )
})

test('selection SQL preserves Billing Audit invoice eligibility', async () => {
  const fake = fakePool([
    LOCK,
    RELEASE,
    { match: /FROM kaudit_billing_reaudit_request\s+WHERE idempotency_key/, rows: [] },
    { match: /UNION/, rows: RESOLVED },
    { match: /active_call_id IN/, rows: [] },
  ])
  await createMysqlManualReauditRequestRepository(fake.pool).enqueue(REQUEST)
  const selection = fake.find(/UNION/)
  assert.equal(
    String(selection?.sql).match(/FROM kaudit_invoice invoice/g)?.length,
    2,
  )
  assert.match(
    String(selection?.sql),
    /invoice.status IN \('received','matched','approved'\)/,
  )
})

test('an unresolved or ambiguous reference is a selection error, not a guess', () => {
  // Not audited, no recording evidence, or simply not a call here.
  assert.throws(
    () => selectedCalls(['synthetic-task-3'], RESOLVED),
    (error: ManualReauditError) => {
      assert.equal(error.code, 'REAUDIT_SELECTION_INVALID')
      assert.equal(error.status, 400)
      assert.equal(error.message.includes('synthetic-task-3'), false)
      return true
    },
  )
  // Two calls behind one displayed reference: paying for the wrong one is
  // exactly what this refuses to risk.
  assert.throws(
    () =>
      selectedCalls(['synthetic-task-1'], [
        ...RESOLVED,
        {
          call_reference: 'synthetic-task-1',
          call_id: 'call-synthetic-9',
          baseline_audit_run_id: 'run-synthetic-9',
        },
      ]),
    ManualReauditError,
  )
})

test('two references naming the same call queue that call once', () => {
  const calls = selectedCalls(['synthetic-task-1', 'synthetic-task-alias'], [
    RESOLVED[0],
    {
      call_reference: 'synthetic-task-alias',
      call_id: 'call-synthetic-1',
      baseline_audit_run_id: 'run-synthetic-1',
    },
  ])
  assert.deepEqual(calls, [
    { callId: 'call-synthetic-1', baselineAuditRunId: 'run-synthetic-1' },
  ])
})

// ---------------------------------------------------------------------------
// Accepting a request
// ---------------------------------------------------------------------------

test('a new selection is queued with a baseline per call and no reference stored', async () => {
  const fake = fakePool([
    LOCK,
    RELEASE,
    { match: /FROM kaudit_billing_reaudit_request\s+WHERE idempotency_key/, rows: [] },
    { match: /UNION/, rows: RESOLVED },
    { match: /active_call_id IN/, rows: [] },
  ])
  const receipt = await createMysqlManualReauditRequestRepository(
    fake.pool,
  ).enqueue(REQUEST)

  assert.deepEqual(receipt, {
    requestId: receipt.requestId,
    outcome: 'accepted',
    status: 'queued',
    acceptedCount: 2,
    alreadyQueuedCount: 0,
  })
  assert.match(String(receipt.requestId), /^brr_/)
  assert.equal(fake.committed(), 1)
  assert.equal(fake.released(), 1)

  const items = fake.all(/INSERT INTO kaudit_billing_reaudit_item/)
  assert.equal(items.length, 2)
  assert.deepEqual(
    items.map((entry) => [entry.parameters[2], entry.parameters[3]]),
    [
      ['call-synthetic-1', 'run-synthetic-1'],
      ['call-synthetic-2', 'run-synthetic-2'],
    ],
  )
  // The stored request carries the DIGEST of the selection, never the
  // references themselves.
  const request = fake.find(/INSERT INTO kaudit_billing_reaudit_request/)
  assert.match(String(request?.parameters[2]), /^[0-9a-f]{64}$/)
  const written = JSON.stringify(
    fake.all(/INSERT INTO/).map((entry) => entry.parameters),
  )
  for (const reference of REQUEST.callReferences) {
    assert.equal(written.includes(reference), false)
  }
})

test('a retry of the same selection replays instead of queuing a second spend', async () => {
  const fake = fakePool([
    LOCK,
    RELEASE,
    {
      match: /FROM kaudit_billing_reaudit_request\s+WHERE idempotency_key/,
      rows: [
        {
          id: 'brr_synthetic',
          // The digest the repository computes for REQUEST's references.
          request_digest: 'placeholder',
          status: 'running',
          completed_count: 1,
          failed_count: 0,
          skipped_count: 0,
        },
      ],
    },
  ])
  await assert.rejects(
    () =>
      createMysqlManualReauditRequestRepository(fake.pool).enqueue(REQUEST),
    (error: ManualReauditError) => {
      // A stored key carrying a DIFFERENT selection is a caller bug, not a
      // retry, and is refused rather than silently re-scoped.
      assert.equal(error.code, 'REAUDIT_REQUEST_CONFLICT')
      assert.equal(error.status, 409)
      return true
    },
  )
  assert.equal(fake.rolledBack(), 1)
  assert.equal(
    fake.all(/INSERT INTO kaudit_billing_reaudit_item/).length,
    0,
  )
})

test('a matching retry key returns the stored request and queues nothing new', async () => {
  const { manualReauditDigest } = await import('../reaudit/manualRequests.ts')
  const fake = fakePool([
    LOCK,
    RELEASE,
    {
      match: /FROM kaudit_billing_reaudit_request\s+WHERE idempotency_key/,
      rows: [
        {
          id: 'brr_synthetic',
          request_digest: manualReauditDigest(REQUEST.callReferences),
          status: 'running',
          completed_count: 1,
          failed_count: 0,
          skipped_count: 0,
        },
      ],
    },
    { match: /SELECT COUNT\(\*\) AS n/, rows: [{ n: 2 }] },
  ])
  const receipt = await createMysqlManualReauditRequestRepository(
    fake.pool,
  ).enqueue(REQUEST)

  assert.deepEqual(receipt, {
    requestId: 'brr_synthetic',
    outcome: 'replayed',
    status: 'running',
    acceptedCount: 2,
    alreadyQueuedCount: 0,
  })
  assert.equal(fake.all(/INSERT INTO/).length, 0)
})

test('a call already spoken for is never queued twice', async () => {
  const fake = fakePool([
    LOCK,
    RELEASE,
    { match: /FROM kaudit_billing_reaudit_request\s+WHERE idempotency_key/, rows: [] },
    { match: /UNION/, rows: RESOLVED },
    {
      match: /active_call_id IN/,
      rows: [{ call_id: 'call-synthetic-1' }],
    },
  ])
  const receipt = await createMysqlManualReauditRequestRepository(
    fake.pool,
  ).enqueue(REQUEST)

  assert.equal(receipt.acceptedCount, 1)
  assert.equal(receipt.alreadyQueuedCount, 1)
  const items = fake.all(/INSERT INTO kaudit_billing_reaudit_item/)
  assert.deepEqual(
    items.map((entry) => entry.parameters[2]),
    ['call-synthetic-2'],
  )
})

test('a fully-busy selection writes nothing and reports itself as already queued', async () => {
  const fake = fakePool([
    LOCK,
    RELEASE,
    { match: /FROM kaudit_billing_reaudit_request\s+WHERE idempotency_key/, rows: [] },
    { match: /UNION/, rows: RESOLVED },
    {
      match: /active_call_id IN/,
      rows: [
        { call_id: 'call-synthetic-1' },
        { call_id: 'call-synthetic-2' },
      ],
    },
  ])
  const receipt = await createMysqlManualReauditRequestRepository(
    fake.pool,
  ).enqueue(REQUEST)

  assert.deepEqual(receipt, {
    requestId: null,
    outcome: 'already_queued',
    status: null,
    acceptedCount: 0,
    alreadyQueuedCount: 2,
  })
  assert.equal(fake.all(/INSERT INTO/).length, 0)
})

test('a busy enqueue lock refuses rather than racing two acceptances', async () => {
  const fake = fakePool([{ match: /GET_LOCK/, rows: [{ acquired: 0 }] }])
  await assert.rejects(
    () =>
      createMysqlManualReauditRequestRepository(fake.pool).enqueue(REQUEST),
    (error: ManualReauditError) => {
      assert.equal(error.code, 'REAUDIT_QUEUE_BUSY')
      assert.equal(error.status, 409)
      return true
    },
  )
  // A lock that was never acquired is not released.
  assert.equal(fake.find(/RELEASE_LOCK/), undefined)
})

test('a driver failure becomes one bounded refusal carrying nothing about it', async () => {
  const driverProse =
    "Duplicate entry 'call-synthetic-1' for key 'uq_billing_reaudit_active_call'"
  const fake = fakePool([
    LOCK,
    RELEASE,
    { match: /FROM kaudit_billing_reaudit_request\s+WHERE idempotency_key/, rows: [] },
    { match: /UNION/, throws: Object.assign(new Error(driverProse), { code: 'ER_DUP_ENTRY' }) },
  ])
  await assert.rejects(
    () =>
      createMysqlManualReauditRequestRepository(fake.pool).enqueue(REQUEST),
    (error: ManualReauditError) => {
      assert.equal(error.code, 'REAUDIT_QUEUE_UNAVAILABLE')
      assert.equal(error.status, 503)
      assert.equal(error.message.includes(driverProse), false)
      assert.equal(error.message.includes('call-synthetic-1'), false)
      return true
    },
  )
  assert.equal(fake.rolledBack(), 1)
  assert.equal(fake.released(), 1)
})

// ---------------------------------------------------------------------------
// Claiming work
// ---------------------------------------------------------------------------

const CLAIMED = [
  {
    item_id: 'bri_synthetic-1',
    request_id: 'brr_synthetic',
    call_id: 'call-synthetic-1',
    baseline_audit_run_id: 'run-synthetic-1',
  },
]

function claimPool(overrides: Rule[] = []) {
  return fakePool([
    ...overrides,
    {
      match: /FROM kaudit_billing_reaudit_item item\s+WHERE item.status = 'processing'/,
      rows: [],
    },
    {
      match: /FROM kaudit_billing_reaudit_item item\s+WHERE \(/,
      rows: CLAIMED,
    },
    {
      match: /FROM kaudit_call_artifact artifact/,
      rows: [
        {
          call_id: 'call-synthetic-1',
          artifact_id: 'artifact-synthetic-1',
          source_url: 'https://recordings.example.test/synthetic.ogg',
          baseline_sha256: 'f'.repeat(64),
        },
      ],
    },
    {
      match: /FROM kaudit_provider_cost cost/,
      rows: [
        {
          call_id: 'call-synthetic-1',
          claimed_duration_ms: 190_000,
          connected_duration_ms: 180_000,
          vendor_billed_minutes: '3.00000000',
        },
      ],
    },
  ])
}

test('selection carries the baseline without claiming work state early', async () => {
  const fake = claimPool()
  const candidates = await createMysqlManualReauditCandidateRepository(
    fake.pool,
  ).listCandidates({ limit: 25, includePreviouslyClassified: true })

  assert.deepEqual(candidates, [
    {
      callId: 'call-synthetic-1',
      artifactId: 'artifact-synthetic-1',
      sourceUrl: 'https://recordings.example.test/synthetic.ogg',
      baselineSha256: 'f'.repeat(64),
      claimedDurationMs: 190_000,
      connectedDurationMs: 180_000,
      vendorBilledMinutes: '3.00000000',
      manualRequest: {
        requestId: 'brr_synthetic',
        itemId: 'bri_synthetic-1',
        baselineAuditRunId: 'run-synthetic-1',
      },
    },
  ])
  const claim = fake.find(
    /FROM kaudit_billing_reaudit_item item\s+WHERE \(/,
  )
  assert.match(String(claim?.sql), /FOR UPDATE/)
  assert.match(String(claim?.sql), /attempt_count < 1/)
  assert.match(String(claim?.sql), /LIMIT 1/)
  assert.doesNotMatch(String(claim?.sql), /status = 'processing'/)
  assert.equal(fake.find(/UPDATE kaudit_billing_reaudit_item/), undefined)
  // The claim locks only the queue's own rows.
  assert.equal(/kaudit_call_artifact/.test(String(claim?.sql)), false)
})

test('an interrupted paid claim fails closed and is never reclaimed', async () => {
  const fake = claimPool([
    {
      match: /FROM kaudit_billing_reaudit_item item\s+WHERE item.status = 'processing'/,
      rows: CLAIMED,
    },
    {
      match: /FROM kaudit_billing_reaudit_item item\s+WHERE \(/,
      rows: [],
    },
  ])

  const candidates = await createMysqlManualReauditCandidateRepository(
    fake.pool,
  ).listCandidates({ limit: 25, includePreviouslyClassified: true })

  assert.deepEqual(candidates, [])
  const staleRead = fake.find(/WHERE item.status = 'processing'/)
  assert.match(String(staleRead?.sql), /INTERVAL 30 MINUTE/)
  const settle = fake
    .all(/UPDATE kaudit_billing_reaudit_item/)
    .find((entry) => entry.parameters[0] === 'failed')
  assert.equal(settle?.parameters[2], 'REAUDIT_WORKER_INTERRUPTED')
  const queuedRead = fake.find(/WHERE \(/)
  assert.doesNotMatch(String(queuedRead?.sql), /status = 'processing'/)
})

test('an exclusive recovery worker selects orphaned processing state for the spend guard', async () => {
  const fake = claimPool([
    {
      match: /FROM kaudit_billing_reaudit_item item\s+WHERE \(/,
      rows: CLAIMED,
    },
  ])

  const candidates = await createMysqlManualReauditCandidateRepository(
    fake.pool,
    { recoverInterruptedClaims: true },
  ).listCandidates({ limit: 25, includePreviouslyClassified: true })

  assert.equal(candidates.length, 1)
  const recoveryRead = fake.find(/FROM kaudit_billing_reaudit_item item\s+WHERE \(/)
  assert.match(String(recoveryRead?.sql), /OR item.status = 'processing'/)
  assert.equal(fake.find(/UPDATE kaudit_billing_reaudit_item/), undefined)
})

test('a claimed call with no usable recording is settled without a model call', async () => {
  const fake = fakePool([
    {
      match: /FROM kaudit_billing_reaudit_item item\s+WHERE item.status = 'processing'/,
      rows: [],
    },
    {
      match: /FROM kaudit_billing_reaudit_item item\s+WHERE \(/,
      rows: CLAIMED,
    },
    { match: /FROM kaudit_call_artifact artifact/, rows: [] },
    { match: /FROM kaudit_provider_cost cost/, rows: [] },
  ])
  const candidates = await createMysqlManualReauditCandidateRepository(
    fake.pool,
  ).listCandidates({ limit: 25, includePreviouslyClassified: true })

  assert.deepEqual(candidates, [])
  const settle = fake
    .all(/UPDATE kaudit_billing_reaudit_item/)
    .find((entry) => entry.parameters[0] === 'failed')
  assert.equal(settle?.parameters[2], 'REAUDIT_RECORDING_UNAVAILABLE')
})

test('a worker wired to the new-calls queue is refused, never quietly served', async () => {
  const fake = claimPool()
  await assert.rejects(
    () =>
      createMysqlManualReauditCandidateRepository(fake.pool).listCandidates({
        limit: 25,
        includePreviouslyClassified: false,
      }),
    (error: ManualReauditError) => {
      assert.equal(error.code, 'REAUDIT_WORKER_MODE_INVALID')
      return true
    },
  )
  assert.equal(fake.statements.length, 0)
})

// ---------------------------------------------------------------------------
// Settling an item
// ---------------------------------------------------------------------------

test('settling records only a bounded code and rolls the request forward', async () => {
  const fake = fakePool([])
  await settleManualReauditItem(fake.connection, {
    requestId: 'brr_synthetic',
    itemId: 'bri_synthetic-1',
    outcome: 'failed',
    errorCode: 'https://recordings.example.test/synthetic.ogg',
    at: new Date('2026-08-17T00:00:00.000Z'),
  })
  const item = fake.find(/UPDATE kaudit_billing_reaudit_item/)
  assert.equal(item?.parameters[0], 'failed')
  // Provider prose and URLs never reach the queue.
  assert.equal(item?.parameters[2], 'REAUDIT_ITEM_FAILED')
  assert.match(String(item?.sql), /AND status = 'processing'/)

  const rollup = fake.find(/UPDATE kaudit_billing_reaudit_request/)
  assert.match(String(rollup?.sql), /completed_with_failures/)
  assert.match(String(rollup?.sql), /skipped_count/)
  assert.deepEqual(rollup?.parameters.at(-1), 'brr_synthetic')
})

test('a completed or skipped item stores no error code at all', async () => {
  for (const outcome of ['completed', 'skipped'] as const) {
    const fake = fakePool([])
    await settleManualReauditItem(fake.connection, {
      requestId: 'brr_synthetic',
      itemId: 'bri_synthetic-1',
      outcome,
      at: new Date(0),
    })
    assert.equal(
      fake.find(/UPDATE kaudit_billing_reaudit_item/)?.parameters[2],
      null,
    )
  }
})

test('settling refuses an item that is no longer processing', async () => {
  const fake = fakePool([
    {
      match: /UPDATE kaudit_billing_reaudit_item/,
      result: { affectedRows: 0 },
    },
  ])
  await assert.rejects(
    () =>
      settleManualReauditItem(fake.connection, {
        requestId: 'brr_synthetic',
        itemId: 'bri_synthetic-1',
        outcome: 'completed',
        at: new Date(0),
      }),
    (error: ManualReauditError) => {
      assert.equal(error.code, 'REAUDIT_ITEM_STATE_CONFLICT')
      return true
    },
  )
  assert.equal(fake.find(/UPDATE kaudit_billing_reaudit_request/), undefined)
})

// ---------------------------------------------------------------------------
// The monitor's per-row read
// ---------------------------------------------------------------------------

test('the monitor read returns only safe lifecycle fields', async () => {
  const fake = fakePool([
    {
      match: /FROM kaudit_billing_reaudit_item item/,
      rows: [
        {
          call_id: 'call-synthetic-1',
          status: 'queued',
          created_at: '2026-08-20 09:00:00',
          completed_at: null,
          last_error_code: null,
        },
        {
          call_id: 'call-synthetic-2',
          status: 'failed',
          created_at: '2026-08-20 10:00:00',
          completed_at: '2026-08-20 10:05:00',
          last_error_code: 'CLASSIFICATION_FAILED',
        },
      ],
    },
  ])
  const statuses = await readManualReauditRowStatuses(fake.pool, [
    'call-synthetic-1',
    'call-synthetic-2',
  ])
  assert.deepEqual([...statuses], [
    [
      'call-synthetic-1',
      { status: 'queued', completedAt: null, failureCode: null },
    ],
    [
      'call-synthetic-2',
      {
        status: 'failed',
        completedAt: '2026-08-20 10:05:00',
        failureCode: 'CLASSIFICATION_FAILED',
      },
    ],
  ])
  const statusSql = String(
    fake.find(/FROM kaudit_billing_reaudit_item/)?.sql,
  )
  assert.match(statusSql, /item.status IN \('queued','processing','completed','failed'\)/)
  assert.match(statusSql, /newer.status IN \('queued','processing','completed','skipped','failed'\)/)
  assert.match(statusSql, /NOT EXISTS \(/)
  assert.match(statusSql, /INTERVAL 30 MINUTE/)
  assert.equal(statusSql.includes('last_error_code'), true)
  assert.equal(statusSql.includes('request_id'), false)
})

test('the monitor read lets a newer lifecycle item win over an older terminal item', async () => {
  const fake = fakePool([
    {
      match: /FROM kaudit_billing_reaudit_item item/,
      rows: [
        {
          call_id: 'call-synthetic-1',
          status: 'completed',
          created_at: '2026-08-20 09:00:00',
          completed_at: '2026-08-20 09:05:00',
          last_error_code: null,
        },
        {
          call_id: 'call-synthetic-1',
          status: 'processing',
          created_at: '2026-08-20 11:00:00',
          completed_at: null,
          last_error_code: null,
        },
      ],
    },
  ])
  assert.deepEqual(
    (await readManualReauditRowStatuses(fake.pool, ['call-synthetic-1'])).get(
      'call-synthetic-1',
    ),
    { status: 'processing', completedAt: null, failureCode: null },
  )
})

test('an unapplied migration reports no re-audit state instead of failing the page', async () => {
  const fake = fakePool([
    {
      match: /FROM kaudit_billing_reaudit_item item/,
      throws: Object.assign(
        new Error("Table 'kaudit.kaudit_billing_reaudit_item' doesn't exist"),
        { code: 'ER_NO_SUCH_TABLE' },
      ),
    },
  ])
  assert.equal(
    (await readManualReauditRowStatuses(fake.pool, ['call-synthetic-1'])).size,
    0,
  )
})

test('an operational queue read failure is not mistaken for an available row', async () => {
  const fake = fakePool([
    {
      match: /FROM kaudit_billing_reaudit_item item/,
      throws: Object.assign(new Error('synthetic driver prose'), {
        code: 'ER_LOCK_WAIT_TIMEOUT',
      }),
    },
  ])
  await assert.rejects(
    () => readManualReauditRowStatuses(fake.pool, ['call-synthetic-1']),
    (error: ManualReauditError) => {
      assert.equal(error.code, 'REAUDIT_QUEUE_UNAVAILABLE')
      assert.equal(error.message.includes('synthetic driver prose'), false)
      return true
    },
  )
})

test('an empty page asks the queue nothing at all', async () => {
  const fake = fakePool([])
  assert.equal((await readManualReauditRowStatuses(fake.pool, [])).size, 0)
  assert.equal(fake.statements.length, 0)
})
