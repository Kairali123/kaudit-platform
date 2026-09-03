import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Pool } from 'mysql2/promise'
import { REAUDIT_CLASSIFIER_RULESET_VERSION } from '../reaudit/core.ts'
import { createMysqlReauditReadRepo } from './mysqlReauditReadRepo.ts'

test('parameterizes an exact external task-ID scope in the candidate query', async () => {
  let capturedSql = ''
  let capturedParameters: unknown[] = []
  const pool = {
    async execute(sql: string, parameters: unknown[]) {
      capturedSql = sql
      capturedParameters = parameters
      return [
        [
          {
            call_id: 'call-1',
            artifact_id: 'artifact-1',
            source_url: 'https://recordings.example.test/call-1.ogg',
            baseline_sha256: null,
            claimed_duration_ms: 30_000,
            connected_duration_ms: 20_000,
            vendor_billed_minutes: '0.50000000',
          },
        ],
      ]
    },
  } as unknown as Pool

  const repo = createMysqlReauditReadRepo(pool, {
    externalTaskIds: ['task-a|1', 'task-b|1'],
  })
  const candidates = await repo.listCandidates({
    limit: 5,
    includePreviouslyClassified: false,
  })

  assert.match(capturedSql, /scope_ref\.provider_name = 'kserve'/)
  assert.match(
    capturedSql,
    /scope_ref\.reference_type IN \('task_id','taskId','task'\)/,
  )
  assert.match(capturedSql, /c\.logical_call_key IN \(\?,\?\)/)
  assert.match(capturedSql, /scope_ref\.external_id IN \(\?,\?\)/)
  assert.match(capturedSql, /FROM kaudit_invoice invoice/)
  assert.match(
    capturedSql,
    /c\.billing_period_date BETWEEN\s+invoice\.period_start AND invoice\.period_end/,
  )
  assert.match(capturedSql, /invoice\.status IN \('received','matched','approved'\)/)
  assert.match(
    capturedSql,
    /audio_processing_status = 'exhausted'[\s\S]*CLASSIFICATION_VALIDATION_FAILED[\s\S]*AUDIT_SPEND_STATE_UNKNOWN/,
  )
  assert.match(
    capturedSql,
    /COALESCE\(ca\.audio_processing_status, 'pending'\)\s+NOT IN \('completed','exhausted'\)/,
  )
  assert.match(capturedSql, /COALESCE\(ca\.audio_attempt_count, 0\) < 8/)
  assert.doesNotMatch(capturedSql, /CLASSIFICATION_OUTPUT_UNRECOVERABLE/)
  assert.match(
    capturedSql,
    /ORDER BY COALESCE\(ca\.audio_attempt_count, 0\), c\.billing_period_date, c\.id/,
  )
  assert.match(capturedSql, /GROUP BY[^]*ca\.audio_attempt_count/)
  assert.deepEqual(capturedParameters, [
    0,
    0,
    'task-a|1',
    'task-b|1',
    'task-a|1',
    'task-b|1',
    5,
  ])
  assert.equal(candidates.length, 1)
  assert.equal(candidates[0]?.callId, 'call-1')
})

test('completed candidates require an explicit reader capability', async () => {
  const pool = {
    async execute() {
      throw new Error('query must not run')
    },
  } as unknown as Pool
  const repo = createMysqlReauditReadRepo(pool, {
    externalTaskIds: ['synthetic-task'],
  })

  await assert.rejects(
    repo.listCandidates({ limit: 1, includePreviouslyClassified: true }),
    /explicitly enabled reader/,
  )
})

test('explicit completed-call reader bypasses only processing and history filters', async () => {
  let capturedSql = ''
  let capturedParameters: unknown[] = []
  const pool = {
    async execute(sql: string, parameters: unknown[]) {
      capturedSql = sql
      capturedParameters = parameters
      return [[]]
    },
  } as unknown as Pool
  const repo = createMysqlReauditReadRepo(pool, {
    externalTaskIds: ['synthetic-task'],
    allowPreviouslyClassified: true,
  })

  await repo.listCandidates({ limit: 1, includePreviouslyClassified: true })

  assert.match(
    capturedSql,
    /\? = 1 OR \(\s*COALESCE\(ca\.audio_attempt_count, 0\) < 8/,
  )
  assert.match(capturedSql, /\? = 1 OR \(\s*NOT EXISTS/)
  assert.match(capturedSql, /scope_ref\.external_id IN \(\?\)/)
  assert.match(capturedSql, /c\.outcome_taxonomy_version <> \?/)
  assert.deepEqual(capturedParameters, [
    1,
    1,
    REAUDIT_CLASSIFIER_RULESET_VERSION,
    'synthetic-task',
    'synthetic-task',
    1,
  ])
})

test('deferred work is read as the inverse of the backoff gate, in server time', async () => {
  let capturedSql = ''
  let capturedParameters: unknown[] = []
  const pool = {
    async execute(sql: string, parameters: unknown[]) {
      capturedSql = sql
      capturedParameters = parameters
      return [[{ due_in_us: '480000000' }]]
    },
  } as unknown as Pool

  const repo = createMysqlReauditReadRepo(pool, {
    externalTaskIds: ['task-a|1'],
  })
  const dueInMs = await repo.deferredWorkDueInMs()

  assert.equal(dueInMs, 480_000)
  // The remaining time is measured by the database against its own clock.
  assert.match(
    capturedSql,
    /TIMESTAMPDIFF\(\s*MICROSECOND,\s*current_timestamp\(6\),\s*MIN\(ca\.audio_next_attempt_at\)\s*\)/,
  )
  // Same eligibility predicate as the candidate read, with the one backoff
  // clause inverted. Anything else would wait for unclaimable work.
  assert.match(
    capturedSql,
    /ca\.audio_next_attempt_at > current_timestamp\(6\)/,
  )
  assert.match(capturedSql, /COALESCE\(ca\.audio_attempt_count, 0\) < 8/)
  assert.match(
    capturedSql,
    /COALESCE\(ca\.audio_processing_status, 'pending'\)\s+NOT IN \('completed','exhausted'\)/,
  )
  assert.match(capturedSql, /FROM kaudit_invoice invoice/)
  assert.match(capturedSql, /FROM kaudit_audit_run ar/)
  assert.match(capturedSql, /scope_ref\.provider_name = 'kserve'/)
  assert.deepEqual(capturedParameters, ['task-a|1', 'task-a|1'])
})

test('no deferred retry reports null rather than a zero wait', async () => {
  const pool = {
    async execute() {
      return [[{ due_in_us: null }]]
    },
  } as unknown as Pool

  assert.equal(
    await createMysqlReauditReadRepo(pool).deferredWorkDueInMs(),
    null,
  )
})

test('a deferral that has already elapsed never reports a negative wait', async () => {
  const pool = {
    async execute() {
      return [[{ due_in_us: '-2500000' }]]
    },
  } as unknown as Pool

  assert.equal(
    await createMysqlReauditReadRepo(pool).deferredWorkDueInMs(),
    0,
  )
})

test('a reader that ignores the backoff gate reports no deferred work', async () => {
  let queried = false
  const pool = {
    async execute() {
      queried = true
      return [[]]
    },
  } as unknown as Pool

  const repo = createMysqlReauditReadRepo(pool, {
    allowPreviouslyClassified: true,
  })

  assert.equal(await repo.deferredWorkDueInMs(), null)
  assert.equal(queried, false)
})
