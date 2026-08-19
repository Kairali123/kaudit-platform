import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import type { Pool } from 'mysql2/promise'
import {
  MAX_REQUESTED_PERIODS,
  collectPeriodAmounts,
  collectRevenueSnapshots,
  providerPeriodTotalsSql,
  validateRequestedPeriods,
  type RequestedPeriod,
} from './mysqlFullDashboard.ts'

/**
 * Revenue snapshot amounts.
 *
 * The statements are executed for real by the in-process SQLite engine over
 * synthetic tables, so period scoping, latest-revision selection, the sums and
 * the invoice preference are PROVEN rather than asserted as SQL text. A
 * recording pool wrapped around that engine additionally captures every
 * statement and every parameter, which is how the read-only, parameterized and
 * bounded-result claims are checked.
 *
 * Every fixture here is SYNTHETIC. No real call, amount, invoice, vendor,
 * identity or secret appears in this file. Nothing creates, reads, writes or
 * locks an external source table, and no statement leaves this process.
 */

// ---------------------------------------------------------------------------
// Synthetic database
// ---------------------------------------------------------------------------

const SCHEMA = `
  CREATE TABLE kaudit_call (
    id TEXT PRIMARY KEY,
    billing_period_date TEXT
  );
  CREATE TABLE kaudit_billing_calculation (
    id TEXT PRIMARY KEY,
    call_id TEXT NOT NULL,
    total_amount TEXT,
    currency TEXT,
    calculated_at TEXT
  );
  CREATE TABLE kaudit_provider_cost (
    id TEXT PRIMARY KEY,
    call_id TEXT NOT NULL,
    provider_sku TEXT NOT NULL,
    minutes_decimal TEXT,
    quantity_decimal TEXT,
    is_final INTEGER NOT NULL DEFAULT 1
  );
  CREATE TABLE kaudit_billing_component_result (
    id TEXT PRIMARY KEY,
    rule_code TEXT NOT NULL,
    unit_rate TEXT
  );
  CREATE TABLE kaudit_invoice (
    id TEXT PRIMARY KEY,
    period_start TEXT NOT NULL,
    period_end TEXT NOT NULL,
    subtotal_amount TEXT,
    currency TEXT,
    revision_no INTEGER NOT NULL,
    created_at TEXT
  );
`

interface SyntheticCall {
  id: string
  billingPeriodDate: string | null
}

interface SyntheticCalculation {
  id: string
  callId: string
  totalAmount: string | null
  currency?: string | null
  calculatedAt: string
}

interface SyntheticProviderCost {
  id: string
  callId: string
  minutesDecimal: string | null
  quantityDecimal?: string | null
  providerSku?: string
}

interface SyntheticInvoice {
  id: string
  periodStart: string
  periodEnd: string
  subtotalAmount: string | null
  currency?: string | null
  revisionNo: number
  createdAt: string
}

interface Fixture {
  calls?: SyntheticCall[]
  calculations?: SyntheticCalculation[]
  providerCosts?: SyntheticProviderCost[]
  invoices?: SyntheticInvoice[]
  /** The PER_MINUTE_CEIL unit rate, or null for a platform with none. */
  perMinuteRate?: string | null
}

interface Statement {
  sql: string
  params: unknown[]
}

interface Harness {
  pool: Pool
  statements: Statement[]
  /** The rows each statement returned, in statement order. */
  results: Record<string, unknown>[][]
  close(): void
}

/** The contract rate the fixtures value provider minutes at. Synthetic. */
const SYNTHETIC_RATE = '9.50000000'

function syntheticHarness(fixture: Fixture): Harness {
  const db = new DatabaseSync(':memory:')
  db.exec(SCHEMA)
  for (const call of fixture.calls ?? []) {
    db.prepare(
      `INSERT INTO kaudit_call (id, billing_period_date) VALUES (?, ?)`,
    ).run(call.id, call.billingPeriodDate)
  }
  for (const calculation of fixture.calculations ?? []) {
    db.prepare(
      `INSERT INTO kaudit_billing_calculation
         (id, call_id, total_amount, currency, calculated_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(
      calculation.id,
      calculation.callId,
      calculation.totalAmount,
      calculation.currency === undefined ? 'INR' : calculation.currency,
      calculation.calculatedAt,
    )
  }
  for (const cost of fixture.providerCosts ?? []) {
    db.prepare(
      `INSERT INTO kaudit_provider_cost
         (id, call_id, provider_sku, minutes_decimal,
          quantity_decimal, is_final)
       VALUES (?, ?, ?, ?, ?, 1)`,
    ).run(
      cost.id,
      cost.callId,
      cost.providerSku ?? 'vendor_asserted_billed_minutes',
      cost.minutesDecimal,
      cost.quantityDecimal ?? null,
    )
  }
  for (const invoice of fixture.invoices ?? []) {
    db.prepare(
      `INSERT INTO kaudit_invoice
         (id, period_start, period_end, subtotal_amount, currency,
          revision_no, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      invoice.id,
      invoice.periodStart,
      invoice.periodEnd,
      invoice.subtotalAmount,
      invoice.currency === undefined ? 'INR' : invoice.currency,
      invoice.revisionNo,
      invoice.createdAt,
    )
  }
  const rate =
    fixture.perMinuteRate === undefined ? SYNTHETIC_RATE : fixture.perMinuteRate
  if (rate != null) {
    db.prepare(
      `INSERT INTO kaudit_billing_component_result (id, rule_code, unit_rate)
       VALUES ('component-synthetic-1', 'PER_MINUTE_CEIL', ?)`,
    ).run(rate)
  }

  const statements: Statement[] = []
  const results: Record<string, unknown>[][] = []
  const failures: unknown[] = []
  const pool = {
    async query(sql: string, params: unknown[] = []) {
      statements.push({ sql, params })
      try {
        // STRAIGHT_JOIN is MySQL's join-order control. SQLite's equivalent
        // execution here uses ordinary JOIN over the same synthetic relations.
        const executable = sql.replaceAll('STRAIGHT_JOIN', 'JOIN')
        const rows = db.prepare(executable).all(
          ...(params as string[]),
        ) as Record<string, unknown>[]
        results.push(rows)
        return [rows]
      } catch (error) {
        // The adapter answers a broken statement with "unavailable", so a
        // silent failure would look like a legitimately empty period. Keep it
        // and re-raise it from the assertion helper instead.
        failures.push(error)
        throw error
      }
    },
    async execute() {
      throw new Error('revenue snapshots issue SELECTs only')
    },
  } as unknown as Pool

  return {
    pool,
    statements,
    results,
    close() {
      db.close()
      if (failures.length > 0) throw failures[0]
    },
  }
}

const AUGUST: RequestedPeriod = {
  key: 'monthly:current',
  start: '2026-08-01',
  end: '2026-08-31',
}
const JULY: RequestedPeriod = {
  key: 'monthly:prior',
  start: '2026-07-01',
  end: '2026-07-31',
}

async function amountsOf(fixture: Fixture, periods: RequestedPeriod[]) {
  const harness = syntheticHarness(fixture)
  const amounts = await collectPeriodAmounts(harness.pool, periods)
  harness.close()
  return { amounts, statements: harness.statements, results: harness.results }
}

// ---------------------------------------------------------------------------
// Scoping: what the database is asked for
// ---------------------------------------------------------------------------

test('a selected month reads only that month and its prior month', async () => {
  const harness = syntheticHarness({
    calls: [
      { id: 'call-1', billingPeriodDate: '2026-08-04' },
      { id: 'call-2', billingPeriodDate: '2026-07-04' },
      { id: 'call-3', billingPeriodDate: '2026-09-04' },
      { id: 'call-4', billingPeriodDate: null },
    ],
    calculations: [
      {
        id: 'calc-1',
        callId: 'call-1',
        totalAmount: '20.50000000',
        calculatedAt: '2026-08-05 00:00:00',
      },
      {
        id: 'calc-2',
        callId: 'call-2',
        totalAmount: '11.25000000',
        calculatedAt: '2026-07-05 00:00:00',
      },
      {
        id: 'calc-3',
        callId: 'call-3',
        totalAmount: '900.00000000',
        calculatedAt: '2026-09-05 00:00:00',
      },
      {
        id: 'calc-4',
        callId: 'call-4',
        totalAmount: '800.00000000',
        calculatedAt: '2026-08-06 00:00:00',
      },
    ],
  })
  const snapshots = await collectRevenueSnapshots(harness.pool, {
    month: '2026-08',
    start: '2026-08-01',
    end: '2026-08-31',
    label: 'August 2026',
  })
  harness.close()

  assert.equal(snapshots.length, 1)
  assert.equal(snapshots[0].verified, '20.5')
  assert.equal(snapshots[0].priorVerified, '11.25')

  // Four bounded reads, and the only periods named are the two requested ones.
  assert.equal(harness.statements.length, 4)
  const periodParams = harness.statements
    .map((statement) => statement.params)
    .filter((params) => params.length > 0)
  assert.equal(periodParams.length, 3)
  for (const params of periodParams) {
    assert.deepEqual(params, [
      'monthly:current',
      '2026-08-01',
      '2026-08-31',
      'monthly:prior',
      '2026-07-01',
      '2026-07-31',
    ])
  }
  // Every row of every result belongs to a requested period, and no read
  // returns more than one row per requested period.
  for (const rows of harness.results) {
    assert.ok(rows.length <= 2)
    for (const row of rows) {
      if (!('period_key' in row)) continue
      assert.ok(
        row.period_key === 'monthly:current' || row.period_key === 'monthly:prior',
        `unexpected period ${String(row.period_key)}`,
      )
    }
  }
})

test('overlapping requested periods each receive their own calls', async () => {
  const week: RequestedPeriod = {
    key: 'weekly:current',
    start: '2026-08-03',
    end: '2026-08-09',
  }
  const { amounts, results } = await amountsOf(
    {
      calls: [
        // Inside BOTH the week and the month.
        { id: 'call-1', billingPeriodDate: '2026-08-05' },
        // Inside the month only.
        { id: 'call-2', billingPeriodDate: '2026-08-20' },
      ],
      calculations: [
        {
          id: 'calc-1',
          callId: 'call-1',
          totalAmount: '10.00000000',
          calculatedAt: '2026-08-06 00:00:00',
        },
        {
          id: 'calc-2',
          callId: 'call-2',
          totalAmount: '20.00000000',
          calculatedAt: '2026-08-21 00:00:00',
        },
      ],
      providerCosts: [
        { id: 'cost-1', callId: 'call-1', minutesDecimal: '2.00000000' },
        { id: 'cost-2', callId: 'call-2', minutesDecimal: '4.00000000' },
      ],
    },
    [week, AUGUST],
  )

  // The shared call contributes in full to each period, and exactly once to
  // each: no double count in the month, nothing missing from the week.
  assert.equal(amounts.get('weekly:current')?.verified, '10')
  assert.equal(amounts.get('monthly:current')?.verified, '30')
  assert.equal(amounts.get('weekly:current')?.providerClaimed, '19')
  assert.equal(amounts.get('monthly:current')?.providerClaimed, '57')
  for (const rows of results) assert.ok(rows.length <= 2)
})

// ---------------------------------------------------------------------------
// Latest calculation, and independent facts
// ---------------------------------------------------------------------------

test('several calculations for one call yield the latest exactly once', async () => {
  const { amounts, results } = await amountsOf(
    {
      calls: [{ id: 'call-1', billingPeriodDate: '2026-08-04' }],
      calculations: [
        {
          id: 'calc-a',
          callId: 'call-1',
          totalAmount: '1.00000000',
          calculatedAt: '2026-08-05 00:00:00',
        },
        // Same instant as the winner: the id breaks the tie, descending.
        {
          id: 'calc-b',
          callId: 'call-1',
          totalAmount: '2.00000000',
          calculatedAt: '2026-08-09 00:00:00',
        },
        {
          id: 'calc-c',
          callId: 'call-1',
          totalAmount: '4.25000000',
          calculatedAt: '2026-08-09 00:00:00',
        },
      ],
    },
    [AUGUST],
  )

  assert.equal(amounts.get('monthly:current')?.verified, '4.25')
  assert.equal(results[0].length, 1)
})

test('provider cost rows are not multiplied by a call’s calculations', async () => {
  const { amounts } = await amountsOf(
    {
      calls: [{ id: 'call-1', billingPeriodDate: '2026-08-04' }],
      calculations: [
        {
          id: 'calc-a',
          callId: 'call-1',
          totalAmount: '5.00000000',
          calculatedAt: '2026-08-05 00:00:00',
        },
        {
          id: 'calc-b',
          callId: 'call-1',
          totalAmount: '7.50000000',
          calculatedAt: '2026-08-06 00:00:00',
        },
      ],
      providerCosts: [
        { id: 'cost-1', callId: 'call-1', minutesDecimal: '1.00000000' },
        { id: 'cost-2', callId: 'call-1', minutesDecimal: '0.50000000' },
        // Neither the other SKU nor the unrecorded minutes are this basis.
        {
          id: 'cost-3',
          callId: 'call-1',
          minutesDecimal: '99.00000000',
          providerSku: 'vendor_asserted_setup_fee',
        },
        { id: 'cost-4', callId: 'call-1', minutesDecimal: null },
      ],
    },
    [AUGUST],
  )

  // Two calculations and two costed rows: 1.5 minutes, not 3.
  assert.equal(amounts.get('monthly:current')?.verified, '7.5')
  assert.equal(amounts.get('monthly:current')?.providerClaimed, '14.25')
})

test('provider amount wins per call and blank amounts retain the rate fallback', async () => {
  const { amounts } = await amountsOf(
    {
      calls: [
        { id: 'call-amount', billingPeriodDate: '2026-08-04' },
        { id: 'call-fallback', billingPeriodDate: '2026-08-05' },
      ],
      providerCosts: [
        {
          id: 'minutes-amount',
          callId: 'call-amount',
          minutesDecimal: '1.00000000',
        },
        {
          id: 'actual-amount',
          callId: 'call-amount',
          providerSku: 'vendor_asserted_billed_amount',
          minutesDecimal: null,
          quantityDecimal: '12.00000000',
        },
        {
          id: 'minutes-fallback',
          callId: 'call-fallback',
          minutesDecimal: '1.00000000',
        },
      ],
    },
    [AUGUST],
  )
  assert.equal(amounts.get('monthly:current')?.providerClaimed, '21.5')
})

// ---------------------------------------------------------------------------
// Invoices
// ---------------------------------------------------------------------------

test('the latest invoice revision wins and its subtotal is preferred', async () => {
  const harness = syntheticHarness({
    calls: [{ id: 'call-1', billingPeriodDate: '2026-08-04' }],
    calculations: [
      {
        id: 'calc-1',
        callId: 'call-1',
        totalAmount: '100.00000000',
        calculatedAt: '2026-08-05 00:00:00',
      },
    ],
    providerCosts: [
      { id: 'cost-1', callId: 'call-1', minutesDecimal: '20.00000000' },
    ],
    invoices: [
      {
        id: 'invoice-1',
        periodStart: '2026-08-01',
        periodEnd: '2026-08-31',
        subtotalAmount: '111.00000000',
        revisionNo: 1,
        createdAt: '2026-09-01 00:00:00',
      },
      {
        id: 'invoice-2',
        periodStart: '2026-08-01',
        periodEnd: '2026-08-31',
        subtotalAmount: '222.00000000',
        revisionNo: 2,
        createdAt: '2026-09-02 00:00:00',
      },
      // A neighbouring month's invoice never covers this period.
      {
        id: 'invoice-3',
        periodStart: '2026-09-01',
        periodEnd: '2026-09-30',
        subtotalAmount: '999.00000000',
        revisionNo: 9,
        createdAt: '2026-10-01 00:00:00',
      },
    ],
  })
  const snapshots = await collectRevenueSnapshots(harness.pool, {
    month: '2026-08',
    start: '2026-08-01',
    end: '2026-08-31',
    label: 'August 2026',
  })
  harness.close()

  // The invoice outranks the provider's own claim of 20 x 9.5 = 190.
  assert.equal(snapshots[0].vendorClaimed, '222.00000000')
  assert.equal(snapshots[0].vendorClaimedBasis, 'invoiced')
  assert.equal(snapshots[0].verified, '100')
})

test('the provider claim stands in only when the period has no invoice', async () => {
  const harness = syntheticHarness({
    calls: [{ id: 'call-1', billingPeriodDate: '2026-08-04' }],
    providerCosts: [
      { id: 'cost-1', callId: 'call-1', minutesDecimal: '3.00000000' },
    ],
  })
  const snapshots = await collectRevenueSnapshots(harness.pool, {
    month: '2026-08',
    start: '2026-08-01',
    end: '2026-08-31',
    label: 'August 2026',
  })
  harness.close()

  assert.equal(snapshots[0].vendorClaimed, '28.5')
  assert.equal(snapshots[0].vendorClaimedBasis, 'provider_claimed_no_invoice')
  assert.equal(snapshots[0].verified, null)
})

// ---------------------------------------------------------------------------
// Absence, money and currency
// ---------------------------------------------------------------------------

test('an amount nobody recorded stays unavailable, never zero', async () => {
  const harness = syntheticHarness({})
  const snapshots = await collectRevenueSnapshots(harness.pool, {
    month: '2026-08',
    start: '2026-08-01',
    end: '2026-08-31',
    label: 'August 2026',
  })
  harness.close()

  assert.deepEqual(
    {
      verified: snapshots[0].verified,
      vendorClaimed: snapshots[0].vendorClaimed,
      basis: snapshots[0].vendorClaimedBasis,
      priorVerified: snapshots[0].priorVerified,
      priorVendorClaimed: snapshots[0].priorVendorClaimed,
      currency: snapshots[0].currency,
    },
    {
      verified: null,
      vendorClaimed: null,
      basis: 'unavailable',
      priorVerified: null,
      priorVendorClaimed: null,
      currency: 'INR',
    },
  )
})

test('minutes without a rate cannot become a claim', async () => {
  const { amounts } = await amountsOf(
    {
      calls: [{ id: 'call-1', billingPeriodDate: '2026-08-04' }],
      providerCosts: [
        { id: 'cost-1', callId: 'call-1', minutesDecimal: '3.00000000' },
      ],
      perMinuteRate: null,
    },
    [AUGUST],
  )

  assert.equal(amounts.get('monthly:current')?.providerClaimed, null)
})

test('money keeps fixed precision through the aggregate', async () => {
  const { amounts } = await amountsOf(
    {
      calls: [
        { id: 'call-1', billingPeriodDate: '2026-08-04' },
        { id: 'call-2', billingPeriodDate: '2026-08-05' },
        { id: 'call-3', billingPeriodDate: '2026-08-06' },
      ],
      calculations: [
        {
          id: 'calc-1',
          callId: 'call-1',
          totalAmount: '0.12500000',
          calculatedAt: '2026-08-07 00:00:00',
        },
        {
          id: 'calc-2',
          callId: 'call-2',
          totalAmount: '10.25000000',
          calculatedAt: '2026-08-07 00:00:00',
        },
        // A calculation with no amount contributes nothing.
        {
          id: 'calc-3',
          callId: 'call-3',
          totalAmount: null,
          calculatedAt: '2026-08-07 00:00:00',
        },
      ],
      providerCosts: [
        { id: 'cost-1', callId: 'call-1', minutesDecimal: '0.10000000' },
        { id: 'cost-2', callId: 'call-2', minutesDecimal: '0.20000000' },
      ],
      invoices: [
        {
          id: 'invoice-1',
          periodStart: '2026-08-01',
          periodEnd: '2026-08-31',
          subtotalAmount: '12.34500000',
          revisionNo: 1,
          createdAt: '2026-09-01 00:00:00',
        },
      ],
    },
    [AUGUST],
  )
  const august = amounts.get('monthly:current')

  assert.equal(august?.verified, '10.375')
  // 0.3 minutes at 9.5 per minute, in exact fixed-point arithmetic.
  assert.equal(august?.providerClaimed, '2.85')
  // The invoice subtotal is passed through as the database stated it.
  assert.equal(august?.invoiceSubtotal, '12.34500000')
})

test('currency follows the invoice, then the calculation, then INR', async () => {
  const invoiced = await amountsOf(
    {
      calls: [{ id: 'call-1', billingPeriodDate: '2026-08-04' }],
      calculations: [
        {
          id: 'calc-1',
          callId: 'call-1',
          totalAmount: '1.00000000',
          currency: 'USD',
          calculatedAt: '2026-08-05 00:00:00',
        },
      ],
      invoices: [
        {
          id: 'invoice-1',
          periodStart: '2026-08-01',
          periodEnd: '2026-08-31',
          subtotalAmount: '1.00000000',
          currency: 'AED',
          revisionNo: 1,
          createdAt: '2026-09-01 00:00:00',
        },
      ],
    },
    [AUGUST],
  )
  assert.equal(invoiced.amounts.get('monthly:current')?.currency, 'AED')

  const calculated = await amountsOf(
    {
      calls: [{ id: 'call-1', billingPeriodDate: '2026-08-04' }],
      calculations: [
        {
          id: 'calc-1',
          callId: 'call-1',
          totalAmount: '1.00000000',
          currency: 'USD',
          calculatedAt: '2026-08-05 00:00:00',
        },
      ],
    },
    [AUGUST],
  )
  assert.equal(calculated.amounts.get('monthly:current')?.currency, 'USD')

  const empty = await amountsOf({}, [AUGUST])
  assert.equal(empty.amounts.get('monthly:current')?.currency, 'INR')
})

// ---------------------------------------------------------------------------
// The statements themselves
// ---------------------------------------------------------------------------

const ALLOWED_RELATIONS = new Set([
  'kaudit_call',
  'kaudit_billing_calculation',
  'kaudit_provider_cost',
  'kaudit_billing_component_result',
  'kaudit_invoice',
  'requested_period',
  'period_call',
  'scoped_calculation',
  'provider_claim',
  'provider_period_total',
  'scoped_invoice',
])

test('provider totals start from provider cost and fix the production join order', async () => {
  const sql = providerPeriodTotalsSql(2)
  assert.match(
    sql,
    /FROM provider_claim claim\s+STRAIGHT_JOIN kaudit_call c/,
  )
  assert.match(sql, /FROM kaudit_provider_cost cost/)
  assert.doesNotMatch(sql, /cost\.call_id IN \(SELECT call_id FROM period_call\)/)
})

test('the reads are parameterized, read-only aggregates over kaudit tables', async () => {
  const { statements, results } = await amountsOf(
    {
      calls: [{ id: 'call-1', billingPeriodDate: '2026-08-04' }],
      calculations: [
        {
          id: 'calc-1',
          callId: 'call-1',
          totalAmount: '1.00000000',
          calculatedAt: '2026-08-05 00:00:00',
        },
      ],
      providerCosts: [
        { id: 'cost-1', callId: 'call-1', minutesDecimal: '1.00000000' },
      ],
      invoices: [
        {
          id: 'invoice-1',
          periodStart: '2026-08-01',
          periodEnd: '2026-08-31',
          subtotalAmount: '1.00000000',
          revisionNo: 1,
          createdAt: '2026-09-01 00:00:00',
        },
      ],
    },
    [AUGUST, JULY],
  )

  for (const { sql, params } of statements) {
    assert.match(sql, /^(SELECT|WITH)\b/)
    assert.doesNotMatch(
      sql,
      /\b(INSERT|UPDATE|DELETE|REPLACE|CREATE|ALTER|DROP|TRUNCATE|GRANT)\b/i,
    )
    assert.doesNotMatch(sql, /FOR UPDATE|LOCK IN SHARE|LOCK TABLES/i)
    // Nothing outside the audit platform's own tables is named or read.
    assert.doesNotMatch(sql, /ai_voice_leads_received/)
    for (const [, relation] of sql.matchAll(/\b(?:FROM|JOIN)\s+([a-z_]+)/g)) {
      assert.ok(
        ALLOWED_RELATIONS.has(relation),
        `unexpected relation ${relation}`,
      )
    }
    // Caller values are bound, never written into the statement.
    assert.equal((sql.match(/\?/g) ?? []).length, params.length)
    assert.doesNotMatch(sql, /\d{4}-\d{2}-\d{2}/)
    assert.doesNotMatch(sql, /monthly:/)
  }

  // Not one call id, invoice id or calculation id crosses into Node.
  for (const rows of results) {
    for (const row of rows) {
      assert.deepEqual(
        Object.keys(row).filter((column) => /(^|_)id$/.test(column)),
        [],
      )
    }
  }
  // Only the two requested keys come back, at most once per read each.
  const requested = new Set(['monthly:current', 'monthly:prior'])
  for (const rows of results) {
    const keys = rows
      .filter((row) => 'period_key' in row)
      .map((row) => String(row.period_key))
    assert.equal(new Set(keys).size, keys.length)
    for (const key of keys) assert.ok(requested.has(key), `stray period ${key}`)
  }
  assert.deepEqual(
    results.map((rows) => rows.length),
    [1, 1, 1, 1],
  )
})

test('query count and returned rows stay constant as the tables grow', async () => {
  const fixtureOf = (calls: number): Fixture => ({
    calls: Array.from({ length: calls }, (_unused, index) => ({
      id: `call-${index}`,
      // Half the calls land in the requested month, half outside it.
      billingPeriodDate: index % 2 === 0 ? '2026-08-04' : '2026-05-04',
    })),
    calculations: Array.from({ length: calls }, (_unused, index) => ({
      id: `calc-${index}`,
      callId: `call-${index}`,
      totalAmount: '1.25000000',
      calculatedAt: '2026-08-05 00:00:00',
    })),
    providerCosts: Array.from({ length: calls }, (_unused, index) => ({
      id: `cost-${index}`,
      callId: `call-${index}`,
      minutesDecimal: '1.00000000',
    })),
  })

  const small = await amountsOf(fixtureOf(4), [AUGUST, JULY])
  const large = await amountsOf(fixtureOf(400), [AUGUST, JULY])

  assert.equal(small.statements.length, 4)
  assert.equal(large.statements.length, 4)
  assert.deepEqual(
    small.statements.map((statement) => statement.sql),
    large.statements.map((statement) => statement.sql),
  )
  // A hundredfold table returns the same rows, with different totals in them.
  assert.deepEqual(
    small.results.map((rows) => rows.length),
    large.results.map((rows) => rows.length),
  )
  for (const rows of large.results) assert.ok(rows.length <= 2)
  assert.equal(small.amounts.get('monthly:current')?.verified, '2.5')
  assert.equal(large.amounts.get('monthly:current')?.verified, '250')
  assert.equal(large.amounts.get('monthly:prior')?.verified, null)
})

// ---------------------------------------------------------------------------
// The bound on what may be asked for
// ---------------------------------------------------------------------------

test('the requested periods are bounded and checked before any read', async () => {
  const nine = Array.from({ length: MAX_REQUESTED_PERIODS + 1 }, (_u, index) => ({
    key: `cadence${'x'.repeat(index)}:current`,
    start: '2026-08-01',
    end: '2026-08-31',
  }))
  const harness = syntheticHarness({})

  await assert.rejects(
    () => collectPeriodAmounts(harness.pool, nine),
    RangeError,
  )
  await assert.rejects(() => collectPeriodAmounts(harness.pool, []), RangeError)
  // Nothing reached the database.
  assert.equal(harness.statements.length, 0)
  harness.close()

  assert.throws(
    () => validateRequestedPeriods([{ ...AUGUST, start: '2026-08' }]),
    RangeError,
  )
  assert.throws(
    () => validateRequestedPeriods([{ ...AUGUST, key: 'DROP TABLE' }]),
    RangeError,
  )
  assert.throws(
    () => validateRequestedPeriods([{ ...AUGUST, start: '2026-09-01' }]),
    RangeError,
  )
  assert.throws(
    () => validateRequestedPeriods([AUGUST, AUGUST]),
    RangeError,
  )
  assert.equal(validateRequestedPeriods([AUGUST, JULY]).length, 2)
})

test('every cadence card is still served by the same four reads', async () => {
  const harness = syntheticHarness({
    calls: [{ id: 'call-1', billingPeriodDate: '2026-08-04' }],
  })
  const snapshots = await collectRevenueSnapshots(harness.pool)
  harness.close()

  assert.equal(snapshots.length, 4)
  assert.equal(harness.statements.length, 4)
  // Four cadences, each with its prior period: the maximum the bound allows.
  const requestedKeys = harness.statements
    .map((statement) => statement.params)
    .find((params) => params.length > 0)
    ?.filter((_unused, index) => index % 3 === 0)
  assert.equal(requestedKeys?.length, MAX_REQUESTED_PERIODS)
  for (const rows of harness.results) {
    assert.ok(rows.length <= MAX_REQUESTED_PERIODS)
  }
})
