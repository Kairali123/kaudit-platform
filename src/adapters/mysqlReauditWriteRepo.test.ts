import assert from 'node:assert/strict'
import test from 'node:test'
import type { Pool } from 'mysql2/promise'
import { createMysqlReauditWriteRepo } from './mysqlReauditWriteRepo.ts'

const candidate = {
  callId: 'synthetic-call',
  artifactId: 'synthetic-artifact',
  sourceUrl: 'https://recordings.example.test/synthetic.ogg',
  baselineSha256: null,
  claimedDurationMs: 10_000,
  connectedDurationMs: 9_000,
  vendorBilledMinutes: '1.00000000',
}

function appendPool(options: {
  currentRuleset?: boolean
  audioAttemptCount?: number
} = {}) {
  const statements: string[] = []
  let committed = 0
  let rolledBack = 0
  const connection = {
    async beginTransaction() {},
    async execute(sql: string) {
      statements.push(sql)
      if (/SELECT EXISTS/.test(sql)) {
        return [[{ n: options.currentRuleset ? 1 : 0 }]]
      }
      if (/SELECT audio_attempt_count/.test(sql)) {
        return [[{ audio_attempt_count: options.audioAttemptCount ?? 8 }]]
      }
      return [{ affectedRows: 1 }]
    },
    async commit() {
      committed += 1
    },
    async rollback() {
      rolledBack += 1
    },
    release() {},
  }
  const pool = {
    async getConnection() {
      return connection
    },
  } as unknown as Pool
  return {
    pool,
    statements,
    committed: () => committed,
    rolledBack: () => rolledBack,
  }
}

test('append re-audit claims an older completed call without resetting its artifact', async () => {
  const fixture = appendPool()
  const repo = createMysqlReauditWriteRepo(fixture.pool, {
    allowCompletedReaudit: true,
  })

  const outcome = await repo.markStarted(candidate, new Date(0))

  assert.equal(outcome, 'acquired')
  assert.equal(fixture.committed(), 1)
  assert.equal(fixture.rolledBack(), 0)
  assert.equal(
    fixture.statements.some((sql) => /UPDATE kaudit_call_artifact/.test(sql)),
    false,
  )
})

test('ordinary claiming reopens only bounded legacy exhausted failures', async () => {
  const fixture = appendPool()
  const repo = createMysqlReauditWriteRepo(fixture.pool)

  const outcome = await repo.markStarted(candidate, new Date(0))
  const update = fixture.statements.find((sql) =>
    /UPDATE kaudit_call_artifact/.test(sql),
  )

  assert.equal(outcome, 'acquired')
  assert.match(String(update), /audio_attempt_count < 8/)
  assert.match(String(update), /CLASSIFICATION_VALIDATION_FAILED/)
  assert.match(String(update), /AUDIT_SPEND_STATE_UNKNOWN/)
  assert.doesNotMatch(String(update), /CLASSIFICATION_OUTPUT_UNRECOVERABLE/)
})

test('append re-audit skips a call already current under this ruleset', async () => {
  const fixture = appendPool({ currentRuleset: true })
  const repo = createMysqlReauditWriteRepo(fixture.pool, {
    allowCompletedReaudit: true,
  })

  const outcome = await repo.markStarted(candidate, new Date(0))

  assert.equal(outcome, 'already_completed')
  assert.equal(fixture.statements.length, 1)
})

test('failed append re-audit records history and preserves current call state', async () => {
  const fixture = appendPool()
  const repo = createMysqlReauditWriteRepo(fixture.pool, {
    allowCompletedReaudit: true,
  })

  const outcome = await repo.persist(
    candidate,
    {
      callId: candidate.callId,
      artifactId: candidate.artifactId,
      outcome: 'classification_failed',
      errorCode: 'CLASSIFIER_OUTPUT_INVALID',
    },
    new Date(0),
  )

  assert.equal(outcome, 'terminal_failure')
  assert.equal(fixture.committed(), 1)
  assert.equal(fixture.rolledBack(), 0)
  assert.equal(
    fixture.statements.some((sql) => /INSERT INTO kaudit_audit_run/.test(sql)),
    true,
  )
  assert.equal(
    fixture.statements.some((sql) => /INSERT INTO kaudit_audit_finding/.test(sql)),
    true,
  )
  assert.equal(
    fixture.statements.some((sql) => /UPDATE kaudit_call(?:_artifact)?/.test(sql)),
    false,
  )
})

test('a paid classification failure is terminal on its first persisted attempt', async () => {
  const fixture = appendPool({ audioAttemptCount: 1 })
  const repo = createMysqlReauditWriteRepo(fixture.pool)

  const outcome = await repo.persist(
    candidate,
    {
      callId: candidate.callId,
      artifactId: candidate.artifactId,
      outcome: 'classification_failed',
      errorCode: 'CLASSIFICATION_OUTPUT_UNRECOVERABLE',
    },
    new Date(0),
  )

  assert.equal(outcome, 'terminal_failure')
  assert.equal(
    fixture.statements.some((sql) =>
      /SET audio_processing_status = \?, audio_next_attempt_at = \?/.test(sql),
    ),
    true,
  )
})

test('ordinary persistence locks the call row instead of an audit-run gap', async () => {
  const fixture = appendPool()
  const repo = createMysqlReauditWriteRepo(fixture.pool)

  await repo.persist(
    candidate,
    {
      callId: candidate.callId,
      artifactId: candidate.artifactId,
      outcome: 'source_missing',
      errorCode: 'SOURCE_MISSING',
    },
    new Date(0),
  )

  assert.equal(
    fixture.statements.some(
      (sql) => /FROM kaudit_call\s+WHERE id = \?\s+FOR UPDATE/.test(sql),
    ),
    true,
  )
  assert.equal(
    fixture.statements.some(
      (sql) => /FROM kaudit_audit_run[^]*FOR UPDATE/.test(sql),
    ),
    false,
  )
})
