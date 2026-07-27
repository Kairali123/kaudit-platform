import { test } from 'node:test'
import assert from 'node:assert/strict'
import mysql, { type RowDataPacket } from 'mysql2/promise'
import {
  calculateVerifiedKServeCharge,
} from '../billing/calculateVerifiedCharge.ts'
import { KSERVE_RULESET_SHA256 } from '../billing/kserveRules.ts'
import type {
  PublishedRateCard,
  VerifiedBillingInput,
} from '../billing/types.ts'
import { persistVerifiedBillingDecision } from './mysqlVerifiedBilling.ts'

const socketPath = process.env.KAUDIT_TEST_MYSQL_SOCKET
const safeSocket =
  socketPath?.startsWith('/tmp/kaudit-') &&
  socketPath.endsWith('/mysql.sock')
    ? socketPath
    : null

const CALL_ID = 'synthetic-billing-call'
const AUDIT_RUN_ID = 'synthetic-billing-audit'
const LEGACY_CALC_ID = 'synthetic-legacy-calculation'
const RATE_CARD_ID = 'rcv-2026-02-28-v1'

test(
  'verified billing persists append-only, traceable, and idempotent',
  { skip: safeSocket == null },
  async () => {
    const pool = mysql.createPool({
      socketPath: safeSocket as string,
      user: 'root',
      database: 'kaudit_verify',
      connectionLimit: 4,
      timezone: 'Z',
      decimalNumbers: false,
    })
    try {
      const [accountRows] = await pool.query<RowDataPacket[]>(
        `SELECT id FROM kaudit_vendor_account ORDER BY id LIMIT 1`,
      )
      const vendorAccountId = String(accountRows[0]?.id ?? '')
      assert.ok(vendorAccountId)

      await pool.execute(
        `UPDATE kaudit_rate_card_version
         SET status = 'published', ruleset_sha256 = ?,
             approved_by = 'finance-approver@example.test',
             approved_at = '2026-07-27 10:00:00.000000'
         WHERE id = ?`,
        [KSERVE_RULESET_SHA256, RATE_CARD_ID],
      )
      await pool.execute(
        `INSERT INTO kaudit_call
           (id, vendor_account_id, logical_call_key, sensitivity_tier,
            processing_status)
         VALUES (?, ?, ?, 'K1', 'audited')`,
        [CALL_ID, vendorAccountId, CALL_ID],
      )
      await pool.execute(
        `INSERT INTO kaudit_audit_run
           (id, call_id, engine_version, input_manifest_sha256, status,
            completed_at)
         VALUES (?, ?, 'synthetic-audit/1', ?, 'completed',
                 '2026-07-27 10:20:00.000000')`,
        [AUDIT_RUN_ID, CALL_ID, 'c'.repeat(64)],
      )
      await pool.execute(
        `INSERT INTO kaudit_billing_calculation
           (id, call_id, rate_card_version_id, engine_version, status,
            billable_duration_ms, subtotal_amount, tax_amount, total_amount,
            currency)
         VALUES (?, ?, ?, 'legacy/1', 'calculated', 180000,
                 '28.50000000', '0.00000000', '28.50000000', 'INR')`,
        [LEGACY_CALC_ID, CALL_ID, RATE_CARD_ID],
      )

      const rateCard: PublishedRateCard = {
        id: RATE_CARD_ID,
        version: '2026-02-28.1',
        status: 'published',
        currency: 'INR',
        rulesetSha256: KSERVE_RULESET_SHA256,
        approvedBy: 'finance-approver@example.test',
        approvedAt: '2026-07-27T10:00:00.000Z',
      }
      const input: VerifiedBillingInput = {
        callId: CALL_ID,
        auditRunId: AUDIT_RUN_ID,
        claimedDurationMs: 200_000,
        connectedDurationMs: 190_000,
        recordedDurationMs: 180_000,
        speechDurationMs: 70_000,
        conversationAssessment: 'established',
        lastMeaningfulCustomerExchangeMs: 61_000,
        model: {
          provider: 'synthetic',
          name: 'synthetic-classifier',
          version: '1',
        },
        classifierRulesetVersion: 'synthetic-classifier/1',
        classifierRulesetSha256: 'b'.repeat(64),
        evidence: [
          {
            kind: 'audio',
            referenceId: 'synthetic-audio',
            sha256: 'a'.repeat(64),
          },
        ],
        authority: {
          calibrationVersion: 'synthetic-calibration/1',
          calibrationComplete: true,
          confidence: '0.95000000',
          threshold: '0.85000000',
          language: 'English',
          findingType: 'conversation_end',
          sensitivityTier: 'K1',
          k23AutomationEnabled: false,
          clinicalSafetyOwner: null,
          recheckAttempt: 0,
          maximumRechecks: 2,
        },
        calculatedAt: '2026-07-27T10:30:00.000Z',
      }
      const result = calculateVerifiedKServeCharge(input, rateCard)
      assert.equal(result.status, 'final')

      const first = await persistVerifiedBillingDecision(pool, {
        input,
        rateCard,
        result,
        correlationId: 'synthetic-correlation',
      })
      const replay = await persistVerifiedBillingDecision(pool, {
        input,
        rateCard,
        result,
        correlationId: 'synthetic-correlation',
      })
      assert.equal(first.outcome, 'inserted')
      assert.equal(replay.outcome, 'duplicate')
      assert.equal(replay.decisionId, first.decisionId)
      assert.equal(
        replay.billingCalculationId,
        first.billingCalculationId,
      )

      const [rows] = await pool.query<RowDataPacket[]>(
        `SELECT
           (SELECT COUNT(*) FROM kaudit_billing_calculation
             WHERE call_id = ?) AS calculations,
           (SELECT COUNT(*) FROM kaudit_billing_component_result component
             JOIN kaudit_billing_calculation calculation
               ON calculation.id = component.billing_calculation_id
             WHERE calculation.call_id = ?) AS components,
           (SELECT COUNT(*) FROM kaudit_automated_decision
             WHERE call_id = ?) AS decisions,
           (SELECT COUNT(*) FROM kaudit_outbox_message
             WHERE aggregate_id = ?
               AND event_type = 'billing.calculation_finalized') AS messages,
           (SELECT COUNT(*) FROM kaudit_billing_calculation
             WHERE supersedes_calculation_id = ?) AS superseders`,
        [CALL_ID, CALL_ID, CALL_ID, CALL_ID, LEGACY_CALC_ID],
      )
      assert.equal(Number(rows[0]?.calculations), 2)
      assert.equal(Number(rows[0]?.components), 1)
      assert.equal(Number(rows[0]?.decisions), 1)
      assert.equal(Number(rows[0]?.messages), 1)
      assert.equal(Number(rows[0]?.superseders), 1)

      const [decisionRows] = await pool.query<RowDataPacket[]>(
        `SELECT decision_status, model_name, confidence,
                evidence_manifest_sha256, decision_output_sha256
         FROM kaudit_automated_decision
         WHERE call_id = ?`,
        [CALL_ID],
      )
      assert.equal(decisionRows[0]?.decision_status, 'final')
      assert.equal(decisionRows[0]?.model_name, 'synthetic-classifier')
      assert.equal(String(decisionRows[0]?.confidence), '0.95000000')
      assert.match(
        String(decisionRows[0]?.evidence_manifest_sha256),
        /^[a-f0-9]{64}$/,
      )
      assert.match(
        String(decisionRows[0]?.decision_output_sha256),
        /^[a-f0-9]{64}$/,
      )
    } finally {
      await pool.execute(
        `DELETE FROM kaudit_outbox_message WHERE aggregate_id = ?`,
        [CALL_ID],
      )
      await pool.execute(
        `DELETE FROM kaudit_automated_decision WHERE call_id = ?`,
        [CALL_ID],
      )
      await pool.execute(
        `DELETE component
         FROM kaudit_billing_component_result component
         JOIN kaudit_billing_calculation calculation
           ON calculation.id = component.billing_calculation_id
         WHERE calculation.call_id = ?`,
        [CALL_ID],
      )
      await pool.execute(
        `DELETE FROM kaudit_billing_calculation WHERE call_id = ?`,
        [CALL_ID],
      )
      await pool.execute(
        `DELETE FROM kaudit_audit_run WHERE id = ?`,
        [AUDIT_RUN_ID],
      )
      await pool.execute(
        `DELETE FROM kaudit_call WHERE id = ?`,
        [CALL_ID],
      )
      await pool.execute(
        `UPDATE kaudit_rate_card_version
         SET status = 'draft', ruleset_sha256 = NULL,
             approved_by = NULL, approved_at = NULL
         WHERE id = ?`,
        [RATE_CARD_ID],
      )
      await pool.end()
    }
  },
)
