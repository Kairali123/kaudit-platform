import mysql from 'mysql2/promise'
import { migrateEvidenceBatch } from '../storage/migrateEvidenceStorage.ts'
import { createMysqlEvidenceRepo } from '../adapters/mysqlEvidenceRepo.ts'
import { createS3DurableTarget } from '../adapters/s3DurableTarget.ts'
import { createLocalSourceReader } from '../adapters/localSourceReader.ts'

// SAFETY: defaults to dry-run. Refuses to write unless KAUDIT_MIGRATION_MODE=EXECUTE.
// Even in EXECUTE mode this touches PRODUCTION evidence + DB and must only be run as an
// approved, supervised W3 operation against provisioned durable storage. Verify on
// synthetic fixtures first: `npm run test:w3`.
async function main(): Promise<void> {
  const execute = process.env.KAUDIT_MIGRATION_MODE?.trim() === 'EXECUTE'
  const dryRun = !execute
  const batchSize = Number(process.env.KAUDIT_MIGRATION_BATCH || '100')

  const pool = mysql.createPool({
    host: req('DB_HOST'),
    port: Number(process.env.DB_PORT || 3306),
    database: req('DB_NAME'),
    user: req('DB_USER'),
    password: req('DB_PASSWORD'),
    connectionLimit: 5,
    connectTimeout: 30_000,
  })
  const repo = createMysqlEvidenceRepo(pool)
  const target = createS3DurableTarget()
  const source = createLocalSourceReader()

  const rows = await repo.listCandidates(batchSize)
  console.log(`[W3] ${dryRun ? 'DRY-RUN' : 'EXECUTE'} — ${rows.length} candidates → bucket ${target.bucket}`)

  const summary = await migrateEvidenceBatch(rows, { source, target, repo }, { dryRun })
  console.log('[W3] summary:', JSON.stringify({ ...summary, results: undefined }, null, 2))

  const problems = summary.results.filter(
    (r) => r.outcome === 'hash_mismatch' || r.outcome === 'source_missing',
  )
  if (problems.length) {
    console.log(`[W3] ${problems.length} rows need attention (hash_mismatch/source_missing) — see audit log`)
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
