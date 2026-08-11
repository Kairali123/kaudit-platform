import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import type { Pool } from 'mysql2/promise'
import {
  buildSourceRefId,
  CALL_AUDIT_PERSISTENCE_SQL,
  CallAuditPersistenceConflictError,
  CallAuditPersistenceError,
  createMysqlCallAuditPersistenceRepository,
} from './mysqlCallAuditPersistence.ts'
import {
  buildContentAuditResult,
  buildFailedResult,
  buildOperationalOnlyResult,
  buildUsageEventRecord,
  type CallAuditResultIdentity,
} from '../callaudit/resultRecords.ts'
import { validateContentAuditOutput } from '../callaudit/modelOutput.ts'
import { buildSourceRevision } from '../callaudit/sourceRevision.ts'
import {
  CALL_AUDIT_SOURCE_TABLE,
  SOURCE_CATEGORICAL_FIELDS,
} from '../callaudit/sourceTypes.ts'
import { CALL_AUDIT_RUBRIC } from '../callaudit/rubric.ts'
import type { MetricScore } from '../callaudit/types.ts'

// ---------------------------------------------------------------------------
// Recording fake connection / pool. No database is ever contacted.
// ---------------------------------------------------------------------------

interface Call {
  sql: string
  parameters: unknown[]
  /** Which executor ran it: a transactional write must use the connection. */
  via: 'pool' | 'connection'
}

interface RowRule {
  match: string
  rows: unknown[]
  /**
   * Number of leading matching reads that return nothing first. Models a lost
   * race: the row only becomes visible after a concurrent writer committed it.
   */
  skip?: number
}

interface FakePoolOptions {
  /** Rows returned per SELECT statement, matched by a substring of the SQL. */
  rows?: RowRule[]
  /** Throw when a statement matching this substring executes. */
  failOn?: { match: string; error: Error }
}

function fakePool(options: FakePoolOptions = {}) {
  const calls: Call[] = []
  const transaction: string[] = []
  const reads = new Map<RowRule, number>()
  let released = 0

  function executor(via: 'pool' | 'connection') {
    return async function execute(sql: string, parameters: unknown[] = []) {
      calls.push({ sql, parameters, via })
      if (options.failOn && sql.includes(options.failOn.match)) {
        throw options.failOn.error
      }
      const configured = options.rows?.find((entry) => sql.includes(entry.match))
      if (!configured) {
        return [[]]
      }
      const seen = reads.get(configured) ?? 0
      reads.set(configured, seen + 1)
      return [seen < (configured.skip ?? 0) ? [] : configured.rows]
    }
  }

  const connection = {
    execute: executor('connection'),
    async beginTransaction() {
      transaction.push('begin')
    },
    async commit() {
      transaction.push('commit')
    },
    async rollback() {
      transaction.push('rollback')
    },
    release() {
      released += 1
    },
  }

  const pool = {
    execute: executor('pool'),
    async getConnection() {
      return connection
    },
  } as unknown as Pool

  return {
    pool,
    calls,
    transaction,
    get released() {
      return released
    },
    statements() {
      return calls.map((call) => call.sql)
    },
    find(match: string) {
      return calls.find((call) => call.sql.includes(match))
    },
    all(match: string) {
      return calls.filter((call) => call.sql.includes(match))
    },
  }
}

// ---------------------------------------------------------------------------
// Synthetic fixtures. No real customer data, transcript, or PII anywhere.
// ---------------------------------------------------------------------------

const IDENTITY: CallAuditResultIdentity = {
  runId: 'run-0001',
  sourceRefId: 'cas_0000000000000000000000000000000000',
  ruleVersionId: 'rule-0001',
}

const AUDITED_AT = '2026-08-01 09:20:00.000000'
const RECORDED_AT = '2026-08-01 09:20:01.500000'

/** A large BIGINT that a JavaScript number cannot represent exactly. */
const BIG_SOURCE_ROW_ID = '9007199254740993'

function scores(
  fill: MetricScore,
  overrides: Record<string, MetricScore> = {},
): Array<{ metric: string; score: MetricScore }> {
  return CALL_AUDIT_RUBRIC.map((metric) => ({
    metric: metric.code,
    score: Object.hasOwn(overrides, metric.code)
      ? overrides[metric.code]
      : fill,
  }))
}

function modelOutput(overrides: Record<string, unknown> = {}) {
  return validateContentAuditOutput(
    {
      callConnected: true,
      customerSpoke: true,
      meaningfulConversation: true,
      intent: 'WARM',
      detailedOutcome: 'Individual Resort Booking',
      qualification: 'QUALIFIED',
      nextAction: 'SCHEDULE_BOOKING',
      confidence: 0.82,
      metricScores: scores(4),
      issueFlags: ['WEAK_NEXT_STEP'],
      managementSummary: 'Caller asked about a resort stay.',
      kserveFeedback: 'Agent did not confirm the travel window.',
      improvementFeedback: 'Confirm dates before closing.',
      ...overrides,
    },
    { eligibility: 'content_auditable' },
  )
}

function sourceReference(overrides: Record<string, unknown> = {}) {
  return buildSourceRevision({
    sourceTable: CALL_AUDIT_SOURCE_TABLE,
    sourceRowId: BIG_SOURCE_ROW_ID,
    leadId: 'LEAD-2026-000123',
    transcript: 'Saanvi: hello? Caller: yes, tell me about the package.',
    effectiveCallTime: '2026-08-01 09:15:00.000000',
    sourceUpdatedAt: '2026-08-01 09:20:00.000000',
    callStartedAt: '2026-08-01 09:15:00.000000',
    callEndedAt: '2026-08-01 09:16:24.000000',
    callDurationSec: '00:01:24',
    company_by_kserve: 'Kairali',
    company: 'Kairali Ayurvedic Group',
    data_source: 'website_form',
    verified_source: 'verified_web',
    service_category: 'panchakarma',
    call_type: 'outbound',
    call_status: 'connected',
    call_end_reason: 'customer_hangup',
    final_call_status: 'completed',
    ai_call_category: 'information_request',
    customer_engagement_level: 'engaged',
    interest_level: 'high',
    call_outcome: 'callback_requested',
    lead_status: 'qualified',
    final_lead_outcome: 'followup_scheduled',
    calculated_qualification_status: 'qualified',
    followup_required: 'yes',
    ...overrides,
  }).reference
}

/**
 * Column values as MySQL would return them for a stored source-ref row, with
 * every persisted column present. `overrides` names COLUMNS, so a test can vary
 * one safe payload field without touching the revision tuple.
 */
function storedSourceRefRow(
  reference: ReturnType<typeof sourceReference>,
  overrides: Record<string, unknown> = {},
) {
  const row: Record<string, unknown> = {
    id: buildSourceRefId(reference),
    source_table: reference.sourceTable,
    source_row_id: reference.sourceRowId,
    source_revision_sha256: reference.sourceRevisionSha256,
    task_id: reference.taskId,
    lead_id_sha256: reference.leadIdSha256,
    transcript_sha256: reference.transcriptSha256,
    has_transcript: reference.hasTranscript ? 1 : 0,
    effective_call_at: reference.effectiveCallTime,
    source_updated_at: reference.sourceUpdatedAt,
    call_started_at: reference.callStartedAt,
    call_ended_at: reference.callEndedAt,
    call_duration_seconds: reference.callDurationSeconds,
    source_ref_idempotency_key: reference.sourceRefIdempotencyKey,
  }
  for (const field of SOURCE_CATEGORICAL_FIELDS) {
    row[field] = reference[field]
  }
  return { ...row, ...overrides }
}

function storedMetricRow(record: Record<string, unknown>) {
  return {
    id: record.id,
    result_id: record.resultId,
    metric_code: record.metricCode,
    score_value: record.scoreValue,
    is_not_applicable: record.isNotApplicable ? 1 : 0,
  }
}

/** The eight rows MySQL would return for a stored succeeded content bundle. */
function storedMetricRows(bundle: {
  metricScores: readonly unknown[]
}): Array<Record<string, unknown>> {
  return bundle.metricScores.map((entry) =>
    storedMetricRow(entry as Record<string, unknown>),
  )
}

const USAGE_BASE = {
  identity: IDENTITY,
  attemptNumber: 1,
  attemptOutcome: 'succeeded' as const,
  providerName: 'openai',
  modelName: 'gpt-4o-mini',
  modelVersion: 'gpt-4o-mini-2024-07-18',
  recordedAt: RECORDED_AT,
}

/** Column values as MySQL would return them for a stored result row. */
function storedResultRow(record: Record<string, unknown>) {
  return {
    id: record.id,
    run_id: record.runId,
    source_ref_id: record.sourceRefId,
    rule_version_id: record.ruleVersionId,
    processing_status: record.processingStatus,
    eligibility: record.eligibility,
    ineligibility_reason: record.ineligibilityReason,
    call_connected:
      record.callConnected === null ? null : record.callConnected ? 1 : 0,
    customer_spoke:
      record.customerSpoke === null ? null : record.customerSpoke ? 1 : 0,
    meaningful_conversation:
      record.meaningfulConversation === null
        ? null
        : record.meaningfulConversation
          ? 1
          : 0,
    intent: record.intent,
    intent_confidence: record.intentConfidence,
    detailed_outcome: record.detailedOutcome,
    grouped_outcome: record.groupedOutcome,
    qualification_label: record.qualificationLabel,
    next_action_code: record.nextActionCode,
    overall_score: record.overallScore,
    overall_score_method: record.overallScoreMethod,
    kserve_reported_outcome: record.kserveReportedOutcome,
    kserve_comparison_label: record.kserveComparisonLabel,
    mismatch_severity: record.mismatchSeverity,
    management_feedback: record.managementFeedback,
    kserve_feedback: record.kserveFeedback,
    improvement_feedback: record.improvementFeedback,
    issue_flags_json: record.issueFlagsJson,
    result_json: record.resultJson,
    result_sha256: record.resultSha256,
    error_code: record.errorCode,
    error_detail: record.errorDetail,
    audited_at: record.auditedAt,
  }
}

function storedUsageRow(record: Record<string, unknown>) {
  return {
    id: record.id,
    result_id: record.resultId,
    run_id: record.runId,
    rule_version_id: record.ruleVersionId,
    attempt_number: record.attemptNumber,
    attempt_outcome: record.attemptOutcome,
    provider_name: record.providerName,
    model_name: record.modelName,
    model_version: record.modelVersion,
    input_tokens: record.inputTokens,
    output_tokens: record.outputTokens,
    total_tokens: record.totalTokens,
    request_id: record.requestId,
    latency_ms: record.latencyMs,
    error_code: record.errorCode,
    recorded_at: record.recordedAt,
  }
}

const ALL_SQL = Object.values(CALL_AUDIT_PERSISTENCE_SQL)

// ---------------------------------------------------------------------------
// SQL safety
// ---------------------------------------------------------------------------

test('every statement is parameterized and uses explicit columns', () => {
  for (const sql of ALL_SQL) {
    assert.equal(/SELECT\s+\*/i.test(sql), false, `SELECT * in: ${sql}`)
    assert.ok(sql.includes('?'), `no placeholder in: ${sql}`)
    // No value is ever concatenated into the text.
    assert.equal(/'\s*\+/.test(sql), false)
    assert.equal(/\$\{/.test(sql), false)
  }
  assert.match(CALL_AUDIT_PERSISTENCE_SQL.insertResult, /INSERT INTO `kaudit_call_audit_result`/)
  assert.match(CALL_AUDIT_PERSISTENCE_SQL.selectResult, /SELECT `id`,/)
})

test('the module never touches the external source table', () => {
  const source = readFileSync(
    new URL('./mysqlCallAuditPersistence.ts', import.meta.url),
    'utf8',
  )
  const executable = source
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('*'))
    .filter((line) => !line.trimStart().startsWith('//'))
    .join('\n')
    // Blank string literals so a documentation mention cannot count.
    .replace(/'[^']*'/g, "''")
    .replace(/`[^`]*`/g, '``')
  assert.equal(
    executable.includes('ai_voice_leads_received'),
    false,
    'the writer must never name the read-only source table',
  )
  for (const sql of ALL_SQL) {
    assert.equal(sql.includes('ai_voice_leads_received'), false)
    assert.equal(/\bFOR\s+UPDATE\b/i.test(sql), false, `locking in: ${sql}`)
    assert.equal(/\bLOCK\s+TABLES\b/i.test(sql), false)
    assert.equal(/\bFOREIGN\s+KEY\b/i.test(sql), false)
  }
})

test('only the six call-audit tables are written', () => {
  const targets = new Set<string>()
  for (const sql of ALL_SQL) {
    for (const match of sql.matchAll(
      /(?:INSERT INTO|FROM|UPDATE)\s+`([a-z0-9_]+)`/gi,
    )) {
      targets.add(match[1])
    }
  }
  assert.deepEqual(
    [...targets].sort(),
    [
      'kaudit_call_audit_metric_score',
      'kaudit_call_audit_result',
      'kaudit_call_audit_source_ref',
      'kaudit_call_audit_usage_event',
    ],
  )
})

test('the adapter uses execute, never query', async () => {
  const source = readFileSync(
    new URL('./mysqlCallAuditPersistence.ts', import.meta.url),
    'utf8',
  )
  assert.equal(/\bpool\.query\b/.test(source), false)
  assert.equal(/\bconnection\.query\b/.test(source), false)
  assert.match(source, /pool\.execute</)
  assert.match(source, /connection\.execute\(/)
})

test('no statement carries a destructive or money-bearing column', () => {
  for (const sql of ALL_SQL) {
    for (const forbidden of [
      /\bDELETE\b/i,
      /\bTRUNCATE\b/i,
      /\bDROP\b/i,
      /\bALTER\b/i,
      /\bREPLACE\s+INTO\b/i,
      /ON\s+DUPLICATE\s+KEY/i,
      /\btranscript\b/i,
      /\blead_id\b/i,
      /\bcost\b/i,
      /\bamount\b/i,
      /\bprice\b/i,
      /\bcurrency\b/i,
      /\bprompt\b/i,
      /raw_response/i,
      /error_message/i,
    ]) {
      assert.equal(forbidden.test(sql), false, `${forbidden} found in: ${sql}`)
    }
  }
})

// ---------------------------------------------------------------------------
// Deterministic source-ref id
// ---------------------------------------------------------------------------

test('the source-ref id is deterministic, prefixed, and varchar(40)', () => {
  const reference = sourceReference()
  const id = buildSourceRefId(reference)
  assert.equal(id, buildSourceRefId(sourceReference()))
  assert.match(id, /^cas_[0-9a-f]{36}$/)
  assert.equal(id.length, 40)
})

test('a changed revision yields a different source-ref id', () => {
  const baseline = buildSourceRefId(sourceReference())
  const changed = buildSourceRefId(sourceReference({ transcript: null }))
  assert.notEqual(changed, baseline)
})

test('the source-ref id derives from no raw lead or transcript value', () => {
  const reference = sourceReference()
  const id = buildSourceRefId(reference)
  // Only the revision tuple participates, so an id built from just that tuple
  // must equal the id built from the whole reference.
  assert.equal(
    id,
    buildSourceRefId({
      ...reference,
      taskId: 'different',
      leadIdSha256: null,
    } as typeof reference),
  )
})

// ---------------------------------------------------------------------------
// Source reference upsert / reuse
// ---------------------------------------------------------------------------

test('an unchanged revision is reused without inserting', async () => {
  const reference = sourceReference()
  const db = fakePool({
    rows: [
      {
        match: 'FROM `kaudit_call_audit_source_ref`',
        rows: [storedSourceRefRow(reference)],
      },
    ],
  })
  const repository = createMysqlCallAuditPersistenceRepository(db.pool)
  const outcome = await repository.upsertSourceReference(reference)

  assert.equal(outcome.outcome, 'reused')
  assert.equal(outcome.id, buildSourceRefId(reference))
  assert.equal(db.all('INSERT INTO `kaudit_call_audit_source_ref`').length, 0)
  assert.deepEqual(db.find('FROM `kaudit_call_audit_source_ref`')?.parameters, [
    reference.sourceRefIdempotencyKey,
  ])
})

test('a changed revision inserts a new append-only row', async () => {
  const changed = sourceReference({ transcript: null })
  const db = fakePool()
  const repository = createMysqlCallAuditPersistenceRepository(db.pool)
  const outcome = await repository.upsertSourceReference(changed)

  assert.equal(outcome.outcome, 'inserted')
  assert.equal(outcome.id, buildSourceRefId(changed))
  const insert = db.find('INSERT INTO `kaudit_call_audit_source_ref`')
  assert.ok(insert)
  assert.equal(
    (insert.sql.match(/\?/g) ?? []).length,
    insert.parameters.length,
  )
  // Never an UPDATE statement: a source reference is immutable once
  // written. The pattern is anchored so the source_updated_at COLUMN name
  // cannot masquerade as an UPDATE statement.
  assert.equal(
    db.statements().some((sql) => /^\s*UPDATE\s/i.test(sql)),
    false,
  )
})

test('the source row id is bound as the exact BIGINT string', async () => {
  const reference = sourceReference()
  const db = fakePool()
  const repository = createMysqlCallAuditPersistenceRepository(db.pool)
  await repository.upsertSourceReference(reference)

  const insert = db.find('INSERT INTO `kaudit_call_audit_source_ref`')
  assert.ok(insert)
  assert.equal(insert.parameters[2], BIG_SOURCE_ROW_ID)
  assert.equal(typeof insert.parameters[2], 'string')
  assert.notEqual(insert.parameters[2], 9007199254740992)
  // And it is read back as CHAR so mysql2 cannot round it.
  assert.match(
    CALL_AUDIT_PERSISTENCE_SQL.selectSourceRef,
    /CAST\(`source_row_id` AS CHAR\)/,
  )
})

test('booleans are bound as tinyint 0/1', async () => {
  const withTranscript = sourceReference()
  const withoutTranscript = sourceReference({ transcript: null })
  for (const [reference, expected] of [
    [withTranscript, 1],
    [withoutTranscript, 0],
  ] as const) {
    const db = fakePool()
    const repository = createMysqlCallAuditPersistenceRepository(db.pool)
    await repository.upsertSourceReference(reference)
    const insert = db.find('INSERT INTO `kaudit_call_audit_source_ref`')
    assert.equal(insert?.parameters[7], expected)
  }
})

test('a reused key with a different revision is a typed conflict', async () => {
  const reference = sourceReference()
  const db = fakePool({
    rows: [
      {
        match: 'FROM `kaudit_call_audit_source_ref`',
        rows: [
          storedSourceRefRow(reference, {
            id: 'cas_other',
            source_revision_sha256: 'a'.repeat(64),
          }),
        ],
      },
    ],
  })
  const repository = createMysqlCallAuditPersistenceRepository(db.pool)
  await assert.rejects(
    () => repository.upsertSourceReference(reference),
    (error: unknown) => {
      assert.ok(error instanceof CallAuditPersistenceConflictError)
      assert.equal(error.entity, 'sourceRef')
      assert.equal(error.field, 'source_revision_sha256')
      return true
    },
  )
  assert.equal(db.all('INSERT INTO `kaudit_call_audit_source_ref`').length, 0)
})

test('the replay check reads back every persisted source-ref column', () => {
  const insert = CALL_AUDIT_PERSISTENCE_SQL.insertSourceRef
  const select = CALL_AUDIT_PERSISTENCE_SQL.selectSourceRef
  const inserted = [
    ...insert.slice(0, insert.indexOf('VALUES')).matchAll(/`([a-z0-9_]+)`/g),
  ]
    .map((match) => match[1])
    .filter((column) => column !== 'kaudit_call_audit_source_ref')
  const selected = new Set(
    [...select.slice(0, select.indexOf('FROM')).matchAll(/`([a-z0-9_]+)`/g)].map(
      (match) => match[1],
    ),
  )
  for (const column of inserted) {
    assert.ok(selected.has(column), `${column} is never read back`)
  }
  // created_at is database-generated and is deliberately not compared.
  assert.equal(selected.has('created_at'), false)
})

test('the same key and revision with a different safe payload is a conflict', async () => {
  const reference = sourceReference()
  // Same idempotency key, same revision identity, one differing persisted
  // column. Each is checked separately so no single field carries the test.
  for (const [column, stored, expectedField] of [
    ['task_id', 'TASK-OTHER', 'task_id'],
    ['has_transcript', 0, 'has_transcript'],
    ['effective_call_at', '2026-08-02 11:00:00.000000', 'effective_call_at'],
    ['call_duration_seconds', 999, 'call_duration_seconds'],
    ['interest_level', 'low', 'interest_level'],
  ] as Array<[string, unknown, string]>) {
    const db = fakePool({
      rows: [
        {
          match: 'FROM `kaudit_call_audit_source_ref`',
          rows: [storedSourceRefRow(reference, { [column]: stored })],
        },
      ],
    })
    const repository = createMysqlCallAuditPersistenceRepository(db.pool)
    const error = await repository
      .upsertSourceReference(reference)
      .then(() => null)
      .catch((caught: unknown) => caught)

    assert.ok(
      error instanceof CallAuditPersistenceConflictError,
      `${column} was silently reused`,
    )
    assert.equal(error.entity, 'sourceRef')
    assert.equal(error.field, expectedField)
    // Nothing is written: the conflict is raised before any append.
    assert.equal(db.all('INSERT INTO').length, 0)
  }
})

test('a source-ref conflict echoes no stored or submitted value', async () => {
  const reference = sourceReference()
  const db = fakePool({
    rows: [
      {
        match: 'FROM `kaudit_call_audit_source_ref`',
        rows: [storedSourceRefRow(reference, { task_id: 'TASK-OTHER' })],
      },
    ],
  })
  const repository = createMysqlCallAuditPersistenceRepository(db.pool)
  const error = (await repository
    .upsertSourceReference(reference)
    .then(() => null)
    .catch((caught: unknown) => caught)) as CallAuditPersistenceConflictError

  const text = `${error.message}\n${error.stack ?? ''}`
  assert.equal(text.includes('TASK-OTHER'), false)
  assert.equal(text.includes(reference.taskId as string), false)
  assert.equal(text.includes(reference.sourceRevisionSha256), false)
})

// ---------------------------------------------------------------------------
// Succeeded content result
// ---------------------------------------------------------------------------

test('a succeeded content result writes the result and eight metric rows in one transaction', async () => {
  const bundle = buildContentAuditResult({
    identity: IDENTITY,
    output: modelOutput(),
    auditedAt: AUDITED_AT,
  })
  const db = fakePool()
  const repository = createMysqlCallAuditPersistenceRepository(db.pool)
  const outcome = await repository.saveResultBundle(bundle)

  assert.equal(outcome.outcome, 'inserted')
  assert.deepEqual(db.transaction, ['begin', 'commit'])
  assert.equal(db.released, 1)

  const resultInsert = db.find('INSERT INTO `kaudit_call_audit_result`')
  const metricInsert = db.find('INSERT INTO `kaudit_call_audit_metric_score`')
  assert.ok(resultInsert)
  assert.ok(metricInsert)
  // Exactly eight tuples of five columns.
  assert.equal(metricInsert.parameters.length, CALL_AUDIT_RUBRIC.length * 5)
  assert.equal(
    (metricInsert.sql.match(/\(\?, \?, \?, \?, \?\)/g) ?? []).length,
    CALL_AUDIT_RUBRIC.length,
  )
  const codes = bundle.metricScores.map((entry) => entry.metricCode)
  assert.deepEqual(codes, CALL_AUDIT_RUBRIC.map((metric) => metric.code))

  // Both writes must run on the transactional connection, never on the pool,
  // or a failed metric insert would leave an orphaned result behind.
  assert.equal(resultInsert.via, 'connection')
  assert.equal(metricInsert.via, 'connection')
  assert.equal(
    db.calls.every((call) => call.via === 'connection'),
    true,
    'no part of the bundle may escape the transaction',
  )
})

test('a metric insert failure rolls back the whole bundle', async () => {
  const bundle = buildContentAuditResult({
    identity: IDENTITY,
    output: modelOutput(),
    auditedAt: AUDITED_AT,
  })
  const failure = new Error('metric insert failed')
  const db = fakePool({
    failOn: { match: 'INSERT INTO `kaudit_call_audit_metric_score`', error: failure },
  })
  const repository = createMysqlCallAuditPersistenceRepository(db.pool)

  await assert.rejects(() => repository.saveResultBundle(bundle), failure)
  assert.deepEqual(db.transaction, ['begin', 'rollback'])
  assert.equal(db.transaction.includes('commit'), false)
  assert.equal(db.released, 1, 'the connection is released even on failure')
})

test('the connection is always released', async () => {
  const bundle = buildOperationalOnlyResult({
    identity: IDENTITY,
    auditedAt: AUDITED_AT,
  })
  const db = fakePool({
    failOn: { match: 'INSERT INTO `kaudit_call_audit_result`', error: new Error('x') },
  })
  const repository = createMysqlCallAuditPersistenceRepository(db.pool)
  await assert.rejects(() => repository.saveResultBundle(bundle))
  assert.equal(db.released, 1)
})

test('provenance columns are bound for the composite foreign key', async () => {
  const bundle = buildContentAuditResult({
    identity: IDENTITY,
    output: modelOutput(),
    auditedAt: AUDITED_AT,
  })
  const db = fakePool()
  const repository = createMysqlCallAuditPersistenceRepository(db.pool)
  await repository.saveResultBundle(bundle)

  const insert = db.find('INSERT INTO `kaudit_call_audit_result`')
  assert.ok(insert)
  assert.equal(insert.parameters[1], IDENTITY.runId)
  assert.equal(insert.parameters[2], IDENTITY.sourceRefId)
  assert.equal(insert.parameters[3], IDENTITY.ruleVersionId)
})

// ---------------------------------------------------------------------------
// Result replay and conflict
// ---------------------------------------------------------------------------

test('replaying an identical result payload and metric set is a no-op', async () => {
  const bundle = buildContentAuditResult({
    identity: IDENTITY,
    output: modelOutput(),
    auditedAt: AUDITED_AT,
  })
  const db = fakePool({
    rows: [
      {
        match: 'FROM `kaudit_call_audit_result`',
        rows: [storedResultRow(bundle.result as unknown as Record<string, unknown>)],
      },
      {
        match: 'FROM `kaudit_call_audit_metric_score`',
        rows: storedMetricRows(bundle),
      },
    ],
  })
  const repository = createMysqlCallAuditPersistenceRepository(db.pool)
  const outcome = await repository.saveResultBundle(bundle)

  assert.equal(outcome.outcome, 'replayed')
  assert.equal(db.all('INSERT INTO `kaudit_call_audit_result`').length, 0)
  assert.equal(db.all('INSERT INTO `kaudit_call_audit_metric_score`').length, 0)
  assert.deepEqual(db.transaction, ['begin', 'rollback'])
  // The metric rows are read inside the same transaction as the result row.
  const metricSelect = db.find('FROM `kaudit_call_audit_metric_score`')
  assert.ok(metricSelect)
  assert.equal(metricSelect.via, 'connection')
  assert.deepEqual(metricSelect.parameters, [bundle.result.id])
})

test('a replayed result whose metric rows differ is a conflict', async () => {
  const bundle = buildContentAuditResult({
    identity: IDENTITY,
    output: modelOutput(),
    auditedAt: AUDITED_AT,
  })
  const stored = storedResultRow(
    bundle.result as unknown as Record<string, unknown>,
  )
  const rows = storedMetricRows(bundle)

  // Missing, extra, duplicated, and differing metric rows are each rejected:
  // an identical result row is not evidence that the bundle is identical.
  for (const [label, metricRows, expectedField] of [
    ['none stored', [], 'row_count'],
    ['one missing', rows.slice(0, 7), 'row_count'],
    ['one extra', [...rows, { ...rows[0], id: 'cam_extra' }], 'row_count'],
    [
      'one duplicated',
      [...rows.slice(0, 7), { ...rows[0] }],
      'metric_code',
    ],
    [
      'a different score',
      [{ ...rows[0], score_value: 1 }, ...rows.slice(1)],
      'score_value',
    ],
    [
      'a different NA flag',
      [{ ...rows[0], score_value: null, is_not_applicable: 1 }, ...rows.slice(1)],
      'score_value',
    ],
    [
      'a different row id',
      [{ ...rows[0], id: 'cam_other' }, ...rows.slice(1)],
      'id',
    ],
  ] as Array<[string, unknown[], string]>) {
    const db = fakePool({
      rows: [
        { match: 'FROM `kaudit_call_audit_result`', rows: [stored] },
        { match: 'FROM `kaudit_call_audit_metric_score`', rows: metricRows },
      ],
    })
    const repository = createMysqlCallAuditPersistenceRepository(db.pool)
    const error = await repository
      .saveResultBundle(bundle)
      .then(() => null)
      .catch((caught: unknown) => caught)

    assert.ok(
      error instanceof CallAuditPersistenceConflictError,
      `${label} was silently replayed`,
    )
    assert.equal(error.entity, 'metricScore')
    assert.equal(error.field, expectedField, label)
    assert.equal(db.all('INSERT INTO').length, 0)
    assert.deepEqual(db.transaction, ['begin', 'rollback'])
  }
})

test('a metric conflict echoes no stored or submitted score', async () => {
  const bundle = buildContentAuditResult({
    identity: IDENTITY,
    output: modelOutput(),
    auditedAt: AUDITED_AT,
  })
  const rows = storedMetricRows(bundle)
  const db = fakePool({
    rows: [
      {
        match: 'FROM `kaudit_call_audit_result`',
        rows: [storedResultRow(bundle.result as unknown as Record<string, unknown>)],
      },
      {
        match: 'FROM `kaudit_call_audit_metric_score`',
        rows: [{ ...rows[0], score_value: 1 }, ...rows.slice(1)],
      },
    ],
  })
  const repository = createMysqlCallAuditPersistenceRepository(db.pool)
  const error = (await repository
    .saveResultBundle(bundle)
    .then(() => null)
    .catch((caught: unknown) => caught)) as CallAuditPersistenceConflictError

  const text = `${error.message}\n${error.stack ?? ''}`
  assert.match(text, /score_value/)
  assert.equal(/\bscore 1\b/.test(text), false)
  assert.equal(text.includes(bundle.metricScores[0].metricCode), false)
})

test('replaying an operational-only or failed result rejects stray metric rows', async () => {
  const content = buildContentAuditResult({
    identity: IDENTITY,
    output: modelOutput(),
    auditedAt: AUDITED_AT,
  })
  const bundles = [
    buildOperationalOnlyResult({ identity: IDENTITY, auditedAt: AUDITED_AT }),
    buildFailedResult({
      identity: IDENTITY,
      eligibility: 'content_auditable',
      errorCode: 'MODEL_TIMEOUT',
    }),
  ]
  for (const bundle of bundles) {
    // A result that owns no metric rows must not silently replay over a
    // metric set some other write left behind.
    const db = fakePool({
      rows: [
        {
          match: 'FROM `kaudit_call_audit_result`',
          rows: [storedResultRow(bundle.result as unknown as Record<string, unknown>)],
        },
        {
          match: 'FROM `kaudit_call_audit_metric_score`',
          rows: storedMetricRows(content),
        },
      ],
    })
    const repository = createMysqlCallAuditPersistenceRepository(db.pool)
    const error = await repository
      .saveResultBundle(bundle)
      .then(() => null)
      .catch((caught: unknown) => caught)

    assert.ok(error instanceof CallAuditPersistenceConflictError)
    assert.equal(error.entity, 'metricScore')
    assert.equal(error.field, 'row_count')
    assert.equal(db.all('INSERT INTO').length, 0)
  }
})

test('replaying an operational-only result with no metric rows is a no-op', async () => {
  const bundle = buildOperationalOnlyResult({
    identity: IDENTITY,
    auditedAt: AUDITED_AT,
  })
  const db = fakePool({
    rows: [
      {
        match: 'FROM `kaudit_call_audit_result`',
        rows: [storedResultRow(bundle.result as unknown as Record<string, unknown>)],
      },
    ],
  })
  const repository = createMysqlCallAuditPersistenceRepository(db.pool)
  const outcome = await repository.saveResultBundle(bundle)

  assert.equal(outcome.outcome, 'replayed')
  assert.equal(db.all('INSERT INTO').length, 0)
})

test('a duplicate-key race on the result insert settles by re-reading', async () => {
  const bundle = buildContentAuditResult({
    identity: IDENTITY,
    output: modelOutput(),
    auditedAt: AUDITED_AT,
  })
  const duplicate = Object.assign(new Error('duplicate entry'), {
    code: 'ER_DUP_ENTRY',
  })
  const db = fakePool({
    failOn: {
      match: 'INSERT INTO `kaudit_call_audit_result`',
      error: duplicate,
    },
    rows: [
      // Invisible to the in-transaction lookup; committed by the concurrent
      // writer by the time the insert fails.
      {
        match: 'FROM `kaudit_call_audit_result`',
        rows: [storedResultRow(bundle.result as unknown as Record<string, unknown>)],
        skip: 1,
      },
      {
        match: 'FROM `kaudit_call_audit_metric_score`',
        rows: storedMetricRows(bundle),
      },
    ],
  })
  const repository = createMysqlCallAuditPersistenceRepository(db.pool)
  const outcome = await repository.saveResultBundle(bundle)

  assert.equal(outcome.outcome, 'replayed')
  assert.deepEqual(db.transaction, ['begin', 'rollback'])
  assert.equal(db.released, 1, 'the racing connection is released once')
  // The winner is re-read outside the rolled-back transaction.
  assert.equal(db.all('FROM `kaudit_call_audit_result`').length, 2)
  assert.equal(db.all('FROM `kaudit_call_audit_result`')[1].via, 'pool')
})

test('a lost race whose winner stored a different bundle is a conflict', async () => {
  const stored = buildContentAuditResult({
    identity: IDENTITY,
    output: modelOutput(),
    auditedAt: AUDITED_AT,
  })
  const incoming = buildContentAuditResult({
    identity: IDENTITY,
    output: modelOutput({ metricScores: scores(3) }),
    auditedAt: AUDITED_AT,
  })
  const duplicate = Object.assign(new Error('duplicate entry'), {
    code: 'ER_DUP_ENTRY',
  })
  const db = fakePool({
    failOn: {
      match: 'INSERT INTO `kaudit_call_audit_result`',
      error: duplicate,
    },
    rows: [
      {
        match: 'FROM `kaudit_call_audit_result`',
        rows: [storedResultRow(stored.result as unknown as Record<string, unknown>)],
        skip: 1,
      },
      {
        match: 'FROM `kaudit_call_audit_metric_score`',
        rows: storedMetricRows(stored),
      },
    ],
  })
  const repository = createMysqlCallAuditPersistenceRepository(db.pool)
  await assert.rejects(
    () => repository.saveResultBundle(incoming),
    (error: unknown) => {
      assert.ok(error instanceof CallAuditPersistenceConflictError)
      assert.equal(error.entity, 'result')
      return true
    },
  )
  assert.equal(db.released, 1)
})

test('a non-duplicate insert failure is never swallowed as a replay', async () => {
  const bundle = buildContentAuditResult({
    identity: IDENTITY,
    output: modelOutput(),
    auditedAt: AUDITED_AT,
  })
  const failure = new Error('connection reset')
  const db = fakePool({
    failOn: { match: 'INSERT INTO `kaudit_call_audit_result`', error: failure },
    rows: [
      {
        match: 'FROM `kaudit_call_audit_result`',
        rows: [storedResultRow(bundle.result as unknown as Record<string, unknown>)],
        skip: 1,
      },
    ],
  })
  const repository = createMysqlCallAuditPersistenceRepository(db.pool)
  await assert.rejects(() => repository.saveResultBundle(bundle), failure)
})

test('the same key with a different result document is a conflict', async () => {
  const stored = buildContentAuditResult({
    identity: IDENTITY,
    output: modelOutput(),
    auditedAt: AUDITED_AT,
  })
  const incoming = buildContentAuditResult({
    identity: IDENTITY,
    output: modelOutput({ metricScores: scores(3) }),
    auditedAt: AUDITED_AT,
  })
  assert.equal(stored.result.idempotencyKey, incoming.result.idempotencyKey)
  assert.notEqual(stored.result.resultSha256, incoming.result.resultSha256)

  const db = fakePool({
    rows: [
      {
        match: 'FROM `kaudit_call_audit_result`',
        rows: [storedResultRow(stored.result as unknown as Record<string, unknown>)],
      },
    ],
  })
  const repository = createMysqlCallAuditPersistenceRepository(db.pool)
  await assert.rejects(
    () => repository.saveResultBundle(incoming),
    (error: unknown) => {
      assert.ok(error instanceof CallAuditPersistenceConflictError)
      assert.equal(error.entity, 'result')
      return true
    },
  )
  assert.equal(db.all('INSERT INTO').length, 0)
  assert.deepEqual(db.transaction, ['begin', 'rollback'])
})

test('a terminal row is never updated, only rejected', async () => {
  const stored = buildContentAuditResult({
    identity: IDENTITY,
    output: modelOutput(),
    auditedAt: AUDITED_AT,
  })
  // Same deterministic key, different terminal payload.
  const incoming = buildFailedResult({
    identity: IDENTITY,
    eligibility: 'content_auditable',
    errorCode: 'MODEL_TIMEOUT',
  })
  const db = fakePool({
    rows: [
      {
        match: 'FROM `kaudit_call_audit_result`',
        rows: [storedResultRow(stored.result as unknown as Record<string, unknown>)],
      },
    ],
  })
  const repository = createMysqlCallAuditPersistenceRepository(db.pool)
  const error = await repository
    .saveResultBundle(incoming)
    .then(() => null)
    .catch((caught: unknown) => caught)

  assert.ok(error instanceof CallAuditPersistenceConflictError)
  assert.equal(error.entity, 'result')
  assert.equal(error.field, 'processing_status')
  assert.equal(
    db.statements().some((sql) => /^\s*UPDATE/i.test(sql)),
    false,
    'a terminal row must never be updated',
  )
})

test('a conflict names the field but echoes no stored or submitted value', async () => {
  const stored = buildContentAuditResult({
    identity: IDENTITY,
    output: modelOutput(),
    auditedAt: AUDITED_AT,
  })
  const incoming = buildContentAuditResult({
    identity: IDENTITY,
    output: modelOutput({
      managementSummary: 'A different sanitized management note.',
    }),
    auditedAt: AUDITED_AT,
  })
  const db = fakePool({
    rows: [
      {
        match: 'FROM `kaudit_call_audit_result`',
        rows: [storedResultRow(stored.result as unknown as Record<string, unknown>)],
      },
    ],
  })
  const repository = createMysqlCallAuditPersistenceRepository(db.pool)
  const error = (await repository
    .saveResultBundle(incoming)
    .then(() => null)
    .catch((caught: unknown) => caught)) as CallAuditPersistenceConflictError

  assert.ok(error instanceof CallAuditPersistenceConflictError)
  const text = `${error.message}\n${error.stack ?? ''}`
  assert.equal(text.includes('A different sanitized management note.'), false)
  assert.equal(text.includes('Caller asked about a resort stay.'), false)
  assert.equal(text.includes(stored.result.resultSha256 as string), false)
})

// ---------------------------------------------------------------------------
// Operational-only and failed results
// ---------------------------------------------------------------------------

test('an operational-only result inserts no metric rows', async () => {
  const bundle = buildOperationalOnlyResult({
    identity: IDENTITY,
    auditedAt: AUDITED_AT,
  })
  const db = fakePool()
  const repository = createMysqlCallAuditPersistenceRepository(db.pool)
  const outcome = await repository.saveResultBundle(bundle)

  assert.equal(outcome.outcome, 'inserted')
  assert.equal(db.all('INSERT INTO `kaudit_call_audit_metric_score`').length, 0)
  const insert = db.find('INSERT INTO `kaudit_call_audit_result`')
  assert.ok(insert)
  // eligibility, ineligibility_reason, and the null audit facts.
  assert.equal(insert.parameters[5], 'operational_only')
  assert.equal(insert.parameters[6], 'missing_transcript')
  assert.equal(insert.parameters[7], null, 'call_connected stays null')
  assert.equal(insert.parameters[16], null, 'overall_score stays null')
  assert.equal(insert.parameters[17], null, 'overall_score_method stays null')
})

test('a failed result inserts no metric rows and no error prose', async () => {
  const bundle = buildFailedResult({
    identity: IDENTITY,
    eligibility: 'content_auditable',
    errorCode: 'MODEL_TIMEOUT',
  })
  const db = fakePool()
  const repository = createMysqlCallAuditPersistenceRepository(db.pool)
  const outcome = await repository.saveResultBundle(bundle)

  assert.equal(outcome.outcome, 'inserted')
  assert.equal(db.all('INSERT INTO `kaudit_call_audit_metric_score`').length, 0)
  const insert = db.find('INSERT INTO `kaudit_call_audit_result`')
  assert.ok(insert)
  assert.equal(insert.parameters[4], 'failed')
  assert.equal(insert.parameters[25], null, 'result_json stays null')
  assert.equal(insert.parameters[26], null, 'result_sha256 stays null')
  assert.equal(insert.parameters[27], 'MODEL_TIMEOUT')
  assert.equal(insert.parameters[28], null, 'error_detail is always null')
  assert.equal(insert.parameters[30], null, 'audited_at is null when failed')
})

test('a malformed bundle is rejected before any write', async () => {
  const bundle = buildContentAuditResult({
    identity: IDENTITY,
    output: modelOutput(),
    auditedAt: AUDITED_AT,
  })
  const db = fakePool()
  const repository = createMysqlCallAuditPersistenceRepository(db.pool)

  for (const broken of [
    { ...bundle, metricScores: bundle.metricScores.slice(0, 7) },
    { ...bundle, metricScores: [] },
    {
      ...bundle,
      metricScores: [
        ...bundle.metricScores.slice(0, 7),
        { ...bundle.metricScores[0] },
      ],
    },
  ]) {
    await assert.rejects(
      () => repository.saveResultBundle(broken),
      CallAuditPersistenceError,
    )
  }
  // An operational-only bundle carrying metric rows is equally malformed.
  const operational = buildOperationalOnlyResult({
    identity: IDENTITY,
    auditedAt: AUDITED_AT,
  })
  await assert.rejects(
    () =>
      repository.saveResultBundle({
        ...operational,
        metricScores: bundle.metricScores,
      }),
    CallAuditPersistenceError,
  )
  assert.equal(db.calls.length, 0, 'nothing may reach the database')
})

// ---------------------------------------------------------------------------
// Usage attempts
// ---------------------------------------------------------------------------

test('a usage attempt is recorded independently of any result transaction', async () => {
  const record = buildUsageEventRecord({
    ...USAGE_BASE,
    inputTokens: '1200',
    outputTokens: '340',
    totalTokens: '1540',
    requestId: 'req-abc',
    latencyMs: 812,
  })
  const db = fakePool()
  const repository = createMysqlCallAuditPersistenceRepository(db.pool)
  const outcome = await repository.recordUsageAttempt(record)

  assert.equal(outcome.outcome, 'inserted')
  // No transaction is opened for a single-row append.
  assert.deepEqual(db.transaction, [])
  const insert = db.find('INSERT INTO `kaudit_call_audit_usage_event`')
  assert.ok(insert)
  assert.equal(insert.parameters[1], record.resultId)
  assert.equal(insert.parameters[2], record.runId)
  assert.equal(insert.parameters[3], record.ruleVersionId)
  assert.equal(insert.parameters[4], 1)
})

test('refused and failed attempts are recorded with their safe code', async () => {
  for (const outcome of ['refused', 'failed'] as const) {
    const record = buildUsageEventRecord({
      ...USAGE_BASE,
      attemptNumber: 2,
      attemptOutcome: outcome,
      errorCode: 'PROVIDER_REFUSAL',
    })
    const db = fakePool()
    const repository = createMysqlCallAuditPersistenceRepository(db.pool)
    await repository.recordUsageAttempt(record)
    const insert = db.find('INSERT INTO `kaudit_call_audit_usage_event`')
    assert.ok(insert)
    assert.equal(insert.parameters[5], outcome)
    assert.equal(insert.parameters[14], 'PROVIDER_REFUSAL')
  }
})

test('null provider counts are preserved, never coerced to zero', async () => {
  const record = buildUsageEventRecord(USAGE_BASE)
  const db = fakePool()
  const repository = createMysqlCallAuditPersistenceRepository(db.pool)
  await repository.recordUsageAttempt(record)

  const insert = db.find('INSERT INTO `kaudit_call_audit_usage_event`')
  assert.ok(insert)
  for (const index of [9, 10, 11, 12, 13]) {
    assert.equal(insert.parameters[index], null)
    assert.notEqual(insert.parameters[index], 0)
  }
})

test('a large BIGINT token count is bound as an exact string', async () => {
  const record = buildUsageEventRecord({
    ...USAGE_BASE,
    inputTokens: '9007199254740993',
    outputTokens: '9223372036854775807',
  })
  const db = fakePool()
  const repository = createMysqlCallAuditPersistenceRepository(db.pool)
  await repository.recordUsageAttempt(record)

  const insert = db.find('INSERT INTO `kaudit_call_audit_usage_event`')
  assert.equal(insert?.parameters[9], '9007199254740993')
  assert.equal(typeof insert?.parameters[9], 'string')
  assert.equal(insert?.parameters[10], '9223372036854775807')
  // Read back as CHAR so a comparison never rounds either.
  assert.match(
    CALL_AUDIT_PERSISTENCE_SQL.selectUsage,
    /CAST\(`input_tokens` AS CHAR\)/,
  )
})

test('replaying an identical usage attempt is a no-op', async () => {
  const record = buildUsageEventRecord({ ...USAGE_BASE, inputTokens: '10' })
  const db = fakePool({
    rows: [
      {
        match: 'FROM `kaudit_call_audit_usage_event`',
        rows: [storedUsageRow(record as unknown as Record<string, unknown>)],
      },
    ],
  })
  const repository = createMysqlCallAuditPersistenceRepository(db.pool)
  const outcome = await repository.recordUsageAttempt(record)

  assert.equal(outcome.outcome, 'replayed')
  assert.equal(db.all('INSERT INTO `kaudit_call_audit_usage_event`').length, 0)
})

test('the same attempt key with a different payload is a conflict', async () => {
  const stored = buildUsageEventRecord({ ...USAGE_BASE, inputTokens: '10' })
  const incoming = buildUsageEventRecord({ ...USAGE_BASE, inputTokens: '20' })
  assert.equal(stored.id, incoming.id)
  assert.equal(stored.attemptNumber, incoming.attemptNumber)

  const db = fakePool({
    rows: [
      {
        match: 'FROM `kaudit_call_audit_usage_event`',
        rows: [storedUsageRow(stored as unknown as Record<string, unknown>)],
      },
    ],
  })
  const repository = createMysqlCallAuditPersistenceRepository(db.pool)
  await assert.rejects(
    () => repository.recordUsageAttempt(incoming),
    (error: unknown) => {
      assert.ok(error instanceof CallAuditPersistenceConflictError)
      assert.equal(error.entity, 'usageEvent')
      assert.equal(error.field, 'input_tokens')
      return true
    },
  )
  assert.equal(db.all('INSERT INTO `kaudit_call_audit_usage_event`').length, 0)
})

test('attempts 1, 2, and 3 are independent rows', async () => {
  const ids = new Set<string>()
  for (const attemptNumber of [1, 2, 3]) {
    const record = buildUsageEventRecord({
      ...USAGE_BASE,
      attemptNumber,
      attemptOutcome: attemptNumber === 3 ? 'succeeded' : 'failed',
      errorCode: attemptNumber === 3 ? null : 'MODEL_TIMEOUT',
    })
    const db = fakePool()
    const repository = createMysqlCallAuditPersistenceRepository(db.pool)
    const outcome = await repository.recordUsageAttempt(record)
    assert.equal(outcome.outcome, 'inserted')

    const insert = db.find('INSERT INTO `kaudit_call_audit_usage_event`')
    assert.ok(insert)
    assert.equal(insert.parameters[4], attemptNumber)
    ids.add(insert.parameters[0] as string)
    // Each attempt is looked up by its own (result_id, attempt_number).
    assert.deepEqual(db.find('FROM `kaudit_call_audit_usage_event`')?.parameters, [
      record.resultId,
      attemptNumber,
    ])
  }
  assert.equal(ids.size, 3, 'each attempt gets its own deterministic id')
})

test('a usage attempt after a terminal result is still recorded', async () => {
  // Terminality gates the RESULT row, never the attempt ledger.
  const record = buildUsageEventRecord({
    ...USAGE_BASE,
    attemptNumber: 4,
    attemptOutcome: 'failed',
    errorCode: 'MODEL_TIMEOUT',
  })
  const db = fakePool()
  const repository = createMysqlCallAuditPersistenceRepository(db.pool)
  const outcome = await repository.recordUsageAttempt(record)
  assert.equal(outcome.outcome, 'inserted')
  assert.ok(db.find('INSERT INTO `kaudit_call_audit_usage_event`'))
})

// ---------------------------------------------------------------------------
// Privacy of everything bound
// ---------------------------------------------------------------------------

test('no bound parameter carries a transcript, lead ID, or PII', async () => {
  const reference = sourceReference()
  const bundle = buildContentAuditResult({
    identity: IDENTITY,
    output: modelOutput(),
    auditedAt: AUDITED_AT,
  })
  const usage = buildUsageEventRecord({ ...USAGE_BASE, inputTokens: '10' })

  const db = fakePool()
  const repository = createMysqlCallAuditPersistenceRepository(db.pool)
  await repository.upsertSourceReference(reference)
  await repository.saveResultBundle(bundle)
  await repository.recordUsageAttempt(usage)

  const bound = db.calls
    .flatMap((call) => call.parameters)
    .filter((value): value is string => typeof value === 'string')
    .join('\n')

  for (const forbidden of [
    'Saanvi',
    'Caller:',
    'tell me about the package',
    'LEAD-2026-000123',
    '9876543210',
    '@example',
    'http://',
    'https://',
  ]) {
    assert.equal(
      bound.includes(forbidden),
      false,
      `a bound parameter leaked ${forbidden}`,
    )
  }
  // The derived Task ID and hashes are what represent the source instead.
  assert.ok(bound.includes(reference.taskId as string))
  assert.ok(bound.includes(reference.leadIdSha256 as string))
})

test('the fixtures themselves contain no real customer data', () => {
  const source = readFileSync(
    new URL('./mysqlCallAuditPersistence.test.ts', import.meta.url),
    'utf8',
  )
  // Synthetic markers only; nothing resembling a real contact detail.
  assert.equal(/\+91\d{10}/.test(source), false)
  assert.equal(/@(gmail|yahoo|hotmail|outlook)\./i.test(source), false)
  assert.ok(source.includes('Synthetic fixtures'))
})
