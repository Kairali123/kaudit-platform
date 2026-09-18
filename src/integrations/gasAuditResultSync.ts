import type { Pool, RowDataPacket } from 'mysql2/promise'
import { createMysqlReauditWriteRepo } from '../adapters/mysqlReauditWriteRepo.ts'
import {
  collectAutomatedValidationCandidates,
  loadPublishedRateCard,
} from '../adapters/mysqlAutomatedValidation.ts'
import { persistVerifiedBillingRecords } from '../adapters/mysqlVerifiedBilling.ts'
import { runAutomatedValidation } from '../automation/validationRun.ts'
import { buildAcceptedAsBilledRecords } from '../billing/acceptedAsBilled.ts'
import { resolveCategoryCharge } from '../billing/categoryChargePolicy.ts'
import {
  mergeTranscriptSegments,
  projectVerifiedCharge,
  validateClassification,
} from '../reaudit/core.ts'
import type {
  ClassificationDecisionSignals,
  ModelClassification,
  ReauditAnalysis,
  ReauditCandidate,
  ReauditItemResult,
  TranscriptSegment,
  TranscriptionResult,
} from '../reaudit/types.ts'
import type { EvidenceHashReference } from '../billing/types.ts'

const SHA256 = /^[a-f0-9]{64}$/
const MONTH = /^(\d{4})-(\d{2})$/
const TASK_ID = /^[A-Za-z0-9._:-]{1,128}$/

interface CandidateRow extends RowDataPacket {
  call_id: string
  artifact_id: string | null
  source_url: string | null
  artifact_sha256: string | null
  connected_duration_ms: number | string | null
  claimed_duration_ms: number | string | null
  vendor_billed_minutes: string | null
  vendor_billed_amount: string | null
}

type Raw = Record<string, unknown>

export interface GasAuditSyncItemReceipt {
  taskId: string
  status: 'imported' | 'duplicate' | 'rejected'
  code?: string
}

export interface GasAuditSyncReceipt {
  batchId: string
  items: GasAuditSyncItemReceipt[]
}

export interface GasAuditSyncRequest {
  batchId: string
  billMonth: string
  bodySha256: string
  body: unknown
  rateCardId: string
  correlationId: string | null
}

function record(value: unknown, name: string): Raw {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`)
  }
  return value as Raw
}

function text(value: unknown, name: string, max = 1_200): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) {
    throw new TypeError(`${name} is invalid`)
  }
  return value.trim()
}

function optionalText(value: unknown, max = 1_200): string | null {
  if (value == null || value === '') return null
  if (typeof value !== 'string' || value.length > max) {
    throw new TypeError('optional text is invalid')
  }
  return value
}

function number(value: unknown, name: string): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) throw new TypeError(`${name} is invalid`)
  return parsed
}

function integer(value: unknown, name: string): number {
  const parsed = number(value, name)
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new TypeError(`${name} is invalid`)
  }
  return parsed
}

function blockNumbers(value: unknown): number[] {
  if (!Array.isArray(value)) throw new TypeError('block numbers are invalid')
  return value.map((item) => integer(item, 'block number'))
}

function monthBounds(month: string): { start: string; end: string } {
  const match = MONTH.exec(month)
  if (!match) throw new TypeError('bill_month is invalid')
  const year = Number(match[1])
  const index = Number(match[2])
  if (index < 1 || index > 12) throw new TypeError('bill_month is invalid')
  const end = new Date(Date.UTC(year, index, 0)).getUTCDate()
  return {
    start: `${match[1]}-${match[2]}-01`,
    end: `${match[1]}-${match[2]}-${String(end).padStart(2, '0')}`,
  }
}

function decimal8(value: unknown, name: string): string {
  const parsed = number(value, name)
  if (parsed < 0) throw new TypeError(`${name} is invalid`)
  return parsed.toFixed(8)
}

function segmentsFromAudit(audit: Raw): TranscriptSegment[] {
  const transcript = record(audit.transcript, 'audit.transcript')
  if (!Array.isArray(transcript.segments) || transcript.segments.length === 0) {
    throw new TypeError('audit transcript segments are required')
  }
  return transcript.segments.map((entry, index) => {
    const segment = record(entry, `segment ${index}`)
    const startMs = Math.max(0, Math.round(number(segment.start_seconds, 'segment start') * 1_000))
    const endMs = Math.max(0, Math.round(number(segment.end_seconds, 'segment end') * 1_000))
    if (endMs < startMs) throw new TypeError('segment end precedes start')
    return {
      startMs,
      endMs,
      text: text(segment.text, 'segment text', 8_000),
    }
  })
}

function signals(raw: Raw): ClassificationDecisionSignals {
  return {
    counterpartyType: text(raw.counterparty_type, 'counterparty_type') as ClassificationDecisionSignals['counterpartyType'],
    agentHandling: text(raw.agent_handling, 'agent_handling') as ClassificationDecisionSignals['agentHandling'],
    conversationOutcome: text(raw.conversation_outcome, 'conversation_outcome') as ClassificationDecisionSignals['conversationOutcome'],
    durationOutcome: text(raw.duration_outcome, 'duration_outcome') as ClassificationDecisionSignals['durationOutcome'],
    stopIntent: text(raw.stop_intent, 'stop_intent') as NonNullable<ClassificationDecisionSignals['stopIntent']>,
    postStopBehavior: text(raw.post_stop_behavior, 'post_stop_behavior') as NonNullable<ClassificationDecisionSignals['postStopBehavior']>,
    successfulOutcome: text(raw.successful_outcome, 'successful_outcome') as NonNullable<ClassificationDecisionSignals['successfulOutcome']>,
    voicemailEvidence: text(raw.voicemail_evidence, 'voicemail_evidence') as NonNullable<ClassificationDecisionSignals['voicemailEvidence']>,
    automationEvidence: text(raw.automation_evidence, 'automation_evidence') as NonNullable<ClassificationDecisionSignals['automationEvidence']>,
    junkEvidence: text(raw.junk_evidence, 'junk_evidence') as NonNullable<ClassificationDecisionSignals['junkEvidence']>,
    agentFailureMode: text(raw.agent_failure_mode, 'agent_failure_mode') as NonNullable<ClassificationDecisionSignals['agentFailureMode']>,
    meaningfulServiceBeforeFailure:
      raw.meaningful_service_before_failure === true,
  }
}

function classificationFromGas(rawValue: unknown): ModelClassification {
  const raw = record(rawValue, 'classification')
  const confidence = number(raw.confidence, 'confidence')
  const model = optionalText(raw.model, 128) ?? 'gpt-4o-mini-2024-07-18'
  return {
    model: { provider: 'openai', name: model, version: model },
    category: text(raw.category_code, 'category_code') as ModelClassification['category'],
    confidence: confidence.toFixed(8),
    customerBlockNumbers: blockNumbers(raw.customer_block_numbers),
    unclearBlockNumbers: blockNumbers(raw.unclear_block_numbers),
    agentBlockNumbers: blockNumbers(raw.agent_block_numbers),
    voicemailEvidenceBlockNumbers:
      blockNumbers(raw.voicemail_evidence_block_numbers),
    automationEvidenceBlockNumbers:
      blockNumbers(raw.automation_evidence_block_numbers),
    junkEvidenceBlockNumbers: blockNumbers(raw.junk_evidence_block_numbers),
    businessRelevantCustomerBlockNumbers:
      blockNumbers(raw.business_relevant_customer_block_numbers),
    customerSpoke: raw.customer_spoke === true,
    lastMeaningfulCustomerExchangeMs: null,
    agentFailureStartBlockNumber:
      integer(raw.agent_failure_start_block_number, 'failure block') || null,
    remarks: optionalText(raw.reasoning_summary, 1_200) ??
      'Structured GAS audit result imported without model prose.',
    disputeRecommended: raw.dispute_recommended === true,
    decisionSignals: signals(raw),
  }
}

function roleSpeech(
  blocks: ReturnType<typeof mergeTranscriptSegments>,
  classification: ModelClassification,
): { customer: number; agent: number } {
  const customer = new Set(classification.customerBlockNumbers)
  const agent = new Set(classification.agentBlockNumbers ?? [])
  return blocks.reduce(
    (result, block) => {
      const duration = Math.max(0, block.endMs - block.startMs)
      if (customer.has(block.number)) result.customer += duration
      else if (agent.has(block.number)) result.agent += duration
      return result
    },
    { customer: 0, agent: 0 },
  )
}

async function candidateForTask(
  pool: Pool,
  taskId: string,
  bounds: { start: string; end: string },
): Promise<ReauditCandidate & {
  callId: string
  vendorBilledAmount: string | null
}> {
  const [rows] = await pool.execute<CandidateRow[]>(
    `SELECT c.id AS call_id, ca.id AS artifact_id, ca.source_url,
            ca.sha256 AS artifact_sha256,
            ROUND(connected.quantity_decimal * 1000) AS connected_duration_ms,
            ROUND(vendor_minutes.minutes_decimal * 60000) AS claimed_duration_ms,
            CAST(vendor_minutes.minutes_decimal AS CHAR) AS vendor_billed_minutes,
            CAST(vendor_amount.quantity_decimal AS CHAR) AS vendor_billed_amount
     FROM kaudit_call c
     JOIN kaudit_call_external_reference ref
       ON ref.call_id = c.id AND ref.reference_type = 'task_id'
      AND ref.external_id = ?
     LEFT JOIN kaudit_call_artifact ca
       ON ca.call_id = c.id AND ca.artifact_type = 'recording' AND ca.is_final = 1
      AND ca.id = (
        SELECT latest.id
        FROM kaudit_call_artifact latest
        WHERE latest.call_id = c.id
          AND latest.artifact_type = 'recording'
          AND latest.is_final = 1
        ORDER BY latest.created_at DESC, latest.id DESC
        LIMIT 1
      )
     LEFT JOIN (
       SELECT call_id, MAX(quantity_decimal) AS quantity_decimal
       FROM kaudit_provider_cost
       WHERE provider_sku = 'duration_without_ringing_sec' AND is_final = 1
       GROUP BY call_id
     ) connected
       ON connected.call_id = c.id
     LEFT JOIN (
       SELECT call_id, MAX(minutes_decimal) AS minutes_decimal
       FROM kaudit_provider_cost
       WHERE provider_sku = 'vendor_asserted_billed_minutes' AND is_final = 1
       GROUP BY call_id
     ) vendor_minutes
       ON vendor_minutes.call_id = c.id
     LEFT JOIN (
       SELECT call_id, MAX(quantity_decimal) AS quantity_decimal
       FROM kaudit_provider_cost
       WHERE provider_sku = 'vendor_asserted_billed_amount' AND is_final = 1
       GROUP BY call_id
     ) vendor_amount
       ON vendor_amount.call_id = c.id
     WHERE c.billing_period_date BETWEEN ? AND ?
     LIMIT 1`,
    [taskId, bounds.start, bounds.end],
  )
  const row = rows[0]
  if (!row) throw new Error('TASK_NOT_FOUND')
  return {
    callId: row.call_id,
    artifactId: row.artifact_id ?? '',
    sourceUrl: row.source_url ?? '',
    baselineSha256: row.artifact_sha256,
    claimedDurationMs:
      row.claimed_duration_ms == null ? null : Number(row.claimed_duration_ms),
    connectedDurationMs:
      row.connected_duration_ms == null
        ? null
        : Number(row.connected_duration_ms),
    vendorBilledMinutes: row.vendor_billed_minutes,
    vendorBilledAmount: row.vendor_billed_amount,
  }
}

function buildPrimaryResult(options: {
  candidate: ReauditCandidate
  audit: Raw
  evidenceSha256: string
}): ReauditItemResult {
  const segments = segmentsFromAudit(options.audit)
  const blocks = mergeTranscriptSegments(segments)
  const transcriptRaw = record(options.audit.transcript, 'audit.transcript')
  const recordedDurationMs = Math.max(
    integer(
      Math.round(number(transcriptRaw.duration_seconds, 'duration') * 1_000),
      'duration',
    ),
    ...segments.map((segment) => segment.endMs),
  )
  const durationMismatch =
    options.candidate.connectedDurationMs != null &&
    Math.abs(options.candidate.connectedDurationMs - recordedDurationMs) > 5_000
  const classification = validateClassification(
    classificationFromGas(options.audit.primary),
    blocks,
    recordedDurationMs,
    { durationMismatch },
  )
  const charge = resolveCategoryCharge({
    category: classification.category,
    recordedDurationMs,
    lastCustomerExchangeMs: classification.lastMeaningfulCustomerExchangeMs,
    lastAgentExchangeMs: classification.lastMeaningfulAgentExchangeMs ?? null,
    lastVoicemailExchangeMs:
      classification.lastVoicemailExchangeMs ?? null,
    lastBusinessRelevantCustomerExchangeMs:
      classification.lastBusinessRelevantCustomerExchangeMs ?? null,
    lastVerifiedInteractionMs:
      classification.lastVerifiedInteractionMs ?? null,
    agentFailureMode: classification.agentFailureMode ?? null,
    meaningfulServiceBeforeFailure:
      classification.meaningfulServiceBeforeFailure === true,
    failureStartMs: classification.failureStartMs ?? null,
  })
  const speech = roleSpeech(blocks, classification)
  const speechDurationMs = segments.reduce(
    (sum, segment) => sum + Math.max(0, segment.endMs - segment.startMs),
    0,
  )
  const analysis: ReauditAnalysis = {
    category: classification.category,
    confidence: classification.confidence,
    language: optionalText(transcriptRaw.language, 32) ?? 'unknown',
    recordedDurationMs,
    speechDurationMs,
    conversationAssessment: classification.customerSpoke
      ? 'established'
      : 'no_meaningful_exchange',
    lastMeaningfulCustomerExchangeMs:
      classification.lastMeaningfulCustomerExchangeMs,
    customerSpeechMs: speech.customer,
    agentSpeechMs: speech.agent,
    chargeableServiceEndMs: charge.serviceEndMs,
    appliedBillingGraceMs: charge.graceMs,
    categoryChargePolicyCode: charge.policyCode,
    durationMismatch,
    evidenceSha256: options.evidenceSha256,
    remarks: classification.remarks,
    disputeRecommended: classification.disputeRecommended,
  }
  const transcription: TranscriptionResult = {
    model: { provider: 'openai', name: 'whisper-1', version: 'whisper-1' },
    language: analysis.language,
    durationMs: recordedDurationMs,
    speechMs: speechDurationMs,
    text: optionalText(transcriptRaw.text, 100_000) ?? '',
    segments,
  }
  return {
    callId: options.candidate.callId,
    artifactId: options.candidate.artifactId,
    outcome: 'projected',
    analysis,
    transcription,
    classification,
    projection: projectVerifiedCharge(analysis),
  }
}

function fallbackReason(basis: string):
  | 'no_recording'
  | 'automated_validation_unresolved' {
  return basis === 'no_recording_zero'
    ? 'no_recording'
    : 'automated_validation_unresolved'
}

export function createGasAuditResultSync(
  pool: Pool,
): { sync(input: GasAuditSyncRequest): Promise<GasAuditSyncReceipt> } {
  return {
    async sync(input) {
      if (!SHA256.test(input.bodySha256)) throw new TypeError('body hash is invalid')
      const payload = record(input.body, 'body')
      if (payload.schema_version !== '1') throw new TypeError('schema version is invalid')
      if (text(payload.batch_id, 'batch_id', 64) !== input.batchId) {
        throw new TypeError('batch id does not match')
      }
      if (text(payload.bill_month, 'bill_month', 7) !== input.billMonth) {
        throw new TypeError('bill month does not match')
      }
      if (!Array.isArray(payload.items) || payload.items.length < 1 || payload.items.length > 20) {
        throw new TypeError('items must contain 1 to 20 rows')
      }
      const bounds = monthBounds(input.billMonth)
      const rateCard = await loadPublishedRateCard(pool, input.rateCardId)
      const receipts: GasAuditSyncItemReceipt[] = []
      for (const rawItem of payload.items) {
        let taskId = 'invalid'
        try {
          const item = record(rawItem, 'item')
          taskId = text(item.task_id, 'task_id', 128)
          if (!TASK_ID.test(taskId)) throw new TypeError('task id is invalid')
          if (text(item.bill_month, 'item.bill_month', 7) !== input.billMonth) {
            throw new TypeError('item month does not match')
          }
          const basis = text(item.calculation_basis, 'calculation_basis', 64)
          if (![
            'independent_category_service_end',
            'accepted_as_billed_unverified',
            'no_recording_zero',
          ].includes(basis)) {
            throw new Error('CALCULATION_BASIS_INVALID')
          }
          const candidate = await candidateForTask(pool, taskId, bounds)
          const sourceEvidence: EvidenceHashReference = {
            kind: 'call_manifest',
            referenceId: `gas-sync:${input.batchId}`,
            sha256: input.bodySha256,
          }
          if (basis !== 'independent_category_service_end') {
            if (basis === 'no_recording_zero' && candidate.artifactId) {
              throw new Error('RECORDING_ARTIFACT_PRESENT')
            }
            if (
              basis === 'accepted_as_billed_unverified' &&
              !candidate.artifactId
            ) {
              throw new Error('RECORDING_ARTIFACT_NOT_FOUND')
            }
            if (candidate.vendorBilledMinutes == null) {
              throw new Error('VENDOR_BILLED_MINUTES_NOT_FOUND')
            }
            const records = buildAcceptedAsBilledRecords({
              callId: candidate.callId,
              fallbackReason: fallbackReason(basis),
              claimedDurationMs: candidate.claimedDurationMs,
              connectedDurationMs: candidate.connectedDurationMs,
              // Money facts are always re-read from immutable provider costs.
              // Values carried by the Sheet payload are never authoritative.
              vendorBilledMinutes: decimal8(
                candidate.vendorBilledMinutes,
                'vendor minutes',
              ),
              vendorBilledAmount: candidate.vendorBilledAmount,
              sourceEvidence,
              decidedAt: new Date().toISOString(),
            }, rateCard)
            const persisted = await persistVerifiedBillingRecords(pool, {
              records,
              rateCard,
              correlationId: input.correlationId,
            })
            receipts.push({
              taskId,
              status: persisted.outcome === 'duplicate' ? 'duplicate' : 'imported',
            })
            continue
          }
          const evidenceSha256 = text(item.evidence_sha256, 'evidence_sha256', 64)
          if (!SHA256.test(evidenceSha256)) throw new TypeError('evidence hash is invalid')
          if (!candidate.artifactId || !candidate.sourceUrl) {
            throw new Error('RECORDING_ARTIFACT_NOT_FOUND')
          }
          if (candidate.baselineSha256 && candidate.baselineSha256 !== evidenceSha256) {
            throw new Error('EVIDENCE_HASH_MISMATCH')
          }
          const audit = record(item.audit, 'audit')
          const repo = createMysqlReauditWriteRepo(pool)
          const started = await repo.markStarted(candidate, new Date())
          if (started === 'acquired') {
            const result = buildPrimaryResult({ candidate, audit, evidenceSha256 })
            await repo.persist(candidate, result, new Date())
          }
          const [validationCandidate] = await collectAutomatedValidationCandidates(pool, {
            ...bounds,
            limit: 1,
            callIds: [candidate.callId],
          })
          if (!validationCandidate) {
            receipts.push({ taskId, status: 'duplicate' })
            continue
          }
          const blocks = mergeTranscriptSegments(validationCandidate.segments)
          const durationMismatch =
            validationCandidate.connectedDurationMs != null &&
            Math.abs(
              validationCandidate.connectedDurationMs -
              validationCandidate.recordedDurationMs,
            ) > 5_000
          const supplied = (value: unknown) => validateClassification(
            classificationFromGas(value),
            blocks,
            validationCandidate.recordedDurationMs,
            { durationMismatch },
          )
          const secondary = supplied(audit.second)
          const third = audit.third == null ? null : supplied(audit.third)
          const outcome = await runAutomatedValidation(pool, {
            candidate: validationCandidate,
            reviewer: { classify: async () => secondary },
            adjudicator: {
              classify: async () => {
                if (!third) throw new Error('THIRD_REVIEW_REQUIRED')
                return third
              },
            },
            rateCard,
            correlationId: input.correlationId,
            decidedAt: new Date().toISOString(),
          })
          receipts.push({
            taskId,
            status: outcome.billingStatus === 'final' ? 'imported' : 'rejected',
            ...(outcome.billingStatus === 'final'
              ? {}
              : { code: outcome.reasons.join('|') || 'CONSENSUS_UNRESOLVED' }),
          })
        } catch (error) {
          receipts.push({
            taskId,
            status: 'rejected',
            code:
              error instanceof Error && /^[A-Z0-9_]{3,80}$/.test(error.message)
                ? error.message
                : 'INVALID_AUDIT_RESULT',
          })
        }
      }
      return { batchId: input.batchId, items: receipts }
    },
  }
}
