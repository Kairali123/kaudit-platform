import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Pool } from 'mysql2/promise'
import {
  createMysqlCallAuditSettingsRepository,
  CallAuditSettingsReadError,
  CALL_AUDIT_SETTINGS_SQL,
} from './mysqlCallAuditSettings.ts'

/**
 * SQL contract of the read-only admin settings repository. No database is
 * contacted: a recording fake pool captures every statement and its bound
 * parameters, and every fixture is synthetic administrator configuration.
 */

interface Call {
  sql: string
  parameters: unknown[]
}

function fakePool(rows: Record<string, unknown>[] = []) {
  const calls: Call[] = []
  const pool = {
    async execute(sql: string, parameters: unknown[] = []) {
      calls.push({ sql, parameters })
      return [rows]
    },
    async getConnection() {
      throw new Error('a read-only repository must never open a transaction')
    },
    async query() {
      throw new Error('every statement must be prepared with execute()')
    },
  } as unknown as Pool
  return { pool, calls }
}

const SYNTHETIC_PROMPT =
  'Assess each conversation against the approved rubric. Never invent facts.'

function ruleVersionRow(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: 'crv_synthetic0001',
    version_label: 'call-audit/2026.08.1',
    status: 'active',
    prompt_sha256: 'a'.repeat(64),
    model_provider: 'synthetic-provider',
    model_name: 'synthetic-model',
    model_version: '2026-08-01',
    temperature: '0.200',
    rule_contract_version: 'call-audit-contract/2.0.0',
    output_schema_version: 'call-audit-output/2.0.0',
    taxonomy_version: 'call-audit-taxonomy/2.0.0',
    scoring_config_version: 'call-audit-scoring/1.0.0',
    config_sha256: 'b'.repeat(64),
    change_reason: 'Approved for live auditing.',
    created_by: 'usr_admin_0001',
    created_at: '2026-08-01 09:00:00.000000',
    activated_by: 'usr_admin_0002',
    activated_at: '2026-08-01 09:30:00.000000',
    retired_by: null,
    retired_at: null,
    ...overrides,
  }
}

function runRow(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: 'crn_synthetic0001',
    rule_version_id: 'crv_synthetic0001',
    run_type: 'monthly',
    status: 'completed',
    period_start: '2026-07-01 00:00:00.000000',
    period_end_exclusive: '2026-08-01 00:00:00.000000',
    period_timezone: 'Asia/Kolkata',
    total_candidates: 40,
    processed_count: 40,
    succeeded_count: 38,
    failed_count: 2,
    skipped_count: 0,
    error_code: null,
    started_at: '2026-08-01 01:00:00.000000',
    finished_at: '2026-08-01 01:22:00.000000',
    ...overrides,
  }
}

const ALL_SQL = Object.values(CALL_AUDIT_SETTINGS_SQL)

// ---------------------------------------------------------------------------
// Immutability and source-table safety
// ---------------------------------------------------------------------------

test('the repository contains no write, lock, or source-table statement', () => {
  for (const sql of ALL_SQL) {
    for (const forbidden of [
      'INSERT',
      'UPDATE',
      'DELETE',
      'REPLACE',
      'FOR UPDATE',
      'LOCK',
      'ai_voice_leads_received',
    ]) {
      assert.equal(
        sql.toUpperCase().includes(forbidden.toUpperCase()),
        false,
        `${forbidden} appears in a read-only statement`,
      )
    }
    // Only the two migration 0008 control tables are named.
    for (const table of sql.match(/FROM `([a-z_]+)`/g) ?? []) {
      assert.ok(
        table === 'FROM `kaudit_call_audit_rule_version`' ||
          table === 'FROM `kaudit_call_audit_run`',
        table,
      )
    }
  }
})

test('every statement lists explicit columns and binds its values', () => {
  for (const sql of ALL_SQL) {
    assert.equal(sql.includes('SELECT *'), false)
    // No value is ever concatenated: the only literals are the closed
    // vocabulary status filter, which is itself bound as a parameter.
    assert.equal(/=\s*'/.test(sql), false, sql)
  }
})

test('only the single-row detail read projects the business prompt', () => {
  for (const [name, sql] of Object.entries(CALL_AUDIT_SETTINGS_SQL)) {
    assert.equal(
      sql.includes('business_prompt'),
      name === 'selectRuleVersionDetail',
      `${name} must not project the prompt`,
    )
    // The locked configuration document is identified by its hash and the four
    // version columns; the document itself is never read back.
    assert.equal(sql.includes('scoring_config_json'), false, name)
  }
})

test('datetime and decimal columns are read as their stored literals', () => {
  const sql = CALL_AUDIT_SETTINGS_SQL.selectRuleVersions
  for (const column of [
    'temperature',
    'created_at',
    'activated_at',
    'retired_at',
  ]) {
    assert.ok(
      sql.includes(`CAST(\`${column}\` AS CHAR) AS \`${column}\``),
      column,
    )
  }
  const runs = CALL_AUDIT_SETTINGS_SQL.selectRecentRuns
  for (const column of [
    'period_start',
    'period_end_exclusive',
    'started_at',
    'finished_at',
  ]) {
    assert.ok(
      runs.includes(`CAST(\`${column}\` AS CHAR) AS \`${column}\``),
      column,
    )
  }
})

// ---------------------------------------------------------------------------
// Behaviour
// ---------------------------------------------------------------------------

test('the version list is bound, bounded, and newest first', async () => {
  const { pool, calls } = fakePool([ruleVersionRow()])
  const repository = createMysqlCallAuditSettingsRepository(pool)
  const versions = await repository.listRuleVersions(25)
  assert.equal(calls[0]?.sql, CALL_AUDIT_SETTINGS_SQL.selectRuleVersions)
  assert.deepEqual(calls[0]?.parameters, [25])
  assert.match(calls[0]?.sql ?? '', /ORDER BY `created_at` DESC/)
  assert.equal(versions[0]?.ruleVersionId, 'crv_synthetic0001')
  assert.equal(versions[0]?.temperature, '0.200')
  assert.equal(versions[0]?.activatedBy, 'usr_admin_0002')
  assert.equal(versions[0]?.retiredAt, null)
  assert.equal('businessPrompt' in versions[0], false)

  // A caller asking for more than the ceiling gets the ceiling, not the table.
  await repository.listRuleVersions(10_000)
  assert.deepEqual(calls[1]?.parameters, [200])
})

test('a non-positive limit is refused before any statement runs', async () => {
  const { pool, calls } = fakePool()
  const repository = createMysqlCallAuditSettingsRepository(pool)
  for (const limit of [0, -1, 2.5, Number.NaN]) {
    await assert.rejects(
      () => repository.listRuleVersions(limit),
      (error: unknown) => {
        assert.ok(error instanceof CallAuditSettingsReadError)
        assert.equal(error.field, 'limit')
        return true
      },
    )
  }
  assert.equal(calls.length, 0)
})

test('the active version is selected by a bound status, or reported absent', async () => {
  const { pool, calls } = fakePool([ruleVersionRow()])
  const active = await createMysqlCallAuditSettingsRepository(
    pool,
  ).getActiveRuleVersion()
  assert.equal(calls[0]?.sql, CALL_AUDIT_SETTINGS_SQL.selectActiveRuleVersion)
  assert.deepEqual(calls[0]?.parameters, ['active'])
  assert.equal(active?.status, 'active')

  const empty = fakePool([])
  assert.equal(
    await createMysqlCallAuditSettingsRepository(
      empty.pool,
    ).getActiveRuleVersion(),
    null,
  )
})

test('the detail read binds a checked id and returns the prompt', async () => {
  const { pool, calls } = fakePool([
    { ...ruleVersionRow(), business_prompt: SYNTHETIC_PROMPT },
  ])
  const repository = createMysqlCallAuditSettingsRepository(pool)
  const detail = await repository.getRuleVersionDetail('crv_synthetic0001')
  assert.equal(calls[0]?.sql, CALL_AUDIT_SETTINGS_SQL.selectRuleVersionDetail)
  assert.deepEqual(calls[0]?.parameters, ['crv_synthetic0001'])
  assert.equal(detail?.businessPrompt, SYNTHETIC_PROMPT)
})

test('an id that is not a rule version id never reaches a statement', async () => {
  const { pool, calls } = fakePool()
  const repository = createMysqlCallAuditSettingsRepository(pool)
  for (const id of [
    "crv_1' OR '1'='1",
    'crv_1; DROP TABLE kaudit_call_audit_rule_version',
    'a'.repeat(41),
    '',
    null,
    7,
  ]) {
    await assert.rejects(
      () => repository.getRuleVersionDetail(id as string),
      (error: unknown) => {
        assert.ok(error instanceof CallAuditSettingsReadError)
        assert.equal(error.field, 'ruleVersionId')
        return true
      },
      String(id),
    )
  }
  assert.equal(calls.length, 0)
})

test('a missing rule version is reported as absent, not as an error', async () => {
  const { pool } = fakePool([])
  assert.equal(
    await createMysqlCallAuditSettingsRepository(pool).getRuleVersionDetail(
      'crv_missing',
    ),
    null,
  )
})

test('recent runs map counters and coded outcomes only', async () => {
  const { pool, calls } = fakePool([
    runRow({ status: 'failed', error_code: 'SOURCE_UNAVAILABLE' }),
  ])
  const runs = await createMysqlCallAuditSettingsRepository(
    pool,
  ).listRecentRuns(10)
  assert.deepEqual(calls[0]?.parameters, [10])
  assert.equal(runs[0]?.runId, 'crn_synthetic0001')
  assert.equal(runs[0]?.processedCount, 40)
  assert.equal(runs[0]?.failedCount, 2)
  assert.equal(runs[0]?.errorCode, 'SOURCE_UNAVAILABLE')
  assert.equal(runs[0]?.periodTimezone, 'Asia/Kolkata')
  // A run summary has no place for an idempotency key, correlation id, or
  // triggering actor, so an operational read cannot carry one.
  for (const forbidden of [
    'idempotencyKey',
    'correlationId',
    'triggeredBy',
    'errorDetail',
  ]) {
    assert.equal(forbidden in (runs[0] ?? {}), false, forbidden)
  }
})
