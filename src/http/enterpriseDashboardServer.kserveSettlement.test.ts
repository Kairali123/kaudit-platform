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
  localSessionCookie,
} from '../auth/localSession.ts'
import { createEnterpriseDashboardServer } from './enterpriseDashboardServer.ts'
import type {
  KserveSettlementHistory,
  KserveSettlementRepository,
  RecordSettlementResult,
} from '../adapters/mysqlKserveSettlement.ts'
import type {
  KserveVendorBilledPort,
  MonthlyKserveBilledScope,
} from '../adapters/mysqlKserveVendorBilled.ts'
import {
  KserveSettlementConflictError,
  KserveSettlementUnavailableError,
  validateRecordSettlementRequest,
} from '../billing/kserveSettlement.ts'

/**
 * HTTP contract of the monthly KServe settlement route.
 *
 * ADMINISTRATOR-ONLY: both the read and the save are gated on
 * `billing:approve`, which the 'user' role does not hold. Recording what was
 * paid is a money decision, not day-to-day operational access.
 *
 * The route is backed by a SYNTHETIC in-memory store here: no database, and no
 * real month, amount, actor, or key in any fixture.
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
            id: 'user-synthetic-1',
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

const adminAccess = accessFor(['admin'])
const operationalUserAccess = accessFor(['user'])
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

const ROUTE = '/api/v1/billing/settlement'
const MONTH = '2026-08'
const KEY = 'set-0000-1111-2222'

interface Recorded {
  method: string
  detail: unknown
}

/**
 * A synthetic append-only store. It keeps versions in memory so supersession
 * and replay behave exactly as the MySQL repository does, without a database.
 */
function syntheticStore(
  reads: Recorded[],
  options: { failWith?: () => never } = {},
): KserveSettlementRepository {
  const versions: Array<{
    versionNo: number
    finalPaidAmountInr: string
    currency: string
    recordedAt: string
    digest: string
    key: string
  }> = []
  return {
    async readHistory(billMonth, limit): Promise<KserveSettlementHistory> {
      reads.push({ method: 'readHistory', detail: { billMonth, limit } })
      options.failWith?.()
      const ordered = [...versions].reverse()
      return {
        versions: ordered.slice(0, limit).map((version, index) => ({
          versionNo: version.versionNo,
          finalPaidAmountInr: version.finalPaidAmountInr,
          currency: version.currency,
          recordedAt: version.recordedAt,
          isCurrent: index === 0,
        })),
        truncated: ordered.length > limit,
      }
    },
    async recordSettlement(request): Promise<RecordSettlementResult> {
      const validated = validateRecordSettlementRequest(request)
      reads.push({ method: 'recordSettlement', detail: validated.billMonth })
      options.failWith?.()
      const existing = versions.find(
        (version) => version.key === validated.idempotencyKey,
      )
      if (existing) {
        if (existing.digest !== validated.requestDigest) {
          throw new KserveSettlementConflictError(
            'idempotencyKey',
            'has already recorded a different amount for this month',
          )
        }
        return {
          versionNo: existing.versionNo,
          finalPaidAmountInr: existing.finalPaidAmountInr,
          currency: existing.currency,
          recordedAt: existing.recordedAt,
          outcome: 'replayed',
        }
      }
      const versionNo = versions.length + 1
      versions.push({
        versionNo,
        finalPaidAmountInr: validated.finalPaidAmountInr,
        currency: validated.currency,
        recordedAt: `2026-09-0${versionNo} 10:00:00.000000`,
        digest: validated.requestDigest,
        key: validated.idempotencyKey,
      })
      return {
        versionNo,
        finalPaidAmountInr: validated.finalPaidAmountInr,
        currency: validated.currency,
        recordedAt: `2026-09-0${versionNo} 10:00:00.000000`,
        outcome: 'recorded',
      }
    },
  }
}

function syntheticVendorBilled(
  scopes: MonthlyKserveBilledScope[],
  chargeInr: string | null = '20000.00000000',
): KserveVendorBilledPort {
  return {
    async readMonthlyBilledCharge(scope) {
      scopes.push(scope)
      return chargeInr == null
        ? { billedCalls: 0, billedMinutes: null, billedChargeInr: null }
        : {
            billedCalls: 4,
            billedMinutes: '2105.26315789',
            billedChargeInr: chargeInr,
          }
    },
  }
}

async function withServer(
  run: (
    baseUrl: string,
    state: {
      events: AuditEvent[]
      reads: Recorded[]
      scopes: MonthlyKserveBilledScope[]
    },
  ) => Promise<void>,
  options: {
    accessRepository?: AccessRepository
    vendorChargeInr?: string | null
    failWith?: () => never
    /**
     * `/api/v1/reports` reads several unrelated blocks straight from the pool.
     * They are not what these tests are about, so this returns an empty result
     * set for them instead of the refusal below, leaving the settlement read as
     * the only thing that varies. The settlement route itself never touches the
     * pool and keeps the refusing default.
     */
    emptyPoolReads?: boolean
  } = {},
): Promise<void> {
  const events: AuditEvent[] = []
  const reads: Recorded[] = []
  const scopes: MonthlyKserveBilledScope[] = []
  const audit: AuditSink = {
    async record(event) {
      events.push(event)
    },
    async readiness() {
      return true
    },
  }
  const pool = (
    options.emptyPoolReads
      ? {
          async query() {
            return [[], []]
          },
          async execute() {
            return [[], []]
          },
        }
      : {
          async query() {
            throw new Error('the synthetic store must be used instead')
          },
          async execute() {
            throw new Error('the synthetic store must be used instead')
          },
        }
  ) as unknown as Pool
  const server = createEnterpriseDashboardServer({
    config,
    pool,
    access: options.accessRepository ?? adminAccess,
    audit,
    verifier: null,
    kserveSettlement: syntheticStore(reads, { failWith: options.failWith }),
    kserveVendorBilled: syntheticVendorBilled(
      scopes,
      options.vendorChargeInr === undefined
        ? '20000.00000000'
        : options.vendorChargeInr,
    ),
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as AddressInfo
  try {
    await run(`http://127.0.0.1:${address.port}`, { events, reads, scopes })
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    )
  }
}

function save(
  baseUrl: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  return fetch(`${baseUrl}${ROUTE}`, {
    method: 'POST',
    headers: {
      cookie: localCookie(),
      'content-type': 'application/json',
      ...headers,
    },
    body: JSON.stringify(body),
  })
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

// ---------------------------------------------------------------------------
// Authorization
// ---------------------------------------------------------------------------

test('an administrator can read and record a settlement', async () => {
  await withServer(async (baseUrl, state) => {
    const empty = await fetch(`${baseUrl}${ROUTE}?month=${MONTH}`, {
      headers: { cookie: localCookie() },
    })
    assert.equal(empty.status, 200)
    const before = (await empty.json()) as Record<string, never>
    assert.equal(before.status, 'pending')
    assert.equal(before.current, null)
    // Absent is never zero.
    assert.equal((before.savings as never as { available: boolean }).available, false)
    assert.equal((before.savings as never as { amountInr: null }).amountInr, null)

    const saved = await save(baseUrl, {
      month: MONTH,
      finalPaidAmountInr: '17500.00',
      idempotencyKey: KEY,
    })
    assert.equal(saved.status, 200)
    const body = (await saved.json()) as Record<string, never>
    assert.equal(body.outcome, 'recorded')
    assert.equal(body.status, 'recorded')
    assert.equal(
      (body.current as never as { finalPaidAmountInr: string })
        .finalPaidAmountInr,
      '17500.00000000',
    )
    // Savings is server-calculated: 20000.00 billed − 17500.00 paid.
    assert.equal(
      (body.savings as never as { amountInr: string }).amountInr,
      '2500.00000000',
    )
    assert.equal(
      (body.savings as never as { direction: string }).direction,
      'saved',
    )
    // The vendor side was scoped to the complete month.
    assert.deepEqual(state.scopes.at(-1), {
      periodStart: '2026-08-01',
      periodEnd: '2026-08-31',
    })
  })
})

test('a non-administrator is refused both the read and the save', async () => {
  for (const accessRepository of [operationalUserAccess, unassignedAccess]) {
    await withServer(
      async (baseUrl, state) => {
        const read = await fetch(`${baseUrl}${ROUTE}?month=${MONTH}`, {
          headers: { cookie: localCookie() },
        })
        assert.equal(read.status, 403)
        assert.equal(state.events.at(-1)?.action, 'kserve_settlement.read')
        assert.equal(state.events.at(-1)?.outcome, 'denied')

        const written = await save(baseUrl, {
          month: MONTH,
          finalPaidAmountInr: '1.00',
          idempotencyKey: KEY,
        })
        assert.equal(written.status, 403)
        // A refused save is logged as a refused SAVE, not as a read.
        assert.equal(state.events.at(-1)?.action, 'kserve_settlement.record')
        assert.equal(state.events.at(-1)?.outcome, 'denied')
        // Nothing was read or written on behalf of a caller who may not.
        assert.deepEqual(state.reads, [])
      },
      { accessRepository },
    )
  }
})

test('an unauthenticated request never reaches the store', async () => {
  await withServer(async (baseUrl, state) => {
    assert.equal((await fetch(`${baseUrl}${ROUTE}?month=${MONTH}`)).status, 401)
    const written = await fetch(`${baseUrl}${ROUTE}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        month: MONTH,
        finalPaidAmountInr: '1.00',
        idempotencyKey: KEY,
      }),
    })
    assert.equal(written.status, 401)
    assert.deepEqual(state.reads, [])
  })
})

// ---------------------------------------------------------------------------
// Write protections
// ---------------------------------------------------------------------------

test('the write is protected by the same-site session cookie and a JSON body', async () => {
  await withServer(async (baseUrl, state) => {
    // A cross-site form post cannot carry the SameSite=Strict session cookie,
    // and the route refuses a form content type outright.
    const formPost = await fetch(`${baseUrl}${ROUTE}`, {
      method: 'POST',
      headers: {
        cookie: localCookie(),
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: 'month=2026-08&finalPaidAmountInr=1.00',
    })
    assert.equal(formPost.status, 415)
    assert.deepEqual(state.reads, [])
  })
})

test('the credential the write depends on cannot ride a cross-site request', () => {
  // The write is authorized by the session cookie alone, so the cookie's own
  // policy IS the CSRF protection. SameSite=Strict keeps a browser from
  // attaching it to any request another site initiates, and HttpOnly keeps
  // script on another origin from reading it.
  const header = localSessionCookie('kaudit_local_session', 'token', 3600)
  assert.match(header, /HttpOnly/)
  assert.match(header, /SameSite=Strict/)
})

test('unsupported methods are refused', async () => {
  await withServer(async (baseUrl, state) => {
    for (const method of ['PUT', 'PATCH', 'DELETE']) {
      const response = await fetch(`${baseUrl}${ROUTE}`, {
        method,
        headers: { cookie: localCookie() },
      })
      assert.equal(response.status, 405)
    }
    assert.deepEqual(state.reads, [])
  })
})

// ---------------------------------------------------------------------------
// Idempotency and supersession over HTTP
// ---------------------------------------------------------------------------

test('an identical retry replays instead of appending a second version', async () => {
  await withServer(async (baseUrl) => {
    const body = {
      month: MONTH,
      finalPaidAmountInr: '17500.00',
      idempotencyKey: KEY,
    }
    const first = (await (await save(baseUrl, body)).json()) as Record<
      string,
      never
    >
    const second = (await (await save(baseUrl, body)).json()) as Record<
      string,
      never
    >
    assert.equal(first.outcome, 'recorded')
    assert.equal(second.outcome, 'replayed')
    assert.equal((second.history as unknown as unknown[]).length, 1)
  })
})

test('a correction supersedes the prior version and keeps it in history', async () => {
  await withServer(async (baseUrl) => {
    await save(baseUrl, {
      month: MONTH,
      finalPaidAmountInr: '17500.00',
      idempotencyKey: KEY,
    })
    const corrected = (await (
      await save(baseUrl, {
        month: MONTH,
        finalPaidAmountInr: '16000.00',
        idempotencyKey: 'set-9999-8888-7777',
      })
    ).json()) as Record<string, never>

    assert.equal(
      (corrected.current as never as { versionNo: number }).versionNo,
      2,
    )
    assert.equal(
      (corrected.savings as never as { amountInr: string }).amountInr,
      '4000.00000000',
    )
    assert.deepEqual(
      (corrected.history as unknown as Array<{
        versionNo: number
        status: string
      }>).map((version) => [version.versionNo, version.status]),
      [
        [2, 'current'],
        [1, 'superseded'],
      ],
    )
  })
})

test('the same key carrying a different amount is refused with 409', async () => {
  await withServer(async (baseUrl) => {
    await save(baseUrl, {
      month: MONTH,
      finalPaidAmountInr: '17500.00',
      idempotencyKey: KEY,
    })
    const response = await save(baseUrl, {
      month: MONTH,
      finalPaidAmountInr: '9999.00',
      idempotencyKey: KEY,
    })
    assert.equal(response.status, 409)
    const problem = (await response.json()) as { code: string; title: string }
    assert.equal(problem.code, 'KSERVE_SETTLEMENT_CONFLICT')
    assert.equal(problem.title.includes('9999'), false)
    assert.equal(problem.title.includes('17500'), false)
  })
})

// ---------------------------------------------------------------------------
// Malformed input and bounded failure
// ---------------------------------------------------------------------------

test('malformed input is refused with a bounded problem that quotes nothing', async () => {
  await withServer(async (baseUrl) => {
    /**
     * Every supplied value below is a distinctive synthetic token, so "the
     * refusal did not echo it" is a real assertion rather than an accidental
     * substring match against ordinary English in the message.
     */
    const supplied = ['ZQZQ-4242.42', 'ZQZQ1e6', 'ZQZQ-month', 'ZQZQkey']
    for (const body of [
      { month: 'ZQZQ-month', finalPaidAmountInr: '1.00', idempotencyKey: KEY },
      {
        month: MONTH,
        finalPaidAmountInr: '-4242.42',
        idempotencyKey: KEY,
      },
      { month: MONTH, finalPaidAmountInr: 'ZQZQ1e6', idempotencyKey: KEY },
      { month: MONTH, finalPaidAmountInr: '1.00', idempotencyKey: 'ZQZQkey' },
      { month: MONTH, finalPaidAmountInr: '1.00' },
    ]) {
      const response = await save(baseUrl, body)
      assert.equal(response.status, 400, JSON.stringify(body))
      const problem = (await response.json()) as {
        code: string
        title: string
      }
      assert.equal(problem.code, 'INVALID_KSERVE_SETTLEMENT')
      for (const value of [...supplied, '4242.42']) {
        assert.equal(
          problem.title.includes(value),
          false,
          `${value} was echoed back`,
        )
      }
    }
  })
})

test('a GET without a single bill month is refused, not aggregated', async () => {
  await withServer(async (baseUrl, state) => {
    for (const query of ['', '?month=all', '?month=2026-13']) {
      const response = await fetch(`${baseUrl}${ROUTE}${query}`, {
        headers: { cookie: localCookie() },
      })
      assert.equal(response.status, 400)
    }
    assert.deepEqual(state.reads, [])
  })
})

test('an unknown store failure is one bounded 503 with no stored value', async () => {
  await withServer(
    async (baseUrl, state) => {
      const response = await fetch(`${baseUrl}${ROUTE}?month=${MONTH}`, {
        headers: { cookie: localCookie() },
      })
      assert.equal(response.status, 503)
      const problem = (await response.json()) as {
        code: string
        title: string
      }
      assert.equal(problem.code, 'KSERVE_SETTLEMENT_UNAVAILABLE')
      assert.equal(
        problem.title,
        'Monthly settlement is temporarily unavailable',
      )
      for (const leak of ['kms_', 'SELECT', 'final_paid_amount', '17500']) {
        assert.equal(problem.title.includes(leak), false, leak)
      }
      assert.equal(state.events.at(-1)?.outcome, 'failure')
    },
    {
      failWith: () => {
        throw new KserveSettlementUnavailableError()
      },
    },
  )
})

// ---------------------------------------------------------------------------
// Privacy of the response
// ---------------------------------------------------------------------------

test('the response exposes amounts and versions and nothing that identifies', async () => {
  await withServer(async (baseUrl) => {
    await save(baseUrl, {
      month: MONTH,
      finalPaidAmountInr: '17500.00',
      idempotencyKey: KEY,
    })
    const response = await fetch(`${baseUrl}${ROUTE}?month=${MONTH}`, {
      headers: { cookie: localCookie() },
    })
    const body = (await response.json()) as unknown
    const keys = deepKeys(body)
    for (const forbidden of [
      'id',
      'settlementId',
      'idempotencyKey',
      'requestDigest',
      'recordedByUserId',
      'actorUserId',
      'actorEmail',
      'correlationId',
      'supersedesSettlementId',
      'callId',
      'sourceUrl',
      'transcript',
      'evidenceSha256',
    ]) {
      assert.equal(keys.has(forbidden), false, forbidden)
    }
    const serialized = JSON.stringify(body)
    assert.equal(serialized.includes(KEY), false)
    assert.equal(serialized.includes('user-synthetic-1'), false)
    assert.equal(serialized.includes('operator@example.test'), false)
  })
})

test('every read and write is logged under its own distinct action', async () => {
  await withServer(async (baseUrl, state) => {
    await fetch(`${baseUrl}${ROUTE}?month=${MONTH}`, {
      headers: { cookie: localCookie() },
    })
    assert.equal(state.events.at(-1)?.action, 'kserve_settlement.read')

    await save(baseUrl, {
      month: MONTH,
      finalPaidAmountInr: '17500.00',
      idempotencyKey: KEY,
    })
    const recorded = state.events.at(-1)
    assert.equal(recorded?.action, 'kserve_settlement.record')
    assert.equal(recorded?.resourceType, 'kserve_monthly_settlement')
    // The resource is the bill month; never the row id, key, digest or amount.
    assert.equal(recorded?.resourceId, MONTH)
    assert.equal(recorded?.purpose, 'billing_settlement')

    await save(baseUrl, {
      month: MONTH,
      finalPaidAmountInr: '17500.00',
      idempotencyKey: KEY,
    })
    assert.equal(state.events.at(-1)?.action, 'kserve_settlement.replay')
  })
})

// ---------------------------------------------------------------------------
// Report integration
// ---------------------------------------------------------------------------

test('savings stays unavailable when the month has no vendor billed evidence', async () => {
  await withServer(
    async (baseUrl) => {
      const body = (await (
        await save(baseUrl, {
          month: MONTH,
          finalPaidAmountInr: '17500.00',
          idempotencyKey: KEY,
        })
      ).json()) as Record<string, never>
      assert.equal(body.status, 'recorded')
      assert.equal(
        (body.savings as never as { available: boolean }).available,
        false,
      )
      assert.equal(
        (body.savings as never as { amountInr: null }).amountInr,
        null,
      )
    },
    { vendorChargeInr: null },
  )
})

/**
 * `/api/v1/reports` must distinguish THREE settlement states, and a failed read
 * is the one that used to be lost: it was swallowed to null and the artifacts
 * then printed "not recorded for this period", turning a transient database
 * failure into a published claim about the month.
 *
 * The route's other blocks read an empty pool here, so the ONLY thing these
 * tests vary is whether the settlement read succeeds.
 */
async function reportsSettlement(
  baseUrl: string,
): Promise<Record<string, unknown> | null> {
  const response = await fetch(`${baseUrl}/api/v1/reports?month=${MONTH}`, {
    headers: { cookie: localCookie() },
  })
  assert.equal(response.status, 200)
  const body = (await response.json()) as {
    settlement: Record<string, unknown> | null
  }
  return body.settlement
}

test('a month with no settlement row reports pending, with no money', async () => {
  await withServer(
    async (baseUrl) => {
      const settlement = await reportsSettlement(baseUrl)
      assert.ok(settlement)
      // A SUCCESSFUL read that found nothing. This is a statement about the
      // month, and it keeps its existing wording.
      assert.equal(settlement.status, 'pending')
      assert.equal(settlement.finallyPaidInr, null)
      assert.equal(settlement.finallyPaidVersion, null)
      assert.equal(settlement.savingsAvailable, false)
      assert.equal(settlement.savingsInr, null)
      // The vendor side was read successfully and is still reported.
      assert.equal(settlement.vendorBilledChargeInr, '20000.00000000')
    },
    { emptyPoolReads: true },
  )
})

test('a failed settlement read reports unavailable, never pending or null', async () => {
  await withServer(
    async (baseUrl) => {
      const settlement = await reportsSettlement(baseUrl)
      // Null would mean "not scoped to one month" and pending would mean "no
      // settlement exists". Neither is true here.
      assert.ok(settlement)
      assert.equal(settlement.status, 'unavailable')
      assert.notEqual(settlement.status, 'pending')

      // No money, no version, no timestamp is fabricated from a failure.
      for (const field of [
        'finallyPaidInr',
        'finallyPaidVersion',
        'finallyPaidRecordedAt',
        'vendorBilledChargeInr',
        'savingsInr',
      ]) {
        assert.equal(settlement[field], null, field)
      }
      assert.equal(settlement.savingsAvailable, false)
      assert.equal(settlement.savingsDirection, 'unavailable')
      assert.equal(settlement.month, MONTH)

      // Nothing about the failure travels: no thrown prose, no table name, no
      // column, no value, no identity.
      const serialized = JSON.stringify(settlement)
      for (const leak of [
        'synthetic-failure',
        'kaudit_kserve_monthly_settlement',
        'final_paid_amount',
        'SELECT',
        'Error',
        '17500',
        'user-synthetic-1',
      ]) {
        assert.equal(serialized.includes(leak), false, leak)
      }
    },
    {
      emptyPoolReads: true,
      failWith: () => {
        throw new Error('synthetic-failure in kaudit_kserve_monthly_settlement')
      },
    },
  )
})

test('a report not scoped to one month still carries a null settlement', async () => {
  await withServer(
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/v1/reports`, {
        headers: { cookie: localCookie() },
      })
      assert.equal(response.status, 200)
      const body = (await response.json()) as { settlement: unknown }
      // Null keeps its ONE meaning: the report is not scoped to a bill month.
      assert.equal(body.settlement, null)
    },
    { emptyPoolReads: true },
  )
})
