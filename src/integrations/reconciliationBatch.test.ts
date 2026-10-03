import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import type { Pool } from 'mysql2/promise'
import {
  createReconciliationBatchService,
  type ReconciliationBatchRequest,
} from './reconciliationBatch.ts'

/**
 * The bounded Sheet reconciliation service, driven through a recording fake
 * pool. No connection, model, provider, or recording is touched; every id,
 * key, and URL is SYNTHETIC.
 */

const BATCH_ID = 'gas-00000000-0000-4000-8000-000000000001'

function fakePool(rules: Array<{ match: RegExp; rows: unknown[] }>) {
  const statements: Array<{ sql: string; parameters: unknown[] }> = []
  const run = async (sql: string, parameters: unknown[] = []) => {
    statements.push({ sql, parameters })
    const rule = rules.find((candidate) => candidate.match.test(sql))
    if (!rule) throw new Error(`unexpected SQL: ${sql.slice(0, 80)}`)
    return [rule.rows, []]
  }
  return {
    pool: {
      execute: run,
      query: run,
      getConnection: async () => {
        throw new Error('no transaction expected')
      },
    } as unknown as Pool,
    statements,
  }
}

function service(pool: Pool) {
  return createReconciliationBatchService({
    pool,
    env: {
      OPENAI_API_KEY: 'sk-synthetic',
      ELEVENLABS_API_KEY: 'el-synthetic',
      KAUDIT_TRANSCRIPTION_PROVIDER: 'elevenlabs',
    },
    rateCardId: 'rate-card-synthetic',
    allowedRecordingHosts: ['recordings.example.test'],
    proxyBaseUrl: 'https://proxy.example.test',
  })
}

function request(body: Record<string, unknown>): ReconciliationBatchRequest {
  return {
    batchId: BATCH_ID,
    billMonth: '2026-07',
    bodySha256: 'a'.repeat(64),
    correlationId: 'corr-synthetic',
    body: {
      schema_version: '1',
      batch_id: BATCH_ID,
      bill_month: '2026-07',
      mode: 'new_month',
      items: [{ task_id: 'task-1' }],
      ...body,
    },
  }
}

test('malformed batches are refused with 400 before any database read', async () => {
  const { pool, statements } = fakePool([])
  const cases: Array<Record<string, unknown>> = [
    { schema_version: '2' },
    { batch_id: 'gas-other-000000000000' },
    { bill_month: '2026-08' },
    { mode: 'bulk' },
    { items: [] },
    { items: [1, 2, 3, 4].map((n) => ({ task_id: `task-${n}` })) },
    { items: [{ task_id: 'task-1' }, { task_id: 'task-1' }] },
    { items: [{ task_id: 'bad id with spaces' }] },
    { mode: 'late_recording', items: [{ task_id: 'task-1' }] },
  ]
  for (const body of cases) {
    await assert.rejects(service(pool).process(request(body)), (error: unknown) => {
      const failure = error as { status?: number; code?: string }
      return failure.status === 400 && failure.code === 'INVALID_RECONCILIATION_BATCH'
    }, JSON.stringify(body))
  }
  assert.equal(statements.length, 0)
})

test('a replayed new-month batch returns the final amount without re-auditing', async () => {
  const { pool, statements } = fakePool([
    {
      match: /UNION/,
      rows: [
        { task_id: 'task-1', call_id: 'call-1' },
        { task_id: 'task-2', call_id: 'call-2' },
      ],
    },
    {
      match: /kaudit_billing_calculation calculation/,
      rows: [
        { call_id: 'call-1', amount: '4.75000000' },
        { call_id: 'call-2', amount: '0.00000000' },
      ],
    },
  ])
  const receipt = await service(pool).process(request({
    items: [{ task_id: 'task-1' }, { task_id: 'task-2' }],
  }))
  assert.deepEqual(receipt.items, [
    { taskId: 'task-1', stage: 'complete', status: 'duplicate', amount: '4.75000000' },
    { taskId: 'task-2', stage: 'complete', status: 'duplicate', amount: '0.00000000' },
  ])
  // Only the two read-only lookups ran: no claim, no model, no billing write.
  assert.equal(statements.length, 2)
  assert.ok(statements.every(({ sql }) => /^\s*SELECT/i.test(sql)))
})

test('task lookup is scoped to the exact bill month and the submitted Task IDs', async () => {
  const { pool, statements } = fakePool([
    // task-2 matches two calls in the month, task-3 matches none.
    {
      match: /UNION/,
      rows: [
        { task_id: 'task-1', call_id: 'call-1' },
        { task_id: 'task-2', call_id: 'call-2a' },
        { task_id: 'task-2', call_id: 'call-2b' },
      ],
    },
    {
      match: /kaudit_billing_calculation calculation/,
      rows: [{ call_id: 'call-1', amount: '1.00000000' }],
    },
  ])
  const receipt = await service(pool).process(request({
    items: [{ task_id: 'task-1' }, { task_id: 'task-2' }, { task_id: 'task-3' }],
  }))
  const lookup = statements[0]
  assert.ok(lookup)
  assert.deepEqual(lookup.parameters, [
    '2026-07-01', '2026-07-31', 'task-1', 'task-2', 'task-3',
    '2026-07-01', '2026-07-31', 'task-1', 'task-2', 'task-3',
  ])
  assert.deepEqual(statements[1]?.parameters, ['call-1'])
  assert.deepEqual(receipt.items.map((item) => [item.taskId, item.status, item.code]), [
    ['task-1', 'duplicate', undefined],
    ['task-2', 'failed', 'TASK_NOT_FOUND_OR_AMBIGUOUS'],
    ['task-3', 'failed', 'TASK_NOT_FOUND_OR_AMBIGUOUS'],
  ])
})

test('a swallowed billing failure logs only bounded identifiers', async () => {
  const { logReconciliationBillingFailure } = await import('./reconciliationBatch.ts')
  const written: string[] = []
  const original = process.stderr.write.bind(process.stderr)
  process.stderr.write = ((chunk: string) => {
    written.push(String(chunk))
    return true
  }) as typeof process.stderr.write
  try {
    logReconciliationBillingFailure('validate_and_bill', Object.assign(
      new Error("Duplicate entry 'https://recordings.example.test/x.ogg'"),
      { code: 'ER_DUP_ENTRY', errno: 1062, sql: 'INSERT secret' },
    ))
  } finally {
    process.stderr.write = original
  }
  assert.deepEqual(JSON.parse(written.join('')), {
    event: 'reconciliation_billing_failed',
    operation: 'validate_and_bill',
    name: 'Error',
    code: 'ER_DUP_ENTRY',
    errno: 1062,
    status: null,
    messageSha256: createHash('sha256')
      .update("Duplicate entry 'https://recordings.example.test/x.ogg'")
      .digest('hex').slice(0, 16),
  })
  assert.doesNotMatch(written.join(''), /recordings|secret|Duplicate/)
})

test('retry_audit is an accepted mode and scopes its lookup like the others', async () => {
  const { pool, statements } = fakePool([{ match: /UNION/, rows: [] }])
  const receipt = await service(pool).process(request({ mode: 'retry_audit' }))
  assert.equal(receipt.mode, 'retry_audit')
  assert.deepEqual(receipt.items.map((item) => item.code), ['TASK_NOT_FOUND_OR_AMBIGUOUS'])
  // Nothing was reset for a call that was not found.
  assert.ok(statements.every(({ sql }) => /^\s*SELECT/i.test(sql)))
})

test('accept_kserve_claim replays a settled call and refuses one that is not unresolved', async () => {
  const { pool, statements } = fakePool([
    { match: /UNION/, rows: [
      { task_id: 'task-settled', call_id: 'call-settled' },
      { task_id: 'task-agreed', call_id: 'call-agreed' },
    ] },
    { match: /AS basis/, rows: [
      { call_id: 'call-settled', basis: 'accepted_as_billed_unverified', amount: '9.50000000' },
      { call_id: 'call-agreed', basis: 'independent_category_service_end', amount: '4.75000000' },
    ] },
    // Neither call's latest consensus is unresolved.
    { match: /validation\.decision_status = 'unresolved'/, rows: [] },
  ])
  const receipt = await service(pool).process(request({
    mode: 'accept_kserve_claim',
    items: [{ task_id: 'task-settled' }, { task_id: 'task-agreed' }],
  }))
  assert.equal(receipt.mode, 'accept_kserve_claim')
  assert.deepEqual(receipt.items, [
    { taskId: 'task-settled', stage: 'complete', status: 'duplicate',
      code: 'ACCEPTED_AS_BILLED_UNVERIFIED|AUTOMATED_VALIDATION_UNRESOLVED', amount: '9.50000000' },
    { taskId: 'task-agreed', stage: 'upload', status: 'failed', code: 'ACCEPT_CLAIM_NOT_UNRESOLVED' },
  ])
  // No model, no money written.
  assert.ok(statements.every(({ sql }) => /^\s*SELECT/i.test(sql)))
})

test('cap_at_kserve leaves a call already within KServe charge untouched', async () => {
  const { pool, statements } = fakePool([
    { match: /UNION/, rows: [{ task_id: 'task-ok', call_id: 'call-ok' }, { task_id: 'task-x', call_id: 'call-x' }] },
    { match: /AS basis/, rows: [
      { call_id: 'call-ok', basis: 'independent_category_service_end', amount: '9.50000000' },
    ] },
    { match: /audited_media\.status = 'completed'/, rows: [{
      call_id: 'call-ok', audit_run_id: 'run-ok', fallback_reason: 'automated_validation_unresolved',
      vendor_billed_minutes: '1.00000000', vendor_billed_amount: '9.50000000',
      evidence_object_id: 'ev', evidence_sha256: 'a'.repeat(64),
    }] },
  ])
  const receipt = await service(pool).process(request({
    mode: 'cap_at_kserve', items: [{ task_id: 'task-ok' }, { task_id: 'task-x' }],
  }))
  assert.deepEqual(receipt.items, [
    { taskId: 'task-ok', stage: 'complete', status: 'duplicate', code: 'WITHIN_KSERVE_CHARGE', amount: '9.50000000' },
    { taskId: 'task-x', stage: 'upload', status: 'failed', code: 'CAP_NOT_AUDITED_OR_NO_KSERVE_CHARGE' },
  ])
  assert.ok(statements.every(({ sql }) => /^\s*SELECT/i.test(sql)))
})

test('new_month refuses up front while the month has no KServe invoice', async () => {
  const { pool, statements } = fakePool([
    { match: /UNION/, rows: [{ task_id: 'task-1', call_id: 'call-1' }] },
    { match: /CAST\(calculation\.total_amount AS CHAR\) AS amount/, rows: [] },
    { match: /FROM kaudit_invoice invoice/, rows: [] },
  ])
  const receipt = await service(pool).process(request({ mode: 'new_month' }))
  assert.deepEqual(receipt.items, [
    { taskId: 'task-1', stage: 'upload', status: 'failed', code: 'INVOICE_NOT_IMPORTED' },
  ])
  assert.ok(statements.every(({ sql }) => /^\s*SELECT/i.test(sql)))
})

test('a retry of a call that is already audited reports its bill as done', async () => {
  const run = async (sql: string) => {
    if (/UNION/.test(sql) && /logical_call_key AS task_id, c\.id/.test(sql)) {
      return [[{ task_id: 'task-done', call_id: 'call-done' }], []]
    }
    if (/FROM kaudit_call_artifact ca/.test(sql)) {
      return [[{ artifact_id: 'a1', has_source_url: 1, has_sha256: 1,
        audio_processing_status: 'completed', live_basis: 'independent_category_service_end',
        audit_completed: 1 }], []]
    }
    if (/CAST\(calculation\.total_amount AS CHAR\) AS amount/.test(sql)) {
      return [[{ call_id: 'call-done', amount: '42.75000000' }], []]
    }
    throw new Error(`unexpected SQL: ${sql.slice(0, 80)}`)
  }
  const connection = {
    execute: run, query: run, beginTransaction: async () => {}, commit: async () => {},
    rollback: async () => {}, release: () => {},
  }
  const pool = { execute: run, query: run, getConnection: async () => connection } as unknown as Pool
  const receipt = await service(pool).process(request({
    mode: 'retry_audit', items: [{ task_id: 'task-done' }],
  }))
  assert.deepEqual(receipt.items, [
    { taskId: 'task-done', stage: 'complete', status: 'duplicate', amount: '42.75000000' },
  ])
})
