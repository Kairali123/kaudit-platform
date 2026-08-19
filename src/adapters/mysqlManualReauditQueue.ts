import type {
  Pool,
  PoolConnection,
  ResultSetHeader,
  RowDataPacket,
} from 'mysql2/promise'
import { REAUDIT_CLASSIFIER_RULESET_VERSION } from '../reaudit/core.ts'
import {
  ManualReauditError,
  MANUAL_REAUDIT_CLAIM_TIMEOUT_MINUTES,
  MAX_MANUAL_REAUDIT_ATTEMPTS,
  manualReauditDigest,
  manualReauditId,
  manualReauditRowStatus,
  safeManualReauditErrorCode,
  type ManualReauditItemStatus,
  type ManualReauditReceipt,
  type ManualReauditRequestPort,
  type ManualReauditRequestStatus,
  type ManualReauditRowStatus,
} from '../reaudit/manualRequests.ts'
import type { ReauditCandidate } from '../reaudit/types.ts'
import type { ReauditCandidateRepository } from '../reaudit/worker.ts'

/**
 * The durable, KAUDIT-OWNED queue behind the Audit Monitor's re-audit action.
 *
 * Three surfaces over two control tables:
 *
 *   1. `enqueue` — the admin endpoint's write. Resolves displayed references to
 *      internal calls, captures each call's CURRENT audit run as a baseline,
 *      and refuses to queue a call that is already spoken for.
 *   2. `listCandidates` — the worker's claim. Bounded, ordered, and fail-closed
 *      after a crash so paid work is never submitted twice automatically.
 *   3. `readManualReauditRowStatuses` — the monitor's read. Returns only
 *      `queued`/`processing`, and only for the rows on screen.
 *
 * Nothing here stores or returns a displayed reference, a URL, a transcript, a
 * prompt, provider prose, an amount, or a credential. The only free text kept
 * is a bounded application error code.
 */

interface RequestRow extends RowDataPacket {
  id: string
  request_digest: string
  status: ManualReauditRequestStatus
  completed_count: number | string
  failed_count: number | string
  skipped_count: number | string
}

interface ResolvedCallRow extends RowDataPacket {
  call_reference: string
  call_id: string
  baseline_audit_run_id: string
}

interface ActiveItemRow extends RowDataPacket {
  call_id: string
}

interface ClaimedItemRow extends RowDataPacket {
  item_id: string
  request_id: string
  call_id: string
  baseline_audit_run_id: string
}

interface ArtifactRow extends RowDataPacket {
  call_id: string
  artifact_id: string
  source_url: string
  baseline_sha256: string | null
}

interface CostRow extends RowDataPacket {
  call_id: string
  claimed_duration_ms: string | number | null
  connected_duration_ms: string | number | null
  vendor_billed_minutes: string | null
}

interface RowStatusRow extends RowDataPacket {
  call_id: string
  status: ManualReauditItemStatus
}

interface LatestRunRow extends RowDataPacket {
  latest_audit_run_id: string | null
}

/**
 * Serializes concurrent admin submissions.
 *
 * The unique key on `active_call_id` is what actually guarantees one active
 * request per call; this lock only keeps two simultaneous clicks from racing
 * into a partially-accepted pair of requests before that key can decide.
 */
const ENQUEUE_LOCK = 'kaudit-billing-reaudit-enqueue-v1'
const ENQUEUE_LOCK_TIMEOUT_SECONDS = 5

/** The reference types the monitor itself displays, in the same order. */
const REFERENCE_TYPES = "('task_id','taskId','task')"

function placeholders(count: number): string {
  return new Array(count).fill('?').join(',')
}

function nullableMs(value: string | number | null): number | null {
  if (value == null) return null
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? Math.round(parsed) : null
}

/**
 * Every driver failure becomes ONE bounded refusal.
 *
 * A duplicate-key race, a lost connection, a constraint the application did not
 * anticipate, and a bug all leave here as the same 503. The original error may
 * quote SQL, a column value, or an internal id, and is dropped rather than
 * carried outward.
 */
function asSafeQueueError(error: unknown): ManualReauditError {
  if (error instanceof ManualReauditError) return error
  return new ManualReauditError(
    'REAUDIT_QUEUE_UNAVAILABLE',
    503,
    'Re-audit queue is temporarily unavailable',
  )
}

async function loadRequest(
  connection: PoolConnection,
  idempotencyKey: string,
): Promise<RequestRow | null> {
  const [rows] = await connection.execute<RequestRow[]>(
    `SELECT id, request_digest, status, completed_count, failed_count,
            skipped_count
     FROM kaudit_billing_reaudit_request
     WHERE idempotency_key = ?`,
    [idempotencyKey],
  )
  return rows[0] ?? null
}

async function itemCount(
  connection: PoolConnection,
  requestId: string,
): Promise<number> {
  const [rows] = await connection.execute<RowDataPacket[]>(
    `SELECT COUNT(*) AS n
     FROM kaudit_billing_reaudit_item
     WHERE request_id = ?`,
    [requestId],
  )
  return Number(rows[0]?.n || 0)
}

/**
 * Terminalize claims whose worker disappeared after crossing the paid boundary.
 * They are never reclaimed; a new administrator action is the only path to a
 * new model call.
 */
async function expireInterruptedClaims(
  connection: PoolConnection,
  callIds?: readonly string[],
  recoverAllProcessing = false,
): Promise<void> {
  if (callIds && callIds.length === 0) return
  const scope = callIds
    ? ` AND item.call_id IN (${placeholders(callIds.length)})`
    : ''
  const [interrupted] = await connection.execute<ClaimedItemRow[]>(
    `SELECT item.id AS item_id, item.request_id, item.call_id,
            item.baseline_audit_run_id
     FROM kaudit_billing_reaudit_item item
     WHERE item.status = 'processing'
       ${recoverAllProcessing ? '' : `AND item.started_at < current_timestamp(6)
         - INTERVAL ${MANUAL_REAUDIT_CLAIM_TIMEOUT_MINUTES} MINUTE`}
       ${scope}
     ORDER BY item.created_at, item.id
     LIMIT 100
     FOR UPDATE`,
    callIds ? [...callIds] : [],
  )
  for (const row of interrupted) {
    await settleManualReauditItem(connection, {
      requestId: row.request_id,
      itemId: row.item_id,
      outcome: 'failed',
      errorCode: 'REAUDIT_WORKER_INTERRUPTED',
      at: new Date(),
    })
  }
}

/**
 * Resolves the exact displayed references an administrator selected.
 *
 * A UNION rather than one OR'd predicate, so each returned row is LABELLED with
 * the reference that matched it. That is what lets the caller insist every
 * submitted reference resolved to exactly one auditable call instead of
 * guessing from a count.
 */
async function resolveSelection(
  connection: PoolConnection,
  callReferences: readonly string[],
): Promise<ResolvedCallRow[]> {
  const list = placeholders(callReferences.length)
  const [rows] = await connection.execute<ResolvedCallRow[]>(
    `SELECT c.logical_call_key AS call_reference,
            c.id AS call_id,
            c.latest_audit_run_id AS baseline_audit_run_id
     FROM kaudit_call c
     JOIN kaudit_audit_run latest
       ON latest.id = c.latest_audit_run_id
      AND latest.status = 'completed'
     WHERE c.logical_call_key IN (${list})
       AND EXISTS (
         SELECT 1
         FROM kaudit_invoice invoice
         WHERE c.billing_period_date BETWEEN
               invoice.period_start AND invoice.period_end
           AND invoice.status IN ('received','matched','approved')
       )
       AND EXISTS (
         SELECT 1
         FROM kaudit_call_artifact artifact
         WHERE artifact.call_id = c.id
           AND artifact.artifact_type = 'recording'
           AND artifact.is_final = 1
           AND artifact.source_url IS NOT NULL
       )
     UNION
     SELECT ref.external_id AS call_reference,
            c.id AS call_id,
            c.latest_audit_run_id AS baseline_audit_run_id
     FROM kaudit_call c
     JOIN kaudit_audit_run latest
       ON latest.id = c.latest_audit_run_id
      AND latest.status = 'completed'
     JOIN kaudit_call_external_reference ref
       ON ref.call_id = c.id
      AND ref.reference_type IN ${REFERENCE_TYPES}
      AND ref.external_id IN (${list})
     WHERE EXISTS (
       SELECT 1
       FROM kaudit_invoice invoice
       WHERE c.billing_period_date BETWEEN
             invoice.period_start AND invoice.period_end
         AND invoice.status IN ('received','matched','approved')
     )
       AND EXISTS (
       SELECT 1
       FROM kaudit_call_artifact artifact
       WHERE artifact.call_id = c.id
         AND artifact.artifact_type = 'recording'
         AND artifact.is_final = 1
         AND artifact.source_url IS NOT NULL
     )`,
    [...callReferences, ...callReferences],
  )
  return rows
}

/**
 * One auditable call per submitted reference, or a bounded refusal.
 *
 * A reference that resolves to nothing (not audited, no recording evidence, or
 * simply not a call on this deployment) and a reference that resolves to more
 * than one call are both selection errors. Neither is repaired by guessing:
 * paying a model for a call the administrator did not mean to select is the
 * failure this check exists to prevent.
 */
export function selectedCalls(
  callReferences: readonly string[],
  resolved: readonly {
    call_reference: string
    call_id: string
    baseline_audit_run_id: string
  }[],
): Array<{ callId: string; baselineAuditRunId: string }> {
  const byReference = new Map<string, Map<string, string>>()
  for (const row of resolved) {
    const calls = byReference.get(row.call_reference) ?? new Map()
    calls.set(row.call_id, row.baseline_audit_run_id)
    byReference.set(row.call_reference, calls)
  }
  const selection = new Map<string, string>()
  for (const reference of callReferences) {
    const calls = byReference.get(reference)
    if (!calls || calls.size !== 1) {
      throw new ManualReauditError(
        'REAUDIT_SELECTION_INVALID',
        400,
        'One or more selected calls cannot be re-audited',
      )
    }
    for (const [callId, baselineAuditRunId] of calls) {
      selection.set(callId, baselineAuditRunId)
    }
  }
  return [...selection].map(([callId, baselineAuditRunId]) => ({
    callId,
    baselineAuditRunId,
  }))
}

export function createMysqlManualReauditRequestRepository(
  pool: Pool,
): ManualReauditRequestPort {
  return {
    async enqueue(input) {
      const digest = manualReauditDigest(input.callReferences)
      const connection = await pool.getConnection()
      let held = false
      try {
        const [lockRows] = await connection.query<RowDataPacket[]>(
          `SELECT GET_LOCK(?, ?) AS acquired`,
          [ENQUEUE_LOCK, ENQUEUE_LOCK_TIMEOUT_SECONDS],
        )
        held = Number(lockRows[0]?.acquired || 0) === 1
        if (!held) {
          throw new ManualReauditError(
            'REAUDIT_QUEUE_BUSY',
            409,
            'Another re-audit request is being accepted; retry this request',
          )
        }
        await connection.beginTransaction()

        // A retry of an accepted request replays it. The digest is what makes
        // that safe: the same key carrying a DIFFERENT selection is a caller
        // bug, not a retry, and is refused rather than silently re-scoped.
        const replay = await loadRequest(connection, input.idempotencyKey)
        if (replay) {
          if (replay.request_digest !== digest) {
            throw new ManualReauditError(
              'REAUDIT_REQUEST_CONFLICT',
              409,
              'Re-audit retry key conflicts with an earlier request',
            )
          }
          const accepted = await itemCount(connection, replay.id)
          await connection.commit()
          return {
            requestId: replay.id,
            outcome: 'replayed',
            status: replay.status,
            acceptedCount: accepted,
            alreadyQueuedCount: 0,
          }
        }

        const calls = selectedCalls(
          input.callReferences,
          await resolveSelection(connection, input.callReferences),
        )
        // A stale claim is no longer displayed as live. Settle it before the
        // active-call uniqueness check so this explicit click can authorize a
        // fresh item without ever auto-retrying the old paid operation.
        await expireInterruptedClaims(
          connection,
          calls.map((call) => call.callId),
        )
        const [active] = await connection.execute<ActiveItemRow[]>(
          `SELECT call_id
           FROM kaudit_billing_reaudit_item
           WHERE active_call_id IN (${placeholders(calls.length)})`,
          calls.map((call) => call.callId),
        )
        const busy = new Set(active.map((row) => row.call_id))
        const accepted = calls.filter((call) => !busy.has(call.callId))
        if (accepted.length === 0) {
          // Every selected call already has live work. Nothing is written, so
          // the same submission stays answerable the same way until that work
          // settles — and no second spend is queued behind the first.
          await connection.commit()
          return {
            requestId: null,
            outcome: 'already_queued',
            status: null,
            acceptedCount: 0,
            alreadyQueuedCount: busy.size,
          }
        }

        const requestId = manualReauditId('brr')
        await connection.execute(
          `INSERT INTO kaudit_billing_reaudit_request
             (id, idempotency_key, request_digest, requested_by_user_id,
              correlation_id, ruleset_version, status, requested_count,
              requested_at)
           VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?)`,
          [
            requestId,
            input.idempotencyKey,
            digest,
            input.requestedByUserId,
            input.correlationId,
            REAUDIT_CLASSIFIER_RULESET_VERSION,
            accepted.length,
            input.requestedAt,
          ],
        )
        for (const call of accepted) {
          await connection.execute(
            `INSERT INTO kaudit_billing_reaudit_item
               (id, request_id, call_id, baseline_audit_run_id, created_at)
             VALUES (?, ?, ?, ?, ?)`,
            [
              manualReauditId('bri'),
              requestId,
              call.callId,
              call.baselineAuditRunId,
              input.requestedAt,
            ],
          )
        }
        await connection.commit()
        return {
          requestId,
          outcome: 'accepted',
          status: 'queued',
          acceptedCount: accepted.length,
          alreadyQueuedCount: busy.size,
        }
      } catch (error) {
        await connection.rollback().catch(() => undefined)
        throw asSafeQueueError(error)
      } finally {
        if (held) {
          await connection
            .query(`SELECT RELEASE_LOCK(?)`, [ENQUEUE_LOCK])
            .catch(() => undefined)
        }
        connection.release()
      }
    },
  }
}

/**
 * The worker's claim over the durable queue.
 *
 * Claiming and enriching are deliberately separate statements. The claim locks
 * only the queue's own rows — never an evidence or artifact row — so a running
 * audit worker cannot block, or be blocked by, the pipeline it is auditing.
 *
 * `includePreviouslyClassified` must be true: a manual re-audit exists to
 * re-answer calls that already have an answer, so a caller asking this
 * repository for "new calls only" has mis-wired the worker and is refused
 * rather than quietly served the wrong queue.
 */
export function createMysqlManualReauditCandidateRepository(
  pool: Pool,
  repositoryOptions: { recoverInterruptedClaims?: boolean } = {},
): ReauditCandidateRepository {
  return {
    async listCandidates(options) {
      if (!options.includePreviouslyClassified) {
        throw new ManualReauditError(
          'REAUDIT_WORKER_MODE_INVALID',
          500,
          'Requested re-audit mode requires previously classified calls',
        )
      }
      const connection = await pool.getConnection()
      let claimed: ClaimedItemRow[] = []
      try {
        await connection.beginTransaction()
        // The hosted requested-mode worker owns the same exclusive database
        // lock as every Billing Audit worker. Once a newly dispatched recovery
        // host has that lock, any pre-existing processing item is proven
        // orphaned and can fail closed immediately; it is never reclaimed.
        await expireInterruptedClaims(
          connection,
          undefined,
          repositoryOptions.recoverInterruptedClaims === true,
        )
        const [rows] = await connection.execute<ClaimedItemRow[]>(
          `SELECT item.id AS item_id, item.request_id, item.call_id,
                  item.baseline_audit_run_id
           FROM kaudit_billing_reaudit_item item
           WHERE item.status = 'queued'
             AND item.attempt_count < ${MAX_MANUAL_REAUDIT_ATTEMPTS}
           ORDER BY item.created_at, item.id
           LIMIT 1
           FOR UPDATE`,
        )
        claimed = rows
        for (const row of claimed) {
          await connection.execute(
            `UPDATE kaudit_billing_reaudit_item
             SET status = 'processing',
                 attempt_count = attempt_count + 1,
                 started_at = current_timestamp(6),
                 last_error_code = NULL
             WHERE id = ?`,
            [row.item_id],
          )
        }
        if (claimed.length > 0) {
          await connection.execute(
            `UPDATE kaudit_billing_reaudit_request
             SET status = 'running',
                 started_at = COALESCE(started_at, current_timestamp(6))
             WHERE id IN (${placeholders(claimed.length)})
               AND status = 'queued'`,
            claimed.map((row) => row.request_id),
          )
        }
        await connection.commit()
      } catch (error) {
        await connection.rollback().catch(() => undefined)
        connection.release()
        throw asSafeQueueError(error)
      }
      if (claimed.length === 0) {
        connection.release()
        return []
      }
      try {
        const callIds = claimed.map((row) => row.call_id)
        const list = placeholders(callIds.length)
        const [artifacts] = await connection.execute<ArtifactRow[]>(
          `SELECT artifact.call_id, artifact.id AS artifact_id,
                  artifact.source_url, artifact.sha256 AS baseline_sha256
           FROM kaudit_call_artifact artifact
           WHERE artifact.call_id IN (${list})
             AND artifact.artifact_type = 'recording'
             AND artifact.is_final = 1
             AND artifact.source_url IS NOT NULL
           ORDER BY artifact.call_id, artifact.created_at DESC, artifact.id DESC`,
          callIds,
        )
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
           WHERE cost.call_id IN (${list})
           GROUP BY cost.call_id`,
          callIds,
        )
        const artifactByCall = new Map<string, ArtifactRow>()
        for (const row of artifacts) {
          if (!artifactByCall.has(row.call_id)) {
            artifactByCall.set(row.call_id, row)
          }
        }
        const costByCall = new Map(costs.map((row) => [row.call_id, row]))
        const candidates: ReauditCandidate[] = []
        for (const item of claimed) {
          const artifact = artifactByCall.get(item.call_id)
          if (!artifact) {
            // Claimed but unauditable. Settled here, with no model call and no
            // change to the call's current audit result.
            await connection.beginTransaction()
            try {
              await settleManualReauditItem(connection, {
                requestId: item.request_id,
                itemId: item.item_id,
                outcome: 'failed',
                errorCode: 'REAUDIT_RECORDING_UNAVAILABLE',
                at: new Date(),
              })
              await connection.commit()
            } catch (error) {
              await connection.rollback().catch(() => undefined)
              throw error
            }
            continue
          }
          const cost = costByCall.get(item.call_id)
          candidates.push({
            callId: item.call_id,
            artifactId: artifact.artifact_id,
            sourceUrl: artifact.source_url,
            baselineSha256: artifact.baseline_sha256,
            claimedDurationMs: nullableMs(cost?.claimed_duration_ms ?? null),
            connectedDurationMs: nullableMs(
              cost?.connected_duration_ms ?? null,
            ),
            vendorBilledMinutes: cost?.vendor_billed_minutes ?? null,
            manualRequest: {
              requestId: item.request_id,
              itemId: item.item_id,
              baselineAuditRunId: item.baseline_audit_run_id,
            },
          })
        }
        return candidates
      } catch (error) {
        throw asSafeQueueError(error)
      } finally {
        connection.release()
      }
    },
  }
}

/**
 * Whether the call still carries the audit run the administrator saw.
 *
 * Read `FOR UPDATE` so the decision and the write that follows it cannot be
 * separated by another worker advancing the same pointer.
 */
export async function manualReauditLatestAuditRunId(
  connection: PoolConnection,
  callId: string,
): Promise<string | null> {
  const [rows] = await connection.execute<LatestRunRow[]>(
    `SELECT latest_audit_run_id
     FROM kaudit_call
     WHERE id = ?
     FOR UPDATE`,
    [callId],
  )
  return rows[0]?.latest_audit_run_id ?? null
}

/**
 * Settles one queue item and rolls its request forward, in the CALLER's
 * transaction.
 *
 * Sharing the audit writer's transaction is the point: a completed audit run
 * and the queue item that paid for it commit together or not at all, so a
 * crash can never leave an item marked done with no audit behind it — or an
 * audit written with the item still claimable for a second spend.
 */
export async function settleManualReauditItem(
  connection: PoolConnection,
  input: {
    requestId: string
    itemId: string
    outcome: 'completed' | 'failed' | 'skipped'
    errorCode?: string | null
    at: Date
  },
): Promise<void> {
  const [updated] = await connection.execute<ResultSetHeader>(
    `UPDATE kaudit_billing_reaudit_item
     SET status = ?, completed_at = ?, last_error_code = ?
     WHERE id = ? AND status = 'processing'`,
    [
      input.outcome,
      input.at,
      input.outcome === 'failed'
        ? safeManualReauditErrorCode(input.errorCode)
        : null,
      input.itemId,
    ],
  )
  if (updated.affectedRows !== 1) {
    throw new ManualReauditError(
      'REAUDIT_ITEM_STATE_CONFLICT',
      500,
      'Re-audit item is not in the expected state',
    )
  }
  await connection.execute(
    `UPDATE kaudit_billing_reaudit_request request
     SET request.completed_count = (
           SELECT COUNT(*) FROM kaudit_billing_reaudit_item item
           WHERE item.request_id = request.id AND item.status = 'completed'
         ),
         request.failed_count = (
           SELECT COUNT(*) FROM kaudit_billing_reaudit_item item
           WHERE item.request_id = request.id AND item.status = 'failed'
         ),
         request.skipped_count = (
           SELECT COUNT(*) FROM kaudit_billing_reaudit_item item
           WHERE item.request_id = request.id AND item.status = 'skipped'
         ),
         request.status = CASE
           WHEN EXISTS (
             SELECT 1 FROM kaudit_billing_reaudit_item item
             WHERE item.request_id = request.id
               AND item.status IN ('queued','processing')
           ) THEN 'running'
           WHEN EXISTS (
             SELECT 1 FROM kaudit_billing_reaudit_item item
             WHERE item.request_id = request.id AND item.status = 'failed'
           ) THEN 'completed_with_failures'
           ELSE 'completed'
         END,
         request.completed_at = CASE
           WHEN EXISTS (
             SELECT 1 FROM kaudit_billing_reaudit_item item
             WHERE item.request_id = request.id
               AND item.status IN ('queued','processing')
           ) THEN NULL
           ELSE ?
         END
     WHERE request.id = ?`,
    [input.at, input.requestId],
  )
}

/**
 * The monitor's per-row read, for the calls ON SCREEN only.
 *
 * Returns nothing but `queued` or `processing` per internal call id. The
 * caller maps those onto displayed rows and never publishes the key. Absence
 * of the tables — a deployment where migration 0015 has not been applied yet —
 * reports every row as having no re-audit state rather than failing the page.
 */
export async function readManualReauditRowStatuses(
  pool: Pool,
  callIds: readonly string[],
): Promise<Map<string, ManualReauditRowStatus>> {
  const statuses = new Map<string, ManualReauditRowStatus>()
  if (callIds.length === 0) return statuses
  try {
    const [rows] = await pool.query<RowStatusRow[]>(
      `SELECT item.call_id, item.status
       FROM kaudit_billing_reaudit_item item
       WHERE (
         item.status = 'queued'
         OR (
           item.status = 'processing'
           AND item.started_at >= current_timestamp(6)
             - INTERVAL ${MANUAL_REAUDIT_CLAIM_TIMEOUT_MINUTES} MINUTE
         )
       )
         AND item.call_id IN (${placeholders(callIds.length)})`,
      [...callIds],
    )
    const byCall = new Map<string, ManualReauditItemStatus[]>()
    for (const row of rows) {
      byCall.set(row.call_id, [...(byCall.get(row.call_id) ?? []), row.status])
    }
    for (const [callId, itemStatuses] of byCall) {
      const status = manualReauditRowStatus(itemStatuses)
      if (status) statuses.set(callId, status)
    }
  } catch (error) {
    // Migration 0015 is additive. Until it is applied the monitor reports no
    // re-audit state instead of hiding the audit data behind an error.
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'ER_NO_SUCH_TABLE'
    ) {
      return new Map()
    }
    throw new ManualReauditError(
      'REAUDIT_QUEUE_UNAVAILABLE',
      503,
      'Re-audit queue is temporarily unavailable',
    )
  }
  return statuses
}

export type { ManualReauditReceipt }
