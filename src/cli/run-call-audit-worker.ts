import mysql, { type RowDataPacket } from 'mysql2/promise'
import { loadRuntimeConfig } from '../config/runtime.ts'
import { resolveDatabaseTls } from '../runtime/databaseTls.ts'
import { createMysqlAuditWorkerControl } from '../adapters/mysqlAuditWorkerControl.ts'
import { createMysqlCallAuditControlRepository } from '../adapters/mysqlCallAuditControl.ts'
import { createMysqlCallAuditPersistenceRepository } from '../adapters/mysqlCallAuditPersistence.ts'
import { createMysqlCallAuditSettingsRepository } from '../adapters/mysqlCallAuditSettings.ts'
import { createMysqlCallAuditSourceReader } from '../adapters/mysqlCallAuditSource.ts'
import { createOpenAiCallAuditModel } from '../adapters/openaiCallAuditClient.ts'
import { runAutomaticCallAuditCycle } from '../callaudit/automaticWorker.ts'

const WORKER_ERROR = 'CALL_AUDIT_AUTO_WORKER_FAILED'

function required(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(WORKER_ERROR)
  return value
}

function integer(name: string, fallback: number, min: number, max: number) {
  const value = Number(process.env[name] || fallback)
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(WORKER_ERROR)
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
  const config = loadRuntimeConfig(process.env)
  const initialCheckpoint =
    process.env.KAUDIT_CALL_AUDIT_AUTO_START?.trim() || null
  const pollMs = integer('KAUDIT_CALL_AUDIT_POLL_MS', 60_000, 5_000, 300_000)
  const batchSize = integer('KAUDIT_CALL_AUDIT_BATCH_SIZE', 25, 1, 1000)
  const drain = enabled('KAUDIT_CALL_AUDIT_DRAIN')
  const deadlineSeconds = integer(
    'KAUDIT_WORKER_DEADLINE_SECONDS',
    19_200,
    300,
    21_000,
  )
  const deadline = Date.now() + deadlineSeconds * 1000
  const apiKey = required('OPENAI_API_KEY')
  const ssl = resolveDatabaseTls(config, process.env)
  const pool = mysql.createPool({
    host: config.database.host,
    port: config.database.port,
    database: config.database.name,
    user: config.database.user,
    password: config.database.password,
    ...(ssl ? { ssl } : {}),
    connectionLimit: 4,
    connectTimeout: 10_000,
    enableKeepAlive: true,
    decimalNumbers: false,
  })
  const lock = await pool.getConnection()
  try {
    const [rows] = await lock.query<RowDataPacket[]>(
      "SELECT GET_LOCK('kaudit-call-audit-auto-v1', 0) AS acquired",
    )
    if (Number(rows[0]?.acquired || 0) !== 1) {
      throw new Error(WORKER_ERROR)
    }
    const workerControl = createMysqlAuditWorkerControl(pool)
    const source = createMysqlCallAuditSourceReader(pool)
    const settings = createMysqlCallAuditSettingsRepository(pool)
    const runControl = createMysqlCallAuditControlRepository(pool)
    const persistence = createMysqlCallAuditPersistenceRepository(pool)
    const model = createOpenAiCallAuditModel(apiKey)

    process.stdout.write('[call-audit-worker] started\n')
    for (;;) {
      if (drain && Date.now() >= deadline) {
        await workerControl.recordObservation({
          system: 'call',
          observedState: 'idle',
        })
        process.stdout.write('[call-audit-worker] deadline reached\n')
        break
      }
      const result = await runAutomaticCallAuditCycle({
        workerControl,
        runControl,
        settings,
        source,
        persistence,
        model,
        initialCheckpoint,
        batchSize,
        shouldContinue: async () => !drain || Date.now() < deadline,
      })
      if (result.outcome === 'processed') {
        process.stdout.write(
          `[call-audit-worker] processed=${result.summary.candidatesProcessed} failed=${result.summary.counts.failedTotal} skipped=${result.summary.counts.skippedTotal}\n`,
        )
      } else {
        process.stdout.write(
          `[call-audit-worker] state=${result.outcome}${
            result.outcome === 'faulted'
              ? ` code=${result.errorCode}`
              : ''
          }\n`,
        )
        if (drain) {
          if (result.outcome === 'faulted') throw new Error(WORKER_ERROR)
          break
        }
        await wait(pollMs)
      }
    }
  } finally {
    try {
      await lock.query("SELECT RELEASE_LOCK('kaudit-call-audit-auto-v1')")
    } finally {
      lock.release()
      await pool.end()
    }
  }
}

main().catch(() => {
  process.stderr.write(`[call-audit-worker] stopped ${WORKER_ERROR}\n`)
  process.exitCode = 1
})
