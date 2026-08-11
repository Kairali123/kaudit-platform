import type { Pool, RowDataPacket } from 'mysql2/promise'
import {
  isSafeRuleVersionId,
  type CallAuditRuleVersionDetailRecord,
  type CallAuditRuleVersionRecord,
  type CallAuditRunSummaryRecord,
  type CallAuditSettingsReadPort,
} from '../callaudit/adminSettings.ts'

/**
 * READ-ONLY MySQL reads for the admin-only Call Audit settings screen.
 *
 * Scope: `kaudit_call_audit_rule_version` and `kaudit_call_audit_run` from
 * migration 0008, and nothing else. There is deliberately no INSERT, UPDATE,
 * DELETE, or `FOR UPDATE` in this module — writing a rule version stays with
 * `mysqlCallAuditControl`, whose append-only snapshot semantics are the reason
 * an activated contract is immutable. Nothing here can weaken that.
 *
 * Source-table safety: `ai_voice_leads_received` is external and READ-ONLY.
 * It is not selected, written, locked, or referenced here.
 *
 * Privacy: no transcript, lead id, phone, email, URL, raw model response,
 * provider error prose, or money column is projected by any statement below.
 * `business_prompt` is administrator-authored configuration and is projected by
 * exactly ONE statement — the single-row detail read — so the list statements
 * cannot carry prompt text at all. `scoring_config_json` is never projected:
 * its identity is the `config_sha256` column plus the four version columns.
 *
 * Every statement is prepared with explicit columns and bound parameters; no
 * value is ever concatenated into SQL.
 */

export class CallAuditSettingsReadError extends Error {
  readonly code = 'CALL_AUDIT_SETTINGS_READ_ERROR'
  readonly field: string

  constructor(field: string, reason: string) {
    super(`${field}: ${reason}`)
    this.field = field
  }
}

/** Hard ceiling for either list, so a caller cannot ask for the whole table. */
const MAX_ROWS = 200

function requireLimit(value: unknown, field: string): number {
  if (!Number.isInteger(value) || (value as number) < 1) {
    throw new CallAuditSettingsReadError(field, 'must be a positive integer')
  }
  return Math.min(value as number, MAX_ROWS)
}

/**
 * Columns read as CHAR: the DATETIME(6) stamps, so a driver Date object never
 * stands in for the stored literal and no timezone conversion happens on the
 * way out, and the DECIMAL(4,3) temperature, so it stays the exact
 * fixed-precision string it was stored as rather than becoming a binary float.
 */
const RULE_VERSION_METADATA_PROJECTION = [
  '`id`',
  '`version_label`',
  '`status`',
  '`prompt_sha256`',
  '`model_provider`',
  '`model_name`',
  '`model_version`',
  'CAST(`temperature` AS CHAR) AS `temperature`',
  '`rule_contract_version`',
  '`output_schema_version`',
  '`taxonomy_version`',
  '`scoring_config_version`',
  '`config_sha256`',
  '`change_reason`',
  '`created_by`',
  'CAST(`created_at` AS CHAR) AS `created_at`',
  '`activated_by`',
  'CAST(`activated_at` AS CHAR) AS `activated_at`',
  '`retired_by`',
  'CAST(`retired_at` AS CHAR) AS `retired_at`',
].join(',\n          ')

const SELECT_RULE_VERSIONS_SQL = `SELECT ${RULE_VERSION_METADATA_PROJECTION}
   FROM \`kaudit_call_audit_rule_version\`
   ORDER BY \`created_at\` DESC, \`id\` DESC
   LIMIT ?`

const SELECT_ACTIVE_RULE_VERSION_SQL = `SELECT ${RULE_VERSION_METADATA_PROJECTION}
   FROM \`kaudit_call_audit_rule_version\`
   WHERE \`status\` = ?
   ORDER BY \`activated_at\` DESC, \`id\` DESC
   LIMIT 1`

/**
 * The ONLY statement that projects the prompt. It is a single-row read by id,
 * reached only from the admin-only detail mode of the settings route.
 */
const SELECT_RULE_VERSION_DETAIL_SQL = `SELECT ${RULE_VERSION_METADATA_PROJECTION},
          \`business_prompt\`
   FROM \`kaudit_call_audit_rule_version\`
   WHERE \`id\` = ?
   LIMIT 1`

const SELECT_RECENT_RUNS_SQL = `SELECT \`id\`,
          \`rule_version_id\`,
          \`run_type\`,
          \`status\`,
          CAST(\`period_start\` AS CHAR) AS \`period_start\`,
          CAST(\`period_end_exclusive\` AS CHAR) AS \`period_end_exclusive\`,
          \`period_timezone\`,
          \`total_candidates\`,
          \`processed_count\`,
          \`succeeded_count\`,
          \`failed_count\`,
          \`skipped_count\`,
          \`error_code\`,
          CAST(\`started_at\` AS CHAR) AS \`started_at\`,
          CAST(\`finished_at\` AS CHAR) AS \`finished_at\`
   FROM \`kaudit_call_audit_run\`
   ORDER BY \`created_at\` DESC, \`id\` DESC
   LIMIT ?`

interface Row extends RowDataPacket {
  [column: string]: unknown
}

function text(value: unknown): string {
  return value === null || value === undefined ? '' : String(value)
}

function textOrNull(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value)
}

function counter(value: unknown): number {
  const parsed = Number(value ?? 0)
  return Number.isFinite(parsed) ? parsed : 0
}

function mapRuleVersion(row: Row): CallAuditRuleVersionRecord {
  return {
    ruleVersionId: text(row.id),
    versionLabel: text(row.version_label),
    status: text(row.status),
    promptSha256: text(row.prompt_sha256),
    modelProvider: text(row.model_provider),
    modelName: text(row.model_name),
    modelVersion: text(row.model_version),
    temperature: text(row.temperature),
    ruleContractVersion: text(row.rule_contract_version),
    outputSchemaVersion: text(row.output_schema_version),
    taxonomyVersion: text(row.taxonomy_version),
    scoringConfigVersion: text(row.scoring_config_version),
    configSha256: text(row.config_sha256),
    changeReason: textOrNull(row.change_reason),
    createdBy: textOrNull(row.created_by),
    createdAt: textOrNull(row.created_at),
    activatedBy: textOrNull(row.activated_by),
    activatedAt: textOrNull(row.activated_at),
    retiredBy: textOrNull(row.retired_by),
    retiredAt: textOrNull(row.retired_at),
  }
}

function mapRun(row: Row): CallAuditRunSummaryRecord {
  return {
    runId: text(row.id),
    ruleVersionId: text(row.rule_version_id),
    runType: text(row.run_type),
    status: text(row.status),
    periodStart: text(row.period_start),
    periodEndExclusive: text(row.period_end_exclusive),
    periodTimezone: text(row.period_timezone),
    totalCandidates: counter(row.total_candidates),
    processedCount: counter(row.processed_count),
    succeededCount: counter(row.succeeded_count),
    failedCount: counter(row.failed_count),
    skippedCount: counter(row.skipped_count),
    errorCode: textOrNull(row.error_code),
    startedAt: textOrNull(row.started_at),
    finishedAt: textOrNull(row.finished_at),
  }
}

export function createMysqlCallAuditSettingsRepository(
  pool: Pool,
): CallAuditSettingsReadPort {
  return {
    async listRuleVersions(limit) {
      const [rows] = await pool.execute<Row[]>(SELECT_RULE_VERSIONS_SQL, [
        requireLimit(limit, 'limit'),
      ])
      return rows.map(mapRuleVersion)
    },

    async getActiveRuleVersion() {
      const [rows] = await pool.execute<Row[]>(
        SELECT_ACTIVE_RULE_VERSION_SQL,
        ['active'],
      )
      return rows[0] ? mapRuleVersion(rows[0]) : null
    },

    async getRuleVersionDetail(ruleVersionId) {
      if (!isSafeRuleVersionId(ruleVersionId)) {
        throw new CallAuditSettingsReadError(
          'ruleVersionId',
          'must be a rule version id',
        )
      }
      const [rows] = await pool.execute<Row[]>(
        SELECT_RULE_VERSION_DETAIL_SQL,
        [ruleVersionId],
      )
      const row = rows[0]
      if (!row) return null
      const record: CallAuditRuleVersionDetailRecord = {
        ...mapRuleVersion(row),
        businessPrompt: text(row.business_prompt),
      }
      return record
    },

    async listRecentRuns(limit) {
      const [rows] = await pool.execute<Row[]>(SELECT_RECENT_RUNS_SQL, [
        requireLimit(limit, 'limit'),
      ])
      return rows.map(mapRun)
    },
  }
}

/** Exposed so a test can pin the exact SQL contract without a database. */
export const CALL_AUDIT_SETTINGS_SQL = {
  selectRuleVersions: SELECT_RULE_VERSIONS_SQL,
  selectActiveRuleVersion: SELECT_ACTIVE_RULE_VERSION_SQL,
  selectRuleVersionDetail: SELECT_RULE_VERSION_DETAIL_SQL,
  selectRecentRuns: SELECT_RECENT_RUNS_SQL,
} as const
