import type { Pool, RowDataPacket } from 'mysql2/promise'
import type { BillingMonthScope } from '../reporting/billingMonth.ts'
import type { PublishedRateCard } from '../billing/types.ts'
import type { AcceptedAsBilledFallbackReason } from '../billing/acceptedAsBilled.ts'

/**
 * Which unsettled calls a cycle-close run is allowed to settle.
 *
 * `all` is the original cycle-close population and stays the default, so no
 * existing caller changes shape.
 *
 * `exhausted-recording` is the narrow, operator-directed cohort: calls that DO
 * have a recording, whose independent audit is finished trying, and which the
 * audit worker will never claim again. It deliberately excludes the
 * no-recording population — those are a separate, already-zero-rated outcome —
 * so a run aimed at a handful of exhausted calls cannot re-price thousands of
 * unrelated ones.
 */
export type CycleCloseCohort =
  | 'all'
  | 'exhausted-recording'
  | 'no-recording'
  | 'audited-projection'

/**
 * Calls this platform actually audited: a final recording, a completed media
 * analysis and transcript, and a canonical outcome. They are priced from their
 * own audited duration, so the candidate row carries the audit facts the
 * projection needs rather than only the vendor's claim.
 */
const AUDITED_SQL = `
  EXISTS (
    SELECT 1
    FROM kaudit_call_artifact audited_artifact
    JOIN kaudit_media_analysis audited_media
      ON audited_media.call_artifact_id = audited_artifact.id
     AND audited_media.status = 'completed'
     AND audited_media.classification_status = 'completed'
    JOIN kaudit_transcript audited_transcript
      ON audited_transcript.call_artifact_id = audited_artifact.id
     AND audited_transcript.status = 'completed'
    WHERE audited_artifact.call_id = c.id
      AND audited_artifact.artifact_type = 'recording'
      AND audited_artifact.is_final = 1
      AND audited_artifact.source_url IS NOT NULL
  )
  AND c.canonical_outcome_code IS NOT NULL
`

/**
 * The latest completed analysis for a call, and the endpoint/grace the audit
 * recorded. Mirrors the Audit Monitor's own derivation so the settled amount is
 * the amount the monitor already displays — the stored policy values when the
 * audit persisted them, and the conversation end with the locked default grace
 * when it did not.
 */
const AUDITED_FACTS_SQL = `
  SELECT
    latest_media.call_id,
    latest_media.decoded_duration_ms,
    latest_media.speech_ms,
    COALESCE(
      CAST(JSON_EXTRACT(
        latest_media.metrics_json, '$.chargeableServiceEndMs'
      ) AS SIGNED),
      latest_media.conversation_end_ms
    ) AS service_end_ms,
    COALESCE(
      CAST(JSON_EXTRACT(
        latest_media.metrics_json, '$.appliedBillingGraceMs'
      ) AS SIGNED),
      60000
    ) AS grace_ms
  FROM kaudit_media_analysis latest_media
  JOIN kaudit_call_artifact fact_artifact
    ON fact_artifact.id = latest_media.call_artifact_id
   AND fact_artifact.artifact_type = 'recording'
   AND fact_artifact.is_final = 1
  WHERE latest_media.status = 'completed'
    AND latest_media.classification_status = 'completed'
    AND latest_media.id = (
      SELECT newest.id
      FROM kaudit_media_analysis newest
      WHERE newest.call_artifact_id = latest_media.call_artifact_id
        AND newest.status = 'completed'
        AND newest.classification_status = 'completed'
      ORDER BY newest.created_at DESC, newest.id DESC
      LIMIT 1
    )
`

/**
 * Calls KServe supplied no recording for.
 *
 * They can never be listened to, so there is no evidence to support a charge
 * and the fallback prices them at zero. Kept as its own cohort so a run aimed
 * at them cannot touch recording-backed work, and vice versa.
 */
const NO_RECORDING_SQL = `
  NOT EXISTS (
    SELECT 1
    FROM kaudit_call_artifact recording
    WHERE recording.call_id = c.id
      AND recording.artifact_type = 'recording'
      AND recording.is_final = 1
      AND recording.source_url IS NOT NULL
  )
`

/**
 * Exhausted statuses the audit worker still re-claims.
 *
 * `mysqlReauditReadRepo` re-selects an exhausted artifact whose last error is
 * one of these while attempts remain, so settling such a call here would take
 * money away from an audit that is still going to run. They are excluded from
 * the fallback cohort for exactly that reason; keep the two lists together.
 */
const RECLAIMABLE_EXHAUSTED_ERRORS = [
  'CLASSIFICATION_VALIDATION_FAILED',
  'AUDIT_SPEND_STATE_UNKNOWN',
] as const

const MAX_AUDIO_ATTEMPTS = 8

const EXHAUSTED_RECORDING_SQL = `
  EXISTS (
    SELECT 1
    FROM kaudit_call_artifact exhausted_recording
    WHERE exhausted_recording.call_id = c.id
      AND exhausted_recording.artifact_type = 'recording'
      AND exhausted_recording.is_final = 1
      AND exhausted_recording.source_url IS NOT NULL
      AND exhausted_recording.audio_processing_status = 'exhausted'
      AND NOT (
        exhausted_recording.audio_last_error IN (${
          RECLAIMABLE_EXHAUSTED_ERRORS.map(
            (value) => `'${value}'`,
          ).join(',')
        })
        AND COALESCE(exhausted_recording.audio_attempt_count, 0)
              < ${MAX_AUDIO_ATTEMPTS}
      )
  )
`

interface CandidateRow extends RowDataPacket {
  call_id: string
  audit_run_id: string | null
  fallback_reason: AcceptedAsBilledFallbackReason
  category: string | null
  recorded_duration_ms: number | string | null
  speech_ms: number | string | null
  service_end_ms: number | string | null
  grace_ms: number | string | null
  vendor_billed_minutes: string
  vendor_billed_amount: string | null
  claimed_duration_ms: number | string | null
  connected_duration_ms: number | string | null
  evidence_object_id: string
  evidence_sha256: string
}

interface RateCardRow extends RowDataPacket {
  id: string
  version: string
  status: string
  currency: string
  ruleset_sha256: string | null
  approved_by: string | null
  approved_at: Date | string | null
}

export interface AcceptedAsBilledCandidate {
  callId: string
  auditRunId: string | null
  fallbackReason: AcceptedAsBilledFallbackReason
  /** Audit facts, present only for the audited-projection cohort. */
  category: string | null
  recordedDurationMs: number | null
  speechDurationMs: number | null
  serviceEndMs: number | null
  graceMs: number | null
  vendorBilledMinutes: string
  vendorBilledAmount: string | null
  claimedDurationMs: number | null
  connectedDurationMs: number | null
  evidenceObjectId: string
  evidenceSha256: string
}

function integerOrNull(value: unknown): number | null {
  return value == null ? null : Number(value)
}

export async function loadPublishedRateCard(
  pool: Pool,
  id: string,
): Promise<PublishedRateCard> {
  const [rows] = await pool.execute<RateCardRow[]>(
    `SELECT id, version, status, currency, ruleset_sha256,
            approved_by, approved_at
     FROM kaudit_rate_card_version
     WHERE id = ?`,
    [id],
  )
  const row = rows[0]
  if (!row) throw new Error(`Rate card ${id} was not found`)
  if (row.currency !== 'INR') {
    throw new Error('The KServe billing engine supports INR only')
  }
  return {
    id: row.id,
    version: row.version,
    status: row.status,
    currency: 'INR',
    rulesetSha256: row.ruleset_sha256,
    approvedBy: row.approved_by,
    approvedAt:
      row.approved_at == null
        ? null
        : new Date(row.approved_at).toISOString(),
  }
}

export async function listAcceptedAsBilledCandidates(
  pool: Pool,
  period: BillingMonthScope,
  limit: number,
  cohort: CycleCloseCohort = 'all',
): Promise<AcceptedAsBilledCandidate[]> {
  /**
   * The cohort narrows WHICH calls are settled; it never changes how any one
   * of them is priced. `exhausted-recording` keeps only the recording-backed
   * calls whose independent audit is finished, so a targeted run cannot reach
   * the no-recording or unresolved-validation populations.
   */
  const eligibilitySql = cohort === 'exhausted-recording'
    ? EXHAUSTED_RECORDING_SQL
    : cohort === 'no-recording'
    ? NO_RECORDING_SQL
    : cohort === 'audited-projection'
    ? AUDITED_SQL
    : `(
         ${NO_RECORDING_SQL}
         OR EXISTS (
           SELECT 1
           FROM kaudit_automated_decision validation
           WHERE validation.call_id = c.id
             AND validation.decision_type =
                   'automated_consensus_validation'
             AND validation.decision_status = 'unresolved'
             AND NOT EXISTS (
               SELECT 1
               FROM kaudit_automated_decision newer_validation
               WHERE newer_validation.supersedes_decision_id =
                     validation.id
             )
         )
         OR ${EXHAUSTED_RECORDING_SQL}
       )`
  const [rows] = await pool.execute<CandidateRow[]>(
    `SELECT
       c.id AS call_id,
       c.latest_audit_run_id AS audit_run_id,
       CASE
         WHEN NOT EXISTS (
           SELECT 1 FROM kaudit_call_artifact recording_reason
           WHERE recording_reason.call_id = c.id
             AND recording_reason.artifact_type = 'recording'
             AND recording_reason.is_final = 1
             AND recording_reason.source_url IS NOT NULL
         )
         THEN 'no_recording'
         -- A recording-backed call whose audit is exhausted is recorded as
         -- exhausted, not as an unresolved validation. They are different
         -- facts and the decision record has to say which one happened.
         WHEN ${EXHAUSTED_RECORDING_SQL}
         THEN 'audit_exhausted'
         ELSE 'automated_validation_unresolved'
       END AS fallback_reason,
       CAST(minutes.minutes_decimal AS CHAR) AS vendor_billed_minutes,
       CAST(amount.quantity_decimal AS CHAR) AS vendor_billed_amount,
       ROUND(with_ringing.quantity_decimal * 1000) AS claimed_duration_ms,
       ROUND(connected.quantity_decimal * 1000) AS connected_duration_ms,
       evidence.id AS evidence_object_id,
       evidence.sha256 AS evidence_sha256,
       c.canonical_outcome_code AS category,
       audited.decoded_duration_ms AS recorded_duration_ms,
       audited.speech_ms,
       audited.service_end_ms,
       audited.grace_ms
     FROM kaudit_call c
     JOIN kaudit_provider_cost minutes
       ON minutes.call_id = c.id
      AND minutes.provider_sku = 'vendor_asserted_billed_minutes'
      AND minutes.is_final = 1
     JOIN kaudit_evidence_object evidence
       ON evidence.id = minutes.source_evidence_object_id
     LEFT JOIN kaudit_provider_cost amount
       ON amount.call_id = c.id
      AND amount.provider_sku = 'vendor_asserted_billed_amount'
      AND amount.is_final = 1
     LEFT JOIN kaudit_provider_cost with_ringing
       ON with_ringing.call_id = c.id
      AND with_ringing.provider_sku = 'duration_with_ringing_sec'
      AND with_ringing.is_final = 1
     LEFT JOIN kaudit_provider_cost connected
       ON connected.call_id = c.id
      AND connected.provider_sku = 'duration_without_ringing_sec'
      AND connected.is_final = 1
     LEFT JOIN (
       ${AUDITED_FACTS_SQL}
     ) audited ON audited.call_id = c.id
     WHERE c.billing_period_date BETWEEN ? AND ?
       AND ${eligibilitySql}
       AND NOT EXISTS (
         SELECT 1
         FROM kaudit_billing_calculation calculation
         WHERE calculation.call_id = c.id
           AND calculation.status = 'final'
           AND NOT EXISTS (
             SELECT 1
             FROM kaudit_billing_calculation newer
             WHERE newer.supersedes_calculation_id = calculation.id
           )
       )
     ORDER BY c.id
     LIMIT ?`,
    [period.start, period.end, limit],
  )
  return rows.map((row) => ({
    callId: row.call_id,
    auditRunId: row.audit_run_id,
    fallbackReason: row.fallback_reason,
    category: row.category,
    recordedDurationMs: integerOrNull(row.recorded_duration_ms),
    speechDurationMs: integerOrNull(row.speech_ms),
    serviceEndMs: integerOrNull(row.service_end_ms),
    graceMs: integerOrNull(row.grace_ms),
    vendorBilledMinutes: row.vendor_billed_minutes,
    vendorBilledAmount: row.vendor_billed_amount,
    claimedDurationMs: integerOrNull(row.claimed_duration_ms),
    connectedDurationMs: integerOrNull(row.connected_duration_ms),
    evidenceObjectId: row.evidence_object_id,
    evidenceSha256: row.evidence_sha256,
  }))
}
