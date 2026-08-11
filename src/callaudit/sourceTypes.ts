/**
 * Server-internal contract for the KServe call source.
 *
 * `ai_voice_leads_received` is an EXTERNAL, READ-ONLY table owned by another
 * system. Nothing in this module writes to it, and nothing here may be sent to
 * a browser, report, or export: use the public `CallAuditDisplay` boundary in
 * ./types.ts for that.
 *
 * Timezone semantics:
 *   Source timestamps are UTC-NAIVE database values — a wall clock with no
 *   zone attached, stored and compared as UTC. Everything in this module reads
 *   and writes that same UTC-naive form. Converting an Asia/Kolkata calendar
 *   period into UTC-naive source boundaries is a SCHEDULING concern and is not
 *   implemented here; an IST midnight string is NOT a valid source boundary.
 */

/** The external source table. Read-only; never a DDL or DML target. */
export const CALL_AUDIT_SOURCE_TABLE = 'ai_voice_leads_received'

/** Raised when a source row cannot be mapped into an auditable candidate. */
export class CallAuditSourceRowError extends Error {
  readonly code = 'INVALID_CALL_AUDIT_SOURCE_ROW'
}

/**
 * Categorical and operational snapshot fields, in the exact order and naming of
 * migration 0008. Kept as data so the revision hash and the persisted columns
 * cannot drift apart silently.
 */
export const SOURCE_CATEGORICAL_FIELDS = [
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
] as const

export type SourceCategoricalField = (typeof SOURCE_CATEGORICAL_FIELDS)[number]

/** The categorical snapshot: every field nullable, all free of PII. */
export type SourceCategoricalSnapshot = {
  [Field in SourceCategoricalField]: string | null
}

/**
 * SERVER-INTERNAL ONLY.
 *
 * One candidate row read from the source table. It carries the raw transcript
 * because that is the approved audit evidence, so a value of this type must
 * never be serialized to a client, log, report, or export. It deliberately has
 * no client name, mobile, email, transcription view URL, or source free text —
 * the adapter never selects those columns.
 */
export interface InternalSourceCandidate extends SourceCategoricalSnapshot {
  sourceTable: string
  /**
   * Primary key of the source row as a canonical decimal STRING. The source
   * column is BIGINT, which a JavaScript number cannot represent exactly.
   */
  sourceRowId: string
  /** SENSITIVE — full source lead ID. Hashed for persistence, never stored raw. */
  leadId: string | null
  /** SENSITIVE — approved audit evidence. Never persisted, displayed, or exported. */
  transcript: string | null
  /**
   * Deterministic source event time — COALESCE(call_start_time, date_time,
   * timestamp) — as a UTC-naive literal. Required: a row without one cannot be
   * placed in any period and is rejected rather than mapped.
   */
  effectiveCallTime: string
  sourceUpdatedAt: string | null
  callStartedAt: string | null
  callEndedAt: string | null
  /** Raw MySQL TIME value, e.g. '00:01:30'. Parsed, never trusted as a number. */
  callDurationSec: string | null
}

/**
 * Persistence-ready row for `kaudit_call_audit_source_ref`, matching migration
 * 0008. Privacy-safe by construction: hashes and categorical facts only, with
 * no raw lead ID, transcript, PII, or URL. `id` and `created_at` are generated
 * by the database and are therefore absent here.
 */
export interface CallAuditSourceReference extends SourceCategoricalSnapshot {
  sourceTable: string
  /** Canonical decimal string; the column is BIGINT. */
  sourceRowId: string
  sourceRevisionSha256: string
  /**
   * Deterministic source event time, persisted as `effective_call_at`. Every
   * period and report index leads with it, so a call whose `call_started_at`
   * is null is still reportable.
   */
  effectiveCallTime: string
  /** Approved extracted Task ID; null when none can be derived. */
  taskId: string | null
  /** SHA-256 of the trimmed full lead ID; null when absent or blank. */
  leadIdSha256: string | null
  /** SHA-256 of the exact transcript bytes; null when no transcript. */
  transcriptSha256: string | null
  hasTranscript: boolean
  sourceUpdatedAt: string | null
  callStartedAt: string | null
  callEndedAt: string | null
  /** Whole non-negative seconds; null when absent or malformed. */
  callDurationSeconds: number | null
  sourceRefIdempotencyKey: string
}

/**
 * Result of building one source revision.
 *
 * The raw transcript is retained ONLY in this in-memory processing envelope and
 * is never part of `reference`, which is the object that reaches the database.
 */
export interface SourceRevisionEnvelope {
  /** SERVER-INTERNAL raw transcript; null when the call had none. */
  transcript: string | null
  reference: CallAuditSourceReference
}
