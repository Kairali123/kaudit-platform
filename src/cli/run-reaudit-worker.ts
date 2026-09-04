import { readFile } from 'node:fs/promises'
import mysql, { type RowDataPacket } from 'mysql2/promise'
import { createProxyResolvingFetcher } from '../adapters/proxyResolvingFetcher.ts'
import { createMysqlReauditReadRepo } from '../adapters/mysqlReauditReadRepo.ts'
import { createMysqlManualReauditCandidateRepository } from '../adapters/mysqlManualReauditQueue.ts'
import { createMysqlReauditWriteRepo } from '../adapters/mysqlReauditWriteRepo.ts'
import { createOpenAiReaudit } from '../adapters/openaiReaudit.ts'
import { createMysqlAuditWorkerControl } from '../adapters/mysqlAuditWorkerControl.ts'
import { createMysqlBillingSpendGuard } from '../adapters/mysqlBillingSpendLease.ts'
import { tagPoolAcquisitionFailures } from '../adapters/mysqlPoolAcquisition.ts'
import {
  acquireBillingAuditLock,
  BILLING_AUDIT_LOCK_ERROR_CODE,
} from '../auditWorkers/billingAdvisoryLock.ts'
import { startActiveHeartbeat } from '../auditWorkers/activeHeartbeat.ts'
import {
  decideBatchFaultResponse,
  decideDrainContinuation,
} from '../auditWorkers/drainContinuation.ts'
import { auditOneCall } from '../reaudit/core.ts'
import {
  runReauditBatch,
  type ReauditCandidateRepository,
} from '../reaudit/worker.ts'
import {
  asReauditFatalError,
  ReauditFatalError,
  type ReauditErrorCategory,
} from '../reaudit/failures.ts'
import { parseRecordingBackedTaskIds } from '../reaudit/scope.ts'
import { loadRuntimeConfig } from '../config/runtime.ts'
import { resolveDatabaseTls } from '../runtime/databaseTls.ts'

let shutdownRequested = false

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    shutdownRequested = true
  })
}

function required(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`${name} is required`)
  return value
}

function integer(
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const value = Number(process.env[name] || fallback)
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be from ${minimum} to ${maximum}`)
  }
  return value
}

function enabled(name: string): boolean {
  return process.env[name]?.trim().toLowerCase() === 'true'
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

const ACTIVE_HEARTBEAT_INTERVAL_MS = 60_000
/**
 * How a bounded drain treats a queue that is momentarily empty only because
 * every remaining call is serving a retry backoff.
 *
 * The horizon is the explicit hand-over point: work due further out than this
 * is left to the next scheduled run rather than holding a runner, the global
 * advisory lock, and a database connection idle for hours.
 */
const DRAIN_DEFERRED_HORIZON_MS = 2 * 60 * 60_000
/** Consecutive infrastructure faults a bounded run waits out before stopping. */
const MAX_CONSECUTIVE_BATCH_FAULTS = 5
const BATCH_FAULT_MAX_BACKOFF_MS = 120_000
/**
 * How often the advisory-lock connection is exercised.
 *
 * The lock lives on ONE connection and was otherwise touched only to take it
 * and to release it. A drain runs for hours, so that connection sat idle long
 * enough for the server to close it — and closing it RELEASES the lock, without
 * anything in this process noticing. A second worker could then acquire it and
 * audit the same queue concurrently, which is how two runs came to fight over
 * the same pre-model spend leases.
 */
const LOCK_KEEPALIVE_INTERVAL_MS = 60_000

async function main(): Promise<void> {
  if (required('KAUDIT_AUDIT_MODE') !== 'EXECUTE') {
    throw new Error(
      'KAUDIT_AUDIT_MODE must be exactly EXECUTE; use reaudit:sample for read-only checks',
    )
  }
  const batchSize = integer('KAUDIT_AUDIT_BATCH', 10, 1, 100)
  const requestedConcurrency = integer('KAUDIT_AUDIT_CONCURRENCY', 1, 1, 10)
  const pollMs = integer('KAUDIT_AUDIT_POLL_MS', 15_000, 1_000, 60_000)
  const lockWaitMs =
    integer('KAUDIT_AUDIT_LOCK_WAIT_SECONDS', 30, 0, 120) * 1_000
  const watch = enabled('KAUDIT_AUDIT_WATCH')
  const drain = enabled('KAUDIT_AUDIT_DRAIN')
  if (watch && drain) {
    throw new Error('KAUDIT_AUDIT_WATCH and KAUDIT_AUDIT_DRAIN are exclusive')
  }
  const deadlineSeconds = integer(
    'KAUDIT_WORKER_DEADLINE_SECONDS',
    19_200,
    300,
    21_000,
  )
  const deadline = Date.now() + deadlineSeconds * 1000
  const appendReauditValue = process.env.KAUDIT_AUDIT_REAUDIT_MODE
  if (
    appendReauditValue !== undefined &&
    appendReauditValue !== 'APPEND'
  ) {
    throw new Error('KAUDIT_AUDIT_REAUDIT_MODE must be exactly APPEND')
  }
  const appendReaudit = appendReauditValue === 'APPEND'
  /**
   * Administrator-requested Billing Audit re-audit.
   *
   * Reads the durable Kaudit-owned request queue instead of the intake queue.
   * It is exact (only the calls an administrator selected), bounded (one batch
   * at a time, up to the worker deadline), serialized by the same per-system
   * workflow concurrency group, and deliberately exclusive with every other
   * mode: it neither widens nor wakes the general billing queue.
   */
  const requestedMode = enabled('KAUDIT_AUDIT_REQUESTED_MODE')
  if (requestedMode && (watch || drain)) {
    throw new Error(
      'KAUDIT_AUDIT_REQUESTED_MODE cannot run with WATCH or DRAIN',
    )
  }
  if (requestedMode && appendReaudit) {
    throw new Error(
      'KAUDIT_AUDIT_REQUESTED_MODE and KAUDIT_AUDIT_REAUDIT_MODE are exclusive',
    )
  }
  if (requestedMode && process.env.KAUDIT_AUDIT_SCOPE_FILE?.trim()) {
    throw new Error(
      'KAUDIT_AUDIT_REQUESTED_MODE reads the durable queue, not a scope file',
    )
  }
  const scopeFile = process.env.KAUDIT_AUDIT_SCOPE_FILE?.trim() || null
  const taskIds = scopeFile
    ? parseRecordingBackedTaskIds(await readFile(scopeFile, 'utf8'))
    : null
  if (enabled('KAUDIT_AUDIT_REQUIRE_SCOPE') && !taskIds) {
    throw new Error(
      'KAUDIT_AUDIT_REQUIRE_SCOPE=true requires KAUDIT_AUDIT_SCOPE_FILE',
    )
  }
  if (appendReaudit && !taskIds) {
    throw new Error(
      'KAUDIT_AUDIT_REAUDIT_MODE=APPEND requires KAUDIT_AUDIT_SCOPE_FILE',
    )
  }
  /**
   * The exact, bounded one-shot runs: a scope-bound targeted append re-audit,
   * and an administrator-requested drain of the durable queue. Both may run
   * while the general billing queue is PAUSED — they claim only calls that were
   * named in advance, so neither wakes nor broadens that queue.
   */
  const targetedOneShot =
    requestedMode ||
    (appendReaudit && taskIds !== null && taskIds.length > 0 && !watch && !drain)
  const concurrency = targetedOneShot ? 1 : requestedConcurrency
  const allowedHosts = required('KAUDIT_ALLOWED_RECORDING_HOSTS')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
  const config = loadRuntimeConfig(process.env)
  const ssl = resolveDatabaseTls(config, process.env)
  const databasePoolOptions = {
    host: config.database.host,
    port: config.database.port,
    database: config.database.name,
    user: config.database.user,
    password: config.database.password,
    ...(ssl ? { ssl } : {}),
    connectTimeout: 30_000,
  }
  /** Provider concurrency is independent from the database connection budget.
   * Model calls release their claim connection before doing network work, so
   * ten provider lanes can share four bounded MySQL connections safely.
   */
  const pool = tagPoolAcquisitionFailures(
    mysql.createPool({
      ...databasePoolOptions,
      connectionLimit: 4,
    }),
  )
  // Control intent and liveness must remain reachable even if every work-pool
  // connection is queued behind persistence or spend-lease traffic.
  const controlPool = tagPoolAcquisitionFailures(
    mysql.createPool({
      ...databasePoolOptions,
      connectionLimit: 1,
    }),
  )
  const control = createMysqlAuditWorkerControl(controlPool)
  let lockConnection
  try {
    lockConnection = await pool.getConnection()
  } catch (error) {
    await Promise.allSettled([pool.end(), controlPool.end()])
    throw asReauditFatalError('pool_acquisition', error)
  }
  let lockAcquired = false
  let lockKeepalive: { stop(): Promise<void> } | null = null
  let lockLost = false
  try {
    try {
      lockAcquired = await acquireBillingAuditLock({
        timeoutMs: lockWaitMs,
        retryMs: 1_000,
        wait,
        tryAcquire: async () => {
          const [lockRows] = await lockConnection.query<RowDataPacket[]>(
            `SELECT GET_LOCK('kaudit-independent-reaudit-v2', 0) AS acquired`,
          )
          const acquired = lockRows[0]?.acquired
          if (Number(acquired) === 1) return true
          if (Number(acquired) === 0) return false
          throw new ReauditFatalError('claim', 'DB_UNKNOWN')
        },
      })
    } catch (error) {
      throw asReauditFatalError('claim', error)
    }
    if (!lockAcquired) {
      try {
        await control.recordObservation({
          system: 'billing',
          observedState: 'faulted',
          errorCode: BILLING_AUDIT_LOCK_ERROR_CODE,
        })
      } catch {
        // Preserve the primary lock diagnosis even if monitor publication fails.
      }
      process.stdout.write(
        `${JSON.stringify({
          event: 'billing_audit_lock_busy',
          category: 'WORKER_LOCK_BUSY',
        })}\n`,
      )
      throw new ReauditFatalError('claim', 'WORKER_LOCK_BUSY')
    }
    /**
     * Hold the lock for real, and stop if it was ever lost.
     *
     * The keepalive both prevents the idle close and verifies ownership: if
     * this connection is no longer the holder, another worker may already be
     * claiming the same calls, and continuing would risk paying twice for one
     * question. A lost lock ends the run rather than racing.
     */
    lockKeepalive = startActiveHeartbeat({
      intervalMs: LOCK_KEEPALIVE_INTERVAL_MS,
      record: async () => {
        try {
          const [heldRows] = await lockConnection.query<RowDataPacket[]>(
            `SELECT IS_USED_LOCK('kaudit-independent-reaudit-v2')
                    = CONNECTION_ID() AS held`,
          )
          if (Number(heldRows[0]?.held) !== 1) lockLost = true
        } catch {
          // An unusable lock connection is a released lock.
          lockLost = true
        }
      },
    })
    const candidates: ReauditCandidateRepository = requestedMode
      ? createMysqlManualReauditCandidateRepository(pool, {
          recoverInterruptedClaims: true,
        })
      : createMysqlReauditReadRepo(pool, {
          externalTaskIds: taskIds ?? undefined,
          allowPreviouslyClassified: appendReaudit,
        })
    const results = createMysqlReauditWriteRepo(pool, {
      allowCompletedReaudit: appendReaudit,
      manualRequest: requestedMode,
    })
    const fetcher = createProxyResolvingFetcher(
      required('KAUDIT_UNPOD_PROXY_BASE'),
    )
    const ai = createOpenAiReaudit(required('OPENAI_API_KEY'))
    let completed = 0
    let selected = 0
    let failedOutcomes = 0
    /**
     * Bounded runs wait out transient infrastructure faults instead of ending
     * the whole drain on the first one. A one-shot targeted/single-batch run
     * keeps failing fast: it was asked for exactly one attempt.
     */
    const retryBatchFaults = drain || requestedMode
    let consecutiveBatchFaults = 0
    let consecutiveInspectionFaults = 0
    const publishNoCompletionFailure = (): void => {
      if (selected === 0 || completed > 0 || failedOutcomes === 0) return
      process.stdout.write(
        `${JSON.stringify({
          event: 'billing_audit_no_completions',
          category: 'ITEM_FAILURES',
          selected,
          failed: failedOutcomes,
        })}\n`,
      )
      process.exitCode = 2
    }
    process.stdout.write(
      `[audit-worker] started; mode=${requestedMode ? 'requested-reaudit' : appendReaudit ? 'append-reaudit' : 'new-only'}; scope=${requestedMode ? 'durable admin request queue' : taskIds ? `${taskIds.length} exact task IDs` : 'all eligible calls'}\n`,
    )
    for (;;) {
      if (lockLost) {
        process.stdout.write(
          `${JSON.stringify({
            event: 'billing_audit_lock_lost',
            category: 'WORKER_LOCK_BUSY',
          })}\n`,
        )
        try {
          await control.recordObservation({
            system: 'billing',
            observedState: 'faulted',
            errorCode: 'BILLING_AUDIT_LOCK_LOST',
          })
        } catch { /* the stale-heartbeat rule still publishes liveness */ }
        break
      }
      if (shutdownRequested) {
        await control.recordObservation({
          system: 'billing',
          observedState: 'idle',
        })
        process.stdout.write('[audit-worker] stopped gracefully\n')
        break
      }
      const desired = await control.getDesiredState('billing')
      if (desired === 'paused' && !targetedOneShot) {
        await control.recordObservation({
          system: 'billing',
          observedState: 'paused',
        })
        if (!watch) break
        await wait(pollMs)
        continue
      }
      await control.recordObservation({
        system: 'billing',
        observedState: 'running',
      })
      let summary
      let reportedFailures = 0
      let reportedProcessed = 0
      const activeHeartbeat = startActiveHeartbeat({
        intervalMs: ACTIVE_HEARTBEAT_INTERVAL_MS,
        record: () => control.recordObservation({
          system: 'billing',
          observedState: 'running',
        }),
      })
      try {
        summary = await runReauditBatch({
          candidates,
          results,
          includePreviouslyClassified: appendReaudit || requestedMode,
          batchSize,
          concurrency,
          // This process owns the global Billing advisory lock and drains all
          // in-flight work before starting another batch. It can therefore
          // recover staged/ambiguous leases immediately without waiting for
          // the fallback wall-clock expiry.
          spendGuard: createMysqlBillingSpendGuard(pool, {
            exclusiveRecovery: true,
          }),
          shouldContinue: async () =>
            !shutdownRequested &&
            !lockLost &&
            (targetedOneShot ||
              (await control.getDesiredState('billing')) === 'running') &&
            ((!drain && !requestedMode) || Date.now() < deadline),
          processor: {
            process: (candidate) =>
              auditOneCall({
                candidate,
                fetcher,
                ai,
                allowedHosts,
              }),
          },
          onProgress: async (progress) => {
            const failures = progress.terminalFailures
            const processed =
              progress.completed + progress.retriesScheduled +
              progress.terminalFailures + progress.alreadyCompleted +
              progress.spendGuardSkipped
            await control.recordObservation({
              system: 'billing',
              observedState: 'running',
              processedDelta: processed - reportedProcessed,
              failedDelta: failures - reportedFailures,
              progressed: true,
            })
            reportedProcessed = processed
            reportedFailures = failures
            process.stdout.write(
              `[audit-worker] batch ${processed}/${progress.selected}; completed=${progress.completed}; retry=${progress.retriesScheduled}; terminal=${progress.terminalFailures}; skipped=${progress.alreadyCompleted + progress.spendGuardSkipped}\n`,
            )
          },
        })
      } catch (error) {
        await activeHeartbeat.stop()
        /**
         * Privacy-safe diagnostic classification. The original failure is
         * reduced to a lifecycle phase and one allowlisted category — never
         * the raw driver/provider error, which can quote SQL or values.
         */
        const fatal: { phase: string; category: ReauditErrorCategory } =
          error instanceof ReauditFatalError
            ? { phase: error.phase, category: error.category }
            : { phase: 'unknown', category: 'DB_UNKNOWN' }
        const boundedCode = `BILLING_AUDIT_BATCH_FAILED_${fatal.category}`
        consecutiveBatchFaults += 1
        const faultResponse = retryBatchFaults
          ? decideBatchFaultResponse({
              category: fatal.category,
              consecutiveFaults: consecutiveBatchFaults,
              maxConsecutiveFaults: MAX_CONSECUTIVE_BATCH_FAULTS,
              remainingMs: deadline - Date.now(),
              baseBackoffMs: pollMs,
              maxBackoffMs: BATCH_FAULT_MAX_BACKOFF_MS,
            })
          : ({ action: 'stop' } as const)
        process.stdout.write(
          `${JSON.stringify({
            event: 'billing_audit_batch_failed',
            phase: fatal.phase,
            category: fatal.category,
            willRetry: faultResponse.action === 'retry',
          })}\n`,
        )
        /**
         * The control write is best-effort on purpose. A second failure here is
         * the same outage, and letting it escape would replace the classified
         * diagnosis with an unclassified one and skip the retry decision above.
         */
        try {
          await control.recordObservation({
            system: 'billing',
            // A run that is going to retry is still running. Only a run that
            // is giving up publishes a fault and counts a failure.
            observedState:
              faultResponse.action === 'retry' ? 'running' : 'faulted',
            errorCode: boundedCode,
            ...(faultResponse.action === 'retry' ? {} : { failedDelta: 1 }),
          })
        } catch {
          // Liveness is still published by the stale-heartbeat rule.
        }
        if (faultResponse.action === 'retry') {
          const faultHeartbeat = startActiveHeartbeat({
            intervalMs: ACTIVE_HEARTBEAT_INTERVAL_MS,
            record: () => control.recordObservation({
              system: 'billing',
              observedState: 'running',
            }),
          })
          try {
            await wait(faultResponse.waitMs)
          } finally {
            await faultHeartbeat.stop()
          }
          continue
        }
        if (!watch) throw new Error(boundedCode)
        await wait(pollMs)
        continue
      }
      consecutiveBatchFaults = 0
      await activeHeartbeat.stop()
      const desiredAfterBatch = await control
        .getDesiredState('billing')
        .catch(() => 'running' as const)
      try {
        await control.recordObservation({
          system: 'billing',
          observedState:
            targetedOneShot && desiredAfterBatch === 'paused'
              ? 'paused'
              : summary.stoppedEarly
                ? desiredAfterBatch === 'paused'
                  ? 'paused'
                  : 'idle'
                : 'running',
        })
      } catch {
        // The next loop retries control publication; completed work stays durable.
      }
      completed += summary.completed
      selected += summary.selected
      failedOutcomes +=
        summary.retriesScheduled + summary.terminalFailures
      if (summary.stoppedEarly) {
        if (shutdownRequested) {
          await control.recordObservation({
            system: 'billing',
            observedState: 'idle',
          })
          process.stdout.write('[audit-worker] stopped gracefully\n')
          break
        }
        if (!watch || drain) break
        await wait(pollMs)
        continue
      }
      if (requestedMode) {
        // Keep draining the request queue while it yields work, bounded by the
        // host deadline. An empty batch means every administrator request is
        // settled, and the run ends rather than waiting for new intent.
        if (summary.selected > 0 && Date.now() < deadline) continue
        await control.recordObservation({
          system: 'billing',
          observedState:
            (await control.getDesiredState('billing')) === 'paused'
              ? 'paused'
              : 'idle',
        })
        process.stdout.write(
          `[audit-worker] requested re-audit finished; newly completed=${completed}\n`,
        )
        publishNoCompletionFailure()
        break
      }
      if (drain) {
        /**
         * An empty batch is NOT the same as a drained queue.
         *
         * A call whose last attempt hit a transient provider or infrastructure
         * failure is parked behind `audio_next_attempt_at` for minutes, so it
         * is invisible to the eligibility read and then claimable again. Ending
         * the run on the first empty batch reported those calls as drained and
         * left them for the next scheduled run hours later. The drain now stops
         * only on an explicit condition: nothing deferred, the host deadline, or
         * deferred work due beyond this run's hand-over horizon.
         */
        let deferredDueInMs: number | null = null
        if (summary.selected === 0) {
          try {
            deferredDueInMs =
              (await candidates.deferredWorkDueInMs?.()) ?? null
          } catch (error) {
            const fatal = asReauditFatalError('claim', error)
            consecutiveInspectionFaults += 1
            const response = decideBatchFaultResponse({
              category: fatal.category,
              consecutiveFaults: consecutiveInspectionFaults,
              maxConsecutiveFaults: MAX_CONSECUTIVE_BATCH_FAULTS,
              remainingMs: deadline - Date.now(),
              baseBackoffMs: pollMs,
              maxBackoffMs: BATCH_FAULT_MAX_BACKOFF_MS,
            })
            process.stdout.write(
              `${JSON.stringify({
                event: 'billing_audit_queue_inspection_failed',
                category: fatal.category,
                willRetry: response.action === 'retry',
              })}\n`,
            )
            if (response.action === 'stop') {
              throw new Error(
                `BILLING_AUDIT_QUEUE_INSPECTION_FAILED_${fatal.category}`,
              )
            }
            const inspectionHeartbeat = startActiveHeartbeat({
              intervalMs: ACTIVE_HEARTBEAT_INTERVAL_MS,
              record: () => control.recordObservation({
                system: 'billing',
                observedState: 'running',
              }),
            })
            try {
              await wait(response.waitMs)
            } finally {
              await inspectionHeartbeat.stop()
            }
            continue
          }
          consecutiveInspectionFaults = 0
        }
        const continuation = decideDrainContinuation({
          selected: summary.selected,
          deferredDueInMs,
          remainingMs: deadline - Date.now(),
          maxWaitMs: pollMs,
          horizonMs: DRAIN_DEFERRED_HORIZON_MS,
        })
        if (continuation.action === 'continue') continue
        if (continuation.action === 'wait') {
          /**
           * Idle out the backoff on the control plane only. Re-running the
           * candidate scan on every tick would turn a deliberate wait into a
           * polling load on the very tables the drain is waiting to leave
           * alone, so only liveness and operator intent are read here.
           */
          const dueAtMs = Date.now() + (deferredDueInMs ?? 0)
          process.stdout.write(
            `[audit-worker] eligible queue empty; waiting ${deferredDueInMs}ms for the next deferred retry\n`,
          )
          let sliceMs = continuation.waitMs
          const deferredHeartbeat = startActiveHeartbeat({
            intervalMs: ACTIVE_HEARTBEAT_INTERVAL_MS,
            record: () => control.recordObservation({
              system: 'billing',
              observedState: 'running',
            }),
          })
          try {
            while (
              !shutdownRequested &&
              Date.now() < dueAtMs &&
              Date.now() < deadline
            ) {
              let stillRunning = true
              try {
                stillRunning =
                  (await control.getDesiredState('billing')) === 'running'
              } catch {
                // Retry operator intent on the next slice after a control-pool outage.
              }
              if (!stillRunning) break
              await wait(sliceMs)
              sliceMs = Math.max(
                1,
                Math.min(dueAtMs - Date.now(), pollMs, deadline - Date.now()),
              )
            }
          } finally {
            await deferredHeartbeat.stop()
          }
          // Shutdown, pause and the deadline are all decided by the loop head.
          continue
        }
        await control.recordObservation({
          system: 'billing',
          observedState: 'idle',
        })
        process.stdout.write(
          `[audit-worker] drain stopped (${continuation.reason}); newly completed=${completed}\n`,
        )
        publishNoCompletionFailure()
        break
      }
      if (!watch) {
        process.stdout.write(
          `[audit-worker] single batch finished; selected=${summary.selected}; newly completed=${completed}\n`,
        )
        publishNoCompletionFailure()
        break
      }
      if (summary.selected === 0) {
        process.stdout.write(
          `[audit-worker] no due unaudited recording calls; watching for imports/retries (${pollMs}ms)\n`,
        )
        await wait(pollMs)
      }
    }
    if (watch) {
      process.stdout.write(
        `[audit-worker] current queue exhausted; newly completed=${completed}\n`,
      )
    }
  } finally {
    try {
      await lockKeepalive?.stop()
    } catch { /* stopping a timer cannot fail the run */ }
    try {
      if (lockAcquired) {
        try {
          await lockConnection.query(
            `SELECT RELEASE_LOCK('kaudit-independent-reaudit-v2')`,
          )
        } catch {
          // A dropped owner connection already releases its advisory lock.
          process.stdout.write(
            `${JSON.stringify({
              event: 'billing_audit_lock_release_skipped',
              category: 'WORKER_LIFECYCLE',
            })}\n`,
          )
        }
      }
    } finally {
      lockConnection.release()
      await Promise.all([pool.end(), controlPool.end()])
    }
  }
}

main().catch((error: unknown) => {
  /**
   * The final line of defense keeps the original failure bounded: a classified
   * fatal surfaces its phase and allowlisted category only; anything else
   * collapses to the generic worker code. Raw errors are never printed.
   */
  const detail = error instanceof ReauditFatalError
    ? ` (phase=${error.phase}; category=${error.category})`
    : ''
  process.stderr.write(
    `[audit-worker] stopped: BILLING_AUDIT_WORKER_FAILED${detail}\n`,
  )
  process.exitCode = 1
})
