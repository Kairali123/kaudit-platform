import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Pool } from 'mysql2/promise'
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
  assert.match(capturedSql, /scope_ref\.reference_type = 'task_id'/)
  assert.match(capturedSql, /scope_ref\.external_id IN \(\?,\?\)/)
  assert.match(capturedSql, /FROM kaudit_invoice invoice/)
  assert.match(
    capturedSql,
    /c\.billing_period_date BETWEEN\s+invoice\.period_start AND invoice\.period_end/,
  )
  assert.match(capturedSql, /invoice\.status IN \('received','matched','approved'\)/)
  assert.deepEqual(capturedParameters, [0, 'task-a|1', 'task-b|1', 5])
  assert.equal(candidates.length, 1)
  assert.equal(candidates[0]?.callId, 'call-1')
})
