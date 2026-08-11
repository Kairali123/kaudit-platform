/**
 * Transcript-based call audit domain foundation.
 *
 * Pure, deterministic, framework-free types shared by the call-audit module.
 * This domain is independent of the verified billing audit: nothing here
 * produces money, rates, or billable quantities.
 */

/** The KServe AI voicebot always presents itself as this caller. */
export const KSERVE_AI_CALLER_NAME = 'Saanvi'

export interface KserveAiCaller {
  readonly kind: 'kserve_ai'
  readonly name: typeof KSERVE_AI_CALLER_NAME
}

/** Single domain value identifying the KServe AI caller on every audited call. */
export const KSERVE_AI_CALLER: KserveAiCaller = Object.freeze({
  kind: 'kserve_ai',
  name: KSERVE_AI_CALLER_NAME,
})

/**
 * Projection of a KServe call source row, narrowed to the fields the audit
 * actually needs. Sensitive fields stay server-side: they are listed in
 * {@link SENSITIVE_SOURCE_FIELDS} and are structurally excluded from
 * {@link CallAuditDisplay}.
 */
export interface CallAuditSourceRow {
  /** Stable identifier of the call row in the source system. */
  callId: string
  /**
   * SENSITIVE — source column `lead_id`. Server-side only: the approved
   * anonymous design surfaces just the Task ID (its final hyphen segment),
   * never the full lead ID.
   */
  leadId: string | null
  /** Call start timestamp as stored by the source system. */
  calledAt: string | null
  /** Recorded call duration in seconds, when the source system reports one. */
  durationSeconds: number | null
  /** SENSITIVE — source column `client_name`. Never displayed or exported. */
  clientName: string | null
  /** SENSITIVE — source column `mobile`. Never displayed or exported. */
  mobile: string | null
  /** SENSITIVE — source column `email`. Never displayed or exported. */
  email: string | null
  /**
   * SENSITIVE — source column `transcription_view_url`. A vendor-hosted view
   * of the raw conversation; never displayed or exported.
   */
  transcriptionViewUrl: string | null
  /** SENSITIVE — raw transcript text. Never displayed or exported. */
  transcript: string | null
}

/**
 * Source fields that must never leave the server boundary. Kept as data so the
 * privacy boundary is assertable at runtime as well as in the type system.
 */
export const SENSITIVE_SOURCE_FIELDS = [
  'leadId',
  'clientName',
  'mobile',
  'email',
  'transcriptionViewUrl',
  'transcript',
] as const satisfies readonly (keyof CallAuditSourceRow)[]

export type SensitiveSourceField = (typeof SENSITIVE_SOURCE_FIELDS)[number]

/** Source fields that are safe to surface. */
export type PublicSourceField = Exclude<
  keyof CallAuditSourceRow,
  SensitiveSourceField
>

/**
 * The only shape of an audited call that may be sent to a browser, report, or
 * export. `Omit` makes the exclusion structural: a sensitive field cannot be
 * added here without a compile error in the tests that pin the boundary.
 */
export type CallAuditDisplay = Omit<
  CallAuditSourceRow,
  SensitiveSourceField
> & {
  /**
   * The only identifier derived from `leadId` that may be surfaced: its final
   * hyphen segment. Null when no Task ID can be derived.
   */
  taskId: string | null
  caller: KserveAiCaller
  eligibility: CallAuditEligibility
  /** Presence signal only — the transcript text itself is never exposed. */
  hasTranscript: boolean
}

/**
 * Whether the call carries conversation content that can be audited for
 * quality, or only operational facts.
 */
export type CallAuditEligibility = 'content_auditable' | 'operational_only'

/** Why a call is limited to an operational-only audit. */
export type OperationalOnlyReason = 'missing_transcript'

export type CallAuditClassification =
  | { eligibility: 'content_auditable' }
  | { eligibility: 'operational_only'; reason: OperationalOnlyReason }

/** Explicit caller intent. WARM is a value of its own and is never null. */
export const CALL_INTENTS = ['HIGH', 'WARM', 'LOW', 'NONE'] as const

export type CallIntent = (typeof CALL_INTENTS)[number]

/** Marker for a metric that does not apply to the call. */
export const METRIC_SCORE_NOT_APPLICABLE = 'NA'

export type MetricScoreValue = 1 | 2 | 3 | 4 | 5

/**
 * A single metric score: an integer 1–5, or NA when the metric does not apply.
 * Weights and any overall score are deliberately out of scope here.
 */
export type MetricScore =
  | MetricScoreValue
  | typeof METRIC_SCORE_NOT_APPLICABLE

export interface MetricScoreEntry {
  metric: string
  score: MetricScore
}

/**
 * Result of assessing one call. Quality scores exist only on the
 * content-auditable branch, so an operational-only call cannot carry them.
 */
export type CallAuditAssessment =
  | {
      eligibility: 'content_auditable'
      intent: CallIntent
      scores: readonly MetricScoreEntry[]
    }
  | { eligibility: 'operational_only'; reason: OperationalOnlyReason }
