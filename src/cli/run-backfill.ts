import mysql from 'mysql2/promise'
import { backfillBatch } from '../backfill/backfillSourceUrl.ts'
import { createMysqlBackfillRepo } from '../adapters/mysqlBackfillRepo.ts'
import { createLocalRawStore } from '../adapters/localRawStore.ts'

// Populates `source_url` on recording evidence rows from the raw KServe export payloads.
// Defaults to DRY-RUN (resolve + report, write nothing). Writes only when
// KAUDIT_BACKFILL_MODE=EXECUTE. Touches the production DB in EXECUTE mode — run as an
// approved, supervised pass, after migration 0001 has added the source_url column.
async function main(): Promise<void> {
  const execute = process.env.KAUDIT_BACKFILL_MODE?.trim() === 'EXECUTE'
  const dryRun = !execute
  const batchSize = Number(process.env.KAUDIT_BACKFILL_BATCH || '100')
  const allowedHosts = (process.env.KAUDIT_ALLOWED_RECORDING_HOSTS || '')
    .split(',')
    .map((h) => h.trim())
    .filter(Boolean)
  if (!allowedHosts.length) {
    throw new Error('KAUDIT_ALLOWED_RECORDING_HOSTS is required (comma-separated S3 host allowlist)')
  }

  const pool = mysql.createPool({
    host: req('DB_HOST'),
    port: Number(process.env.DB_PORT || 3306),
    database: req('DB_NAME'),
    user: req('DB_USER'),
    password: req('DB_PASSWORD'),
    connectionLimit: 5,
    connectTimeout: 30_000,
  })
  const repo = createMysqlBackfillRepo(pool)
  const rawStore = createLocalRawStore()

  const candidates = await repo.listCandidates(batchSize)
  console.log(`[W3-backfill] ${dryRun ? 'DRY-RUN' : 'EXECUTE'} — ${candidates.length} candidates`)

  const summary = await backfillBatch(candidates, { rawStore, repo }, { dryRun, allowedHosts })
  console.log('[W3-backfill] summary:', JSON.stringify({ ...summary, results: undefined }, null, 2))

  const problems = summary.results.filter(
    (r) =>
      r.outcome === 'raw_missing' ||
      r.outcome === 'call_not_in_export' ||
      r.outcome === 'no_recording_url' ||
      r.outcome === 'unrecognized_url',
  )
  if (problems.length) {
    console.log(`[W3-backfill] ${problems.length} candidates unresolved — see audit log`)
  }
  await pool.end()
}

function req(name: string): string {
  const v = process.env[name]?.trim()
  if (!v) throw new Error(`${name} is required`)
  return v
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
