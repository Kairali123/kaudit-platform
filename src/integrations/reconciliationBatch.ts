import { createHash } from 'node:crypto'
import type { Pool, RowDataPacket } from 'mysql2/promise'
import { createConfiguredReauditAi } from '../adapters/configuredReaudit.ts'
import { createMysqlBillingMonthSummaryStore } from '../adapters/mysqlBillingMonthSummary.ts'
import { createMysqlBillingSpendGuard } from '../adapters/mysqlBillingSpendLease.ts'
import {
  collectAutomatedValidationCandidates,
  loadPublishedRateCard,
} from '../adapters/mysqlAutomatedValidation.ts'
import {
  commitLateRecordingBatch,
  createMysqlLateRecordingCandidateRepository,
  finalizeLateRecordingBatch,
  listLateRecordingCorrectionFacts,
  prepareLateRecordingBatch,
  readActualPaidAmount,
  readLateRecordingBatchProgress,
  readVerifiedMonthTotal,
} from '../adapters/mysqlLateRecordingCorrections.ts'
import {
  createMysqlManualReauditCandidateRepository,
  createMysqlManualReauditRequestRepository,
} from '../adapters/mysqlManualReauditQueue.ts'
import { createOpenAiConsensusReviewer } from '../adapters/openaiConsensus.ts'
import { createProxyResolvingFetcher } from '../adapters/proxyResolvingFetcher.ts'
import { createMysqlReauditReadRepo } from '../adapters/mysqlReauditReadRepo.ts'
import { createMysqlReauditWriteRepo } from '../adapters/mysqlReauditWriteRepo.ts'
import { auditStoredTranscript } from '../adapters/mysqlStoredTranscriptReaudit.ts'
import { createMysqlTranscriptionCache } from '../adapters/mysqlTranscriptionCache.ts'
import { runAutomatedValidation } from '../automation/validationRun.ts'
import type { PublishedRateCard } from '../billing/types.ts'
import {
  canonicalizeLateRecordingUrl,
  type LateRecordingRowDecision,
} from '../lateRecording/corrections.ts'
import { correctLateRecordingItem } from '../lateRecording/correctItem.ts'
import { proposedFinanceAdjustment } from '../lateRecording/corrections.ts'
import { parseBillingMonth, type BillingMonthScope } from '../reporting/billingMonth.ts'
import { auditOneCall } from '../reaudit/core.ts'
import { runReauditBatch, type ReauditCandidateRepository } from '../reaudit/worker.ts'

const TASK_ID = /^[A-Za-z0-9._:-]{1,191}$/
const BATCH_ID = /^[A-Za-z0-9._:-]{16,80}$/
export const RECONCILIATION_BATCH_ROUTE = '/api/v1/reconciliation/batch'
export const MAX_RECONCILIATION_BATCH_ITEMS = 3

export type ReconciliationMode =
  | 'new_month'
  | 'late_recording'
  | 'transcript_reaudit'

export interface ReconciliationBatchRequest {
  batchId: string
  billMonth: string
  bodySha256: string
  correlationId: string | null
  body: unknown
}

export interface ReconciliationItemReceipt {
  taskId: string
  stage: 'upload' | 'transcription' | 'classification' | 'billing' | 'complete'
  status: 'completed' | 'duplicate' | 'retryable' | 'failed'
  code?: string
  amount?: string | null
}

export interface ReconciliationBatchReceipt {
  batchId: string
  billMonth: string
  mode: ReconciliationMode
  items: ReconciliationItemReceipt[]
  finalized?: boolean
  totalAdjustment?: string | null
}

export interface ReconciliationBatchService {
  process(input: ReconciliationBatchRequest): Promise<ReconciliationBatchReceipt>
}

type Raw = Record<string, unknown>

interface ParsedItem {
  taskId: string
  recordingUrl: string | null
}

interface CallRow extends RowDataPacket {
  task_id: string
  call_id: string
}

interface FailureRow extends RowDataPacket {
  task_id: string
  latest_audit_run_id: string | null
  processing_status: string | null
  audio_processing_status: string | null
  audio_last_error: string | null
}

interface CompletedRow extends RowDataPacket {
  call_id: string
  amount: string
}

function record(value: unknown): Raw {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('reconciliation body is invalid')
  }
  return value as Raw
}

function parseRequest(input: ReconciliationBatchRequest): {
  mode: ReconciliationMode
  period: BillingMonthScope
  items: ParsedItem[]
} {
  const body = record(input.body)
  if (body.schema_version !== '1') throw new TypeError('schema version is invalid')
  if (body.batch_id !== input.batchId || !BATCH_ID.test(input.batchId)) {
    throw new TypeError('batch id is invalid')
  }
  if (body.bill_month !== input.billMonth) {
    throw new TypeError('bill month does not match')
  }
  const period = parseBillingMonth(input.billMonth)
  if (!period) throw new TypeError('bill month is invalid')
  if (
    body.mode !== 'new_month' &&
    body.mode !== 'late_recording' &&
    body.mode !== 'transcript_reaudit'
  ) throw new TypeError('reconciliation mode is invalid')
  if (
    !Array.isArray(body.items) ||
    body.items.length < 1 ||
    body.items.length > MAX_RECONCILIATION_BATCH_ITEMS
  ) throw new TypeError('reconciliation batch size is invalid')
  const items = body.items.map((raw): ParsedItem => {
    const item = record(raw)
    const taskId = typeof item.task_id === 'string' ? item.task_id.trim() : ''
    if (!TASK_ID.test(taskId)) throw new TypeError('task id is invalid')
    const recordingUrl =
      typeof item.recording_url === 'string' && item.recording_url.trim()
        ? item.recording_url.trim()
        : null
    if (body.mode === 'late_recording' && !recordingUrl) {
      throw new TypeError('late recording URL is required')
    }
    return { taskId, recordingUrl }
  })
  if (new Set(items.map((item) => item.taskId)).size !== items.length) {
    throw new TypeError('task ids must be unique in a batch')
  }
  return { mode: body.mode, period, items }
}

async function resolveTaskCalls(
  pool: Pool,
  period: BillingMonthScope,
  taskIds: readonly string[],
): Promise<{
  calls: Map<string, string>
  invalid: Set<string>
}> {
  const placeholders = taskIds.map(() => '?').join(',')
  const [rows] = await pool.execute<CallRow[]>(
    `SELECT ref.external_id AS task_id, c.id AS call_id
     FROM kaudit_call c
     JOIN kaudit_call_external_reference ref ON ref.call_id = c.id
     WHERE c.billing_period_date BETWEEN ? AND ?
       AND ref.reference_type IN ('task_id','taskId','task')
       AND ref.external_id IN (${placeholders})
     UNION
     SELECT c.logical_call_key AS task_id, c.id AS call_id
     FROM kaudit_call c
     WHERE c.billing_period_date BETWEEN ? AND ?
       AND c.logical_call_key IN (${placeholders})`,
    [period.start, period.end, ...taskIds, period.start, period.end, ...taskIds],
  )
  const grouped = new Map<string, Set<string>>()
  for (const row of rows) {
    const calls = grouped.get(row.task_id) ?? new Set<string>()
    calls.add(row.call_id)
    grouped.set(row.task_id, calls)
  }
  const calls = new Map<string, string>()
  const invalid = new Set<string>()
  for (const taskId of taskIds) {
    const matches = grouped.get(taskId)
    if (!matches || matches.size !== 1) invalid.add(taskId)
    else calls.set(taskId, [...matches][0] as string)
  }
  return { calls, invalid }
}

/**
 * One stderr line for a swallowed billing failure: the error class and its
 * bounded identifiers only. Messages and SQL can carry call data, so they are
 * never written.
 */
export function logReconciliationBillingFailure(
  operation: 'validate_and_bill' | 'late_correction',
  error: unknown,
): void {
  const shaped = (error ?? {}) as {
    message?: unknown
    name?: unknown
    code?: unknown
    errno?: unknown
    status?: unknown
  }
  const bounded = (value: unknown, pattern: RegExp): string | null =>
    typeof value === 'string' && pattern.test(value) ? value : null
  process.stderr.write(`${JSON.stringify({
    event: 'reconciliation_billing_failed',
    operation,
    name: bounded(shaped.name, /^[A-Za-z][A-Za-z0-9]{0,63}$/),
    code: bounded(shaped.code, /^[A-Za-z][A-Za-z0-9_]{0,63}$/),
    errno: Number.isInteger(shaped.errno) ? shaped.errno : null,
    status: Number.isInteger(shaped.status) ? shaped.status : null,
    // A fingerprint, not the text: our own fixed messages can be matched
    // offline, while a model refusal (which may quote the call) cannot leak.
    messageSha256: typeof shaped.message === 'string'
      ? createHash('sha256').update(shaped.message).digest('hex').slice(0, 16)
      : null,
  })}\n`)
}

function oneShotCandidates(
  candidates: Awaited<ReturnType<ReauditCandidateRepository['listCandidates']>>,
): ReauditCandidateRepository {
  let delivered = false
  return {
    async listCandidates() {
      if (delivered) return []
      delivered = true
      return candidates
    },
  }
}

async function validateAndBill(
  pool: Pool,
  options: {
    callId: string
    period: BillingMonthScope
    rateCard: PublishedRateCard
    reviewer: ReturnType<typeof createOpenAiConsensusReviewer>
    adjudicator: ReturnType<typeof createConfiguredReauditAi>
    correlationId: string | null
    allowExistingCalculation: boolean
  },
): Promise<{ status: 'completed' | 'failed'; amount: string | null; code?: string }> {
  const [candidate] = await collectAutomatedValidationCandidates(pool, {
    start: options.period.start,
    end: options.period.end,
    limit: 1,
    callIds: [options.callId],
    allowExistingCalculation: options.allowExistingCalculation,
  })
  if (!candidate) {
    return { status: 'failed', amount: null, code: 'AUDIT_RESULT_NOT_READY' }
  }
  const outcome = await runAutomatedValidation(pool, {
    candidate,
    reviewer: options.reviewer,
    adjudicator: options.adjudicator,
    rateCard: options.rateCard,
    correlationId: options.correlationId,
    decidedAt: new Date().toISOString(),
  })
  return outcome.billingStatus === 'final'
    ? { status: 'completed', amount: outcome.amount }
    : {
        status: 'failed',
        amount: null,
        code: outcome.reasons.join('|') || 'CONSENSUS_UNRESOLVED',
      }
}

async function failureReceipts(
  pool: Pool,
  period: BillingMonthScope,
  taskIds: readonly string[],
): Promise<Map<string, ReconciliationItemReceipt>> {
  if (taskIds.length === 0) return new Map()
  const placeholders = taskIds.map(() => '?').join(',')
  // Same two ways to match a Task ID as resolveTaskCalls.
  const columns = `c.latest_audit_run_id, c.processing_status,
            artifact.audio_processing_status, artifact.audio_last_error
     FROM kaudit_call c`
  const recording = `LEFT JOIN kaudit_call_artifact artifact ON artifact.call_id = c.id
      AND artifact.artifact_type = 'recording' AND artifact.is_final = 1`
  const [rows] = await pool.execute<FailureRow[]>(
    `SELECT ref.external_id AS task_id, ${columns}
     JOIN kaudit_call_external_reference ref ON ref.call_id = c.id
      AND ref.reference_type IN ('task_id','taskId','task')
     ${recording}
     WHERE c.billing_period_date BETWEEN ? AND ?
       AND ref.external_id IN (${placeholders})
     UNION
     SELECT c.logical_call_key AS task_id, ${columns}
     ${recording}
     WHERE c.billing_period_date BETWEEN ? AND ?
       AND c.logical_call_key IN (${placeholders})`,
    [period.start, period.end, ...taskIds, period.start, period.end, ...taskIds],
  )
  return new Map(rows.flatMap((row) => {
    if (row.audio_processing_status === 'completed') return []
    return [[row.task_id, {
      taskId: row.task_id,
      stage:
        row.audio_processing_status === 'fetch_failed'
          ? 'upload' as const
          : row.audio_processing_status === 'transcribe_failed'
            ? 'transcription' as const
            : 'classification' as const,
      status:
        row.processing_status === 'audit_retry'
          ? 'retryable' as const
          : 'failed' as const,
      code: row.audio_last_error || 'AUDIT_NOT_COMPLETED',
    }]]
  }))
}

async function completedCallAmounts(
  pool: Pool,
  callIds: readonly string[],
): Promise<Map<string, string>> {
  if (callIds.length === 0) return new Map()
  const placeholders = callIds.map(() => '?').join(',')
  const [rows] = await pool.execute<CompletedRow[]>(
    `SELECT c.id AS call_id, CAST(calculation.total_amount AS CHAR) AS amount
     FROM kaudit_call c
     JOIN kaudit_audit_run run
       ON run.id = c.latest_audit_run_id AND run.status = 'completed'
     JOIN kaudit_call_artifact artifact
       ON artifact.call_id = c.id AND artifact.artifact_type = 'recording'
      AND artifact.is_final = 1
      AND artifact.audio_processing_status = 'completed'
     JOIN kaudit_media_analysis media
       ON media.call_artifact_id = artifact.id AND media.status = 'completed'
      AND media.classification_status = 'completed'
     JOIN kaudit_transcript transcript
       ON transcript.call_artifact_id = artifact.id
      AND transcript.call_id = c.id AND transcript.status = 'completed'
      AND transcript.input_sha256 = artifact.sha256
     JOIN kaudit_billing_calculation calculation
       ON calculation.call_id = c.id
      AND calculation.audit_run_id = c.latest_audit_run_id
      AND calculation.status = 'final'
     WHERE c.id IN (${placeholders})
       AND NOT EXISTS (
         SELECT 1 FROM kaudit_billing_calculation newer
         WHERE newer.supersedes_calculation_id = calculation.id
       )`,
    [...callIds],
  )
  return new Map(rows.map((row) => [row.call_id, row.amount]))
}

export function createReconciliationBatchService(options: {
  pool: Pool
  env: NodeJS.ProcessEnv
  rateCardId: string
  allowedRecordingHosts: readonly string[]
  proxyBaseUrl: string
}): ReconciliationBatchService {
  if (!options.rateCardId.trim()) {
    throw new Error('KAUDIT_GAS_AUDIT_SYNC_RATE_CARD_ID is required')
  }
  if (!options.proxyBaseUrl.trim()) {
    throw new Error('KAUDIT_UNPOD_PROXY_BASE is required')
  }
  if (options.allowedRecordingHosts.length === 0) {
    throw new Error('KAUDIT_ALLOWED_RECORDING_HOSTS is required')
  }
  const pool = options.pool
  const ai = createConfiguredReauditAi(options.env)
  const reviewer = createOpenAiConsensusReviewer(
    options.env.OPENAI_API_KEY?.trim() || '',
  )
  const fetcher = createProxyResolvingFetcher(options.proxyBaseUrl)
  const transcriptCache = createMysqlTranscriptionCache(pool)
  const summaries = createMysqlBillingMonthSummaryStore(pool)

  async function processNewOrReaudit(
    input: ReconciliationBatchRequest,
    period: BillingMonthScope,
    items: ParsedItem[],
    mode: 'new_month' | 'transcript_reaudit',
  ): Promise<ReconciliationBatchReceipt> {
    const taskIds = items.map((item) => item.taskId)
    const resolution = await resolveTaskCalls(pool, period, taskIds)
    const receipts = new Map<string, ReconciliationItemReceipt>()
    for (const taskId of resolution.invalid) {
      receipts.set(taskId, {
        taskId,
        stage: 'upload',
        status: 'failed',
        code: 'TASK_NOT_FOUND_OR_AMBIGUOUS',
      })
    }
    const validTaskIds = taskIds.filter((taskId) => !resolution.invalid.has(taskId))
    let processingTaskIds = validTaskIds
    if (mode === 'new_month' && validTaskIds.length > 0) {
      const completed = await completedCallAmounts(
        pool,
        validTaskIds.map((taskId) => resolution.calls.get(taskId) as string),
      )
      processingTaskIds = validTaskIds.filter((taskId) => {
        const callId = resolution.calls.get(taskId) as string
        const amount = completed.get(callId)
        if (amount == null) return true
        receipts.set(taskId, {
          taskId,
          stage: 'complete',
          status: 'duplicate',
          amount,
        })
        return false
      })
    }
    if (processingTaskIds.length > 0) {
      let candidates: ReauditCandidateRepository
      let results: ReturnType<typeof createMysqlReauditWriteRepo>
      if (mode === 'transcript_reaudit') {
        const queued = await createMysqlManualReauditRequestRepository(pool, {
          period,
        }).enqueue({
          callReferences: processingTaskIds,
          idempotencyKey: input.batchId,
          requestedByUserId: null,
          correlationId: input.correlationId ?? `gas:${input.batchId}`,
          requestedAt: new Date(),
        })
        if (!queued.requestId) {
          for (const taskId of processingTaskIds) {
            receipts.set(taskId, {
              taskId,
              stage: 'classification',
              status: 'retryable',
              code: 'REAUDIT_ALREADY_IN_PROGRESS',
            })
          }
          return {
            batchId: input.batchId,
            billMonth: period.month,
            mode,
            items: taskIds.map((taskId) => receipts.get(taskId) as ReconciliationItemReceipt),
          }
        }
        candidates = createMysqlManualReauditCandidateRepository(pool, {
          requestId: queued.requestId,
        })
        results = createMysqlReauditWriteRepo(pool, { manualRequest: true })
        await runReauditBatch({
          candidates,
          results,
          batchSize: Math.max(1, queued.acceptedCount),
          concurrency: Math.max(1, queued.acceptedCount),
          includePreviouslyClassified: true,
          spendGuard: createMysqlBillingSpendGuard(pool),
          processor: {
            process: (candidate) => auditStoredTranscript({
              pool,
              candidate,
              classifier: ai,
            }),
          },
        })
      } else {
        candidates = createMysqlReauditReadRepo(pool, {
          externalTaskIds: processingTaskIds,
          period,
        })
        results = createMysqlReauditWriteRepo(pool)
        await runReauditBatch({
          candidates,
          results,
          batchSize: processingTaskIds.length,
          concurrency: processingTaskIds.length,
          spendGuard: createMysqlBillingSpendGuard(pool),
          processor: {
            process: (candidate) => auditOneCall({
              candidate,
              fetcher,
              ai,
              allowedHosts: [...options.allowedRecordingHosts],
              transcriptCache,
            }),
          },
        })
      }

      const rateCard = await loadPublishedRateCard(pool, options.rateCardId)
      for (const taskId of processingTaskIds) {
        const callId = resolution.calls.get(taskId) as string
        try {
          const billed = await validateAndBill(pool, {
            callId,
            period,
            rateCard,
            reviewer,
            adjudicator: ai,
            correlationId: input.correlationId,
            allowExistingCalculation: mode === 'transcript_reaudit',
          })
          receipts.set(taskId, {
            taskId,
            stage: billed.status === 'completed' ? 'complete' : 'billing',
            status: billed.status,
            ...(billed.code ? { code: billed.code } : {}),
            amount: billed.amount,
          })
        } catch (error) {
          logReconciliationBillingFailure('validate_and_bill', error)
          receipts.set(taskId, {
            taskId,
            stage: 'billing',
            status: 'retryable',
            code: 'BILLING_RETRY_REQUIRED',
          })
        }
      }
      const failed = await failureReceipts(pool, period, processingTaskIds)
      for (const [taskId, receipt] of failed) {
        if (receipts.get(taskId)?.status !== 'completed') receipts.set(taskId, receipt)
      }
      await summaries.invalidate(period.month)
    }
    return {
      batchId: input.batchId,
      billMonth: period.month,
      mode,
      items: taskIds.map((taskId) => receipts.get(taskId) ?? ({
        taskId,
        stage: 'classification',
        status: 'retryable',
        code: 'AUDIT_STATUS_UNAVAILABLE',
      })),
    }
  }

  async function processLate(
    input: ReconciliationBatchRequest,
    period: BillingMonthScope,
    items: ParsedItem[],
  ): Promise<ReconciliationBatchReceipt> {
    const carriedRejections: LateRecordingRowDecision[] = []
    const rows = items.flatMap((item, index) => {
      const canonical = canonicalizeLateRecordingUrl(
        item.recordingUrl as string,
        options.allowedRecordingHosts,
      )
      if ('code' in canonical) {
        carriedRejections.push({
          rowNumber: index + 2,
          outcome: 'rejected',
          code: canonical.code,
        })
        return []
      }
      return [{
        rowNumber: index + 2,
        taskId: item.taskId,
        submittedUrl: item.recordingUrl as string,
        canonicalUrl: canonical.canonicalUrl,
      }]
    })
    const committed = await commitLateRecordingBatch(pool, {
      period,
      rows,
      carriedRejections,
      sourceFileSha256: input.bodySha256,
      idempotencyKey: input.batchId,
      requestedByUserId: null,
      correlationId: input.correlationId ?? `gas:${input.batchId}`,
      requestedAt: new Date(),
    })
    if (!committed.batchId) {
      const byRow = new Map(committed.decisions.map((decision) => [decision.rowNumber, decision]))
      return {
        batchId: input.batchId,
        billMonth: period.month,
        mode: 'late_recording',
        items: items.map((item, index) => {
          const decision = byRow.get(index + 2)
          return {
            taskId: item.taskId,
            stage: 'upload',
            status: decision?.outcome === 'duplicate_replay' ? 'duplicate' : 'failed',
            ...(decision?.outcome === 'rejected' ? { code: decision.code } : {}),
          }
        }),
      }
    }

    const prepared = await prepareLateRecordingBatch(pool, {
      batchId: committed.batchId,
      period,
      at: new Date(),
    })
    if (!prepared) throw new Error('LATE_RECORDING_BATCH_NOT_FOUND')
    const rateCard = await loadPublishedRateCard(pool, prepared.rateCardVersionId)
    const repository = createMysqlLateRecordingCandidateRepository(pool, {
      batchId: committed.batchId,
    })
    const claimed = await repository.listCandidates({
      limit: items.length,
      includePreviouslyClassified: false,
    })
    if (claimed.length > 0) {
      await runReauditBatch({
        candidates: oneShotCandidates(claimed),
        results: createMysqlReauditWriteRepo(pool),
        batchSize: claimed.length,
        concurrency: claimed.length,
        spendGuard: createMysqlBillingSpendGuard(pool),
        processor: {
          process: (candidate) => auditOneCall({
            candidate,
            fetcher,
            ai,
            allowedHosts: [...options.allowedRecordingHosts],
            transcriptCache,
          }),
        },
      })
    }

    const facts = await listLateRecordingCorrectionFacts(pool, committed.batchId)
    for (const fact of facts) {
      try {
        await correctLateRecordingItem(pool, {
          facts: fact,
          batchId: committed.batchId,
          period,
          rateCard,
          reviewer,
          adjudicator: ai,
          decidedAt: new Date().toISOString(),
          correlationId: input.correlationId ?? `gas:${input.batchId}`,
        })
      } catch (error) {
        logReconciliationBillingFailure('late_correction', error)
        // The durable item remains in flight and the sheet retries this batch.
      }
    }
    await summaries.invalidate(period.month)
    const revisedVerifiedTotal = await readVerifiedMonthTotal(pool, period)
    const actualPaidAmount = await readActualPaidAmount(pool, period.month)
    const proposal = proposedFinanceAdjustment({
      previousVerifiedTotal: prepared.previousVerifiedTotal,
      revisedVerifiedTotal,
      actualPaidAmount,
    })
    await finalizeLateRecordingBatch(pool, {
      batchId: committed.batchId,
      billMonth: period.month,
      revisedVerifiedTotal,
      actualPaidAmount,
      revisedVariance: proposal.revisedVariance,
    })
    const progress = await readLateRecordingBatchProgress(pool, committed.batchId)
    const byTask = new Map(progress?.items.map((item) => [item.taskReference, item]) ?? [])
    // A corrected item whose recording never finished auditing was settled at
    // the vendor's claim (accepted_as_billed_unverified); say so.
    const unaudited = await failureReceipts(
      pool,
      period,
      [...byTask.values()]
        .filter((item) => item.state === 'corrected')
        .map((item) => item.taskReference),
    )
    return {
      batchId: input.batchId,
      billMonth: period.month,
      mode: 'late_recording',
      finalized: progress?.finalized ?? false,
      totalAdjustment: progress?.totalAdjustment ?? null,
      items: items.map((item, index) => {
        const progressItem = byTask.get(item.taskId)
        const unauditedReceipt = unaudited.get(item.taskId)
        if (progressItem?.state === 'corrected' && unauditedReceipt) {
          return {
            taskId: item.taskId,
            stage: 'billing',
            status: 'failed',
            code: `ACCEPTED_AS_BILLED_UNVERIFIED|${unauditedReceipt.code}`,
            amount: progressItem.revisedAmount,
          }
        }
        if (progressItem) {
          return {
            taskId: item.taskId,
            stage: progressItem.state === 'corrected' ? 'complete' : 'billing',
            status:
              progressItem.state === 'corrected'
                ? 'completed'
                : progressItem.state === 'failed'
                  ? 'failed'
                  : 'retryable',
            ...(progressItem.failureCode ? { code: progressItem.failureCode } : {}),
            amount: progressItem.revisedAmount,
          }
        }
        const decision = committed.decisions.find(
          (candidate) => candidate.rowNumber === index + 2,
        )
        return {
          taskId: item.taskId,
          stage: 'upload',
          status: decision?.outcome === 'duplicate_replay' ? 'duplicate' : 'failed',
          ...(decision?.outcome === 'rejected' ? { code: decision.code } : {}),
        }
      }),
    }
  }

  return {
    async process(input) {
      let parsed: ReturnType<typeof parseRequest>
      try {
        parsed = parseRequest(input)
      } catch {
        throw Object.assign(new Error('Reconciliation batch is invalid'), {
          code: 'INVALID_RECONCILIATION_BATCH',
          status: 400,
        })
      }
      return parsed.mode === 'late_recording'
        ? processLate(input, parsed.period, parsed.items)
        : processNewOrReaudit(
            input,
            parsed.period,
            parsed.items,
            parsed.mode,
          )
    },
  }
}
