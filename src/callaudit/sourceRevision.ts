import {
  canonicalJson,
  canonicalJsonSha256,
  type JsonValue,
} from '../messaging/canonicalJson.ts'
import { sha256Hex } from '../lib/hash.ts'
import { hasAuditableTranscript } from './eligibility.ts'
import { parseMysqlTimeToSeconds } from './mysqlTime.ts'
import { normalizeSourceRowId } from './sourceRowId.ts'
import { extractTaskId } from './taskId.ts'
import {
  SOURCE_CATEGORICAL_FIELDS,
  type CallAuditSourceReference,
  type InternalSourceCandidate,
  type SourceRevisionEnvelope,
} from './sourceTypes.ts'

export class CallAuditSourceRevisionError extends Error {
  readonly code = 'INVALID_CALL_AUDIT_SOURCE_ROW'
}

/**
 * Facts covered by `source_revision_sha256`.
 *
 * Deliberately excluded: the generated `id`, `source_ref_idempotency_key` (it is
 * derived FROM this hash), and `created_at` (when we observed the row, not what
 * the row says). Also excluded: the raw lead ID and raw transcript — only their
 * hashes participate, so the revision is privacy-safe on its own.
 */
function revisionFacts(reference: CallAuditSourceReference): JsonValue {
  const facts: Record<string, JsonValue> = {
    source_table: reference.sourceTable,
    // A canonical decimal string, never a number: a BIGINT beyond 2^53-1 would
    // otherwise be rounded and two distinct rows could share a revision.
    source_row_id: reference.sourceRowId,
    effective_call_at: reference.effectiveCallTime,
    task_id: reference.taskId,
    lead_id_sha256: reference.leadIdSha256,
    transcript_sha256: reference.transcriptSha256,
    has_transcript: reference.hasTranscript,
    source_updated_at: reference.sourceUpdatedAt,
    call_started_at: reference.callStartedAt,
    call_ended_at: reference.callEndedAt,
    call_duration_seconds: reference.callDurationSeconds,
  }
  for (const field of SOURCE_CATEGORICAL_FIELDS) {
    facts[field] = reference[field]
  }
  return facts
}

/** The canonical JSON a revision hash is taken over. Exposed for auditing. */
export function sourceRevisionCanonicalJson(
  reference: CallAuditSourceReference,
): string {
  return canonicalJson(revisionFacts(reference))
}

/**
 * Stable key for one source row revision. Rebuilding an unchanged row yields
 * the same key, so re-reading the source is idempotent; a changed revision
 * yields a new key and therefore a new append-only row.
 */
export function buildSourceRefIdempotencyKey(
  sourceTable: string,
  sourceRowId: string,
  sourceRevisionSha256: string,
): string {
  return `${sourceTable}:${sourceRowId}:${sourceRevisionSha256}`
}

/**
 * Maps one server-internal source candidate into a processing envelope: the raw
 * transcript stays in memory, and `reference` holds only privacy-safe facts
 * ready for `kaudit_call_audit_source_ref`.
 *
 * Pure and deterministic — the same candidate always yields the same hashes.
 */
export function buildSourceRevision(
  candidate: InternalSourceCandidate,
): SourceRevisionEnvelope {
  if (!candidate.sourceTable.trim()) {
    throw new CallAuditSourceRevisionError('Source table must not be blank')
  }
  const sourceRowId = normalizeSourceRowId(candidate.sourceRowId)
  if (sourceRowId === null) {
    throw new CallAuditSourceRevisionError(
      'Source row ID must be a canonical positive decimal within BIGINT range',
    )
  }
  if (
    typeof candidate.effectiveCallTime !== 'string' ||
    !candidate.effectiveCallTime.trim()
  ) {
    throw new CallAuditSourceRevisionError(
      'Effective call time is required; a row without one is unreportable',
    )
  }

  const trimmedLeadId =
    typeof candidate.leadId === 'string' ? candidate.leadId.trim() : ''
  const hasTranscript = hasAuditableTranscript(candidate.transcript)

  const reference: CallAuditSourceReference = {
    sourceTable: candidate.sourceTable,
    sourceRowId,
    // Filled in below, once the facts above are settled.
    sourceRevisionSha256: '',
    effectiveCallTime: candidate.effectiveCallTime,
    taskId: extractTaskId(candidate.leadId),
    leadIdSha256: trimmedLeadId ? sha256Hex(trimmedLeadId) : null,
    // The exact transcript bytes, not a trimmed copy: the hash must identify
    // the evidence as it was read.
    transcriptSha256: hasTranscript
      ? sha256Hex(candidate.transcript as string)
      : null,
    hasTranscript,
    sourceUpdatedAt: candidate.sourceUpdatedAt,
    callStartedAt: candidate.callStartedAt,
    callEndedAt: candidate.callEndedAt,
    callDurationSeconds: parseMysqlTimeToSeconds(candidate.callDurationSec),
    sourceRefIdempotencyKey: '',
    company_by_kserve: candidate.company_by_kserve,
    company: candidate.company,
    data_source: candidate.data_source,
    verified_source: candidate.verified_source,
    service_category: candidate.service_category,
    call_type: candidate.call_type,
    call_status: candidate.call_status,
    call_end_reason: candidate.call_end_reason,
    final_call_status: candidate.final_call_status,
    ai_call_category: candidate.ai_call_category,
    customer_engagement_level: candidate.customer_engagement_level,
    interest_level: candidate.interest_level,
    call_outcome: candidate.call_outcome,
    lead_status: candidate.lead_status,
    final_lead_outcome: candidate.final_lead_outcome,
    calculated_qualification_status: candidate.calculated_qualification_status,
    followup_required: candidate.followup_required,
  }

  reference.sourceRevisionSha256 = canonicalJsonSha256(revisionFacts(reference))
  reference.sourceRefIdempotencyKey = buildSourceRefIdempotencyKey(
    reference.sourceTable,
    reference.sourceRowId,
    reference.sourceRevisionSha256,
  )

  return { transcript: candidate.transcript, reference }
}
