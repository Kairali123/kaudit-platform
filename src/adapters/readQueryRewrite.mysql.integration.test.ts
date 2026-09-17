import { test } from 'node:test'
import assert from 'node:assert/strict'
import mysql, { type Pool, type RowDataPacket } from 'mysql2/promise'
import {
  categoryCallsSql,
  categoryTotalsRowsSql,
  categoryTotalsSql,
  legacyCategoryCallsSql,
  legacyNoRecordingTotalsSql,
  noRecordingTotalsSql,
} from './mysqlBillingCategoryAnalysis.ts'
import {
  auditedCountAndUsageSql,
  auditedFinancialSummarySql,
  auditedRowsSql,
  coreAcceptedFallbackSql,
  coreCompletedReauditSql,
  coreSummarySql,
  filterSql,
  financialAuditedScope,
  legacyAuditedCountAndUsageSql,
  legacyAuditedRowsSql,
  legacyCoreSummarySql,
  TASK_ID_MATCHING_CALLS_SQL,
  type AuditMonitorQuery,
} from './mysqlAuditMonitor.ts'
import {
  ADMIN_CALL_ACCESS_SQL,
  LEGACY_ADMIN_CALL_ACCESS_SQL,
} from './mysqlAdminCallDetail.ts'
import {
  billingCalculationSummarySql,
  legacyBillingCalculationSql,
  legacyProviderPeriodTotalsSql,
  providerPeriodTotalsSql,
  unresolvedAutomatedDecisionsSql,
} from './mysqlFullDashboard.ts'
import {
  CALL_AUDIT_REPORTING_SQL,
  createMysqlCallAuditReportingRepository,
  issueFlagNeedle,
  tallyBuckets,
  validateReportPeriod,
} from './mysqlCallAuditReporting.ts'
import { ISSUE_FLAGS } from '../callaudit/modelOutput.ts'
import { REAUDIT_ENGINE_FAMILY } from '../reaudit/core.ts'

/**
 * Real-MySQL result equivalence for the read-query performance rewrite.
 *
 * Every rewritten statement is run next to the statement it replaces, over
 * one deliberately awkward SYNTHETIC dataset, and the results must match.
 * Runs ONLY against an isolated local fixture socket under /tmp (the same
 * guard the other MySQL integration suites use), in a database it creates and
 * drops itself. Never production, never shared, never real evidence.
 */
const socketPath = process.env.KAUDIT_TEST_MYSQL_SOCKET
const safeSocket =
  socketPath?.startsWith('/tmp/kaudit-') && socketPath.endsWith('/mysql.sock')
    ? socketPath
    : null
const DATABASE = 'kaudit_read_rewrite_verify'

const SCHEMA = [
  `CREATE TABLE kaudit_call (
     id varchar(40) PRIMARY KEY,
     logical_call_key varchar(191) NOT NULL,
     canonical_outcome_code varchar(60) NULL,
     outcome_taxonomy_version varchar(40) NULL,
     billing_period_date date NULL,
     source_started_at datetime NULL,
     source_ended_at datetime NULL,
     latest_audit_run_id varchar(40) NULL,
     sensitivity_tier varchar(10) NOT NULL DEFAULT 'K1',
     created_at datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
     KEY idx_call_billing_period_id (billing_period_date, id),
     KEY idx_call_period_category_started
       (billing_period_date, canonical_outcome_code, source_started_at, id),
     KEY idx_call_logical_key (logical_call_key)
   )`,
  `CREATE TABLE kaudit_call_artifact (
     id varchar(40) PRIMARY KEY,
     call_id varchar(40) NOT NULL,
     artifact_type varchar(30) NOT NULL,
     is_final tinyint NOT NULL DEFAULT 1,
     source_url varchar(2048) NULL,
     sha256 char(64) NULL,
     last_verified_at datetime(6) NULL,
     audio_processing_status varchar(30) NULL,
     audio_attempt_count int NULL,
     audio_last_attempt_at datetime(6) NULL,
     created_at datetime(6) NOT NULL,
     KEY idx_call_artifact_call_recording_final (call_id, artifact_type, is_final)
   )`,
  `CREATE TABLE kaudit_media_analysis (
     id varchar(40) PRIMARY KEY,
     call_artifact_id varchar(40) NOT NULL,
     status varchar(30) NOT NULL,
     classification_status varchar(30) NOT NULL,
     decoded_duration_ms bigint NULL,
     speech_ms bigint NULL,
     conversation_end_ms bigint NULL,
     metrics_json json NULL,
     created_at datetime(6) NOT NULL,
     KEY idx_media_analysis_artifact_classified_latest
       (call_artifact_id, status, classification_status, created_at DESC, id DESC)
   )`,
  `CREATE TABLE kaudit_transcript (
     id varchar(40) PRIMARY KEY,
     call_id varchar(40) NOT NULL,
     call_artifact_id varchar(40) NOT NULL,
     status varchar(30) NOT NULL,
     language varchar(30) NULL,
     provider_name varchar(60) NULL,
     model_name varchar(60) NULL,
     model_version varchar(60) NULL,
     created_at datetime(6) NOT NULL,
     KEY idx_transcript_artifact_status_call (call_artifact_id, status, call_id)
   )`,
  `CREATE TABLE kaudit_provider_cost (
     id varchar(40) PRIMARY KEY,
     call_id varchar(40) NOT NULL,
     provider_sku varchar(60) NOT NULL,
     minutes_decimal decimal(20,8) NULL,
     quantity_decimal decimal(20,8) NULL,
     is_final tinyint NOT NULL DEFAULT 1,
     KEY idx_provider_cost_call_sku_final (call_id, provider_sku, is_final)
   )`,
  `CREATE TABLE kaudit_billing_calculation (
     id varchar(40) PRIMARY KEY,
     call_id varchar(40) NOT NULL,
     status varchar(20) NOT NULL,
     calculation_basis varchar(60) NOT NULL,
     total_amount decimal(20,8) NULL,
     billable_duration_ms bigint NULL,
     currency char(3) NOT NULL DEFAULT 'INR',
     audit_run_id varchar(40) NULL,
     input_manifest_sha256 char(64) NULL,
     ruleset_sha256 char(64) NULL,
     decision_trace_sha256 char(64) NULL,
     finalized_at datetime(6) NULL,
     calculated_at datetime(6) NOT NULL,
     supersedes_calculation_id varchar(40) NULL,
     KEY idx_billing_calc_call (call_id),
     KEY idx_billing_calc_supersedes (supersedes_calculation_id)
   )`,
  `CREATE TABLE kaudit_automated_decision (
     id varchar(40) PRIMARY KEY,
     call_id varchar(40) NOT NULL,
     decision_type varchar(60) NOT NULL,
     decision_status varchar(30) NOT NULL,
     supersedes_decision_id varchar(40) NULL,
     KEY idx_decision_call (call_id)
   )`,
  `CREATE TABLE kaudit_call_external_reference (
     id bigint AUTO_INCREMENT PRIMARY KEY,
     call_id varchar(40) NOT NULL,
     reference_type varchar(30) NOT NULL,
     external_id varchar(191) NOT NULL,
     KEY idx_call_reference_call_type_first (call_id, reference_type, id),
     KEY idx_reference_external (external_id, reference_type, call_id)
   )`,
  `CREATE TABLE kaudit_audit_finding (
     id varchar(40) PRIMARY KEY,
     audit_run_id varchar(40) NOT NULL,
     call_id varchar(40) NOT NULL,
     finding_code varchar(60) NOT NULL,
     confirmation_status varchar(30) NOT NULL,
     confidence decimal(9,8) NULL,
     explanation text NULL,
     created_at datetime(6) NOT NULL,
     KEY idx_audit_finding_call_code_latest
       (call_id, finding_code, created_at DESC, id DESC)
   )`,
  `CREATE TABLE kaudit_audit_run (
     id varchar(40) PRIMARY KEY,
     call_id varchar(40) NOT NULL,
     engine_version varchar(80) NULL,
     status varchar(30) NOT NULL,
     completed_at datetime(6) NULL,
     KEY idx_audit_run_call_engine_status (call_id, engine_version, status)
   )`,
  `CREATE TABLE kaudit_ai_usage_event (
     id varchar(40) PRIMARY KEY,
     audit_run_id varchar(40) NOT NULL,
     call_id varchar(40) NOT NULL,
     model_name varchar(100) NOT NULL,
     input_tokens bigint NULL,
     output_tokens bigint NULL,
     total_tokens bigint NULL,
     audio_seconds decimal(14,3) NULL,
     KEY idx_ai_usage_call (call_id),
     -- Stands in for production's uq_ai_usage_audit_pass leading column.
     KEY idx_ai_usage_run (audit_run_id)
   )`,
  `CREATE TABLE kaudit_call_audit_source_ref (
     id varchar(40) PRIMARY KEY,
     effective_call_at datetime(6) NOT NULL
   )`,
  `CREATE TABLE kaudit_call_audit_run (
     id varchar(40) PRIMARY KEY,
     run_type varchar(20) NOT NULL
   )`,
  `CREATE TABLE kaudit_call_audit_result (
     id varchar(40) PRIMARY KEY,
     run_id varchar(40) NOT NULL,
     source_ref_id varchar(40) NOT NULL,
     processing_status varchar(30) NOT NULL,
     eligibility varchar(30) NOT NULL,
     intent varchar(10) NULL,
     grouped_outcome varchar(80) NULL,
     kserve_comparison_label varchar(60) NULL,
     mismatch_severity varchar(30) NULL,
     qualification_label varchar(80) NULL,
     next_action_code varchar(80) NULL,
     issue_flags_json longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NULL
   )`,
]

const CATEGORIES = ['OK', 'AGENT_FAILURE', 'USER_SILENCE', 'VOICEMAIL', null]

interface Seed {
  [table: string]: Array<Record<string, unknown>>
}

function syntheticData(): Seed {
  const seed: Seed = {
    kaudit_call: [],
    kaudit_call_artifact: [],
    kaudit_media_analysis: [],
    kaudit_transcript: [],
    kaudit_provider_cost: [],
    kaudit_billing_calculation: [],
    kaudit_automated_decision: [],
    kaudit_call_external_reference: [],
    kaudit_audit_finding: [],
    kaudit_audit_run: [],
    kaudit_ai_usage_event: [],
  }
  const push = (table: string, row: Record<string, unknown>) =>
    seed[table]!.push(row)
  for (let i = 0; i < 90; i += 1) {
    const id = `call-${String(i).padStart(3, '0')}`
    const category = CATEGORIES[i % CATEGORIES.length]!
    const month = i % 13 === 12 ? '2026-06' : i % 17 === 16 ? '2026-08' : '2026-07'
    const run = `run-${id}`
    push('kaudit_call', {
      id,
      logical_call_key: `synthetic-key-${i % 40}`,
      canonical_outcome_code: category,
      outcome_taxonomy_version: category ? 'v2' : null,
      billing_period_date: `${month}-${String((i % 28) + 1).padStart(2, '0')}`,
      // Heavy ties; some calls have no start at all.
      source_started_at: i % 9 === 8 ? null : `${month}-0${(i % 3) + 1} 10:00:00`,
      source_ended_at: i % 9 === 8 ? null : `${month}-0${(i % 3) + 1} 10:04:00`,
      latest_audit_run_id: i % 11 === 10 ? null : run,
    })
    push('kaudit_audit_run', {
      id: run,
      call_id: id,
      engine_version: i % 4 === 0 ? 'legacy-engine/1.0' : `${REAUDIT_ENGINE_FAMILY}2.${i % 3}.0`,
      status: i % 7 === 6 ? 'failed' : 'completed',
      completed_at: i % 5 === 4 ? null : '2026-07-20 00:00:00.000000',
    })
    // Artifacts: none, one, or several final recordings (plus a non-final).
    const artifacts = i % 10 === 0 ? 0 : i % 6 === 0 ? 3 : 1
    for (let a = 0; a < artifacts; a += 1) {
      const artifactId = `art-${id}-${a}`
      push('kaudit_call_artifact', {
        id: artifactId,
        call_id: id,
        artifact_type: 'recording',
        is_final: a === 2 ? 0 : 1,
        source_url: (i + a) % 5 === 3 ? null : `https://recordings.example.test/${artifactId}.ogg`,
        sha256: a === 0 ? 'e'.repeat(64) : null,
        last_verified_at: null,
        audio_processing_status: ['completed', 'exhausted', null, 'fetch_failed', 'pending'][(i + a) % 5],
        audio_attempt_count: (i + a) % 4,
        audio_last_attempt_at: null,
        // Tied artifact timestamps on multi-artifact calls: id decides.
        created_at: '2026-07-10 00:00:00.000000',
      })
      // Media: two analyses (one tied on created_at) unless unaudited.
      if ((i + a) % 8 !== 7) {
        for (let m = 0; m < 2; m += 1) {
          push('kaudit_media_analysis', {
            id: `ma-${artifactId}-${m}`,
            call_artifact_id: artifactId,
            status: m === 1 && i % 12 === 11 ? 'failed' : 'completed',
            classification_status: 'completed',
            decoded_duration_ms: i % 14 === 13 ? null : 60_000 + i * 1_000 + m * 7_000 + a * 3_000,
            speech_ms: 20_000 + i,
            conversation_end_ms: i % 15 === 14 ? null : i % 16 === 15 ? 0 : 25_000 + i * 500 + m,
            metrics_json: category === 'AGENT_FAILURE'
              ? JSON.stringify({
                  chargeableServiceEndMs: i % 2 === 0 ? 40_000 + i : 0,
                  appliedBillingGraceMs: i % 2 === 0 ? 30_000 : 0,
                })
              : category === 'USER_SILENCE'
                ? JSON.stringify({ chargeableServiceEndMs: 15_000, appliedBillingGraceMs: 60_000 })
                : null,
            created_at: '2026-07-11 00:00:00.000000',
          })
        }
      }
      // Transcripts: completed on this artifact, on none, or a failed one.
      if ((i + a) % 7 !== 6) {
        push('kaudit_transcript', {
          id: `tr-${artifactId}-0`,
          call_id: id,
          call_artifact_id: artifactId,
          status: 'completed',
          language: i % 2 ? 'English' : null,
          provider_name: 'synthetic-asr',
          model_name: 'synthetic-asr-model',
          model_version: '1',
          created_at: '2026-07-12 00:00:00.000000',
        })
        push('kaudit_transcript', {
          id: `tr-${artifactId}-1`,
          call_id: id,
          call_artifact_id: artifactId,
          status: i % 3 === 0 ? 'failed' : 'completed',
          language: 'Hindi',
          provider_name: 'synthetic-asr',
          model_name: 'synthetic-asr-model',
          model_version: '2',
          created_at: '2026-07-12 00:00:00.000000',
        })
      }
    }
    // Revised provider costs: sometimes two final minute rows, a non-final
    // row, an amount, and a connected duration.
    if (i % 9 !== 4) {
      push('kaudit_provider_cost', {
        id: `pc-${id}-m1`, call_id: id, provider_sku: 'vendor_asserted_billed_minutes',
        minutes_decimal: `${(i % 5) + 0.5}`, quantity_decimal: null, is_final: 1,
      })
    }
    if (i % 6 === 1) {
      push('kaudit_provider_cost', {
        id: `pc-${id}-m2`, call_id: id, provider_sku: 'vendor_asserted_billed_minutes',
        minutes_decimal: '2.25000000', quantity_decimal: null, is_final: 1,
      })
      push('kaudit_provider_cost', {
        id: `pc-${id}-m3`, call_id: id, provider_sku: 'vendor_asserted_billed_minutes',
        minutes_decimal: '99.00000000', quantity_decimal: null, is_final: 0,
      })
    }
    if (i % 4 === 2) {
      push('kaudit_provider_cost', {
        id: `pc-${id}-a`, call_id: id, provider_sku: 'vendor_asserted_billed_amount',
        minutes_decimal: null, quantity_decimal: `${i}.12345678`, is_final: 1,
      })
    }
    push('kaudit_provider_cost', {
      id: `pc-${id}-d`, call_id: id, provider_sku: 'duration_without_ringing_sec',
      minutes_decimal: null, quantity_decimal: `${60 + i}.5`, is_final: 1,
    })
    // Calculations: a superseded chain, the two fallback bases, and one
    // late-recording correction superseding a no_recording_zero row.
    const bases = [
      'independent_category_service_end',
      'accepted_as_billed_unverified',
      'no_recording_zero',
      'independent_conversation_end',
    ]
    if (i % 3 !== 2) {
      push('kaudit_billing_calculation', {
        id: `bc-${id}-1`, call_id: id, status: i % 10 === 9 ? 'unresolved' : 'final',
        calculation_basis: bases[i % 4], total_amount: `${i}.50000000`,
        billable_duration_ms: 60_000 * (i % 4), audit_run_id: i % 8 === 0 ? null : run,
        input_manifest_sha256: 'a'.repeat(64), ruleset_sha256: 'b'.repeat(64),
        decision_trace_sha256: i % 5 === 0 ? null : 'c'.repeat(64),
        finalized_at: '2026-07-21 00:00:00.000000',
        calculated_at: '2026-07-21 00:00:00.000000', supersedes_calculation_id: null,
      })
      if (i % 5 === 1) {
        push('kaudit_billing_calculation', {
          id: `bc-${id}-2`, call_id: id, status: 'final',
          calculation_basis: 'independent_category_service_end',
          total_amount: '9.50000000', billable_duration_ms: 60_000, audit_run_id: run,
          input_manifest_sha256: 'a'.repeat(64), ruleset_sha256: 'b'.repeat(64),
          decision_trace_sha256: 'c'.repeat(64), finalized_at: '2026-07-22 00:00:00.000000',
          calculated_at: '2026-07-22 00:00:00.000000', supersedes_calculation_id: `bc-${id}-1`,
        })
      }
    }
    push('kaudit_automated_decision', {
      id: `ad-${id}-1`, call_id: id, decision_type: i % 2 ? 'verified_call_billing' : 'automated_consensus_validation',
      decision_status: i % 3 ? 'unresolved' : 'final', supersedes_decision_id: null,
    })
    if (i % 7 === 3) {
      push('kaudit_automated_decision', {
        id: `ad-${id}-2`, call_id: id, decision_type: 'verified_call_billing',
        decision_status: 'unresolved', supersedes_decision_id: `ad-${id}-1`,
      })
    }
    // Task references: none, one, an alias pair, and shared ambiguous ids.
    if (i % 5 !== 0) {
      push('kaudit_call_external_reference', {
        id: 1_000 + i * 2, call_id: id, reference_type: ['task_id', 'taskId', 'task', 'other'][i % 4],
        external_id: `task-${i % 30}`,
      })
    }
    if (i % 8 === 1) {
      push('kaudit_call_external_reference', {
        id: 1_000 + i * 2 - 1, call_id: id, reference_type: 'task_id', external_id: `alias-${i}`,
      })
    }
    // Findings: the latest-run finding, an older one, and a stale newer run.
    if (category) {
      push('kaudit_audit_finding', {
        id: `af-${id}-1`, audit_run_id: run, call_id: id, finding_code: category,
        confirmation_status: i % 2 ? 'confirmed' : 'model_output',
        confidence: '0.91000000', explanation: `Synthetic rationale ${i}`,
        created_at: '2026-07-13 00:00:00.000000',
      })
      push('kaudit_audit_finding', {
        id: `af-${id}-2`, audit_run_id: run, call_id: id, finding_code: category,
        confirmation_status: 'rejected', confidence: '0.42000000',
        explanation: `Synthetic tie ${i}`, created_at: '2026-07-13 00:00:00.000000',
      })
      if (i % 4 === 3) {
        push('kaudit_audit_finding', {
          id: `af-${id}-0`, audit_run_id: `stale-${run}`, call_id: id, finding_code: category,
          confirmation_status: 'confirmed', confidence: '0.10000000',
          explanation: 'Synthetic stale run', created_at: '2026-07-19 00:00:00.000000',
        })
      }
    }
    // Usage on the latest run, on an older run, and with null tokens.
    push('kaudit_ai_usage_event', {
      id: `ue-${id}-1`, audit_run_id: run, call_id: id,
      model_name: i % 2 ? 'gpt-4o-mini' : 'whisper-1',
      input_tokens: i % 3 ? 100 + i : null, output_tokens: 10 + i,
      total_tokens: 110 + 2 * i, audio_seconds: `${i}.125`,
    })
    push('kaudit_ai_usage_event', {
      id: `ue-${id}-2`, audit_run_id: `old-${run}`, call_id: id,
      model_name: 'gpt-4o-mini', input_tokens: 5, output_tokens: 5,
      total_tokens: 10, audio_seconds: '1.000',
    })
  }
  // The same Task ID naming two calls, with distinct recording times.
  push('kaudit_call_external_reference', {
    id: 9_001, call_id: 'call-001', reference_type: 'task_id', external_id: 'shared-task',
  })
  push('kaudit_call_external_reference', {
    id: 9_002, call_id: 'call-011', reference_type: 'task_id', external_id: 'shared-task',
  })
  // A reference whose call row does not exist.
  push('kaudit_call_external_reference', {
    id: 9_003, call_id: 'call-missing', reference_type: 'task_id', external_id: 'task-7',
  })
  push('kaudit_provider_cost', {
    id: 'pc-missing', call_id: 'call-missing', provider_sku: 'vendor_asserted_billed_minutes',
    minutes_decimal: '5.00000000', quantity_decimal: null, is_final: 1,
  })
  return seed
}

async function withDatabase(
  run: (pool: Pool) => Promise<void>,
): Promise<void> {
  const admin = await mysql.createConnection({
    socketPath: safeSocket as string,
    user: 'root',
  })
  await admin.query(`DROP DATABASE IF EXISTS ${DATABASE}`)
  await admin.query(`CREATE DATABASE ${DATABASE}`)
  await admin.end()
  const pool = mysql.createPool({
    socketPath: safeSocket as string,
    user: 'root',
    database: DATABASE,
    connectionLimit: 2,
  })
  try {
    for (const statement of SCHEMA) await pool.query(statement)
    for (const [table, rows] of Object.entries(syntheticData())) {
      for (const row of rows) {
        const columns = Object.keys(row)
        await pool.query(
          `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
          columns.map((column) => row[column]),
        )
      }
    }
    await run(pool)
  } finally {
    await pool.end()
    // Diagnostics only: keep the throwaway database for manual inspection.
    if (process.env.KAUDIT_READ_REWRITE_KEEP_DB === '1') return
    const cleanup = await mysql.createConnection({
      socketPath: safeSocket as string,
      user: 'root',
    })
    await cleanup.query(`DROP DATABASE IF EXISTS ${DATABASE}`)
    await cleanup.end()
  }
}

async function rows(pool: Pool, sql: string, params: unknown[]) {
  const [result] = await pool.query<RowDataPacket[]>(sql, params)
  return result.map((row) => ({ ...row }))
}

function sorted<T>(values: T[]): T[] {
  return [...values].sort((left, right) =>
    JSON.stringify(left).localeCompare(JSON.stringify(right)),
  )
}

const JULY = ['2026-07-01', '2026-07-31']

function monitorQuery(overrides: Partial<AuditMonitorQuery>): AuditMonitorQuery {
  return {
    page: 1,
    pendingPage: 1,
    noRecordingPage: 1,
    pageSize: 25,
    category: null,
    taskId: null,
    periodStart: JULY[0],
    periodEnd: JULY[1],
    ...overrides,
  }
}

const OLD_TASK_PREDICATE = `(
    c.logical_call_key = ?
    OR EXISTS (
      SELECT 1
      FROM kaudit_call_external_reference task_ref
      WHERE task_ref.call_id = c.id
        AND task_ref.reference_type IN ('task_id','taskId','task')
        AND task_ref.external_id = ?
    )
  )`

test(
  'every rewritten read returns exactly what it replaced on real MySQL',
  { skip: safeSocket == null },
  async () => {
    await withDatabase(async (pool) => {
      // --- 1. category page -------------------------------------------------
      const periodFilters = [
        'c.canonical_outcome_code IS NOT NULL',
        'c.billing_period_date BETWEEN ? AND ?',
      ]
      let nonEmptyPages = 0
      for (const [filters, base] of [
        [periodFilters, JULY],
        [['c.canonical_outcome_code IS NOT NULL'], []],
        [periodFilters, ['2031-01-01', '2031-01-31']],
      ] as const) {
        for (const category of [null, 'OK', 'AGENT_FAILURE', 'USER_SILENCE']) {
          const scoped = category
            ? [...filters, 'c.canonical_outcome_code = ?']
            : [...filters]
          const params = category ? [...base, category] : [...base]
          for (const [limit, offset] of [[1, 0], [5, 3], [7, 7], [25, 0], [25, 25], [10, 1000]]) {
            const legacy = await rows(pool, legacyCategoryCallsSql(scoped), [...params, limit, offset])
            const current = await rows(pool, categoryCallsSql(scoped), [...params, limit, offset])
            assert.deepEqual(current, legacy, `page ${category} ${limit}/${offset}`)
            if (current.length > 0) nonEmptyPages += 1
          }
        }
      }
      assert.ok(nonEmptyPages > 10)

      // --- 2. category totals ----------------------------------------------
      for (const [filters, params] of [
        [periodFilters, JULY],
        [['c.canonical_outcome_code IS NOT NULL'], []],
      ] as const) {
        const legacy = await rows(
          pool,
          categoryTotalsSql(categoryTotalsRowsSql(filters, { legacyEvidence: true })),
          [...params],
        )
        const current = await rows(
          pool,
          categoryTotalsSql(categoryTotalsRowsSql(filters)),
          [...params],
        )
        assert.ok(current.length > 0)
        assert.deepEqual(current, legacy, 'totals')
      }

      // --- 3. no-recording totals ------------------------------------------
      for (const scope of [
        { periodStart: JULY[0]!, periodEnd: JULY[1]! },
        { periodStart: null, periodEnd: null },
        { periodStart: '2031-01-01', periodEnd: '2031-01-31' },
      ]) {
        const legacy = legacyNoRecordingTotalsSql(scope)
        const current = noRecordingTotalsSql(scope)
        assert.deepEqual(
          await rows(pool, current.sql, current.params),
          await rows(pool, legacy.sql, legacy.params),
          `no-recording ${scope.periodStart}`,
        )
      }

      // --- 4. audit-monitor core summary ------------------------------------
      for (const monthScoped of [true, false]) {
        const periodClause = monthScoped
          ? ' AND c.billing_period_date BETWEEN ? AND ?'
          : ''
        const periodParams = monthScoped ? JULY : []
        const legacy = legacyCoreSummarySql(periodClause)
        const [overall] = await rows(pool, legacy.overall, periodParams)
        const [fallback] = await rows(pool, legacy.acceptedFallback, periodParams)
        const [reaudit] = await rows(pool, legacy.reaudit, [`${REAUDIT_ENGINE_FAMILY}%`, ...periodParams])
        const [currentOverall] = await rows(
          pool,
          coreSummarySql(monthScoped),
          periodParams,
        )
        const [currentFallback] = await rows(
          pool,
          coreAcceptedFallbackSql(monthScoped),
          periodParams,
        )
        const [currentReaudit] = await rows(
          pool,
          coreCompletedReauditSql(monthScoped),
          [`${REAUDIT_ENGINE_FAMILY}%`, ...periodParams],
        )
        const n = (value: unknown) => Number(value ?? 0)
        assert.ok(n(currentOverall!.total_calls) > 0)
        for (const key of [
          'total_calls', 'audited_calls', 'recording_available',
          'pending_calls', 'no_recording_calls', 'processing_failures',
        ]) {
          assert.equal(n(currentOverall![key]), n(overall![key]), key)
        }
        for (const key of [
          'accepted_fallback_calls', 'accepted_failure_calls',
          'accepted_recording_backed_calls',
        ]) {
          assert.equal(n(currentFallback![key]), n(fallback![key]), key)
        }
        assert.equal(
          n(currentReaudit!.completed_reaudit_calls),
          n(reaudit!.n),
        )
      }

      // --- 5. Task-ID scoping ------------------------------------------------
      // Give the two calls sharing a Task ID distinct recording times, so the
      // pre-existing "newest recording wins" rule has a single answer.
      await pool.query(
        "UPDATE kaudit_call_artifact SET created_at = '2026-07-15 00:00:00' WHERE id = 'art-call-011-0'",
      )
      for (const taskId of ['task-7', 'synthetic-key-3', 'alias-9', 'shared-task', 'absent']) {
        const legacyIds = await rows(
          pool,
          `SELECT c.id FROM kaudit_call c WHERE ${OLD_TASK_PREDICATE} ORDER BY c.id`,
          [taskId, taskId],
        )
        const currentIds = await rows(
          pool,
          `SELECT c.id FROM kaudit_call c
           WHERE c.id IN (SELECT matching_calls.id FROM (${TASK_ID_MATCHING_CALLS_SQL}) matching_calls)
           ORDER BY c.id`,
          [taskId, taskId],
        )
        assert.deepEqual(currentIds, legacyIds, taskId)
        const legacyAccess = await rows(pool, LEGACY_ADMIN_CALL_ACCESS_SQL, [taskId, taskId])
        const currentAccess = await rows(pool, ADMIN_CALL_ACCESS_SQL, [taskId, taskId, taskId, taskId])
        if (taskId === 'synthetic-key-3') {
          // Pre-existing: three calls share this key with tied recording
          // times, so the old statement's winner is unordered too. Both
          // statements must still return one of those candidates.
          const candidates = legacyIds.map((row) => row.id)
          assert.equal(currentAccess.length, 1)
          assert.ok(candidates.includes(currentAccess[0]!.call_id))
          assert.ok(candidates.includes(legacyAccess[0]!.call_id))
          continue
        }
        assert.deepEqual(currentAccess, legacyAccess, `access ${taskId}`)
      }
      // The ambiguous Task ID keeps the pre-existing winner rule (newest
      // recording) and does not invent another; both calls stay in the
      // monitor's scope.
      const shared = await rows(pool, ADMIN_CALL_ACCESS_SQL, Array(4).fill('shared-task'))
      assert.equal(shared.length, 1)
      assert.equal(shared[0]!.call_id, 'call-011')
      const sharedScope = await rows(
        pool,
        `SELECT c.id FROM kaudit_call c WHERE c.id IN (SELECT matching_calls.id FROM (${TASK_ID_MATCHING_CALLS_SQL}) matching_calls) ORDER BY c.id`,
        ['shared-task', 'shared-task'],
      )
      assert.deepEqual(sharedScope.map((row) => row.id), ['call-001', 'call-011'])
      // The candidate set is uncorrelated: materialized once, not re-probed
      // per call.
      const [plan] = await rows(
        pool,
        `EXPLAIN FORMAT=JSON SELECT c.id FROM kaudit_call c
         WHERE c.billing_period_date BETWEEN ? AND ?
           AND c.id IN (SELECT matching_calls.id FROM (${TASK_ID_MATCHING_CALLS_SQL}) matching_calls)`,
        [...JULY, 'task-7', 'task-7'],
      )
      const planText = JSON.stringify(plan)
      assert.equal(/"dependent": true/.test(planText), false, planText)

      // --- 6/8. monitor audited count, usage and audited rows --------------
      for (const query of [
        monitorQuery({}),
        monitorQuery({ periodStart: null, periodEnd: null }),
        monitorQuery({ category: 'AGENT_FAILURE' }),
        monitorQuery({ taskId: 'task-7' }),
        monitorQuery({ taskId: 'shared-task', periodStart: null, periodEnd: null }),
      ]) {
        const filters = filterSql(query)
        const legacy = legacyAuditedCountAndUsageSql(filters)
        const current = auditedCountAndUsageSql(filters)
        assert.deepEqual(
          await rows(pool, current.count, filters.params),
          await rows(pool, legacy.count, filters.params),
          'audited count',
        )
        assert.deepEqual(
          sorted(await rows(pool, current.usage, filters.params)),
          sorted(await rows(pool, legacy.usage, filters.params)),
          'usage rollup',
        )
        for (const [limit, offset] of [[26, 0], [4, 4], [3, 9], [26, 500]]) {
          const legacyRows = await rows(pool, legacyAuditedRowsSql(filters), [...filters.params, limit, offset])
          const currentRows = await rows(pool, auditedRowsSql(filters), [...filters.params, limit, offset])
          assert.deepEqual(currentRows, legacyRows, `rows ${limit}/${offset}`)
        }

        // --- 7. monitor financial summary ----------------------------------
        const scope = financialAuditedScope(query)
        if (query.taskId == null && query.category == null && query.periodStart) {
          // Characterization of a PRE-EXISTING issue, unchanged here: a call
          // with two eligible final recordings of different durations yields
          // two scope rows, so it is counted (and vendor-priced) twice.
          const duplicated = await rows(
            pool,
            `SELECT scoped.id FROM (${scope.sql}) scoped GROUP BY scoped.id HAVING COUNT(*) > 1`,
            scope.params,
          )
          assert.ok(duplicated.length > 0, 'fixture must exercise the duplicate')
          const [summary] = await rows(pool, auditedFinancialSummarySql(scope.sql), scope.params)
          const [distinct] = await rows(
            pool,
            `SELECT COUNT(DISTINCT scoped.id) AS n FROM (${scope.sql}) scoped`,
            scope.params,
          )
          assert.ok(Number(summary!.audited_calls) > Number(distinct!.n))
        }
        assert.deepEqual(
          await rows(pool, auditedFinancialSummarySql(scope.sql), scope.params),
          await rows(pool, auditedFinancialSummarySql(scope.sql, { legacyVendorScan: true }), scope.params),
          'financial',
        )
      }

      // --- 9. billing calculation summary -----------------------------------
      for (const period of [
        { month: '2026-07', start: JULY[0]!, end: JULY[1]! },
        null,
      ]) {
        const legacy = legacyBillingCalculationSql(period as never)
        const [oldSummary] = await rows(pool, legacy.summary, legacy.summaryParams)
        const [oldAuthority] = await rows(pool, legacy.authority, legacy.authorityParams)
        const params = period ? [period.start, period.end] : []
        const [summary] = await rows(pool, billingCalculationSummarySql(period as never), params)
        const [decisions] = await rows(pool, unresolvedAutomatedDecisionsSql(period as never), params)
        for (const key of ['calculations', 'calculated_total', 'billable_minutes', 'currency']) {
          assert.equal(summary![key], oldSummary![key], key)
        }
        for (const key of ['current_calculations', 'authoritative_calculations', 'independent_final_calculations']) {
          assert.equal(String(summary![key]), String(oldAuthority![key]), key)
        }
        assert.equal(
          Number(decisions!.unresolved_automated_decisions),
          Number(oldAuthority!.unresolved_automated_decisions),
        )
      }

      // --- 10. provider period totals ---------------------------------------
      const periods = [
        'monthly', '2026-07-01', '2026-07-31',
        'weekly', '2026-07-01', '2026-07-07',
        'prior', '2026-06-01', '2026-06-30',
        'empty', '2031-01-01', '2031-01-31',
      ]
      assert.deepEqual(
        sorted(await rows(pool, providerPeriodTotalsSql(4), periods)),
        sorted(await rows(pool, legacyProviderPeriodTotalsSql(4), periods)),
      )
    })
  },
)

test(
  'the one-scan Call Audit summary equals the ten-scan summary on real MySQL',
  { skip: safeSocket == null },
  async () => {
    await withDatabase(async (pool) => {
      const values = {
        processing_status: ['succeeded', 'failed', 'pending', 'skipped', 'retrying'],
        eligibility: ['content_auditable', 'operational_only', 'unknown_bucket'],
        intent: ['HIGH', 'WARM', null, 'LOW', 'SOMEDAY'],
        grouped_outcome: ['EXISTING_DUPLICATE_DNC', null, 'SOME_FUTURE_GROUP'],
        kserve_comparison_label: ['match', 'mismatch', null],
        mismatch_severity: ['none', 'high', null, 'severe'],
        qualification_label: ['QUALIFIED', 'NON_QUALIFIED', null],
        next_action_code: ['DO_NOT_CALL', 'NONE', null, 'CALL_LATER_MAYBE'],
      }
      for (let i = 0; i < 60; i += 1) {
        await pool.query(
          'INSERT INTO kaudit_call_audit_source_ref (id, effective_call_at) VALUES (?, ?)',
          [`cas-${i}`, `2026-0${6 + (i % 3)}-15 10:00:00.000000`],
        )
      }
      await pool.query(
        "INSERT INTO kaudit_call_audit_run (id, run_type) VALUES ('crn-daily', 'daily'), ('crn-monthly', 'monthly')",
      )
      for (let i = 0; i < 150; i += 1) {
        const pick = (list: readonly (string | null)[]) => list[i % list.length] ?? null
        const flags = ISSUE_FLAGS.filter((_, index) => (i + index) % 4 === 0)
        await pool.query(
          `INSERT INTO kaudit_call_audit_result
             (id, run_id, source_ref_id, processing_status, eligibility, intent,
              grouped_outcome, kserve_comparison_label, mismatch_severity,
              qualification_label, next_action_code, issue_flags_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            `car-${i}`, i % 2 ? 'crn-daily' : 'crn-monthly', `cas-${i % 60}`,
            pick(values.processing_status), pick(values.eligibility), pick(values.intent),
            pick(values.grouped_outcome), pick(values.kserve_comparison_label),
            pick(values.mismatch_severity), pick(values.qualification_label),
            pick(values.next_action_code),
            i % 9 === 0 ? null : JSON.stringify(flags),
          ],
        )
      }
      const repository = createMysqlCallAuditReportingRepository(pool)
      const july = { periodStart: '2026-07-01 00:00:00', periodEndExclusive: '2026-08-01 00:00:00' }
      for (const query of [
        { period: july },
        { period: july, runTypes: ['monthly' as const] },
        { period: july, runId: 'crn-daily' },
        { period: { periodStart: '2031-01-01 00:00:00', periodEndExclusive: '2031-02-01 00:00:00' } },
      ]) {
        const summary = await repository.getPeriodSummary(query)
        const period = validateReportPeriod(query.period)
        const scoped = CALL_AUDIT_REPORTING_SQL.buildScopedSql(
          `FROM \`kaudit_call_audit_result\` res
   JOIN \`kaudit_call_audit_source_ref\` src ON src.\`id\` = res.\`source_ref_id\``,
          {
            period,
            runTypes: query.runTypes ?? [],
            runId: query.runId ?? null,
          } as never,
        )
        const [[totals]] = await pool.execute<RowDataPacket[]>(
          `${CALL_AUDIT_REPORTING_SQL.summaryTotalsProjection}
   ${scoped.from}
   WHERE ${scoped.where}`,
          scoped.parameters,
        )
        assert.equal(summary.resultCount, Number(totals!.result_count))
        assert.equal(summary.auditedCallCount, Number(totals!.audited_call_count))
        for (const dimension of CALL_AUDIT_REPORTING_SQL.dimensions) {
          const [buckets] = await pool.execute(
            CALL_AUDIT_REPORTING_SQL.buildDimensionSql(dimension, scoped),
            scoped.parameters,
          )
          assert.deepEqual(
            summary[dimension.key],
            tallyBuckets(buckets as never, dimension.vocabulary, dimension.column),
            dimension.key,
          )
        }
        const [[flagRow]] = await pool.execute<RowDataPacket[]>(
          CALL_AUDIT_REPORTING_SQL.buildIssueFlagSql(scoped),
          [...ISSUE_FLAGS.map(issueFlagNeedle), ...scoped.parameters],
        )
        for (const flag of ISSUE_FLAGS) {
          assert.equal(summary.byIssueFlag[flag], Number(flagRow![`flag_${flag}`]), flag)
        }
      }
    })
  },
)
