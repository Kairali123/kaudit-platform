/**
 * The Call Audit rule contract: what an administrator may edit, what the
 * application locks, and how a draft is validated before it can be activated.
 *
 * Administrators own the business prompt, model, model version, and
 * temperature. They do NOT own privacy rules, the outcome taxonomy, the output
 * schema, the scoring rubric, or the application-derived fields — those are
 * pinned here by version constant and enforced in code.
 */

/**
 * Identity of the locked contract. Bump when the locked instruction set,
 * schema, taxonomy, or rubric changes — never when a business prompt changes.
 */
export const RULE_CONTRACT_VERSION = 'call-audit-contract/2.0.0'

/** Identity of the strict model-output schema. */
export const OUTPUT_SCHEMA_VERSION = 'call-audit-output/2.0.0'

/**
 * Identity of the 53-label detailed-outcome taxonomy, its locked descriptions,
 * and its grouping. Bumped to 2.0.0 when the authoritative KServe taxonomy
 * replaced the earlier FYI list; superseded labels are not aliased.
 */
export const TAXONOMY_VERSION = 'call-audit-taxonomy/2.0.0'

/** Identity of the eight-metric rubric, weights, and NA policy. */
export const SCORING_CONFIG_VERSION = 'call-audit-scoring/1.0.0'

/** Column widths from migration 0008; a longer value would be truncated. */
export const MAX_VERSION_LABEL_LENGTH = 80
export const MAX_MODEL_PROVIDER_LENGTH = 80
export const MAX_MODEL_NAME_LENGTH = 100
export const MAX_MODEL_VERSION_LENGTH = 100

/**
 * Upper bound for the editable business prompt. The column is LONGTEXT, so this
 * is an administration guard rather than a storage limit: a prompt beyond this
 * is far past anything reviewable, and an unbounded field is a denial-of-service
 * and cost surface once it reaches a model.
 */
export const MAX_BUSINESS_PROMPT_LENGTH = 20_000

/** Approved sampling range. The column is decimal(4,3). */
export const MIN_TEMPERATURE = '0.000'
export const MAX_TEMPERATURE = '2.000'
export const TEMPERATURE_DECIMALS = 3

export class CallAuditRuleError extends Error {
  readonly code = 'INVALID_CALL_AUDIT_RULE_DRAFT'
  readonly field: string

  constructor(field: string, reason: string) {
    super(`${field}: ${reason}`)
    this.field = field
  }
}

/** Untrusted administrator input for a draft rule version. */
export interface CallAuditRuleDraft {
  versionLabel: string
  businessPrompt: string
  modelProvider: string
  modelName: string
  modelVersion: string
  /** Fixed-precision decimal STRING, e.g. '0.200'. Never a binary float. */
  temperature: string
}

/** A draft that has passed validation and been normalized. */
export interface ValidatedRuleSettings {
  versionLabel: string
  businessPrompt: string
  modelProvider: string
  modelName: string
  modelVersion: string
  /** Always exactly three decimal places. */
  temperature: string
}

/** No control character belongs in an identifier or setting. */
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/
/** Prompt text may wrap and indent; every other control character is unsafe. */
const UNSAFE_PROMPT_CHARACTER = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/

/**
 * Canonical decimal: no sign, no exponent, no leading zeros, at most three
 * fractional digits. Anything looser would let two spellings of the same
 * temperature produce two different stored values.
 */
const CANONICAL_TEMPERATURE = /^(0|[1-9][0-9]*)(?:\.([0-9]{1,3}))?$/

function requireIdentifier(
  value: unknown,
  field: string,
  maxLength: number,
): string {
  if (typeof value !== 'string') {
    throw new CallAuditRuleError(field, 'must be a string')
  }
  const text = value.trim()
  if (!text) {
    throw new CallAuditRuleError(field, 'must not be blank')
  }
  if (text.length > maxLength) {
    throw new CallAuditRuleError(
      field,
      `must be at most ${maxLength} characters`,
    )
  }
  if (CONTROL_CHARACTER.test(text)) {
    throw new CallAuditRuleError(field, 'must not contain control characters')
  }
  return text
}

/**
 * Normalizes a temperature to exactly three decimal places using integer
 * arithmetic on the digits. The value is never parsed into a binary float,
 * so '0.1' can never drift and the stored decimal(4,3) is exact.
 */
export function normalizeTemperature(value: unknown): string {
  if (typeof value !== 'string') {
    // A number would arrive already rounded by IEEE 754 and could not be
    // trusted as the authoritative value.
    throw new CallAuditRuleError(
      'temperature',
      'must be a fixed-precision decimal string, not a number',
    )
  }
  const text = value.trim()
  if (!text) {
    throw new CallAuditRuleError('temperature', 'must not be blank')
  }
  const match = CANONICAL_TEMPERATURE.exec(text)
  if (!match) {
    throw new CallAuditRuleError(
      'temperature',
      'must be a plain decimal with at most three fractional digits',
    )
  }
  const whole = match[1]
  const fraction = (match[2] ?? '').padEnd(TEMPERATURE_DECIMALS, '0')
  const thousandths = BigInt(whole) * 1000n + BigInt(fraction)
  if (thousandths < 0n || thousandths > 2000n) {
    throw new CallAuditRuleError(
      'temperature',
      `must be between ${MIN_TEMPERATURE} and ${MAX_TEMPERATURE}`,
    )
  }
  return `${whole}.${fraction}`
}

/**
 * Validates an untrusted draft. Errors are typed and field-specific and never
 * echo the prompt or any submitted value, so an administrator's draft cannot
 * leak into a log or an error response.
 */
export function validateRuleDraft(draft: unknown): ValidatedRuleSettings {
  if (!draft || typeof draft !== 'object' || Array.isArray(draft)) {
    throw new CallAuditRuleError('root', 'must be an object')
  }
  const record = draft as Record<string, unknown>

  const versionLabel = requireIdentifier(
    record.versionLabel,
    'versionLabel',
    MAX_VERSION_LABEL_LENGTH,
  )
  const modelProvider = requireIdentifier(
    record.modelProvider,
    'modelProvider',
    MAX_MODEL_PROVIDER_LENGTH,
  )
  const modelName = requireIdentifier(
    record.modelName,
    'modelName',
    MAX_MODEL_NAME_LENGTH,
  )
  const modelVersion = requireIdentifier(
    record.modelVersion,
    'modelVersion',
    MAX_MODEL_VERSION_LENGTH,
  )

  const promptValue = record.businessPrompt
  if (typeof promptValue !== 'string') {
    throw new CallAuditRuleError('businessPrompt', 'must be a string')
  }
  const businessPrompt = promptValue.trim()
  if (!businessPrompt) {
    throw new CallAuditRuleError('businessPrompt', 'must not be blank')
  }
  if (businessPrompt.length > MAX_BUSINESS_PROMPT_LENGTH) {
    throw new CallAuditRuleError(
      'businessPrompt',
      `must be at most ${MAX_BUSINESS_PROMPT_LENGTH} characters`,
    )
  }
  if (UNSAFE_PROMPT_CHARACTER.test(businessPrompt)) {
    throw new CallAuditRuleError(
      'businessPrompt',
      'must not contain control characters other than tab and newline',
    )
  }

  return {
    versionLabel,
    businessPrompt,
    modelProvider,
    modelName,
    modelVersion,
    temperature: normalizeTemperature(record.temperature),
  }
}
