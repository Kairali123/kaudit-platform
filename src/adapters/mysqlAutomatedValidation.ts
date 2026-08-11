import { randomUUID } from 'node:crypto'
import type {
  Pool,
  RowDataPacket,
} from 'mysql2/promise'
import {
  canonicalJson,
  canonicalJsonSha256,
  type JsonValue,
} from '../messaging/canonicalJson.ts'
import type {
  ModelClassification,
  TranscriptSegment,
} from '../reaudit/types.ts'
import type {
  EvidenceHashReference,
  PublishedRateCard,
} from '../billing/types.ts'
import type { ConsensusResult } from '../automation/consensus.ts'
import {
  AUTOMATED_VALIDATION_VERSION,
} from '../automation/consensus.ts'
import {
  CONSENSUS_REVIEWER_RULESET_SHA256,
  CONSENSUS_REVIEWER_VERSION,
} from './openaiConsensus.ts'
import { insertAiUsageEvent } from './mysqlAiUsage.ts'

interface CandidateRow extends RowDataPacket {
  call_id: string
  call_reference: string
  audit_run_id: string
  artifact_id: string
  audio_sha256: string
  transcript_id: string
  transcript_input_sha256: string
  language: string
  asr_provider: string
  asr_model: string
  asr_version: string
  category: ModelClassification['category']
  confidence: string
  conversation_end_ms: number | string | null
  recorded_duration_ms: number | string
  speech_duration_ms: number | string
  connected_duration_ms: number | string | null
  claimed_duration_ms: number | string | null
}

interface SegmentRow extends RowDataPacket {
  start_ms: number | string
  end_ms: number | string
  text: string
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

export interface AutomatedValidationCandidate {
  callId: string
  callReference: string
  auditRunId: string
  artifactId: string
  transcriptId: string
  language: string
  recordedDurationMs: number
  speechDurationMs: number
  connectedDurationMs: number | null
  claimedDurationMs: number | null
  primary: ModelClassification
  segments: TranscriptSegment[]
  evidence: EvidenceHashReference[]
}

export async function loadPublishedRateCard(
  pool: Pool,
  id: string,
): Promise<PublishedRateCard> {
  const [rows] = await pool.execute<RateCardRow[]>(
    `SELECT id, version, status, currency, ruleset_sha256,
            approved_by, approved_at
     FROM kaudit_rate_card_version WHERE id = ?`,
    [id],
  )
  const row = rows[0]
  if (!row || row.currency !== 'INR') {
    throw new Error('Published INR rate card was not found')
  }
  return {
    id: row.id,
    version: row.version,
    status: row.status,
    currency: 'INR',
    rulesetSha256: row.ruleset_sha256,
    approvedBy: row.approved_by,
    approvedAt: row.approved_at?.toISOString() ?? null,
  }
}

export async function collectAutomatedValidationCandidates(
  pool: Pool,
  options: {
    start: string
    end: string
    limit: number
  },
): Promise<AutomatedValidationCandidate[]> {
  const [rows] = await pool.execute<CandidateRow[]>(
    `SELECT
       c.id AS call_id,
       ref.external_id AS call_reference,
       c.latest_audit_run_id AS audit_run_id,
       ca.id AS artifact_id,
       ca.sha256 AS audio_sha256,
       t.id AS transcript_id,
       t.input_sha256 AS transcript_input_sha256,
       COALESCE(t.language, 'unknown') AS language,
       COALESCE(t.provider_name, 'openai') AS asr_provider,
       COALESCE(t.model_name, 'whisper-1') AS asr_model,
       COALESCE(t.model_version, 'whisper-1') AS asr_version,
       c.canonical_outcome_code AS category,
       CAST(finding.confidence AS CHAR) AS confidence,
       ma.conversation_end_ms,
       ma.decoded_duration_ms AS recorded_duration_ms,
       ma.speech_ms AS speech_duration_ms,
       ROUND(connected.quantity_decimal * 1000)
         AS connected_duration_ms,
       ROUND(vendor_minutes.minutes_decimal * 60000)
         AS claimed_duration_ms
     FROM kaudit_call c
     JOIN kaudit_call_external_reference ref
       ON ref.call_id = c.id AND ref.reference_type = 'task_id'
     JOIN kaudit_call_artifact ca
       ON ca.call_id = c.id AND ca.artifact_type = 'recording'
      AND ca.is_final = 1 AND ca.sha256 IS NOT NULL
     JOIN kaudit_transcript t
       ON t.call_id = c.id AND t.call_artifact_id = ca.id
      AND t.status = 'completed'
     JOIN kaudit_media_analysis ma
       ON ma.call_artifact_id = ca.id
      AND ma.status = 'completed'
      AND ma.classification_status = 'completed'
     JOIN kaudit_audit_finding finding
       ON finding.audit_run_id = c.latest_audit_run_id
      AND finding.call_id = c.id
      AND finding.origin = 'model'
     LEFT JOIN kaudit_provider_cost connected
       ON connected.call_id = c.id
      AND connected.provider_sku = 'duration_without_ringing_sec'
      AND connected.is_final = 1
     LEFT JOIN kaudit_provider_cost vendor_minutes
       ON vendor_minutes.call_id = c.id
      AND vendor_minutes.provider_sku =
            'vendor_asserted_billed_minutes'
      AND vendor_minutes.is_final = 1
     WHERE c.billing_period_date BETWEEN ? AND ?
       AND c.latest_audit_run_id IS NOT NULL
       AND NOT EXISTS (
         SELECT 1
         FROM kaudit_billing_calculation calculation
         WHERE calculation.call_id = c.id
           AND calculation.status = 'final'
           AND calculation.calculation_basis =
                 'independent_conversation_end'
           AND NOT EXISTS (
             SELECT 1
             FROM kaudit_billing_calculation newer
             WHERE newer.supersedes_calculation_id = calculation.id
           )
       )
       AND t.id = (
         SELECT latest_t.id
         FROM kaudit_transcript latest_t
         WHERE latest_t.call_id = c.id
           AND latest_t.call_artifact_id = ca.id
           AND latest_t.status = 'completed'
         ORDER BY latest_t.created_at DESC, latest_t.id DESC
         LIMIT 1
       )
       AND ma.id = (
         SELECT latest_ma.id
         FROM kaudit_media_analysis latest_ma
         WHERE latest_ma.call_artifact_id = ca.id
           AND latest_ma.status = 'completed'
           AND latest_ma.classification_status = 'completed'
         ORDER BY latest_ma.created_at DESC, latest_ma.id DESC
         LIMIT 1
       )
     ORDER BY ref.external_id
     LIMIT ?`,
    [options.start, options.end, options.limit],
  )
  const result: AutomatedValidationCandidate[] = []
  for (const row of rows) {
    const [segmentRows] = await pool.execute<SegmentRow[]>(
      `SELECT start_ms, end_ms, text
       FROM kaudit_transcript_segment
       WHERE transcript_id = ?
       ORDER BY start_ms, end_ms, id`,
      [row.transcript_id],
    )
    const segments = segmentRows.map((segment) => ({
      startMs: Number(segment.start_ms),
      endMs: Number(segment.end_ms),
      text: segment.text,
    }))
    const transcriptSha256 = canonicalJsonSha256(
      segments as unknown as JsonValue,
    )
    result.push({
      callId: row.call_id,
      callReference: row.call_reference,
      auditRunId: row.audit_run_id,
      artifactId: row.artifact_id,
      transcriptId: row.transcript_id,
      language: row.language,
      recordedDurationMs: Number(row.recorded_duration_ms),
      speechDurationMs: Number(row.speech_duration_ms),
      connectedDurationMs:
        row.connected_duration_ms == null
          ? null
          : Number(row.connected_duration_ms),
      claimedDurationMs:
        row.claimed_duration_ms == null
          ? null
          : Number(row.claimed_duration_ms),
      primary: {
        model: {
          provider: 'openai',
          name: 'gpt-4o-mini-2024-07-18',
          version: 'gpt-4o-mini-2024-07-18',
        },
        category: row.category,
        confidence: row.confidence,
        customerBlockNumbers: [],
        unclearBlockNumbers: [],
        customerSpoke: row.conversation_end_ms != null,
        lastMeaningfulCustomerExchangeMs:
          row.conversation_end_ms == null
            ? null
            : Number(row.conversation_end_ms),
        remarks: '',
        disputeRecommended: false,
      },
      segments,
      evidence: [
        {
          kind: 'audio',
          referenceId: row.artifact_id,
          sha256: row.audio_sha256,
        },
        {
          kind: 'transcript',
          referenceId: row.transcript_id,
          sha256: transcriptSha256,
        },
      ],
    })
  }
  return result
}

export async function persistAutomatedValidation(
  pool: Pool,
  options: {
    candidate: AutomatedValidationCandidate
    secondary: ModelClassification
    adjudicator: ModelClassification | null
    consensus: ConsensusResult
    decidedAt: string
  },
): Promise<'inserted' | 'duplicate'> {
  const { candidate, secondary, adjudicator, consensus } = options
  const output = {
    schemaVersion: '1',
    policy: {
      version: consensus.version,
      threshold: consensus.threshold,
      meaning:
        'Automated model-consensus validation; not human-labeled ground truth.',
    },
    primary: {
      model: candidate.primary.model,
      category: candidate.primary.category,
      confidence: candidate.primary.confidence,
      customerSpoke: candidate.primary.customerSpoke,
      lastMeaningfulCustomerExchangeMs:
        candidate.primary.lastMeaningfulCustomerExchangeMs,
      billableDurationMs: consensus.primaryBillableDurationMs,
    },
    secondary: {
      model: secondary.model,
      reviewerVersion: CONSENSUS_REVIEWER_VERSION,
      reviewerRulesetSha256: CONSENSUS_REVIEWER_RULESET_SHA256,
      category: secondary.category,
      confidence: secondary.confidence,
      customerSpoke: secondary.customerSpoke,
      lastMeaningfulCustomerExchangeMs:
        secondary.lastMeaningfulCustomerExchangeMs,
      billableDurationMs: consensus.secondaryBillableDurationMs,
    },
    adjudicator: adjudicator
      ? {
          model: adjudicator.model,
          category: adjudicator.category,
          confidence: adjudicator.confidence,
          customerSpoke: adjudicator.customerSpoke,
          lastMeaningfulCustomerExchangeMs:
            adjudicator.lastMeaningfulCustomerExchangeMs,
          billableDurationMs:
            consensus.adjudicatorBillableDurationMs,
        }
      : null,
    outcome: {
      status: consensus.status,
      reasons: consensus.reasons,
      effectiveConfidence: consensus.effectiveConfidence,
      selectedSource: consensus.selectedSource,
    },
  }
  const evidenceRefsJson = canonicalJson(
    candidate.evidence as unknown as JsonValue,
  )
  const evidenceManifestSha256 = canonicalJsonSha256(
    candidate.evidence as unknown as JsonValue,
  )
  const inputManifestSha256 = canonicalJsonSha256({
    callId: candidate.callId,
    auditRunId: candidate.auditRunId,
    evidenceManifestSha256,
    primary: output.primary,
    secondary: output.secondary,
    adjudicator: output.adjudicator,
    policy: output.policy,
  } as unknown as JsonValue)
  const decisionOutputJson = canonicalJson(
    output as unknown as JsonValue,
  )
  const decisionOutputSha256 = canonicalJsonSha256(
    output as unknown as JsonValue,
  )
  const rulesetSha256 = canonicalJsonSha256({
    version: AUTOMATED_VALIDATION_VERSION,
    threshold: consensus.threshold,
    checks: [
      'category_exact',
      'customer_spoke_exact',
      'rounded_billable_duration_exact',
      'both_confidence_at_or_above_floor',
    ],
  } as unknown as JsonValue)
  const connection = await pool.getConnection()
  try {
    await connection.beginTransaction()
    const [existing] = await connection.execute<RowDataPacket[]>(
      `SELECT id, decision_output_sha256
       FROM kaudit_automated_decision
       WHERE call_id = ?
         AND decision_type = 'automated_consensus_validation'
         AND input_manifest_sha256 = ?
         AND ruleset_sha256 = ?
       FOR UPDATE`,
      [candidate.callId, inputManifestSha256, rulesetSha256],
    )
    if (existing[0]) {
      if (
        existing[0].decision_output_sha256 !==
        decisionOutputSha256
      ) {
        throw new Error(
          'Identical consensus input produced different output bytes',
        )
      }
      await connection.commit()
      return 'duplicate'
    }
    const [previous] = await connection.execute<RowDataPacket[]>(
      `SELECT prior.id
       FROM kaudit_automated_decision prior
       WHERE prior.call_id = ?
         AND prior.decision_type =
               'automated_consensus_validation'
         AND NOT EXISTS (
           SELECT 1 FROM kaudit_automated_decision newer
           WHERE newer.supersedes_decision_id = prior.id
         )
       ORDER BY prior.decided_at DESC, prior.id DESC
       LIMIT 1 FOR UPDATE`,
      [candidate.callId],
    )
    await connection.execute(
      `INSERT INTO kaudit_automated_decision
         (id, call_id, audit_run_id, billing_calculation_id,
          decision_type, decision_status, reason_code, next_action,
          sensitivity_tier, language_code, finding_type,
          decision_engine_name, decision_engine_version,
          model_provider, model_name, model_version,
          ruleset_version, ruleset_sha256,
          classifier_ruleset_version, classifier_ruleset_sha256,
          calibration_version, confidence, confidence_threshold,
          evidence_manifest_sha256, evidence_refs_json,
          input_manifest_sha256, decision_output_json,
          decision_output_sha256, recheck_attempt, decided_at,
          supersedes_decision_id)
       VALUES
         (?, ?, ?, NULL, 'automated_consensus_validation', ?, ?, ?,
          'K0', ?, 'category_and_billable_duration',
          'kairali-automated-consensus', ?, 'openai', ?, ?, ?, ?, ?,
          ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      [
        randomUUID(),
        candidate.callId,
        candidate.auditRunId,
        consensus.status === 'accepted' ? 'final' : 'unresolved',
        consensus.status === 'accepted'
          ? 'AUTOMATED_CONSENSUS_ACCEPTED'
          : 'AUTOMATED_CONSENSUS_DISAGREEMENT',
        consensus.status === 'accepted'
          ? null
          : 'retry_automated_consensus',
        candidate.language,
        AUTOMATED_VALIDATION_VERSION,
        secondary.model.name,
        secondary.model.version,
        AUTOMATED_VALIDATION_VERSION,
        rulesetSha256,
        CONSENSUS_REVIEWER_VERSION,
        CONSENSUS_REVIEWER_RULESET_SHA256,
        AUTOMATED_VALIDATION_VERSION,
        consensus.effectiveConfidence,
        consensus.threshold,
        evidenceManifestSha256,
        evidenceRefsJson,
        inputManifestSha256,
        decisionOutputJson,
        decisionOutputSha256,
        new Date(options.decidedAt),
        previous[0]?.id ?? null,
      ],
    )
    if (secondary.usage) {
      await insertAiUsageEvent(connection, {
        auditRunId: candidate.auditRunId,
        callId: candidate.callId,
        operation: 'classification',
        passName: 'consensus_secondary',
        providerName: secondary.model.provider,
        modelName: secondary.model.name,
        modelVersion: secondary.model.version,
        usage: secondary.usage,
        recordedAt: new Date(options.decidedAt),
      })
    }
    if (adjudicator?.usage) {
      await insertAiUsageEvent(connection, {
        auditRunId: candidate.auditRunId,
        callId: candidate.callId,
        operation: 'classification',
        passName: 'consensus_adjudicator',
        providerName: adjudicator.model.provider,
        modelName: adjudicator.model.name,
        modelVersion: adjudicator.model.version,
        usage: adjudicator.usage,
        recordedAt: new Date(options.decidedAt),
      })
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

interface ValidationDecisionRow extends RowDataPacket {
  id: string
  call_id: string
  audit_run_id: string
  decision_output_json: string | Record<string, unknown>
  decision_output_sha256: string
  evidence_refs_json: string
}

export async function finalizeAutomatedFindingStates(
  pool: Pool,
  period: { start: string; end: string },
): Promise<{
  confirmed: number
  rejected: number
  insertedReplacement: number
}> {
  const [decisions] = await pool.execute<ValidationDecisionRow[]>(
    `SELECT decision_row.id, decision_row.call_id,
            decision_row.audit_run_id,
            decision_row.decision_output_json,
            decision_row.decision_output_sha256,
            decision_row.evidence_refs_json
     FROM kaudit_automated_decision decision_row
     JOIN kaudit_call c ON c.id = decision_row.call_id
     WHERE c.billing_period_date BETWEEN ? AND ?
       AND decision_row.decision_type =
             'automated_consensus_validation'
       AND decision_row.decision_status = 'final'
       AND decision_row.audit_run_id IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM kaudit_automated_decision newer
         WHERE newer.supersedes_decision_id = decision_row.id
       )`,
    [period.start, period.end],
  )
  const summary = {
    confirmed: 0,
    rejected: 0,
    insertedReplacement: 0,
  }
  for (const decision of decisions) {
    const output = (
      typeof decision.decision_output_json === 'string'
        ? JSON.parse(decision.decision_output_json)
        : decision.decision_output_json
    ) as {
      outcome: {
        selectedSource:
          | 'primary'
          | 'secondary'
          | 'adjudicator'
      }
      primary: {
        category: string
        confidence: string
        model: unknown
      }
      secondary: {
        category: string
        confidence: string
        model: unknown
      }
      adjudicator: {
        category: string
        confidence: string
        model: unknown
      } | null
      policy: { version: string }
    }
    const selected = output[output.outcome.selectedSource]
    if (!selected) {
      throw new Error(
        'Final automated consensus decision has no selected output',
      )
    }
    const connection = await pool.getConnection()
    try {
      await connection.beginTransaction()
      const [findingRows] = await connection.execute<RowDataPacket[]>(
        `SELECT id, finding_code, status, confirmation_status,
                root_cause_status
         FROM kaudit_audit_finding
         WHERE call_id = ? AND audit_run_id = ? AND origin = 'model'
         ORDER BY created_at, id FOR UPDATE`,
        [decision.call_id, decision.audit_run_id],
      )
      const primaryFinding = findingRows[0]
      if (!primaryFinding) {
        throw new Error(
          'Automated consensus cannot resolve a missing primary finding',
        )
      }
      const sameCategory =
        primaryFinding.finding_code === selected.category
      const beforeHash = canonicalJsonSha256({
        id: primaryFinding.id,
        findingCode: primaryFinding.finding_code,
        status: primaryFinding.status,
        confirmationStatus:
          primaryFinding.confirmation_status,
        rootCauseStatus: primaryFinding.root_cause_status,
      } as unknown as JsonValue)
      if (sameCategory) {
        await connection.execute(
          `UPDATE kaudit_audit_finding
           SET status = 'closed',
               confirmation_status = 'confirmed',
               root_cause_status = 'confirmed'
           WHERE id = ?`,
          [primaryFinding.id],
        )
        summary.confirmed += 1
      } else {
        await connection.execute(
          `UPDATE kaudit_audit_finding
           SET status = 'closed',
               confirmation_status = 'rejected',
               root_cause_status = 'rejected'
           WHERE id = ?`,
          [primaryFinding.id],
        )
        summary.rejected += 1
        const [replacementRows] =
          await connection.execute<RowDataPacket[]>(
            `SELECT id
             FROM kaudit_audit_finding
             WHERE call_id = ? AND audit_run_id = ?
               AND finding_code = ?
               AND confirmation_status = 'confirmed'
               AND JSON_UNQUOTE(JSON_EXTRACT(
                     signal_values_json,
                     '$.automatedConsensusDecisionId'
                   )) = ?
             LIMIT 1`,
            [
              decision.call_id,
              decision.audit_run_id,
              selected.category,
              decision.id,
            ],
          )
        if (!replacementRows[0]) {
          await connection.execute(
            `INSERT INTO kaudit_audit_finding
               (id, audit_run_id, call_id, finding_code, severity,
                origin, confidence, status, confirmation_status,
                root_cause_status, evidence_refs_json,
                signal_values_json, billing_relevance, explanation)
             VALUES (?, ?, ?, ?, 'medium', 'model', ?, 'closed',
                     'confirmed', 'confirmed', ?, ?,
                     'duration_input', ?)`,
            [
              randomUUID(),
              decision.audit_run_id,
              decision.call_id,
              selected.category,
              selected.confidence,
              decision.evidence_refs_json,
              canonicalJson({
                automatedConsensusDecisionId: decision.id,
                automatedConsensusDecisionSha256:
                  decision.decision_output_sha256,
                validationVersion: output.policy.version,
                selectedSource:
                  output.outcome.selectedSource,
                selectedModel: selected.model as JsonValue,
              }),
              'Finalized by leadership-approved automated model consensus; no manual review.',
            ],
          )
          summary.insertedReplacement += 1
        }
      }
      const afterHash = canonicalJsonSha256({
        automatedConsensusDecisionId: decision.id,
        selectedCategory: selected.category,
        selectedConfidence: selected.confidence,
        confirmationStatus: 'confirmed',
        rejectedPrimaryCategory: sameCategory
          ? null
          : primaryFinding.finding_code,
      } as unknown as JsonValue)
      await connection.execute(
        `INSERT INTO kaudit_audit_log
           (id, actor_email, action, resource_type, resource_id,
            before_hash, after_hash, client, correlation_id)
         VALUES (?, NULL, 'automated_finding_finalized',
                 'audit_finding', ?, ?, ?,
                 'kairali-automated-consensus', ?)`,
        [
          randomUUID(),
          primaryFinding.id,
          beforeHash,
          afterHash,
          `automated-consensus:${decision.id}`,
        ],
      )
      await connection.commit()
    } catch (error) {
      await connection.rollback()
      throw error
    } finally {
      connection.release()
    }
  }
  return summary
}
