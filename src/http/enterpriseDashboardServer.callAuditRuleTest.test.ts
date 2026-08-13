import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { AddressInfo } from 'node:net'
import { readFileSync } from 'node:fs'
import type { Pool } from 'mysql2/promise'
import type { AccessRepository, AccessUser } from '../auth/types.ts'
import type { AuditEvent, AuditSink } from '../audit/types.ts'
import type { RuntimeConfig } from '../config/runtime.ts'
import {
  createLocalPasswordHash,
  issueLocalSession,
} from '../auth/localSession.ts'
import { createEnterpriseDashboardServer } from './enterpriseDashboardServer.ts'
import { buildRuleVersionId } from '../adapters/mysqlCallAuditControl.ts'
import { buildRuleActivation } from '../callaudit/ruleActivation.ts'
import { CALL_AUDIT_RUBRIC } from '../callaudit/rubric.ts'
import {
  CALL_AUDIT_RULE_TEST_ROUTE,
  CALL_AUDIT_SETTINGS_ROUTE,
  type CallAuditRuleVersionDetailRecord,
  type CallAuditRuleVersionRecord,
  type CallAuditSettingsReadPort,
} from '../callaudit/adminSettings.ts'
import {
  createContentAuditModelAdapter,
  MAX_TRANSCRIPT_LENGTH,
  type ContentAuditModelAdapter,
  type ContentAuditModelRequest,
  type ContentAuditModelResult,
  type ContentAuditUsageFacts,
} from '../adapters/openaiCallAuditModel.ts'
import type { ValidatedContentAuditOutput } from '../callaudit/modelOutput.ts'

/**
 * HTTP contract of the ADMIN-ONLY Call Audit rule TEST LAB.
 *
 * Everything is synthetic: an in-memory settings read port stands in for MySQL,
 * an in-memory model port stands in for a provider, and no test here can reach a
 * network or a database. The transcript, the prompt, and the model's prose all
 * carry distinctive markers, so a leak into a response, a problem, or an audit
 * event is unmistakable. No lead, source row, recording, or money value exists
 * anywhere in this file.
 */

const config: RuntimeConfig = {
  environment: 'test',
  host: '127.0.0.1',
  port: 4177,
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
      Buffer.alloc(16, 5),
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

// ---------------------------------------------------------------------------
// Synthetic fixtures
// ---------------------------------------------------------------------------

const TRANSCRIPT = [
  'SYNTHETIC-TRANSCRIPT-MARKER-9f02',
  'Saanvi: greeted the caller and described the programme.',
  'Caller: asked for the details in writing.',
].join('\n')

const SYNTHETIC_PROMPT =
  'SYNTHETIC-BUSINESS-PROMPT-MARKER-4c18: assess each conversation against ' +
  'the approved rubric and report only the structured fields.'

const SNAPSHOT = buildRuleActivation({
  versionLabel: 'call-audit/2026.08.1',
  businessPrompt: SYNTHETIC_PROMPT,
  modelProvider: 'synthetic-provider',
  modelName: 'synthetic-model',
  modelVersion: '2026-08-01',
  temperature: '0.200',
})

const RULE_VERSION_ID = buildRuleVersionId(SNAPSHOT)

function versionRecord(): CallAuditRuleVersionRecord {
  return {
    ruleVersionId: RULE_VERSION_ID,
    versionLabel: SNAPSHOT.versionLabel,
    status: 'active',
    promptSha256: SNAPSHOT.promptSha256,
    modelProvider: SNAPSHOT.modelProvider,
    modelName: SNAPSHOT.modelName,
    modelVersion: SNAPSHOT.modelVersion,
    temperature: SNAPSHOT.temperature,
    ruleContractVersion: SNAPSHOT.ruleContractVersion,
    outputSchemaVersion: SNAPSHOT.outputSchemaVersion,
    taxonomyVersion: SNAPSHOT.taxonomyVersion,
    scoringConfigVersion: SNAPSHOT.scoringConfigVersion,
    configSha256: SNAPSHOT.configSha256,
    changeReason: 'Approved for live auditing.',
    createdBy: 'usr_admin_0001',
    createdAt: '2026-08-01 09:00:00.000000',
    activatedBy: 'usr_admin_0001',
    activatedAt: '2026-08-01 09:30:00.000000',
    retiredBy: null,
    retiredAt: null,
  }
}

function usageFacts(): ContentAuditUsageFacts {
  return {
    provider: 'synthetic-provider',
    modelName: 'synthetic-model',
    modelVersion: '2026-08-01',
    requestId: 'req_synthetic_lab_1',
    inputTokens: '1200',
    outputTokens: '340',
    totalTokens: '1540',
    latencyMs: '125',
  }
}

/** An in-memory OpenAI-compatible client. No test here can reach a network. */
function fakeChatClient() {
  return {
    async createChatCompletion() {
      return {
        choices: [
          {
            message: {
              content: JSON.stringify({
                callConnected: true,
                customerSpoke: true,
                meaningfulConversation: true,
                intent: 'WARM',
                detailedOutcome: 'Treatment Package for Resort',
                qualification: 'QUALIFIED',
                nextAction: 'SEND_DETAILS_EMAIL',
                confidence: 0.75,
                metricScores: CALL_AUDIT_RUBRIC.map((metric) => ({
                  metric: metric.code,
                  score: 4,
                })),
                issueFlags: ['WEAK_NEXT_STEP'],
                managementSummary:
                  'SYNTHETIC-SUMMARY-MARKER-51ac: written details requested.',
                kserveFeedback:
                  'SYNTHETIC-FEEDBACK-MARKER-51ac: confirm the next channel.',
                improvementFeedback:
                  'SYNTHETIC-IMPROVEMENT-MARKER-51ac: state the step.',
              }),
            },
          },
        ],
      }
    },
  }
}

/**
 * Produces a genuinely validated output by running the real adapter over the
 * fake client, so the endpoint is asserted against a shape a validator approved
 * rather than a hand-built object.
 */
async function validatedOutput(): Promise<ValidatedContentAuditOutput> {
  const result = await createContentAuditModelAdapter({
    client: fakeChatClient(),
  }).auditTranscript({
    activation: SNAPSHOT,
    transcript: TRANSCRIPT,
  })
  if (result.status !== 'succeeded') {
    throw new Error('the synthetic fixture did not validate')
  }
  return result.output
}

interface FakeModel {
  requests: ContentAuditModelRequest[]
  model: ContentAuditModelAdapter
}

/** Records every request it is given and answers with a canned outcome. */
function fakeModel(outcome: ContentAuditModelResult): FakeModel {
  const requests: ContentAuditModelRequest[] = []
  return {
    requests,
    model: {
      async auditTranscript(request) {
        requests.push(request)
        return outcome
      },
    },
  }
}

interface RecordedRead {
  method: string
  argument: unknown
}

function readPort(
  reads: RecordedRead[],
  options: {
    active?: CallAuditRuleVersionRecord | null
    detail?: boolean
  } = {},
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
      if (options.detail === false) return null
      if (!active || active.ruleVersionId !== ruleVersionId) return null
      const detail: CallAuditRuleVersionDetailRecord = {
        ...active,
        businessPrompt: SYNTHETIC_PROMPT,
      }
      return detail
    },
    async listRecentRuns(limit) {
      reads.push({ method: 'listRecentRuns', argument: limit })
      return []
    },
  }
}

interface ServerState {
  events: AuditEvent[]
  reads: RecordedRead[]
  requests: ContentAuditModelRequest[]
}

async function withServer(
  run: (baseUrl: string, state: ServerState) => Promise<void>,
  options: {
    roles?: string[]
    active?: CallAuditRuleVersionRecord | null
    detail?: boolean
    outcome?: ContentAuditModelResult
    withoutModel?: boolean
    /**
     * Injects the REAL content-audit adapter over the fake client instead of a
     * canned port, so the bounds the adapter owns — a blank or over-long
     * transcript, an impossible duration — are exercised for real.
     */
    realAdapter?: boolean
  } = {},
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
      return [[{ one: 1 }], []]
    },
    async execute() {
      throw new Error('the synthetic repositories must be used instead')
    },
  } as unknown as Pool
  const outcome =
    options.outcome ??
    ({
      status: 'succeeded',
      output: await validatedOutput(),
      usage: usageFacts(),
    } satisfies ContentAuditModelResult)
  const fake = fakeModel(outcome)
  const server = createEnterpriseDashboardServer({
    config,
    pool,
    access: accessFor(options.roles ?? ['admin']),
    audit,
    verifier: null,
    callAuditSettings: readPort(reads, {
      active: options.active,
      detail: options.detail,
    }),
    callAuditRuleTestModel: options.withoutModel
      ? undefined
      : options.realAdapter
        ? createContentAuditModelAdapter({ client: fakeChatClient() })
        : fake.model,
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as AddressInfo
  try {
    await run(`http://127.0.0.1:${address.port}`, {
      events,
      reads,
      requests: fake.requests,
    })
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    )
  }
}

function post(
  baseUrl: string,
  body: unknown,
  init: { headers?: Record<string, string>; raw?: string } = {},
): Promise<Response> {
  return fetch(`${baseUrl}${CALL_AUDIT_RULE_TEST_ROUTE}`, {
    method: 'POST',
    headers: {
      cookie: localCookie(),
      'content-type': 'application/json',
      ...init.headers,
    },
    body: init.raw ?? JSON.stringify(body),
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
// Success
// ---------------------------------------------------------------------------

test('an administrator tests an explicitly named rule version', async () => {
  await withServer(async (baseUrl, state) => {
    const response = await post(baseUrl, {
      transcript: TRANSCRIPT,
      ruleVersionId: RULE_VERSION_ID,
      context: { language: 'hi', durationSeconds: 96 },
    })
    assert.equal(response.status, 200)
    const body = (await response.json()) as Record<string, unknown>
    assert.equal(body.ruleVersionId, RULE_VERSION_ID)
    assert.match(String(body.boundary), /never stored/)
    const result = body.result as Record<string, unknown>
    assert.equal(result.status, 'succeeded')
    const metadata = result.metadata as Record<string, unknown>
    assert.equal(metadata.versionLabel, 'call-audit/2026.08.1')
    assert.equal(metadata.temperature, '0.200')
    assert.equal(metadata.transcriptCharacterCount, TRANSCRIPT.length)
    assert.equal(metadata.transcriptLineCount, 3)
    const output = result.output as Record<string, unknown>
    assert.equal(output.intent, 'WARM')
    assert.equal(output.groupedOutcome, 'RESORT_HEALING')

    // Named explicitly, so the active-version lookup is never issued.
    assert.deepEqual(
      state.reads.map((read) => read.method),
      ['getRuleVersionDetail'],
    )
    assert.equal(state.reads[0]?.argument, RULE_VERSION_ID)
    assert.equal(state.requests.length, 1)
    assert.equal(state.events.at(-1)?.action, 'call_audit_rule_test.run')
    assert.equal(state.events.at(-1)?.outcome, 'success')
    assert.equal(state.events.at(-1)?.resourceType, 'call_audit_rule_version')
    assert.equal(state.events.at(-1)?.resourceId, RULE_VERSION_ID)
  })
})

test('omitting the id tests the active version through an explicit detail read', async () => {
  await withServer(async (baseUrl, state) => {
    const response = await post(baseUrl, { transcript: TRANSCRIPT })
    assert.equal(response.status, 200)
    const body = (await response.json()) as Record<string, unknown>
    assert.equal(body.ruleVersionId, RULE_VERSION_ID)
    assert.equal(
      (body.result as Record<string, unknown>).status,
      'succeeded',
    )
    // The prompt is fetched by an explicit detail read for the active id, never
    // as a side effect of listing versions.
    assert.deepEqual(
      state.reads.map((read) => read.method),
      ['getActiveRuleVersion', 'getRuleVersionDetail'],
    )
    assert.equal(state.requests.length, 1)
  })
})

test('the model receives the exact transcript and nothing but safe context', async () => {
  await withServer(async (baseUrl, state) => {
    const response = await post(baseUrl, {
      transcript: TRANSCRIPT,
      ruleVersionId: RULE_VERSION_ID,
      context: {
        language: 'hi',
        durationSeconds: 96,
        // Everything below is dropped by the submission parser: none of it is
        // part of the accepted vocabulary, so none of it can reach a provider.
        leadId: 'lead-should-not-travel',
        sourceRowId: 987,
        phone: '+910000000000',
        email: 'nobody@example.test',
        customerName: 'Should Not Travel',
        recordingUrl: 'https://example.invalid/recording.ogg',
      },
      leadId: 'lead-should-not-travel',
      sourceRowId: 987,
      amount: '1000.00',
    })
    assert.equal(response.status, 200)
    assert.equal(state.requests.length, 1)
    const [sent] = state.requests
    assert.equal(sent?.transcript, TRANSCRIPT)
    assert.deepEqual(sent?.context, { language: 'hi', durationSeconds: 96 })
    assert.equal(sent?.activation.businessPrompt, SYNTHETIC_PROMPT)
    assert.deepEqual(Object.keys(sent ?? {}).sort(), [
      'activation',
      'context',
      'transcript',
    ])
    const serializedRequest = JSON.stringify(state.requests)
    for (const marker of [
      'lead-should-not-travel',
      '987',
      '+910000000000',
      'nobody@example.test',
      'Should Not Travel',
      'recording.ogg',
      '1000.00',
    ]) {
      assert.equal(
        serializedRequest.includes(marker),
        false,
        `${marker} must not reach the model request`,
      )
    }
  })
})

test('a returned refusal is reported as an outcome, not as a server error', async () => {
  await withServer(
    async (baseUrl, state) => {
      const response = await post(baseUrl, {
        transcript: TRANSCRIPT,
        ruleVersionId: RULE_VERSION_ID,
      })
      assert.equal(response.status, 200)
      const result = (
        (await response.json()) as Record<string, unknown>
      ).result as Record<string, unknown>
      assert.equal(result.status, 'refused')
      assert.deepEqual(result.failure, {
        kind: 'refusal',
        errorCode: 'MODEL_REFUSED',
      })
      assert.equal(state.events.at(-1)?.outcome, 'success')
    },
    {
      outcome: {
        status: 'refused',
        failure: { kind: 'refusal', errorCode: 'MODEL_REFUSED' },
        usage: usageFacts(),
      },
    },
  )
})

// ---------------------------------------------------------------------------
// Access control
// ---------------------------------------------------------------------------

test('a normal logged-in user is denied the rule test', async () => {
  await withServer(
    async (baseUrl, state) => {
      const response = await post(baseUrl, {
        transcript: TRANSCRIPT,
        ruleVersionId: RULE_VERSION_ID,
      })
      assert.equal(response.status, 403)
      const problem = (await response.json()) as Record<string, unknown>
      assert.equal(problem.code, 'PERMISSION_DENIED')
      // Denied before anything was read, tested, or submitted to a model.
      assert.equal(state.reads.length, 0)
      assert.equal(state.requests.length, 0)
      assert.equal(state.events.at(-1)?.outcome, 'denied')
      assert.equal(state.events.at(-1)?.action, 'call_audit_rule_test.run')
    },
    { roles: ['user'] },
  )
})

test('the rule test requires an authenticated session', async () => {
  await withServer(async (baseUrl, state) => {
    const response = await fetch(`${baseUrl}${CALL_AUDIT_RULE_TEST_ROUTE}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ transcript: TRANSCRIPT }),
    })
    assert.equal(response.status, 401)
    assert.equal(
      ((await response.json()) as Record<string, unknown>).code,
      'AUTH_REQUIRED',
    )
    assert.equal(state.reads.length, 0)
    assert.equal(state.requests.length, 0)
  })
})

test('the rule test is POST only', async () => {
  await withServer(async (baseUrl, state) => {
    for (const method of ['GET', 'PUT', 'DELETE']) {
      const response = await fetch(`${baseUrl}${CALL_AUDIT_RULE_TEST_ROUTE}`, {
        method,
        headers: { cookie: localCookie() },
      })
      assert.equal(response.status, 405, method)
      assert.equal(
        ((await response.json()) as Record<string, unknown>).code,
        'METHOD_NOT_ALLOWED',
      )
    }
    assert.equal(state.requests.length, 0)
  })
})

test('non-admin Call Audit surfaces stay closed and the report rejects writes', async () => {
  await withServer(
    async (baseUrl) => {
      const test = await post(baseUrl, { transcript: TRANSCRIPT })
      assert.equal(test.status, 403)
      const settings = await fetch(`${baseUrl}${CALL_AUDIT_SETTINGS_ROUTE}`, {
        headers: { cookie: localCookie() },
      })
      assert.equal(settings.status, 403)
      // The report is administrator-only too, and remains read-only: a POST is
      // rejected as a method error without becoming a reporting write path.
      const method = await fetch(`${baseUrl}/api/v1/call-audit/report`, {
        method: 'POST',
        headers: { cookie: localCookie() },
      })
      assert.equal(method.status, 405)
    },
    { roles: ['user'] },
  )
})

// ---------------------------------------------------------------------------
// Unavailable dependencies
// ---------------------------------------------------------------------------

test('a missing model port reports 503 without reading a prompt', async () => {
  await withServer(
    async (baseUrl, state) => {
      const response = await post(baseUrl, {
        transcript: TRANSCRIPT,
        ruleVersionId: RULE_VERSION_ID,
      })
      assert.equal(response.status, 503)
      const problem = (await response.json()) as Record<string, unknown>
      assert.equal(problem.code, 'CALL_AUDIT_RULE_TEST_UNAVAILABLE')
      assert.equal(typeof problem.correlationId, 'string')
      // No version was resolved and no prompt was fetched.
      assert.equal(state.reads.length, 0)
      assert.equal(state.events.at(-1)?.action, 'call_audit_rule_test.run')
      assert.equal(state.events.at(-1)?.outcome, 'failure')
      assert.equal(
        JSON.stringify(problem).includes('SYNTHETIC-TRANSCRIPT-MARKER'),
        false,
      )
    },
    { withoutModel: true },
  )
})

test('an unknown or unavailable rule version is a safe, quiet failure', async () => {
  await withServer(
    async (baseUrl, state) => {
      const response = await post(baseUrl, {
        transcript: TRANSCRIPT,
        ruleVersionId: 'crv_missing_0001',
      })
      assert.equal(response.status, 404)
      const problem = (await response.json()) as Record<string, unknown>
      assert.equal(problem.code, 'CALL_AUDIT_RULE_VERSION_NOT_FOUND')
      assert.equal(state.requests.length, 0)
      assert.equal(
        JSON.stringify(problem).includes('SYNTHETIC-'),
        false,
        'a rejection must echo neither the transcript nor the prompt',
      )
    },
    { detail: false },
  )
})

test('testing with no active version asks for one rather than guessing', async () => {
  await withServer(
    async (baseUrl, state) => {
      const response = await post(baseUrl, { transcript: TRANSCRIPT })
      assert.equal(response.status, 409)
      assert.equal(
        ((await response.json()) as Record<string, unknown>).code,
        'CALL_AUDIT_RULE_VERSION_NOT_ACTIVE',
      )
      assert.deepEqual(
        state.reads.map((read) => read.method),
        ['getActiveRuleVersion'],
      )
      assert.equal(state.requests.length, 0)
    },
    { active: null },
  )
})

// ---------------------------------------------------------------------------
// Rejected submissions
// ---------------------------------------------------------------------------

test('an invalid submission is refused with a field-named, value-free problem', async () => {
  await withServer(async (baseUrl, state) => {
    const cases: Array<[unknown, number, string]> = [
      [
        { transcript: 42, ruleVersionId: RULE_VERSION_ID },
        400,
        'INVALID_CALL_AUDIT_RULE_TEST',
      ],
      [{ ruleVersionId: RULE_VERSION_ID }, 400, 'INVALID_CALL_AUDIT_RULE_TEST'],
      ['not-an-object', 400, 'INVALID_CALL_AUDIT_RULE_TEST'],
      [
        { transcript: TRANSCRIPT, ruleVersionId: "crv' OR 1" },
        400,
        'INVALID_CALL_AUDIT_RULE_TEST',
      ],
      [
        { transcript: TRANSCRIPT, context: 'hi' },
        400,
        'INVALID_CALL_AUDIT_RULE_TEST',
      ],
    ]
    for (const [body, status, code] of cases) {
      const response = await post(baseUrl, body)
      assert.equal(response.status, status, JSON.stringify(code))
      const problem = (await response.json()) as Record<string, unknown>
      assert.equal(problem.code, code)
      assert.equal(
        JSON.stringify(problem).includes('SYNTHETIC-TRANSCRIPT-MARKER'),
        false,
        'a rejection must never echo the submitted transcript',
      )
    }
    // A rejected submission never reaches the provider port.
    assert.equal(state.requests.length, 0)
  })
})

test('the adapter stays authoritative for what may reach a model', async () => {
  await withServer(
    async (baseUrl) => {
      const cases: unknown[] = [
        { transcript: '   ', ruleVersionId: RULE_VERSION_ID },
        {
          transcript: TRANSCRIPT.padEnd(MAX_TRANSCRIPT_LENGTH + 1, 'x'),
          ruleVersionId: RULE_VERSION_ID,
        },
        {
          transcript: TRANSCRIPT,
          ruleVersionId: RULE_VERSION_ID,
          context: { durationSeconds: -1 },
        },
        {
          transcript: TRANSCRIPT,
          ruleVersionId: RULE_VERSION_ID,
          context: { language: 'x'.repeat(200) },
        },
      ]
      for (const body of cases) {
        const response = await post(baseUrl, body)
        assert.equal(response.status, 400)
        const problem = (await response.json()) as Record<string, unknown>
        // The adapter's own typed error: field-named, and value-free.
        assert.equal(problem.code, 'INVALID_CALL_AUDIT_MODEL_REQUEST')
        assert.equal(
          JSON.stringify(problem).includes('SYNTHETIC-TRANSCRIPT-MARKER'),
          false,
          'a rejection must never echo the submitted transcript',
        )
      }
      // A valid submission still succeeds through the same real adapter.
      const ok = await post(baseUrl, {
        transcript: TRANSCRIPT,
        ruleVersionId: RULE_VERSION_ID,
      })
      assert.equal(ok.status, 200)
      assert.equal(
        ((await ok.json()) as { result: { status: string } }).result.status,
        'succeeded',
      )
    },
    { realAdapter: true },
  )
})

test('a non-JSON, malformed, or oversized body is refused safely', async () => {
  await withServer(async (baseUrl, state) => {
    const media = await post(baseUrl, null, {
      headers: { 'content-type': 'text/plain' },
      raw: `transcript=${TRANSCRIPT}`,
    })
    assert.equal(media.status, 415)
    assert.equal(
      ((await media.json()) as Record<string, unknown>).code,
      'INVALID_CALL_AUDIT_RULE_TEST_REQUEST',
    )

    const malformed = await post(baseUrl, null, {
      raw: `{"transcript": "${TRANSCRIPT.replaceAll('\n', ' ')}"`,
    })
    assert.equal(malformed.status, 400)
    const malformedProblem = (await malformed.json()) as Record<string, unknown>
    assert.equal(
      malformedProblem.code,
      'INVALID_CALL_AUDIT_RULE_TEST_REQUEST',
    )
    assert.equal(
      JSON.stringify(malformedProblem).includes('SYNTHETIC-TRANSCRIPT-MARKER'),
      false,
      'a parser failure must not quote the submitted body',
    )

    const oversized = await post(baseUrl, {
      transcript: TRANSCRIPT.padEnd(1_100_000, 'x'),
    })
    assert.equal(oversized.status, 413)
    const oversizedProblem = (await oversized.json()) as Record<string, unknown>
    assert.equal(
      JSON.stringify(oversizedProblem).includes('SYNTHETIC-TRANSCRIPT-MARKER'),
      false,
    )

    assert.equal(state.reads.length, 0)
    assert.equal(state.requests.length, 0)
  })
})

// ---------------------------------------------------------------------------
// Sanitization of the response
// ---------------------------------------------------------------------------

const FORBIDDEN_KEYS = [
  'transcript',
  'transcriptText',
  'transcriptSha256',
  'businessPrompt',
  'prompt',
  'compiledPrompt',
  'messages',
  'raw',
  'rawResponse',
  'errorDetail',
  'errorMessage',
  'refusal',
  'leadId',
  'sourceRowId',
  'sourceRefId',
  'sourceUrl',
  'recordingUrl',
  'taskId',
  'callId',
  'phone',
  'email',
  'customerName',
  'managementSummary',
  'kserveFeedback',
  'improvementFeedback',
  'amount',
  'currency',
  'price',
  'rate',
  'cost',
  'invoice',
  'billable',
]

test('no transcript, prompt, provider prose, identity, or money is returned', async () => {
  await withServer(async (baseUrl, state) => {
    const response = await post(baseUrl, {
      transcript: TRANSCRIPT,
      ruleVersionId: RULE_VERSION_ID,
      context: { language: 'hi', durationSeconds: 96 },
    })
    assert.equal(response.status, 200)
    const body = await response.json()
    const keys = deepKeys(body)
    for (const forbidden of FORBIDDEN_KEYS) {
      assert.equal(keys.has(forbidden), false, `key ${forbidden} leaked`)
    }
    const serialized = JSON.stringify(body)
    for (const pattern of [
      /SYNTHETIC-TRANSCRIPT-MARKER/,
      /SYNTHETIC-BUSINESS-PROMPT-MARKER/,
      /SYNTHETIC-SUMMARY-MARKER/,
      /SYNTHETIC-FEEDBACK-MARKER/,
      /SYNTHETIC-IMPROVEMENT-MARKER/,
      /ai_voice_leads_received/i,
      /\bprice\b/i,
      /\brate\b/i,
      /\bcost\b/i,
      /\bamount\b/i,
      /\bcurrency\b/i,
      /\binvoice\b/i,
      /\bbillable\b/i,
    ]) {
      assert.equal(
        pattern.test(serialized),
        false,
        `the response must not match ${pattern}`,
      )
    }
    // The audit trail records that a test ran, never what was submitted.
    const events = JSON.stringify(state.events)
    assert.equal(events.includes('SYNTHETIC-TRANSCRIPT-MARKER'), false)
    assert.equal(events.includes('SYNTHETIC-BUSINESS-PROMPT-MARKER'), false)
  })
})

test('this test file runs under the call audit test script', () => {
  const manifest = JSON.parse(
    readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
  ) as { scripts: Record<string, string> }
  assert.ok(
    (manifest.scripts['test:callaudit'] ?? '').includes(
      'src/http/enterpriseDashboardServer.callAuditRuleTest.test.ts',
    ),
  )
})
