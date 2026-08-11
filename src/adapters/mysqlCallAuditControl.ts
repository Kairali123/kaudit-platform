import type { Pool, PoolConnection, RowDataPacket } from 'mysql2/promise'
import { canonicalJsonSha256 } from '../messaging/canonicalJson.ts'
import { sha256Hex } from '../lib/hash.ts'
import {
  businessPromptSha256,
  type CallAuditRuleActivation,
} from '../callaudit/ruleActivation.ts'
import {
  MAX_VERSION_LABEL_LENGTH,
  normalizeTemperature,
  validateRuleDraft,
} from '../callaudit/ruleContract.ts'
import {
  MAX_ID_LENGTH,
  MAX_IDEMPOTENCY_KEY_LENGTH,
} from '../callaudit/resultRecords.ts'

/**
 * MySQL persistence for Call Audit RULE VERSIONS and RUN CONTROL rows —
 * `kaudit_call_audit_rule_version` and `kaudit_call_audit_run` from migration
 * 0008, and nothing else.
 *
 * Scope: persistence only. No model client, no worker loop, no API route, no
 * scheduler, no UI, no reporting, and no billing. This repository never
 * calculates money and never imports a billing module: Call Audit is a separate
 * concern from Billing Audit.
 *
 * Contracts:
 *   * ids are DETERMINISTIC — a rule version is identified by
 *     (versionLabel, promptSha256, configSha256) and a run by
 *     (ruleVersionId, runType, period, timezone, idempotencyKey), so a retried
 *     writer always lands on the same row and never mints a second one;
 *   * an identical payload REPLAYS as a no-op, and the same deterministic key
 *     carrying a different payload is a TYPED CONFLICT — never a silent
 *     overwrite;
 *   * a rule-version row is IMMUTABLE. This module contains no UPDATE against
 *     `kaudit_call_audit_rule_version` at all, so an activated or retired
 *     contract cannot be edited in place even by mistake. A correction is a new
 *     version, exactly as migration 0008 states;
 *   * a run advances pending -> running -> exactly one terminal state
 *     (completed, failed, or cancelled) and is IMMUTABLE once terminal. Every
 *     transition runs in a transaction over a `FOR UPDATE` read of the run row,
 *     so two workers cannot both claim the same pending run;
 *   * provenance is composite: a run carries its `rule_version_id`, which with
 *     its `id` forms the parent key a result later references as one unit.
 *
 * Source-table safety: `ai_voice_leads_received` is external and READ-ONLY.
 * Nothing here selects, writes, locks, or foreign-keys it. The only tables named
 * are the two control tables above, and the only `FOR UPDATE` locks taken are on
 * those two.
 *
 * Privacy: no transcript, lead id, phone, email, URL, raw model response,
 * provider error prose, or money value reaches a column here. The ONE prompt
 * this module persists is the administrator-authored `business_prompt` from a
 * validated activation snapshot, which migration 0008 stores deliberately and
 * which contains no customer content. Error messages name an entity and a FIELD
 * only — never a stored or submitted value, so a conflict can be logged safely
 * without echoing the prompt, an idempotency key, or a period.
 */

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Invalid input, rejected before any statement runs. Names a field, never a value. */
export class CallAuditControlError extends Error {
  readonly code = 'CALL_AUDIT_CONTROL_ERROR'
  readonly entity: string
  readonly field: string

  constructor(entity: string, field: string, reason: string) {
    super(`${entity}.${field}: ${reason}`)
    this.entity = entity
    this.field = field
  }
}

/**
 * A row already exists for the same deterministic key with a different payload.
 * The message names the entity and the differing COLUMN only.
 */
export class CallAuditControlConflictError extends Error {
  readonly code = 'CALL_AUDIT_CONTROL_CONFLICT'
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

/**
 * A lifecycle transition that the state machine forbids — most importantly any
 * attempt to move a terminal run. Both statuses are closed enum values, so the
 * message carries no payload.
 */
export class CallAuditControlTransitionError extends Error {
  readonly code = 'CALL_AUDIT_CONTROL_TRANSITION'
  readonly entity: string
  readonly fromStatus: string
  readonly toStatus: string

  constructor(entity: string, fromStatus: string, toStatus: string) {
    super(`${entity}: cannot move from ${fromStatus} to ${toStatus}`)
    this.entity = entity
    this.fromStatus = fromStatus
    this.toStatus = toStatus
  }
}

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
// Column widths and closed vocabularies, all from migration 0008
// ---------------------------------------------------------------------------

/** rule_version.change_reason */
export const MAX_CHANGE_REASON_LENGTH = 500
/** rule_version.created_by / activated_by / retired_by, run.triggered_by */
export const MAX_ACTOR_ID_LENGTH = 40
/** rule_version.rule_contract_version and the three sibling version columns */
export const MAX_CONTRACT_VERSION_LENGTH = 40
/** run.correlation_id */
export const MAX_CORRELATION_ID_LENGTH = 120
/** run.period_timezone */
export const MAX_TIMEZONE_LENGTH = 64
/** run.error_code */
export const MAX_ERROR_CODE_LENGTH = 80
/** Every counter column is a signed INT. */
export const MAX_COUNTER_VALUE = 2147483647

export const RULE_VERSION_STATUSES = ['draft', 'active', 'retired'] as const
export type CallAuditRuleVersionStatus =
  (typeof RULE_VERSION_STATUSES)[number]

export const RUN_TYPES = [
  'daily',
  'monthly',
  'quarterly',
  'yearly',
  'manual',
  'test',
  'backfill',
] as const
export type CallAuditRunType = (typeof RUN_TYPES)[number]

export const RUN_STATUSES = [
  'pending',
  'running',
  'completed',
  'failed',
  'cancelled',
] as const
export type CallAuditRunStatus = (typeof RUN_STATUSES)[number]

/** Once a run reaches one of these it is frozen; a re-run is a NEW run. */
export const TERMINAL_RUN_STATUSES = [
  'completed',
  'failed',
  'cancelled',
] as const
export type CallAuditTerminalRunStatus =
  (typeof TERMINAL_RUN_STATUSES)[number]

function isTerminal(status: string): status is CallAuditTerminalRunStatus {
  return (TERMINAL_RUN_STATUSES as readonly string[]).includes(status)
}

/** Default calendar zone of a period. Stored as a label; never converted here. */
export const DEFAULT_PERIOD_TIMEZONE = 'Asia/Kolkata'

// ---------------------------------------------------------------------------
// Validation primitives
// ---------------------------------------------------------------------------

const CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/
/** A note may wrap and indent; every other control character is unsafe. */
const UNSAFE_NOTE_CHARACTER =
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/
const SHA256_HEX = /^[0-9a-f]{64}$/
/** Conservative machine code grammar: uppercase, digits, underscore only. */
const SAFE_ERROR_CODE = /^[A-Z][A-Z0-9_]*$/
/**
 * Conservative IANA zone grammar. Deliberately not a lookup against the host's
 * zone database: this column records WHICH calendar the period was expressed in,
 * and a name is never resolved or converted by this module.
 */
const IANA_ZONE = /^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+)*$/
/** UTC-naive datetime literal, matching the datetime(6) columns. */
const NAIVE_DATETIME =
  /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?$/

function requireIdentifier(
  value: unknown,
  entity: string,
  field: string,
  maxLength: number,
): string {
  if (typeof value !== 'string') {
    throw new CallAuditControlError(entity, field, 'must be a string')
  }
  const text = value.trim()
  if (!text) {
    throw new CallAuditControlError(entity, field, 'must not be blank')
  }
  if (text.length > maxLength) {
    throw new CallAuditControlError(
      entity,
      field,
      `must be at most ${maxLength} characters`,
    )
  }
  if (CONTROL_CHARACTER.test(text)) {
    throw new CallAuditControlError(
      entity,
      field,
      'must not contain control characters',
    )
  }
  return text
}

function optionalIdentifier(
  value: unknown,
  entity: string,
  field: string,
  maxLength: number,
): string | null {
  if (value === null || value === undefined) return null
  return requireIdentifier(value, entity, field, maxLength)
}

/**
 * Free-ish administrator note. Bounded and control-character free, but not held
 * to the identifier grammar because a reason is a sentence. It is admin-authored
 * metadata about a CONTRACT change and never carries call content.
 */
function optionalNote(
  value: unknown,
  entity: string,
  field: string,
  maxLength: number,
): string | null {
  if (value === null || value === undefined) return null
  if (typeof value !== 'string') {
    throw new CallAuditControlError(entity, field, 'must be a string or null')
  }
  const text = value.trim()
  if (!text) return null
  if (text.length > maxLength) {
    throw new CallAuditControlError(
      entity,
      field,
      `must be at most ${maxLength} characters`,
    )
  }
  if (UNSAFE_NOTE_CHARACTER.test(text)) {
    throw new CallAuditControlError(
      entity,
      field,
      'must not contain control characters other than tab and newline',
    )
  }
  return text
}

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeapYear(year) ? 29 : 28
  return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31
}

/**
 * Normalizes to 'YYYY-MM-DD HH:MM:SS.ffffff' so comparison is lexicographic,
 * checking every component against the Gregorian calendar. Date parsing is
 * deliberately NOT used: JavaScript rolls impossible dates forward, so
 * '2026-02-30' would silently become 2 March and shift the audited period.
 *
 * A trailing Z or a numeric offset is REJECTED rather than converted. This
 * module stores the calendar period exactly as the caller expressed it, in the
 * zone named by `period_timezone`; turning that into UTC-naive source
 * boundaries is a scheduling concern and deliberately not done here.
 */
function requireNaiveDatetime(
  value: unknown,
  entity: string,
  field: string,
): string {
  if (typeof value !== 'string') {
    throw new CallAuditControlError(entity, field, 'must be a string')
  }
  const match = NAIVE_DATETIME.exec(value.trim())
  if (!match) {
    throw new CallAuditControlError(
      entity,
      field,
      "must be a UTC-naive 'YYYY-MM-DD HH:MM:SS' datetime",
    )
  }
  const [, yearText, monthText, dayText, hourText, minuteText, secondText] =
    match
  const fraction = match[7] ?? ''
  const year = Number(yearText)
  const month = Number(monthText)
  const day = Number(dayText)

  if (year < 1) {
    throw new CallAuditControlError(entity, field, 'has an invalid year')
  }
  if (month < 1 || month > 12) {
    throw new CallAuditControlError(entity, field, 'has an invalid month')
  }
  if (day < 1 || day > daysInMonth(year, month)) {
    throw new CallAuditControlError(
      entity,
      field,
      'has an invalid day for that month',
    )
  }
  if (Number(hourText) > 23) {
    throw new CallAuditControlError(entity, field, 'has an invalid hour')
  }
  if (Number(minuteText) > 59) {
    throw new CallAuditControlError(entity, field, 'has an invalid minute')
  }
  if (Number(secondText) > 59) {
    throw new CallAuditControlError(entity, field, 'has an invalid second')
  }
  return (
    `${yearText}-${monthText}-${dayText} ` +
    `${hourText}:${minuteText}:${secondText}.${fraction.padEnd(6, '0')}`
  )
}

function optionalNaiveDatetime(
  value: unknown,
  entity: string,
  field: string,
): string | null {
  if (value === null || value === undefined) return null
  return requireNaiveDatetime(value, entity, field)
}

function requireCounter(
  value: unknown,
  entity: string,
  field: string,
): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new CallAuditControlError(entity, field, 'must be a safe integer')
  }
  if (value < 0) {
    throw new CallAuditControlError(entity, field, 'must not be negative')
  }
  if (value > MAX_COUNTER_VALUE) {
    throw new CallAuditControlError(
      entity,
      field,
      `must be at most ${MAX_COUNTER_VALUE}`,
    )
  }
  return value
}

function requireSha256(value: unknown, entity: string, field: string): string {
  if (typeof value !== 'string' || !SHA256_HEX.test(value)) {
    throw new CallAuditControlError(
      entity,
      field,
      'must be a lowercase 64-character SHA-256 hex digest',
    )
  }
  return value
}

// ---------------------------------------------------------------------------
// Value coercion for read-back comparison
// ---------------------------------------------------------------------------

/** Every value bound to a placeholder is one of these primitives. */
type SqlValue = string | number | null

function textOrNull(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value)
}

function numberOrNull(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value)
}

/**
 * MySQL renders DATETIME(6) with six fractional digits while a domain timestamp
 * may omit them. Both sides are padded so a comparison never fails on formatting
 * alone. No timezone conversion happens.
 */
function readDatetime(value: unknown): string | null {
  if (value === null || value === undefined) return null
  const text = String(value)
  const match =
    /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?/.exec(text)
  if (!match) return text
  return `${match[1]} ${match[2]}.${(match[3] ?? '').padEnd(6, '0')}`
}

// ---------------------------------------------------------------------------
// Deterministic ids
// ---------------------------------------------------------------------------

/** Stable prefixes, so a raw id is self-describing in a log or a join. */
const RULE_VERSION_ID_PREFIX = 'crv_'
const RUN_ID_PREFIX = 'crn_'
/** prefix (4) + truncated hash (36) = the varchar(40) column exactly. */
const ID_HASH_LENGTH = MAX_ID_LENGTH - RULE_VERSION_ID_PREFIX.length

/** The identity tuple a rule-version id is derived from. */
export type CallAuditRuleVersionIdentity = Pick<
  CallAuditRuleActivation,
  'versionLabel' | 'promptSha256' | 'configSha256'
>

/**
 * Deterministic varchar(40) id for a rule version, derived from exactly the
 * tuple that migration 0008 already makes unique
 * (`uq_call_audit_rule_version_hashes`). The prompt TEXT is never an input —
 * only its digest — so an id can be computed and logged without handling the
 * prompt itself.
 */
export function buildRuleVersionId(
  identity: CallAuditRuleVersionIdentity,
): string {
  const digest = canonicalJsonSha256({
    versionLabel: identity.versionLabel,
    promptSha256: identity.promptSha256,
    configSha256: identity.configSha256,
  })
  return `${RULE_VERSION_ID_PREFIX}${digest.slice(0, ID_HASH_LENGTH)}`
}

/**
 * Deterministic varchar(40) id for a run. Every field that changes WHAT the run
 * covers is an input, so a scheduler that retries with the same key and the same
 * period lands on the same row, while the same key aimed at a different period,
 * rule, type, or zone produces a different id and is caught as a conflict rather
 * than silently rewriting the first run.
 */
export function buildRunId(request: ValidatedCallAuditRunRequest): string {
  const digest = canonicalJsonSha256({
    ruleVersionId: request.ruleVersionId,
    runType: request.runType,
    periodStart: request.periodStart,
    periodEndExclusive: request.periodEndExclusive,
    periodTimezone: request.periodTimezone,
    idempotencyKey: request.idempotencyKey,
  })
  return `${RUN_ID_PREFIX}${digest.slice(0, ID_HASH_LENGTH)}`
}

// ---------------------------------------------------------------------------
// Rule version — input shapes and validation
// ---------------------------------------------------------------------------

/** Safe administrator metadata that accompanies a snapshot into storage. */
export interface CallAuditRuleVersionLifecycle {
  status: CallAuditRuleVersionStatus
  /** kaudit_user.id of the author; never a name, email, or display string. */
  createdBy?: string | null
  changeReason?: string | null
  activatedBy?: string | null
  activatedAt?: string | null
  retiredBy?: string | null
  retiredAt?: string | null
}

interface ValidatedLifecycle {
  status: CallAuditRuleVersionStatus
  createdBy: string | null
  changeReason: string | null
  activatedBy: string | null
  activatedAt: string | null
  retiredBy: string | null
  retiredAt: string | null
}

const RULE_VERSION_ENTITY = 'ruleVersion'

/**
 * Validates the lifecycle metadata and its internal coherence.
 *
 * The status columns are the audit trail for WHEN a contract governed live
 * auditing, so the states are pinned rather than merely stored: a draft has
 * never been activated, an active version has an activation time, and a retired
 * version was activated first and retired no earlier than that.
 */
export function validateRuleVersionLifecycle(
  lifecycle: CallAuditRuleVersionLifecycle,
): ValidatedLifecycle {
  if (!lifecycle || typeof lifecycle !== 'object') {
    throw new CallAuditControlError(
      RULE_VERSION_ENTITY,
      'lifecycle',
      'must be an object',
    )
  }
  const { status } = lifecycle
  if (!(RULE_VERSION_STATUSES as readonly unknown[]).includes(status)) {
    throw new CallAuditControlError(
      RULE_VERSION_ENTITY,
      'status',
      `must be one of ${RULE_VERSION_STATUSES.join(', ')}`,
    )
  }
  const validated: ValidatedLifecycle = {
    status,
    createdBy: optionalIdentifier(
      lifecycle.createdBy,
      RULE_VERSION_ENTITY,
      'createdBy',
      MAX_ACTOR_ID_LENGTH,
    ),
    changeReason: optionalNote(
      lifecycle.changeReason,
      RULE_VERSION_ENTITY,
      'changeReason',
      MAX_CHANGE_REASON_LENGTH,
    ),
    activatedBy: optionalIdentifier(
      lifecycle.activatedBy,
      RULE_VERSION_ENTITY,
      'activatedBy',
      MAX_ACTOR_ID_LENGTH,
    ),
    activatedAt: optionalNaiveDatetime(
      lifecycle.activatedAt,
      RULE_VERSION_ENTITY,
      'activatedAt',
    ),
    retiredBy: optionalIdentifier(
      lifecycle.retiredBy,
      RULE_VERSION_ENTITY,
      'retiredBy',
      MAX_ACTOR_ID_LENGTH,
    ),
    retiredAt: optionalNaiveDatetime(
      lifecycle.retiredAt,
      RULE_VERSION_ENTITY,
      'retiredAt',
    ),
  }

  if (status === 'draft') {
    if (validated.activatedAt || validated.activatedBy) {
      throw new CallAuditControlError(
        RULE_VERSION_ENTITY,
        'activatedAt',
        'must be absent on a draft',
      )
    }
  } else if (!validated.activatedAt) {
    throw new CallAuditControlError(
      RULE_VERSION_ENTITY,
      'activatedAt',
      'is required once a version has been activated',
    )
  }

  if (status === 'retired') {
    if (!validated.retiredAt) {
      throw new CallAuditControlError(
        RULE_VERSION_ENTITY,
        'retiredAt',
        'is required on a retired version',
      )
    }
    if (validated.retiredAt < (validated.activatedAt as string)) {
      throw new CallAuditControlError(
        RULE_VERSION_ENTITY,
        'retiredAt',
        'must not precede activatedAt',
      )
    }
  } else if (validated.retiredAt || validated.retiredBy) {
    throw new CallAuditControlError(
      RULE_VERSION_ENTITY,
      'retiredAt',
      'must be absent unless the version is retired',
    )
  }
  return validated
}

/**
 * Re-validates an activation snapshot at the persistence boundary and proves its
 * two hashes describe the two payloads actually being stored.
 *
 * The hash checks are the point: `prompt_sha256` and `config_sha256` are what
 * every later result cites as evidence of the contract it ran under. A row whose
 * digest did not cover its own stored bytes would make that evidence a lie, so
 * a mismatch is refused here rather than written and discovered later.
 */
export function validateRuleActivationSnapshot(
  snapshot: CallAuditRuleActivation,
): CallAuditRuleActivation {
  if (!snapshot || typeof snapshot !== 'object') {
    throw new CallAuditControlError(
      RULE_VERSION_ENTITY,
      'snapshot',
      'must be an object',
    )
  }
  // Re-runs the administrator-editable contract: label, prompt, model triple,
  // and fixed-precision temperature. Its errors name fields, never values.
  const settings = validateRuleDraft({
    versionLabel: snapshot.versionLabel,
    businessPrompt: snapshot.businessPrompt,
    modelProvider: snapshot.modelProvider,
    modelName: snapshot.modelName,
    modelVersion: snapshot.modelVersion,
    temperature: snapshot.temperature,
  })

  const promptSha256 = requireSha256(
    snapshot.promptSha256,
    RULE_VERSION_ENTITY,
    'promptSha256',
  )
  if (promptSha256 !== businessPromptSha256(settings.businessPrompt)) {
    throw new CallAuditControlError(
      RULE_VERSION_ENTITY,
      'promptSha256',
      'does not match the business prompt it claims to cover',
    )
  }

  const scoringConfigJson = snapshot.scoringConfigJson
  if (typeof scoringConfigJson !== 'string' || !scoringConfigJson) {
    throw new CallAuditControlError(
      RULE_VERSION_ENTITY,
      'scoringConfigJson',
      'must be a non-empty canonical JSON string',
    )
  }
  try {
    JSON.parse(scoringConfigJson)
  } catch {
    throw new CallAuditControlError(
      RULE_VERSION_ENTITY,
      'scoringConfigJson',
      'must be valid JSON',
    )
  }
  const configSha256 = requireSha256(
    snapshot.configSha256,
    RULE_VERSION_ENTITY,
    'configSha256',
  )
  if (configSha256 !== sha256Hex(scoringConfigJson)) {
    throw new CallAuditControlError(
      RULE_VERSION_ENTITY,
      'configSha256',
      'does not match the scoring configuration it claims to cover',
    )
  }

  return {
    versionLabel: requireIdentifier(
      settings.versionLabel,
      RULE_VERSION_ENTITY,
      'versionLabel',
      MAX_VERSION_LABEL_LENGTH,
    ),
    businessPrompt: settings.businessPrompt,
    promptSha256,
    modelProvider: settings.modelProvider,
    modelName: settings.modelName,
    modelVersion: settings.modelVersion,
    temperature: normalizeTemperature(settings.temperature),
    outputSchemaVersion: requireIdentifier(
      snapshot.outputSchemaVersion,
      RULE_VERSION_ENTITY,
      'outputSchemaVersion',
      MAX_CONTRACT_VERSION_LENGTH,
    ),
    taxonomyVersion: requireIdentifier(
      snapshot.taxonomyVersion,
      RULE_VERSION_ENTITY,
      'taxonomyVersion',
      MAX_CONTRACT_VERSION_LENGTH,
    ),
    scoringConfigVersion: requireIdentifier(
      snapshot.scoringConfigVersion,
      RULE_VERSION_ENTITY,
      'scoringConfigVersion',
      MAX_CONTRACT_VERSION_LENGTH,
    ),
    ruleContractVersion: requireIdentifier(
      snapshot.ruleContractVersion,
      RULE_VERSION_ENTITY,
      'ruleContractVersion',
      MAX_CONTRACT_VERSION_LENGTH,
    ),
    scoringConfigJson,
    configSha256,
  }
}

// ---------------------------------------------------------------------------
// Rule version — SQL
// ---------------------------------------------------------------------------

const RULE_VERSION_COLUMNS = [
  'id',
  'version_label',
  'status',
  'business_prompt',
  'prompt_sha256',
  'model_provider',
  'model_name',
  'model_version',
  'temperature',
  'rule_contract_version',
  'output_schema_version',
  'taxonomy_version',
  'scoring_config_version',
  'scoring_config_json',
  'config_sha256',
  'change_reason',
  'created_by',
  'activated_by',
  'activated_at',
  'retired_by',
  'retired_at',
] as const

const INSERT_RULE_VERSION_SQL = `INSERT INTO \`kaudit_call_audit_rule_version\`
     (${RULE_VERSION_COLUMNS.map((column) => `\`${column}\``).join(', ')})
   VALUES (${RULE_VERSION_COLUMNS.map(() => '?').join(', ')})`

/**
 * Columns read back as CHAR: the DATETIME(6) stamps so a driver Date object
 * never stands in for the literal that was written, and the DECIMAL(4,3)
 * temperature so it is compared as the exact fixed-precision string it was
 * stored as rather than as a binary float.
 */
const RULE_VERSION_CHAR_COLUMNS = new Set<string>([
  'temperature',
  'activated_at',
  'retired_at',
])

function readRuleVersionColumn(column: string): string {
  return RULE_VERSION_CHAR_COLUMNS.has(column)
    ? `CAST(\`${column}\` AS CHAR) AS \`${column}\``
    : `\`${column}\``
}

/**
 * Matches on EITHER unique identity: the deterministic id, or the version label
 * that migration 0008 makes unique on its own. Both are needed — a corrected
 * prompt under an unchanged label produces a new id but collides on the label,
 * and that must surface as a conflict rather than a duplicate-key surprise.
 *
 * `created_at` and `updated_at` are excluded deliberately: they are
 * database-generated and are not part of the submitted payload.
 */
const SELECT_RULE_VERSION_SQL = `SELECT ${RULE_VERSION_COLUMNS.map(
  readRuleVersionColumn,
).join(',\n          ')}
   FROM \`kaudit_call_audit_rule_version\`
   WHERE \`id\` = ? OR \`version_label\` = ?`

/** Locks the matching rule-version rows only; no other table is ever locked. */
const SELECT_RULE_VERSION_FOR_UPDATE_SQL = `${SELECT_RULE_VERSION_SQL}
   FOR UPDATE`

/**
 * Guards the "one active contract" invariant inside the same transaction as the
 * insert, so two administrators activating different versions concurrently
 * cannot both succeed and leave the system with two live contracts.
 */
const SELECT_ACTIVE_RULE_VERSION_SQL = `SELECT \`id\`
   FROM \`kaudit_call_audit_rule_version\`
   WHERE \`status\` = ? AND \`id\` <> ?
   LIMIT 1
   FOR UPDATE`

interface RuleVersionRow extends RowDataPacket {
  [column: string]: unknown
}

function ruleVersionValues(
  snapshot: CallAuditRuleActivation,
  lifecycle: ValidatedLifecycle,
): SqlValue[] {
  return [
    buildRuleVersionId(snapshot),
    snapshot.versionLabel,
    lifecycle.status,
    // The ONLY prompt this module persists: administrator-authored business
    // guidance, reviewed before activation, never containing call content.
    snapshot.businessPrompt,
    snapshot.promptSha256,
    snapshot.modelProvider,
    snapshot.modelName,
    snapshot.modelVersion,
    // Fixed-precision decimal STRING; never a binary float.
    snapshot.temperature,
    snapshot.ruleContractVersion,
    snapshot.outputSchemaVersion,
    snapshot.taxonomyVersion,
    snapshot.scoringConfigVersion,
    snapshot.scoringConfigJson,
    snapshot.configSha256,
    lifecycle.changeReason,
    lifecycle.createdBy,
    lifecycle.activatedBy,
    lifecycle.activatedAt,
    lifecycle.retiredBy,
    lifecycle.retiredAt,
  ]
}

/**
 * Returns the first column whose stored value differs from the incoming payload,
 * or null when the row is a faithful replay.
 *
 * EVERY persisted column is compared, including `business_prompt` itself: an
 * activated contract is immutable, so a replay that would leave different bytes
 * behind is rejected, not merged. Only the column NAME is ever returned — the
 * stored and submitted prompts stay inside this function.
 */
function ruleVersionConflictField(
  existing: RuleVersionRow,
  snapshot: CallAuditRuleActivation,
  lifecycle: ValidatedLifecycle,
): string | null {
  const expected: Array<[string, SqlValue]> = [
    ['id', buildRuleVersionId(snapshot)],
    ['version_label', snapshot.versionLabel],
    ['status', lifecycle.status],
    ['business_prompt', snapshot.businessPrompt],
    ['prompt_sha256', snapshot.promptSha256],
    ['model_provider', snapshot.modelProvider],
    ['model_name', snapshot.modelName],
    ['model_version', snapshot.modelVersion],
    ['temperature', snapshot.temperature],
    ['rule_contract_version', snapshot.ruleContractVersion],
    ['output_schema_version', snapshot.outputSchemaVersion],
    ['taxonomy_version', snapshot.taxonomyVersion],
    ['scoring_config_version', snapshot.scoringConfigVersion],
    ['scoring_config_json', snapshot.scoringConfigJson],
    ['config_sha256', snapshot.configSha256],
    ['change_reason', lifecycle.changeReason],
    ['created_by', lifecycle.createdBy],
    ['activated_by', lifecycle.activatedBy],
    ['retired_by', lifecycle.retiredBy],
  ]
  for (const [column, value] of expected) {
    if (textOrNull(existing[column]) !== textOrNull(value)) {
      return column
    }
  }
  for (const [column, value] of [
    ['activated_at', lifecycle.activatedAt],
    ['retired_at', lifecycle.retiredAt],
  ] as Array<[string, string | null]>) {
    if (readDatetime(existing[column]) !== readDatetime(value)) {
      return column
    }
  }
  return null
}

function assertRuleVersionMatches(
  rows: readonly RuleVersionRow[],
  snapshot: CallAuditRuleActivation,
  lifecycle: ValidatedLifecycle,
): void {
  if (rows.length > 1) {
    // The deterministic id and the version label matched two different rows,
    // so the label is already owned by another contract.
    throw new CallAuditControlConflictError(
      RULE_VERSION_ENTITY,
      'version_label',
    )
  }
  const field = ruleVersionConflictField(rows[0], snapshot, lifecycle)
  if (field) {
    throw new CallAuditControlConflictError(RULE_VERSION_ENTITY, field)
  }
}

// ---------------------------------------------------------------------------
// Run — input shapes and validation
// ---------------------------------------------------------------------------

const RUN_ENTITY = 'run'

/** Progress counters. All seven are explicit; none is inferred from another. */
export interface CallAuditRunCounters {
  totalCandidates: number
  processedCount: number
  succeededCount: number
  failedCount: number
  skippedCount: number
  contentAuditableCount: number
  operationalOnlyCount: number
}

export const ZERO_RUN_COUNTERS: CallAuditRunCounters = {
  totalCandidates: 0,
  processedCount: 0,
  succeededCount: 0,
  failedCount: 0,
  skippedCount: 0,
  contentAuditableCount: 0,
  operationalOnlyCount: 0,
}

/** Field-to-column mapping, so a counter can never be inserted but not compared. */
const COUNTER_COLUMNS: ReadonlyArray<[keyof CallAuditRunCounters, string]> = [
  ['totalCandidates', 'total_candidates'],
  ['processedCount', 'processed_count'],
  ['succeededCount', 'succeeded_count'],
  ['failedCount', 'failed_count'],
  ['skippedCount', 'skipped_count'],
  ['contentAuditableCount', 'content_auditable_count'],
  ['operationalOnlyCount', 'operational_only_count'],
]

export function validateRunCounters(
  counters: CallAuditRunCounters,
): CallAuditRunCounters {
  if (!counters || typeof counters !== 'object') {
    throw new CallAuditControlError(RUN_ENTITY, 'counters', 'must be an object')
  }
  const validated = {} as CallAuditRunCounters
  for (const [field] of COUNTER_COLUMNS) {
    validated[field] = requireCounter(
      counters[field],
      RUN_ENTITY,
      `counters.${field}`,
    )
  }
  return validated
}

/** Everything that defines WHAT a run covers. All of it is immutable once written. */
export interface CallAuditRunRequest {
  ruleVersionId: string
  runType: CallAuditRunType
  /** Inclusive period start, expressed in `periodTimezone`. */
  periodStart: string
  /** EXCLUSIVE period end; a call at exactly this instant is out of scope. */
  periodEndExclusive: string
  /** IANA zone of the CALENDAR period. Recorded, never converted here. */
  periodTimezone?: string
  idempotencyKey: string
  correlationId?: string | null
  /** kaudit_user.id for a manual run; NULL for a scheduled one. */
  triggeredBy?: string | null
  scheduledAt?: string | null
}

export interface ValidatedCallAuditRunRequest {
  ruleVersionId: string
  runType: CallAuditRunType
  periodStart: string
  periodEndExclusive: string
  periodTimezone: string
  idempotencyKey: string
  correlationId: string | null
  triggeredBy: string | null
  scheduledAt: string | null
}

export function validateRunRequest(
  request: CallAuditRunRequest,
): ValidatedCallAuditRunRequest {
  if (!request || typeof request !== 'object') {
    throw new CallAuditControlError(RUN_ENTITY, 'request', 'must be an object')
  }
  if (!(RUN_TYPES as readonly unknown[]).includes(request.runType)) {
    throw new CallAuditControlError(
      RUN_ENTITY,
      'runType',
      `must be one of ${RUN_TYPES.join(', ')}`,
    )
  }
  const periodStart = requireNaiveDatetime(
    request.periodStart,
    RUN_ENTITY,
    'periodStart',
  )
  const periodEndExclusive = requireNaiveDatetime(
    request.periodEndExclusive,
    RUN_ENTITY,
    'periodEndExclusive',
  )
  // Half-open and strictly ordered, matching chk_call_audit_run_period_order.
  // An empty period is refused here rather than left for the database, because
  // an empty audit window is a caller bug, not a legitimate zero-row run.
  if (periodEndExclusive <= periodStart) {
    throw new CallAuditControlError(
      RUN_ENTITY,
      'periodEndExclusive',
      'must be strictly after periodStart',
    )
  }
  const periodTimezone = requireIdentifier(
    request.periodTimezone ?? DEFAULT_PERIOD_TIMEZONE,
    RUN_ENTITY,
    'periodTimezone',
    MAX_TIMEZONE_LENGTH,
  )
  if (!IANA_ZONE.test(periodTimezone)) {
    throw new CallAuditControlError(
      RUN_ENTITY,
      'periodTimezone',
      'must be an IANA zone name',
    )
  }
  return {
    ruleVersionId: requireIdentifier(
      request.ruleVersionId,
      RUN_ENTITY,
      'ruleVersionId',
      MAX_ID_LENGTH,
    ),
    runType: request.runType,
    periodStart,
    periodEndExclusive,
    periodTimezone,
    idempotencyKey: requireIdentifier(
      request.idempotencyKey,
      RUN_ENTITY,
      'idempotencyKey',
      MAX_IDEMPOTENCY_KEY_LENGTH,
    ),
    correlationId: optionalIdentifier(
      request.correlationId,
      RUN_ENTITY,
      'correlationId',
      MAX_CORRELATION_ID_LENGTH,
    ),
    triggeredBy: optionalIdentifier(
      request.triggeredBy,
      RUN_ENTITY,
      'triggeredBy',
      MAX_ACTOR_ID_LENGTH,
    ),
    scheduledAt: optionalNaiveDatetime(
      request.scheduledAt,
      RUN_ENTITY,
      'scheduledAt',
    ),
  }
}

function requireRunId(runId: unknown): string {
  return requireIdentifier(runId, RUN_ENTITY, 'runId', MAX_ID_LENGTH)
}

function requireErrorCode(value: unknown, field: string): string {
  const code = requireIdentifier(value, RUN_ENTITY, field, MAX_ERROR_CODE_LENGTH)
  if (!SAFE_ERROR_CODE.test(code)) {
    // A coded reason only. Provider prose or an exception message would leak
    // source content into a column that reports read.
    throw new CallAuditControlError(
      RUN_ENTITY,
      field,
      'must be an uppercase machine code',
    )
  }
  return code
}

// ---------------------------------------------------------------------------
// Run — SQL
// ---------------------------------------------------------------------------

const RUN_COLUMNS = [
  'id',
  'rule_version_id',
  'run_type',
  'period_start',
  'period_end_exclusive',
  'period_timezone',
  'status',
  ...COUNTER_COLUMNS.map(([, column]) => column),
  'correlation_id',
  'idempotency_key',
  'triggered_by',
  'error_code',
  'scheduled_at',
  'started_at',
  'finished_at',
] as const

const INSERT_RUN_SQL = `INSERT INTO \`kaudit_call_audit_run\`
     (${RUN_COLUMNS.map((column) => `\`${column}\``).join(', ')})
   VALUES (${RUN_COLUMNS.map(() => '?').join(', ')})`

const RUN_CHAR_COLUMNS = new Set<string>([
  'period_start',
  'period_end_exclusive',
  'scheduled_at',
  'started_at',
  'finished_at',
])

function readRunColumn(column: string): string {
  return RUN_CHAR_COLUMNS.has(column)
    ? `CAST(\`${column}\` AS CHAR) AS \`${column}\``
    : `\`${column}\``
}

const RUN_PROJECTION = RUN_COLUMNS.map(readRunColumn).join(',\n          ')

const SELECT_RUN_BY_KEY_SQL = `SELECT ${RUN_PROJECTION}
   FROM \`kaudit_call_audit_run\`
   WHERE \`idempotency_key\` = ?`

const SELECT_RUN_BY_ID_SQL = `SELECT ${RUN_PROJECTION}
   FROM \`kaudit_call_audit_run\`
   WHERE \`id\` = ?`

/** Locks the run row only; the external source table is never locked. */
const SELECT_RUN_BY_ID_FOR_UPDATE_SQL = `${SELECT_RUN_BY_ID_SQL}
   FOR UPDATE`

/**
 * Every lifecycle UPDATE repeats the expected current status in its WHERE
 * clause. The `FOR UPDATE` read already serializes writers; this is the second
 * lock, so a transition can never apply to a row that moved underneath it.
 */
const UPDATE_RUN_RUNNING_SQL = `UPDATE \`kaudit_call_audit_run\`
   SET \`status\` = ?, \`started_at\` = ?
   WHERE \`id\` = ? AND \`status\` = ?`

const COUNTER_ASSIGNMENTS = COUNTER_COLUMNS.map(
  ([, column]) => `\`${column}\` = ?`,
).join(', ')

const UPDATE_RUN_COUNTERS_SQL = `UPDATE \`kaudit_call_audit_run\`
   SET ${COUNTER_ASSIGNMENTS}
   WHERE \`id\` = ? AND \`status\` = ?`

const UPDATE_RUN_TERMINAL_SQL = `UPDATE \`kaudit_call_audit_run\`
   SET \`status\` = ?,
       \`finished_at\` = ?,
       \`error_code\` = ?,
       ${COUNTER_ASSIGNMENTS}
   WHERE \`id\` = ? AND \`status\` IN (?, ?)`

interface RunRow extends RowDataPacket {
  [column: string]: unknown
}

function runValues(request: ValidatedCallAuditRunRequest): SqlValue[] {
  return [
    buildRunId(request),
    request.ruleVersionId,
    request.runType,
    request.periodStart,
    request.periodEndExclusive,
    request.periodTimezone,
    // A run is always born pending. Lifecycle is advanced by the transition
    // methods below, never smuggled in at creation.
    'pending',
    ...COUNTER_COLUMNS.map(() => 0),
    request.correlationId,
    request.idempotencyKey,
    request.triggeredBy,
    // No error, no start, no finish: none of them can have happened yet.
    null,
    request.scheduledAt,
    null,
    null,
  ]
}

/**
 * Compares only the IMMUTABLE creation identity of a run.
 *
 * Status, counters, error code, and the start/finish stamps are deliberately
 * excluded: they legitimately advance after creation, so comparing them would
 * turn a harmless re-create by a restarted scheduler into a false conflict on a
 * run that is simply already underway. Everything that defines what the run
 * COVERS is compared, so the same key aimed at a different period, rule, type,
 * or zone is still caught.
 */
function runConflictField(
  existing: RunRow,
  request: ValidatedCallAuditRunRequest,
): string | null {
  const expected: Array<[string, SqlValue]> = [
    ['id', buildRunId(request)],
    ['rule_version_id', request.ruleVersionId],
    ['run_type', request.runType],
    ['period_timezone', request.periodTimezone],
    ['correlation_id', request.correlationId],
    ['idempotency_key', request.idempotencyKey],
    ['triggered_by', request.triggeredBy],
  ]
  for (const [column, value] of expected) {
    if (textOrNull(existing[column]) !== textOrNull(value)) {
      return column
    }
  }
  for (const [column, value] of [
    ['period_start', request.periodStart],
    ['period_end_exclusive', request.periodEndExclusive],
    ['scheduled_at', request.scheduledAt],
  ] as Array<[string, string | null]>) {
    if (readDatetime(existing[column]) !== readDatetime(value)) {
      return column
    }
  }
  return null
}

function assertRunMatches(
  existing: RunRow,
  request: ValidatedCallAuditRunRequest,
): void {
  const field = runConflictField(existing, request)
  if (field) {
    throw new CallAuditControlConflictError(RUN_ENTITY, field)
  }
}

function readCounters(row: RunRow): CallAuditRunCounters {
  const counters = {} as CallAuditRunCounters
  for (const [field, column] of COUNTER_COLUMNS) {
    counters[field] = Number(row[column] ?? 0)
  }
  return counters
}

function countersDiffer(
  row: RunRow,
  counters: CallAuditRunCounters,
): string | null {
  for (const [field, column] of COUNTER_COLUMNS) {
    if (numberOrNull(row[column]) !== counters[field]) {
      return column
    }
  }
  return null
}

function runStatusOf(row: RunRow): CallAuditRunStatus {
  return String(row.status) as CallAuditRunStatus
}

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

export interface SaveRuleVersionResult {
  id: string
  outcome: 'inserted' | 'replayed'
}

export interface CreateRunResult {
  id: string
  outcome: 'inserted' | 'replayed'
}

export interface RunTransitionResult {
  id: string
  status: CallAuditRunStatus
  outcome: 'updated' | 'replayed'
}

export interface MarkRunRunningInput {
  runId: string
  startedAt: string
}

export interface MarkRunCompletedInput {
  runId: string
  finishedAt: string
  counters: CallAuditRunCounters
}

export interface MarkRunFailedInput {
  runId: string
  finishedAt: string
  /** Safe uppercase machine code. Never provider prose or an exception message. */
  errorCode: string
  counters?: CallAuditRunCounters
}

export interface MarkRunCancelledInput {
  runId: string
  finishedAt: string
  errorCode?: string | null
  counters?: CallAuditRunCounters
}

export interface CallAuditControlRepository {
  saveRuleVersionSnapshot(
    snapshot: CallAuditRuleActivation,
    lifecycle: CallAuditRuleVersionLifecycle,
  ): Promise<SaveRuleVersionResult>
  createRun(request: CallAuditRunRequest): Promise<CreateRunResult>
  markRunRunning(input: MarkRunRunningInput): Promise<RunTransitionResult>
  updateRunCounters(
    runId: string,
    counters: CallAuditRunCounters,
  ): Promise<RunTransitionResult>
  markRunCompleted(input: MarkRunCompletedInput): Promise<RunTransitionResult>
  markRunFailed(input: MarkRunFailedInput): Promise<RunTransitionResult>
  markRunCancelled(input: MarkRunCancelledInput): Promise<RunTransitionResult>
}

export function createMysqlCallAuditControlRepository(
  pool: Pool,
): CallAuditControlRepository {
  async function findRuleVersion(
    id: string,
    versionLabel: string,
  ): Promise<RuleVersionRow[]> {
    const [rows] = await pool.execute<RuleVersionRow[]>(
      SELECT_RULE_VERSION_SQL,
      [id, versionLabel],
    )
    return rows
  }

  async function findRunByKey(
    idempotencyKey: string,
  ): Promise<RunRow | null> {
    const [rows] = await pool.execute<RunRow[]>(SELECT_RUN_BY_KEY_SQL, [
      idempotencyKey,
    ])
    return rows[0] ?? null
  }

  /**
   * Opens the transaction, replays or inserts, and lets a duplicate-key error
   * escape so the caller can settle a lost race on a released connection.
   */
  async function writeRuleVersion(
    snapshot: CallAuditRuleActivation,
    lifecycle: ValidatedLifecycle,
  ): Promise<SaveRuleVersionResult> {
    const id = buildRuleVersionId(snapshot)
    const connection: PoolConnection = await pool.getConnection()
    try {
      await connection.beginTransaction()
      const [rows] = await connection.execute<RuleVersionRow[]>(
        SELECT_RULE_VERSION_FOR_UPDATE_SQL,
        [id, snapshot.versionLabel],
      )
      if (rows.length > 0) {
        // Never an UPDATE: an existing contract is immutable, so the only
        // acceptable outcome is proving the stored row IS this payload.
        assertRuleVersionMatches(rows, snapshot, lifecycle)
        await connection.rollback()
        return { id, outcome: 'replayed' }
      }

      if (lifecycle.status === 'active') {
        const [active] = await connection.execute<RuleVersionRow[]>(
          SELECT_ACTIVE_RULE_VERSION_SQL,
          ['active', id],
        )
        if (active.length > 0) {
          throw new CallAuditControlError(
            RULE_VERSION_ENTITY,
            'status',
            'another rule version is already active; retire it first',
          )
        }
      }

      await connection.execute(
        INSERT_RULE_VERSION_SQL,
        ruleVersionValues(snapshot, lifecycle),
      )
      await connection.commit()
      return { id, outcome: 'inserted' }
    } catch (error) {
      await connection.rollback()
      throw error
    } finally {
      connection.release()
    }
  }

  /**
   * Runs one lifecycle transition under a `FOR UPDATE` read of the run row.
   * `decide` sees the locked row and returns either a replay verdict or the
   * statement to apply.
   */
  async function transition(
    runId: string,
    decide: (row: RunRow) => {
      replay: boolean
      sql?: string
      parameters?: SqlValue[]
      status: CallAuditRunStatus
    },
  ): Promise<RunTransitionResult> {
    const connection: PoolConnection = await pool.getConnection()
    try {
      await connection.beginTransaction()
      const [rows] = await connection.execute<RunRow[]>(
        SELECT_RUN_BY_ID_FOR_UPDATE_SQL,
        [runId],
      )
      const existing = rows[0]
      if (!existing) {
        throw new CallAuditControlError(RUN_ENTITY, 'runId', 'does not exist')
      }
      const decision = decide(existing)
      if (decision.replay) {
        await connection.rollback()
        return { id: runId, status: decision.status, outcome: 'replayed' }
      }
      await connection.execute(
        decision.sql as string,
        decision.parameters as SqlValue[],
      )
      await connection.commit()
      return { id: runId, status: decision.status, outcome: 'updated' }
    } catch (error) {
      await connection.rollback()
      throw error
    } finally {
      connection.release()
    }
  }

  /**
   * Shared terminal transition. A run may finish from `pending` (cancelled or
   * failed before any work started) or from `running`; from any terminal status
   * it may not move at all.
   */
  function finish(
    runId: string,
    toStatus: CallAuditTerminalRunStatus,
    finishedAt: string,
    errorCode: string | null,
    counters: CallAuditRunCounters | null,
  ): Promise<RunTransitionResult> {
    return transition(runId, (row) => {
      const from = runStatusOf(row)
      if (from === toStatus) {
        // Idempotent finish: the same terminal outcome, already recorded.
        if (readDatetime(row.finished_at) !== readDatetime(finishedAt)) {
          throw new CallAuditControlConflictError(RUN_ENTITY, 'finished_at')
        }
        if (textOrNull(row.error_code) !== textOrNull(errorCode)) {
          throw new CallAuditControlConflictError(RUN_ENTITY, 'error_code')
        }
        if (counters) {
          const differing = countersDiffer(row, counters)
          if (differing) {
            throw new CallAuditControlConflictError(RUN_ENTITY, differing)
          }
        }
        return { replay: true, status: toStatus }
      }
      if (isTerminal(from)) {
        // Terminal immutability: a finished run is history. A correction is a
        // new run, never a rewrite of this one.
        throw new CallAuditControlTransitionError(RUN_ENTITY, from, toStatus)
      }
      // Counters are always written explicitly: when the caller supplies none,
      // the stored values are rewritten as themselves rather than left to an
      // implicit default that could zero real progress.
      const settled = counters ?? readCounters(row)
      return {
        replay: false,
        sql: UPDATE_RUN_TERMINAL_SQL,
        parameters: [
          toStatus,
          finishedAt,
          errorCode,
          ...COUNTER_COLUMNS.map(([field]) => settled[field]),
          runId,
          'pending',
          'running',
        ],
        status: toStatus,
      }
    })
  }

  return {
    /**
     * Writes a validated activation snapshot as a rule-version row with explicit
     * lifecycle fields. Replaying the same snapshot and lifecycle is a no-op;
     * the same deterministic id or version label carrying a different prompt,
     * config, model, temperature, or lifecycle payload is a typed conflict.
     *
     * There is no UPDATE path by design: an activated or retired contract is
     * immutable, and a correction is a new version.
     */
    async saveRuleVersionSnapshot(snapshot, lifecycle) {
      const validatedSnapshot = validateRuleActivationSnapshot(snapshot)
      const validatedLifecycle = validateRuleVersionLifecycle(lifecycle)
      try {
        return await writeRuleVersion(validatedSnapshot, validatedLifecycle)
      } catch (error) {
        if (!isDuplicateEntry(error)) {
          throw error
        }
        // A concurrent writer committed the same identity between the locked
        // read and the insert. That is a legitimate replay only if what they
        // committed is this payload, so it is re-checked on a fresh read.
        const id = buildRuleVersionId(validatedSnapshot)
        const raced = await findRuleVersion(id, validatedSnapshot.versionLabel)
        if (raced.length === 0) {
          throw error
        }
        assertRuleVersionMatches(raced, validatedSnapshot, validatedLifecycle)
        return { id, outcome: 'replayed' }
      }
    },

    /**
     * Creates a pending run for an exact half-open period, or replays an
     * identical create. The same idempotency key describing a different period,
     * rule version, run type, or timezone is a typed conflict.
     */
    async createRun(request) {
      const validated = validateRunRequest(request)
      const id = buildRunId(validated)
      const existing = await findRunByKey(validated.idempotencyKey)
      if (existing) {
        assertRunMatches(existing, validated)
        return { id, outcome: 'replayed' }
      }
      try {
        await pool.execute(INSERT_RUN_SQL, runValues(validated))
        return { id, outcome: 'inserted' }
      } catch (error) {
        if (!isDuplicateEntry(error)) {
          throw error
        }
        const raced = await findRunByKey(validated.idempotencyKey)
        if (!raced) {
          throw error
        }
        assertRunMatches(raced, validated)
        return { id, outcome: 'replayed' }
      }
    },

    /** pending -> running. Claiming an already-running run replays. */
    async markRunRunning(input) {
      const runId = requireRunId(input?.runId)
      const startedAt = requireNaiveDatetime(
        input?.startedAt,
        RUN_ENTITY,
        'startedAt',
      )
      return transition(runId, (row) => {
        const from = runStatusOf(row)
        if (from === 'running') {
          if (readDatetime(row.started_at) !== readDatetime(startedAt)) {
            throw new CallAuditControlConflictError(RUN_ENTITY, 'started_at')
          }
          return { replay: true, status: 'running' }
        }
        if (from !== 'pending') {
          throw new CallAuditControlTransitionError(RUN_ENTITY, from, 'running')
        }
        return {
          replay: false,
          sql: UPDATE_RUN_RUNNING_SQL,
          parameters: ['running', startedAt, runId, 'pending'],
          status: 'running',
        }
      })
    },

    /**
     * Records progress on a run that has not finished. Counters are absolute
     * values supplied by the caller, never incremented in SQL: an increment
     * would double-count on a retried batch.
     */
    async updateRunCounters(runId, counters) {
      const id = requireRunId(runId)
      const validated = validateRunCounters(counters)
      return transition(id, (row) => {
        const from = runStatusOf(row)
        if (isTerminal(from)) {
          throw new CallAuditControlTransitionError(RUN_ENTITY, from, from)
        }
        if (!countersDiffer(row, validated)) {
          return { replay: true, status: from }
        }
        return {
          replay: false,
          sql: UPDATE_RUN_COUNTERS_SQL,
          parameters: [
            ...COUNTER_COLUMNS.map(([field]) => validated[field]),
            id,
            from,
          ],
          status: from,
        }
      })
    },

    /** pending|running -> completed. A completed run carries no error code. */
    async markRunCompleted(input) {
      const runId = requireRunId(input?.runId)
      const finishedAt = requireNaiveDatetime(
        input?.finishedAt,
        RUN_ENTITY,
        'finishedAt',
      )
      const counters = validateRunCounters(input?.counters)
      return finish(runId, 'completed', finishedAt, null, counters)
    },

    /** pending|running -> failed. The reason is a safe machine code. */
    async markRunFailed(input) {
      const runId = requireRunId(input?.runId)
      const finishedAt = requireNaiveDatetime(
        input?.finishedAt,
        RUN_ENTITY,
        'finishedAt',
      )
      const errorCode = requireErrorCode(input?.errorCode, 'errorCode')
      const counters = input?.counters
        ? validateRunCounters(input.counters)
        : null
      return finish(runId, 'failed', finishedAt, errorCode, counters)
    },

    /** pending|running -> cancelled. */
    async markRunCancelled(input) {
      const runId = requireRunId(input?.runId)
      const finishedAt = requireNaiveDatetime(
        input?.finishedAt,
        RUN_ENTITY,
        'finishedAt',
      )
      const errorCode =
        input?.errorCode === null || input?.errorCode === undefined
          ? null
          : requireErrorCode(input.errorCode, 'errorCode')
      const counters = input?.counters
        ? validateRunCounters(input.counters)
        : null
      return finish(runId, 'cancelled', finishedAt, errorCode, counters)
    },
  }
}

/** Exposed so tests can pin the exact SQL contract without a database. */
export const CALL_AUDIT_CONTROL_SQL = {
  insertRuleVersion: INSERT_RULE_VERSION_SQL,
  selectRuleVersion: SELECT_RULE_VERSION_SQL,
  selectRuleVersionForUpdate: SELECT_RULE_VERSION_FOR_UPDATE_SQL,
  selectActiveRuleVersion: SELECT_ACTIVE_RULE_VERSION_SQL,
  insertRun: INSERT_RUN_SQL,
  selectRunByKey: SELECT_RUN_BY_KEY_SQL,
  selectRunById: SELECT_RUN_BY_ID_SQL,
  selectRunByIdForUpdate: SELECT_RUN_BY_ID_FOR_UPDATE_SQL,
  updateRunRunning: UPDATE_RUN_RUNNING_SQL,
  updateRunCounters: UPDATE_RUN_COUNTERS_SQL,
  updateRunTerminal: UPDATE_RUN_TERMINAL_SQL,
} as const
