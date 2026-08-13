import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  CALL_AUDIT_SPEND_SKIP_CODES,
  CALL_AUDIT_SPEND_SKIP_CODE_VALUES,
  isCallAuditSpendSkipCode,
} from './spendClaim.ts'

/**
 * Contract test for the spend-claim port. Nothing here reaches a database, a
 * model, or a clock: the module is types and closed codes only.
 */

const MODULE_SOURCE = readFileSync(
  new URL('./spendClaim.ts', import.meta.url),
  'utf8',
)

/**
 * The module with every comment removed. Prose is allowed — and expected — to
 * NAME the switches this contract refuses to have; only the code is asserted
 * not to have them.
 */
const MODULE_CODE = MODULE_SOURCE.replace(/\/\*[\s\S]*?\*\//g, '').replace(
  /^\s*\/\/.*$/gm,
  '',
)

test('the skip codes are closed, distinct, and storable as machine codes', () => {
  assert.deepEqual(CALL_AUDIT_SPEND_SKIP_CODE_VALUES, [
    CALL_AUDIT_SPEND_SKIP_CODES.priorResult,
    CALL_AUDIT_SPEND_SKIP_CODES.priorClaim,
  ])
  assert.equal(new Set(CALL_AUDIT_SPEND_SKIP_CODE_VALUES).size, 2)
  for (const code of CALL_AUDIT_SPEND_SKIP_CODE_VALUES) {
    // The same grammar the result `error_code` column accepts, so a refusal is
    // always recordable and never has to be softened into something else.
    assert.match(code, /^[A-Z][A-Z0-9_]*$/)
    assert.ok(code.length <= 80)
  }
})

test('the code list is frozen, so a caller cannot widen it at runtime', () => {
  assert.ok(Object.isFrozen(CALL_AUDIT_SPEND_SKIP_CODE_VALUES))
})

test('only a defined code is recognised as a skip code', () => {
  for (const code of CALL_AUDIT_SPEND_SKIP_CODE_VALUES) {
    assert.equal(isCallAuditSpendSkipCode(code), true)
  }
  for (const value of [
    'CALL_AUDIT_ALLOW_RESPEND',
    'call_audit_duplicate_prior_claim',
    '',
    null,
    undefined,
    42,
    {},
  ]) {
    assert.equal(isCallAuditSpendSkipCode(value), false)
  }
})

test('the contract offers no outcome that grants a second spend', () => {
  // `claimed` is granted at most once per revision; every other outcome is a
  // refusal. A third, permissive outcome would repeal the guarantee for every
  // caller at once, so its absence is asserted rather than assumed.
  for (const forbidden of [
    /force/i,
    /override/i,
    /re_?audit/i,
    /bypass/i,
    /allow_?re?spend/i,
    /'granted_again'|'reclaimed'|'released'/i,
  ]) {
    assert.equal(
      forbidden.test(MODULE_CODE),
      false,
      `spendClaim.ts must not contain ${forbidden}`,
    )
  }
  // Exactly two outcome literals in the result union.
  const outcomes = [...MODULE_CODE.matchAll(/outcome: '([a-z_]+)'/g)].map(
    (match) => match[1],
  )
  assert.deepEqual([...new Set(outcomes)].sort(), ['claimed', 'duplicate'])
})

test('the module holds no SQL, no clock, no logging, and nothing content-bearing', () => {
  for (const forbidden of [
    /INSERT\s+INTO/i,
    /\bSELECT\s/i,
    /\bkaudit_/,
    /ai_voice_leads_received/,
    /console\./,
    /process\.env/,
    /Date\.now|new Date\(/,
    /\btranscript\b(?!s)/,
  ]) {
    assert.equal(
      forbidden.test(MODULE_CODE),
      false,
      `must not contain ${forbidden}`,
    )
  }
})
