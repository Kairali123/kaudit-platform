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
