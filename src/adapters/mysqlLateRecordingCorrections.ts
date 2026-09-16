import type {
  Pool,
  PoolConnection,
  ResultSetHeader,
  RowDataPacket,
} from 'mysql2/promise'
import { REAUDIT_CLASSIFIER_RULESET_VERSION } from '../reaudit/core.ts'
import type { ReauditCandidate } from '../reaudit/types.ts'
import type { ReauditCandidateRepository } from '../reaudit/worker.ts'
import type { BillingMonthScope } from '../reporting/billingMonth.ts'
import { KSERVE_RULESET_SHA256 } from '../billing/kserveRules.ts'
import {
  canonicalUrlSha256,
  fixed8,
  lateRecordingCorrectionTotals,
  LateRecordingError,
  lateRecordingBatchDigest,
  lateRecordingId,
  MAX_LATE_RECORDING_ROWS,
  safeLateRecordingFailureCode,
  type LateRecordingBatchStatus,
  type LateRecordingCsvRow,
  type LateRecordingItemState,
  type LateRecordingRowDecision,
} from '../lateRecording/corrections.ts'
import {
  decideLateRecordingRow,
  summarizeLateRecordingDecisions,
  type LateRecordingCallFacts,
  type LateRecordingPreview,
} from '../lateRecording/eligibility.ts'

/**
 * The durable, KAUDIT-OWNED late-recording correction workflow (migration
 * 0020).
 *
 * Four surfaces over three control tables:
 *
 *   1. `previewLateRecordingBatch` — READ-ONLY. Resolves every uploaded row
 *      against the selected month and reports what a commit would do. It opens
 *      no transaction and executes no statement that can write.
 *   2. `commitLateRecordingBatch` — the administrator's write. Performs the
 *      one-way `NULL -> canonical URL` transition on each accepted artifact,
 *      records the batch and its items, and returns a receipt that carries an
 *      opaque batch id and counts.
 *   3. `createMysqlLateRecordingCandidateRepository` — the worker's claim.
 *      Bounded, ordered, and joined EXACTLY to accepted items of one batch, so
 *      a run can never reach a call the administrator did not upload.
 *   4. `readLateRecordingBatchProgress` — the progress screen's read.
 *
 * A RECORDING URL NEVER LEAVES THIS MODULE. It is read from the upload,
 * normalized, written once into `kaudit_call_artifact.source_url`, and handed
 * to the audit fetcher through the ordinary candidate shape. Every other value
 * in this file -- receipts, decisions, progress rows, errors, item rows --
 * carries a SHA-256 instead. Nothing returned by any exported function here
 * contains a URL.
 */

interface BatchRow extends RowDataPacket {
  id: string
  bill_month: string
  request_digest: string
  status: LateRecordingBatchStatus
  submitted_count: number | string
  accepted_count: number | string
  rejected_count: number | string
  corrected_count: number | string
  failed_count: number | string
  rate_card_version_id: string
  baseline_verified_total: string | null
  baseline_captured_at: Date | string | null
}

interface ResolvedRow extends RowDataPacket {
  task_reference: string
  call_id: string
  artifact_id: string | null
  source_url: string | null
  evidence_sha256: string | null
  invoice_present: number | string
  audit_completed: number | string
  live_calculation_id: string | null
  live_calculation_basis: string | null
  live_total_amount: string | null
}

interface RateCardRow extends RowDataPacket {
  id: string
}

interface ClaimedItemRow extends RowDataPacket {
  item_id: string
  batch_id: string
  call_id: string
  artifact_id: string
  source_url: string
  evidence_sha256: string | null
  item_state: 'accepted' | 'auditing'
}

interface CostRow extends RowDataPacket {
  call_id: string
  claimed_duration_ms: string | number | null
  connected_duration_ms: string | number | null
  vendor_billed_minutes: string | null
}

interface ProgressRow extends RowDataPacket {
  task_reference: string
  row_number: number | string
  state: LateRecordingItemState
  previous_amount: string | null
  revised_amount: string | null
  last_error_code: string | null
  completed_at: Date | string | null
}

interface TotalRow extends RowDataPacket {
  verified_total: string | null
}

/**
 * Serializes concurrent administrator commits.
 *
 * The unique key on `active_call_id` is what actually guarantees one live item
 * per call; this lock only keeps two simultaneous uploads from racing into a
 * partially-written pair of batches before that key can decide.
 */
const COMMIT_LOCK = 'kaudit-late-recording-commit-v1'
const COMMIT_LOCK_TIMEOUT_SECONDS = 5

/** The reference types the import and monitor surfaces already display. */
const REFERENCE_TYPES = "('task_id','taskId','task')"

function placeholders(count: number): string {
  return new Array(count).fill('?').join(',')
}

function nullableMs(value: string | number | null): number | null {
  const parsed = value == null ? Number.NaN : Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? Math.round(parsed) : null
}

/**
 * Every driver failure becomes ONE bounded refusal.
 *
 * A duplicate-key race, a lost connection, an unanticipated constraint, and a
 * bug all leave here as the same 503. The original error may quote SQL, a
 * column value, an internal id, or -- the reason this matters most here -- a
 * recording URL, and is dropped rather than carried outward.
 */
function asSafeLateRecordingError(error: unknown): LateRecordingError {
  if (error instanceof LateRecordingError) return error
  return new LateRecordingError(
    'LATE_RECORDING_UNAVAILABLE',
    503,
    'Late recording correction storage is temporarily unavailable',
  )
}

/**
 * Whether a formally published rate card covers the month.
 *
 * Checked ONCE before any row is resolved, so an upload that could never be
 * priced is refused as a whole instead of accepted and then stuck.
 */
async function applicableRateCardId(
  pool: Pool | PoolConnection,
  period: BillingMonthScope,
): Promise<string | null> {
  const [rows] = await pool.execute<RateCardRow[]>(
    `SELECT card.id
     FROM kaudit_rate_card_version card
     WHERE card.status = 'published'
       AND card.currency = 'INR'
       AND card.approved_by IS NOT NULL
       AND card.approved_at IS NOT NULL
       AND card.ruleset_sha256 = ?
       AND card.effective_from <= ?
       AND (card.effective_to IS NULL OR card.effective_to >= ?)
     ORDER BY card.effective_from DESC, card.approved_at DESC, card.id DESC
     LIMIT 1`,
    [KSERVE_RULESET_SHA256, period.start, period.end],
  )
  return rows[0]?.id ?? null
}

/**
 * Resolves the uploaded Task IDs against ONE month.
 *
 * A UNION rather than one OR'd predicate, so each returned row is LABELLED
 * with the reference that matched it. That is what lets the caller insist a
 * reference resolved to exactly one call instead of guessing from a count.
 *
 * The month is part of the predicate, not a filter applied afterwards: a Task
 * ID that exists in a different month resolves to nothing here, which is the
 * correct answer for an upload that named this month.
 */
async function resolveUploadedTasks(
  pool: Pool | PoolConnection,
  period: BillingMonthScope,
  taskIds: readonly string[],
): Promise<ResolvedRow[]> {
  const list = placeholders(taskIds.length)
  const facts = (reference: string) => `
    SELECT ${reference} AS task_reference,
           c.id AS call_id,
           artifact.id AS artifact_id,
           artifact.source_url,
           artifact.sha256 AS evidence_sha256,
           EXISTS (
             SELECT 1
             FROM kaudit_invoice invoice
             WHERE c.billing_period_date BETWEEN
                   invoice.period_start AND invoice.period_end
               AND invoice.status IN ('received','matched','approved')
           ) AS invoice_present,
           EXISTS (
             SELECT 1
             FROM kaudit_audit_run run
             WHERE run.call_id = c.id AND run.status = 'completed'
           ) AS audit_completed,
           (
             SELECT live.id
             FROM kaudit_billing_calculation live
             WHERE live.call_id = c.id
               AND live.status = 'final'
               AND NOT EXISTS (
                 SELECT 1
                 FROM kaudit_billing_calculation newer
                 WHERE newer.supersedes_calculation_id = live.id
               )
             ORDER BY live.calculated_at DESC, live.id DESC
             LIMIT 1
           ) AS live_calculation_id,
           (
             SELECT live.calculation_basis
             FROM kaudit_billing_calculation live
             WHERE live.call_id = c.id
               AND live.status = 'final'
               AND NOT EXISTS (
                 SELECT 1
                 FROM kaudit_billing_calculation newer
                 WHERE newer.supersedes_calculation_id = live.id
               )
             ORDER BY live.calculated_at DESC, live.id DESC
             LIMIT 1
           ) AS live_calculation_basis,
           (
             SELECT CAST(live.total_amount AS CHAR)
             FROM kaudit_billing_calculation live
             WHERE live.call_id = c.id
               AND live.status = 'final'
               AND NOT EXISTS (
                 SELECT 1
                 FROM kaudit_billing_calculation newer
                 WHERE newer.supersedes_calculation_id = live.id
               )
             ORDER BY live.calculated_at DESC, live.id DESC
             LIMIT 1
           ) AS live_total_amount`
  const [rows] = await pool.execute<ResolvedRow[]>(
    `${facts('c.logical_call_key')}
     FROM kaudit_call c
     LEFT JOIN kaudit_call_artifact artifact
       ON artifact.call_id = c.id
      AND artifact.artifact_type = 'recording'
      AND artifact.is_final = 1
     WHERE c.billing_period_date BETWEEN ? AND ?
       AND c.logical_call_key IN (${list})
     UNION
     ${facts('ref.external_id')}
     FROM kaudit_call c
     JOIN kaudit_call_external_reference ref
       ON ref.call_id = c.id
      AND ref.reference_type IN ${REFERENCE_TYPES}
      AND ref.external_id IN (${list})
     LEFT JOIN kaudit_call_artifact artifact
       ON artifact.call_id = c.id
      AND artifact.artifact_type = 'recording'
      AND artifact.is_final = 1
     WHERE c.billing_period_date BETWEEN ? AND ?`,
    [
      period.start,
      period.end,
      ...taskIds,
      ...taskIds,
      period.start,
      period.end,
    ],
  )
  return rows
}

/**
 * The facts the pure eligibility rule needs, with every URL already reduced to
 * a hash before it crosses the boundary.
 *
 * A call with several final recording artifacts keeps the one that already
 * carries evidence, if any; otherwise the first empty one. That ordering makes
 * a conflict visible rather than letting a second empty artifact be used to
 * sidestep an artifact that is already populated.
 */
function factsByReference(
  rows: readonly ResolvedRow[],
): Map<string, LateRecordingCallFacts[]> {
  const byReference = new Map<string, Map<string, LateRecordingCallFacts>>()
  for (const row of rows) {
    const calls =
      byReference.get(row.task_reference) ??
      new Map<string, LateRecordingCallFacts>()
    const existing = calls.get(row.call_id)
    const candidate: LateRecordingCallFacts = {
      callId: row.call_id,
      artifactId: row.artifact_id,
      existingUrlSha256: row.source_url
        ? canonicalUrlSha256(row.source_url)
        : null,
      evidenceHashRecorded: row.evidence_sha256 != null,
      invoicePresent: Number(row.invoice_present) === 1,
      auditCompleted: Number(row.audit_completed) === 1,
      liveCalculationId: row.live_calculation_id,
      liveCalculationBasis: row.live_calculation_basis,
      liveTotalAmount:
        row.live_total_amount == null
          ? null
          : fixed8(String(row.live_total_amount)),
    }
    const populated = (facts: LateRecordingCallFacts): boolean =>
      facts.existingUrlSha256 != null || facts.evidenceHashRecorded
    if (!existing || (!populated(existing) && populated(candidate))) {
      calls.set(row.call_id, candidate)
    }
    byReference.set(row.task_reference, calls)
  }
  return new Map(
    [...byReference].map(([reference, calls]) => [reference, [...calls.values()]]),
  )
}

export interface LateRecordingResolution extends LateRecordingPreview {
  billMonth: string
}

/** Accepted rows, with the canonical URL kept SERVER-SIDE for the commit. */
interface AcceptedRow {
  rowNumber: number
  taskId: string
  callId: string
  artifactId: string
  canonicalUrl: string
  canonicalUrlSha256: string
  previousAmount: string | null
  supersededCalculationId: string | null
}

async function resolveBatch(
  pool: Pool | PoolConnection,
  period: BillingMonthScope,
  rows: ReadonlyArray<LateRecordingCsvRow & { canonicalUrl: string }>,
  carriedRejections: readonly LateRecordingRowDecision[],
): Promise<{
  preview: LateRecordingResolution
  accepted: AcceptedRow[]
  rateCardVersionId: string | null
}> {
  if (rows.length > MAX_LATE_RECORDING_ROWS) {
    throw new LateRecordingError(
      'LATE_RECORDING_BATCH_TOO_LARGE',
      400,
      'Late recording upload exceeds the bounded batch size',
    )
  }
  const rateCardVersionId = await applicableRateCardId(pool, period)
  const facts =
    rows.length === 0
      ? new Map<string, LateRecordingCallFacts[]>()
      : factsByReference(
          await resolveUploadedTasks(
            pool,
            period,
            rows.map((row) => row.taskId),
          ),
        )
  const decisions: LateRecordingRowDecision[] = [...carriedRejections]
  const accepted: AcceptedRow[] = []
  for (const row of rows) {
    const urlSha256 = canonicalUrlSha256(row.canonicalUrl)
    const outcome = decideLateRecordingRow({
      rateCardAvailable: rateCardVersionId != null,
      row: {
        rowNumber: row.rowNumber,
        taskId: row.taskId,
        canonicalUrlSha256: urlSha256,
        matches: facts.get(row.taskId) ?? [],
      },
    })
    decisions.push(outcome.decision)
    if (outcome.decision.outcome === 'accepted') {
      accepted.push({
        rowNumber: row.rowNumber,
        taskId: row.taskId,
        callId: outcome.callId as string,
        artifactId: outcome.artifactId as string,
        canonicalUrl: row.canonicalUrl,
        canonicalUrlSha256: urlSha256,
        previousAmount: outcome.previousAmount ?? null,
        supersededCalculationId: outcome.supersededCalculationId ?? null,
      })
    }
  }
  return {
    preview: {
      billMonth: period.month,
      ...summarizeLateRecordingDecisions(
        decisions,
        decisions.length,
      ),
    },
    accepted,
    rateCardVersionId,
  }
}

/**
 * Validates an upload and writes NOTHING.
 *
 * Every statement this path runs is a SELECT. That is the contract a preview
 * makes to the administrator: looking at the consequences of an upload can
 * never be the thing that applies it.
 */
export async function previewLateRecordingBatch(
  pool: Pool,
  input: {
    period: BillingMonthScope
    rows: ReadonlyArray<LateRecordingCsvRow & { canonicalUrl: string }>
    carriedRejections: readonly LateRecordingRowDecision[]
  },
): Promise<LateRecordingResolution> {
  try {
    const { preview } = await resolveBatch(
      pool,
      input.period,
      input.rows,
      input.carriedRejections,
    )
    return preview
  } catch (error) {
    throw asSafeLateRecordingError(error)
  }
}

export interface LateRecordingCommitReceipt extends LateRecordingResolution {
  /** Opaque batch handle. The ONLY identifier a dispatch may carry. */
  batchId: string | null
  outcome: 'accepted' | 'replayed' | 'nothing_to_do'
  status: LateRecordingBatchStatus | null
}

/**
 * Commits a previewed upload.
 *
 * The write order is structural. The artifact transition is attempted FIRST,
 * with the `source_url IS NULL AND sha256 IS NULL` predicate carried into the
 * statement, so the database itself decides whether this is still the empty
 * artifact the preview saw. Only a row that actually transitioned becomes an
 * item, which is what makes the queue an exact record of attached evidence
 * rather than of intent.
 */
export async function commitLateRecordingBatch(
  pool: Pool,
  input: {
    period: BillingMonthScope
    rows: ReadonlyArray<LateRecordingCsvRow & { canonicalUrl: string }>
    carriedRejections: readonly LateRecordingRowDecision[]
    sourceFileSha256: string
    idempotencyKey: string
    requestedByUserId: string | null
    correlationId: string
    requestedAt: Date
  },
): Promise<LateRecordingCommitReceipt> {
  const connection = await pool.getConnection()
  let held = false
  try {
    const [lockRows] = await connection.query<RowDataPacket[]>(
      `SELECT GET_LOCK(?, ?) AS acquired`,
      [COMMIT_LOCK, COMMIT_LOCK_TIMEOUT_SECONDS],
    )
    held = Number(lockRows[0]?.acquired || 0) === 1
    if (!held) {
      throw new LateRecordingError(
        'LATE_RECORDING_BUSY',
        409,
        'Another late recording upload is being accepted; retry this request',
      )
    }
    // Request identity must not depend on mutable call state. Once the first
    // commit attaches evidence, the same row resolves as already attached;
    // hashing only currently accepted rows would therefore turn a genuine
    // retry into a conflict. Canonical task/URL pairs are stable across signed
    // URL refreshes and across every later lifecycle transition.
    const digest = lateRecordingBatchDigest({
      billMonth: input.period.month,
      items: input.rows.map((row) => ({
        taskId: row.taskId,
        canonicalUrlSha256: canonicalUrlSha256(row.canonicalUrl),
      })),
    })
    const { preview, accepted, rateCardVersionId } = await resolveBatch(
      connection,
      input.period,
      input.rows,
      input.carriedRejections,
    )

    await connection.beginTransaction()
    /**
     * A retry of an accepted commit replays it. The digest is what makes that
     * safe: the same key carrying a DIFFERENT selection is a caller bug, not a
     * retry, and is refused rather than silently re-scoped.
     */
    const [replayRows] = await connection.execute<BatchRow[]>(
      `SELECT id, bill_month, request_digest, status, submitted_count,
              accepted_count, rejected_count, corrected_count, failed_count
       FROM kaudit_late_recording_batch
       WHERE idempotency_key = ?`,
      [input.idempotencyKey],
    )
    const replay = replayRows[0]
    if (replay) {
      if (
        replay.request_digest !== digest ||
        replay.bill_month !== input.period.month
      ) {
        throw new LateRecordingError(
          'LATE_RECORDING_REQUEST_CONFLICT',
          409,
          'Late recording retry key conflicts with an earlier upload',
        )
      }
      await connection.commit()
      return {
        ...preview,
        batchId: replay.id,
        outcome: 'replayed',
        status: replay.status,
      }
    }
    if (accepted.length === 0) {
      // Nothing to attach. No batch row is written, so the same upload stays
      // answerable the same way and no empty queue is left behind.
      await connection.commit()
      return {
        ...preview,
        batchId: null,
        outcome: 'nothing_to_do',
        status: null,
      }
    }
    if (!rateCardVersionId) {
      throw new LateRecordingError(
        'LATE_RECORDING_RATE_CARD_CHANGED',
        409,
        'The applicable published rate card changed; preview the upload again',
      )
    }

    const batchId = lateRecordingId('lrb')
    const attached: AcceptedRow[] = []
    const lostRaces: LateRecordingRowDecision[] = []
    for (const row of accepted) {
      /**
       * The one-way transition, expressed as a predicate.
       *
       * `source_url IS NULL AND sha256 IS NULL` is what makes this an
       * ATTACHMENT rather than an update: it can only ever fire on an artifact
       * that has no evidence behind it at all. If the row changed between the
       * resolution above and here, zero rows match and the upload row becomes
       * a conflict instead of an overwrite.
       */
      const [updated] = await connection.execute<ResultSetHeader>(
        `UPDATE kaudit_call_artifact
         SET source_url = ?,
             audio_processing_status = 'pending',
             audio_attempt_count = 0,
             audio_last_attempt_at = NULL,
             audio_next_attempt_at = NULL,
             audio_last_error = NULL
         WHERE id = ? AND call_id = ?
           AND artifact_type = 'recording' AND is_final = 1
           AND source_url IS NULL AND sha256 IS NULL`,
        [row.canonicalUrl, row.artifactId, row.callId],
      )
      if (updated.affectedRows !== 1) {
        lostRaces.push({
          rowNumber: row.rowNumber,
          outcome: 'rejected',
          code: 'RECORDING_URL_ALREADY_PRESENT',
        })
        continue
      }
      attached.push(row)
    }
    if (attached.length === 0) {
      // Every accepted row lost its race. Nothing was attached, so nothing is
      // queued; the transaction still commits because it changed nothing.
      await connection.commit()
      const settled = summarizeLateRecordingDecisions(
        [
          ...preview.decisions.filter(
            (decision) =>
              !lostRaces.some(
                (lost) => lost.rowNumber === decision.rowNumber,
              ),
          ),
          ...lostRaces,
        ],
        preview.submittedCount,
      )
      return {
        billMonth: input.period.month,
        ...settled,
        batchId: null,
        outcome: 'nothing_to_do',
        status: null,
      }
    }

    const decisions = [
      ...preview.decisions.filter(
        (decision) =>
          !lostRaces.some((lost) => lost.rowNumber === decision.rowNumber),
      ),
      ...lostRaces,
    ]
    const settled = summarizeLateRecordingDecisions(
      decisions,
      preview.submittedCount,
    )
    await connection.execute(
      `INSERT INTO kaudit_late_recording_batch
         (id, bill_month, period_start, period_end, source_file_sha256,
          request_digest, idempotency_key, requested_by_user_id,
          correlation_id, ruleset_version, rate_card_version_id,
          status, submitted_count,
          accepted_count, rejected_count, requested_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'accepted', ?, ?, ?, ?)`,
      [
        batchId,
        input.period.month,
        input.period.start,
        input.period.end,
        input.sourceFileSha256,
        digest,
        input.idempotencyKey,
        input.requestedByUserId,
        input.correlationId,
        REAUDIT_CLASSIFIER_RULESET_VERSION,
        rateCardVersionId,
        settled.submittedCount,
        attached.length,
        settled.rejectedCount,
        input.requestedAt,
      ],
    )
    for (const row of attached) {
      await connection.execute(
        `INSERT INTO kaudit_late_recording_item
           (id, batch_id, call_id, call_artifact_id, task_reference,
            row_number, canonical_url_sha256, previous_amount,
            superseded_calculation_id, state, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'accepted', ?)`,
        [
          lateRecordingId('lri'),
          batchId,
          row.callId,
          row.artifactId,
          row.taskId,
          row.rowNumber,
          row.canonicalUrlSha256,
          row.previousAmount,
          row.supersededCalculationId,
          input.requestedAt,
        ],
      )
    }
    await connection.commit()
    return {
      billMonth: input.period.month,
      ...settled,
      batchId,
      outcome: 'accepted',
      status: 'accepted',
    }
  } catch (error) {
    await connection.rollback().catch(() => undefined)
    throw asSafeLateRecordingError(error)
  } finally {
    if (held) {
      await connection
        .query(`SELECT RELEASE_LOCK(?)`, [COMMIT_LOCK])
        .catch(() => undefined)
    }
    connection.release()
  }
}

/**
 * The worker's claim over ONE batch.
 *
 * The candidate predicate is an exact join to `kaudit_late_recording_item`
 * rows of this batch: `batch_id = ?` and nothing else selects work. There is
 * deliberately no month predicate, no status sweep, and no eligibility scan --
 * a run cannot widen into unrelated calls even if every other guard failed,
 * because no unrelated call has a row in this batch.
 *
 * Claiming and enriching are separate statements, so a running audit worker
 * cannot block, or be blocked by, the pipeline it is auditing.
 */
export function createMysqlLateRecordingCandidateRepository(
  pool: Pool,
  options: { batchId: string },
): ReauditCandidateRepository {
  const batchId = options.batchId
  return {
    async listCandidates(listOptions) {
      const limit = Math.min(
        Math.max(1, listOptions.limit),
        MAX_LATE_RECORDING_ROWS,
      )
      const connection = await pool.getConnection()
      let claimed: ClaimedItemRow[] = []
      try {
        await connection.beginTransaction()
        const [rows] = await connection.execute<ClaimedItemRow[]>(
          `SELECT item.id AS item_id, item.batch_id, item.call_id,
                  item.call_artifact_id AS artifact_id,
                  artifact.source_url, artifact.sha256 AS evidence_sha256,
                  item.state AS item_state
           FROM kaudit_late_recording_item item
           JOIN kaudit_call_artifact artifact
             ON artifact.id = item.call_artifact_id
            AND artifact.source_url IS NOT NULL
           WHERE item.batch_id = ?
             AND (
               (item.state = 'accepted' AND item.attempt_count = 0)
               OR (
                 item.state = 'auditing'
                 AND item.attempt_count = 1
                 AND COALESCE(artifact.audio_attempt_count, 0) < 8
                 AND NOT EXISTS (
                   SELECT 1 FROM kaudit_audit_run completed_run
                   WHERE completed_run.call_id = item.call_id
                     AND completed_run.status = 'completed'
                 )
                 AND (
                   (
                     COALESCE(artifact.audio_processing_status, 'pending')
                       NOT IN ('completed','exhausted')
                     AND (
                       artifact.audio_next_attempt_at IS NULL
                       OR artifact.audio_next_attempt_at <= current_timestamp(6)
                     )
                   )
                   OR (
                     artifact.audio_processing_status = 'exhausted'
                     AND artifact.audio_last_error IN (
                       'CLASSIFICATION_VALIDATION_FAILED',
                       'AUDIT_SPEND_STATE_UNKNOWN'
                     )
                   )
                 )
               )
             )
           ORDER BY item.row_number, item.id
           LIMIT ${limit}
           FOR UPDATE`,
          [batchId],
        )
        claimed = rows
        for (const row of rows) {
          if (row.item_state === 'auditing') continue
          const [updated] = await connection.execute<ResultSetHeader>(
            `UPDATE kaudit_late_recording_item
             SET state = 'auditing',
                 attempt_count = attempt_count + 1,
                 started_at = current_timestamp(6),
                 last_error_code = NULL
             WHERE id = ? AND state = 'accepted' AND attempt_count = 0`,
            [row.item_id],
          )
          if (updated.affectedRows !== 1) {
            claimed = claimed.filter(
              (candidate) => candidate.item_id !== row.item_id,
            )
          }
        }
        await connection.execute(
          `UPDATE kaudit_late_recording_batch
           SET status = 'running',
               started_at = COALESCE(started_at, current_timestamp(6))
           WHERE id = ? AND status = 'accepted'`,
          [batchId],
        )
        await connection.commit()
      } catch (error) {
        await connection.rollback().catch(() => undefined)
        connection.release()
        throw asSafeLateRecordingError(error)
      }
      if (claimed.length === 0) {
        connection.release()
        return []
      }
      try {
        const callIds = claimed.map((row) => row.call_id)
        const [costs] = await connection.execute<CostRow[]>(
          `SELECT cost.call_id,
                  MAX(CASE
                        WHEN cost.provider_sku = 'duration_with_ringing_sec'
                        THEN ROUND(cost.quantity_decimal * 1000)
                      END) AS claimed_duration_ms,
                  MAX(CASE
                        WHEN cost.provider_sku = 'duration_without_ringing_sec'
                        THEN ROUND(cost.quantity_decimal * 1000)
                      END) AS connected_duration_ms,
                  MAX(CASE
                        WHEN cost.provider_sku =
                             'vendor_asserted_billed_minutes'
                        THEN CAST(cost.minutes_decimal AS CHAR)
                      END) AS vendor_billed_minutes
           FROM kaudit_provider_cost cost
           WHERE cost.call_id IN (${placeholders(callIds.length)})
           GROUP BY cost.call_id`,
          callIds,
        )
        const costByCall = new Map(costs.map((row) => [row.call_id, row]))
        return claimed.map((item): ReauditCandidate => {
          const cost = costByCall.get(item.call_id)
          return {
            callId: item.call_id,
            artifactId: item.artifact_id,
            // The URL reaches the fetcher and nothing else. It is not stored
            // on the item, not logged, and not returned by any read.
            sourceUrl: item.source_url,
            baselineSha256: item.evidence_sha256,
            claimedDurationMs: nullableMs(cost?.claimed_duration_ms ?? null),
            connectedDurationMs: nullableMs(
              cost?.connected_duration_ms ?? null,
            ),
            vendorBilledMinutes: cost?.vendor_billed_minutes ?? null,
          }
        })
      } catch (error) {
        throw asSafeLateRecordingError(error)
      } finally {
        connection.release()
      }
    },
    async deferredWorkDueInMs() {
      const [rows] = await pool.execute<RowDataPacket[]>(
        `SELECT TIMESTAMPDIFF(
                  MICROSECOND,
                  current_timestamp(6),
                  MIN(artifact.audio_next_attempt_at)
                ) AS due_in_us
         FROM kaudit_late_recording_item item
         JOIN kaudit_call_artifact artifact
           ON artifact.id = item.call_artifact_id
          AND artifact.source_url IS NOT NULL
         WHERE item.batch_id = ?
           AND item.state = 'auditing'
           AND item.attempt_count = 1
           AND COALESCE(artifact.audio_attempt_count, 0) < 8
           AND COALESCE(artifact.audio_processing_status, 'pending')
                 NOT IN ('completed','exhausted')
           AND artifact.audio_next_attempt_at IS NOT NULL
           AND artifact.audio_next_attempt_at > current_timestamp(6)
           AND NOT EXISTS (
             SELECT 1 FROM kaudit_audit_run completed_run
             WHERE completed_run.call_id = item.call_id
               AND completed_run.status = 'completed'
           )`,
        [batchId],
      )
      const microseconds = rows[0]?.due_in_us
      if (microseconds == null) return null
      const value = Number(microseconds)
      return Number.isFinite(value) ? Math.max(0, Math.round(value / 1_000)) : null
    },
  }
}

/**
 * Settles one item terminally.
 *
 * `corrected` and `failed` are the only outcomes, and both are reached from
 * `auditing`. The audit and the money are two writes, and a crash between them
 * leaves the item in `auditing` on purpose: the correction pass is a function
 * of durable audit state, so re-running it finishes the item without ever
 * re-spending on a model.
 */
export async function settleLateRecordingItem(
  connection: PoolConnection | Pool,
  input: {
    batchId: string
    itemId: string
    outcome: 'corrected' | 'failed'
    errorCode?: string | null
    previousAmount?: string | null
    revisedAmount?: string | null
    supersededCalculationId?: string | null
    at: Date
  },
): Promise<void> {
  const [updated] = await connection.execute<ResultSetHeader>(
    `UPDATE kaudit_late_recording_item
     SET state = ?,
         completed_at = ?,
         last_error_code = ?,
         previous_amount = COALESCE(?, previous_amount),
         revised_amount = COALESCE(?, revised_amount),
         superseded_calculation_id =
           COALESCE(?, superseded_calculation_id)
     WHERE id = ? AND batch_id = ? AND state = 'auditing'`,
    [
      input.outcome,
      input.at,
      input.outcome === 'failed'
        ? safeLateRecordingFailureCode(input.errorCode)
        : null,
      input.previousAmount == null ? null : fixed8(input.previousAmount),
      input.revisedAmount == null ? null : fixed8(input.revisedAmount),
      input.supersededCalculationId ?? null,
      input.itemId,
      input.batchId,
    ],
  )
  if (updated.affectedRows !== 1) {
    throw new LateRecordingError(
      'LATE_RECORDING_ITEM_STATE_CONFLICT',
      500,
      'Late recording item is not in the expected state',
    )
  }
  await connection.execute(
    `UPDATE kaudit_late_recording_batch batch
     SET batch.corrected_count = (
           SELECT COUNT(*) FROM kaudit_late_recording_item item
           WHERE item.batch_id = batch.id AND item.state = 'corrected'
         ),
         batch.failed_count = (
           SELECT COUNT(*) FROM kaudit_late_recording_item item
           WHERE item.batch_id = batch.id AND item.state = 'failed'
         ),
         batch.status = 'running',
         batch.completed_at = NULL
     WHERE batch.id = ?`,
    [input.batchId],
  )
}

/**
 * The month's auditor-verified payable total, from live calculations only.
 *
 * The predicate is the platform's existing definition of "current": a final
 * calculation nothing supersedes. Reading it the same way before and after the
 * batch is what makes the recorded delta a fact rather than an estimate.
 */
export async function readVerifiedMonthTotal(
  pool: Pool | PoolConnection,
  period: BillingMonthScope,
): Promise<string> {
  const [rows] = await pool.execute<TotalRow[]>(
    `SELECT CAST(COALESCE(SUM(calculation.total_amount), 0) AS CHAR)
              AS verified_total
     FROM kaudit_billing_calculation calculation
     JOIN kaudit_call c ON c.id = calculation.call_id
     WHERE c.billing_period_date BETWEEN ? AND ?
       AND calculation.status = 'final'
       AND NOT EXISTS (
         SELECT 1
         FROM kaudit_billing_calculation newer
         WHERE newer.supersedes_calculation_id = calculation.id
       )`,
    [period.start, period.end],
  )
  return fixed8(rows[0]?.verified_total ?? '0')
}

/** The current recorded actual-paid settlement, or null when none exists. */
export async function readActualPaidAmount(
  pool: Pool | PoolConnection,
  month: string,
): Promise<string | null> {
  try {
    const [rows] = await pool.execute<RowDataPacket[]>(
      `SELECT CAST(final_paid_amount AS CHAR) AS final_paid_amount
       FROM kaudit_kserve_monthly_settlement
       WHERE bill_month = ?
       ORDER BY version_no DESC
       LIMIT 1`,
      [month],
    )
    const amount = rows[0]?.final_paid_amount
    return amount == null ? null : fixed8(String(amount))
  } catch {
    // The settlement table is Finance's, not this workflow's. Its absence or
    // unavailability leaves the proposed adjustment unknown, never zero.
    return null
  }
}

export interface LateRecordingBatchPreparation {
  rateCardVersionId: string
  previousVerifiedTotal: string
  finalized: boolean
}

/**
 * Captures the batch's BEFORE-month total exactly once.
 *
 * The late-recording worker holds the global Billing Audit advisory lock while
 * calling this function. The row lock makes a duplicate dispatch harmless;
 * the first caller writes the baseline and every retry reads the same value.
 */
export async function prepareLateRecordingBatch(
  pool: Pool,
  input: { batchId: string; period: BillingMonthScope; at: Date },
): Promise<LateRecordingBatchPreparation | null> {
  const connection = await pool.getConnection()
  try {
    await connection.beginTransaction()
    const [rows] = await connection.execute<BatchRow[]>(
      `SELECT id, bill_month, request_digest, status, submitted_count,
              accepted_count, rejected_count, corrected_count, failed_count,
              rate_card_version_id,
              CAST(baseline_verified_total AS CHAR) AS baseline_verified_total,
              baseline_captured_at
       FROM kaudit_late_recording_batch
       WHERE id = ?
       FOR UPDATE`,
      [input.batchId],
    )
    const batch = rows[0]
    if (!batch) {
      await connection.commit()
      return null
    }
    const [correctionRows] = await connection.execute<RowDataPacket[]>(
      `SELECT 1 AS present
       FROM kaudit_late_recording_month_correction
       WHERE batch_id = ?`,
      [input.batchId],
    )
    let previousVerifiedTotal = batch.baseline_verified_total
    if (previousVerifiedTotal == null) {
      previousVerifiedTotal = await readVerifiedMonthTotal(
        connection,
        input.period,
      )
      const [captured] = await connection.execute<ResultSetHeader>(
        `UPDATE kaudit_late_recording_batch
         SET baseline_verified_total = ?, baseline_captured_at = ?,
             status = 'running',
             started_at = COALESCE(started_at, ?)
         WHERE id = ? AND baseline_verified_total IS NULL`,
        [previousVerifiedTotal, input.at, input.at, input.batchId],
      )
      if (captured.affectedRows !== 1) {
        throw new LateRecordingError(
          'LATE_RECORDING_BASELINE_CONFLICT',
          409,
          'Late recording baseline was changed concurrently',
        )
      }
    } else if (batch.status === 'accepted') {
      await connection.execute(
        `UPDATE kaudit_late_recording_batch
         SET status = 'running', started_at = COALESCE(started_at, ?)
         WHERE id = ? AND status = 'accepted'`,
        [input.at, input.batchId],
      )
    }
    await connection.commit()
    return {
      rateCardVersionId: batch.rate_card_version_id,
      previousVerifiedTotal: fixed8(previousVerifiedTotal),
      finalized: correctionRows.length > 0,
    }
  } catch (error) {
    await connection.rollback().catch(() => undefined)
    throw asSafeLateRecordingError(error)
  } finally {
    connection.release()
  }
}

interface CorrectionRecordRow extends RowDataPacket {
  bill_month: string
  currency: string
  previous_verified_total: string
  revised_verified_total: string
  delta_amount: string
  actual_paid_amount: string | null
  revised_variance: string | null
  corrected_count: number | string
  failed_count: number | string
  completed_at: Date | string
}

interface ItemRollupRow extends RowDataPacket {
  live_count: number | string
  corrected_count: number | string
  failed_count: number | string
  completed_at: Date | string | null
}

function sameInstant(left: Date | string, right: Date): boolean {
  return new Date(left).getTime() === right.getTime()
}

function correctionMatches(
  row: CorrectionRecordRow,
  input: {
    billMonth: string
    previousVerifiedTotal: string
    revisedVerifiedTotal: string
    deltaAmount: string
    actualPaidAmount: string | null
    revisedVariance: string | null
    correctedCount: number
    failedCount: number
    completedAt: Date
  },
): boolean {
  const optional = (value: string | null): string | null =>
    value == null ? null : fixed8(String(value))
  return row.bill_month === input.billMonth &&
    row.currency === 'INR' &&
    fixed8(String(row.previous_verified_total)) === input.previousVerifiedTotal &&
    fixed8(String(row.revised_verified_total)) === input.revisedVerifiedTotal &&
    fixed8(String(row.delta_amount)) === input.deltaAmount &&
    optional(row.actual_paid_amount) === input.actualPaidAmount &&
    optional(row.revised_variance) === input.revisedVariance &&
    Number(row.corrected_count) === input.correctedCount &&
    Number(row.failed_count) === input.failedCount &&
    sameInstant(row.completed_at, input.completedAt)
}

function duplicateKey(error: unknown): boolean {
  return typeof error === 'object' && error !== null &&
    (error as { code?: unknown }).code === 'ER_DUP_ENTRY'
}

export interface LateRecordingFinalizationResult {
  outcome: 'recorded' | 'replayed' | 'in_flight'
  previousVerifiedTotal: string
  revisedVerifiedTotal: string | null
  deltaAmount: string | null
  correctedCount: number
  failedCount: number
}

/**
 * Atomically appends the immutable month correction and terminalizes its batch.
 * A batch is never shown as completed without the correction row that explains
 * the money, and a restart can finalize an all-terminal item set.
 */
export async function finalizeLateRecordingBatch(
  pool: Pool,
  input: {
    batchId: string
    billMonth: string
    revisedVerifiedTotal: string
    actualPaidAmount: string | null
    revisedVariance: string | null
  },
): Promise<LateRecordingFinalizationResult> {
  const connection = await pool.getConnection()
  try {
    await connection.beginTransaction()
    const [batchRows] = await connection.execute<BatchRow[]>(
      `SELECT id, bill_month, request_digest, status, submitted_count,
              accepted_count, rejected_count, corrected_count, failed_count,
              rate_card_version_id,
              CAST(baseline_verified_total AS CHAR) AS baseline_verified_total,
              baseline_captured_at
       FROM kaudit_late_recording_batch
       WHERE id = ?
       FOR UPDATE`,
      [input.batchId],
    )
    const batch = batchRows[0]
    if (!batch || batch.bill_month !== input.billMonth ||
        batch.baseline_verified_total == null) {
      throw new LateRecordingError(
        'LATE_RECORDING_FINALIZATION_CONFLICT',
        409,
        'Late recording batch is not ready to finalize',
      )
    }
    const [rollupRows] = await connection.execute<ItemRollupRow[]>(
      `SELECT
         SUM(state IN ('accepted','auditing')) AS live_count,
         SUM(state = 'corrected') AS corrected_count,
         SUM(state = 'failed') AS failed_count,
         MAX(completed_at) AS completed_at
       FROM kaudit_late_recording_item
       WHERE batch_id = ?`,
      [input.batchId],
    )
    const rollup = rollupRows[0]
    const correctedCount = Number(rollup?.corrected_count ?? 0)
    const failedCount = Number(rollup?.failed_count ?? 0)
    if (Number(rollup?.live_count ?? 0) > 0) {
      await connection.commit()
      return {
        outcome: 'in_flight',
        previousVerifiedTotal: fixed8(batch.baseline_verified_total),
        revisedVerifiedTotal: null,
        deltaAmount: null,
        correctedCount,
        failedCount,
      }
    }
    if (correctedCount + failedCount !== Number(batch.accepted_count) ||
        rollup?.completed_at == null) {
      throw new LateRecordingError(
        'LATE_RECORDING_FINALIZATION_CONFLICT',
        409,
        'Late recording item totals do not match the accepted batch',
      )
    }
    const totals = lateRecordingCorrectionTotals({
      previousVerifiedTotal: batch.baseline_verified_total,
      revisedVerifiedTotal: input.revisedVerifiedTotal,
      correctedCount,
    })
    const completedAt = new Date(rollup.completed_at)
    const payload = {
      billMonth: input.billMonth,
      previousVerifiedTotal: totals.previousVerifiedTotal,
      revisedVerifiedTotal: totals.revisedVerifiedTotal,
      deltaAmount: totals.deltaAmount,
      actualPaidAmount:
        input.actualPaidAmount == null ? null : fixed8(input.actualPaidAmount),
      revisedVariance:
        input.revisedVariance == null ? null : fixed8(input.revisedVariance),
      correctedCount,
      failedCount,
      completedAt,
    }
    const [existingRows] = await connection.execute<CorrectionRecordRow[]>(
      `SELECT bill_month, currency,
              CAST(previous_verified_total AS CHAR) AS previous_verified_total,
              CAST(revised_verified_total AS CHAR) AS revised_verified_total,
              CAST(delta_amount AS CHAR) AS delta_amount,
              CAST(actual_paid_amount AS CHAR) AS actual_paid_amount,
              CAST(revised_variance AS CHAR) AS revised_variance,
              corrected_count, failed_count, completed_at
       FROM kaudit_late_recording_month_correction
       WHERE batch_id = ?
       FOR UPDATE`,
      [input.batchId],
    )
    let outcome: 'recorded' | 'replayed' = 'replayed'
    if (existingRows[0]) {
      if (!correctionMatches(existingRows[0], payload)) {
        throw new LateRecordingError(
          'LATE_RECORDING_CORRECTION_CONFLICT',
          409,
          'Late recording correction conflicts with its immutable result',
        )
      }
    } else {
      try {
        await connection.execute<ResultSetHeader>(
          `INSERT INTO kaudit_late_recording_month_correction
             (id, batch_id, bill_month, currency, previous_verified_total,
              revised_verified_total, delta_amount, actual_paid_amount,
              revised_variance, corrected_count, failed_count, completed_at)
           VALUES (?, ?, ?, 'INR', ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            lateRecordingId('lrc'),
            input.batchId,
            payload.billMonth,
            payload.previousVerifiedTotal,
            payload.revisedVerifiedTotal,
            payload.deltaAmount,
            payload.actualPaidAmount,
            payload.revisedVariance,
            payload.correctedCount,
            payload.failedCount,
            payload.completedAt,
          ],
        )
        outcome = 'recorded'
      } catch (error) {
        if (!duplicateKey(error)) throw error
        const [racedRows] = await connection.execute<CorrectionRecordRow[]>(
          `SELECT bill_month, currency,
                  CAST(previous_verified_total AS CHAR) AS previous_verified_total,
                  CAST(revised_verified_total AS CHAR) AS revised_verified_total,
                  CAST(delta_amount AS CHAR) AS delta_amount,
                  CAST(actual_paid_amount AS CHAR) AS actual_paid_amount,
                  CAST(revised_variance AS CHAR) AS revised_variance,
                  corrected_count, failed_count, completed_at
           FROM kaudit_late_recording_month_correction
           WHERE batch_id = ?
           FOR UPDATE`,
          [input.batchId],
        )
        if (!racedRows[0] || !correctionMatches(racedRows[0], payload)) {
          throw new LateRecordingError(
            'LATE_RECORDING_CORRECTION_CONFLICT',
            409,
            'Late recording correction conflicts with its immutable result',
          )
        }
      }
    }
    await connection.execute(
      `UPDATE kaudit_late_recording_batch
       SET corrected_count = ?, failed_count = ?,
           status = ?, completed_at = ?
       WHERE id = ?`,
      [
        correctedCount,
        failedCount,
        failedCount > 0 ? 'completed_with_failures' : 'completed',
        completedAt,
        input.batchId,
      ],
    )
    await connection.commit()
    return {
      outcome,
      previousVerifiedTotal: payload.previousVerifiedTotal,
      revisedVerifiedTotal: payload.revisedVerifiedTotal,
      deltaAmount: payload.deltaAmount,
      correctedCount,
      failedCount,
    }
  } catch (error) {
    await connection.rollback().catch(() => undefined)
    throw asSafeLateRecordingError(error)
  } finally {
    connection.release()
  }
}

export interface LateRecordingBatchProgress {
  batchId: string
  billMonth: string
  status: LateRecordingBatchStatus
  submitted: number
  accepted: number
  rejected: number
  queued: number
  auditing: number
  completed: number
  failed: number
  /** True only after the append-only month correction exists. */
  finalized: boolean
  previousVerifiedTotal: string | null
  revisedVerifiedTotal: string | null
  totalAdjustment: string | null
  items: Array<{
    taskReference: string
    rowNumber: number
    state: LateRecordingItemState
    previousAmount: string | null
    revisedAmount: string | null
    failureCode: string | null
    completedAt: string | null
  }>
}

/**
 * The administrator's progress read.
 *
 * Returns the uploaded Task ID -- which the administrator typed and is already
 * looking at -- lifecycle, bounded failure codes, and fixed-precision amounts.
 * It returns no URL, no internal call id, no artifact id, no audit-run id, and
 * no item id.
 */
export async function readLateRecordingBatchProgress(
  pool: Pool,
  batchId: string,
): Promise<LateRecordingBatchProgress | null> {
  try {
    const [batchRows] = await pool.execute<BatchRow[]>(
      `SELECT id, bill_month, request_digest, status, submitted_count,
              accepted_count, rejected_count, corrected_count, failed_count
       FROM kaudit_late_recording_batch
       WHERE id = ?`,
      [batchId],
    )
    const batch = batchRows[0]
    if (!batch) return null
    const [items] = await pool.execute<ProgressRow[]>(
      `SELECT task_reference, row_number, state,
              CAST(previous_amount AS CHAR) AS previous_amount,
              CAST(revised_amount AS CHAR) AS revised_amount,
              last_error_code, completed_at
       FROM kaudit_late_recording_item
       WHERE batch_id = ?
       ORDER BY row_number, id`,
      [batchId],
    )
    const [corrections] = await pool.execute<RowDataPacket[]>(
      `SELECT CAST(previous_verified_total AS CHAR) AS previous_verified_total,
              CAST(revised_verified_total AS CHAR) AS revised_verified_total,
              CAST(delta_amount AS CHAR) AS delta_amount
       FROM kaudit_late_recording_month_correction
       WHERE batch_id = ?`,
      [batchId],
    )
    const correction = corrections[0]
    const counted = (state: LateRecordingItemState): number =>
      items.filter((item) => item.state === state).length
    return {
      batchId: batch.id,
      billMonth: batch.bill_month,
      status: batch.status,
      submitted: Number(batch.submitted_count),
      accepted: Number(batch.accepted_count),
      rejected: Number(batch.rejected_count),
      queued: counted('accepted'),
      auditing: counted('auditing'),
      completed: counted('corrected'),
      failed: counted('failed'),
      finalized: correction != null,
      previousVerifiedTotal:
        correction?.previous_verified_total == null
          ? null
          : fixed8(String(correction.previous_verified_total)),
      revisedVerifiedTotal:
        correction?.revised_verified_total == null
          ? null
          : fixed8(String(correction.revised_verified_total)),
      totalAdjustment:
        correction?.delta_amount == null
          ? null
          : fixed8(String(correction.delta_amount)),
      items: items.map((item) => ({
        taskReference: item.task_reference,
        rowNumber: Number(item.row_number),
        state: item.state,
        previousAmount:
          item.previous_amount == null
            ? null
            : fixed8(String(item.previous_amount)),
        revisedAmount:
          item.revised_amount == null
            ? null
            : fixed8(String(item.revised_amount)),
        failureCode:
          item.state === 'failed'
            ? safeLateRecordingFailureCode(item.last_error_code)
            : null,
        completedAt:
          item.completed_at == null
            ? null
            : new Date(item.completed_at).toISOString(),
      })),
    }
  } catch (error) {
    throw asSafeLateRecordingError(error)
  }
}

/**
 * Batches the scheduled recovery run should pick up.
 *
 * A batch that was accepted and never drained -- a dispatch that failed, a
 * host that died, a worker that lost its lock -- is invisible to everything
 * else, because nothing polls the item queue globally. This is the read that
 * makes the workflow recoverable without an administrator re-uploading.
 */
export async function listUnfinishedLateRecordingBatchIds(
  pool: Pool,
  limit = 5,
): Promise<string[]> {
  const bounded = Math.min(Math.max(1, limit), 50)
  try {
    const [rows] = await pool.execute<RowDataPacket[]>(
      `SELECT batch.id
       FROM kaudit_late_recording_batch batch
       WHERE NOT EXISTS (
         SELECT 1
         FROM kaudit_late_recording_month_correction correction
         WHERE correction.batch_id = batch.id
       )
       ORDER BY batch.requested_at
       LIMIT ${bounded}`,
    )
    return rows.map((row) => String(row.id))
  } catch (error) {
    throw asSafeLateRecordingError(error)
  }
}

/** The batch's accepted items that still need money written. */
export async function listLateRecordingItemsAwaitingCorrection(
  pool: Pool,
  batchId: string,
): Promise<
  Array<{ itemId: string; callId: string; taskReference: string }>
> {
  try {
    const [rows] = await pool.execute<RowDataPacket[]>(
      `SELECT id, call_id, task_reference
       FROM kaudit_late_recording_item
       WHERE batch_id = ? AND state = 'auditing'
       ORDER BY row_number, id
       LIMIT ${MAX_LATE_RECORDING_ROWS}`,
      [batchId],
    )
    return rows.map((row) => ({
      itemId: String(row.id),
      callId: String(row.call_id),
      taskReference: String(row.task_reference),
    }))
  } catch (error) {
    throw asSafeLateRecordingError(error)
  }
}

interface CorrectionFactsRow extends RowDataPacket {
  item_id: string
  call_id: string
  task_reference: string
  state: LateRecordingItemState
  artifact_id: string
  audio_processing_status: string | null
  audio_attempt_count: number | string | null
  audio_last_error: string | null
  audit_run_id: string | null
  category: string | null
  recorded_duration_ms: number | string | null
  speech_ms: number | string | null
  service_end_ms: number | string | null
  grace_ms: number | string | null
  vendor_billed_minutes: string | null
  vendor_billed_amount: string | null
  claimed_duration_ms: number | string | null
  connected_duration_ms: number | string | null
  evidence_object_id: string | null
  evidence_sha256: string | null
  baseline_calculation_id: string | null
  baseline_total_amount: string | null
  current_calculation_id: string | null
  current_supersedes_calculation_id: string | null
  current_rate_card_version_id: string | null
  current_total_amount: string | null
  bound_rate_card_version_id: string
}

export interface LateRecordingCorrectionFacts {
  itemId: string
  callId: string
  taskReference: string
  state: LateRecordingItemState
  /** Whether the independent audit produced a completed, classified result. */
  auditCompleted: boolean
  /** Whether the audit is finished trying and will never be claimed again. */
  auditExhausted: boolean
  auditRunId: string | null
  category: string | null
  recordedDurationMs: number | null
  speechDurationMs: number | null
  serviceEndMs: number | null
  graceMs: number | null
  vendorBilledMinutes: string | null
  vendorBilledAmount: string | null
  claimedDurationMs: number | null
  connectedDurationMs: number | null
  evidenceObjectId: string | null
  evidenceSha256: string | null
  /** The calculation and amount captured before evidence was attached. */
  baselineCalculationId: string | null
  baselineTotalAmount: string | null
  /** A revised calculation already durably written before an interrupted settle. */
  persistedRevisedAmount: string | null
}

/**
 * Exhausted statuses the ordinary audit worker still re-claims.
 *
 * Mirrors `mysqlCycleClose`'s own list deliberately: settling a call the audit
 * pipeline is still going to retry would take money away from an audit that
 * has not finished. Keep the two lists together.
 */
const RECLAIMABLE_EXHAUSTED_ERRORS = [
  'CLASSIFICATION_VALIDATION_FAILED',
  'AUDIT_SPEND_STATE_UNKNOWN',
] as const
const MAX_AUDIO_ATTEMPTS = 8

/**
 * The audit and billing facts for one batch's in-flight items.
 *
 * Read AFTER the audit pass, so the correction step decides money from what
 * was actually persisted rather than from what the worker believes happened.
 * That is what makes the correction pass idempotent and safe to re-run: it is
 * a function of durable state, never of a run's own memory.
 *
 * The join is `batch_id = ?` and nothing else, so it cannot reach a call the
 * administrator did not upload.
 */
export async function listLateRecordingCorrectionFacts(
  pool: Pool,
  batchId: string,
): Promise<LateRecordingCorrectionFacts[]> {
  try {
    const [rows] = await pool.execute<CorrectionFactsRow[]>(
      `SELECT
         item.id AS item_id,
         item.call_id,
         item.task_reference,
         item.state,
         item.call_artifact_id AS artifact_id,
         artifact.audio_processing_status,
         artifact.audio_attempt_count,
         artifact.audio_last_error,
         c.latest_audit_run_id AS audit_run_id,
         c.canonical_outcome_code AS category,
         media.decoded_duration_ms AS recorded_duration_ms,
         media.speech_ms,
         COALESCE(
           CAST(JSON_EXTRACT(
             media.metrics_json, '$.chargeableServiceEndMs'
           ) AS SIGNED),
           media.conversation_end_ms
         ) AS service_end_ms,
         COALESCE(
           CAST(JSON_EXTRACT(
             media.metrics_json, '$.appliedBillingGraceMs'
           ) AS SIGNED),
           60000
         ) AS grace_ms,
         CAST(minutes.minutes_decimal AS CHAR) AS vendor_billed_minutes,
         CAST(amount.quantity_decimal AS CHAR) AS vendor_billed_amount,
         ROUND(with_ringing.quantity_decimal * 1000) AS claimed_duration_ms,
         ROUND(connected.quantity_decimal * 1000) AS connected_duration_ms,
         evidence.id AS evidence_object_id,
         evidence.sha256 AS evidence_sha256,
         item.superseded_calculation_id AS baseline_calculation_id,
         CAST(item.previous_amount AS CHAR) AS baseline_total_amount,
         current_calculation.id AS current_calculation_id,
         current_calculation.supersedes_calculation_id
           AS current_supersedes_calculation_id,
         current_calculation.rate_card_version_id
           AS current_rate_card_version_id,
         CAST(current_calculation.total_amount AS CHAR) AS current_total_amount,
         batch.rate_card_version_id AS bound_rate_card_version_id
       FROM kaudit_late_recording_item item
       JOIN kaudit_late_recording_batch batch ON batch.id = item.batch_id
       JOIN kaudit_call c ON c.id = item.call_id
       JOIN kaudit_call_artifact artifact
         ON artifact.id = item.call_artifact_id
       LEFT JOIN kaudit_media_analysis media
         ON media.id = (
           SELECT newest.id
           FROM kaudit_media_analysis newest
           WHERE newest.call_artifact_id = item.call_artifact_id
             AND newest.status = 'completed'
             AND newest.classification_status = 'completed'
           ORDER BY newest.created_at DESC, newest.id DESC
           LIMIT 1
         )
       LEFT JOIN kaudit_provider_cost minutes
         ON minutes.call_id = c.id
        AND minutes.provider_sku = 'vendor_asserted_billed_minutes'
        AND minutes.is_final = 1
       LEFT JOIN kaudit_evidence_object evidence
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
       LEFT JOIN kaudit_billing_calculation current_calculation
         ON current_calculation.id = (
           SELECT current_calculation.id
           FROM kaudit_billing_calculation current_calculation
           WHERE current_calculation.call_id = c.id
             AND current_calculation.status = 'final'
             AND NOT EXISTS (
               SELECT 1
               FROM kaudit_billing_calculation newer
               WHERE newer.supersedes_calculation_id = current_calculation.id
             )
           ORDER BY current_calculation.calculated_at DESC,
                    current_calculation.id DESC
           LIMIT 1
         )
       WHERE item.batch_id = ?
         AND item.state = 'auditing'
       ORDER BY item.row_number, item.id
       LIMIT ${MAX_LATE_RECORDING_ROWS}`,
      [batchId],
    )
    return rows.map((row) => ({
      itemId: row.item_id,
      callId: row.call_id,
      taskReference: row.task_reference,
      state: row.state,
      auditCompleted:
        row.recorded_duration_ms != null && row.category != null,
      auditExhausted:
        row.audio_processing_status === 'exhausted' &&
        !(
          (RECLAIMABLE_EXHAUSTED_ERRORS as readonly string[]).includes(
            row.audio_last_error ?? '',
          ) && Number(row.audio_attempt_count ?? 0) < MAX_AUDIO_ATTEMPTS
        ),
      auditRunId: row.audit_run_id,
      category: row.category,
      recordedDurationMs: nullableMs(row.recorded_duration_ms),
      speechDurationMs: nullableMs(row.speech_ms),
      serviceEndMs: nullableMs(row.service_end_ms),
      graceMs: nullableMs(row.grace_ms),
      vendorBilledMinutes: row.vendor_billed_minutes,
      vendorBilledAmount: row.vendor_billed_amount,
      claimedDurationMs: nullableMs(row.claimed_duration_ms),
      connectedDurationMs: nullableMs(row.connected_duration_ms),
      evidenceObjectId: row.evidence_object_id,
      evidenceSha256: row.evidence_sha256,
      baselineCalculationId: row.baseline_calculation_id,
      baselineTotalAmount:
        row.baseline_total_amount == null
          ? null
          : fixed8(String(row.baseline_total_amount)),
      persistedRevisedAmount:
        row.current_calculation_id != null &&
        row.current_calculation_id !== row.baseline_calculation_id &&
        row.current_rate_card_version_id === row.bound_rate_card_version_id &&
        row.current_supersedes_calculation_id === row.baseline_calculation_id &&
        row.current_total_amount != null
          ? fixed8(String(row.current_total_amount))
          : null,
    }))
  } catch (error) {
    throw asSafeLateRecordingError(error)
  }
}
