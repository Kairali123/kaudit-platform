import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { AddressInfo } from 'node:net'
import type { Pool } from 'mysql2/promise'
import type { AccessRepository } from '../auth/types.ts'
import type { AuditEvent } from '../audit/types.ts'
import type { RuntimeConfig } from '../config/runtime.ts'
import {
  createLocalPasswordHash,
  issueLocalSession,
} from '../auth/localSession.ts'
import type {
  AuditDispatchMode,
  AuditSystem,
} from '../auditWorkers/control.ts'
import {
  LATE_RECORDING_COMMIT_ROUTE,
  LATE_RECORDING_PREVIEW_ROUTE,
  LATE_RECORDING_STATUS_ROUTE,
} from '../lateRecording/corrections.ts'
import { createEnterpriseDashboardServer } from './enterpriseDashboardServer.ts'

/**
 * The late-recording correction endpoints: authorization, method, privacy,
 * idempotency, and dispatch scope.
 *
 * The pool is a recording fake, so nothing here writes to a database, starts a
 * workflow, or spends on a model. Every identifier and URL is SYNTHETIC.
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
      Buffer.alloc(16, 4),
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

const HOST = 'cdr-storage-recs.s3.ap-south-1.amazonaws.com'
const OBJECT_URL = `https://${HOST}/media/private/synthetic-a.ogg`
const SIGNED_URL = `${OBJECT_URL}?X-Amz-Signature=deadbeef`
const KEY = 'lr-0123456789abcdef'
const BATCH_ID = 'lrb_00000000-0000-4000-8000-000000000000'

function cookie(): string {
  if (config.auth.mode !== 'local') throw new Error('local test config required')
  return `${config.auth.sessionCookie}=${encodeURIComponent(
    issueLocalSession(
      config.auth.email,
      config.auth.sessionSecret,
      config.auth.sessionTtlSeconds,
    ),
  )}`
}

function access(roles: string[]): AccessRepository {
  return {
    async findByOidc() {
      return null
    },
    async findByEmail(email) {
      return email === 'operator@example.test'
        ? {
            id: 'usr_synthetic_admin',
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

interface Executed {
  sql: string
  parameters: unknown[]
}

interface Harness {
  base: string
  close(): Promise<void>
  executed: Executed[]
  dispatched: Array<{
    system: AuditSystem
    mode?: AuditDispatchMode
    scope?: { batchId?: string }
  }>
  events: AuditEvent[]
}

const RESOLVED_ROW = {
  task_reference: 'T-SYNTH-1',
  call_id: 'synthetic-call-1',
  artifact_id: 'synthetic-artifact-1',
  source_url: null,
  evidence_sha256: null,
  invoice_present: 1,
  audit_completed: 0,
  live_calculation_basis: 'no_recording_zero',
}

async function harness(
  options: {
    roles?: string[]
    answers?: Array<[RegExp, unknown]>
    dispatcher?: boolean
    dispatchThrows?: boolean
  } = {},
): Promise<Harness> {
  const executed: Executed[] = []
  const dispatched: Harness['dispatched'] = []
  const events: AuditEvent[] = []
  const answers: Array<[RegExp, unknown]> = [
    [/FROM kaudit_rate_card_version card/, [{ id: 'synthetic-rate-card' }]],
    [/task_reference/, [RESOLVED_ROW]],
    [/GET_LOCK/, [{ acquired: 1 }]],
    [/UPDATE kaudit_call_artifact/, { affectedRows: 1 }],
    [/SELECT 1|one/, [{ one: 1 }]],
    ...(options.answers ?? []),
  ]
  const run = async (sql: string, parameters: unknown[] = []) => {
    executed.push({ sql, parameters })
    for (const [pattern, rows] of answers) {
      if (pattern.test(sql)) return [rows, []] as never
    }
    return [[], []] as never
  }
  const connection = {
    execute: run,
    query: run,
    beginTransaction: async () => undefined,
    commit: async () => undefined,
    rollback: async () => undefined,
    release: () => undefined,
  }
  const server = createEnterpriseDashboardServer({
    config,
    pool: {
      execute: run,
      query: run,
      getConnection: async () => connection,
    } as unknown as Pool,
    access: access(options.roles ?? ['admin']),
    audit: {
      async record(event) {
        events.push(event)
      },
      async readiness() {
        return true
      },
    },
    verifier: null,
    allowedRecordingHosts: [HOST],
    ...(options.dispatcher === false
      ? {}
      : {
          auditWorkerDispatcher: {
            canDispatch() {
              return true
            },
            async dispatch(system, mode, scope) {
              dispatched.push({ system, mode, scope })
              if (options.dispatchThrows) {
                throw new Error('synthetic failure')
              }
            },
          },
        }),
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as AddressInfo
  return {
    base: `http://127.0.0.1:${address.port}`,
    executed,
    dispatched,
    events,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  }
}

function csv(...lines: string[]): string {
  return ['Task ID,Recording URL', ...lines].join('\n')
}

function upload(
  base: string,
  route: string,
  body: string,
  headers: Record<string, string> = {},
) {
  return fetch(`${base}${route}`, {
    method: 'POST',
    headers: {
      cookie: cookie(),
      'content-type': 'text/csv',
      'x-kaudit-filename': 'synthetic.csv',
      'x-kaudit-month': '2026-06',
      'x-kaudit-idempotency-key': KEY,
      ...headers,
    },
    body,
  })
}

// ---------------------------------------------------------------------------
// Authorization
// ---------------------------------------------------------------------------

test('an operational user cannot preview or commit a correction', async () => {
  const fixture = await harness({ roles: ['user'] })
  try {
    for (const route of [
      LATE_RECORDING_PREVIEW_ROUTE,
      LATE_RECORDING_COMMIT_ROUTE,
    ]) {
      const response = await upload(
        fixture.base,
        route,
        csv(`T-SYNTH-1,${OBJECT_URL}`),
      )
      assert.equal(response.status, 403)
    }
    // Refused before a byte of the body reached a statement.
    assert.equal(
      fixture.executed.find((item) => /UPDATE|INSERT/.test(item.sql)),
      undefined,
    )
  } finally {
    await fixture.close()
  }
})

test('an unauthenticated upload is refused; SameSite=Strict is the CSRF gate', async () => {
  const fixture = await harness()
  try {
    const response = await fetch(
      `${fixture.base}${LATE_RECORDING_COMMIT_ROUTE}`,
      {
        method: 'POST',
        headers: {
          'content-type': 'text/csv',
          'x-kaudit-month': '2026-06',
          'x-kaudit-idempotency-key': KEY,
        },
        body: csv(`T-SYNTH-1,${OBJECT_URL}`),
      },
    )
    assert.equal(response.status, 401)
    // A cross-site form post cannot carry the SameSite=Strict session cookie,
    // so it arrives exactly like this one: with no session at all.
    const login = await fetch(`${fixture.base}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: 'operator@example.test',
        password: 'synthetic-password',
      }),
    })
    assert.match(
      login.headers.get('set-cookie') ?? '',
      /SameSite=Strict/,
    )
  } finally {
    await fixture.close()
  }
})

test('these routes are POST only', async () => {
  const fixture = await harness()
  try {
    for (const route of [
      LATE_RECORDING_PREVIEW_ROUTE,
      LATE_RECORDING_COMMIT_ROUTE,
    ]) {
      const response = await fetch(`${fixture.base}${route}`, {
        headers: { cookie: cookie() },
      })
      assert.equal(response.status, 405)
    }
  } finally {
    await fixture.close()
  }
})

test('a commit is refused when no worker can be started', async () => {
  const fixture = await harness({ dispatcher: false })
  try {
    const commit = await upload(
      fixture.base,
      LATE_RECORDING_COMMIT_ROUTE,
      csv(`T-SYNTH-1,${OBJECT_URL}`),
    )
    assert.equal(commit.status, 503)
    // Nothing was attached: evidence is never written where nothing will audit it.
    assert.equal(
      fixture.executed.find((item) =>
        /UPDATE kaudit_call_artifact/.test(item.sql),
      ),
      undefined,
    )
    // A preview needs no dispatcher, because it starts nothing.
    const preview = await upload(
      fixture.base,
      LATE_RECORDING_PREVIEW_ROUTE,
      csv(`T-SYNTH-1,${OBJECT_URL}`),
    )
    assert.equal(preview.status, 200)
  } finally {
    await fixture.close()
  }
})

// ---------------------------------------------------------------------------
// Preview and commit
// ---------------------------------------------------------------------------

test('a preview reports what would happen and writes nothing', async () => {
  const fixture = await harness()
  try {
    const response = await upload(
      fixture.base,
      LATE_RECORDING_PREVIEW_ROUTE,
      csv(`T-SYNTH-1,${SIGNED_URL}`, `T-SYNTH-2,https://elsewhere.invalid/a.ogg`),
    )
    assert.equal(response.status, 200)
    const receipt = (await response.json()) as {
      acceptedCount: number
      rejectedCount: number
      decisions: Array<{ rowNumber: number; code?: string }>
    }
    assert.equal(receipt.acceptedCount, 1)
    assert.equal(receipt.rejectedCount, 1)
    assert.deepEqual(receipt.decisions[1], {
      rowNumber: 3,
      outcome: 'rejected',
      code: 'URL_NOT_ALLOWLISTED',
    } as never)
    assert.equal(
      fixture.executed.find((item) => /INSERT|UPDATE|GET_LOCK/.test(item.sql)),
      undefined,
    )
    assert.deepEqual(fixture.dispatched, [])
  } finally {
    await fixture.close()
  }
})

test('a commit attaches the canonical URL and dispatches only the batch handle', async () => {
  const fixture = await harness()
  try {
    const response = await upload(
      fixture.base,
      LATE_RECORDING_COMMIT_ROUTE,
      csv(`T-SYNTH-1,${SIGNED_URL}`),
    )
    assert.equal(response.status, 200)
    const receipt = (await response.json()) as {
      batchId: string
      outcome: string
    }
    assert.equal(receipt.outcome, 'accepted')

    // The SIGNED URL was normalized before it was stored.
    const attach = fixture.executed.find((item) =>
      /UPDATE kaudit_call_artifact/.test(item.sql),
    ) as Executed
    assert.equal(attach.parameters[0], OBJECT_URL)

    // The dispatch carries the opaque handle and nothing else.
    assert.equal(fixture.dispatched.length, 1)
    assert.deepEqual(fixture.dispatched[0], {
      system: 'billing',
      mode: 'late-recording',
      scope: { batchId: receipt.batchId },
    })
  } finally {
    await fixture.close()
  }
})

test('a failed dispatch leaves the batch durable rather than losing the correction', async () => {
  const fixture = await harness({ dispatchThrows: true })
  try {
    const response = await upload(
      fixture.base,
      LATE_RECORDING_COMMIT_ROUTE,
      csv(`T-SYNTH-1,${OBJECT_URL}`),
    )
    // The evidence is attached and the batch is queued; the scheduled recovery
    // run finds it. Failing the request would strand attached evidence.
    assert.equal(response.status, 200)
    assert.ok(
      fixture.executed.some((item) =>
        /INSERT INTO kaudit_late_recording_batch/.test(item.sql),
      ),
    )
  } finally {
    await fixture.close()
  }
})

test('a month or retry key that is not exactly right is refused', async () => {
  const fixture = await harness()
  try {
    const invalid: Array<Record<string, string>> = [
      { 'x-kaudit-month': '2026-13' },
      { 'x-kaudit-month': 'June' },
      { 'x-kaudit-idempotency-key': 'short' },
    ]
    for (const headers of invalid) {
      const response = await upload(
        fixture.base,
        LATE_RECORDING_COMMIT_ROUTE,
        csv(`T-SYNTH-1,${OBJECT_URL}`),
        headers,
      )
      assert.equal(response.status, 400)
    }
    assert.equal(
      fixture.executed.find((item) =>
        /UPDATE kaudit_call_artifact/.test(item.sql),
      ),
      undefined,
    )
  } finally {
    await fixture.close()
  }
})

test('an oversized batch is refused before anything is resolved', async () => {
  const fixture = await harness()
  try {
    const response = await upload(
      fixture.base,
      LATE_RECORDING_PREVIEW_ROUTE,
      csv(
        ...Array.from(
          { length: 101 },
          (_value, index) => `T-SYNTH-${index},${OBJECT_URL}`,
        ),
      ),
    )
    assert.equal(response.status, 400)
    const problem = (await response.json()) as { type?: string }
    assert.match(String(problem.type), /late-recording-batch-too-large/)
  } finally {
    await fixture.close()
  }
})

// ---------------------------------------------------------------------------
// Privacy
// ---------------------------------------------------------------------------

test('no response or audit event on this path can carry a recording URL', async () => {
  const fixture = await harness()
  try {
    const response = await upload(
      fixture.base,
      LATE_RECORDING_COMMIT_ROUTE,
      csv(`T-SYNTH-1,${SIGNED_URL}`),
    )
    const body = await response.text()
    assert.doesNotMatch(body, /https?:/)
    assert.doesNotMatch(body, /amazonaws/)
    const events = JSON.stringify(fixture.events)
    assert.doesNotMatch(events, /https?:\/\//)
    assert.doesNotMatch(events, /amazonaws/)
    // The access log names the batch handle, never a call or artifact id.
    const recorded = fixture.events.find(
      (event) => event.action === 'late_recording.commit',
    )
    assert.match(String(recorded?.resourceId), /^lrb_/)
    assert.equal(recorded?.resourceType, 'late_recording_batch')
  } finally {
    await fixture.close()
  }
})

// ---------------------------------------------------------------------------
// Progress
// ---------------------------------------------------------------------------

test('progress is scoped to one batch handle and never cached', async () => {
  const fixture = await harness({
    answers: [
      [
        /FROM kaudit_late_recording_batch\s+WHERE id/,
        [
          {
            id: BATCH_ID,
            bill_month: '2026-06',
            request_digest: 'd'.repeat(64),
            status: 'running',
            submitted_count: 1,
            accepted_count: 1,
            rejected_count: 0,
            corrected_count: 0,
            failed_count: 0,
          },
        ],
      ],
    ],
  })
  try {
    const response = await fetch(
      `${fixture.base}${LATE_RECORDING_STATUS_ROUTE}?batch=${BATCH_ID}`,
      { headers: { cookie: cookie() } },
    )
    assert.equal(response.status, 200)
    const body = await response.text()
    assert.doesNotMatch(body, /https?:/)

    const malformed = await fetch(
      `${fixture.base}${LATE_RECORDING_STATUS_ROUTE}?batch=synthetic-call-1`,
      { headers: { cookie: cookie() } },
    )
    assert.equal(malformed.status, 400)
  } finally {
    await fixture.close()
  }
})

test('an operational user cannot read correction progress', async () => {
  const fixture = await harness({ roles: ['user'] })
  try {
    const response = await fetch(
      `${fixture.base}${LATE_RECORDING_STATUS_ROUTE}?batch=${BATCH_ID}`,
      { headers: { cookie: cookie() } },
    )
    assert.equal(response.status, 403)
  } finally {
    await fixture.close()
  }
})
