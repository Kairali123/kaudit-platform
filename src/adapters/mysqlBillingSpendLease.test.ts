import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Pool } from 'mysql2/promise'
import type { ReauditCandidate, ReauditItemResult } from '../reaudit/types.ts'
import { createMysqlBillingSpendGuard } from './mysqlBillingSpendLease.ts'

const candidate: ReauditCandidate = {
  callId: 'call-synthetic-1',
  artifactId: 'artifact-synthetic-1',
  sourceUrl: 'https://recordings.example.test/synthetic.ogg',
  baselineSha256: 'a'.repeat(64),
  claimedDurationMs: 60_000,
  connectedDurationMs: 60_000,
  vendorBilledMinutes: '1',
}

function fakePool(options: {
  lease?: { status: string; staged_result_json: unknown }
  owned?: boolean
} = {}) {
  const statements: Array<{ sql: string; parameters: unknown[] }> = []
  let insertSeen = false
  const pool = {
    async execute(sql: string, parameters: unknown[] = []) {
      statements.push({ sql, parameters })
      if (/INSERT INTO kaudit_billing_spend_lease/.test(sql)) {
        if (!insertSeen && options.lease) {
          insertSeen = true
          throw Object.assign(new Error('synthetic duplicate'), {
            code: 'ER_DUP_ENTRY',
          })
        }
        return [{ affectedRows: 1 }, []]
      }
      if (/SELECT status, staged_result_json/.test(sql)) {
        return [[options.lease], []]
      }
      if (/SELECT 1 AS owned/.test(sql)) {
        return [options.owned === false ? [] : [{ owned: 1 }], []]
      }
      return [{ affectedRows: 1 }, []]
    },
  } as unknown as Pool
  return { pool, statements }
}

test('an unstaged ambiguous lease recovers as terminal without a paid reclaim', async () => {
  const fake = fakePool({
    lease: { status: 'active', staged_result_json: null },
  })
  const guard = createMysqlBillingSpendGuard(fake.pool, {
    exclusiveRecovery: true,
  })
  const claim = await guard.claim(candidate)

  assert.equal(claim.outcome, 'recovered')
  assert.equal(
    claim.outcome === 'recovered' ? claim.result.outcome : null,
    'spend_state_unknown',
  )
  const recovery = fake.statements.find((entry) =>
    /staged_result_json = \?/.test(entry.sql),
  )
  assert.ok(recovery)
  assert.doesNotMatch(recovery.sql, /attempt_count\s*=\s*attempt_count\s*\+/)
  assert.match(String(recovery.parameters[3]), /AUDIT_SPEND_STATE_UNKNOWN/)
})

test('a completed lease returns terminal reconciliation instead of staying busy', async () => {
  const fake = fakePool({
    lease: { status: 'completed', staged_result_json: null },
  })
  const guard = createMysqlBillingSpendGuard(fake.pool)
  const claim = await guard.claim(candidate)

  assert.equal(claim.outcome, 'closed')
  assert.equal(
    claim.outcome === 'closed' ? claim.result.outcome : null,
    'spend_state_unknown',
  )
})

test('staged recovery accepts JSON already decoded by mysql2', async () => {
  const fake = fakePool({
    lease: {
      status: 'active',
      staged_result_json: {
        callId: candidate.callId,
        artifactId: candidate.artifactId,
        outcome: 'classification_failed',
        errorCode: 'CLASSIFICATION_FAILED',
      },
    },
  })
  const guard = createMysqlBillingSpendGuard(fake.pool, {
    exclusiveRecovery: true,
  })

  const claim = await guard.claim(candidate)

  assert.equal(claim.outcome, 'recovered')
  assert.equal(
    claim.outcome === 'recovered' ? claim.result.outcome : null,
    'classification_failed',
  )
})

test('temporary staging keeps only fields required by final persistence', async () => {
  const fake = fakePool()
  const guard = createMysqlBillingSpendGuard(fake.pool)
  await guard.claim(candidate)
  const result: ReauditItemResult = {
    callId: candidate.callId,
    artifactId: candidate.artifactId,
    outcome: 'projected',
    analysis: {
      category: 'OK',
      confidence: '0.90000000',
      language: 'english',
      recordedDurationMs: 60_000,
      speechDurationMs: 20_000,
      conversationAssessment: 'established',
      lastMeaningfulCustomerExchangeMs: 10_000,
      customerSpeechMs: 10_000,
      agentSpeechMs: 10_000,
      chargeableServiceEndMs: 10_000,
      appliedBillingGraceMs: 50_000,
      categoryChargePolicyCode: 'STANDARD_CUSTOMER_PLUS_GRACE',
      durationMismatch: false,
      evidenceSha256: 'b'.repeat(64),
      remarks: 'Synthetic bounded finding.',
      disputeRecommended: false,
    },
    transcription: {
      model: { provider: 'openai', name: 'whisper-1', version: 'whisper-1' },
      language: 'english',
      durationMs: 60_000,
      speechMs: 20_000,
      text: 'unused whole transcript',
      segments: [{ startMs: 0, endMs: 1_000, text: 'synthetic segment' }],
    },
    classification: {
      model: { provider: 'openai', name: 'synthetic-model', version: '1' },
      category: 'OK',
      confidence: '0.90000000',
      customerBlockNumbers: [1],
      unclearBlockNumbers: [2],
      customerSpoke: true,
      lastMeaningfulCustomerExchangeMs: 10_000,
      remarks: 'unused duplicate provider prose',
      disputeRecommended: false,
    },
    projection: {
      amount: '123.45000000',
      amountPaise: 12345n,
      billableMinutes: '1',
      billableDurationMs: 60_000,
      adjustedChargeableDurationMs: 60_000,
      oneWayTailMs: 0,
      oneWayTailAlert: false,
      categoryChargePolicyCode: 'STANDARD_CUSTOMER_PLUS_GRACE',
      ruleCode: 'PER_MINUTE_CEIL',
      authority: 'provisional_uncalibrated',
    },
  }

  await guard.stageResult(candidate, result)
  const stage = fake.statements.find((entry) =>
    /SET staged_result_json = \?/.test(entry.sql),
  )
  const stored = String(stage?.parameters[0])
  assert.ok(stored.includes('synthetic segment'))
  assert.ok(!stored.includes('unused whole transcript'))
  assert.ok(!stored.includes('unused duplicate provider prose'))
  assert.ok(!stored.includes('123.45000000'))
  assert.ok(!stored.includes('amountPaise'))
  assert.ok(!stored.includes('projection'))
})

test('unknown settlement still checks claim ownership', async () => {
  const fake = fakePool({ owned: false })
  const guard = createMysqlBillingSpendGuard(fake.pool)
  await assert.rejects(
    () => guard.settle(candidate, 'unknown'),
    (error: Error & { code?: string }) => {
      assert.equal(error.code, 'REAUDIT_ITEM_STATE_CONFLICT')
      return true
    },
  )
})

test('successful settlement clears temporary staged content under ownership', async () => {
  const fake = fakePool()
  const guard = createMysqlBillingSpendGuard(fake.pool)
  await guard.settle(candidate, 'model_spent')
  const settle = fake.statements.at(-1)
  assert.match(String(settle?.sql), /staged_result_json = NULL/)
  assert.match(String(settle?.sql), /worker_id = \?/)
})
