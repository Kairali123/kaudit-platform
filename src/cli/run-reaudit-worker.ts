import { readFile } from 'node:fs/promises'
import mysql, { type RowDataPacket } from 'mysql2/promise'
import { createProxyResolvingFetcher } from '../adapters/proxyResolvingFetcher.ts'
import { createMysqlReauditReadRepo } from '../adapters/mysqlReauditReadRepo.ts'
import { createMysqlManualReauditCandidateRepository } from '../adapters/mysqlManualReauditQueue.ts'
import { createMysqlReauditWriteRepo } from '../adapters/mysqlReauditWriteRepo.ts'
import { createOpenAiReaudit } from '../adapters/openaiReaudit.ts'
import { createMysqlAuditWorkerControl } from '../adapters/mysqlAuditWorkerControl.ts'
import { auditOneCall } from '../reaudit/core.ts'
import { runReauditBatch } from '../reaudit/worker.ts'
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

async function main(): Promise<void> {
  if (required('KAUDIT_AUDIT_MODE') !== 'EXECUTE') {
    throw new Error(
      'KAUDIT_AUDIT_MODE must be exactly EXECUTE; use reaudit:sample for read-only checks',
    )
  }
  const batchSize = integer('KAUDIT_AUDIT_BATCH', 10, 1, 100)
  const pollMs = integer('KAUDIT_AUDIT_POLL_MS', 15_000, 1_000, 60_000)
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
  const allowedHosts = required('KAUDIT_ALLOWED_RECORDING_HOSTS')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
  const config = loadRuntimeConfig(process.env)
  const ssl = resolveDatabaseTls(config, process.env)
  const pool = mysql.createPool({
    host: config.database.host,
    port: config.database.port,
    database: config.database.name,
    user: config.database.user,
    password: config.database.password,
    ...(ssl ? { ssl } : {}),
    connectionLimit: 4,
    connectTimeout: 30_000,
  })
  const lockConnection = await pool.getConnection()
  try {
    const [lockRows] = await lockConnection.query<RowDataPacket[]>(
      `SELECT GET_LOCK('kaudit-independent-reaudit-v2', 0) AS acquired`,
    )
    if (Number(lockRows[0]?.acquired || 0) !== 1) {
      throw new Error('Another full-call audit worker already owns the database lock')
    }
    const candidates = requestedMode
      ? createMysqlManualReauditCandidateRepository(pool)
      : createMysqlReauditReadRepo(pool, {
          externalTaskIds: taskIds ?? undefined,
          allowPreviouslyClassified: appendReaudit,
        })
    const results = createMysqlReauditWriteRepo(pool, {
      allowCompletedReaudit: appendReaudit,
      manualRequest: requestedMode,
    })
    const control = createMysqlAuditWorkerControl(pool)
    const fetcher = createProxyResolvingFetcher(
      required('KAUDIT_UNPOD_PROXY_BASE'),
    )
    const ai = createOpenAiReaudit(required('OPENAI_API_KEY'))
    let completed = 0
    process.stdout.write(
      `[audit-worker] started; mode=${requestedMode ? 'requested-reaudit' : appendReaudit ? 'append-reaudit' : 'new-only'}; scope=${requestedMode ? 'durable admin request queue' : taskIds ? `${taskIds.length} exact task IDs` : 'all eligible calls'}\n`,
    )
    for (;;) {
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
      try {
        summary = await runReauditBatch({
          candidates,
          results,
          includePreviouslyClassified: appendReaudit || requestedMode,
          batchSize,
          shouldContinue: async () =>
            !shutdownRequested &&
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
            const failures =
              progress.retriesScheduled + progress.terminalFailures
            await control.recordObservation({
              system: 'billing',
              observedState: 'running',
              processedDelta: 1,
              failedDelta: failures - reportedFailures,
              progressed: true,
            })
            reportedFailures = failures
            process.stdout.write(
              `[audit-worker] batch ${progress.completed + progress.retriesScheduled + progress.terminalFailures + progress.alreadyCompleted}/${progress.selected}; completed=${progress.completed}; retry=${progress.retriesScheduled}; terminal=${progress.terminalFailures}; skipped=${progress.alreadyCompleted}\n`,
            )
          },
        })
      } catch {
        await control.recordObservation({
          system: 'billing',
          observedState: 'faulted',
          errorCode: 'BILLING_AUDIT_BATCH_FAILED',
          failedDelta: 1,
        })
        if (!watch) throw new Error('BILLING_AUDIT_BATCH_FAILED')
        await wait(pollMs)
        continue
      }
      const desiredAfterBatch = await control.getDesiredState('billing')
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
      completed += summary.completed
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
        break
      }
      if (drain) {
        if (summary.selected > 0 && Date.now() < deadline) continue
        await control.recordObservation({
          system: 'billing',
          observedState: 'idle',
        })
        process.stdout.write(
          `[audit-worker] drain finished; newly completed=${completed}\n`,
        )
        break
      }
      if (!watch) {
        process.stdout.write(
          `[audit-worker] single batch finished; selected=${summary.selected}; newly completed=${completed}\n`,
        )
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
      await lockConnection.query(
        `SELECT RELEASE_LOCK('kaudit-independent-reaudit-v2')`,
      )
    } finally {
      lockConnection.release()
      await pool.end()
    }
  }
}

main().catch(() => {
  process.stderr.write(
    '[audit-worker] stopped: BILLING_AUDIT_WORKER_FAILED\n',
  )
  process.exitCode = 1
})
