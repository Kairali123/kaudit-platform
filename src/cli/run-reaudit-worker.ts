import { randomUUID } from 'node:crypto'
import mysql, { type RowDataPacket } from 'mysql2/promise'
import { createProxyResolvingFetcher } from '../adapters/proxyResolvingFetcher.ts'
import { createMysqlReauditReadRepo } from '../adapters/mysqlReauditReadRepo.ts'
import { createMysqlReauditWriteRepo } from '../adapters/mysqlReauditWriteRepo.ts'
import { createOpenAiReaudit } from '../adapters/openaiReaudit.ts'
import { auditOneCall } from '../reaudit/core.ts'
import { runReauditBatch } from '../reaudit/worker.ts'

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
  const allowedHosts = required('KAUDIT_ALLOWED_RECORDING_HOSTS')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
  const pool = mysql.createPool({
    host: required('DB_HOST'),
    port: Number(process.env.DB_PORT || 3306),
    database: required('DB_NAME'),
    user: required('DB_USER'),
    password: required('DB_PASSWORD'),
    connectionLimit: 4,
    connectTimeout: 30_000,
  })
  const lockConnection = await pool.getConnection()
  const owner = `audit-worker-${randomUUID()}`
  try {
    const [lockRows] = await lockConnection.query<RowDataPacket[]>(
      `SELECT GET_LOCK('kaudit-independent-reaudit-v2', 0) AS acquired`,
    )
    if (Number(lockRows[0]?.acquired || 0) !== 1) {
      throw new Error('Another full-call audit worker already owns the database lock')
    }
    const candidates = createMysqlReauditReadRepo(pool)
    const results = createMysqlReauditWriteRepo(pool)
    const fetcher = createProxyResolvingFetcher(
      required('KAUDIT_UNPOD_PROXY_BASE'),
    )
    const ai = createOpenAiReaudit(required('OPENAI_API_KEY'))
    let completed = 0
    process.stdout.write(
      `[audit-worker] started owner=${owner}; every already-audited call is skipped\n`,
    )
    for (;;) {
      const summary = await runReauditBatch({
        candidates,
        results,
        batchSize,
        processor: {
          process: (candidate) =>
            auditOneCall({
              candidate,
              fetcher,
              ai,
              allowedHosts,
            }),
        },
        onProgress: (progress) => {
          process.stdout.write(
            `[audit-worker] batch ${progress.completed + progress.retriesScheduled + progress.terminalFailures + progress.alreadyCompleted}/${progress.selected}; completed=${progress.completed}; retry=${progress.retriesScheduled}; terminal=${progress.terminalFailures}; skipped=${progress.alreadyCompleted}\n`,
          )
        },
      })
      completed += summary.completed
      if (summary.selected === 0) {
        if (!watch) break
        process.stdout.write(
          `[audit-worker] no due unaudited recording calls; watching for imports/retries (${pollMs}ms)\n`,
        )
        await wait(pollMs)
      }
    }
    process.stdout.write(
      `[audit-worker] current queue exhausted; newly completed=${completed}\n`,
    )
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

main().catch((error) => {
  process.stderr.write(
    `[audit-worker] stopped: ${String((error as Error)?.message || error).slice(0, 500)}\n`,
  )
  process.exitCode = 1
})
