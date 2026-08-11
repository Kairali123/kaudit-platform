import type { JsonValue } from '../messaging/canonicalJson.ts'
import {
  CONTENT_AUDIT_OUTPUT_KEYS,
  ISSUE_FLAGS,
  MAX_FEEDBACK_LENGTH,
  NEXT_ACTION_CODES,
  QUALIFICATIONS,
} from './modelOutput.ts'
import { DETAILED_OUTCOMES } from './outcomes.ts'
import { CALL_AUDIT_RUBRIC } from './rubric.ts'
import { CALL_INTENTS, METRIC_SCORE_NOT_APPLICABLE } from './types.ts'

/**
 * Strict JSON schema for content-audit model output, written to the documented
 * OpenAI Structured Outputs subset so it can be sent with strict: true.
 *
 * Subset discipline: no $schema, no title, no prefixItems, no tuple-terminating
 * `items: false`, no uniqueItems, allOf, not, if/then/else, patternProperties,
 * dependentRequired, or dependentSchemas. A schema outside the subset is
 * rejected at request time, and a generic JSON Schema test passing would not
 * have caught that.
 *
 * Every node states its JSON type explicitly, including string enums and the NA
 * restriction, matching the official strict-schema examples. An untyped enum is
 * valid generic JSON Schema but is not what the strict validator expects.
 *
 * The schema is only the request-side contract. `validateContentAuditOutput`
 * remains the AUTHORITATIVE enforcement layer for exactly eight metrics, no
 * duplicates, one of every metric, canonical returned ordering, unique issue
 * flags, text bounds, and semantic consistency — none of which the subset can
 * express. Weakening the schema therefore weakens nothing that is enforced.
 *
 * The numeric, array-length, and string-length constraints below are supported
 * for the non-fine-tuned models this application will use initially. FINE-TUNED
 * models accept a narrower constraint subset; validating a chosen model against
 * its capabilities belongs to the future OpenAI adapter / model selector, not
 * to this pure schema module.
 *
 * Deliberately absent: groupedOutcome and overallScore (the application derives
 * both), and any transcript, rationale, raw response, identifier, URL, or PII
 * field. A field that is not here cannot be asked for.
 */

/** A 1-5 integer or the exact string NA — the accepted metric score domain. */
const METRIC_SCORE_SCHEMA: JsonValue = {
  anyOf: [
    { type: 'integer', minimum: 1, maximum: 5 },
    { type: 'string', enum: [METRIC_SCORE_NOT_APPLICABLE] },
  ],
}

/**
 * One metric entry. Every position accepts the same strict object, with the
 * metric restricted to the eight approved codes by enum.
 *
 * Position-pinning is not expressible in the subset, so "exactly one of each
 * metric, in canonical order" is enforced by the runtime validator instead: it
 * rejects missing, duplicate, and unknown metrics and re-emits the set in
 * canonical rubric order.
 */
const METRIC_ENTRY_SCHEMA: JsonValue = {
  type: 'object',
  additionalProperties: false,
  required: ['metric', 'score'],
  properties: {
    metric: {
      type: 'string',
      enum: CALL_AUDIT_RUBRIC.map((metric) => metric.code),
    },
    score: METRIC_SCORE_SCHEMA,
  },
}

function feedbackSchema(description: string): JsonValue {
  return {
    type: 'string',
    maxLength: MAX_FEEDBACK_LENGTH,
    description,
  }
}

/** Builds the schema. Pure and deterministic: same constants, same bytes. */
export function buildContentAuditSchema(): JsonValue {
  return {
    type: 'object',
    additionalProperties: false,
    required: [...CONTENT_AUDIT_OUTPUT_KEYS],
    properties: {
      callConnected: {
        type: 'boolean',
        description: 'True only when the call actually connected.',
      },
      customerSpoke: {
        type: 'boolean',
        description:
          'True only when the customer produced speech in the transcript. Must be false when callConnected is false.',
      },
      meaningfulConversation: {
        type: 'boolean',
        description:
          'True only when a real exchange occurred. Must be false when customerSpoke is false.',
      },
      intent: {
        type: 'string',
        enum: [...CALL_INTENTS],
        description: 'Explicit intent. WARM is a value of its own, never null.',
      },
      detailedOutcome: {
        type: 'string',
        enum: [...DETAILED_OUTCOMES],
        description:
          'Exactly one approved label, reproduced character for character.',
      },
      qualification: { type: 'string', enum: [...QUALIFICATIONS] },
      nextAction: { type: 'string', enum: [...NEXT_ACTION_CODES] },
      confidence: {
        type: 'number',
        minimum: 0,
        maximum: 1,
        description: 'Self-reported confidence from 0 through 1.',
      },
      metricScores: {
        type: 'array',
        minItems: CALL_AUDIT_RUBRIC.length,
        maxItems: CALL_AUDIT_RUBRIC.length,
        items: METRIC_ENTRY_SCHEMA,
        description: `Exactly ${CALL_AUDIT_RUBRIC.length} entries: one score for EACH metric, each metric appearing exactly once, listed in this canonical rubric order: ${CALL_AUDIT_RUBRIC.map(
          (metric) => metric.code,
        ).join(', ')}. Never repeat or omit a metric.`,
      },
      issueFlags: {
        type: 'array',
        minItems: 0,
        maxItems: ISSUE_FLAGS.length,
        items: { type: 'string', enum: [...ISSUE_FLAGS] },
        description: 'Distinct approved flags. Never repeat a flag.',
      },
      managementSummary: feedbackSchema(
        'Concise privacy-safe summary for management. No names, numbers, emails, URLs, or transcript quotes.',
      ),
      kserveFeedback: feedbackSchema(
        'Concise privacy-safe feedback for the vendor. No names, numbers, emails, URLs, or transcript quotes.',
      ),
      improvementFeedback: feedbackSchema(
        'Concise privacy-safe coaching point. No names, numbers, emails, URLs, or transcript quotes.',
      ),
    },
  }
}

/** The compiled schema. Stable for a given set of Task 4 constants. */
export const CONTENT_AUDIT_JSON_SCHEMA: JsonValue = buildContentAuditSchema()

/**
 * Keywords outside the documented Structured Outputs subset. A schema carrying
 * any of them is rejected at request time, so they are banned anywhere in the
 * tree — not merely at the root.
 */
export const STRUCTURED_OUTPUT_FORBIDDEN_KEYWORDS = [
  '$schema',
  '$ref',
  '$defs',
  'prefixItems',
  'uniqueItems',
  'contains',
  'minContains',
  'maxContains',
  'allOf',
  'oneOf',
  'not',
  'if',
  'then',
  'else',
  'dependentRequired',
  'dependentSchemas',
  'patternProperties',
  'unevaluatedProperties',
  'unevaluatedItems',
  'propertyNames',
] as const

/** Fields that must never appear in the schema, asserted by test. */
export const SCHEMA_FORBIDDEN_FIELDS = [
  'groupedOutcome',
  'overallScore',
  'transcript',
  'transcription',
  'rationale',
  'reasoning',
  'rawResponse',
  'leadId',
  'clientName',
  'customerName',
  'mobile',
  'phone',
  'email',
  'transcriptionViewUrl',
  'recordingUrl',
  'url',
] as const
