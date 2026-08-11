import {
  canonicalJson,
  canonicalJsonSha256,
  type JsonValue,
} from '../messaging/canonicalJson.ts'
import { sha256Hex } from '../lib/hash.ts'
import { buildContentAuditSchema } from './modelSchema.ts'
import {
  ISSUE_FLAGS,
  MAX_FEEDBACK_LENGTH,
  NEXT_ACTION_CODES,
  QUALIFICATIONS,
} from './modelOutput.ts'
import {
  DETAILED_OUTCOME_DEFINITIONS,
  DETAILED_OUTCOME_GROUP,
  NO_CONTACT_OUTCOMES,
  OUTCOME_GROUPS,
} from './outcomes.ts'
import {
  CALL_AUDIT_RUBRIC,
  CALL_AUDIT_TOTAL_WEIGHT,
} from './rubric.ts'
import {
  OUTPUT_SCHEMA_VERSION,
  RULE_CONTRACT_VERSION,
  SCORING_CONFIG_VERSION,
  TAXONOMY_VERSION,
  validateRuleDraft,
  type ValidatedRuleSettings,
} from './ruleContract.ts'
import { CALL_INTENTS, METRIC_SCORE_NOT_APPLICABLE } from './types.ts'

/**
 * Deterministic activation snapshot for a rule version.
 *
 * Two hashes, deliberately separate:
 *   * promptSha256 covers ONLY the editable business prompt, so editing the
 *     prompt is visibly a prompt change and nothing else;
 *   * configSha256 covers ONLY the locked contract — schema, taxonomy, rubric,
 *     NA policy, and version identities — so a contract change is visible even
 *     when the prompt is untouched.
 *
 * Model provider/name/version and temperature are explicit settings on the
 * snapshot but are NOT part of configSha256: swapping a model must never look
 * like a taxonomy or scoring change.
 *
 * Nothing here touches a transcript, a database, an ID generator, a clock, or a
 * lifecycle status — those belong to the persistence task, not this pure one.
 */

/** The locked configuration document that configSha256 covers. */
export function buildScoringConfigDocument(): JsonValue {
  return {
    ruleContractVersion: RULE_CONTRACT_VERSION,
    outputSchemaVersion: OUTPUT_SCHEMA_VERSION,
    taxonomyVersion: TAXONOMY_VERSION,
    scoringConfigVersion: SCORING_CONFIG_VERSION,
    outputSchema: buildContentAuditSchema(),
    taxonomy: {
      // Labels AND their locked descriptions are bound in, so configSha256
      // moves if either changes — a reworded description steers the model
      // differently and must be as traceable as a renamed label.
      detailedOutcomes: DETAILED_OUTCOME_DEFINITIONS.map((definition) => ({
        label: definition.label,
        description: definition.description,
      })),
      outcomeGroups: [...OUTCOME_GROUPS],
      detailedOutcomeGroup: { ...DETAILED_OUTCOME_GROUP },
      noContactOutcomes: [...NO_CONTACT_OUTCOMES],
      intents: [...CALL_INTENTS],
      qualifications: [...QUALIFICATIONS],
      nextActions: [...NEXT_ACTION_CODES],
      issueFlags: [...ISSUE_FLAGS],
    },
    rubric: {
      totalWeight: CALL_AUDIT_TOTAL_WEIGHT,
      notApplicableMarker: METRIC_SCORE_NOT_APPLICABLE,
      scoreMinimum: 1,
      scoreMaximum: 5,
      metrics: CALL_AUDIT_RUBRIC.map((metric) => ({
        code: metric.code,
        weight: metric.weight,
        naAllowedWhenCustomerSpoke: metric.naAllowedWhenCustomerSpoke,
        naReason: metric.naReason,
      })),
    },
    derivation: {
      // Recorded so an activated version proves who owned each field.
      groupedOutcome: 'application_derived_from_detailed_outcome',
      overallScore: 'application_calculated_weighted_percentage',
      overallScoreDecimals: 3,
      rounding: 'half_up',
      naWeightRedistribution: true,
    },
    feedback: {
      maxLength: MAX_FEEDBACK_LENGTH,
      sanitized: true,
    },
    evidence: 'transcript_only',
  }
}

/** Persistence-ready snapshot, matching the rule-version columns of 0008. */
export interface CallAuditRuleActivation {
  versionLabel: string
  /** The exact accepted prompt bytes; promptSha256 is taken over this string. */
  businessPrompt: string
  promptSha256: string
  modelProvider: string
  modelName: string
  modelVersion: string
  /** Fixed-precision decimal string with exactly three places. */
  temperature: string
  outputSchemaVersion: string
  taxonomyVersion: string
  scoringConfigVersion: string
  ruleContractVersion: string
  /** Canonical JSON of the locked configuration document. */
  scoringConfigJson: string
  configSha256: string
}

/** Hash of the exact accepted business prompt bytes. */
export function businessPromptSha256(businessPrompt: string): string {
  return sha256Hex(businessPrompt)
}

/**
 * Validates a draft and returns its activation snapshot. Deterministic: the
 * same draft always produces byte-identical output and hashes.
 */
export function buildRuleActivation(draft: unknown): CallAuditRuleActivation {
  const settings: ValidatedRuleSettings = validateRuleDraft(draft)
  const configDocument = buildScoringConfigDocument()
  return {
    versionLabel: settings.versionLabel,
    businessPrompt: settings.businessPrompt,
    promptSha256: businessPromptSha256(settings.businessPrompt),
    modelProvider: settings.modelProvider,
    modelName: settings.modelName,
    modelVersion: settings.modelVersion,
    temperature: settings.temperature,
    outputSchemaVersion: OUTPUT_SCHEMA_VERSION,
    taxonomyVersion: TAXONOMY_VERSION,
    scoringConfigVersion: SCORING_CONFIG_VERSION,
    ruleContractVersion: RULE_CONTRACT_VERSION,
    scoringConfigJson: canonicalJson(configDocument),
    configSha256: canonicalJsonSha256(configDocument),
  }
}
