import { createHash } from 'node:crypto'
import type {
  Pool,
  PoolConnection,
  RowDataPacket,
} from 'mysql2/promise'
import type { BillingMonthScope } from '../reporting/billingMonth.ts'
import type {
  CyclePreviewInputRow,
  CyclePreviewRow,
} from '../reporting/cyclePreview.ts'

interface PreviewRow extends RowDataPacket {
  call_id: string
  call_reference: string
  recording_available: number | string
  category: string | null
  confidence: string | null
  vendor_billed_minutes: string
  vendor_connected_duration_ms: number | string | null
  recorded_duration_ms: number | string | null
  conversation_end_ms: number | string | null
  evidence_sha256: string
  audit_run_id: string | null
}

export async function collectCyclePreviewInputs(
  pool: Pool,
  period: BillingMonthScope,
): Promise<CyclePreviewInputRow[]> {
  const [rows] = await pool.execute<PreviewRow[]>(
    `SELECT
       c.id AS call_id,
       ref.external_id AS call_reference,
       ca.source_url IS NOT NULL AS recording_available,
       c.canonical_outcome_code AS category,
       CAST((
         SELECT finding.confidence
         FROM kaudit_audit_finding finding
         WHERE finding.call_id = c.id
         ORDER BY finding.created_at DESC, finding.id DESC
         LIMIT 1
       ) AS CHAR) AS confidence,
       CAST(minutes.minutes_decimal AS CHAR) AS vendor_billed_minutes,
       ROUND(connected.quantity_decimal * 1000)
         AS vendor_connected_duration_ms,
       ma.decoded_duration_ms AS recorded_duration_ms,
       ma.conversation_end_ms,
       COALESCE(ca.sha256, usage_evidence.sha256) AS evidence_sha256,
       audit_run.id AS audit_run_id
     FROM kaudit_call c
     JOIN kaudit_call_external_reference ref
       ON ref.call_id = c.id
      AND ref.reference_type = 'task_id'
     JOIN kaudit_provider_cost minutes
       ON minutes.call_id = c.id
      AND minutes.provider_sku = 'vendor_asserted_billed_minutes'
      AND minutes.is_final = 1
     JOIN kaudit_evidence_object usage_evidence
       ON usage_evidence.id = minutes.source_evidence_object_id
     LEFT JOIN kaudit_provider_cost connected
       ON connected.call_id = c.id
      AND connected.provider_sku = 'duration_without_ringing_sec'
      AND connected.is_final = 1
     LEFT JOIN kaudit_call_artifact ca
       ON ca.call_id = c.id
      AND ca.artifact_type = 'recording'
      AND ca.is_final = 1
     LEFT JOIN kaudit_audit_run audit_run
       ON audit_run.id = c.latest_audit_run_id
      AND audit_run.status = 'completed'
     LEFT JOIN kaudit_media_analysis ma
       ON ma.call_artifact_id = ca.id
      AND ma.status = 'completed'
      AND ma.classification_status = 'completed'
      AND ma.id = (
        SELECT latest.id
        FROM kaudit_media_analysis latest
        WHERE latest.call_artifact_id = ca.id
          AND latest.status = 'completed'
          AND latest.classification_status = 'completed'
        ORDER BY latest.created_at DESC, latest.id DESC
        LIMIT 1
      )
     WHERE c.billing_period_date BETWEEN ? AND ?
     ORDER BY ref.external_id`,
    [period.start, period.end],
  )
  return rows.map((row) => ({
    callId: row.call_id,
    callReference: row.call_reference,
    recordingAvailable: Boolean(Number(row.recording_available)),
    category: row.category,
    confidence: row.confidence,
    vendorBilledMinutes: row.vendor_billed_minutes,
    vendorConnectedDurationMs:
      row.vendor_connected_duration_ms == null
        ? null
        : Number(row.vendor_connected_duration_ms),
    recordedDurationMs:
      row.recorded_duration_ms == null
        ? null
        : Number(row.recorded_duration_ms),
    conversationEndMs:
      row.conversation_end_ms == null
        ? null
        : Number(row.conversation_end_ms),
    evidenceSha256: row.evidence_sha256,
    auditRunId: row.audit_run_id,
  }))
}

export async function persistProvisionalReconciliation(
  pool: Pool,
  options: {
    period: BillingMonthScope
    rateCardId: string
    createdBy: string
    inputs: CyclePreviewInputRow[]
    rows: CyclePreviewRow[]
    totals: {
      vendorAmount: string
      verifiedAmount: string
      variance: string
    }
  },
): Promise<'inserted' | 'duplicate'> {
  const reconciliationId =
    `recon-${options.period.month}-test-preview-v1`
  const connection: PoolConnection = await pool.getConnection()
  try {
    await connection.beginTransaction()
    const [existing] = await connection.execute<RowDataPacket[]>(
      `SELECT id, CAST(claimed_subtotal AS CHAR) AS claimed,
              CAST(verified_subtotal AS CHAR) AS verified,
              CAST(net_variance AS CHAR) AS variance
       FROM kaudit_reconciliation WHERE id = ? FOR UPDATE`,
      [reconciliationId],
    )
    if (existing[0]) {
      if (
        existing[0].claimed !== options.totals.vendorAmount ||
        existing[0].verified !== options.totals.verifiedAmount ||
        existing[0].variance !== options.totals.variance
      ) {
        throw new Error(
          'Existing provisional reconciliation differs; append a new version rather than overwriting it',
        )
      }
      await connection.commit()
      return 'duplicate'
    }
    const [invoiceRows] = await connection.execute<RowDataPacket[]>(
      `SELECT id, CAST(subtotal_amount AS CHAR) AS subtotal
       FROM kaudit_invoice
       WHERE period_start = ? AND period_end = ?
       ORDER BY revision_no DESC, created_at DESC LIMIT 1 FOR UPDATE`,
      [options.period.start, options.period.end],
    )
    const invoice = invoiceRows[0]
    if (!invoice) throw new Error('No invoice exists for this period')
    if (invoice.subtotal !== options.totals.vendorAmount) {
      throw new Error(
        'Derived vendor amount does not tie to the imported invoice subtotal',
      )
    }
    await connection.execute(
      `INSERT INTO kaudit_reconciliation
         (id, invoice_id, rate_card_version_id, version, status,
          source_coverage_ratio, review_coverage_ratio, claimed_subtotal,
          verified_subtotal, accepted_amount, disputed_amount,
          unresolved_amount, credit_amount, tax_difference, net_variance,
          currency, created_by)
       VALUES (?, ?, ?, 1, 'test_preview', 1.00000, 0.00000, ?, ?,
               NULL, ?, ?, NULL, NULL, ?, 'INR', ?)`,
      [
        reconciliationId,
        invoice.id,
        options.rateCardId,
        options.totals.vendorAmount,
        options.totals.verifiedAmount,
        options.totals.variance,
        options.totals.variance,
        options.totals.variance,
        options.createdBy,
      ],
    )
    for (const [index, row] of options.rows.entries()) {
      const input = options.inputs[index]
      if (!input || input.callReference !== row.callReference) {
        throw new Error('Preview row order changed before persistence')
      }
      const itemId = `ri-${createHash('sha256')
        .update(`${reconciliationId}:${input.callId}`)
        .digest('hex')
        .slice(0, 32)}`
      const [calculationRows] =
        await connection.execute<RowDataPacket[]>(
          `SELECT id
           FROM kaudit_billing_calculation
           WHERE call_id = ?
             AND status = 'final'
             AND calculation_basis =
               'accepted_as_billed_unverified'
             AND NOT EXISTS (
               SELECT 1 FROM kaudit_billing_calculation newer
               WHERE newer.supersedes_calculation_id =
                 kaudit_billing_calculation.id
             )
           ORDER BY calculated_at DESC LIMIT 1`,
          [input.callId],
        )
      await connection.execute(
        `INSERT INTO kaudit_reconciliation_item
           (id, reconciliation_id, invoice_line_id, call_id,
            billing_calculation_id, reason_code, claimed_amount,
            verified_amount, difference_amount, disposition,
            materiality, notes)
         VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          itemId,
          reconciliationId,
          input.callId,
          calculationRows[0]?.id ?? null,
          row.auditResolution ===
            'accepted_as_billed_unverified'
            ? 'NO_RECORDING_ACCEPTED'
            : 'AI_UNCALIBRATED_PREVIEW',
          row.vendorAmount,
          row.verifiedAmount,
          row.variance,
          row.auditResolution ===
            'accepted_as_billed_unverified'
            ? 'accepted'
            : 'unresolved',
          Number(row.variance) === 0 ? 'none' : 'material',
          row.auditResolution ===
            'accepted_as_billed_unverified'
            ? 'No recording; explicitly accepted at the KServe source quantity.'
            : 'Provisional AI-derived amount; calibration is not complete.',
        ],
      )
    }
    await connection.commit()
    return 'inserted'
  } catch (error) {
    await connection.rollback()
    throw error
  } finally {
    connection.release()
  }
}
