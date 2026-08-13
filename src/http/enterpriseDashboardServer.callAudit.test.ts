import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { AddressInfo } from 'node:net'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { Pool } from 'mysql2/promise'
import type { AccessRepository } from '../auth/types.ts'
import type { AuditEvent, AuditSink } from '../audit/types.ts'
import type { RuntimeConfig } from '../config/runtime.ts'
import {
  createLocalPasswordHash,
  issueLocalSession,
} from '../auth/localSession.ts'
import { createEnterpriseDashboardServer } from './enterpriseDashboardServer.ts'
import {
  ELIGIBILITIES,
  KSERVE_COMPARISON_LABELS,
  MISMATCH_SEVERITIES,
  PROCESSING_STATUSES,
  UNDETERMINED_BUCKET,
  type CallAuditPeriodQuery,
  type CallAuditPeriodSummary,
  type CallAuditReportingRepository,
  type CallAuditResultListQuery,
  type CallAuditResultReportRow,
  type CallAuditTally,
} from '../adapters/mysqlCallAuditReporting.ts'
import { CALL_AUDIT_METRIC_CODES } from '../callaudit/rubric.ts'
import { OUTCOME_GROUPS } from '../callaudit/outcomes.ts'
import {
  ISSUE_FLAGS,
  NEXT_ACTION_CODES,
  QUALIFICATIONS,
  type IssueFlag,
} from '../callaudit/modelOutput.ts'
import { CALL_INTENTS } from '../callaudit/types.ts'

/**
 * HTTP contract of the sanitized Call Audit reporting route.
 *
 * The route is ADMINISTRATOR-ONLY: it is gated on `audit:inspect`, which the
 * 'user' role does not hold. The rows it returns stay sanitized regardless —
 * that boundary is asserted below and is not weakened by the narrower gate.
 *
 * The route is backed by a SYNTHETIC in-memory repository here: no database, no
 * external source table, and no real transcript, lead, hash, URL, PII, or money
 * anywhere in the fixture.
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
    sessionSecret:
      'synthetic-session-secret-at-least-32-characters',
    sessionCookie: 'kaudit_local_session',
    sessionTtlSeconds: 3600,
  },
  releaseGates: {
    automatedValidationApproved: false,
    calibrationComplete: false,
    reportingApproved: false,
  },
}

/**
 * The one configured local identity, resolved with whichever roles a test asks
 * for. The session cookie is identical in every case, so the only thing that
 * differs between the allowed and the denied requests below is the ROLE.
 */
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

/** An administrator: holds audit:inspect, so the report is readable. */
const access = accessFor(['admin'])

/** A plain operational user: role 'user', NOT admin, no audit:inspect. */
const operationalUserAccess = accessFor(['user'])

/** The seed default: no permission at all. */
const unassignedAccess = accessFor(['unassigned'])

function localCookie(): string {
  if (config.auth.mode !== 'local') {
    throw new Error('Synthetic local config is required')
  }
  const token = issueLocalSession(
    config.auth.email,
    config.auth.sessionSecret,
    config.auth.sessionTtlSeconds,
  )
  return `${config.auth.sessionCookie}=${encodeURIComponent(token)}`
}

function tally<Bucket extends string>(
  vocabulary: readonly Bucket[],
  counts: Partial<Record<string, number>> = {},
): CallAuditTally<Bucket> {
  return Object.fromEntries(
    [...vocabulary, UNDETERMINED_BUCKET].map((bucket) => [
      bucket,
      counts[bucket] ?? 0,
    ]),
  ) as CallAuditTally<Bucket>
}

function summaryFixture(resultCount: number): CallAuditPeriodSummary {
  return {
    period: {
      periodStart: '2026-07-01 00:00:00.000000',
      periodEndExclusive: '2026-08-01 00:00:00.000000',
    },
    runTypes: ['monthly'],
    runId: null,
    resultCount,
    auditedCallCount: resultCount,
    byProcessingStatus: tally(PROCESSING_STATUSES, {
      succeeded: resultCount,
    }),
    byEligibility: tally(ELIGIBILITIES, {
      content_auditable: resultCount,
    }),
    byIntent: tally(CALL_INTENTS, { WARM: resultCount }),
    byGroupedOutcome: tally(OUTCOME_GROUPS, {
      PRODUCTS_COMMERCE: resultCount,
    }),
    byKserveComparison: tally(KSERVE_COMPARISON_LABELS, {
      match: resultCount,
    }),
    byMismatchSeverity: tally(MISMATCH_SEVERITIES, {
      none: resultCount,
    }),
    byQualification: tally(QUALIFICATIONS, { QUALIFIED: resultCount }),
    byNextAction: tally(NEXT_ACTION_CODES, { CALLBACK: resultCount }),
    byIssueFlag: Object.fromEntries(
      ISSUE_FLAGS.map((flag) => [flag, 0]),
    ) as Record<IssueFlag, number>,
  }
}

/** Carries fields the DTO must drop, so the route is proven to sanitize. */
function resultFixture(index: number): CallAuditResultReportRow {
  return {
    resultId: `res-${index}`,
    runId: 'run-1',
    sourceRefId: `src-${index}`,
    taskId: `TASK-${2000 + index}`,
    effectiveCallAt: '2026-07-12 11:04:00.000000',
    callDurationSeconds: 210,
    hasTranscript: true,
    company: 'Synthetic Wellness Pvt Ltd',
    companyByKserve: 'Synthetic Wellness',
    serviceCategory: 'PRODUCTS',
    callType: 'outbound',
    callStatus: 'completed',
    finalCallStatus: 'completed',
    aiCallCategory: 'enquiry',
    customerEngagementLevel: 'high',
    interestLevel: 'warm',
    callOutcome: 'Individual Products Buying',
    leadStatus: 'open',
    finalLeadOutcome: 'follow_up',
    calculatedQualificationStatus: 'qualified',
    followupRequired: 'yes',
    processingStatus: 'succeeded',
    eligibility: 'content_auditable',
    ineligibilityReason: null,
    callConnected: true,
    customerSpoke: true,
    meaningfulConversation: true,
    intent: 'WARM',
    intentConfidence: '0.810',
    detailedOutcome: 'Individual Products Buying',
    groupedOutcome: 'PRODUCTS_COMMERCE',
    qualificationLabel: 'QUALIFIED',
    nextActionCode: 'CALLBACK',
    overallScore: '81.500',
    overallScoreMethod: 'weighted_rubric_v1',
    kserveReportedOutcome: 'Individual Products Buying',
    kserveComparisonLabel: 'match',
    mismatchSeverity: 'none',
    managementFeedback: 'Synthetic sanitized management note.',
    kserveFeedback: 'Synthetic sanitized comparison note.',
    improvementFeedback: 'Synthetic sanitized coaching note.',
    issueFlags: [],
    auditedAt: '2026-08-01 01:15:00.000000',
    transcript: 'SYNTHETIC-TRANSCRIPT-MUST-NOT-LEAK',
    leadId: 'SYNTHETIC-LEAD-MUST-NOT-LEAK',
    leadIdSha256: 'SYNTHETIC-HASH-MUST-NOT-LEAK',
    sourceUrl: 'https://synthetic.invalid/must-not-leak',
    businessPrompt: 'SYNTHETIC-PROMPT-MUST-NOT-LEAK',
    amountInr: '4321.00',
  } as unknown as CallAuditResultReportRow
}

interface RecordedCall {
  method: string
  query: unknown
}

function syntheticRepository(
  calls: RecordedCall[],
  resultCount = 4,
): CallAuditReportingRepository {
  return {
    async getRunProgress() {
      return null
    },
    async listRuns(query) {
      calls.push({ method: 'listRuns', query })
      return []
    },
    async getPeriodSummary(query: CallAuditPeriodQuery) {
      calls.push({ method: 'getPeriodSummary', query })
      return summaryFixture(resultCount)
    },
    async listMetricScoreAggregates(query: CallAuditPeriodQuery) {
      calls.push({ method: 'listMetricScoreAggregates', query })
      return CALL_AUDIT_METRIC_CODES.map((metricCode) => ({
        metricCode,
        scoredCount: 4,
        notApplicableCount: 0,
        averageScore: '4.000',
        distribution: { 1: 0, 2: 0, 3: 0, 4: 4, 5: 0 },
      }))
    },
    async listResults(query: CallAuditResultListQuery) {
      calls.push({ method: 'listResults', query })
      return Array.from(
        { length: Math.min(resultCount, query.limit) },
        (_, index) => resultFixture(index),
      )
    },
    async listUsageAggregates(query: CallAuditPeriodQuery) {
      calls.push({ method: 'listUsageAggregates', query })
      return [
        {
          providerName: 'synthetic-provider',
          modelName: 'synthetic-model',
          modelVersion: '2026-01-01',
          attemptOutcome: 'succeeded',
          attemptCount: 4,
          resultCount: 4,
          maxAttemptNumber: 1,
          inputTokensTotal: '4000',
          outputTokensTotal: '1200',
          totalTokensTotal: '5200',
          latencyMsTotal: '8000',
          latencyMsMax: '2600',
          erroredCount: 0,
        },
      ]
    },
  }
}

async function withServer(
  run: (
    baseUrl: string,
    state: { events: AuditEvent[]; calls: RecordedCall[] },
  ) => Promise<void>,
  options: {
    accessRepository?: AccessRepository
    webDistRoot?: string
    resultCount?: number
  } = {},
): Promise<void> {
  const events: AuditEvent[] = []
  const calls: RecordedCall[] = []
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
      return [[{ one: 1 }], []]
    },
    async execute() {
      throw new Error('the synthetic repository must be used instead')
    },
  } as unknown as Pool
  const server = createEnterpriseDashboardServer({
    config,
    pool,
    access: options.accessRepository ?? access,
    audit,
    verifier: null,
    callAuditReporting: syntheticRepository(
      calls,
      options.resultCount ?? 4,
    ),
    webDistRoot: options.webDistRoot,
  })
  await new Promise<void>((resolve) =>
    server.listen(0, '127.0.0.1', resolve),
  )
  const address = server.address() as AddressInfo
  try {
    await run(`http://127.0.0.1:${address.port}`, { events, calls })
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

const ROUTE = '/api/v1/call-audit/report'

test('call audit reporting is readable by an administrator', async () => {
  await withServer(async (baseUrl, state) => {
    const response = await fetch(
      `${baseUrl}${ROUTE}?cadence=monthly&start=2026-07-01&end=2026-08-01&limit=10`,
      { headers: { cookie: localCookie() } },
    )
    assert.equal(response.status, 200)
    const body = (await response.json()) as Record<string, unknown>
    assert.equal(body.title, 'Kserve Call Audit Report')
    assert.equal(body.aiCaller, 'Saanvi')
    assert.equal(body.hasResults, true)
    const basis = body.reportBasis as Record<string, unknown>
    assert.equal(basis.cadence, 'monthly')
    assert.equal(basis.periodStart, '2026-07-01 00:00:00.000000')
    assert.equal(
      basis.periodEndExclusive,
      '2026-08-01 00:00:00.000000',
    )
    assert.equal(basis.resultLimit, 10)
    assert.equal((body.headline as unknown[]).length, 8)
    assert.equal((body.metrics as unknown[]).length, 8)
    assert.equal((body.results as unknown[]).length, 4)

    // The route reads only through the sanitized Task 13 repository.
    assert.deepEqual(
      state.calls.map((call) => call.method).sort(),
      [
        'getPeriodSummary',
        'listMetricScoreAggregates',
        'listResults',
        'listRuns',
        'listUsageAggregates',
      ],
    )
    assert.equal(state.events.at(-1)?.action, 'call_audit_report.read')
    assert.equal(state.events.at(-1)?.outcome, 'success')
    assert.equal(state.events.at(-1)?.resourceType, 'aggregate_dashboard')
  })
})

test('the reporting response exposes no transcript, identity, or money field', async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}${ROUTE}`, {
      headers: { cookie: localCookie() },
    })
    assert.equal(response.status, 200)
    const body = await response.json()
    const keys = deepKeys(body)
    for (const forbidden of [
      'transcript',
      'transcriptSha256',
      'leadId',
      'leadIdSha256',
      'sourceRowId',
      'sourceRefId',
      'sourceUrl',
      'recordingUrl',
      'resultJson',
      'resultSha256',
      'errorDetail',
      'businessPrompt',
      'scoringConfigJson',
      'prompt',
      'temperature',
      'providerName',
      'modelName',
      'modelVersion',
      'phone',
      'amount',
      'amountInr',
      'currency',
      'price',
      'rate',
      'cost',
      'invoice',
    ]) {
      assert.equal(keys.has(forbidden), false, `key ${forbidden} leaked`)
    }
    const serialized = JSON.stringify(body)
    for (const forbidden of [
      'SYNTHETIC-TRANSCRIPT-MUST-NOT-LEAK',
      'SYNTHETIC-LEAD-MUST-NOT-LEAK',
      'SYNTHETIC-HASH-MUST-NOT-LEAK',
      'must-not-leak',
      'SYNTHETIC-PROMPT-MUST-NOT-LEAK',
      '4321.00',
      'synthetic-provider',
      'synthetic-model',
      'ai_voice_leads_received',
    ]) {
      assert.equal(
        serialized.includes(forbidden),
        false,
        `value ${forbidden} leaked`,
      )
    }
    assert.match(serialized, /TASK-2000/)
  })
})

test('an empty period reports pending tiles rather than zero success', async () => {
  await withServer(
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}${ROUTE}`, {
        headers: { cookie: localCookie() },
      })
      assert.equal(response.status, 200)
      const body = (await response.json()) as Record<string, unknown>
      assert.equal(body.hasResults, false)
      for (const tile of body.headline as Array<
        Record<string, unknown>
      >) {
        assert.equal(tile.status, 'pending')
        assert.equal(tile.value, '—')
      }
    },
    { resultCount: 0 },
  )
})

test('an invalid report query is rejected with a client-safe problem', async () => {
  await withServer(async (baseUrl) => {
    for (const query of [
      'cadence=weekly',
      'start=2026-08-01&end=2026-07-01',
      'start=2026-07-01T00:00:00Z&end=2026-08-01',
      'limit=5000',
      'start=2000-01-01&end=2026-01-01',
    ]) {
      const response = await fetch(`${baseUrl}${ROUTE}?${query}`, {
        headers: { cookie: localCookie() },
      })
      assert.equal(response.status, 400, query)
      const problem = (await response.json()) as Record<string, unknown>
      assert.equal(problem.code, 'INVALID_CALL_AUDIT_REPORT_QUERY')
      assert.equal(typeof problem.correlationId, 'string')
    }
  })
})

test('reporting requires an authenticated session', async () => {
  await withServer(async (baseUrl, state) => {
    const response = await fetch(`${baseUrl}${ROUTE}`)
    assert.equal(response.status, 401)
    const problem = (await response.json()) as Record<string, unknown>
    assert.equal(problem.code, 'AUTH_REQUIRED')
    assert.equal(state.calls.length, 0)
    assert.equal(state.events.at(-1)?.outcome, 'denied')
    assert.equal(state.events.at(-1)?.action, 'call_audit_report.read')
  })
})

test('an ordinary authenticated user is denied before any data is read', async () => {
  await withServer(
    async (baseUrl, state) => {
      const response = await fetch(
        `${baseUrl}${ROUTE}?cadence=monthly&limit=10`,
        { headers: { cookie: localCookie() } },
      )
      assert.equal(response.status, 403)
      const problem = (await response.json()) as Record<string, unknown>
      assert.equal(problem.code, 'PERMISSION_DENIED')
      // The gate runs BEFORE the repository: a denied user's request never
      // reaches a query, so not even a sanitized row is assembled for them.
      assert.equal(state.calls.length, 0)
      // And nothing of the report — not a title, not a Task ID — comes back
      // on the refusal itself.
      const serialized = JSON.stringify(problem)
      assert.equal(serialized.includes('TASK-'), false)
      assert.equal(
        serialized.includes('Kserve Call Audit Report'),
        false,
      )
      assert.equal(state.events.at(-1)?.outcome, 'denied')
      assert.equal(state.events.at(-1)?.action, 'call_audit_report.read')
    },
    { accessRepository: operationalUserAccess },
  )
})

test('a role with no permission at all is denied', async () => {
  await withServer(
    async (baseUrl, state) => {
      const response = await fetch(`${baseUrl}${ROUTE}`, {
        headers: { cookie: localCookie() },
      })
      assert.equal(response.status, 403)
      const problem = (await response.json()) as Record<string, unknown>
      assert.equal(problem.code, 'PERMISSION_DENIED')
      assert.equal(state.calls.length, 0)
    },
    { accessRepository: unassignedAccess },
  )
})

async function webRoot(): Promise<string> {
  const root = await mkdtemp(
    path.join(os.tmpdir(), 'kaudit-call-audit-'),
  )
  await mkdir(path.join(root, 'assets'))
  await writeFile(
    path.join(root, 'index.html'),
    '<!doctype html><div id="root"></div>',
  )
  return root
}

test('the call audit page is served to an administrator', async () => {
  const root = await webRoot()
  await withServer(
    async (baseUrl) => {
      const page = await fetch(`${baseUrl}/call-audit`, {
        headers: { cookie: localCookie() },
        redirect: 'manual',
      })
      assert.equal(page.status, 200)
      assert.match(
        page.headers.get('content-type') ?? '',
        /text\/html/,
      )
      // Call Audit rules stay admin-only alongside it, and Billing Audit
      // remains its own module rather than being folded into this gate.
      const rules = await fetch(`${baseUrl}/call-audit/settings`, {
        headers: { cookie: localCookie() },
        redirect: 'manual',
      })
      assert.equal(rules.status, 200)
    },
    { webDistRoot: root },
  )
})

test('the call audit page is refused to a non-admin who types the URL', async () => {
  const root = await webRoot()
  await withServer(
    async (baseUrl) => {
      for (const target of ['/call-audit', '/call-audit/settings']) {
        const page = await fetch(`${baseUrl}${target}`, {
          headers: { cookie: localCookie() },
          redirect: 'manual',
        })
        assert.equal(page.status, 403, target)
        assert.equal(
          page.headers.get('content-type')?.includes('text/html'),
          false,
          `${target} must not return the app shell`,
        )
      }
      // Billing Audit is a separate module and is unaffected by the Call
      // Audit gate: this same user keeps the pages their role allows.
      const billing = await fetch(`${baseUrl}/billing`, {
        headers: { cookie: localCookie() },
        redirect: 'manual',
      })
      assert.equal(billing.status, 200)
    },
    { webDistRoot: root, accessRepository: operationalUserAccess },
  )
})
