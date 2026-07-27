import { randomUUID } from 'node:crypto'
import type {
  Pool,
  PoolConnection,
  RowDataPacket,
} from 'mysql2/promise'
import { createMysqlOutboxWriter } from './mysqlOutbox.ts'
import { buildVerifiedBillingRecords } from '../billing/records.ts'
import type {
  PublishedRateCard,
  VerifiedBillingInput,
  VerifiedBillingResult,
} from '../billing/types.ts'

interface ExistingDecisionRow extends RowDataPacket {
  id: string
  billing_calculation_id: string | null
  decision_output_sha256: string
}

interface ExistingCalculationRow extends RowDataPacket {
  id: string
  decision_trace_sha256: string | null
}

interface RateCardRow extends RowDataPacket {
  id: string
  version: string
  status: string
  currency: string
  ruleset_sha256: string | null
  approved_by: string | null
  approved_at: Date | null
}

interface PriorRow extends RowDataPacket {
  id: string
}

export interface PersistVerifiedBillingResult {
  outcome: 'inserted' | 'duplicate'
  decisionId: string
  billingCalculationId: string | null
}

export class BillingPersistenceIntegrityError extends Error {
  readonly code = 'BILLING_PERSISTENCE_INTEGRITY'
}

async function lockAndValidateRateCard(
  connection: PoolConnection,
  rateCard: PublishedRateCard,
): Promise<void> {
  const [rows] = await connection.execute<RateCardRow[]>(
    `SELECT id, version, status, currency, ruleset_sha256,
            approved_by, approved_at
     FROM kaudit_rate_card_version
     WHERE id = ? FOR UPDATE`,
    [rateCard.id],
  )
  const row = rows[0]
  if (
    !row ||
    row.version !== rateCard.version ||
    row.status !== 'published' ||
    row.currency !== rateCard.currency ||
    row.ruleset_sha256 !== rateCard.rulesetSha256 ||
    row.approved_by !== rateCard.approvedBy ||
    row.approved_at == null
  ) {
    throw new BillingPersistenceIntegrityError(
      'Rate card changed or is not formally published; billing write aborted',
    )
  }
}

async function findExistingDecision(
  connection: PoolConnection,
  callId: string,
  inputManifestSha256: string,
  rulesetSha256: string,
): Promise<ExistingDecisionRow | null> {
  const [rows] = await connection.execute<ExistingDecisionRow[]>(
    `SELECT id, billing_calculation_id, decision_output_sha256
     FROM kaudit_automated_decision
     WHERE call_id = ?
       AND decision_type = 'verified_call_billing'
       AND input_manifest_sha256 = ?
       AND ruleset_sha256 = ?
     FOR UPDATE`,
    [callId, inputManifestSha256, rulesetSha256],
  )
  return rows[0] ?? null
}

async function findCurrentCalculation(
  connection: PoolConnection,
  callId: string,
): Promise<string | null> {
  const [rows] = await connection.execute<PriorRow[]>(
    `SELECT previous.id
     FROM kaudit_billing_calculation previous
     WHERE previous.call_id = ?
       AND NOT EXISTS (
         SELECT 1
         FROM kaudit_billing_calculation newer
         WHERE newer.supersedes_calculation_id = previous.id
       )
     ORDER BY previous.calculated_at DESC, previous.id DESC
     LIMIT 1 FOR UPDATE`,
    [callId],
  )
  return rows[0]?.id ?? null
}

async function findPreviousDecision(
  connection: PoolConnection,
  callId: string,
): Promise<string | null> {
  const [rows] = await connection.execute<PriorRow[]>(
    `SELECT previous.id
     FROM kaudit_automated_decision previous
     WHERE previous.call_id = ?
       AND previous.decision_type = 'verified_call_billing'
       AND NOT EXISTS (
         SELECT 1
         FROM kaudit_automated_decision newer
         WHERE newer.supersedes_decision_id = previous.id
       )
     ORDER BY previous.decided_at DESC, previous.id DESC
     LIMIT 1 FOR UPDATE`,
    [callId],
  )
  return rows[0]?.id ?? null
}

export async function persistVerifiedBillingDecision(
  pool: Pool,
  options: {
    input: VerifiedBillingInput
    rateCard: PublishedRateCard
    result: VerifiedBillingResult
    correlationId: string | null
  },
): Promise<PersistVerifiedBillingResult> {
  const records = buildVerifiedBillingRecords(
    options.input,
    options.rateCard,
    options.result,
  )
  const connection = await pool.getConnection()
  try {
    await connection.beginTransaction()
    await lockAndValidateRateCard(connection, options.rateCard)

    const duplicate = await findExistingDecision(
      connection,
      records.decision.callId,
      records.decision.inputManifestSha256,
      records.decision.rulesetSha256,
    )
    if (duplicate) {
      if (
        duplicate.decision_output_sha256 !==
        records.decision.decisionOutputSha256
      ) {
        throw new BillingPersistenceIntegrityError(
          'The same billing manifest/ruleset produced different decision bytes',
        )
      }
      await connection.commit()
      return {
        outcome: 'duplicate',
        decisionId: duplicate.id,
        billingCalculationId: duplicate.billing_calculation_id,
      }
    }

    let billingCalculationId: string | null = null
    if (records.calculation && records.component) {
      const [exactRows] =
        await connection.execute<ExistingCalculationRow[]>(
          `SELECT id, decision_trace_sha256
           FROM kaudit_billing_calculation
           WHERE call_id = ? AND rate_card_version_id = ?
             AND engine_version = ? AND input_manifest_sha256 = ?
           FOR UPDATE`,
          [
            records.calculation.callId,
            records.calculation.rateCardVersionId,
            records.calculation.engineVersion,
            records.calculation.inputManifestSha256,
          ],
        )
      const exact = exactRows[0]
      if (exact) {
        if (
          exact.decision_trace_sha256 !==
          records.calculation.decisionTraceSha256
        ) {
          throw new BillingPersistenceIntegrityError(
            'The same billing manifest produced a different calculation trace',
          )
        }
        billingCalculationId = exact.id
      } else {
        billingCalculationId = randomUUID()
        const supersedesCalculationId =
          await findCurrentCalculation(
            connection,
            records.calculation.callId,
          )
        await connection.execute(
          `INSERT INTO kaudit_billing_calculation
             (id, call_id, rate_card_version_id, audit_run_id, engine_version,
              input_manifest_sha256, status, calculation_basis,
              claimed_duration_ms, connected_duration_ms, recorded_duration_ms,
              speech_duration_ms, conversation_end_ms, wrap_up_grace_ms,
              adjusted_chargeable_duration_ms, billable_duration_ms,
              one_way_tail_ms, one_way_tail_alert, subtotal_amount, tax_amount,
              total_amount, currency, ruleset_sha256, trace_object_id,
              decision_trace_json, decision_trace_sha256, calculated_at,
              finalized_at, supersedes_calculation_id)
           VALUES
             (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
              ?, ?, ?, NULL, ?, ?, ?, ?, ?)`,
          [
            billingCalculationId,
            records.calculation.callId,
            records.calculation.rateCardVersionId,
            records.calculation.auditRunId,
            records.calculation.engineVersion,
            records.calculation.inputManifestSha256,
            records.calculation.status,
            records.calculation.calculationBasis,
            records.calculation.claimedDurationMs,
            records.calculation.connectedDurationMs,
            records.calculation.recordedDurationMs,
            records.calculation.speechDurationMs,
            records.calculation.conversationEndMs,
            records.calculation.wrapUpGraceMs,
            records.calculation.adjustedChargeableDurationMs,
            records.calculation.billableDurationMs,
            records.calculation.oneWayTailMs,
            records.calculation.oneWayTailAlert,
            records.calculation.subtotalAmount,
            records.calculation.taxAmount,
            records.calculation.totalAmount,
            records.calculation.currency,
            records.calculation.rulesetSha256,
            records.calculation.decisionTraceJson,
            records.calculation.decisionTraceSha256,
            new Date(records.calculation.calculatedAt),
            new Date(records.calculation.finalizedAt),
            supersedesCalculationId,
          ],
        )
        await connection.execute(
          `INSERT INTO kaudit_billing_component_result
             (id, billing_calculation_id, component_type, rule_code,
              raw_quantity, raw_unit, billable_quantity, billing_increment,
              unit_rate, subtotal_amount, tax_amount, total_amount, currency,
              result_status, explanation_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            randomUUID(),
            billingCalculationId,
            records.component.componentType,
            records.component.ruleCode,
            records.component.rawQuantity,
            records.component.rawUnit,
            records.component.billableQuantity,
            records.component.billingIncrement,
            records.component.unitRate,
            records.component.subtotalAmount,
            records.component.taxAmount,
            records.component.totalAmount,
            records.component.currency,
            records.component.resultStatus,
            records.component.explanationJson,
          ],
        )
      }
    }

    const decisionId = randomUUID()
    const supersedesDecisionId = await findPreviousDecision(
      connection,
      records.decision.callId,
    )
    await connection.execute(
      `INSERT INTO kaudit_automated_decision
         (id, call_id, audit_run_id, billing_calculation_id, decision_type,
          decision_status, reason_code, next_action, sensitivity_tier,
          language_code, finding_type, decision_engine_name,
          decision_engine_version, model_provider, model_name, model_version,
          ruleset_version, ruleset_sha256, classifier_ruleset_version,
          classifier_ruleset_sha256, calibration_version, confidence,
          confidence_threshold, evidence_manifest_sha256, evidence_refs_json,
          input_manifest_sha256, decision_output_json, decision_output_sha256,
          recheck_attempt, decided_at, supersedes_decision_id)
       VALUES
         (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
          ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        decisionId,
        records.decision.callId,
        records.decision.auditRunId,
        billingCalculationId,
        records.decision.decisionType,
        records.decision.decisionStatus,
        records.decision.reasonCode,
        records.decision.nextAction,
        records.decision.sensitivityTier,
        records.decision.languageCode,
        records.decision.findingType,
        records.decision.decisionEngineName,
        records.decision.decisionEngineVersion,
        records.decision.modelProvider,
        records.decision.modelName,
        records.decision.modelVersion,
        records.decision.rulesetVersion,
        records.decision.rulesetSha256,
        records.decision.classifierRulesetVersion,
        records.decision.classifierRulesetSha256,
        records.decision.calibrationVersion,
        records.decision.confidence,
        records.decision.confidenceThreshold,
        records.decision.evidenceManifestSha256,
        records.decision.evidenceRefsJson,
        records.decision.inputManifestSha256,
        records.decision.decisionOutputJson,
        records.decision.decisionOutputSha256,
        records.decision.recheckAttempt,
        new Date(records.decision.decidedAt),
        supersedesDecisionId,
      ],
    )

    const outbox = createMysqlOutboxWriter(connection)
    await outbox.enqueue({
      messageId:
        `verified-billing:${records.decision.inputManifestSha256}:` +
        records.decision.rulesetSha256,
      aggregateType: 'call',
      aggregateId: records.decision.callId,
      eventType:
        records.decision.decisionStatus === 'final'
          ? 'billing.calculation_finalized'
          : 'billing.decision_unresolved',
      payload: {
        callId: records.decision.callId,
        decisionId,
        billingCalculationId,
        status: records.decision.decisionStatus,
        reasonCode: records.decision.reasonCode,
        nextAction: records.decision.nextAction,
        inputManifestSha256:
          records.decision.inputManifestSha256,
        rulesetSha256: records.decision.rulesetSha256,
        decisionOutputSha256:
          records.decision.decisionOutputSha256,
      },
      correlationId: options.correlationId,
    })
    await connection.commit()
    return {
      outcome: 'inserted',
      decisionId,
      billingCalculationId,
    }
  } catch (error) {
    await connection.rollback()
    throw error
  } finally {
    connection.release()
  }
}
