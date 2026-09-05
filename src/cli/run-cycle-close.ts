import mysql from 'mysql2/promise'
import { loadRuntimeConfig } from '../config/runtime.ts'
import {
  countRecordingBackedCalls,
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
  buildAuditedProjectionRecords,
} from '../billing/auditedProjectionSettlement.ts'
import {
  persistVerifiedBillingRecords,
} from '../adapters/mysqlVerifiedBilling.ts'
import {
  decideVendorAssertedBound,
} from '../billing/vendorAssertedBound.ts'
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
if (
  cohortValue !== 'all' &&
  cohortValue !== 'exhausted-recording' &&
  cohortValue !== 'no-recording' &&
  cohortValue !== 'audited-projection'
) {
  throw new Error(
    'KAUDIT_CYCLE_CLOSE_COHORT must be all, exhausted-recording, no-recording, or audited-projection',
  )
}
const cohort: CycleCloseCohort = cohortValue

/**
 * Why one call could not be settled, as a bounded code.
 *
 * The builder's refusals are exact, known sentences, so they map to codes by
 * ALLOWLIST rather than by pattern-matching the message. An earlier version
 * accepted any message that looked code-shaped and collapsed everything else
 * to the catch-all — which meant the one field that exists to explain a skip
 * explained nothing. Prose is still never emitted: an unrecognized failure
 * stays the catch-all, because it may carry a driver detail or a quantity.
 */
const SETTLEMENT_FAILURE_CODES = new Map([
  [
    'Vendor billed minutes must use the locked 0.5-minute increments',
    'VENDOR_MINUTES_NOT_HALF_MINUTE_MULTIPLE',
  ],
  [
    'vendorBilledMinutes must be a positive scale-8 decimal',
    'VENDOR_MINUTES_MALFORMED',
  ],
  ['Vendor quantity cannot be represented exactly', 'VENDOR_QUANTITY_INEXACT'],
  ['source evidence must carry a SHA-256 hash', 'EVIDENCE_HASH_MISSING'],
  ['callId is required', 'CALL_ID_MISSING'],
  ['decidedAt must be an ISO timestamp', 'DECIDED_AT_INVALID'],
])

function settlementFailureCode(error: unknown): string {
  const message = error instanceof Error ? error.message : ''
  const known = SETTLEMENT_FAILURE_CODES.get(message)
  if (known) return known
  if (message.startsWith('D-03:')) return 'RATE_CARD_GATE_REFUSED'
  const driverCode = (error as { code?: unknown } | null)?.code
  return typeof driverCode === 'string' && /^[A-Z][A-Z0-9_]{2,39}$/.test(driverCode)
    ? `DB_${driverCode}`
    : 'CANDIDATE_NOT_SETTLED'
}
/**
 * How many calls settle at once.
 *
 * Each call remains its own transaction with its own manifest hash, decision
 * trace and evidence hash; this only stops the run waiting on one database
 * round trip at a time. A cohort can be tens of thousands of calls, and
 * sequentially that is round-trip-bound into the hour range.
 */
const concurrency = Number(process.env.KAUDIT_CYCLE_CLOSE_CONCURRENCY || 12)
if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 32) {
  throw new Error('KAUDIT_CYCLE_CLOSE_CONCURRENCY must be 1..32')
}
/**
 * Optional per-run override of the vendor-asserted bound. Absent by default:
 * the point of the bound is that nobody has to set anything for it to hold.
 */
const maxVendorAssertedShareRaw =
  process.env.KAUDIT_CYCLE_CLOSE_MAX_VENDOR_ASSERTED_SHARE?.trim()
const maxVendorAssertedShare =
  maxVendorAssertedShareRaw ? Number(maxVendorAssertedShareRaw) : null
if (
  maxVendorAssertedShare != null &&
  !(Number.isFinite(maxVendorAssertedShare) &&
    maxVendorAssertedShare >= 0 &&
    maxVendorAssertedShare <= 1)
) {
  throw new Error(
    'KAUDIT_CYCLE_CLOSE_MAX_VENDOR_ASSERTED_SHARE must be a share between 0 and 1',
  )
}

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
  // One connection per settling lane, plus headroom for the rate-card read.
  connectionLimit: concurrency + 2,
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
  /**
   * The exhausted cohort is the only one priced on the vendor's own assertion,
   * so it is the only one that carries a bound. It is checked BEFORE any money
   * is written, and a preview reports it without enforcing it, so an operator
   * learns the month is abnormal from a dry run rather than from a refusal
   * halfway through a real close.
   */
  const vendorAssertedBound = cohort === 'exhausted-recording'
    ? decideVendorAssertedBound({
      exhaustedCandidates: candidates.length,
      recordingBackedCalls: await countRecordingBackedCalls(pool, period),
      ...(maxVendorAssertedShare == null
        ? {}
        : { maxShare: maxVendorAssertedShare }),
    })
    : null
  if (vendorAssertedBound && !vendorAssertedBound.permitted) {
    process.stdout.write(`${JSON.stringify({
      blocked: 'CYCLE_CLOSE_VENDOR_ASSERTED_BOUND_EXCEEDED',
      cohort,
      month: period.month,
      ...vendorAssertedBound,
      remedy:
        'An audit failure this wide is a fault to investigate, not a bill to accept. Re-run once the recording or transcription failures are resolved, or raise KAUDIT_CYCLE_CLOSE_MAX_VENDOR_ASSERTED_SHARE deliberately for this month.',
    }, null, 2)}\n`)
    process.exitCode = 5
    if (mode === 'EXECUTE') {
      throw new Error('CYCLE_CLOSE_VENDOR_ASSERTED_BOUND_EXCEEDED')
    }
  }
  const decidedAt = `${period.end}T18:29:59.999Z`
  let inserted = 0
  let duplicates = 0
  let acceptedAmountPaise = 0
  let noRecordingZeroCandidates = 0
  let recordingFallbackCandidates = 0
  let auditExhaustedCandidates = 0
  let unresolvedValidationCandidates = 0
  let skipped = 0
  let auditedProjectionCandidates = 0
  let auditedNoDurationCandidates = 0
  const skippedCodes = new Map<string, number>()
  const settle = async (
    candidate: (typeof candidates)[number],
  ): Promise<void> => {
    /**
     * The reason counters describe the fallback population. An audited call is
     * not a fallback: it is priced from its own audit, and the query's reason
     * column only labels it for the cases where a fallback IS needed. Counting
     * it here reported every audited call as an unresolved validation, which is
     * the opposite of what happened to it.
     */
    if (cohort !== 'audited-projection') {
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
    }
    // Pricing runs through the same gate, so an unusable card can only be
    // counted, never valued. The count is what a preview is for.
    if (!rateCardUsable) return
    /**
     * One call cannot abandon the rest.
     *
     * A cohort is now tens of thousands of calls, and a single malformed
     * vendor quantity used to throw out of the loop, leaving a partial cycle
     * with no statement of where it stopped. Each call is its own transaction
     * and re-running skips what is already written, so an isolated failure is
     * recorded and stepped over. It is never silent: the count is reported and
     * the run exits non-zero so a partial close cannot read as a clean one.
     */
    try {
      /**
       * An audited call is priced from its OWN audited duration. Only when the
       * audit established no chargeable duration is there nothing to bill from,
       * and the vendor's claim is accepted instead — recorded as that, not as
       * an audited amount of zero, because nobody measured zero.
       */
      const projected = cohort === 'audited-projection'
        ? buildAuditedProjectionRecords({
            callId: candidate.callId,
            auditRunId: candidate.auditRunId,
            category: candidate.category,
            recordedDurationMs: candidate.recordedDurationMs,
            speechDurationMs: candidate.speechDurationMs,
            serviceEndMs: candidate.serviceEndMs,
            graceMs: candidate.graceMs,
            claimedDurationMs: candidate.claimedDurationMs,
            connectedDurationMs: candidate.connectedDurationMs,
            vendorBilledAmount: candidate.vendorBilledAmount,
            sourceEvidence: {
              kind: 'call_manifest',
              referenceId: candidate.evidenceObjectId,
              sha256: candidate.evidenceSha256,
            },
            decidedAt,
          }, rateCard)
        : null
      if (projected) {
        auditedProjectionCandidates += 1
        acceptedAmountPaise += Math.round(
          Number(projected.calculation?.totalAmount || 0) * 100,
        )
        if (mode === 'DRY-RUN') return
        const projectedResult = await persistVerifiedBillingRecords(pool, {
          records: projected,
          rateCard,
          correlationId: `cycle-close:${period.month}`,
          firstSettlement: true,
        })
        if (projectedResult.outcome === 'inserted') inserted += 1
        else duplicates += 1
        return
      }
      if (cohort === 'audited-projection') auditedNoDurationCandidates += 1
      const records = buildAcceptedAsBilledRecords({
        callId: candidate.callId,
        auditRunId: candidate.auditRunId,
        fallbackReason: cohort === 'audited-projection'
          ? 'audited_duration_unavailable'
          : candidate.fallbackReason,
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
      if (mode === 'DRY-RUN') return
      const result = await persistVerifiedBillingRecords(pool, {
        records,
        rateCard,
        correlationId: `cycle-close:${period.month}`,
        // The candidate query selected this call precisely because no live
        // final calculation exists for it, so the writer's supersede and
        // duplicate probes match nothing — and each one takes a gap lock that
        // every other settling lane then waits on.
        firstSettlement: true,
      })
      if (result.outcome === 'inserted') inserted += 1
      else duplicates += 1
    } catch (error) {
      skipped += 1
      skippedCodes.set(
        settlementFailureCode(error),
        (skippedCodes.get(settlementFailureCode(error)) ?? 0) + 1,
      )
    }
  }
  /**
   * Bounded lanes over one shared cursor.
   *
   * Ordering does not matter here: every candidate is independent, each writes
   * its own transaction, and the counters above are only incremented between
   * awaits on a single-threaded event loop.
   */
  let nextIndex = 0
  await Promise.all(
    Array.from(
      { length: Math.min(concurrency, candidates.length) },
      async () => {
        for (;;) {
          const candidate = candidates[nextIndex]
          if (!candidate) return
          nextIndex += 1
          await settle(candidate)
        }
      },
    ),
  )
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
    auditedProjectionCandidates,
    auditedNoDurationCandidates,
    inserted,
    duplicates,
    skipped,
    skippedCodes: Object.fromEntries(skippedCodes),
    vendorAssertedBound,
    acceptedAsBilledAmount: (
      acceptedAmountPaise / 100
    ).toFixed(2),
    warning:
      'Cycle-close outcomes are deterministic fallbacks, not independent AI audits',
  }, null, 2)}\n`)
  // A close that left calls unsettled is not a clean close, whatever the
  // insert count says.
  if (skipped > 0) process.exitCode = 4
} finally {
  await pool.end()
}
