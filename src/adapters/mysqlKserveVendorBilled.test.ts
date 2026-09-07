import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { Pool } from 'mysql2/promise'
import {
  KSERVE_VENDOR_RATE_PER_MINUTE,
  MONTHLY_KSERVE_BILLED_CHARGE_SQL,
  VENDOR_BILLED_AMOUNT_SQL,
  VENDOR_BILLED_MINUTES_SQL,
  createMysqlKserveVendorBilledRepository,
  toMonthlyKserveBilledCharge,
  vendorBilledAssertionsSql,
} from './mysqlKserveVendorBilled.ts'
import { KSERVE_RULESET_DOCUMENT } from '../billing/kserveRules.ts'

/**
 * The shared KServe vendor-billed read model.
 *
 * The point of this module is that ONE definition of "what KServe billed"
 * serves the settlement page, the category analysis, and the monthly report, so
 * these tests pin the definition itself rather than any one caller. Every row
 * below is synthetic and no database is opened.
 */

test('the SQL rate is the rate from the locked KServe ruleset', () => {
  // Same number, stated in the form each side needs: the ruleset carries eight
  // decimal places, the statement carries the literal MySQL multiplies by.
  assert.equal(
    Number(KSERVE_VENDOR_RATE_PER_MINUTE),
    Number(KSERVE_RULESET_DOCUMENT.ratePerMinute),
  )
  assert.equal(KSERVE_RULESET_DOCUMENT.currency, 'INR')
})

test('the basis is the vendor’s own final billed-minute evidence', () => {
  assert.match(
    VENDOR_BILLED_MINUTES_SQL,
    /provider_sku = 'vendor_asserted_billed_minutes'/,
  )
  assert.match(VENDOR_BILLED_MINUTES_SQL, /cost\.is_final = 1/)
  // MAX, not SUM: several final rows for one call are revisions of the same
  // assertion, and summing them would inflate the vendor's own claim.
  assert.match(VENDOR_BILLED_MINUTES_SQL, /MAX\(cost\.minutes_decimal\)/)
})

test('the supplied billed amount takes priority with a legacy rate fallback', () => {
  assert.match(
    VENDOR_BILLED_AMOUNT_SQL,
    /provider_sku = 'vendor_asserted_billed_amount'/,
  )
  assert.match(VENDOR_BILLED_AMOUNT_SQL, /cost\.is_final = 1/)
  // Both assertions now come from one pass, so the supplied amount and the
  // rate fallback read off the same row rather than a separate join.
  assert.match(
    MONTHLY_KSERVE_BILLED_CHARGE_SQL,
    /COALESCE\(\s*vendor\.amount_decimal,\s*vendor\.minutes_decimal \*/,
  )
})

test('the combined assertion read keeps both claims in one cost pass', () => {
  const sql = vendorBilledAssertionsSql(
    'JOIN scoped_calls ON scoped_calls.id = cost.call_id',
  )
  assert.equal(sql.match(/FROM kaudit_provider_cost/g)?.length, 1)
  assert.match(sql, /vendor_asserted_billed_minutes/)
  assert.match(sql, /vendor_asserted_billed_amount/)
  assert.match(sql, /JOIN scoped_calls/)
  assert.match(sql, /cost\.is_final = 1/)
})

test('the month query covers the whole month, not only audited calls', () => {
  assert.match(
    MONTHLY_KSERVE_BILLED_CHARGE_SQL,
    /scoped_call\.billing_period_date BETWEEN \? AND \?/,
  )
  // No audited-evidence join: restricting to audited calls would make savings
  // grow as the audit fell behind.
  for (const forbidden of [
    'kaudit_media_analysis',
    'kaudit_transcript',
    'kaudit_billing_calculation',
    'canonical_outcome_code',
  ]) {
    assert.equal(
      MONTHLY_KSERVE_BILLED_CHARGE_SQL.includes(forbidden),
      false,
      forbidden,
    )
  }
  // Decimals are read as text so the driver cannot hand back a float.
  assert.match(MONTHLY_KSERVE_BILLED_CHARGE_SQL, /CAST\(SUM\(/)
})

test('the category analysis uses the shared one-pass assertion definition', () => {
  const category = readFileSync(
    fileURLToPath(
      new URL('./mysqlBillingCategoryAnalysis.ts', import.meta.url),
    ),
    'utf8',
  )
  assert.match(
    category,
    /import \{[\s\S]*?KSERVE_VENDOR_RATE_PER_MINUTE,[\s\S]*?vendorBilledAssertionsSql,[\s\S]*?\} from '\.\/mysqlKserveVendorBilled\.ts'/,
  )
  // The definition exists once. A second copy is what drift is made of.
  assert.equal(
    category.includes("provider_sku = 'vendor_asserted_billed_minutes'"),
    false,
  )
})

test('never reads, writes, or locks the external source table', () => {
  const source = readFileSync(
    fileURLToPath(new URL('./mysqlKserveVendorBilled.ts', import.meta.url)),
    'utf8',
  )
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('//'))
    .join('\n')
  assert.equal(code.includes('ai_voice_leads_received'), false)
  for (const forbidden of [
    /\bINSERT\b/,
    /\bUPDATE\b/,
    /\bDELETE\b/,
    /FOR UPDATE/,
    /\bLOCK\b/,
  ]) {
    assert.equal(forbidden.test(code), false, `module contains ${forbidden}`)
  }
})

test('a month with no billed evidence is unavailable, never a zero charge', () => {
  assert.deepEqual(toMonthlyKserveBilledCharge(undefined), {
    billedCalls: 0,
    billedMinutes: null,
    billedChargeInr: null,
  })
  assert.deepEqual(
    toMonthlyKserveBilledCharge({
      billed_calls: 0,
      billed_minutes: null,
      billed_charge_inr: null,
    } as never),
    { billedCalls: 0, billedMinutes: null, billedChargeInr: null },
  )
})

test('a billed month returns exact decimal text', () => {
  assert.deepEqual(
    toMonthlyKserveBilledCharge({
      billed_calls: '3',
      billed_minutes: '12.50000000',
      billed_charge_inr: '118.75000000',
    } as never),
    {
      billedCalls: 3,
      billedMinutes: '12.50000000',
      billedChargeInr: '118.75000000',
    },
  )
})

test('the read is one bounded statement scoped to the requested month', async () => {
  const calls: Array<{ sql: string; parameters: unknown[] }> = []
  const pool = {
    async execute(sql: string, parameters: unknown[]) {
      calls.push({ sql, parameters })
      return [
        [
          {
            billed_calls: 2,
            billed_minutes: '4.00000000',
            billed_charge_inr: '38.00000000',
          },
        ],
        [],
      ]
    },
  } as unknown as Pool
  const charge = await createMysqlKserveVendorBilledRepository(
    pool,
  ).readMonthlyBilledCharge({
    periodStart: '2026-08-01',
    periodEnd: '2026-08-31',
  })
  assert.equal(charge.billedChargeInr, '38.00000000')
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0].parameters, ['2026-08-01', '2026-08-31'])
})

test('the monthly billed charge reads one scoped pass over provider cost', () => {
  // Two earlier shapes of this read caused outages. Grouping the whole
  // provider-cost table and filtering afterwards scanned every month ever
  // ingested; scoping it but keeping two derived tables still paid for two
  // grouped scans of the same rows.
  const sql = MONTHLY_KSERVE_BILLED_CHARGE_SQL
  const passes = sql.match(/FROM kaudit_provider_cost cost/g) ?? []
  assert.equal(passes.length, 1)
  // The month drives the query rather than filtering its result.
  assert.match(
    sql,
    /JOIN kaudit_call scoped_call\s*\n\s*ON scoped_call\.id = cost\.call_id\s*\n\s*AND scoped_call\.billing_period_date BETWEEN \? AND \?/,
  )
  // Both vendor assertions come from the same rows, read together.
  assert.match(sql, /vendor_asserted_billed_minutes/)
  assert.match(sql, /vendor_asserted_billed_amount/)
  // The month is bound exactly once, so the caller's two parameters still line
  // up with the placeholders.
  assert.equal((sql.match(/\?/g) ?? []).length, 2)
})

test('a call with an asserted amount but no billed minutes is still not billed time', () => {
  // The original inner join on billed minutes carried this rule. Folding both
  // assertions into one pass could silently have dropped it, which would add
  // vendor-asserted money for calls with no evidence of billed duration.
  assert.match(
    MONTHLY_KSERVE_BILLED_CHARGE_SQL,
    /WHERE vendor\.minutes_decimal IS NOT NULL/,
  )
})
