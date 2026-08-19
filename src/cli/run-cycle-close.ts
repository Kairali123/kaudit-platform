import fs from 'node:fs'
import mysql from 'mysql2/promise'
import { loadRuntimeConfig } from '../config/runtime.ts'
import {
  listAcceptedAsBilledCandidates,
  loadPublishedRateCard,
} from '../adapters/mysqlCycleClose.ts'
import {
  buildAcceptedAsBilledRecords,
} from '../billing/acceptedAsBilled.ts'
import {
  persistVerifiedBillingRecords,
} from '../adapters/mysqlVerifiedBilling.ts'
import { parseBillingMonth } from '../reporting/billingMonth.ts'

const config = loadRuntimeConfig(process.env)
const mode =
  process.env.KAUDIT_CYCLE_CLOSE_MODE === 'EXECUTE'
    ? 'EXECUTE'
    : 'DRY-RUN'
const month = process.env.KAUDIT_CYCLE_CLOSE_MONTH?.trim()
const rateCardId =
  process.env.KAUDIT_CYCLE_CLOSE_RATE_CARD_ID?.trim()
if (!month) throw new Error('KAUDIT_CYCLE_CLOSE_MONTH is required')
if (!rateCardId) {
  throw new Error('KAUDIT_CYCLE_CLOSE_RATE_CARD_ID is required')
}
const period = parseBillingMonth(month)
if (!period) throw new Error('A specific billing month is required')
const batch = Number(process.env.KAUDIT_CYCLE_CLOSE_BATCH || 1000)
if (!Number.isInteger(batch) || batch < 1 || batch > 50_000) {
  throw new Error('KAUDIT_CYCLE_CLOSE_BATCH must be 1..50000')
}
// Both flags, always: mysql2 skips the hostname check unless `verifyIdentity`
// is set, so a CA-only pool would accept any host holding any certificate the
// configured authority ever issued.
const ssl = config.database.sslCaFile
  ? {
      ca: fs.readFileSync(config.database.sslCaFile, 'utf8'),
      rejectUnauthorized: true,
      verifyIdentity: true,
    }
  : undefined
const pool = mysql.createPool({
  host: config.database.host,
  port: config.database.port,
  database: config.database.name,
  user: config.database.user,
  password: config.database.password,
  ssl,
  connectionLimit: 4,
})

try {
  const rateCard = await loadPublishedRateCard(pool, rateCardId)
  const candidates = await listAcceptedAsBilledCandidates(
    pool,
    period,
    batch,
  )
  const decidedAt = `${period.end}T18:29:59.999Z`
  let inserted = 0
  let duplicates = 0
  let acceptedAmountPaise = 0
  for (const candidate of candidates) {
    const records = buildAcceptedAsBilledRecords({
      callId: candidate.callId,
      auditRunId: candidate.auditRunId,
      fallbackReason: candidate.fallbackReason,
      claimedDurationMs: candidate.claimedDurationMs,
      connectedDurationMs: candidate.connectedDurationMs,
      vendorBilledMinutes: candidate.vendorBilledMinutes,
      vendorBilledAmount: candidate.vendorBilledAmount,
      sourceEvidence: {
        kind: 'call_manifest',
        referenceId: candidate.evidenceObjectId,
        sha256: candidate.evidenceSha256,
      },
      decidedAt,
    }, rateCard)
    acceptedAmountPaise += Math.round(
      Number(records.calculation?.totalAmount || 0) * 100,
    )
    if (mode === 'DRY-RUN') continue
    const result = await persistVerifiedBillingRecords(pool, {
      records,
      rateCard,
      correlationId: `cycle-close:${period.month}`,
    })
    if (result.outcome === 'inserted') inserted += 1
    else duplicates += 1
  }
  process.stdout.write(`${JSON.stringify({
    mode,
    month: period.month,
    candidates: candidates.length,
    inserted,
    duplicates,
    acceptedAsBilledAmount: (
      acceptedAmountPaise / 100
    ).toFixed(2),
    warning:
      'accepted_as_billed_unverified is a cycle-close fallback, not an independent AI audit',
  }, null, 2)}\n`)
} finally {
  await pool.end()
}
