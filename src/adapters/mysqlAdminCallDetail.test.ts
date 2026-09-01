import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Pool } from 'mysql2/promise'
import {
  collectAdminCallDetail,
  type AdminCallAccess,
} from './mysqlAdminCallDetail.ts'

const ACCESS: AdminCallAccess = {
  callId: 'call-synthetic-1',
  callReference: 'task-synthetic-1',
  sensitivityTier: 'K0',
  sourceUrl: 'https://media.example.test/synthetic.ogg',
  evidenceSha256: 'a'.repeat(64),
}

const DETAIL_ROW = {
  billing_period_date: '2026-08-01',
  category: 'USER_SILENCE',
  confirmation_status: 'model_output',
  confidence: '0.95000000',
  language: 'english',
  transcript_id: null,
  recorded_duration_ms: 100_000,
  speech_duration_ms: 40_000,
  conversation_end_ms: null,
  audited_service_end_ms: 40_000,
  audited_grace_ms: 60_000,
  vendor_billed_minutes: '3.00000000',
  vendor_connected_duration_ms: 120_000,
  vendor_amount: '28.50000000',
  calculation_basis: null,
  calculation_status: null,
  auditor_adjusted_duration_ms: null,
  auditor_billable_duration_ms: null,
  auditor_billable_minutes: null,
  auditor_amount: null,
  auditor_rule_code: null,
  auditor_increment: null,
  auditor_unit_rate: null,
  rate_card_version: null,
  rate_card_status: null,
  evidence_sha256: 'a'.repeat(64),
  last_verified_at: '2026-08-02 00:00:00',
  audit_engine_version: 'synthetic-engine/1.0.0',
  audit_completed_at: '2026-08-02 00:00:00',
}

function fakePool(row: Record<string, unknown>) {
  const statements: string[] = []
  const pool = {
    async execute(sql: string) {
      statements.push(sql)
      if (sql.includes('FROM kaudit_call c')) return [[row]]
      if (sql.includes('FROM kaudit_transcript_segment')) return [[]]
      return [[]]
    },
  } as unknown as Pool
  return { pool, statements }
}

interface DetailResult {
  call: { confirmationStatus: string | null }
  durations: {
    chargeableServiceEndMs: number | null
    appliedBillingGraceMs: number | null
    adjustedChargeableMs: number | null
  }
  comparison: {
    auditor: {
      authority: string
      amount: string | null
      billableMinutes: string | null
      ruleCode: string | null
      projectionRulesetVersion: string | null
    }
    variance: string | null
  }
}

test('completed model output gets a deterministic per-call projection', async () => {
  const fake = fakePool(DETAIL_ROW)
  const detail = await collectAdminCallDetail(
    fake.pool,
    ACCESS,
  ) as DetailResult

  assert.equal(detail.call.confirmationStatus, 'model_output')
  assert.equal(detail.durations.chargeableServiceEndMs, 40_000)
  assert.equal(detail.durations.appliedBillingGraceMs, 60_000)
  assert.equal(detail.durations.adjustedChargeableMs, 100_000)
  assert.equal(detail.comparison.auditor.authority, 'projected')
  assert.equal(detail.comparison.auditor.amount, '19.00000000')
  assert.equal(detail.comparison.auditor.billableMinutes, '2.00000000')
  assert.equal(detail.comparison.auditor.ruleCode, 'PER_MINUTE_CEIL')
  assert.equal(
    detail.comparison.auditor.projectionRulesetVersion,
    '2026-07-27.1',
  )
  assert.equal(detail.comparison.variance, '9.5')

  const sql = fake.statements[0] ?? ''
  assert.match(sql, /\$\.chargeableServiceEndMs/)
  assert.match(sql, /\$\.appliedBillingGraceMs/)
  assert.match(sql, /finding\.finding_code = c\.canonical_outcome_code/)
  assert.doesNotMatch(sql, /finding\.confirmation_status = 'confirmed'/)
})

test('a persisted final calculation takes precedence over projection', async () => {
  const fake = fakePool({
    ...DETAIL_ROW,
    calculation_basis: 'independent_category_service_end',
    calculation_status: 'final',
    auditor_adjusted_duration_ms: 61_000,
    auditor_billable_duration_ms: 120_000,
    auditor_billable_minutes: '2.00000000',
    auditor_amount: '19.00000000',
    auditor_rule_code: 'PER_MINUTE_CEIL',
    auditor_increment: '1 minute',
    auditor_unit_rate: '9.50000000',
    rate_card_version: 'synthetic-rate-card-v1',
    rate_card_status: 'published',
  })
  const detail = await collectAdminCallDetail(
    fake.pool,
    ACCESS,
  ) as DetailResult

  assert.equal(detail.comparison.auditor.authority, 'final')
  assert.equal(detail.comparison.auditor.amount, '19.00000000')
  assert.equal(detail.comparison.auditor.projectionRulesetVersion, null)
  assert.equal(detail.durations.adjustedChargeableMs, 61_000)
})

test('a malformed final calculation is not concealed by a projection', async () => {
  const fake = fakePool({
    ...DETAIL_ROW,
    calculation_status: 'final',
  })
  const detail = await collectAdminCallDetail(
    fake.pool,
    ACCESS,
  ) as DetailResult

  assert.equal(detail.comparison.auditor.authority, 'final')
  assert.equal(detail.comparison.auditor.amount, null)
  assert.equal(detail.comparison.auditor.projectionRulesetVersion, null)
})

test('missing service endpoint remains unavailable instead of becoming zero', async () => {
  const fake = fakePool({
    ...DETAIL_ROW,
    audited_service_end_ms: null,
  })
  const detail = await collectAdminCallDetail(
    fake.pool,
    ACCESS,
  ) as DetailResult

  assert.equal(detail.comparison.auditor.authority, 'unavailable')
  assert.equal(detail.comparison.auditor.amount, null)
  assert.equal(detail.comparison.variance, null)
})

test('legacy voicemail uses its final transcript timestamp and 30 second grace', async () => {
  const pool = {
    async execute(sql: string) {
      if (sql.includes('FROM kaudit_call c')) return [[{
        ...DETAIL_ROW,
        category: 'VOICEMAIL',
        transcript_id: 'transcript-synthetic-1',
        audited_service_end_ms: null,
        audited_grace_ms: null,
      }]]
      if (sql.includes('FROM kaudit_transcript_segment')) {
        return [[
          { start_ms: 0, end_ms: 25_000, text: 'Synthetic agent speech.' },
          { start_ms: 30_000, end_ms: 40_000, text: 'Synthetic system speech.' },
        ]]
      }
      return [[]]
    },
  } as unknown as Pool
  const detail = await collectAdminCallDetail(
    pool,
    ACCESS,
  ) as DetailResult

  assert.equal(detail.durations.chargeableServiceEndMs, 40_000)
  assert.equal(detail.durations.appliedBillingGraceMs, 30_000)
  assert.equal(detail.durations.adjustedChargeableMs, 70_000)
  assert.equal(detail.comparison.auditor.amount, '19.00000000')
  assert.equal(detail.comparison.auditor.authority, 'projected')
})
