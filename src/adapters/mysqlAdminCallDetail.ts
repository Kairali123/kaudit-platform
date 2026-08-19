import type { Pool, RowDataPacket } from 'mysql2/promise'
import { subtract } from '../ui/decimal.ts'

interface AccessRow extends RowDataPacket {
  call_id: string
  call_reference: string
  sensitivity_tier: string
  source_url: string | null
  evidence_sha256: string | null
}

interface DetailRow extends RowDataPacket {
  billing_period_date: Date | string | null
  category: string | null
  confirmation_status: string | null
  confidence: string | null
  language: string | null
  transcript_id: string | null
  recorded_duration_ms: number | string | null
  speech_duration_ms: number | string | null
  conversation_end_ms: number | string | null
  vendor_billed_minutes: string | null
  vendor_connected_duration_ms: number | string | null
  vendor_amount: string | null
  calculation_basis: string | null
  calculation_status: string | null
  auditor_billable_duration_ms: number | string | null
  auditor_billable_minutes: string | null
  auditor_amount: string | null
  auditor_rule_code: string | null
  auditor_increment: string | null
  auditor_unit_rate: string | null
  rate_card_version: string | null
  rate_card_status: string | null
  evidence_sha256: string | null
  last_verified_at: Date | string | null
  audit_engine_version: string | null
  audit_completed_at: Date | string | null
}

interface SegmentRow extends RowDataPacket {
  start_ms: number | string
  end_ms: number | string
  text: string
}

export interface AdminCallAccess {
  callId: string
  callReference: string
  sensitivityTier: string
  sourceUrl: string | null
  evidenceSha256: string | null
}

function iso(value: Date | string | null): string | null {
  if (value == null) return null
  const parsed = value instanceof Date ? value : new Date(value)
  return Number.isNaN(parsed.getTime())
    ? String(value)
    : parsed.toISOString()
}

function numberOrNull(value: unknown): number | null {
  return value == null ? null : Number(value)
}

export async function resolveAdminCallAccess(
  pool: Pool,
  taskReference: string,
): Promise<AdminCallAccess | null> {
  if (
    !taskReference.trim() ||
    taskReference.length > 191 ||
    /[\u0000-\u001f]/.test(taskReference)
  ) {
    return null
  }
  const [rows] = await pool.execute<AccessRow[]>(
    `SELECT c.id AS call_id,
            COALESCE(ref.external_id, c.logical_call_key)
              AS call_reference,
            c.sensitivity_tier, recording.source_url,
            recording.sha256 AS evidence_sha256
     FROM kaudit_call c
     LEFT JOIN kaudit_call_external_reference ref
       ON ref.call_id = c.id
      AND ref.reference_type IN ('task_id','taskId','task')
     LEFT JOIN kaudit_call_artifact recording
       ON recording.call_id = c.id
      AND recording.artifact_type = 'recording'
      AND recording.is_final = 1
     WHERE ref.external_id = ?
        OR c.logical_call_key = ?
     ORDER BY recording.created_at DESC
     LIMIT 1`,
    [taskReference, taskReference],
  )
  const row = rows[0]
  return row
    ? {
        callId: row.call_id,
        callReference: row.call_reference,
        sensitivityTier: row.sensitivity_tier,
        sourceUrl: row.source_url,
        evidenceSha256: row.evidence_sha256,
      }
    : null
}

export async function collectAdminCallDetail(
  pool: Pool,
  access: AdminCallAccess,
): Promise<unknown> {
  const [rows] = await pool.execute<DetailRow[]>(
    `SELECT
       c.billing_period_date,
       c.canonical_outcome_code AS category,
       finding.confirmation_status,
       CAST(finding.confidence AS CHAR) AS confidence,
       transcript.language,
       transcript.id AS transcript_id,
       media.decoded_duration_ms AS recorded_duration_ms,
       media.speech_ms AS speech_duration_ms,
       media.conversation_end_ms,
       CAST(vendor_minutes.minutes_decimal AS CHAR)
         AS vendor_billed_minutes,
       ROUND(vendor_connected.quantity_decimal * 1000)
         AS vendor_connected_duration_ms,
       CAST(COALESCE(
         vendor_amount.quantity_decimal,
         vendor_minutes.minutes_decimal * 9.5
       ) AS CHAR)
         AS vendor_amount,
       calculation.calculation_basis,
       calculation.status AS calculation_status,
       calculation.billable_duration_ms
         AS auditor_billable_duration_ms,
       CAST(component.billable_quantity AS CHAR)
         AS auditor_billable_minutes,
       CAST(calculation.total_amount AS CHAR) AS auditor_amount,
       component.rule_code AS auditor_rule_code,
       component.billing_increment AS auditor_increment,
       CAST(component.unit_rate AS CHAR) AS auditor_unit_rate,
       rate_card.version AS rate_card_version,
       rate_card.status AS rate_card_status,
       recording.sha256 AS evidence_sha256,
       recording.last_verified_at,
       audit_run.engine_version AS audit_engine_version,
       audit_run.completed_at AS audit_completed_at
     FROM kaudit_call c
     LEFT JOIN kaudit_call_artifact recording
       ON recording.call_id = c.id
      AND recording.artifact_type = 'recording'
      AND recording.is_final = 1
     LEFT JOIN kaudit_audit_run audit_run
       ON audit_run.id = c.latest_audit_run_id
     LEFT JOIN kaudit_transcript transcript
       ON transcript.call_id = c.id
      AND transcript.call_artifact_id = recording.id
      AND transcript.status = 'completed'
      AND transcript.id = (
        SELECT latest_transcript.id
        FROM kaudit_transcript latest_transcript
        WHERE latest_transcript.call_id = c.id
          AND latest_transcript.call_artifact_id = recording.id
          AND latest_transcript.status = 'completed'
        ORDER BY latest_transcript.created_at DESC,
                 latest_transcript.id DESC
        LIMIT 1
      )
     LEFT JOIN kaudit_media_analysis media
       ON media.call_artifact_id = recording.id
      AND media.status = 'completed'
      AND media.classification_status = 'completed'
      AND media.id = (
        SELECT latest_media.id
        FROM kaudit_media_analysis latest_media
        WHERE latest_media.call_artifact_id = recording.id
          AND latest_media.status = 'completed'
          AND latest_media.classification_status = 'completed'
        ORDER BY latest_media.created_at DESC, latest_media.id DESC
        LIMIT 1
      )
     LEFT JOIN kaudit_audit_finding finding
       ON finding.call_id = c.id
      AND finding.audit_run_id = c.latest_audit_run_id
      AND finding.confirmation_status = 'confirmed'
      AND finding.id = (
        SELECT latest_finding.id
        FROM kaudit_audit_finding latest_finding
        WHERE latest_finding.call_id = c.id
          AND latest_finding.audit_run_id = c.latest_audit_run_id
          AND latest_finding.confirmation_status = 'confirmed'
        ORDER BY latest_finding.created_at DESC,
                 latest_finding.id DESC
        LIMIT 1
      )
     LEFT JOIN kaudit_provider_cost vendor_minutes
       ON vendor_minutes.call_id = c.id
      AND vendor_minutes.provider_sku =
            'vendor_asserted_billed_minutes'
      AND vendor_minutes.is_final = 1
     LEFT JOIN kaudit_provider_cost vendor_connected
       ON vendor_connected.call_id = c.id
      AND vendor_connected.provider_sku =
            'duration_without_ringing_sec'
      AND vendor_connected.is_final = 1
     LEFT JOIN kaudit_provider_cost vendor_amount
       ON vendor_amount.call_id = c.id
      AND vendor_amount.provider_sku =
            'vendor_asserted_billed_amount'
      AND vendor_amount.is_final = 1
     LEFT JOIN kaudit_billing_calculation calculation
       ON calculation.call_id = c.id
      AND calculation.status = 'final'
      AND NOT EXISTS (
        SELECT 1
        FROM kaudit_billing_calculation newer_calculation
        WHERE newer_calculation.supersedes_calculation_id =
              calculation.id
      )
     LEFT JOIN kaudit_billing_component_result component
       ON component.billing_calculation_id = calculation.id
      AND component.component_type = 'platform'
     LEFT JOIN kaudit_rate_card_version rate_card
       ON rate_card.id = calculation.rate_card_version_id
     WHERE c.id = ?
     LIMIT 1`,
    [access.callId],
  )
  const row = rows[0]
  if (!row) return null
  const segments = row.transcript_id
    ? (
        await pool.execute<SegmentRow[]>(
          `SELECT start_ms, end_ms, text
           FROM kaudit_transcript_segment
           WHERE transcript_id = ?
           ORDER BY start_ms, end_ms, id`,
          [row.transcript_id],
        )
      )[0].map((segment) => ({
        startMs: Number(segment.start_ms),
        endMs: Number(segment.end_ms),
        text: segment.text,
      }))
    : []
  const vendorAmount =
    row.vendor_amount == null ? null : row.vendor_amount
  const auditorAmount =
    row.auditor_amount == null ? null : row.auditor_amount
  const variance =
    vendorAmount == null || auditorAmount == null
      ? null
      : subtract(vendorAmount, auditorAmount)
  return {
    generatedAt: new Date().toISOString(),
    call: {
      reference: access.callReference,
      billingPeriodDate: iso(row.billing_period_date),
      sensitivityTier: access.sensitivityTier,
      category: row.category,
      confirmationStatus: row.confirmation_status,
      confidence: row.confidence,
      language: row.language,
      auditEngineVersion: row.audit_engine_version,
      auditedAt: iso(row.audit_completed_at),
    },
    evidence: {
      recordingAvailable: Boolean(access.sourceUrl),
      evidenceHashRecorded: Boolean(row.evidence_sha256),
      lastVerifiedAt: iso(row.last_verified_at),
    },
    durations: {
      recordedMs: numberOrNull(row.recorded_duration_ms),
      speechMs: numberOrNull(row.speech_duration_ms),
      finalCustomerExchangeMs: numberOrNull(
        row.conversation_end_ms,
      ),
      vendorConnectedMs: numberOrNull(
        row.vendor_connected_duration_ms,
      ),
    },
    comparison: {
      currency: 'INR',
      kserve: {
        basis:
          'Derived from KServe sheet minutes; KServe does not provide a per-task invoice amount.',
        billedMinutes: row.vendor_billed_minutes,
        unitRate: '9.50000000',
        amount: vendorAmount,
      },
      auditor: {
        basis: row.calculation_basis,
        status: row.calculation_status,
        billableDurationMs: numberOrNull(
          row.auditor_billable_duration_ms,
        ),
        billableMinutes: row.auditor_billable_minutes,
        unitRate: row.auditor_unit_rate,
        amount: auditorAmount,
        ruleCode: row.auditor_rule_code,
        billingIncrement: row.auditor_increment,
        rateCardVersion: row.rate_card_version,
        rateCardStatus: row.rate_card_status,
      },
      variance,
    },
    transcript: {
      available: segments.length > 0,
      segments,
    },
  }
}
