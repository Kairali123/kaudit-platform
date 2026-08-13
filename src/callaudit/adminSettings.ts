/**
 * Admin-only Call Audit RULE SETTINGS: the read model behind the settings
 * screen and the validation behind creating a new rule-version snapshot.
 *
 * Scope: rule versions and their lifecycle metadata, plus recent operational
 * run summaries for context. Nothing here executes a model, schedules a run,
 * tests a prompt, or reads the external source table.
 *
 * Privacy: this module never handles a transcript, lead id, phone, email, URL,
 * provider response, provider error prose, or model output. The one prompt it
 * handles is the ADMINISTRATOR-AUTHORED business prompt, which is configuration
 * rather than evidence — and even that is returned only by the explicit detail
 * mode, so the default list read cannot carry it at all.
 *
 * Separation: Call Audit is not Billing Audit. No amount, rate, cost, currency,
 * or invoice field exists in any shape below, and this module imports no
 * billing code.
 */

import { canonicalJsonSha256 } from '../messaging/canonicalJson.ts'
import {
  MAX_ACTOR_ID_LENGTH,
  MAX_CHANGE_REASON_LENGTH,
  RULE_VERSION_STATUSES,
  RUN_STATUSES,
  RUN_TYPES,
  type CallAuditRuleVersionStatus,
  type CallAuditRunStatus,
  type CallAuditRunType,
} from '../adapters/mysqlCallAuditControl.ts'
import { MAX_ID_LENGTH } from './resultRecords.ts'
import { buildScoringConfigDocument } from './ruleActivation.ts'
import {
  MAX_BUSINESS_PROMPT_LENGTH,
  MAX_MODEL_NAME_LENGTH,
  MAX_MODEL_PROVIDER_LENGTH,
  MAX_MODEL_VERSION_LENGTH,
  MAX_TEMPERATURE,
  MAX_VERSION_LABEL_LENGTH,
  MIN_TEMPERATURE,
  OUTPUT_SCHEMA_VERSION,
  RULE_CONTRACT_VERSION,
  SCORING_CONFIG_VERSION,
  TAXONOMY_VERSION,
  TEMPERATURE_DECIMALS,
  validateRuleDraft,
  type ValidatedRuleSettings,
} from './ruleContract.ts'

// ---------------------------------------------------------------------------
// Identity of the surface
// ---------------------------------------------------------------------------

/** Admin-only settings API. Distinct from the sanitized reporting route. */
export const CALL_AUDIT_SETTINGS_ROUTE = '/api/v1/call-audit/settings'

/** Admin-only lifecycle switch for an existing immutable rule snapshot. */
export const CALL_AUDIT_RULE_ACTIVATE_ROUTE =
  '/api/v1/call-audit/settings/activate'

/**
 * Admin-only rule TEST LAB, under the settings module and gated the same way.
 * POST only, and transient: a submission is held for one model call and leaves
 * no record. Named here beside the settings surface it belongs to; this module
 * itself neither reads nor holds anything a submission carries.
 */
export const CALL_AUDIT_RULE_TEST_ROUTE = '/api/v1/call-audit/settings/test'

/** Admin-only settings page, linked only from the admin navigation section. */
export const CALL_AUDIT_SETTINGS_PAGE_ROUTE = '/call-audit/settings'

export const CALL_AUDIT_SETTINGS_TITLE = 'Call Audit Rule Settings'

/**
 * Stated on every response so the screen can label what it is showing. The
 * prompt is configuration an administrator wrote; it is never call evidence.
 */
export const CALL_AUDIT_SETTINGS_BOUNDARY =
  'Administrator configuration only. Rule versions are immutable snapshots: a ' +
  'correction is a new version, never an edit. No transcript, source record, ' +
  'model output, or billing value is available on this surface.'

/** Default and maximum page sizes for the two admin lists. */
export const DEFAULT_VERSION_LIMIT = 25
export const MAX_VERSION_LIMIT = 100
export const DEFAULT_RUN_LIMIT = 10
export const MAX_RUN_LIMIT = 50

/** What an administrator owns, and what the application locks. */
export const ADMIN_EDITABLE_FIELDS: readonly string[] = [
  'versionLabel',
  'businessPrompt',
  'modelProvider',
  'modelName',
  'modelVersion',
  'temperature',
  'changeReason',
]

export const APPLICATION_LOCKED_FIELDS: readonly string[] = [
  'ruleContractVersion',
  'outputSchemaVersion',
  'taxonomyVersion',
  'scoringConfigVersion',
  'outcomeTaxonomy',
  'scoringRubric',
  'privacyRules',
]

const RULE_VERSION_STATUS_LABELS: Record<string, string> = {
  draft: 'Draft',
  active: 'Active',
  retired: 'Retired',
}

const RUN_STATUS_LABELS: Record<string, string> = {
  pending: 'Pending',
  running: 'Running',
  completed: 'Completed',
  failed: 'Failed',
  cancelled: 'Cancelled',
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * A rejected settings query. Names a parameter, never an echoed value, and
 * carries an HTTP status so the server can shape it without inspecting prose.
 */
export class CallAuditSettingsQueryError extends Error {
  readonly code = 'INVALID_CALL_AUDIT_SETTINGS_QUERY'
  readonly status = 400
  readonly field: string

  constructor(field: string, reason: string) {
    super(`${field}: ${reason}`)
    this.field = field
  }
}

// ---------------------------------------------------------------------------
// Read port — implemented by the MySQL admin settings adapter
// ---------------------------------------------------------------------------

/**
 * One rule-version row WITHOUT its prompt. The prompt column is deliberately
 * absent from this shape so a list read cannot carry prompt text even by
 * accident: the detail record below is the only shape that has it.
 */
export interface CallAuditRuleVersionRecord {
  ruleVersionId: string
  versionLabel: string
  status: string
  promptSha256: string
  modelProvider: string
  modelName: string
  modelVersion: string
  /** Fixed-precision decimal string, exactly three places. Never a float. */
  temperature: string
  ruleContractVersion: string
  outputSchemaVersion: string
  taxonomyVersion: string
  scoringConfigVersion: string
  configSha256: string
  changeReason: string | null
  createdBy: string | null
  createdAt: string | null
  activatedBy: string | null
  activatedAt: string | null
  retiredBy: string | null
  retiredAt: string | null
}

/** A rule version WITH its administrator-authored prompt. Admin detail only. */
export interface CallAuditRuleVersionDetailRecord
  extends CallAuditRuleVersionRecord {
  businessPrompt: string
}

/** Operational context only: what ran, over which period, and how it ended. */
export interface CallAuditRunSummaryRecord {
  runId: string
  ruleVersionId: string
  runType: string
  status: string
  periodStart: string
  periodEndExclusive: string
  periodTimezone: string
  totalCandidates: number
  processedCount: number
  succeededCount: number
  failedCount: number
  skippedCount: number
  /** Safe uppercase machine code; never provider prose. */
  errorCode: string | null
  startedAt: string | null
  finishedAt: string | null
}

export interface CallAuditSettingsReadPort {
  /** Newest first. Metadata only — no prompt, no scoring config document. */
  listRuleVersions(limit: number): Promise<CallAuditRuleVersionRecord[]>
  /** The single active version, or null when nothing is live. */
  getActiveRuleVersion(): Promise<CallAuditRuleVersionRecord | null>
  /** Full detail including the administrator-authored prompt, or null. */
  getRuleVersionDetail(
    ruleVersionId: string,
  ): Promise<CallAuditRuleVersionDetailRecord | null>
  /** Newest first. Counters and coded outcomes only. */
  listRecentRuns(limit: number): Promise<CallAuditRunSummaryRecord[]>
}

// ---------------------------------------------------------------------------
// DTOs
// ---------------------------------------------------------------------------

export interface CallAuditRuleVersionDto {
  ruleVersionId: string
  versionLabel: string
  status: string
  statusLabel: string
  isActive: boolean
  modelProvider: string
  modelName: string
  modelVersion: string
  /** Always exactly three decimal places, carried as a string end to end. */
  temperature: string
  ruleContractVersion: string
  outputSchemaVersion: string
  taxonomyVersion: string
  scoringConfigVersion: string
  promptSha256: string
  configSha256: string
  /**
   * False when the stored locked-config hash no longer equals the contract this
   * build compiles — the signal that a version predates a contract change.
   */
  matchesApplicationContract: boolean
  changeReason: string | null
  createdBy: string | null
  createdAt: string | null
  activatedBy: string | null
  activatedAt: string | null
  retiredBy: string | null
  retiredAt: string | null
}

/** Returned only by the explicit detail mode of the admin-only route. */
export interface CallAuditRuleVersionDetailDto extends CallAuditRuleVersionDto {
  /** Administrator-authored configuration text. Not evidence, not customer data. */
  businessPrompt: string
  businessPromptLength: number
}

export interface CallAuditSettingsRunDto {
  runId: string
  ruleVersionId: string
  ruleVersionLabel: string | null
  runType: string
  status: string
  statusLabel: string
  periodStart: string
  periodEndExclusive: string
  periodTimezone: string
  totalCandidates: number
  processedCount: number
  succeededCount: number
  failedCount: number
  skippedCount: number
  errorCode: string | null
  startedAt: string | null
  finishedAt: string | null
}

/** The locked half of the contract, so the screen can show what is not editable. */
export interface CallAuditSettingsContractDto {
  ruleContractVersion: string
  outputSchemaVersion: string
  taxonomyVersion: string
  scoringConfigVersion: string
  configSha256: string
  temperatureDecimals: number
  minTemperature: string
  maxTemperature: string
  maxVersionLabelLength: number
  maxBusinessPromptLength: number
  maxChangeReasonLength: number
  maxModelProviderLength: number
  maxModelNameLength: number
  maxModelVersionLength: number
  editableFields: string[]
  lockedFields: string[]
}

export interface CallAuditSettingsDto {
  generatedAt: string
  title: string
  boundary: string
  contract: CallAuditSettingsContractDto
  activeVersion: CallAuditRuleVersionDto | null
  versions: CallAuditRuleVersionDto[]
  versionCount: number
  /** Present only when the request asked for one version by id. */
  detail: CallAuditRuleVersionDetailDto | null
  recentRuns: CallAuditSettingsRunDto[]
  /**
   * True when no version is active, so the screen can say plainly that a create
   * may also activate. When a version is already live, a new snapshot is saved
   * as draft and may then be selected through Version history.
   */
  activationAvailable: boolean
}

// ---------------------------------------------------------------------------
// Query parsing
// ---------------------------------------------------------------------------

/** Deterministic id grammar, matching the varchar(40) control ids. */
const SAFE_ID = /^[A-Za-z0-9_-]{1,40}$/

export interface CallAuditSettingsQuery {
  versionLimit: number
  runLimit: number
  /** Null means metadata only: no prompt is read or returned. */
  detailRuleVersionId: string | null
}

function parseLimit(
  raw: string | null,
  fallback: number,
  maximum: number,
  field: string,
): number {
  if (raw === null || raw.trim() === '') return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 1 || value > maximum) {
    throw new CallAuditSettingsQueryError(
      field,
      `must be an integer between 1 and ${maximum}`,
    )
  }
  return value
}

export function parseCallAuditSettingsQuery(
  parameters: URLSearchParams,
): CallAuditSettingsQuery {
  const detail = parameters.get('detail')?.trim() ?? ''
  if (detail && !SAFE_ID.test(detail)) {
    throw new CallAuditSettingsQueryError(
      'detail',
      'must be a rule version id',
    )
  }
  return {
    versionLimit: parseLimit(
      parameters.get('versions'),
      DEFAULT_VERSION_LIMIT,
      MAX_VERSION_LIMIT,
      'versions',
    ),
    runLimit: parseLimit(
      parameters.get('runs'),
      DEFAULT_RUN_LIMIT,
      MAX_RUN_LIMIT,
      'runs',
    ),
    detailRuleVersionId: detail || null,
  }
}

// ---------------------------------------------------------------------------
// Create request
// ---------------------------------------------------------------------------

/** A note may wrap and indent; every other control character is unsafe. */
const UNSAFE_NOTE_CHARACTER =
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/

/** A rejected create. Names a FIELD only; a submitted value is never echoed. */
export class CallAuditSettingsRequestError extends Error {
  readonly code = 'INVALID_CALL_AUDIT_SETTINGS_REQUEST'
  readonly status = 400
  readonly field: string

  constructor(field: string, reason: string) {
    super(`${field}: ${reason}`)
    this.field = field
  }
}

export interface CallAuditSettingsCreateRequest {
  /** Validated by the existing rule contract, including fixed-precision temperature. */
  settings: ValidatedRuleSettings
  changeReason: string | null
  /** Only an explicit boolean true activates; anything else stays a draft. */
  activate: boolean
  createdBy: string | null
}

function optionalReason(value: unknown): string | null {
  if (value === null || value === undefined) return null
  if (typeof value !== 'string') {
    throw new CallAuditSettingsRequestError(
      'changeReason',
      'must be a string or null',
    )
  }
  const text = value.trim()
  if (!text) return null
  if (text.length > MAX_CHANGE_REASON_LENGTH) {
    throw new CallAuditSettingsRequestError(
      'changeReason',
      `must be at most ${MAX_CHANGE_REASON_LENGTH} characters`,
    )
  }
  if (UNSAFE_NOTE_CHARACTER.test(text)) {
    throw new CallAuditSettingsRequestError(
      'changeReason',
      'must not contain control characters other than tab and newline',
    )
  }
  return text
}

function optionalActor(value: unknown): string | null {
  if (value === null || value === undefined) return null
  if (typeof value !== 'string') return null
  const text = value.trim()
  if (!text) return null
  if (text.length > MAX_ACTOR_ID_LENGTH || !SAFE_ID.test(text)) {
    // The actor comes from the authenticated session, not the request body, so
    // an unusable id is dropped rather than failing an administrator's save.
    return null
  }
  return text
}

/**
 * Validates an administrator's submitted settings.
 *
 * The editable contract itself is delegated to `validateRuleDraft`, so the
 * temperature is held to the same fixed three-decimal rule as every other
 * writer and the prompt to the same bounds. Errors name a FIELD and never echo
 * a submitted value, so a rejected save is safe to log.
 */
export function parseCallAuditSettingsCreate(
  body: unknown,
  actorUserId: string | null = null,
): CallAuditSettingsCreateRequest {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new CallAuditSettingsRequestError('body', 'must be an object')
  }
  const record = body as Record<string, unknown>
  const activate = record.activate
  if (activate !== undefined && typeof activate !== 'boolean') {
    throw new CallAuditSettingsRequestError('activate', 'must be a boolean')
  }
  return {
    settings: validateRuleDraft({
      versionLabel: record.versionLabel,
      businessPrompt: record.businessPrompt,
      modelProvider: record.modelProvider,
      modelName: record.modelName,
      modelVersion: record.modelVersion,
      temperature: record.temperature,
    }),
    changeReason: optionalReason(record.changeReason),
    activate: activate === true,
    createdBy: optionalActor(actorUserId),
  }
}

export interface CallAuditSettingsActivateRequest {
  ruleVersionId: string
  activatedBy: string | null
}

/**
 * Parses only the selected rule id. The actor always comes from the
 * authenticated session and can never be supplied or impersonated by the body.
 */
export function parseCallAuditSettingsActivate(
  body: unknown,
  actorUserId: string | null = null,
): CallAuditSettingsActivateRequest {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new CallAuditSettingsRequestError('body', 'must be an object')
  }
  const ruleVersionId = (body as Record<string, unknown>).ruleVersionId
  if (
    typeof ruleVersionId !== 'string' ||
    !ruleVersionId.trim() ||
    ruleVersionId.length > MAX_ID_LENGTH ||
    !SAFE_ID.test(ruleVersionId)
  ) {
    throw new CallAuditSettingsRequestError(
      'ruleVersionId',
      'must be a rule version id',
    )
  }
  return {
    ruleVersionId,
    activatedBy: optionalActor(actorUserId),
  }
}

// ---------------------------------------------------------------------------
// Timestamps
// ---------------------------------------------------------------------------

/**
 * UTC-naive 'YYYY-MM-DD HH:MM:SS.ffffff', the exact literal the control tables
 * store. Built from the ISO string rather than local getters, so the activation
 * stamp is never shifted by the host's timezone.
 */
export function naiveUtcTimestamp(now: Date = new Date()): string {
  const iso = now.toISOString()
  return `${iso.slice(0, 10)} ${iso.slice(11, 23).padEnd(12, '0')}000`
}

// ---------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------

/** SHA-256 of the locked configuration this build compiles. */
export function applicationConfigSha256(): string {
  return canonicalJsonSha256(buildScoringConfigDocument())
}

function statusLabel(
  status: string,
  labels: Record<string, string>,
  vocabulary: readonly string[],
): string {
  return vocabulary.includes(status) ? labels[status] : status
}

export function toRuleVersionDto(
  record: CallAuditRuleVersionRecord,
  applicationConfigHash: string,
): CallAuditRuleVersionDto {
  return {
    ruleVersionId: record.ruleVersionId,
    versionLabel: record.versionLabel,
    status: record.status,
    statusLabel: statusLabel(
      record.status,
      RULE_VERSION_STATUS_LABELS,
      RULE_VERSION_STATUSES,
    ),
    isActive: record.status === 'active',
    modelProvider: record.modelProvider,
    modelName: record.modelName,
    modelVersion: record.modelVersion,
    temperature: record.temperature,
    ruleContractVersion: record.ruleContractVersion,
    outputSchemaVersion: record.outputSchemaVersion,
    taxonomyVersion: record.taxonomyVersion,
    scoringConfigVersion: record.scoringConfigVersion,
    promptSha256: record.promptSha256,
    configSha256: record.configSha256,
    matchesApplicationContract:
      record.configSha256 === applicationConfigHash &&
      record.ruleContractVersion === RULE_CONTRACT_VERSION,
    changeReason: record.changeReason,
    createdBy: record.createdBy,
    createdAt: record.createdAt,
    activatedBy: record.activatedBy,
    activatedAt: record.activatedAt,
    retiredBy: record.retiredBy,
    retiredAt: record.retiredAt,
  }
}

export function toRuleVersionDetailDto(
  record: CallAuditRuleVersionDetailRecord,
  applicationConfigHash: string,
): CallAuditRuleVersionDetailDto {
  return {
    ...toRuleVersionDto(record, applicationConfigHash),
    businessPrompt: record.businessPrompt,
    businessPromptLength: record.businessPrompt.length,
  }
}

export function toSettingsRunDto(
  record: CallAuditRunSummaryRecord,
  ruleVersionLabels: ReadonlyMap<string, string>,
): CallAuditSettingsRunDto {
  return {
    runId: record.runId,
    ruleVersionId: record.ruleVersionId,
    ruleVersionLabel: ruleVersionLabels.get(record.ruleVersionId) ?? null,
    runType: RUN_TYPES.includes(record.runType as CallAuditRunType)
      ? record.runType
      : record.runType,
    status: record.status,
    statusLabel: statusLabel(
      record.status,
      RUN_STATUS_LABELS,
      RUN_STATUSES,
    ),
    periodStart: record.periodStart,
    periodEndExclusive: record.periodEndExclusive,
    periodTimezone: record.periodTimezone,
    totalCandidates: record.totalCandidates,
    processedCount: record.processedCount,
    succeededCount: record.succeededCount,
    failedCount: record.failedCount,
    skippedCount: record.skippedCount,
    errorCode: record.errorCode,
    startedAt: record.startedAt,
    finishedAt: record.finishedAt,
  }
}

function contractDto(configSha256: string): CallAuditSettingsContractDto {
  return {
    ruleContractVersion: RULE_CONTRACT_VERSION,
    outputSchemaVersion: OUTPUT_SCHEMA_VERSION,
    taxonomyVersion: TAXONOMY_VERSION,
    scoringConfigVersion: SCORING_CONFIG_VERSION,
    configSha256,
    temperatureDecimals: TEMPERATURE_DECIMALS,
    minTemperature: MIN_TEMPERATURE,
    maxTemperature: MAX_TEMPERATURE,
    maxVersionLabelLength: MAX_VERSION_LABEL_LENGTH,
    maxBusinessPromptLength: MAX_BUSINESS_PROMPT_LENGTH,
    maxChangeReasonLength: MAX_CHANGE_REASON_LENGTH,
    maxModelProviderLength: MAX_MODEL_PROVIDER_LENGTH,
    maxModelNameLength: MAX_MODEL_NAME_LENGTH,
    maxModelVersionLength: MAX_MODEL_VERSION_LENGTH,
    editableFields: [...ADMIN_EDITABLE_FIELDS],
    lockedFields: [...APPLICATION_LOCKED_FIELDS],
  }
}

/**
 * Assembles the admin settings read model.
 *
 * The prompt is fetched ONLY when a detail id was requested, so the ordinary
 * screen load never pulls prompt text out of storage at all.
 */
export async function buildCallAuditSettings(
  repository: CallAuditSettingsReadPort,
  query: CallAuditSettingsQuery,
  now: Date = new Date(),
): Promise<CallAuditSettingsDto> {
  const [versions, active, runs, detail] = await Promise.all([
    repository.listRuleVersions(query.versionLimit),
    repository.getActiveRuleVersion(),
    repository.listRecentRuns(query.runLimit),
    query.detailRuleVersionId
      ? repository.getRuleVersionDetail(query.detailRuleVersionId)
      : Promise.resolve(null),
  ])
  const applicationConfigHash = applicationConfigSha256()
  const labels = new Map<string, string>(
    versions.map((version) => [version.ruleVersionId, version.versionLabel]),
  )
  if (active) labels.set(active.ruleVersionId, active.versionLabel)
  return {
    generatedAt: now.toISOString(),
    title: CALL_AUDIT_SETTINGS_TITLE,
    boundary: CALL_AUDIT_SETTINGS_BOUNDARY,
    contract: contractDto(applicationConfigHash),
    activeVersion: active
      ? toRuleVersionDto(active, applicationConfigHash)
      : null,
    versions: versions.map((version) =>
      toRuleVersionDto(version, applicationConfigHash),
    ),
    versionCount: versions.length,
    detail: detail
      ? toRuleVersionDetailDto(detail, applicationConfigHash)
      : null,
    recentRuns: runs.map((run) => toSettingsRunDto(run, labels)),
    activationAvailable: active === null,
  }
}

/** The sanitized acknowledgement returned after a create. */
export interface CallAuditSettingsCreateResultDto {
  ruleVersionId: string
  versionLabel: string
  status: CallAuditRuleVersionStatus
  statusLabel: string
  outcome: 'inserted' | 'replayed'
  activated: boolean
  promptSha256: string
  configSha256: string
  createdAt: string
}

export interface CallAuditSettingsActivateResultDto {
  ruleVersionId: string
  status: 'active'
  statusLabel: string
  outcome: 'activated' | 'replayed'
  activatedAt: string
}

export function toActivateResultDto(input: {
  ruleVersionId: string
  outcome: 'activated' | 'replayed'
  activatedAt: string
}): CallAuditSettingsActivateResultDto {
  return {
    ruleVersionId: input.ruleVersionId,
    status: 'active',
    statusLabel: RULE_VERSION_STATUS_LABELS.active,
    outcome: input.outcome,
    activatedAt: input.activatedAt,
  }
}

export function toCreateResultDto(input: {
  ruleVersionId: string
  versionLabel: string
  status: CallAuditRuleVersionStatus
  outcome: 'inserted' | 'replayed'
  promptSha256: string
  configSha256: string
  createdAt: string
}): CallAuditSettingsCreateResultDto {
  return {
    ruleVersionId: input.ruleVersionId,
    versionLabel: input.versionLabel,
    status: input.status,
    statusLabel: RULE_VERSION_STATUS_LABELS[input.status] ?? input.status,
    outcome: input.outcome,
    activated: input.status === 'active',
    promptSha256: input.promptSha256,
    configSha256: input.configSha256,
    createdAt: input.createdAt,
  }
}

/** Exported for the id-grammar test; also used by the settings adapter. */
export function isSafeRuleVersionId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= MAX_ID_LENGTH &&
    SAFE_ID.test(value)
  )
}

export type {
  CallAuditRuleVersionStatus,
  CallAuditRunStatus,
  CallAuditRunType,
}
