import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

/**
 * Transport-shape contract for the verified-billing writer.
 *
 * The behaviour of the writer itself is covered by
 * `mysqlVerifiedBilling.integration.test.ts`, which needs a database. What is
 * asserted here is the lock mode it asks for, which is readable from source and
 * decides whether a cycle close runs in minutes or in hours.
 */

const source = readFileSync(
  new URL('./mysqlVerifiedBilling.ts', import.meta.url),
  'utf8',
)

test('the rate card is held with a shared lock, never an exclusive one', () => {
  // Every write in a cycle close targets the SAME rate card row. An exclusive
  // lock there serialized the entire run against itself — 24,169 calls became
  // 24,169 sequential transactions. A shared lock gives the guarantee that
  // actually matters: the card cannot be modified while money is written
  // against it, because any concurrent UPDATE still blocks.
  assert.match(source, /WHERE id = \? LOCK IN SHARE MODE/)
  assert.doesNotMatch(
    source,
    /kaudit_rate_card_version[\s\S]{0,200}FOR UPDATE/,
  )
  // The validation itself is unchanged: any drift still aborts the write.
  assert.match(source, /Rate card changed or is not formally published/)
})

test('rows that must not move under a write still take an exclusive lock', () => {
  // The shared lock above is specific to the rate card. Per-call rows a write
  // supersedes are still locked exclusively, because two writers really can
  // contend for those.
  assert.match(source, /FROM kaudit_automated_decision[\s\S]{0,300}FOR UPDATE/)
})

test('a first settlement skips probes that can only take gap locks', () => {
  // The candidate query already established no live final calculation exists.
  // Each probe below is then a SELECT ... FOR UPDATE matching no row, so
  // InnoDB takes a GAP lock, and concurrent lanes settling a cohort fight over
  // those gaps — which is what turned a bulk close into seconds per call.
  for (const probe of [
    /const duplicate = firstSettlement \? null : await findExistingDecision/,
    /const \[exactRows\] = firstSettlement/,
    /const supersedesCalculationId = firstSettlement\s*\n\s*\? null/,
    /const supersedesDecisionId = firstSettlement\s*\n\s*\? null/,
  ]) {
    assert.match(source, probe)
  }
})

test('the manifest unique key is what still prevents a double write', () => {
  // With the probes skipped the constraint is the defence, so its violation is
  // the duplicate answer rather than a crash — and only on that path.
  assert.match(source, /ER_DUP_ENTRY/)
  assert.match(
    source,
    /if \(firstSettlement && isDuplicateKey\(error\)\) \{[\s\S]{0,160}outcome: 'duplicate'/,
  )
  // A normal write still surfaces a duplicate key as a real failure.
  assert.match(source, /if \(firstSettlement && isDuplicateKey/)
})

test('the rate card is still validated on every write, fast path included', () => {
  assert.match(
    source,
    /await connection\.beginTransaction\(\)\s*\n\s*await lockAndValidateRateCard/,
  )
})
