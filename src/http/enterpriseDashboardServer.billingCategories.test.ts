import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { AddressInfo } from 'node:net'
import type { Pool } from 'mysql2/promise'
import type { AccessRepository } from '../auth/types.ts'
import type { AuditEvent, AuditSink } from '../audit/types.ts'
import type { RuntimeConfig } from '../config/runtime.ts'
import {
  createLocalPasswordHash,
  issueLocalSession,
} from '../auth/localSession.ts'
import { createEnterpriseDashboardServer } from './enterpriseDashboardServer.ts'
import type {
  BillingCategoryAnalysisPort,
  BillingCategoryCallRow,
  BillingCategoryPageScope,
  BillingCategoryScope,
} from '../adapters/mysqlBillingCategoryAnalysis.ts'

/**
 * HTTP contract of the Billing Audit category-analysis routes.
 *
 * The page is served by TWO reads — the month summary (KPIs, Issue/No issue,
 * Grand Total) and the table page (rows and its pager) — so selecting a category
 * costs a bounded page read instead of a month-wide recomputation. Both are
 * ADMINISTRATOR-ONLY on the SAME `audit:inspect` gate, which the 'user' role
 * does not hold: splitting a page for cost must never split its authorization.
 *
 * The rows stay privacy-bounded regardless — that is asserted below and is not
 * weakened by the gate.
 *
 * Both routes are backed by a SYNTHETIC in-memory read model here: no database,
 * and no real call, task id, transcript, recording, amount, or PII in any
 * fixture.
 */

const config: RuntimeConfig = {
  environment: 'test',
  host: '127.0.0.1',
  port: 4175,
  trustProxy: false,
  database: {
    host: 'synthetic',
    port: 3306,
    name: 'synthetic',
    user: 'synthetic',
    password: 'synthetic',
    tlsMode: 'required',
    sslCaFile: null,
    sslCaInline: false,
  },
  auth: {
    mode: 'local',
    email: 'operator@example.test',
    passwordHash: createLocalPasswordHash(
      'synthetic-password',
      Buffer.alloc(16, 3),
    ),
    sessionSecret: 'synthetic-session-secret-at-least-32-characters',
    sessionCookie: 'kaudit_local_session',
    sessionTtlSeconds: 3600,
  },
  releaseGates: {
    automatedValidationApproved: false,
    calibrationComplete: false,
    reportingApproved: false,
  },
}

function accessFor(roles: readonly string[]): AccessRepository {
  return {
    async findByOidc() {
      return null
    },
    async findByEmail(email) {
      return email === 'operator@example.test'
        ? {
            id: 'user-1',
            email,
            status: 'active',
            maxSensitivityTier: 'K0',
            roles: [...roles],
          }
        : null
    },
    async readiness() {
      return true
    },
  }
}

/** An administrator: holds audit:inspect. */
const adminAccess = accessFor(['admin'])
/** A plain operational user: role 'user', NOT admin, no audit:inspect. */
const operationalUserAccess = accessFor(['user'])
/** The seed default: no permission at all. */
const unassignedAccess = accessFor(['unassigned'])

function localCookie(): string {
  if (config.auth.mode !== 'local') {
    throw new Error('Synthetic local config is required')
  }
  return `${config.auth.sessionCookie}=${encodeURIComponent(
    issueLocalSession(
      config.auth.email,
      config.auth.sessionSecret,
      config.auth.sessionTtlSeconds,
    ),
  )}`
}

/**
 * Carries fields the DTO must drop, so the route is proven to copy field by
 * field rather than to spread whatever the read model happened to select.
 */
function callFixture(): BillingCategoryCallRow {
  return {
    callReference: 'SYNTHETIC-TASK-1',
    callDate: '2026-08-04',
    callStartAt: '2026-08-04 09:15:00',
    callEndAt: '2026-08-04 09:18:10',
    category: 'PRODUCT_ENQUIRY',
    kserveChargeTimeMs: 180_000,
    kserveChargeInr: '28.50000000',
    aiAuditedDurationMs: 121_000,
    aiConfidence: '0.95000000',
    aiAuditResult: 'Issue found',
    gapMs: 59_000,
    recordingAvailable: true,
    callId: 'SYNTHETIC-INTERNAL-ID-MUST-NOT-LEAK',
    sourceUrl: 'https://synthetic.invalid/must-not-leak',
    evidenceSha256: 'SYNTHETIC-HASH-MUST-NOT-LEAK',
    transcript: 'SYNTHETIC-TRANSCRIPT-MUST-NOT-LEAK',
  } as unknown as BillingCategoryCallRow
}

interface RecordedRead {
  method: string
  scope:
    | BillingCategoryScope
    | BillingCategoryPageScope
}

function syntheticReadModel(
  reads: RecordedRead[],
): BillingCategoryAnalysisPort {
  return {
    async listCategoryTotals(scope) {
      reads.push({ method: 'listCategoryTotals', scope })
      return [
        {
          category: 'PRODUCT_ENQUIRY',
          auditedCallCount: 2,
          issueFoundCount: 1,
          noIssueFoundCount: 1,
          kservePricedCalls: 2,
          kserveChargeInr: '19.00000000',
          auditorFinalPricedCalls: 1,
          auditorUnfinalizedCalls: 1,
          auditorFinalChargeInr: '9.50000000',
          kserveChargeTimeMs: 240_000,
          aiAuditedDurationMs: 181_000,
          aiAuditedDurationCalls: 2,
          comparableCalls: 2,
          gapMs: 59_000,
        },
      ]
    },
    async listNoRecordingTotals(scope) {
      reads.push({ method: 'listNoRecordingTotals', scope })
      return {
        category: 'NO_RECORDING',
        auditedCallCount: 0,
        issueFoundCount: 0,
        noIssueFoundCount: 0,
        kservePricedCalls: 0,
        kserveChargeInr: '0',
        auditorFinalPricedCalls: 0,
        auditorUnfinalizedCalls: 0,
        auditorFinalChargeInr: '0',
        kserveChargeTimeMs: 0,
        aiAuditedDurationMs: 0,
        aiAuditedDurationCalls: 0,
        comparableCalls: 0,
        gapMs: 0,
      }
    },
    async listCalls(scope) {
      reads.push({ method: 'listCalls', scope })
      return [callFixture()]
    },
  }
}

async function withServer(
  run: (
    baseUrl: string,
    state: { events: AuditEvent[]; reads: RecordedRead[] },
  ) => Promise<void>,
  options: { accessRepository?: AccessRepository } = {},
): Promise<void> {
  const events: AuditEvent[] = []
  const reads: RecordedRead[] = []
  const audit: AuditSink = {
    async record(event) {
      events.push(event)
    },
    async readiness() {
      return true
    },
  }
  const pool = {
    async query() {
      throw new Error('the synthetic read model must be used instead')
    },
    async execute() {
      throw new Error('the synthetic read model must be used instead')
    },
  } as unknown as Pool
  const server = createEnterpriseDashboardServer({
    config,
    pool,
    access: options.accessRepository ?? adminAccess,
    audit,
    verifier: null,
    billingCategoryAnalysis: syntheticReadModel(reads),
  })
  await new Promise<void>((resolve) =>
    server.listen(0, '127.0.0.1', resolve),
  )
  const address = server.address() as AddressInfo
  try {
    await run(`http://127.0.0.1:${address.port}`, { events, reads })
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    )
  }
}

function deepKeys(value: unknown, keys = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const entry of value) deepKeys(entry, keys)
  } else if (value && typeof value === 'object') {
    for (const [key, entry] of Object.entries(value)) {
      keys.add(key)
      deepKeys(entry, keys)
    }
  }
  return keys
}

const ROUTE = '/api/v1/billing/categories'
const SUMMARY_ROUTE = '/api/v1/billing/categories/summary'
const PAGE_ROUTE = '/billing/categories'

// ---------------------------------------------------------------------------
// Authorization
// ---------------------------------------------------------------------------

test('a table page is readable by an administrator', async () => {
  await withServer(async (baseUrl, state) => {
    const response = await fetch(
      `${baseUrl}${ROUTE}?month=2026-08&category=PRODUCT_ENQUIRY&page=2&pageSize=10`,
      { headers: { cookie: localCookie() } },
    )
    assert.equal(response.status, 200)
    const body = (await response.json()) as Record<string, unknown>
    assert.equal(body.title, 'Category analysis')
    const scope = body.scope as Record<string, unknown>
    assert.equal(scope.month, '2026-08')
    assert.equal(scope.category, 'PRODUCT_ENQUIRY')
    // A page performs one bounded row read and no month aggregate or count.
    assert.deepEqual(state.reads.map((read) => read.method), ['listCalls'])
    const page = state.reads.find(
      (read) => read.method === 'listCalls',
    )?.scope as BillingCategoryPageScope
    assert.deepEqual(page, {
      periodStart: '2026-08-01',
      periodEnd: '2026-08-31',
      category: 'PRODUCT_ENQUIRY',
      limit: 10,
      offset: 10,
    })
    assert.deepEqual(body.pagination, {
      page: 2,
      pageSize: 10,
    })
    // The read is access-logged under its own action.
    assert.equal(
      state.events.at(-1)?.action,
      'billing_category_analysis.read',
    )
    assert.equal(state.events.at(-1)?.outcome, 'success')
  })
})

test('the month summary is readable by an administrator and is month-scoped', async () => {
  await withServer(async (baseUrl, state) => {
    const response = await fetch(`${baseUrl}${SUMMARY_ROUTE}?month=2026-08`, {
      headers: { cookie: localCookie() },
    })
    assert.equal(response.status, 200)
    const body = (await response.json()) as Record<string, unknown>
    assert.equal(body.title, 'Category analysis')
    // Month scope only: the summary is never narrowed by a category or a page.
    const scope = body.scope as Record<string, unknown>
    assert.deepEqual(Object.keys(scope).sort(), ['month', 'monthLabel'])
    assert.equal(scope.month, '2026-08')
    // Nine selectable KPIs plus the all-categories aggregate, and the summary
    // and Grand Total the page displays around them.
    assert.equal((body.categories as unknown[]).length, 10)
    assert.ok(body.grandTotal)
    assert.ok(body.summary)
    // The summary reads month aggregates only. It never pages calls, so an
    // admin KPI read is not a second way to reach per-call references.
    assert.deepEqual(state.reads.map((read) => read.method).sort(), [
      'listCategoryTotals',
      'listNoRecordingTotals',
    ])
    for (const read of state.reads) {
      assert.deepEqual(read.scope, {
        periodStart: '2026-08-01',
        periodEnd: '2026-08-31',
      })
    }
    assert.equal(
      state.events.at(-1)?.action,
      'billing_category_summary.read',
    )
    assert.equal(state.events.at(-1)?.outcome, 'success')
  })
})

test('a non-administrator is refused both routes and the refusal is logged', async () => {
  for (const accessRepository of [
    operationalUserAccess,
    unassignedAccess,
  ]) {
    for (const [route, action] of [
      [ROUTE, 'billing_category_analysis.read'],
      [SUMMARY_ROUTE, 'billing_category_summary.read'],
    ] as const) {
      await withServer(
        async (baseUrl, state) => {
          const response = await fetch(`${baseUrl}${route}`, {
            headers: { cookie: localCookie() },
          })
          assert.equal(response.status, 403, route)
          // Nothing was read on behalf of a caller who may not read it.
          assert.deepEqual(state.reads, [])
          assert.equal(state.events.at(-1)?.action, action)
          assert.equal(state.events.at(-1)?.outcome, 'denied')
        },
        { accessRepository },
      )
    }
  }
})

test('an unauthenticated request never reaches the read model', async () => {
  for (const route of [ROUTE, SUMMARY_ROUTE]) {
    await withServer(async (baseUrl, state) => {
      const response = await fetch(`${baseUrl}${route}`)
      assert.equal(response.status, 401, route)
      assert.deepEqual(state.reads, [])
    })
  }
})

test('the page route takes the same administrator-only gate', async () => {
  await withServer(
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}${PAGE_ROUTE}`, {
        headers: { cookie: localCookie() },
      })
      assert.equal(response.status, 403)
    },
    { accessRepository: operationalUserAccess },
  )
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}${PAGE_ROUTE}`, {
      headers: { cookie: localCookie() },
    })
    // An administrator passes the gate. Whether the app bundle happens to be
    // built decides between the page and APP_NOT_BUILT; neither is a refusal.
    assert.ok(
      response.status === 200 || response.status === 503,
      `unexpected status ${response.status}`,
    )
  })
})

// ---------------------------------------------------------------------------
// Privacy boundary
// ---------------------------------------------------------------------------

test('neither response exposes evidence, identity, or raw content', async () => {
  for (const route of [ROUTE, SUMMARY_ROUTE]) {
    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}${route}?month=2026-08`, {
        headers: { cookie: localCookie() },
      })
      assert.equal(response.status, 200, route)
      const text = await response.text()
      for (const leaked of [
        'MUST-NOT-LEAK',
        'synthetic.invalid',
      ]) {
        assert.equal(
          text.includes(leaked),
          false,
          `${leaked} must not reach a browser`,
        )
      }
      const keys = deepKeys(JSON.parse(text))
      for (const forbidden of [
        'callId',
        'sourceUrl',
        'recordingUrl',
        'evidenceSha256',
        'sha256',
        'transcript',
        'segments',
        'sourceRowId',
        'leadId',
        'prompt',
        'rawResponse',
      ]) {
        assert.equal(
          keys.has(forbidden),
          false,
          `${forbidden} must not be returned by ${route}`,
        )
      }
    })
  }
})

test('the table page carries the approved per-call facts and nothing more', async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}${ROUTE}?month=2026-08`, {
      headers: { cookie: localCookie() },
    })
    const keys = deepKeys(await response.json())
    // What a row does carry: the approved reference and duration metadata.
    assert.ok(keys.has('callReference'))
    assert.ok(keys.has('recordingAvailable'))
  })
})

test('the month summary carries no per-call row at all', async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}${SUMMARY_ROUTE}?month=2026-08`, {
      headers: { cookie: localCookie() },
    })
    const keys = deepKeys(await response.json())
    for (const rowField of [
      'rows',
      'callReference',
      'recordingAvailable',
      'aiConfidence',
    ]) {
      assert.equal(keys.has(rowField), false, rowField)
    }
  })
})

test('money stays fixed-precision text on the wire', async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}${SUMMARY_ROUTE}?month=2026-08`, {
      headers: { cookie: localCookie() },
    })
    const body = (await response.json()) as {
      categories: Record<string, unknown>[]
    }
    // The KPI a tile shows IS the scope total the table footer shows, so it is
    // asserted here once rather than in two places that could drift apart. The
    // synthetic month holds one category, so the all-categories KPI carries its
    // amounts exactly.
    const kpi = body.categories.find(
      (candidate) => candidate.category === 'all',
    )!
    assert.equal(kpi.kserveChargeInr, '19.00000000')
    assert.equal(kpi.auditorFinalChargeInr, '9.50000000')
    assert.equal(kpi.auditorUnfinalizedCalls, 1)
    assert.equal(kpi.basis, 'entire_selected_scope')
    // Durations are text minutes and integer milliseconds, never money.
    assert.equal(kpi.gapMinutes, '0.98')
    assert.equal(kpi.gapMs, 59_000)
  })
})

// ---------------------------------------------------------------------------
// Request validation
// ---------------------------------------------------------------------------

test('an out-of-range or malformed request is refused with a bounded problem', async () => {
  await withServer(async (baseUrl, state) => {
    for (const search of [
      '?page=0',
      '?pageSize=5000',
      '?category=DROP%20TABLE',
    ]) {
      const response = await fetch(`${baseUrl}${ROUTE}${search}`, {
        headers: { cookie: localCookie() },
      })
      assert.equal(response.status, 400, search)
      const body = (await response.json()) as { code?: string }
      assert.equal(body.code, 'INVALID_BILLING_CATEGORY_QUERY')
    }
    // A malformed month is refused on BOTH halves of the page, so a bad scope
    // can never be answered by one read and rejected by the other.
    for (const route of [ROUTE, SUMMARY_ROUTE]) {
      const monthResponse = await fetch(`${baseUrl}${route}?month=August`, {
        headers: { cookie: localCookie() },
      })
      assert.equal(monthResponse.status, 400, route)
      assert.equal(
        ((await monthResponse.json()) as { code?: string }).code,
        'INVALID_BILLING_MONTH',
      )
    }
    // A refused request reads nothing.
    assert.deepEqual(state.reads, [])
  })
})

/**
 * The summary is scoped by month alone. A page or category parameter on it is
 * simply not part of its contract, and must not change what it returns — a
 * cached month summary that quietly varied by category would defeat the split.
 */
test('the month summary ignores category and page parameters', async () => {
  await withServer(async (baseUrl, state) => {
    const plain = await fetch(`${baseUrl}${SUMMARY_ROUTE}?month=2026-08`, {
      headers: { cookie: localCookie() },
    })
    const decorated = await fetch(
      `${baseUrl}${SUMMARY_ROUTE}?month=2026-08&category=PRODUCT_ENQUIRY&page=9`,
      { headers: { cookie: localCookie() } },
    )
    assert.equal(plain.status, 200)
    assert.equal(decorated.status, 200)
    const [first, second] = await Promise.all([
      plain.json() as Promise<Record<string, unknown>>,
      decorated.json() as Promise<Record<string, unknown>>,
    ])
    assert.deepEqual(first.scope, second.scope)
    assert.deepEqual(first.categories, second.categories)
    assert.deepEqual(first.grandTotal, second.grandTotal)
    // Neither read was narrowed to a category.
    for (const read of state.reads) {
      assert.equal('category' in read.scope, false)
    }
  })
})
