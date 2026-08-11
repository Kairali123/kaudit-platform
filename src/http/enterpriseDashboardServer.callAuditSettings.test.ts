import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { AddressInfo } from 'node:net'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { Pool } from 'mysql2/promise'
import type { AccessRepository, AccessUser } from '../auth/types.ts'
import type { AuditEvent, AuditSink } from '../audit/types.ts'
import type { RuntimeConfig } from '../config/runtime.ts'
import {
  createLocalPasswordHash,
  issueLocalSession,
} from '../auth/localSession.ts'
import { createEnterpriseDashboardServer } from './enterpriseDashboardServer.ts'
import {
  buildRuleVersionId,
  CallAuditControlError,
  type CallAuditControlRepository,
  type CallAuditRuleVersionLifecycle,
} from '../adapters/mysqlCallAuditControl.ts'
import { buildRuleActivation } from '../callaudit/ruleActivation.ts'
import type { CallAuditRuleActivation } from '../callaudit/ruleActivation.ts'
import {
  CALL_AUDIT_SETTINGS_PAGE_ROUTE,
  CALL_AUDIT_SETTINGS_ROUTE,
  type CallAuditRuleVersionDetailRecord,
  type CallAuditRuleVersionRecord,
  type CallAuditRunSummaryRecord,
  type CallAuditSettingsReadPort,
} from '../callaudit/adminSettings.ts'

/**
 * HTTP contract of the ADMIN-ONLY Call Audit settings route.
 *
 * Everything is synthetic: an in-memory read port and an in-memory control
 * repository stand in for MySQL, and no transcript, lead identifier, source
 * record, or money value exists anywhere in this file. The one prompt present
 * is administrator-authored configuration, which is exactly what the route
 * exists to administer.
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

function accessFor(roles: string[]): AccessRepository {
  return {
    async findByOidc() {
      return null
    },
    async findByEmail(email): Promise<AccessUser | null> {
      return email === 'operator@example.test'
        ? {
            id: 'usr_admin_0001',
            email,
            status: 'active',
            maxSensitivityTier: 'K0',
            roles,
          }
        : null
    },
    async readiness() {
      return true
    },
  }
}

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

const SYNTHETIC_PROMPT =
  'Assess each conversation against the approved rubric. Report only the ' +
  'structured fields the output schema defines. Never invent facts.'

function snapshotFixture(): CallAuditRuleActivation {
  return buildRuleActivation({
    versionLabel: 'call-audit/2026.08.1',
    businessPrompt: SYNTHETIC_PROMPT,
    modelProvider: 'synthetic-provider',
    modelName: 'synthetic-model',
    modelVersion: '2026-08-01',
    temperature: '0.200',
  })
}

function versionRecord(
  overrides: Partial<CallAuditRuleVersionRecord> = {},
): CallAuditRuleVersionRecord {
  const snapshot = snapshotFixture()
  return {
    ruleVersionId: buildRuleVersionId(snapshot),
    versionLabel: snapshot.versionLabel,
    status: 'active',
    promptSha256: snapshot.promptSha256,
    modelProvider: snapshot.modelProvider,
    modelName: snapshot.modelName,
    modelVersion: snapshot.modelVersion,
    temperature: snapshot.temperature,
    ruleContractVersion: snapshot.ruleContractVersion,
    outputSchemaVersion: snapshot.outputSchemaVersion,
    taxonomyVersion: snapshot.taxonomyVersion,
    scoringConfigVersion: snapshot.scoringConfigVersion,
    configSha256: snapshot.configSha256,
    changeReason: 'Approved for live auditing.',
    createdBy: 'usr_admin_0001',
    createdAt: '2026-08-01 09:00:00.000000',
    activatedBy: 'usr_admin_0002',
    activatedAt: '2026-08-01 09:30:00.000000',
    retiredBy: null,
    retiredAt: null,
    ...overrides,
  }
}

const RUN_RECORD: CallAuditRunSummaryRecord = {
  runId: 'crn_synthetic0001',
  ruleVersionId: buildRuleVersionId(snapshotFixture()),
  runType: 'monthly',
  status: 'completed',
  periodStart: '2026-07-01 00:00:00.000000',
  periodEndExclusive: '2026-08-01 00:00:00.000000',
  periodTimezone: 'Asia/Kolkata',
  totalCandidates: 40,
  processedCount: 40,
  succeededCount: 38,
  failedCount: 2,
  skippedCount: 0,
  errorCode: null,
  startedAt: '2026-08-01 01:00:00.000000',
  finishedAt: '2026-08-01 01:22:00.000000',
}

interface RecordedRead {
  method: string
  argument: unknown
}

function readPort(
  reads: RecordedRead[],
  options: { active?: CallAuditRuleVersionRecord | null } = {},
): CallAuditSettingsReadPort {
  const active =
    options.active === undefined ? versionRecord() : options.active
  return {
    async listRuleVersions(limit) {
      reads.push({ method: 'listRuleVersions', argument: limit })
      return active ? [active] : []
    },
    async getActiveRuleVersion() {
      reads.push({ method: 'getActiveRuleVersion', argument: null })
      return active
    },
    async getRuleVersionDetail(ruleVersionId) {
      reads.push({ method: 'getRuleVersionDetail', argument: ruleVersionId })
      if (!active || active.ruleVersionId !== ruleVersionId) return null
      const detail: CallAuditRuleVersionDetailRecord = {
        ...active,
        businessPrompt: SYNTHETIC_PROMPT,
      }
      return detail
    },
    async listRecentRuns(limit) {
      reads.push({ method: 'listRecentRuns', argument: limit })
      return [RUN_RECORD]
    },
  }
}

interface SavedVersion {
  snapshot: CallAuditRuleActivation
  lifecycle: CallAuditRuleVersionLifecycle
}

function controlRepository(
  saved: SavedVersion[],
  options: { activeAlready?: boolean } = {},
): CallAuditControlRepository {
  const unsupported = () => {
    throw new Error('run control is out of scope for the settings route')
  }
  return {
    async saveRuleVersionSnapshot(
      snapshot: CallAuditRuleActivation,
      lifecycle: CallAuditRuleVersionLifecycle,
    ) {
      if (lifecycle.status === 'active' && options.activeAlready) {
        // Exactly what the append-only repository does rather than editing the
        // live version in place.
        throw new CallAuditControlError(
          'ruleVersion',
          'status',
          'another rule version is already active; retire it first',
        )
      }
      saved.push({ snapshot, lifecycle })
      return { id: buildRuleVersionId(snapshot), outcome: 'inserted' }
    },
    createRun: unsupported,
    markRunRunning: unsupported,
    updateRunCounters: unsupported,
    markRunCompleted: unsupported,
    markRunFailed: unsupported,
    markRunCancelled: unsupported,
  } as unknown as CallAuditControlRepository
}

interface ServerState {
  events: AuditEvent[]
  reads: RecordedRead[]
  saved: SavedVersion[]
}

async function withServer(
  run: (baseUrl: string, state: ServerState) => Promise<void>,
  options: {
    roles?: string[]
    active?: CallAuditRuleVersionRecord | null
    activeAlready?: boolean
    webDistRoot?: string
  } = {},
): Promise<void> {
  const events: AuditEvent[] = []
  const reads: RecordedRead[] = []
  const saved: SavedVersion[] = []
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
      throw new Error('the synthetic repositories must be used instead')
    },
  } as unknown as Pool
  const server = createEnterpriseDashboardServer({
    config,
    pool,
    access: accessFor(options.roles ?? ['admin']),
    audit,
    verifier: null,
    callAuditSettings: readPort(reads, { active: options.active }),
    callAuditControl: controlRepository(saved, {
      activeAlready: options.activeAlready,
    }),
    webDistRoot: options.webDistRoot,
  })
  await new Promise<void>((resolve) =>
    server.listen(0, '127.0.0.1', resolve),
  )
  const address = server.address() as AddressInfo
  try {
    await run(`http://127.0.0.1:${address.port}`, { events, reads, saved })
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

function post(baseUrl: string, body: unknown, headers = {}): Promise<Response> {
  return fetch(`${baseUrl}${CALL_AUDIT_SETTINGS_ROUTE}`, {
    method: 'POST',
    headers: {
      cookie: localCookie(),
      'content-type': 'application/json',
      ...headers,
    },
    body: JSON.stringify(body),
  })
}

const VALID_DRAFT = {
  versionLabel: 'call-audit/2026.09.1',
  businessPrompt: SYNTHETIC_PROMPT,
  modelProvider: 'synthetic-provider',
  modelName: 'synthetic-model',
  modelVersion: '2026-09-01',
  temperature: '0.2',
  changeReason: 'Tightened the coaching guidance.',
}

// ---------------------------------------------------------------------------
// Access control
// ---------------------------------------------------------------------------

test('an authenticated administrator can read the settings', async () => {
  await withServer(async (baseUrl, state) => {
    const response = await fetch(`${baseUrl}${CALL_AUDIT_SETTINGS_ROUTE}`, {
      headers: { cookie: localCookie() },
    })
    assert.equal(response.status, 200)
    const body = (await response.json()) as Record<string, unknown>
    assert.equal(body.title, 'Call Audit Rule Settings')
    const active = body.activeVersion as Record<string, unknown>
    assert.equal(active.versionLabel, 'call-audit/2026.08.1')
    assert.equal(active.statusLabel, 'Active')
    assert.equal(active.temperature, '0.200')
    assert.equal(active.matchesApplicationContract, true)
    assert.equal((body.versions as unknown[]).length, 1)
    assert.equal((body.recentRuns as unknown[]).length, 1)
    // Metadata only by default: the prompt read is never issued.
    assert.equal(
      state.reads.some((read) => read.method === 'getRuleVersionDetail'),
      false,
    )
    assert.equal(body.detail, null)
    assert.equal(state.events.at(-1)?.action, 'call_audit_settings.read')
    assert.equal(state.events.at(-1)?.outcome, 'success')
  })
})

test('a normal logged-in user is denied the settings read', async () => {
  await withServer(
    async (baseUrl, state) => {
      const response = await fetch(`${baseUrl}${CALL_AUDIT_SETTINGS_ROUTE}`, {
        headers: { cookie: localCookie() },
      })
      assert.equal(response.status, 403)
      const problem = (await response.json()) as Record<string, unknown>
      assert.equal(problem.code, 'PERMISSION_DENIED')
      // Nothing was read, so no prompt or metadata reached the denied caller.
      assert.equal(state.reads.length, 0)
      assert.equal(state.events.at(-1)?.outcome, 'denied')
      assert.equal(state.events.at(-1)?.action, 'call_audit_settings.read')
    },
    { roles: ['user'] },
  )
})

test('a normal logged-in user is denied the settings write', async () => {
  await withServer(
    async (baseUrl, state) => {
      const response = await post(baseUrl, VALID_DRAFT)
      assert.equal(response.status, 403)
      assert.equal(
        ((await response.json()) as Record<string, unknown>).code,
        'PERMISSION_DENIED',
      )
      assert.equal(state.saved.length, 0)
    },
    { roles: ['user'] },
  )
})

test('the settings route requires an authenticated session', async () => {
  await withServer(async (baseUrl, state) => {
    const read = await fetch(`${baseUrl}${CALL_AUDIT_SETTINGS_ROUTE}`)
    assert.equal(read.status, 401)
    assert.equal(
      ((await read.json()) as Record<string, unknown>).code,
      'AUTH_REQUIRED',
    )
    const write = await fetch(`${baseUrl}${CALL_AUDIT_SETTINGS_ROUTE}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(VALID_DRAFT),
    })
    assert.equal(write.status, 401)
    assert.equal(state.reads.length, 0)
    assert.equal(state.saved.length, 0)
  })
})

test('the settings page is admin-only while the report page is not', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kaudit-ca-settings-'))
  await mkdir(path.join(root, 'assets'))
  await writeFile(
    path.join(root, 'index.html'),
    '<!doctype html><div id="root"></div>',
  )
  await withServer(
    async (baseUrl) => {
      const denied = await fetch(
        `${baseUrl}${CALL_AUDIT_SETTINGS_PAGE_ROUTE}`,
        { headers: { cookie: localCookie() }, redirect: 'manual' },
      )
      assert.equal(denied.status, 403)
      const report = await fetch(`${baseUrl}/call-audit`, {
        headers: { cookie: localCookie() },
        redirect: 'manual',
      })
      assert.equal(report.status, 200)
    },
    { roles: ['user'], webDistRoot: root },
  )
  await withServer(
    async (baseUrl) => {
      const allowed = await fetch(
        `${baseUrl}${CALL_AUDIT_SETTINGS_PAGE_ROUTE}`,
        { headers: { cookie: localCookie() }, redirect: 'manual' },
      )
      assert.equal(allowed.status, 200)
      assert.match(
        allowed.headers.get('content-type') ?? '',
        /text\/html/,
      )
    },
    { webDistRoot: root },
  )
})

// ---------------------------------------------------------------------------
// Sanitization
// ---------------------------------------------------------------------------

test('no raw, source, identity, or money field appears in the settings DTO', async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(
      `${baseUrl}${CALL_AUDIT_SETTINGS_ROUTE}?detail=${buildRuleVersionId(
        snapshotFixture(),
      )}`,
      { headers: { cookie: localCookie() } },
    )
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
      'scoringConfigJson',
      'phone',
      'email',
      'amount',
      'amountInr',
      'currency',
      'price',
      'rate',
      'cost',
      'invoice',
      'idempotencyKey',
      'correlationId',
      'triggeredBy',
    ]) {
      assert.equal(keys.has(forbidden), false, `key ${forbidden} leaked`)
    }
    assert.equal(
      JSON.stringify(body).includes('ai_voice_leads_received'),
      false,
    )
    // The administrator-authored prompt IS present here, and only here: this is
    // the admin-only detail mode, which exists to review configuration.
    const detail = (body as Record<string, unknown>).detail as Record<
      string,
      unknown
    >
    assert.equal(detail.businessPrompt, SYNTHETIC_PROMPT)
  })
})

test('an unknown detail id reports nothing rather than another version', async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(
      `${baseUrl}${CALL_AUDIT_SETTINGS_ROUTE}?detail=crv_missing`,
      { headers: { cookie: localCookie() } },
    )
    assert.equal(response.status, 200)
    assert.equal(
      ((await response.json()) as Record<string, unknown>).detail,
      null,
    )
  })
})

test('an invalid settings query is rejected with a client-safe problem', async () => {
  await withServer(async (baseUrl) => {
    for (const query of ['versions=0', 'runs=9999', 'detail=crv%20OR%201']) {
      const response = await fetch(
        `${baseUrl}${CALL_AUDIT_SETTINGS_ROUTE}?${query}`,
        { headers: { cookie: localCookie() } },
      )
      assert.equal(response.status, 400, query)
      const problem = (await response.json()) as Record<string, unknown>
      assert.equal(problem.code, 'INVALID_CALL_AUDIT_SETTINGS_QUERY')
      assert.equal(typeof problem.correlationId, 'string')
    }
  })
})

// ---------------------------------------------------------------------------
// Create and activate
// ---------------------------------------------------------------------------

test('an administrator creates a draft version by default', async () => {
  await withServer(async (baseUrl, state) => {
    const response = await post(baseUrl, VALID_DRAFT)
    assert.equal(response.status, 200)
    const body = (await response.json()) as Record<string, unknown>
    assert.equal(body.status, 'draft')
    assert.equal(body.statusLabel, 'Draft')
    assert.equal(body.activated, false)
    assert.equal(body.outcome, 'inserted')
    assert.equal(body.versionLabel, 'call-audit/2026.09.1')
    assert.match(String(body.promptSha256), /^[0-9a-f]{64}$/)

    const [written] = state.saved
    assert.equal(written?.lifecycle.status, 'draft')
    assert.equal(written?.lifecycle.createdBy, 'usr_admin_0001')
    assert.equal(written?.lifecycle.activatedAt, null)
    // Normalized to fixed precision by the existing contract helper.
    assert.equal(written?.snapshot.temperature, '0.200')
    assert.equal(
      state.events.at(-1)?.action,
      'call_audit_rule_version.create',
    )
    assert.equal(state.events.at(-1)?.resourceType, 'call_audit_rule_version')
  })
})

test('an explicit activate writes an active snapshot with an activation stamp', async () => {
  await withServer(
    async (baseUrl, state) => {
      const response = await post(baseUrl, {
        ...VALID_DRAFT,
        activate: true,
      })
      assert.equal(response.status, 200)
      const body = (await response.json()) as Record<string, unknown>
      assert.equal(body.status, 'active')
      assert.equal(body.activated, true)

      const [written] = state.saved
      assert.equal(written?.lifecycle.status, 'active')
      assert.equal(written?.lifecycle.activatedBy, 'usr_admin_0001')
      assert.match(
        String(written?.lifecycle.activatedAt),
        /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{6}$/,
      )
      assert.equal(
        state.events.at(-1)?.action,
        'call_audit_rule_version.activate',
      )
    },
    { active: null },
  )
})

test('activating while another version is live is refused, not merged', async () => {
  await withServer(
    async (baseUrl) => {
      const response = await post(baseUrl, {
        ...VALID_DRAFT,
        activate: true,
      })
      assert.equal(response.status, 409)
      const problem = (await response.json()) as Record<string, unknown>
      assert.equal(problem.code, 'CALL_AUDIT_CONTROL_ERROR')
      assert.match(String(problem.title), /already active/)
    },
    { activeAlready: true },
  )
})

test('an invalid draft is refused with a field-named, value-free problem', async () => {
  await withServer(async (baseUrl, state) => {
    const cases: Array<[unknown, string]> = [
      [
        { ...VALID_DRAFT, temperature: '0.2001' },
        'INVALID_CALL_AUDIT_RULE_DRAFT',
      ],
      [{ ...VALID_DRAFT, temperature: 0.2 }, 'INVALID_CALL_AUDIT_RULE_DRAFT'],
      [{ ...VALID_DRAFT, versionLabel: '' }, 'INVALID_CALL_AUDIT_RULE_DRAFT'],
      [{ ...VALID_DRAFT, businessPrompt: '' }, 'INVALID_CALL_AUDIT_RULE_DRAFT'],
      [
        { ...VALID_DRAFT, activate: 'yes' },
        'INVALID_CALL_AUDIT_SETTINGS_REQUEST',
      ],
      ['not-an-object', 'INVALID_CALL_AUDIT_SETTINGS_REQUEST'],
    ]
    for (const [body, code] of cases) {
      const response = await post(baseUrl, body)
      assert.equal(response.status, 400, JSON.stringify(body))
      const problem = (await response.json()) as Record<string, unknown>
      assert.equal(problem.code, code)
      assert.equal(
        String(problem.title).includes(SYNTHETIC_PROMPT.slice(0, 20)),
        false,
        'a rejection must never echo the submitted prompt',
      )
    }
    assert.equal(state.saved.length, 0)
  })
})

test('a non-JSON settings submission is refused before it is parsed', async () => {
  await withServer(async (baseUrl, state) => {
    const response = await fetch(
      `${baseUrl}${CALL_AUDIT_SETTINGS_ROUTE}`,
      {
        method: 'POST',
        headers: {
          cookie: localCookie(),
          'content-type': 'text/plain',
        },
        body: 'versionLabel=x',
      },
    )
    assert.equal(response.status, 415)
    assert.equal(state.saved.length, 0)
  })
})

test('the sanitized report route stays reachable and unchanged for a user', async () => {
  await withServer(
    async (baseUrl) => {
      // The settings route is admin-only; the reporting route is not gated on
      // it, so the two modules cannot become one permission.
      const settings = await fetch(
        `${baseUrl}${CALL_AUDIT_SETTINGS_ROUTE}`,
        { headers: { cookie: localCookie() } },
      )
      assert.equal(settings.status, 403)
      const method = await fetch(`${baseUrl}/api/v1/call-audit/report`, {
        method: 'POST',
        headers: { cookie: localCookie() },
      })
      assert.equal(method.status, 405)
    },
    { roles: ['user'] },
  )
})
