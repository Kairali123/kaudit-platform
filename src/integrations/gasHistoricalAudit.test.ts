import assert from 'node:assert/strict'
import test from 'node:test'
import type { Pool } from 'mysql2/promise'
import {
  createGasHistoricalAudit,
  signGasHistoricalStateToken,
  verifyGasHistoricalStateToken,
} from './gasHistoricalAudit.ts'

const secret = 'synthetic-historical-audit-secret-32-characters'
const payload = {
  v: 1 as const,
  month: '2026-06',
  taskId: 'T-synthetic-1',
  callId: 'call-synthetic-1',
  artifactId: 'artifact-synthetic-1',
  sourceUrlSha256: 'a'.repeat(64),
  latestAuditRunId: 'run-synthetic-1',
}

test('historical Sheet state token round-trips exact database state', () => {
  const token = signGasHistoricalStateToken(payload, secret)
  assert.deepEqual(verifyGasHistoricalStateToken(token, secret), payload)
  assert.equal(token.includes(payload.callId), false)
})

test('historical Sheet state token rejects tampering and a different secret', () => {
  const token = signGasHistoricalStateToken(payload, secret)
  assert.throws(
    () => verifyGasHistoricalStateToken(`${token.slice(0, -1)}x`, secret),
    /STATE_TOKEN_INVALID/,
  )
  assert.throws(
    () => verifyGasHistoricalStateToken(
      token,
      'different-synthetic-secret-32-characters',
    ),
    /STATE_TOKEN_INVALID/,
  )
})

test('month synchronization returns audit facts but never a stored recording URL', async () => {
  let queryCount = 0
  const pool = {
    async execute(sql: string) {
      queryCount += 1
      if (sql.includes('SELECT ref.external_id AS task_id')) {
        return [[{
          task_id: 'T-synthetic-1',
          call_id: 'call-synthetic-1',
        }]]
      }
      return [[{
        call_id: 'call-synthetic-1',
        artifact_id: 'artifact-synthetic-1',
        source_url: 'https://recordings.example.test/private.ogg',
        artifact_sha256: 'b'.repeat(64),
        latest_audit_run_id: 'run-synthetic-1',
        latest_audit_status: 'completed',
        connected_seconds: '42.00000000',
        vendor_billed_minutes: '1.00000000',
        vendor_billed_amount: '9.50000000',
        category: 'OK',
        confidence: '0.95000000',
        verified_amount: '9.50000000',
        calculation_basis: 'independent_category_service_end',
      }]]
    },
  } as unknown as Pool
  const receipt = await createGasHistoricalAudit(pool).list({
    billMonth: '2026-06',
    tokenSecret: secret,
    body: { schema_version: '1', bill_month: '2026-06', limit: 500 },
  })

  assert.equal(receipt.rows.length, 1)
  assert.equal(receipt.rows[0]?.recordingStatus, 'ATTACHED')
  assert.equal(receipt.rows[0]?.auditStatus, 'AUDITED')
  assert.equal('sourceUrl' in (receipt.rows[0] ?? {}), false)
  assert.equal(JSON.stringify(receipt).includes('private.ogg'), false)
  assert.equal(queryCount, 2)
})

test('month synchronization paginates by indexed call id before hydrating details', async () => {
  const queries: Array<{ sql: string; params: unknown[] }> = []
  const pool = {
    async execute(sql: string, params: unknown[]) {
      queries.push({ sql, params })
      if (sql.includes('SELECT ref.external_id AS task_id')) {
        return [[
          { task_id: 'T-synthetic-1', call_id: 'call-synthetic-1' },
          { task_id: 'T-synthetic-2', call_id: 'call-synthetic-2' },
        ]]
      }
      return [[{
        call_id: 'call-synthetic-1', artifact_id: null, source_url: null,
        artifact_sha256: null, latest_audit_run_id: null,
        latest_audit_status: null, connected_seconds: '12',
        vendor_billed_minutes: '1', vendor_billed_amount: '9.5',
        category: null, confidence: null, verified_amount: null,
        calculation_basis: null,
      }]]
    },
  } as unknown as Pool

  const receipt = await createGasHistoricalAudit(pool).list({
    billMonth: '2026-06',
    tokenSecret: secret,
    body: { schema_version: '1', bill_month: '2026-06', cursor: '', limit: 1 },
  })

  assert.equal(receipt.rows.length, 1)
  assert.equal(receipt.nextCursor, 'call-synthetic-1')
  assert.match(queries[0]?.sql ?? '', /c\.billing_period_date BETWEEN \? AND \?/)
  assert.match(queries[0]?.sql ?? '', /c\.id > \?/)
  assert.match(queries[0]?.sql ?? '', /ORDER BY c\.id/)
  assert.deepEqual(queries[1]?.params, ['call-synthetic-1'])
})
