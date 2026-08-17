import assert from 'node:assert/strict'
import test from 'node:test'
import type { Pool } from 'mysql2/promise'
import type {
  ReauditCandidate,
  ReauditItemResult,
} from '../reaudit/types.ts'
import { createMysqlReauditWriteRepo } from './mysqlReauditWriteRepo.ts'

/**
 * The audit writer in ADMINISTRATOR-REQUESTED mode.
 *
 * What is proven here, all through a recording fake pool and with no database,
 * no provider, and no model call:
 *
 *   * the captured baseline — not the classifier ruleset — decides whether to
 *     spend, so a same-ruleset rerun is allowed;
 *   * a call that moved on since selection is SKIPPED, not re-audited;
 *   * a success appends a run, advances the latest-run pointer, and settles the
 *     queue item in the SAME transaction; and
 *   * a failure records bounded history and leaves the prior successful result
 *     current.
 *
 * Every id, hash, and duration below is SYNTHETIC.
 */

const BASELINE = 'run-synthetic-baseline'

const candidate: ReauditCandidate = {
  callId: 'call-synthetic-1',
  artifactId: 'artifact-synthetic-1',
  sourceUrl: 'https://recordings.example.test/synthetic.ogg',
  baselineSha256: 'a'.repeat(64),
  claimedDurationMs: 190_000,
  connectedDurationMs: 180_000,
  vendorBilledMinutes: '3.00000000',
  manualRequest: {
    requestId: 'brr_synthetic',
    itemId: 'bri_synthetic-1',
    baselineAuditRunId: BASELINE,
  },
}

const SUCCESS: ReauditItemResult = {
  callId: candidate.callId,
  artifactId: candidate.artifactId,
  outcome: 'projected',
  analysis: {
    category: 'OK',
    confidence: '0.94000000',
    language: 'english',
    recordedDurationMs: 190_000,
    speechDurationMs: 80_000,
    conversationAssessment: 'established',
    lastMeaningfulCustomerExchangeMs: 61_000,
    customerSpeechMs: 30_000,
    agentSpeechMs: 50_000,
    durationMismatch: false,
    evidenceSha256: 'b'.repeat(64),
    remarks: 'Synthetic remark for a synthetic call.',
    disputeRecommended: false,
  },
  transcription: {
    model: { provider: 'openai', name: 'whisper-1', version: 'whisper-1' },
    language: 'english',
    durationMs: 190_000,
    speechMs: 80_000,
    text: 'synthetic transcript',
    segments: [{ startMs: 0, endMs: 1_000, text: 'synthetic transcript' }],
  },
  classification: {
    model: { provider: 'openai', name: 'synthetic-model', version: '1' },
    category: 'OK',
    confidence: '0.94000000',
    customerBlockNumbers: [1],
    unclearBlockNumbers: [],
    customerSpoke: true,
    lastMeaningfulCustomerExchangeMs: 61_000,
    remarks: 'Synthetic remark for a synthetic call.',
    disputeRecommended: false,
  },
}

function manualPool(options: { latestAuditRunId?: string | null } = {}) {
  const statements: Array<{ sql: string; parameters: unknown[] }> = []
  let committed = 0
  let rolledBack = 0
  const connection = {
    async beginTransaction() {},
    async execute(sql: string, parameters: unknown[] = []) {
      statements.push({ sql, parameters })
      if (/SELECT latest_audit_run_id/.test(sql)) {
        return [
          [
            {
              latest_audit_run_id:
                'latestAuditRunId' in options
                  ? options.latestAuditRunId
                  : BASELINE,
            },
          ],
        ]
      }
      if (/SELECT audio_attempt_count/.test(sql)) {
        return [[{ audio_attempt_count: 1 }]]
      }
      if (/^SELECT/.test(sql.trim())) return [[]]
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
    find(pattern: RegExp) {
      return statements.find((entry) => pattern.test(entry.sql))
    },
    all(pattern: RegExp) {
      return statements.filter((entry) => pattern.test(entry.sql))
    },
  }
}

function manualRepo(fixture: ReturnType<typeof manualPool>) {
  return createMysqlReauditWriteRepo(fixture.pool, { manualRequest: true })
}

test('an unchanged baseline is claimed without touching the intake pipeline', async () => {
  const fixture = manualPool()
  const outcome = await manualRepo(fixture).markStarted(candidate, new Date(0))

  assert.equal(outcome, 'acquired')
  assert.equal(fixture.committed(), 1)
  assert.equal(fixture.rolledBack(), 0)
  // The baseline is read under a row lock the following write then holds.
  assert.match(
    String(fixture.find(/SELECT latest_audit_run_id/)?.sql),
    /FOR UPDATE/,
  )
  // Nothing about the call, its artifact, or its current result is changed.
  assert.equal(fixture.all(/UPDATE kaudit_call/).length, 0)
})

test('a same-ruleset rerun is allowed: the ruleset is never compared', async () => {
  const fixture = manualPool()
  await manualRepo(fixture).markStarted(candidate, new Date(0))
  const asked = JSON.stringify(fixture.statements)
  assert.equal(asked.includes('outcome_taxonomy_version'), false)
  assert.equal(asked.includes('kairali-12cat'), false)
})

test('a call that moved on since selection is skipped, never re-audited', async () => {
  const fixture = manualPool({ latestAuditRunId: 'run-synthetic-newer' })
  const outcome = await manualRepo(fixture).markStarted(candidate, new Date(0))

  assert.equal(outcome, 'already_completed')
  const settle = fixture.find(/UPDATE kaudit_billing_reaudit_item/)
  assert.equal(settle?.parameters[0], 'skipped')
  assert.equal(settle?.parameters[2], null)
  assert.equal(fixture.committed(), 1)
})

test('persist re-checks the baseline and discards a stale answer', async () => {
  const fixture = manualPool({ latestAuditRunId: 'run-synthetic-newer' })
  const outcome = await manualRepo(fixture).persist(
    candidate,
    SUCCESS,
    new Date(0),
  )

  assert.equal(outcome, 'already_completed')
  assert.equal(
    fixture.find(/UPDATE kaudit_billing_reaudit_item/)?.parameters[0],
    'skipped',
  )
  // A newer result stays current: no run, finding, or pointer move happens.
  assert.equal(fixture.all(/INSERT INTO kaudit_audit_run/).length, 0)
  assert.equal(fixture.all(/UPDATE kaudit_call\b/).length, 0)
})

test('a successful requested re-audit appends a run and advances the pointer', async () => {
  const fixture = manualPool()
  const outcome = await manualRepo(fixture).persist(
    candidate,
    SUCCESS,
    new Date(0),
  )

  assert.equal(outcome, 'completed')
  assert.equal(fixture.committed(), 1)
  assert.equal(fixture.rolledBack(), 0)
  assert.match(
    String(fixture.find(/INSERT INTO kaudit_audit_run/)?.sql),
    /'completed'/,
  )
  const call = fixture.find(/UPDATE kaudit_call\b/)
  assert.match(String(call?.sql), /latest_audit_run_id = \?/)
  // The queue item settles in the SAME transaction as the audit it paid for.
  assert.equal(
    fixture.find(/UPDATE kaudit_billing_reaudit_item/)?.parameters[0],
    'completed',
  )
})

test('a same-ruleset rerun gets its own outbox identity', async () => {
  const fixture = manualPool()
  await manualRepo(fixture).persist(candidate, SUCCESS, new Date(0))
  const message = fixture.find(/INSERT INTO kaudit_outbox_message/)
  const messageId = String(message?.parameters[1])

  assert.match(messageId, /^audit-completed:manual:bri_synthetic-1:[0-9a-f]{64}$/)

  // The same call, evidence and ruleset re-run under a DIFFERENT queue item
  // produces a different message, so the two never collide.
  const second = manualPool()
  await manualRepo(second).persist(
    {
      ...candidate,
      manualRequest: {
        ...candidate.manualRequest!,
        itemId: 'bri_synthetic-2',
      },
    },
    SUCCESS,
    new Date(0),
  )
  assert.notEqual(
    String(second.find(/INSERT INTO kaudit_outbox_message/)?.parameters[1]),
    messageId,
  )
})

test('a failed requested re-audit records history and keeps the prior result', async () => {
  const fixture = manualPool()
  const outcome = await manualRepo(fixture).persist(
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
  assert.match(
    String(fixture.find(/INSERT INTO kaudit_audit_run/)?.sql),
    /'failed'/,
  )
  assert.equal(fixture.all(/INSERT INTO kaudit_audit_finding/).length, 1)
  // The current successful result and the intake pipeline are both untouched.
  assert.equal(fixture.all(/UPDATE kaudit_call\b/).length, 0)
  assert.equal(fixture.all(/UPDATE kaudit_call_artifact/).length, 0)
  assert.equal(fixture.all(/SELECT audio_attempt_count/).length, 0)
  // The item is settled with a bounded code and is not retried automatically.
  const settle = fixture.find(/UPDATE kaudit_billing_reaudit_item/)
  assert.equal(settle?.parameters[0], 'failed')
  assert.equal(settle?.parameters[2], 'CLASSIFIER_OUTPUT_INVALID')
})

test('an unclaimed candidate is refused rather than audited unaccounted for', async () => {
  const fixture = manualPool()
  const { manualRequest: _claimed, ...unclaimed } = candidate
  await assert.rejects(
    () => manualRepo(fixture).markStarted(unclaimed, new Date(0)),
    (error: Error & { code?: string }) => {
      assert.equal(error.code, 'REAUDIT_ITEM_UNCLAIMED')
      return true
    },
  )
  assert.equal(fixture.rolledBack(), 1)
})

test('ordinary and targeted writers are unchanged by requested mode existing', async () => {
  const fixture = manualPool()
  const repo = createMysqlReauditWriteRepo(fixture.pool)
  await repo.markStarted(
    { ...candidate, manualRequest: undefined },
    new Date(0),
  )
  // The intake path still claims through the artifact's own processing state.
  assert.equal(fixture.all(/UPDATE kaudit_call_artifact/).length, 1)
  assert.equal(fixture.all(/UPDATE kaudit_billing_reaudit_item/).length, 0)
})
