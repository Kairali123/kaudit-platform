import type { Pool, PoolConnection, RowDataPacket } from 'mysql2/promise'
import { canonicalJsonSha256 } from '../messaging/canonicalJson.ts'
import {
  SOURCE_CATEGORICAL_FIELDS,
  type CallAuditSourceReference,
} from '../callaudit/sourceTypes.ts'
import { CALL_AUDIT_RUBRIC } from '../callaudit/rubric.ts'
import type {
  CallAuditMetricScoreRecord,
  CallAuditResultBundle,
  CallAuditResultRecord,
  CallAuditUsageEventRecord,
} from '../callaudit/resultRecords.ts'
import {
  CALL_AUDIT_SPEND_SKIP_CODES,
  type CallAuditSpendClaimPort,
  type CallAuditSpendClaimResult,
  type ContentAuditSpendClaimInput,
} from '../callaudit/spendClaim.ts'

/**
 * MySQL persistence for Call Audit source references, results, metric rows, and
 * AI usage attempts.
 *
 * Scope: writes only. No worker lifecycle, no API, no model call, no schedule.
 *
 * Contracts carried through from the pure layer:
 *   * source references are APPEND-ONLY and revision-aware — an unchanged
 *     revision is reused, a changed revision becomes a new row;
 *   * a result is deterministic by (runId, sourceRefId, ruleVersionId) and a
 *     terminal row is IMMUTABLE: replaying an identical payload is a no-op,
 *     and the same key with a different payload is a typed conflict;
 *   * a succeeded content result carries exactly the eight rubric metric rows,
 *     written in the same transaction as the result;
 *   * a usage attempt is recorded per attempt, independently and idempotently,
 *     including refusals and failures and including after the result is
 *     terminal.
 *
 * Nothing here ever touches `ai_voice_leads_received`: no SELECT, INSERT,
 * UPDATE, DELETE, LOCK, or foreign key. It is read by the separate read-only
 * source adapter and never by this writer.
 *
 * Privacy: only the already-privacy-safe record fields are written. No
 * transcript, lead ID, PII, URL, prompt, raw model response, refusal or
 * provider prose, or money value reaches a column here — `error_detail` is
 * always NULL by construction.
 */

export class CallAuditPersistenceError extends Error {
  readonly code = 'CALL_AUDIT_PERSISTENCE_ERROR'
  readonly entity: string

  constructor(entity: string, reason: string) {
    super(`${entity}: ${reason}`)
    this.entity = entity
  }
}

/**
 * A row already exists for the same deterministic key with a different safe
 * payload. The message names the entity and the differing FIELD only — never a
 * stored or submitted value, so a conflict can be logged safely.
 */
export class CallAuditPersistenceConflictError extends Error {
  readonly code = 'CALL_AUDIT_PERSISTENCE_CONFLICT'
  readonly entity: string
  readonly field: string

  constructor(entity: string, field: string) {
    super(
      `${entity}: an existing row has a different value for ${field}; ` +
        'a deterministic key may never be reused for a different payload',
    )
    this.entity = entity
    this.field = field
  }
}

export type PersistOutcome = 'inserted' | 'reused' | 'replayed'

/** MySQL duplicate-key error, raised when a concurrent writer won the race. */
const DUPLICATE_ENTRY = 'ER_DUP_ENTRY'

function isDuplicateEntry(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: string }).code === DUPLICATE_ENTRY
  )
}

// ---------------------------------------------------------------------------
// Deterministic source-reference id
// ---------------------------------------------------------------------------

const SOURCE_REF_ID_PREFIX = 'cas_'
const ID_HASH_LENGTH = 36

/**
 * Deterministic varchar(40) id for a source reference, derived ONLY from the
 * append-only revision tuple — never from a lead ID, Task ID, or transcript.
 * The same revision therefore always replays to the same row id, so a retried
 * import cannot create a duplicate.
 */
export function buildSourceRefId(reference: CallAuditSourceReference): string {
  const digest = canonicalJsonSha256({
    sourceTable: reference.sourceTable,
    sourceRowId: reference.sourceRowId,
    sourceRevisionSha256: reference.sourceRevisionSha256,
  })
  return `${SOURCE_REF_ID_PREFIX}${digest.slice(0, ID_HASH_LENGTH)}`
}

// ---------------------------------------------------------------------------
// Value coercion
// ---------------------------------------------------------------------------

/** MySQL has no boolean; tinyint(1) takes 0/1. NULL stays NULL. */
/** Every value bound to a placeholder is one of these primitives. */
type SqlValue = string | number | null

function toTinyint(value: boolean | null): 0 | 1 | null {
  if (value === null) return null
  return value ? 1 : 0
}

function fromTinyint(value: unknown): boolean | null {
  if (value === null || value === undefined) return null
  return Number(value) === 1
}

/**
 * MySQL renders DATETIME(6) with six fractional digits, while a domain
 * timestamp may omit them. Both sides are padded so a comparison never fails on
 * formatting alone. No timezone conversion happens: these are UTC-naive
 * literals on both sides.
 */
function normalizeDatetime(value: unknown): string | null {
  if (value === null || value === undefined) return null
  const text = String(value)
  const match = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?/.exec(
    text,
  )
  if (!match) return text
  return `${match[1]} ${match[2]}.${(match[3] ?? '').padEnd(6, '0')}`
}

/** BIGINT columns are read back as CHAR, so a large value never rounds. */
function textOrNull(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value)
}

function numberOrNull(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value)
}

// ---------------------------------------------------------------------------
// Source reference
// ---------------------------------------------------------------------------

const SOURCE_REF_COLUMNS = [
  'id',
  'source_table',
  'source_row_id',
  'source_revision_sha256',
  'task_id',
  'lead_id_sha256',
  'transcript_sha256',
  'has_transcript',
  'effective_call_at',
  'source_updated_at',
  'call_started_at',
  'call_ended_at',
  'call_duration_seconds',
  'company_by_kserve',
  'company',
  'data_source',
  'verified_source',
  'service_category',
  'call_type',
  'call_status',
  'call_end_reason',
  'final_call_status',
  'ai_call_category',
  'customer_engagement_level',
  'interest_level',
  'call_outcome',
  'lead_status',
  'final_lead_outcome',
  'calculated_qualification_status',
  'followup_required',
  'source_ref_idempotency_key',
] as const

const INSERT_SOURCE_REF_SQL = `INSERT INTO \`kaudit_call_audit_source_ref\`
     (${SOURCE_REF_COLUMNS.map((column) => `\`${column}\``).join(', ')})
   VALUES (${SOURCE_REF_COLUMNS.map(() => '?').join(', ')})`

/**
 * Columns read back as CHAR: the BIGINT so mysql2 cannot round a large source
 * row id, and the DATETIME(6) columns so a driver Date object never stands in
 * for the UTC-naive literal that was written.
 */
const SOURCE_REF_CHAR_COLUMNS = new Set<string>([
  'source_row_id',
  'effective_call_at',
  'source_updated_at',
  'call_started_at',
  'call_ended_at',
])

function readSourceRefColumn(column: string): string {
  return SOURCE_REF_CHAR_COLUMNS.has(column)
    ? `CAST(\`${column}\` AS CHAR) AS \`${column}\``
    : `\`${column}\``
}

/**
 * Selects EVERY inserted column — the whole privacy-safe payload, not just the
 * revision tuple — so a replayed idempotency key whose stored row differs in any
 * persisted field is a conflict rather than a silent reuse. `created_at` is
 * excluded deliberately: it is database-generated and is not part of the
 * submitted payload.
 */
const SELECT_SOURCE_REF_SQL = `SELECT ${SOURCE_REF_COLUMNS.map(
  readSourceRefColumn,
).join(',\n          ')}
   FROM \`kaudit_call_audit_source_ref\`
   WHERE \`source_ref_idempotency_key\` = ?`

interface SourceRefRow extends RowDataPacket {
  [column: string]: unknown
}

function sourceRefValues(reference: CallAuditSourceReference): SqlValue[] {
  return [
    buildSourceRefId(reference),
    reference.sourceTable,
    // Kept as the exact decimal STRING: a JS number cannot hold every BIGINT.
    reference.sourceRowId,
    reference.sourceRevisionSha256,
    reference.taskId,
    reference.leadIdSha256,
    reference.transcriptSha256,
    toTinyint(reference.hasTranscript),
    reference.effectiveCallTime,
    reference.sourceUpdatedAt,
    reference.callStartedAt,
    reference.callEndedAt,
    reference.callDurationSeconds,
    reference.company_by_kserve,
    reference.company,
    reference.data_source,
    reference.verified_source,
    reference.service_category,
    reference.call_type,
    reference.call_status,
    reference.call_end_reason,
    reference.final_call_status,
    reference.ai_call_category,
    reference.customer_engagement_level,
    reference.interest_level,
    reference.call_outcome,
    reference.lead_status,
    reference.final_lead_outcome,
    reference.calculated_qualification_status,
    reference.followup_required,
    reference.sourceRefIdempotencyKey,
  ]
}

/**
 * Returns the first column whose stored value differs from the incoming
 * privacy-safe payload, or null when the row is a faithful reuse.
 *
 * The revision tuple is compared FIRST because the idempotency key is derived
 * from it, so a mismatch there is the most direct statement of what went wrong.
 * Every other persisted column is then compared too: the same key and the same
 * revision identity carrying a different snapshot — a different Task ID,
 * transcript presence, or call timestamp — is still a reused deterministic key
 * and must not be accepted as an unchanged revision.
 */
function sourceRefConflictField(
  existing: SourceRefRow,
  reference: CallAuditSourceReference,
): string | null {
  const text: Array<[string, SqlValue]> = [
    ['source_table', reference.sourceTable],
    ['source_row_id', reference.sourceRowId],
    ['source_revision_sha256', reference.sourceRevisionSha256],
    ['id', buildSourceRefId(reference)],
    ['task_id', reference.taskId],
    ['lead_id_sha256', reference.leadIdSha256],
    ['transcript_sha256', reference.transcriptSha256],
    ['source_ref_idempotency_key', reference.sourceRefIdempotencyKey],
    // Driven by the shared field list so a new categorical column cannot be
    // inserted but left out of the replay check.
    ...SOURCE_CATEGORICAL_FIELDS.map(
      (field): [string, SqlValue] => [field, reference[field]],
    ),
  ]
  for (const [column, value] of text) {
    if (textOrNull(existing[column]) !== textOrNull(value)) {
      return column
    }
  }
  if (fromTinyint(existing.has_transcript) !== reference.hasTranscript) {
    return 'has_transcript'
  }
  if (
    numberOrNull(existing.call_duration_seconds) !==
    reference.callDurationSeconds
  ) {
    return 'call_duration_seconds'
  }
  for (const [column, value] of [
    ['effective_call_at', reference.effectiveCallTime],
    ['source_updated_at', reference.sourceUpdatedAt],
    ['call_started_at', reference.callStartedAt],
    ['call_ended_at', reference.callEndedAt],
  ] as Array<[string, string | null]>) {
    if (normalizeDatetime(existing[column]) !== normalizeDatetime(value)) {
      return column
    }
  }
  return null
}

function assertSourceRefMatches(
  existing: SourceRefRow,
  reference: CallAuditSourceReference,
): void {
  const field = sourceRefConflictField(existing, reference)
  if (field) {
    throw new CallAuditPersistenceConflictError('sourceRef', field)
  }
}

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

const RESULT_COLUMNS = [
  'id',
  'run_id',
  'source_ref_id',
  'rule_version_id',
  'processing_status',
  'eligibility',
  'ineligibility_reason',
  'call_connected',
  'customer_spoke',
  'meaningful_conversation',
  'intent',
  'intent_confidence',
  'detailed_outcome',
  'grouped_outcome',
  'qualification_label',
  'next_action_code',
  'overall_score',
  'overall_score_method',
  'kserve_reported_outcome',
  'kserve_comparison_label',
  'mismatch_severity',
  'management_feedback',
  'kserve_feedback',
  'improvement_feedback',
  'issue_flags_json',
  'result_json',
  'result_sha256',
  'error_code',
  'error_detail',
  'idempotency_key',
  'audited_at',
] as const

const INSERT_RESULT_SQL = `INSERT INTO \`kaudit_call_audit_result\`
     (${RESULT_COLUMNS.map((column) => `\`${column}\``).join(', ')})
   VALUES (${RESULT_COLUMNS.map(() => '?').join(', ')})`

const SELECT_RESULT_SQL = `SELECT \`id\`,
          \`run_id\`,
          \`source_ref_id\`,
          \`rule_version_id\`,
          \`processing_status\`,
          \`eligibility\`,
          \`ineligibility_reason\`,
          \`call_connected\`,
          \`customer_spoke\`,
          \`meaningful_conversation\`,
          \`intent\`,
          \`intent_confidence\`,
          \`detailed_outcome\`,
          \`grouped_outcome\`,
          \`qualification_label\`,
          \`next_action_code\`,
          \`overall_score\`,
          \`overall_score_method\`,
          \`kserve_reported_outcome\`,
          \`kserve_comparison_label\`,
          \`mismatch_severity\`,
          \`management_feedback\`,
          \`kserve_feedback\`,
          \`improvement_feedback\`,
          \`issue_flags_json\`,
          \`result_json\`,
          \`result_sha256\`,
          \`error_code\`,
          \`error_detail\`,
          CAST(\`audited_at\` AS CHAR) AS \`audited_at\`
   FROM \`kaudit_call_audit_result\`
   WHERE \`idempotency_key\` = ?`

interface ResultRow extends RowDataPacket {
  [column: string]: unknown
}

function resultValues(record: CallAuditResultRecord): SqlValue[] {
  return [
    record.id,
    record.runId,
    record.sourceRefId,
    record.ruleVersionId,
    record.processingStatus,
    record.eligibility,
    record.ineligibilityReason,
    toTinyint(record.callConnected),
    toTinyint(record.customerSpoke),
    toTinyint(record.meaningfulConversation),
    record.intent,
    record.intentConfidence,
    record.detailedOutcome,
    record.groupedOutcome,
    record.qualificationLabel,
    record.nextActionCode,
    record.overallScore,
    record.overallScoreMethod,
    record.kserveReportedOutcome,
    record.kserveComparisonLabel,
    record.mismatchSeverity,
    record.managementFeedback,
    record.kserveFeedback,
    record.improvementFeedback,
    record.issueFlagsJson,
    record.resultJson,
    record.resultSha256,
    record.errorCode,
    // Always NULL: provider prose is never persisted.
    record.errorDetail,
    record.idempotencyKey,
    record.auditedAt,
  ]
}

/**
 * Returns the first column whose stored value differs from the incoming safe
 * payload, or null when the row is a faithful replay. Booleans, BIGINT-free
 * decimals, and datetimes are normalized on both sides first.
 */
function resultConflictField(
  existing: ResultRow,
  record: CallAuditResultRecord,
): string | null {
  const expected: Array<[string, SqlValue]> = [
    ['id', record.id],
    ['run_id', record.runId],
    ['source_ref_id', record.sourceRefId],
    ['rule_version_id', record.ruleVersionId],
    ['processing_status', record.processingStatus],
    ['eligibility', record.eligibility],
    ['ineligibility_reason', record.ineligibilityReason],
    ['intent', record.intent],
    ['intent_confidence', record.intentConfidence],
    ['detailed_outcome', record.detailedOutcome],
    ['grouped_outcome', record.groupedOutcome],
    ['qualification_label', record.qualificationLabel],
    ['next_action_code', record.nextActionCode],
    ['overall_score', record.overallScore],
    ['overall_score_method', record.overallScoreMethod],
    ['kserve_reported_outcome', record.kserveReportedOutcome],
    ['kserve_comparison_label', record.kserveComparisonLabel],
    ['mismatch_severity', record.mismatchSeverity],
    ['management_feedback', record.managementFeedback],
    ['kserve_feedback', record.kserveFeedback],
    ['improvement_feedback', record.improvementFeedback],
    ['issue_flags_json', record.issueFlagsJson],
    ['result_json', record.resultJson],
    ['result_sha256', record.resultSha256],
    ['error_code', record.errorCode],
    ['error_detail', record.errorDetail],
  ]
  for (const [column, value] of expected) {
    if (textOrNull(existing[column]) !== textOrNull(value)) {
      return column
    }
  }
  for (const [column, value] of [
    ['call_connected', record.callConnected],
    ['customer_spoke', record.customerSpoke],
    ['meaningful_conversation', record.meaningfulConversation],
  ] as Array<[string, boolean | null]>) {
    if (fromTinyint(existing[column]) !== value) {
      return column
    }
  }
  if (
    normalizeDatetime(existing.audited_at) !==
    normalizeDatetime(record.auditedAt)
  ) {
    return 'audited_at'
  }
  return null
}

// ---------------------------------------------------------------------------
// Metric scores
// ---------------------------------------------------------------------------

const METRIC_COLUMNS = [
  'id',
  'result_id',
  'metric_code',
  'score_value',
  'is_not_applicable',
] as const

/**
 * A fixed eight-row multi-value INSERT. The placeholder count comes from the
 * approved rubric length, never from caller input, and the bundle is validated
 * to exactly that shape before any write.
 */
const INSERT_METRIC_SCORES_SQL = `INSERT INTO \`kaudit_call_audit_metric_score\`
     (${METRIC_COLUMNS.map((column) => `\`${column}\``).join(', ')})
   VALUES ${CALL_AUDIT_RUBRIC.map(
     () => `(${METRIC_COLUMNS.map(() => '?').join(', ')})`,
   ).join(', ')}`

/**
 * Reads back the metric rows already stored for a result, so a result replay
 * can prove the WHOLE bundle matches and not just its result row.
 */
const SELECT_METRIC_SCORES_SQL = `SELECT ${METRIC_COLUMNS.map(
  (column) => `\`${column}\``,
).join(', ')}
   FROM \`kaudit_call_audit_metric_score\`
   WHERE \`result_id\` = ?`

interface MetricScoreRow extends RowDataPacket {
  [column: string]: unknown
}

/**
 * Returns the first field on which the stored metric rows differ from the
 * incoming bundle, or null when they match exactly.
 *
 * Rows are matched by metric code rather than by position, because SQL returns
 * no order without an ORDER BY. A missing, extra, or duplicated row is as much
 * a conflict as a differing score: a succeeded content result owns exactly the
 * eight rubric rows, and every other result owns none, so a replay that would
 * leave a different metric set behind is rejected instead of reported as a
 * faithful no-op. Only column names are ever returned — never a stored or
 * submitted score.
 */
function metricScoresConflictField(
  existing: readonly MetricScoreRow[],
  records: readonly CallAuditMetricScoreRecord[],
): string | null {
  if (existing.length !== records.length) {
    return 'row_count'
  }
  const byCode = new Map<string, MetricScoreRow>()
  for (const row of existing) {
    const code = textOrNull(row.metric_code)
    if (code === null || byCode.has(code)) {
      return 'metric_code'
    }
    byCode.set(code, row)
  }
  for (const record of records) {
    const row = byCode.get(record.metricCode)
    if (!row) {
      return 'metric_code'
    }
    if (textOrNull(row.id) !== record.id) {
      return 'id'
    }
    if (textOrNull(row.result_id) !== record.resultId) {
      return 'result_id'
    }
    if (numberOrNull(row.score_value) !== record.scoreValue) {
      return 'score_value'
    }
    if (fromTinyint(row.is_not_applicable) !== record.isNotApplicable) {
      return 'is_not_applicable'
    }
  }
  return null
}

function assertMetricScoresMatch(
  existing: readonly MetricScoreRow[],
  records: readonly CallAuditMetricScoreRecord[],
): void {
  const field = metricScoresConflictField(existing, records)
  if (field) {
    throw new CallAuditPersistenceConflictError('metricScore', field)
  }
}

function metricValues(
  records: readonly CallAuditMetricScoreRecord[],
): SqlValue[] {
  return records.flatMap((record) => [
    record.id,
    record.resultId,
    record.metricCode,
    record.scoreValue,
    toTinyint(record.isNotApplicable),
  ])
}

/**
 * Rejects a malformed bundle BEFORE any write. A succeeded content-auditable
 * result must carry exactly the eight rubric codes, once each; every other
 * result carries none.
 */
function assertBundleShape(bundle: CallAuditResultBundle): void {
  const { result, metricScores } = bundle
  const expectsMetrics =
    result.processingStatus === 'succeeded' &&
    result.eligibility === 'content_auditable'

  if (!expectsMetrics) {
    if (metricScores.length !== 0) {
      throw new CallAuditPersistenceError(
        'resultBundle',
        'only a succeeded content-auditable result may carry metric scores',
      )
    }
    return
  }
  if (metricScores.length !== CALL_AUDIT_RUBRIC.length) {
    throw new CallAuditPersistenceError(
      'resultBundle',
      `a succeeded content result must carry exactly ${CALL_AUDIT_RUBRIC.length} metric scores`,
    )
  }
  const seen = new Set<string>()
  for (const record of metricScores) {
    if (record.resultId !== result.id) {
      throw new CallAuditPersistenceError(
        'resultBundle',
        'every metric score must belong to its own result',
      )
    }
    if (seen.has(record.metricCode)) {
      throw new CallAuditPersistenceError(
        'resultBundle',
        `metric ${record.metricCode} appears more than once`,
      )
    }
    seen.add(record.metricCode)
  }
  for (const metric of CALL_AUDIT_RUBRIC) {
    if (!seen.has(metric.code)) {
      throw new CallAuditPersistenceError(
        'resultBundle',
        `metric ${metric.code} is missing`,
      )
    }
  }
}

// ---------------------------------------------------------------------------
// Usage events
// ---------------------------------------------------------------------------

const USAGE_COLUMNS = [
  'id',
  'result_id',
  'run_id',
  'rule_version_id',
  'attempt_number',
  'attempt_outcome',
  'provider_name',
  'model_name',
  'model_version',
  'input_tokens',
  'output_tokens',
  'total_tokens',
  'request_id',
  'latency_ms',
  'error_code',
  'recorded_at',
] as const

const INSERT_USAGE_SQL = `INSERT INTO \`kaudit_call_audit_usage_event\`
     (${USAGE_COLUMNS.map((column) => `\`${column}\``).join(', ')})
   VALUES (${USAGE_COLUMNS.map(() => '?').join(', ')})`

/** Every BIGINT is read back as CHAR so a large token count never rounds. */
const SELECT_USAGE_SQL = `SELECT \`id\`,
          \`result_id\`,
          \`run_id\`,
          \`rule_version_id\`,
          \`attempt_number\`,
          \`attempt_outcome\`,
          \`provider_name\`,
          \`model_name\`,
          \`model_version\`,
          CAST(\`input_tokens\` AS CHAR) AS \`input_tokens\`,
          CAST(\`output_tokens\` AS CHAR) AS \`output_tokens\`,
          CAST(\`total_tokens\` AS CHAR) AS \`total_tokens\`,
          \`request_id\`,
          CAST(\`latency_ms\` AS CHAR) AS \`latency_ms\`,
          \`error_code\`,
          CAST(\`recorded_at\` AS CHAR) AS \`recorded_at\`
   FROM \`kaudit_call_audit_usage_event\`
   WHERE \`result_id\` = ? AND \`attempt_number\` = ?`

interface UsageRow extends RowDataPacket {
  [column: string]: unknown
}

function usageValues(record: CallAuditUsageEventRecord): SqlValue[] {
  return [
    record.id,
    record.resultId,
    record.runId,
    record.ruleVersionId,
    record.attemptNumber,
    record.attemptOutcome,
    record.providerName,
    record.modelName,
    record.modelVersion,
    // Provider counts stay decimal STRINGS or NULL; never recomputed.
    record.inputTokens,
    record.outputTokens,
    record.totalTokens,
    record.requestId,
    record.latencyMs,
    record.errorCode,
    record.recordedAt,
  ]
}

function usageConflictField(
  existing: UsageRow,
  record: CallAuditUsageEventRecord,
): string | null {
  const expected: Array<[string, SqlValue]> = [
    ['id', record.id],
    ['result_id', record.resultId],
    ['run_id', record.runId],
    ['rule_version_id', record.ruleVersionId],
    ['attempt_outcome', record.attemptOutcome],
    ['provider_name', record.providerName],
    ['model_name', record.modelName],
    ['model_version', record.modelVersion],
    ['input_tokens', record.inputTokens],
    ['output_tokens', record.outputTokens],
    ['total_tokens', record.totalTokens],
    ['request_id', record.requestId],
    ['latency_ms', record.latencyMs],
    ['error_code', record.errorCode],
  ]
  for (const [column, value] of expected) {
    if (textOrNull(existing[column]) !== textOrNull(value)) {
      return column
    }
  }
  if (numberOrNull(existing.attempt_number) !== record.attemptNumber) {
    return 'attempt_number'
  }
  if (
    normalizeDatetime(existing.recorded_at) !==
    normalizeDatetime(record.recordedAt)
  ) {
    return 'recorded_at'
  }
  return null
}

// ---------------------------------------------------------------------------
// Spend claim — cross-run duplicate-spend protection
// ---------------------------------------------------------------------------

/**
 * "Has an EARLIER run already produced a result for this exact revision?"
 *
 * `run_id <> ?` is the whole question: a result written by the asking run is
 * that run's own work, and re-driving the same run is caught a step later by
 * the claim's primary key instead. Served by
 * `idx_call_audit_result_history (source_ref_id, created_at)`, and `LIMIT 1`
 * because existence is all that is being decided — no result payload is read,
 * so nothing content-bearing is loaded to answer a permission question.
 */
const SELECT_PRIOR_RESULT_SQL = `SELECT 1 AS \`prior\`
   FROM \`kaudit_call_audit_result\`
   WHERE \`source_ref_id\` = ? AND \`run_id\` <> ?
   LIMIT 1`

/**
 * The claim itself. There is no ON DUPLICATE KEY UPDATE and no INSERT IGNORE on
 * purpose: this statement must FAIL loudly when a claim already exists, because
 * that failure IS the mutual exclusion. A silent upsert would report success to
 * a run that did not win, and both runs would spend.
 */
const INSERT_SPEND_CLAIM_SQL = `INSERT INTO \`kaudit_call_audit_spend_claim\`
     (\`source_ref_id\`, \`run_id\`, \`rule_version_id\`, \`claimed_at\`)
   VALUES (?, ?, ?, ?)`

interface PriorResultRow extends RowDataPacket {
  [column: string]: unknown
}

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

export interface SourceReferencePersistResult {
  id: string
  outcome: 'inserted' | 'reused'
}

export interface CallAuditPersistenceRepository extends CallAuditSpendClaimPort {
  upsertSourceReference(
    reference: CallAuditSourceReference,
  ): Promise<SourceReferencePersistResult>
  saveResultBundle(
    bundle: CallAuditResultBundle,
  ): Promise<{ outcome: 'inserted' | 'replayed' }>
  recordUsageAttempt(
    record: CallAuditUsageEventRecord,
  ): Promise<{ outcome: 'inserted' | 'replayed' }>
}

export function createMysqlCallAuditPersistenceRepository(
  pool: Pool,
): CallAuditPersistenceRepository {
  async function findSourceRef(
    reference: CallAuditSourceReference,
  ): Promise<SourceRefRow | null> {
    const [rows] = await pool.execute<SourceRefRow[]>(SELECT_SOURCE_REF_SQL, [
      reference.sourceRefIdempotencyKey,
    ])
    return rows[0] ?? null
  }

  async function findResult(idempotencyKey: string): Promise<ResultRow | null> {
    const [rows] = await pool.execute<ResultRow[]>(SELECT_RESULT_SQL, [
      idempotencyKey,
    ])
    return rows[0] ?? null
  }

  async function findMetricScores(
    resultId: string,
  ): Promise<MetricScoreRow[]> {
    const [rows] = await pool.execute<MetricScoreRow[]>(
      SELECT_METRIC_SCORES_SQL,
      [resultId],
    )
    return rows
  }

  /**
   * Opens the transaction, replays or inserts, and lets a duplicate-key error
   * escape so the caller can settle a lost race on a released connection.
   */
  async function writeResultBundle(
    bundle: CallAuditResultBundle,
  ): Promise<{ outcome: 'inserted' | 'replayed' }> {
    const { result, metricScores } = bundle
    const connection: PoolConnection = await pool.getConnection()
    try {
      await connection.beginTransaction()
      const [rows] = await connection.execute<ResultRow[]>(SELECT_RESULT_SQL, [
        result.idempotencyKey,
      ])
      const existing = rows[0]
      if (existing) {
        const field = resultConflictField(existing, result)
        if (field) {
          // Terminal rows are immutable: a differing payload is rejected,
          // never merged over the stored one.
          throw new CallAuditPersistenceConflictError('result', field)
        }
        // The result row alone is not the bundle. A replay is only a no-op
        // when the stored metric rows are the incoming set exactly — including
        // the empty set an operational-only or failed result must own.
        const [metricRows] = await connection.execute<MetricScoreRow[]>(
          SELECT_METRIC_SCORES_SQL,
          [result.id],
        )
        assertMetricScoresMatch(metricRows, metricScores)
        await connection.rollback()
        return { outcome: 'replayed' }
      }

      await connection.execute(INSERT_RESULT_SQL, resultValues(result))
      if (metricScores.length > 0) {
        await connection.execute(
          INSERT_METRIC_SCORES_SQL,
          metricValues(metricScores),
        )
      }
      await connection.commit()
      return { outcome: 'inserted' }
    } catch (error) {
      await connection.rollback()
      throw error
    } finally {
      connection.release()
    }
  }

  return {
    /**
     * Decides, permanently and default-deny, whether this run may call the paid
     * content model for this exact immutable source revision.
     *
     * Two checks, in this order, because they answer different questions:
     *
     *   1. HISTORY — did an earlier run already produce a result for this
     *      revision? This is what catches audits recorded before claims
     *      existed, and it is a read, so it takes no claim: a run that is not
     *      going to spend must not leave a record saying it did.
     *   2. EXCLUSION — insert the claim. The table's primary key is
     *      `source_ref_id` alone, so exactly one INSERT can ever succeed for a
     *      revision. Two runs overlapping in time both reach this line having
     *      seen no prior result; InnoDB then admits one and rejects the other,
     *      which is the only point in this path where the race is actually
     *      decided.
     *
     * A duplicate-key rejection is the answer, not an error: it means another
     * run holds the claim, so this one must not spend. It is deliberately NOT
     * distinguished by holder — knowing who won changes nothing about what this
     * run may do, and re-reading the row to find out would only add a way to
     * get the default wrong.
     *
     * Any other failure propagates. Denying spend on an unknown database fault
     * is the safe direction, and a caller that cannot tell a refusal from an
     * outage would be free to invent permission.
     */
    async claimContentAuditSpend(
      input: ContentAuditSpendClaimInput,
    ): Promise<CallAuditSpendClaimResult> {
      const [prior] = await pool.execute<PriorResultRow[]>(
        SELECT_PRIOR_RESULT_SQL,
        [input.sourceRefId, input.runId],
      )
      if (prior.length > 0) {
        return {
          outcome: 'duplicate',
          skipCode: CALL_AUDIT_SPEND_SKIP_CODES.priorResult,
        }
      }
      try {
        await pool.execute(INSERT_SPEND_CLAIM_SQL, [
          input.sourceRefId,
          input.runId,
          input.ruleVersionId,
          input.claimedAt,
        ])
        return { outcome: 'claimed' }
      } catch (error) {
        if (!isDuplicateEntry(error)) {
          throw error
        }
        return {
          outcome: 'duplicate',
          skipCode: CALL_AUDIT_SPEND_SKIP_CODES.priorClaim,
        }
      }
    },

    /**
     * Reuses the row for an unchanged revision, or appends a new row for a
     * changed one. Never updates: a source reference is immutable once written.
     */
    async upsertSourceReference(reference) {
      const existing = await findSourceRef(reference)
      if (existing) {
        // The assertion above proved `id` equals the derived id, so returning
        // the derived one keeps the type exact without trusting the read-back.
        assertSourceRefMatches(existing, reference)
        return { id: buildSourceRefId(reference), outcome: 'reused' }
      }
      try {
        await pool.execute(INSERT_SOURCE_REF_SQL, sourceRefValues(reference))
        return { id: buildSourceRefId(reference), outcome: 'inserted' }
      } catch (error) {
        if (!isDuplicateEntry(error)) {
          throw error
        }
        // A concurrent writer inserted the same revision first. That is a
        // legitimate reuse provided the stored tuple still agrees.
        const raced = await findSourceRef(reference)
        if (!raced) {
          throw error
        }
        assertSourceRefMatches(raced, reference)
        return { id: buildSourceRefId(reference), outcome: 'reused' }
      }
    },

    /**
     * Writes the result and, for a succeeded content result, all eight metric
     * rows in ONE transaction. Replaying an identical bundle — result row AND
     * metric rows — is a no-op; reusing the key for a different result payload
     * or a different metric set is a conflict. A terminal row is never updated.
     */
    async saveResultBundle(bundle) {
      assertBundleShape(bundle)
      try {
        return await writeResultBundle(bundle)
      } catch (error) {
        if (!isDuplicateEntry(error)) {
          throw error
        }
        // A concurrent writer committed the same deterministic key between the
        // lookup and the insert. That is a legitimate replay only if what they
        // committed is the same bundle, so the whole payload is re-checked on a
        // fresh read rather than assumed.
        const raced = await findResult(bundle.result.idempotencyKey)
        if (!raced) {
          throw error
        }
        const field = resultConflictField(raced, bundle.result)
        if (field) {
          throw new CallAuditPersistenceConflictError('result', field)
        }
        assertMetricScoresMatch(
          await findMetricScores(bundle.result.id),
          bundle.metricScores,
        )
        return { outcome: 'replayed' }
      }
    },

    /**
     * Records one attempt. Independent of the result transaction, so a retry,
     * refusal, or failure is captured even when the result is already terminal.
     */
    async recordUsageAttempt(record) {
      const [rows] = await pool.execute<UsageRow[]>(SELECT_USAGE_SQL, [
        record.resultId,
        record.attemptNumber,
      ])
      const existing = rows[0]
      if (existing) {
        const field = usageConflictField(existing, record)
        if (field) {
          throw new CallAuditPersistenceConflictError('usageEvent', field)
        }
        return { outcome: 'replayed' }
      }
      try {
        await pool.execute(INSERT_USAGE_SQL, usageValues(record))
        return { outcome: 'inserted' }
      } catch (error) {
        if (!isDuplicateEntry(error)) {
          throw error
        }
        const [racedRows] = await pool.execute<UsageRow[]>(SELECT_USAGE_SQL, [
          record.resultId,
          record.attemptNumber,
        ])
        const raced = racedRows[0]
        if (!raced) {
          throw error
        }
        const field = usageConflictField(raced, record)
        if (field) {
          throw new CallAuditPersistenceConflictError('usageEvent', field)
        }
        return { outcome: 'replayed' }
      }
    },
  }
}

/** Exposed so tests can pin the exact SQL contract without a database. */
export const CALL_AUDIT_PERSISTENCE_SQL = {
  insertSourceRef: INSERT_SOURCE_REF_SQL,
  selectSourceRef: SELECT_SOURCE_REF_SQL,
  insertResult: INSERT_RESULT_SQL,
  selectResult: SELECT_RESULT_SQL,
  insertMetricScores: INSERT_METRIC_SCORES_SQL,
  selectMetricScores: SELECT_METRIC_SCORES_SQL,
  insertUsage: INSERT_USAGE_SQL,
  selectUsage: SELECT_USAGE_SQL,
  selectPriorResult: SELECT_PRIOR_RESULT_SQL,
  insertSpendClaim: INSERT_SPEND_CLAIM_SQL,
} as const
