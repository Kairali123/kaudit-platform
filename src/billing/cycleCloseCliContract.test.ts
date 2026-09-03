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
  assert.match(
    cli,
    /cohortValue !== 'all' && cohortValue !== 'exhausted-recording'/,
  )
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
    /if \(mode === 'DRY-RUN'\) continue\s*\n\s*const result = await persistVerifiedBillingRecords/,
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
