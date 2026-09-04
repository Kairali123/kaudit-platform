import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

/**
 * Static contract for the cycle-close command.
 *
 * The command writes money, so what it does BEFORE writing matters as much as
 * the arithmetic. This pins the order and the refusals; the arithmetic itself
 * is proven in `acceptedAsBilled.test.ts` and the cohort in
 * `mysqlCycleClose.test.ts`.
 *
 * No fixture, identifier, or amount in this file comes from real data.
 */

const cli = readFileSync(
  new URL('../cli/run-cycle-close.ts', import.meta.url),
  'utf8',
)

test('the published rate card is checked before any candidate is read', () => {
  const validateAt = cli.indexOf('validateRateCard(rateCard)')
  const listAt = cli.indexOf('listAcceptedAsBilledCandidates(')
  assert.ok(validateAt > 0, 'the command must check the rate card')
  assert.ok(listAt > 0)
  assert.ok(
    validateAt < listAt,
    'the rate-card check must precede the candidate scan',
  )
})

test('an unusable rate card refuses the run and states which side mismatched', () => {
  assert.match(cli, /RATE_CARD_RULESET_BINDING_INVALID/)
  assert.match(cli, /storedRulesetSha256: rateCard\.rulesetSha256/)
  assert.match(cli, /lockedRulesetSha256: KSERVE_RULESET_SHA256/)
  assert.match(cli, /No money was written/)
  assert.match(cli, /process\.exitCode = 3/)
})

test('only a writing run stops at an unusable rate card', () => {
  // A preview exists to learn the cohort size AND the rate-card state in one
  // pass. Stopping at the first blocker turns one diagnostic into two.
  assert.match(
    cli,
    /if \(mode === 'EXECUTE'\) \{\s*\n\s*throw new Error\('CYCLE_CLOSE_RATE_CARD_RULESET_BINDING_INVALID'\)/,
  )
  // It still values nothing without a usable card, and still writes nothing.
  assert.match(cli, /if \(!rateCardUsable\) return/)
  assert.match(cli, /rateCardUsable,/)
  // The refusal is still reported and still non-zero, either way.
  assert.match(cli, /process\.exitCode = 3/)
})

test('the command can never repair the binding it refuses', () => {
  // Re-binding a published rate card is an approval decision, not something a
  // batch command may do to unblock itself.
  for (const forbidden of [
    /UPDATE\s+kaudit_rate_card_version/i,
    /ruleset_sha256\s*=/i,
    /KSERVE_RULESET_SHA256\s*=/,
  ]) {
    assert.doesNotMatch(cli, forbidden)
  }
})

test('the settled cohort is explicit, validated, and reported', () => {
  assert.match(cli, /KAUDIT_CYCLE_CLOSE_COHORT/)
  assert.match(cli, /cohortValue !== 'all' &&/)
  assert.match(cli, /cohortValue !== 'exhausted-recording'/)
  // The default stays the original whole population, so no existing caller
  // silently changes what it settles.
  assert.match(cli, /KAUDIT_CYCLE_CLOSE_COHORT\?\.trim\(\) \|\| 'all'/)
  // The receipt has to say which cohort ran and what each reason contributed.
  assert.match(cli, /cohort,/)
  assert.match(cli, /auditExhaustedCandidates/)
  assert.match(cli, /unresolvedValidationCandidates/)
})

test('a dry run reads and prices but never persists', () => {
  assert.match(
    cli,
    /if \(mode === 'DRY-RUN'\) return\s*\n\s*const result = await persistVerifiedBillingRecords/,
  )
  assert.match(cli, /=== 'EXECUTE'\s*\n?\s*\? 'EXECUTE'\s*\n?\s*: 'DRY-RUN'/)
})

test('the receipt keeps calling the fallback what it is', () => {
  assert.match(
    cli,
    /Cycle-close outcomes are deterministic fallbacks, not independent AI audits/,
  )
})

test('the pool omits the ssl key entirely on a plaintext runtime', () => {
  // mysql2 decides whether to negotiate TLS from whether the key is PRESENT.
  // Passing `ssl: undefined` makes the client open a handshake the server is
  // not expecting, and the connection hangs until it times out rather than
  // failing fast — which is what a cycle close is least able to distinguish
  // from an empty queue.
  assert.match(cli, /\.\.\.\(ssl \? \{ ssl \} : \{\}\)/)
  assert.doesNotMatch(cli, /^\s*ssl,\s*$/m)
})

test('the pool allows the same connect budget as the hosted workers', () => {
  // The mysql2 default is 10s. The hosted audit workers connect to the same
  // host with 30s, so a cycle close that uses the default fails where they
  // succeed — and reports it as a connection error, not as "nothing to do".
  assert.match(cli, /connectTimeout: 30_000/)
})

test('one unsettleable call cannot abandon the rest of the cohort', () => {
  // A cohort is now tens of thousands of calls. A single malformed vendor
  // quantity used to throw out of the loop, leaving a partial cycle with no
  // statement of where it stopped.
  // Both builders sit inside the per-call try, so neither an audited
  // projection nor a vendor-claim fallback can throw out of the cohort.
  assert.match(cli, /try \{[\s\S]{0,600}buildAuditedProjectionRecords/)
  assert.match(cli, /try \{[\s\S]{0,2500}buildAcceptedAsBilledRecords/)
  assert.match(cli, /skipped \+= 1/)
  // Never silent: reported, and the run cannot exit clean.
  assert.match(cli, /skipped,/)
  assert.match(cli, /skippedCodes: Object\.fromEntries\(skippedCodes\)/)
  assert.match(cli, /if \(skipped > 0\) process\.exitCode = 4/)
  // The recorded code stays bounded; a raw message can quote a quantity.
  assert.match(cli, /CANDIDATE_NOT_SETTLED/)
})

test('the no-recording cohort is accepted and validated', () => {
  assert.match(cli, /cohortValue !== 'no-recording'/)
  assert.match(
    cli,
    /must be all, exhausted-recording, no-recording, or audited-projection/,
  )
})

test('candidates settle in bounded lanes, each still its own transaction', () => {
  // Sequential settling is round-trip bound: tens of thousands of calls take
  // an hour with the database idle between each one.
  assert.match(cli, /KAUDIT_CYCLE_CLOSE_CONCURRENCY/)
  assert.match(cli, /concurrency < 1 \|\| concurrency > 32/)
  assert.match(cli, /Math\.min\(concurrency, candidates\.length\)/)
  // The pool has to be able to carry the lanes, or they queue on connections.
  assert.match(cli, /connectionLimit: concurrency \+ 2/)
  // Parallelism must not become batching: one call, one transaction, one
  // manifest hash and trace.
  assert.match(cli, /await settle\(candidate\)/)
  assert.match(cli, /await persistVerifiedBillingRecords\(pool, \{/)
})

test('a skip names its reason instead of collapsing to a catch-all', () => {
  // The earlier version accepted any code-shaped message and collapsed the
  // rest, so the one field that exists to explain a skip explained nothing.
  assert.match(cli, /SETTLEMENT_FAILURE_CODES = new Map/)
  for (const code of [
    'VENDOR_MINUTES_NOT_HALF_MINUTE_MULTIPLE',
    'VENDOR_MINUTES_MALFORMED',
    'VENDOR_QUANTITY_INEXACT',
    'EVIDENCE_HASH_MISSING',
    'RATE_CARD_GATE_REFUSED',
  ]) {
    assert.ok(cli.includes(code), `${code} must be a reportable reason`)
  }
  // Prose still never escapes: an unrecognized failure stays the catch-all.
  assert.match(cli, /: 'CANDIDATE_NOT_SETTLED'/)
  assert.doesNotMatch(cli, /\? error\.message\s*\n?\s*: 'CANDIDATE_NOT_SETTLED'/)
  // A driver code is bounded by shape before it is reported.
  assert.match(cli, /\^\[A-Z\]\[A-Z0-9_\]\{2,39\}\$/)
})
