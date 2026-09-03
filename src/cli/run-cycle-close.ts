import mysql from 'mysql2/promise'
import { loadRuntimeConfig } from '../config/runtime.ts'
import {
  listAcceptedAsBilledCandidates,
  loadPublishedRateCard,
  type CycleCloseCohort,
} from '../adapters/mysqlCycleClose.ts'
import {
  buildAcceptedAsBilledRecords,
  validateRateCard,
} from '../billing/acceptedAsBilled.ts'
import { KSERVE_RULESET_SHA256 } from '../billing/kserveRules.ts'
import {
  persistVerifiedBillingRecords,
} from '../adapters/mysqlVerifiedBilling.ts'
import { parseBillingMonth } from '../reporting/billingMonth.ts'
import { resolveDatabaseTls } from '../runtime/databaseTls.ts'

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
/**
 * Which unsettled calls this run may settle. Defaults to the original whole
 * population; an operator narrows it deliberately by naming a cohort.
 */
const cohortValue =
  process.env.KAUDIT_CYCLE_CLOSE_COHORT?.trim() || 'all'
if (cohortValue !== 'all' && cohortValue !== 'exhausted-recording') {
  throw new Error(
    'KAUDIT_CYCLE_CLOSE_COHORT must be all or exhausted-recording',
  )
}
const cohort: CycleCloseCohort = cohortValue
const ssl = resolveDatabaseTls(config, process.env)
const pool = mysql.createPool({
  host: config.database.host,
  port: config.database.port,
  database: config.database.name,
  user: config.database.user,
  password: config.database.password,
  // Present only when there is a handshake to configure. mysql2 decides
  // whether to negotiate TLS from whether this key carries options, so a
  // plaintext runtime must hand the driver no `ssl` key at all rather than one
  // holding `undefined` — otherwise the client opens a TLS handshake the
  // server is not expecting and the connection hangs until it times out.
  ...(ssl ? { ssl } : {}),
  // The same budget the hosted audit workers use. The mysql2 default is ten
  // seconds, which is not enough for this host's handshake from a fresh CI
  // runner, and a cycle close that cannot connect is indistinguishable from
  // one that found nothing to settle.
  connectTimeout: 30_000,
  connectionLimit: 4,
})

try {
  const rateCard = await loadPublishedRateCard(pool, rateCardId)
  /**
   * Check the rate card ONCE, before reading a single candidate.
   *
   * The same D-03 gate runs inside every record build, so a stale binding used
   * to surface only on the first candidate — after a full scan, with nothing
   * written and no statement of which side was wrong. Failing here instead
   * costs one query and names the mismatch exactly. It is deliberately not
   * repairable from this command: a rate card whose stored hash does not match
   * the locked ruleset must be re-published through the approval path.
   */
  let rateCardUsable = true
  try {
    validateRateCard(rateCard)
  } catch {
    rateCardUsable = false
    process.stderr.write(`${JSON.stringify({
      event: 'cycle_close_rate_card_unusable',
      code: 'RATE_CARD_RULESET_BINDING_INVALID',
      rateCardId: rateCard.id,
      rateCardVersion: rateCard.version,
      status: rateCard.status,
      currency: rateCard.currency,
      approverRecorded: Boolean(rateCard.approvedBy),
      approvedAtRecorded: Boolean(rateCard.approvedAt),
      // Ruleset hashes are published repo constants, not secrets, and the
      // operator cannot repair the binding without seeing both sides.
      storedRulesetSha256: rateCard.rulesetSha256,
      lockedRulesetSha256: KSERVE_RULESET_SHA256,
      rulesetMatches: rateCard.rulesetSha256 === KSERVE_RULESET_SHA256,
      remedy:
        'Re-publish the rate card version bound to the locked KServe ruleset, then re-run. No money was written.',
    }, null, 2)}\n`)
    process.exitCode = 3
    /**
     * A run that would WRITE stops here. A dry run continues, because the
     * whole point of previewing is to learn the cohort size and the rate-card
     * state in one pass rather than one blocker at a time. It still writes
     * nothing: the persistence call below is unreachable in DRY-RUN.
     */
    if (mode === 'EXECUTE') {
      throw new Error('CYCLE_CLOSE_RATE_CARD_RULESET_BINDING_INVALID')
    }
  }
  const candidates = await listAcceptedAsBilledCandidates(
    pool,
    period,
    batch,
    cohort,
  )
  const decidedAt = `${period.end}T18:29:59.999Z`
  let inserted = 0
  let duplicates = 0
  let acceptedAmountPaise = 0
  let noRecordingZeroCandidates = 0
  let recordingFallbackCandidates = 0
  let auditExhaustedCandidates = 0
  let unresolvedValidationCandidates = 0
  for (const candidate of candidates) {
    if (candidate.fallbackReason === 'no_recording') {
      noRecordingZeroCandidates += 1
    } else {
      recordingFallbackCandidates += 1
      if (candidate.fallbackReason === 'audit_exhausted') {
        auditExhaustedCandidates += 1
      } else {
        unresolvedValidationCandidates += 1
      }
    }
    // Pricing runs through the same gate, so an unusable card can only be
    // counted, never valued. The count is what a preview is for.
    if (!rateCardUsable) continue
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
    cohort,
    rateCardUsable,
    month: period.month,
    candidates: candidates.length,
    noRecordingZeroCandidates,
    recordingFallbackCandidates,
    auditExhaustedCandidates,
    unresolvedValidationCandidates,
    inserted,
    duplicates,
    acceptedAsBilledAmount: (
      acceptedAmountPaise / 100
    ).toFixed(2),
    warning:
      'Cycle-close outcomes are deterministic fallbacks, not independent AI audits',
  }, null, 2)}\n`)
} finally {
  await pool.end()
}
