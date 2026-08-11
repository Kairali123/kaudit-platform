import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Pool } from 'mysql2/promise'
import {
  averageMetricScore,
  CALL_AUDIT_REPORT_CADENCES,
  CALL_AUDIT_REPORTING_SQL,
  CallAuditReportingError,
  createMysqlCallAuditReportingRepository,
  issueFlagNeedle,
  MAX_RESULT_PAGE_SIZE,
  MAX_RUN_PAGE_SIZE,
  nextCallAuditResultCursor,
  parseIssueFlags,
  validateReportPeriod,
  type CallAuditPeriodQuery,
  type CallAuditResultListQuery,
  type CallAuditRunListQuery,
} from './mysqlCallAuditReporting.ts'
import { CALL_AUDIT_METRIC_CODES } from '../callaudit/rubric.ts'
import { ISSUE_FLAGS } from '../callaudit/modelOutput.ts'

/**
 * Contract tests for the sanitized Call Audit reporting repository.
 *
 * No database is contacted: a recording fake stands in for a mysql2 pool, so
 * every assertion is about the SQL this module emits, the parameters it binds,
 * and the DTOs it maps back.
 *
 * Every fixture here is SYNTHETIC. There is no real transcript, lead id, task
 * id, phone, email, URL, invoice, or secret anywhere in this file.
 */

// ---------------------------------------------------------------------------
// Recording fake pool
// ---------------------------------------------------------------------------

interface Call {
  sql: string
  parameters: unknown[]
}

interface RowRule {
  /** Every substring must appear in the statement for the rule to apply. */
  match: string | string[]
  rows: unknown[]
}

function matches(sql: string, match: string | string[]): boolean {
  const parts = Array.isArray(match) ? match : [match]
  return parts.every((part) => sql.includes(part))
}

function fakePool(rules: RowRule[] = []) {
  const calls: Call[] = []
  const pool = {
    async execute(sql: string, parameters: unknown[] = []) {
      calls.push({ sql, parameters })
      const configured = rules.find((rule) => matches(sql, rule.match))
      return [configured ? configured.rows : []]
    },
    async getConnection() {
      throw new Error('a read-only reporting repository never takes a connection')
    },
  } as unknown as Pool

  return {
    pool,
    calls,
    find(match: string) {
      return calls.find((call) => call.sql.includes(match))
    },
    all(match: string) {
      return calls.filter((call) => call.sql.includes(match))
    },
  }
}

// ---------------------------------------------------------------------------
// Synthetic fixtures
// ---------------------------------------------------------------------------

const PERIOD = {
  periodStart: '2026-07-01 00:00:00',
  periodEndExclusive: '2026-08-01 00:00:00',
}

const NORMALIZED_PERIOD = {
  periodStart: '2026-07-01 00:00:00.000000',
  periodEndExclusive: '2026-08-01 00:00:00.000000',
}

const RUN_ID = 'crn_0000000000000000000000000000000000a1'
const RESULT_ID = 'car_0000000000000000000000000000000000b2'
const SOURCE_REF_ID = 'cas_0000000000000000000000000000000000c3'
const RULE_VERSION_ID = 'crv_0000000000000000000000000000000000d4'

/** A byte-exact approved KServe label, vendor spelling and spacing included. */
const VENDOR_LABEL = "DNC Client : Don't Call Furthur"

function periodQuery(
  overrides: Partial<CallAuditPeriodQuery> = {},
): CallAuditPeriodQuery {
  return { period: PERIOD, ...overrides }
}

function runListQuery(
  overrides: Partial<CallAuditRunListQuery> = {},
): CallAuditRunListQuery {
  return { period: PERIOD, limit: 50, ...overrides }
}

function resultListQuery(
  overrides: Partial<CallAuditResultListQuery> = {},
): CallAuditResultListQuery {
  return { period: PERIOD, limit: 100, ...overrides }
}

function runRow(overrides: Record<string, unknown> = {}) {
  return {
    run_id: RUN_ID,
    rule_version_id: RULE_VERSION_ID,
    rule_version_label: 'call-audit/2026.08.1',
    run_type: 'monthly',
    period_start: '2026-07-01 00:00:00.000000',
    period_end_exclusive: '2026-08-01 00:00:00.000000',
    period_timezone: 'Asia/Kolkata',
    status: 'completed',
    total_candidates: '120',
    processed_count: '118',
    succeeded_count: '100',
    failed_count: '3',
    skipped_count: '15',
    content_auditable_count: '90',
    operational_only_count: '30',
    error_code: null,
    scheduled_at: '2026-08-01 01:00:00.000000',
    started_at: '2026-08-01 01:00:05.000000',
    finished_at: '2026-08-01 01:42:00.000000',
    ...overrides,
  }
}

function resultRow(overrides: Record<string, unknown> = {}) {
  return {
    result_id: RESULT_ID,
    run_id: RUN_ID,
    source_ref_id: SOURCE_REF_ID,
    task_id: 'TASK-00001',
    effective_call_at: '2026-07-15 10:30:00.000000',
    call_duration_seconds: '184',
    has_transcript: 1,
    company: 'Synthetic Company',
    company_by_kserve: 'Synthetic Company (KServe)',
    service_category: 'Synthetic Category',
    call_type: 'inbound',
    call_status: 'answered',
    final_call_status: 'completed',
    ai_call_category: 'Synthetic AI Category',
    customer_engagement_level: 'medium',
    interest_level: 'warm',
    call_outcome: 'Synthetic Outcome',
    lead_status: 'open',
    final_lead_outcome: 'Synthetic Lead Outcome',
    calculated_qualification_status: 'qualified',
    followup_required: 'yes',
    processing_status: 'succeeded',
    eligibility: 'content_auditable',
    ineligibility_reason: null,
    call_connected: 1,
    customer_spoke: 1,
    meaningful_conversation: 1,
    intent: 'WARM',
    intent_confidence: '0.87000000',
    detailed_outcome: VENDOR_LABEL,
    grouped_outcome: 'EXISTING_DUPLICATE_DNC',
    qualification_label: 'NON_QUALIFIED',
    next_action_code: 'DO_NOT_CALL',
    overall_score: '72.267',
    overall_score_method: 'call-audit-weighted-percentage/1.0.0',
    kserve_reported_outcome: VENDOR_LABEL,
    kserve_comparison_label: 'match',
    mismatch_severity: 'none',
    management_feedback: 'Agent honoured the do-not-call request promptly.',
    kserve_feedback: 'Classification agreed with the audited outcome.',
    improvement_feedback: 'Close the call sooner once the request is stated.',
    issue_flags_json: '["DNC_RISK","WEAK_NEXT_STEP"]',
    audited_at: '2026-08-01 01:20:00.000000',
    ...overrides,
  }
}

function metricRow(
  metricCode: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    metric_code: metricCode,
    scored_count: '3',
    na_count: '0',
    score_total: '11',
    score_1: '0',
    score_2: '0',
    score_3: '1',
    score_4: '1',
    score_5: '1',
    ...overrides,
  }
}

function usageRow(overrides: Record<string, unknown> = {}) {
  return {
    provider_name: 'synthetic-provider',
    model_name: 'synthetic-model',
    model_version: '2026-08-01',
    attempt_outcome: 'succeeded',
    attempt_count: '104',
    result_count: '100',
    max_attempt_number: '3',
    input_tokens_total: '9223372036854775807',
    output_tokens_total: '4611686018427387904',
    total_tokens_total: '9223372036854775807',
    latency_ms_total: '1234567890123',
    latency_ms_max: '8400',
    errored_count: '4',
    ...overrides,
  }
}

/** Rules that give every summary statement a row, so one call exercises all. */
function summaryRules(): RowRule[] {
  return [
    { match: 'audited_call_count', rows: [{ result_count: '7', audited_call_count: '5' }] },
    {
      match: 'GROUP BY res.`processing_status`',
      rows: [
        { bucket: 'succeeded', bucket_count: '5' },
        { bucket: 'failed', bucket_count: '2' },
      ],
    },
    {
      match: 'GROUP BY res.`eligibility`',
      rows: [
        { bucket: 'content_auditable', bucket_count: '4' },
        { bucket: 'operational_only', bucket_count: '3' },
      ],
    },
    {
      match: 'GROUP BY res.`intent`',
      rows: [
        { bucket: null, bucket_count: '3' },
        { bucket: 'WARM', bucket_count: '2' },
        { bucket: 'HIGH', bucket_count: '2' },
      ],
    },
    {
      match: 'GROUP BY res.`grouped_outcome`',
      rows: [
        { bucket: 'EXISTING_DUPLICATE_DNC', bucket_count: '4' },
        // A label outside the locked vocabulary must be counted, never surfaced.
        { bucket: 'SOME_FUTURE_GROUP', bucket_count: '3' },
      ],
    },
    {
      match: 'GROUP BY res.`kserve_comparison_label`',
      rows: [
        { bucket: 'match', bucket_count: '4' },
        { bucket: 'mismatch', bucket_count: '3' },
      ],
    },
    {
      match: 'GROUP BY res.`mismatch_severity`',
      rows: [
        { bucket: 'none', bucket_count: '4' },
        { bucket: 'high', bucket_count: '3' },
      ],
    },
    {
      match: 'GROUP BY res.`qualification_label`',
      rows: [{ bucket: 'NON_QUALIFIED', bucket_count: '7' }],
    },
    {
      match: 'GROUP BY res.`next_action_code`',
      rows: [{ bucket: 'DO_NOT_CALL', bucket_count: '7' }],
    },
    {
      match: 'flag_DNC_RISK',
      rows: [
        Object.fromEntries(
          ISSUE_FLAGS.map((flag) => [
            `flag_${flag}`,
            flag === 'DNC_RISK' ? '4' : flag === 'WEAK_NEXT_STEP' ? '2' : '0',
          ]),
        ),
      ],
    },
  ]
}

/** Exercises every read method once, against one fake pool. */
async function exerciseEveryRead(rules: RowRule[] = []) {
  const fake = fakePool(rules)
  const repo = createMysqlCallAuditReportingRepository(fake.pool)
  await repo.getRunProgress(RUN_ID)
  await repo.listRuns(
    runListQuery({ runTypes: ['daily', 'monthly'], statuses: ['completed'] }),
  )
  await repo.getPeriodSummary(periodQuery({ runTypes: ['monthly'] }))
  await repo.listMetricScoreAggregates(periodQuery({ runId: RUN_ID }))
  await repo.listResults(
    resultListQuery({
      cursor: { effectiveCallAt: '2026-07-15 10:30:00', resultId: RESULT_ID },
    }),
  )
  await repo.listUsageAggregates(periodQuery())
  return fake
}

// ---------------------------------------------------------------------------
// Read-only SQL contract
// ---------------------------------------------------------------------------

const WRITE_KEYWORDS = [
  'INSERT',
  'UPDATE',
  'DELETE',
  'REPLACE',
  'MERGE',
  'ALTER',
  'CREATE',
  'DROP',
  'TRUNCATE',
  'RENAME',
  'GRANT',
  'LOCK',
  'UNLOCK',
  'FOR UPDATE',
  'FOR SHARE',
  'BEGIN',
  'START TRANSACTION',
  'COMMIT',
  'ROLLBACK',
  'SET ',
  'CALL ',
  'PREPARE',
  'EXECUTE',
  'INTO OUTFILE',
]

test('every statement is a read-only SELECT', async () => {
  const fake = await exerciseEveryRead(summaryRules())
  assert.ok(fake.calls.length >= 14)
  for (const call of fake.calls) {
    assert.match(call.sql, /^SELECT /)
    const upper = call.sql.toUpperCase()
    for (const keyword of WRITE_KEYWORDS) {
      assert.ok(
        !upper.includes(keyword),
        `statement must not contain ${keyword}: ${call.sql}`,
      )
    }
    assert.ok(!call.sql.includes(';'), 'a statement is never batched')
  }
})

test('a reporting read never opens a connection or a transaction', async () => {
  // getConnection() throws in the fake, so a lifecycle write path would fail.
  await exerciseEveryRead(summaryRules())
})

test('every statement uses only the six migration 0008 tables', async () => {
  const fake = await exerciseEveryRead(summaryRules())
  const allowed = new Set<string>(CALL_AUDIT_REPORTING_SQL.tables)
  assert.equal(allowed.size, 6)
  for (const call of fake.calls) {
    const referenced = [...call.sql.matchAll(/(?:FROM|JOIN)\s+`([^`]+)`/g)].map(
      (match) => match[1],
    )
    assert.ok(referenced.length > 0)
    for (const table of referenced) {
      assert.ok(allowed.has(table), `unexpected table ${table}`)
    }
  }
})

test('no forbidden table, column, or content name is ever queried', async () => {
  const fake = await exerciseEveryRead(summaryRules())
  // `has_transcript` is a deliberate presence FLAG, so the transcript itself is
  // pinned by its exact column names rather than by the substring 'transcript'.
  const forbidden = [
    'ai_voice_leads_received',
    'transcription',
    'transcript_sha256',
    'lead_id',
    'business_prompt',
    'scoring_config_json',
    'prompt_sha256',
    'config_sha256',
    'result_json',
    'result_sha256',
    'error_detail',
    'source_row_id',
    'source_revision_sha256',
    'data_source',
    'verified_source',
    'client_name',
    'mobile',
    'email',
    'customer_context',
    'additional_notes',
    'ai_call_summary',
    'customer_intent',
    'next_action_required',
    'model_provider',
    'temperature',
    'kaudit_invoice',
    'kaudit_provider_cost',
    'kaudit_billing',
    'price',
    'amount',
    'currency',
    'cost',
    'money',
    'minutes_decimal',
    'quantity_decimal',
  ]
  for (const call of fake.calls) {
    const lower = call.sql.toLowerCase()
    for (const name of forbidden) {
      assert.ok(
        !lower.includes(name),
        `statement must not name ${name}: ${call.sql}`,
      )
    }
  }
})

test('every caller value is a bound placeholder, never inlined SQL text', async () => {
  const fake = await exerciseEveryRead(summaryRules())
  for (const call of fake.calls) {
    const placeholders = (call.sql.match(/\?/g) ?? []).length
    assert.equal(
      placeholders,
      call.parameters.length,
      `placeholder count must match parameters: ${call.sql}`,
    )
    for (const literal of [
      PERIOD.periodStart,
      NORMALIZED_PERIOD.periodStart,
      NORMALIZED_PERIOD.periodEndExclusive,
      RUN_ID,
      RESULT_ID,
    ]) {
      assert.ok(
        !call.sql.includes(literal),
        `caller value must not appear in SQL: ${call.sql}`,
      )
    }
    for (const parameter of call.parameters) {
      assert.ok(
        typeof parameter === 'string' || typeof parameter === 'number',
        'every bound parameter is a primitive',
      )
    }
  }
})

test('a run-type filter binds each cadence as its own placeholder', async () => {
  const fake = fakePool()
  const repo = createMysqlCallAuditReportingRepository(fake.pool)
  await repo.getPeriodSummary(
    periodQuery({ runTypes: [...CALL_AUDIT_REPORT_CADENCES] }),
  )
  const call = fake.find('audited_call_count')
  assert.ok(call)
  assert.ok(call.sql.includes('`run`.`run_type` IN (?, ?, ?, ?)'))
  assert.deepEqual(call.parameters, [
    NORMALIZED_PERIOD.periodStart,
    NORMALIZED_PERIOD.periodEndExclusive,
    'daily',
    'monthly',
    'quarterly',
    'yearly',
  ])
})

test('an unfiltered period read does not join the run table at all', async () => {
  const fake = fakePool()
  const repo = createMysqlCallAuditReportingRepository(fake.pool)
  await repo.listUsageAggregates(periodQuery())
  const call = fake.find('attempt_outcome')
  assert.ok(call)
  assert.ok(!call.sql.includes('kaudit_call_audit_run'))
  assert.deepEqual(call.parameters, [
    NORMALIZED_PERIOD.periodStart,
    NORMALIZED_PERIOD.periodEndExclusive,
  ])
})

// ---------------------------------------------------------------------------
// Runs and progress
// ---------------------------------------------------------------------------

test('run progress maps counters and status safely', async () => {
  const fake = fakePool([{ match: 'WHERE `run`.`id` = ?', rows: [runRow()] }])
  const repo = createMysqlCallAuditReportingRepository(fake.pool)
  const progress = await repo.getRunProgress(RUN_ID)
  assert.ok(progress)
  assert.equal(progress.runId, RUN_ID)
  assert.equal(progress.ruleVersionLabel, 'call-audit/2026.08.1')
  assert.equal(progress.runType, 'monthly')
  assert.equal(progress.status, 'completed')
  assert.equal(progress.periodStart, '2026-07-01 00:00:00.000000')
  assert.equal(progress.periodEndExclusive, '2026-08-01 00:00:00.000000')
  assert.equal(progress.periodTimezone, 'Asia/Kolkata')
  assert.deepEqual(progress.counters, {
    totalCandidates: 120,
    processedCount: 118,
    succeededCount: 100,
    failedCount: 3,
    skippedCount: 15,
    contentAuditableCount: 90,
    operationalOnlyCount: 30,
  })
  assert.equal(progress.errorCode, null)
  assert.equal(progress.finishedAt, '2026-08-01 01:42:00.000000')
})

test('a pending run keeps its unset stamps null rather than inventing them', async () => {
  const fake = fakePool([
    {
      match: 'WHERE `run`.`id` = ?',
      rows: [
        runRow({
          status: 'pending',
          processed_count: '0',
          succeeded_count: '0',
          failed_count: '0',
          skipped_count: '0',
          content_auditable_count: '0',
          operational_only_count: '0',
          started_at: null,
          finished_at: null,
        }),
      ],
    },
  ])
  const repo = createMysqlCallAuditReportingRepository(fake.pool)
  const progress = await repo.getRunProgress(RUN_ID)
  assert.ok(progress)
  assert.equal(progress.status, 'pending')
  assert.equal(progress.startedAt, null)
  assert.equal(progress.finishedAt, null)
  assert.equal(progress.counters.processedCount, 0)
})

test('a missing run reads as null, not as an empty run', async () => {
  const fake = fakePool()
  const repo = createMysqlCallAuditReportingRepository(fake.pool)
  assert.equal(await repo.getRunProgress(RUN_ID), null)
})

test('run listing bounds the window, filters cadences, and orders newest first', async () => {
  const fake = fakePool([{ match: 'ORDER BY', rows: [runRow()] }])
  const repo = createMysqlCallAuditReportingRepository(fake.pool)
  const runs = await repo.listRuns(
    runListQuery({
      runTypes: ['monthly', 'daily'],
      statuses: ['completed', 'running'],
      limit: 25,
    }),
  )
  assert.equal(runs.length, 1)
  const call = fake.calls[0]
  assert.ok(
    call.sql.includes('`run`.`period_start` >= ? AND `run`.`period_start` < ?'),
  )
  assert.ok(call.sql.includes('`run`.`run_type` IN (?, ?)'))
  assert.ok(call.sql.includes('`run`.`status` IN (?, ?)'))
  assert.ok(
    call.sql.includes('ORDER BY `run`.`period_start` DESC, `run`.`id` ASC'),
  )
  assert.ok(call.sql.includes('LIMIT ?'))
  // Cadences and statuses are echoed in vocabulary order, never caller order.
  assert.deepEqual(call.parameters, [
    NORMALIZED_PERIOD.periodStart,
    NORMALIZED_PERIOD.periodEndExclusive,
    'daily',
    'monthly',
    'running',
    'completed',
    25,
  ])
})

test('run progress never exposes rule prompt or model settings', async () => {
  const fake = fakePool([{ match: 'WHERE `run`.`id` = ?', rows: [runRow()] }])
  const repo = createMysqlCallAuditReportingRepository(fake.pool)
  const progress = await repo.getRunProgress(RUN_ID)
  assert.ok(progress)
  assert.deepEqual(Object.keys(progress).sort(), [
    'counters',
    'errorCode',
    'finishedAt',
    'periodEndExclusive',
    'periodStart',
    'periodTimezone',
    'ruleVersionId',
    'ruleVersionLabel',
    'runId',
    'runType',
    'scheduledAt',
    'startedAt',
    'status',
  ])
})

// ---------------------------------------------------------------------------
// Period summary
// ---------------------------------------------------------------------------

test('period summary maps every SQL aggregate row into its tally', async () => {
  const fake = fakePool(summaryRules())
  const repo = createMysqlCallAuditReportingRepository(fake.pool)
  const summary = await repo.getPeriodSummary(
    periodQuery({ runTypes: ['monthly'] }),
  )

  assert.deepEqual(summary.period, NORMALIZED_PERIOD)
  assert.deepEqual(summary.runTypes, ['monthly'])
  assert.equal(summary.runId, null)
  assert.equal(summary.resultCount, 7)
  assert.equal(summary.auditedCallCount, 5)

  assert.deepEqual(summary.byProcessingStatus, {
    pending: 0,
    succeeded: 5,
    failed: 2,
    skipped: 0,
    undetermined: 0,
  })
  assert.deepEqual(summary.byEligibility, {
    content_auditable: 4,
    operational_only: 3,
    undetermined: 0,
  })
  assert.deepEqual(summary.byKserveComparison, {
    match: 4,
    mismatch: 3,
    not_comparable: 0,
    undetermined: 0,
  })
  assert.deepEqual(summary.byMismatchSeverity, {
    none: 4,
    low: 0,
    medium: 0,
    high: 3,
    undetermined: 0,
  })
  assert.equal(summary.byQualification.NON_QUALIFIED, 7)
  assert.equal(summary.byQualification.QUALIFIED, 0)
  assert.equal(summary.byNextAction.DO_NOT_CALL, 7)
  assert.equal(summary.byNextAction.NONE, 0)
})

test('an undetermined intent is counted as undetermined, never as WARM', async () => {
  const fake = fakePool(summaryRules())
  const repo = createMysqlCallAuditReportingRepository(fake.pool)
  const summary = await repo.getPeriodSummary(periodQuery())
  assert.deepEqual(summary.byIntent, {
    HIGH: 2,
    WARM: 2,
    LOW: 0,
    NONE: 0,
    undetermined: 3,
  })
})

test('a grouped outcome outside the locked vocabulary is counted, not surfaced', async () => {
  const fake = fakePool(summaryRules())
  const repo = createMysqlCallAuditReportingRepository(fake.pool)
  const summary = await repo.getPeriodSummary(periodQuery())
  assert.equal(summary.byGroupedOutcome.EXISTING_DUPLICATE_DNC, 4)
  assert.equal(summary.byGroupedOutcome.undetermined, 3)
  assert.ok(!('SOME_FUTURE_GROUP' in summary.byGroupedOutcome))
})

test('issue flag counts are coded, complete, and bound as needles', async () => {
  const fake = fakePool(summaryRules())
  const repo = createMysqlCallAuditReportingRepository(fake.pool)
  const summary = await repo.getPeriodSummary(periodQuery())

  assert.deepEqual(Object.keys(summary.byIssueFlag).sort(), [...ISSUE_FLAGS].sort())
  assert.equal(summary.byIssueFlag.DNC_RISK, 4)
  assert.equal(summary.byIssueFlag.WEAK_NEXT_STEP, 2)
  assert.equal(summary.byIssueFlag.TECHNICAL_ISSUE, 0)

  const call = fake.find('flag_DNC_RISK')
  assert.ok(call)
  assert.deepEqual(call.parameters, [
    ...ISSUE_FLAGS.map(issueFlagNeedle),
    NORMALIZED_PERIOD.periodStart,
    NORMALIZED_PERIOD.periodEndExclusive,
  ])
  // INSTR, not LIKE: every flag code contains an underscore, which LIKE would
  // treat as a wildcard.
  assert.ok(call.sql.includes('INSTR(res.`issue_flags_json`, ?)'))
  assert.ok(!call.sql.includes('LIKE'))
})

test('a summary over an empty period reports zeros, not missing buckets', async () => {
  const fake = fakePool()
  const repo = createMysqlCallAuditReportingRepository(fake.pool)
  const summary = await repo.getPeriodSummary(periodQuery({ runId: RUN_ID }))
  assert.equal(summary.resultCount, 0)
  assert.equal(summary.auditedCallCount, 0)
  assert.equal(summary.runId, RUN_ID)
  assert.deepEqual(summary.byIntent, {
    HIGH: 0,
    WARM: 0,
    LOW: 0,
    NONE: 0,
    undetermined: 0,
  })
  assert.equal(
    Object.values(summary.byIssueFlag).reduce((sum, count) => sum + count, 0),
    0,
  )
})

test('summary counts every declared dimension exactly once', async () => {
  const fake = fakePool(summaryRules())
  const repo = createMysqlCallAuditReportingRepository(fake.pool)
  await repo.getPeriodSummary(periodQuery())
  for (const dimension of CALL_AUDIT_REPORTING_SQL.dimensions) {
    assert.equal(
      fake.all(`GROUP BY ${dimension.column}`).length,
      1,
      `one statement per dimension: ${dimension.key}`,
    )
  }
})

// ---------------------------------------------------------------------------
// Metric aggregates
// ---------------------------------------------------------------------------

test('metric aggregates preserve NA and the 1-5 distribution', async () => {
  const fake = fakePool([
    {
      match: 'GROUP BY ms.`metric_code`',
      rows: [
        metricRow('CUSTOMER_UNDERSTANDING', {
          scored_count: '4',
          na_count: '0',
          score_total: '15',
          score_3: '1',
          score_4: '2',
          score_5: '1',
        }),
        metricRow('OBJECTION_CALLBACK_HANDLING', {
          scored_count: '2',
          na_count: '6',
          score_total: '7',
          score_3: '1',
          score_4: '1',
          score_5: '0',
        }),
      ],
    },
  ])
  const repo = createMysqlCallAuditReportingRepository(fake.pool)
  const aggregates = await repo.listMetricScoreAggregates(periodQuery())

  // All eight rubric metrics, in rubric order, always.
  assert.deepEqual(
    aggregates.map((entry) => entry.metricCode),
    [...CALL_AUDIT_METRIC_CODES],
  )

  const understanding = aggregates.find(
    (entry) => entry.metricCode === 'CUSTOMER_UNDERSTANDING',
  )
  assert.ok(understanding)
  assert.equal(understanding.scoredCount, 4)
  assert.equal(understanding.notApplicableCount, 0)
  assert.equal(understanding.averageScore, '3.750')
  assert.deepEqual(understanding.distribution, { 1: 0, 2: 0, 3: 1, 4: 2, 5: 1 })

  const objection = aggregates.find(
    (entry) => entry.metricCode === 'OBJECTION_CALLBACK_HANDLING',
  )
  assert.ok(objection)
  // NA is its own state: it never lands in the distribution or the average.
  assert.equal(objection.notApplicableCount, 6)
  assert.equal(objection.scoredCount, 2)
  assert.equal(objection.averageScore, '3.500')
  assert.deepEqual(objection.distribution, { 1: 0, 2: 0, 3: 1, 4: 1, 5: 0 })
})

test('an unscored metric reports a null average, never 0.000', async () => {
  const fake = fakePool([
    {
      match: 'GROUP BY ms.`metric_code`',
      rows: [
        metricRow('COMPLIANCE_PRIVACY', {
          scored_count: '0',
          na_count: '9',
          score_total: '0',
          score_3: '0',
          score_4: '0',
          score_5: '0',
        }),
      ],
    },
  ])
  const repo = createMysqlCallAuditReportingRepository(fake.pool)
  const aggregates = await repo.listMetricScoreAggregates(periodQuery())
  const compliance = aggregates.find(
    (entry) => entry.metricCode === 'COMPLIANCE_PRIVACY',
  )
  assert.ok(compliance)
  assert.equal(compliance.averageScore, null)
  assert.equal(compliance.notApplicableCount, 9)

  // A metric with no rows at all is zero-filled so a report column still renders.
  const missing = aggregates.find(
    (entry) => entry.metricCode === 'PROFESSIONALISM',
  )
  assert.ok(missing)
  assert.deepEqual(missing, {
    metricCode: 'PROFESSIONALISM',
    scoredCount: 0,
    notApplicableCount: 0,
    averageScore: null,
    distribution: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 },
  })
})

test('a metric code outside the locked rubric is never reported', async () => {
  const fake = fakePool([
    {
      match: 'GROUP BY ms.`metric_code`',
      rows: [metricRow('AUDIO_VOLUME_CLARITY')],
    },
  ])
  const repo = createMysqlCallAuditReportingRepository(fake.pool)
  const aggregates = await repo.listMetricScoreAggregates(periodQuery())
  assert.equal(aggregates.length, CALL_AUDIT_METRIC_CODES.length)
  assert.ok(
    !aggregates.some((entry) => String(entry.metricCode) === 'AUDIO_VOLUME_CLARITY'),
  )
})

test('averageMetricScore rounds half-up in exact integer arithmetic', () => {
  assert.equal(averageMetricScore('11', 3), '3.667')
  assert.equal(averageMetricScore('7', 2), '3.500')
  assert.equal(averageMetricScore('10', 4), '2.500')
  assert.equal(averageMetricScore('5', 1), '5.000')
  assert.equal(averageMetricScore('0', 0), null)
  assert.equal(averageMetricScore('9', -1), null)
})

// ---------------------------------------------------------------------------
// Sanitized result rows
// ---------------------------------------------------------------------------

test('a drilldown row is anonymous and carries only sanitized columns', async () => {
  const fake = fakePool([{ match: 'ORDER BY src.`effective_call_at`', rows: [resultRow()] }])
  const repo = createMysqlCallAuditReportingRepository(fake.pool)
  const [row] = await repo.listResults(resultListQuery())

  assert.equal(row.taskId, 'TASK-00001')
  assert.equal(row.resultId, RESULT_ID)
  assert.equal(row.runId, RUN_ID)
  assert.equal(row.sourceRefId, SOURCE_REF_ID)
  assert.equal(row.effectiveCallAt, '2026-07-15 10:30:00.000000')
  assert.equal(row.callDurationSeconds, 184)
  assert.equal(row.hasTranscript, true)
  assert.equal(row.processingStatus, 'succeeded')
  assert.equal(row.eligibility, 'content_auditable')
  assert.equal(row.intent, 'WARM')
  assert.equal(row.intentConfidence, '0.87000000')
  assert.equal(row.overallScore, '72.267')
  assert.equal(row.kserveComparisonLabel, 'match')
  assert.equal(row.mismatchSeverity, 'none')
  // Stable approved-vocabulary order, not the stored array order.
  assert.deepEqual(row.issueFlags, ['WEAK_NEXT_STEP', 'DNC_RISK'])
  assert.equal(row.auditedAt, '2026-08-01 01:20:00.000000')

  const forbiddenKeys = [
    'leadId',
    'leadIdSha256',
    'transcript',
    'transcriptSha256',
    'transcription',
    'transcriptionViewUrl',
    'clientName',
    'mobile',
    'email',
    'resultJson',
    'resultSha256',
    'errorDetail',
    'businessPrompt',
    'scoringConfigJson',
    'sourceRowId',
    'dataSource',
    'verifiedSource',
    'cost',
    'amount',
    'price',
    'currency',
  ]
  for (const key of forbiddenKeys) {
    assert.ok(!(key in row), `a report row must not carry ${key}`)
  }
})

test('vendor outcome labels are returned byte-exact, never aliased', async () => {
  const fake = fakePool([
    { match: 'ORDER BY src.`effective_call_at`', rows: [resultRow()] },
  ])
  const repo = createMysqlCallAuditReportingRepository(fake.pool)
  const [row] = await repo.listResults(resultListQuery())
  assert.equal(row.detailedOutcome, VENDOR_LABEL)
  assert.equal(row.kserveReportedOutcome, VENDOR_LABEL)
  assert.equal(row.groupedOutcome, 'EXISTING_DUPLICATE_DNC')
})

test('an undetermined call state stays null and is never read as false', async () => {
  const fake = fakePool([
    {
      match: 'ORDER BY src.`effective_call_at`',
      rows: [
        resultRow({
          processing_status: 'skipped',
          eligibility: 'operational_only',
          ineligibility_reason: 'missing_transcript',
          has_transcript: 0,
          call_connected: null,
          customer_spoke: null,
          meaningful_conversation: null,
          intent: null,
          intent_confidence: null,
          detailed_outcome: null,
          grouped_outcome: null,
          qualification_label: null,
          next_action_code: null,
          overall_score: null,
          overall_score_method: null,
          kserve_reported_outcome: null,
          kserve_comparison_label: null,
          mismatch_severity: null,
          management_feedback: null,
          kserve_feedback: null,
          improvement_feedback: null,
          issue_flags_json: null,
          call_duration_seconds: null,
          audited_at: null,
        }),
      ],
    },
  ])
  const repo = createMysqlCallAuditReportingRepository(fake.pool)
  const [row] = await repo.listResults(resultListQuery())
  assert.equal(row.hasTranscript, false)
  assert.equal(row.callConnected, null)
  assert.equal(row.customerSpoke, null)
  assert.equal(row.meaningfulConversation, null)
  assert.equal(row.intent, null)
  assert.equal(row.overallScore, null)
  assert.equal(row.callDurationSeconds, null)
  assert.equal(row.ineligibilityReason, 'missing_transcript')
  assert.deepEqual(row.issueFlags, [])
})

test('drilldown paging is keyset, bounded, and deterministically ordered', async () => {
  const fake = fakePool([
    { match: 'ORDER BY src.`effective_call_at`', rows: [resultRow()] },
  ])
  const repo = createMysqlCallAuditReportingRepository(fake.pool)
  const rows = await repo.listResults(
    resultListQuery({
      limit: 2,
      runTypes: ['monthly'],
      cursor: { effectiveCallAt: '2026-07-15 10:30:00', resultId: RESULT_ID },
    }),
  )
  const call = fake.calls[0]
  assert.ok(call.sql.includes('ORDER BY src.`effective_call_at` ASC, res.`id` ASC'))
  assert.ok(!call.sql.includes('OFFSET'))
  assert.ok(call.sql.includes('LIMIT ?'))
  assert.deepEqual(call.parameters, [
    NORMALIZED_PERIOD.periodStart,
    NORMALIZED_PERIOD.periodEndExclusive,
    'monthly',
    '2026-07-15 10:30:00.000000',
    '2026-07-15 10:30:00.000000',
    RESULT_ID,
    2,
  ])
  assert.deepEqual(nextCallAuditResultCursor(rows), {
    effectiveCallAt: '2026-07-15 10:30:00.000000',
    resultId: RESULT_ID,
  })
  assert.equal(nextCallAuditResultCursor([]), null)
})

test('a stored code outside its approved vocabulary is refused by column name', async () => {
  const fake = fakePool([
    {
      match: 'ORDER BY src.`effective_call_at`',
      rows: [resultRow({ processing_status: 'partially_done' })],
    },
  ])
  const repo = createMysqlCallAuditReportingRepository(fake.pool)
  await assert.rejects(
    () => repo.listResults(resultListQuery()),
    (error: unknown) => {
      assert.ok(error instanceof CallAuditReportingError)
      assert.equal(error.field, 'result.processing_status')
      // The offending value is never echoed.
      assert.ok(!error.message.includes('partially_done'))
      return true
    },
  )
})

test('parseIssueFlags keeps approved codes only and never leaks raw payloads', () => {
  assert.deepEqual(parseIssueFlags('["DNC_RISK"]'), ['DNC_RISK'])
  assert.deepEqual(parseIssueFlags('["NOT_A_FLAG","DNC_RISK"]'), ['DNC_RISK'])
  assert.deepEqual(parseIssueFlags('["DNC_RISK","DNC_RISK"]'), ['DNC_RISK'])
  assert.deepEqual(parseIssueFlags('not json at all'), [])
  assert.deepEqual(parseIssueFlags('{"flag":"DNC_RISK"}'), [])
  assert.deepEqual(parseIssueFlags(null), [])
  assert.deepEqual(parseIssueFlags(''), [])
  // Stable rubric-order output regardless of stored order.
  assert.deepEqual(parseIssueFlags('["DNC_RISK","TECHNICAL_ISSUE"]'), [
    'TECHNICAL_ISSUE',
    'DNC_RISK',
  ])
})

// ---------------------------------------------------------------------------
// Usage and reliability
// ---------------------------------------------------------------------------

test('usage aggregates keep BIGINT values as strings and carry no money', async () => {
  const fake = fakePool([
    { match: 'GROUP BY ue.`provider_name`', rows: [usageRow()] },
  ])
  const repo = createMysqlCallAuditReportingRepository(fake.pool)
  const [aggregate] = await repo.listUsageAggregates(periodQuery())

  assert.equal(aggregate.providerName, 'synthetic-provider')
  assert.equal(aggregate.modelName, 'synthetic-model')
  assert.equal(aggregate.modelVersion, '2026-08-01')
  assert.equal(aggregate.attemptOutcome, 'succeeded')
  assert.equal(aggregate.attemptCount, 104)
  assert.equal(aggregate.resultCount, 100)
  assert.equal(aggregate.maxAttemptNumber, 3)
  assert.equal(aggregate.erroredCount, 4)

  for (const field of [
    'inputTokensTotal',
    'outputTokensTotal',
    'totalTokensTotal',
    'latencyMsTotal',
    'latencyMsMax',
  ] as const) {
    assert.equal(typeof aggregate[field], 'string', `${field} stays a string`)
  }
  // Exact at full BIGINT precision: a JS number would have rounded this.
  assert.equal(aggregate.inputTokensTotal, '9223372036854775807')
  assert.notEqual(aggregate.inputTokensTotal, String(Number('9223372036854775807')))

  for (const key of ['cost', 'amount', 'price', 'currency', 'spend', 'errorCode']) {
    assert.ok(!(key in aggregate), `a usage aggregate must not carry ${key}`)
  }
})

test('a refused or failed attempt is aggregated, never dropped', async () => {
  const fake = fakePool([
    {
      match: 'GROUP BY ue.`provider_name`',
      rows: [
        usageRow({ attempt_outcome: 'refused', attempt_count: '2', errored_count: '2' }),
        usageRow({
          attempt_outcome: 'failed',
          attempt_count: '3',
          errored_count: '3',
          latency_ms_max: null,
        }),
      ],
    },
  ])
  const repo = createMysqlCallAuditReportingRepository(fake.pool)
  const aggregates = await repo.listUsageAggregates(periodQuery())
  assert.deepEqual(
    aggregates.map((entry) => entry.attemptOutcome),
    ['refused', 'failed'],
  )
  assert.equal(aggregates[0].erroredCount, 2)
  assert.equal(aggregates[1].latencyMsMax, null)
})

// ---------------------------------------------------------------------------
// Validation happens before any SQL
// ---------------------------------------------------------------------------

async function rejectsBeforeSql(
  run: (repo: ReturnType<typeof createMysqlCallAuditReportingRepository>) => Promise<unknown>,
  field: string,
) {
  const fake = fakePool()
  const repo = createMysqlCallAuditReportingRepository(fake.pool)
  await assert.rejects(
    () => run(repo),
    (error: unknown) => {
      assert.ok(error instanceof CallAuditReportingError)
      assert.equal(error.code, 'CALL_AUDIT_REPORTING_ERROR')
      assert.equal(error.field, field)
      return true
    },
  )
  assert.equal(fake.calls.length, 0, 'no statement runs for invalid input')
}

test('an inverted or empty period is rejected before SQL', async () => {
  await rejectsBeforeSql(
    (repo) =>
      repo.getPeriodSummary({
        period: {
          periodStart: '2026-08-01 00:00:00',
          periodEndExclusive: '2026-07-01 00:00:00',
        },
      }),
    'period.periodEndExclusive',
  )
  await rejectsBeforeSql(
    (repo) =>
      repo.listUsageAggregates({
        period: {
          periodStart: '2026-07-01 00:00:00',
          periodEndExclusive: '2026-07-01 00:00:00',
        },
      }),
    'period.periodEndExclusive',
  )
})

test('an impossible calendar date or an offset-bearing boundary is rejected', async () => {
  await rejectsBeforeSql(
    (repo) =>
      repo.listMetricScoreAggregates({
        period: {
          periodStart: '2026-02-30 00:00:00',
          periodEndExclusive: '2026-03-31 00:00:00',
        },
      }),
    'period.periodStart',
  )
  await rejectsBeforeSql(
    (repo) =>
      repo.getPeriodSummary({
        period: {
          periodStart: '2026-07-01T00:00:00Z',
          periodEndExclusive: '2026-08-01 00:00:00',
        },
      }),
    'period.periodStart',
  )
  assert.deepEqual(validateReportPeriod(PERIOD), NORMALIZED_PERIOD)
})

test('an unknown cadence, run type, or status is rejected before SQL', async () => {
  await rejectsBeforeSql(
    (repo) =>
      repo.getPeriodSummary({
        period: PERIOD,
        runTypes: ['weekly'] as unknown as ['daily'],
      }),
    'runTypes',
  )
  await rejectsBeforeSql(
    (repo) =>
      repo.listRuns({
        period: PERIOD,
        limit: 10,
        statuses: ['halted'] as unknown as ['completed'],
      }),
    'statuses',
  )
})

test('an out-of-range page size is rejected before SQL', async () => {
  await rejectsBeforeSql(
    (repo) => repo.listRuns({ period: PERIOD, limit: MAX_RUN_PAGE_SIZE + 1 }),
    'limit',
  )
  await rejectsBeforeSql(
    (repo) =>
      repo.listResults({ period: PERIOD, limit: MAX_RESULT_PAGE_SIZE + 1 }),
    'limit',
  )
  await rejectsBeforeSql(
    (repo) => repo.listResults({ period: PERIOD, limit: 0 }),
    'limit',
  )
})

test('a cursor outside the period is rejected before SQL', async () => {
  await rejectsBeforeSql(
    (repo) =>
      repo.listResults(
        resultListQuery({
          cursor: {
            effectiveCallAt: '2026-06-30 23:59:59',
            resultId: RESULT_ID,
          },
        }),
      ),
    'cursor.effectiveCallAt',
  )
  await rejectsBeforeSql(
    (repo) =>
      repo.listResults(
        resultListQuery({
          cursor: {
            effectiveCallAt: '2026-08-01 00:00:00',
            resultId: RESULT_ID,
          },
        }),
      ),
    'cursor.effectiveCallAt',
  )
  await rejectsBeforeSql(
    (repo) =>
      repo.listResults(
        resultListQuery({
          cursor: { effectiveCallAt: '2026-07-15 10:30:00', resultId: '   ' },
        }),
      ),
    'cursor.resultId',
  )
})

test('a blank run id is rejected before SQL', async () => {
  await rejectsBeforeSql((repo) => repo.getRunProgress(''), 'runId')
  await rejectsBeforeSql(
    (repo) => repo.getPeriodSummary(periodQuery({ runId: '' })),
    'runId',
  )
})
