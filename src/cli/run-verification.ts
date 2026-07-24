import mysql from 'mysql2/promise'
import { verifyEvidenceBatch } from '../storage/verifyEvidenceUrl.ts'
import { createMysqlEvidenceRepo } from '../adapters/mysqlEvidenceRepo.ts'
import { createProxyResolvingFetcher } from '../adapters/proxyResolvingFetcher.ts'

// Verifies KServe recordings: fetches each recording FRESH through the unpod.ai proxy
// ({KAUDIT_UNPOD_PROXY_BASE}?url={s3_object_url}) and hashes it against the baseline
// recorded at ingestion. Defaults to DRY-RUN (fetch + report, write nothing). Writes
// hashes/verifications/findings only when KAUDIT_VERIFY_MODE=EXECUTE. Touches the
// production DB and downloads real recordings in EXECUTE mode — run as an approved,
// supervised pass.
async function main(): Promise<void> {
  const execute = process.env.KAUDIT_VERIFY_MODE?.trim() === 'EXECUTE'
  const dryRun = !execute
  const batchSize = Number(process.env.KAUDIT_VERIFY_BATCH || '100')
  const allowedHosts = (process.env.KAUDIT_ALLOWED_RECORDING_HOSTS || '')
    .split(',')
    .map((h) => h.trim())
    .filter(Boolean)
  if (!allowedHosts.length) {
    throw new Error('KAUDIT_ALLOWED_RECORDING_HOSTS is required (comma-separated S3 host allowlist)')
  }
  const proxyBase = req('KAUDIT_UNPOD_PROXY_BASE')

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
  const fetcher = createProxyResolvingFetcher(proxyBase)

  const rows = await repo.listForVerification(batchSize)
  console.log(
    `[W3-verify] ${dryRun ? 'DRY-RUN' : 'EXECUTE'} — ${rows.length} rows; proxy=${new URL(proxyBase).host}; s3-hosts=${allowedHosts.join(',')}`,
  )

  const summary = await verifyEvidenceBatch(
    rows,
    { fetcher, repo, allowedHosts, now: () => new Date().toISOString() },
    { dryRun },
  )
  console.log('[W3-verify] summary:', JSON.stringify({ ...summary, results: undefined }, null, 2))

  const problems = summary.results.filter(
    (r) => r.outcome === 'evidence_altered' || r.outcome === 'source_missing' || r.outcome === 'unsafe_url',
  )
  if (problems.length) {
    console.log(`[W3-verify] ${problems.length} findings need attention — see audit log`)
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
