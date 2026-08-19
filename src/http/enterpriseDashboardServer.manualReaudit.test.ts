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
import type { AuditDispatchMode } from '../auditWorkers/control.ts'
import {
  ManualReauditError,
  MANUAL_REAUDIT_ROUTE,
  MANUAL_REAUDIT_RESUME_ROUTE,
  MAX_MANUAL_REAUDIT_CALLS,
  type ManualReauditEnqueueInput,
  type ManualReauditReceipt,
} from '../reaudit/manualRequests.ts'
import { createEnterpriseDashboardServer } from './enterpriseDashboardServer.ts'

/**
 * The admin-only re-audit endpoint: authorization, privacy, and idempotency.
 *
 * The queue is injected, so nothing here writes to a database, starts a
 * workflow, or spends on a model. Every identifier is SYNTHETIC.
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

const REFERENCES = ['synthetic-task-1', 'synthetic-task-2']
const KEY = 'rea-0123456789abcdef'

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

interface Harness {
  base: string
  close(): Promise<void>
  enqueued: ManualReauditEnqueueInput[]
  dispatched: Array<{ system: string; mode?: AuditDispatchMode }>
  events: AuditEvent[]
}

async function harness(options: {
  roles?: string[]
  receipts?: ManualReauditReceipt[]
  enqueueError?: unknown
  dispatcher?: boolean
  requestedDispatchAvailable?: boolean
  dispatchThrows?: boolean | number
} = {}): Promise<Harness> {
  const enqueued: ManualReauditEnqueueInput[] = []
  const dispatched: Array<{ system: string; mode?: AuditDispatchMode }> = []
  const events: AuditEvent[] = []
  const receipts = [...(options.receipts ?? [])]
  const server = createEnterpriseDashboardServer({
    config,
    pool: {
      async query() {
        return [[{ one: 1 }], []]
      },
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
    manualReauditRequests: {
      async enqueue(input) {
        enqueued.push(input)
        if (options.enqueueError) throw options.enqueueError
        return (
          receipts.shift() ?? {
            requestId: 'brr_synthetic',
            outcome: 'accepted',
            status: 'queued',
            acceptedCount: input.callReferences.length,
            alreadyQueuedCount: 0,
          }
        )
      },
    },
    ...(options.dispatcher === false
      ? {}
      : {
          auditWorkerDispatcher: {
            canDispatch(_system, mode) {
              return mode !== 'requested' ||
                options.requestedDispatchAvailable !== false
            },
            async dispatch(system, mode) {
              dispatched.push({ system, mode })
              if (
                options.dispatchThrows === true ||
                (typeof options.dispatchThrows === 'number' &&
                  dispatched.length <= options.dispatchThrows)
              ) {
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
    enqueued,
    dispatched,
    events,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  }
}

function post(base: string, body: unknown, headers: Record<string, string> = {}) {
  return fetch(`${base}${MANUAL_REAUDIT_ROUTE}`, {
    method: 'POST',
    headers: {
      cookie: cookie(),
      'content-type': 'application/json',
      ...headers,
    },
    body: JSON.stringify(body),
  })
}

function resume(base: string, headers: Record<string, string> = {}) {
  return fetch(`${base}${MANUAL_REAUDIT_RESUME_ROUTE}`, {
    method: 'POST',
    headers: { cookie: cookie(), 'content-type': 'application/json', ...headers },
    body: '{}',
  })
}

test('an administrator queues an exact selection and one worker run starts', async () => {
  const fixture = await harness()
  try {
    const response = await post(fixture.base, {
      callReferences: REFERENCES,
      idempotencyKey: KEY,
    })
    assert.equal(response.status, 200)
    const receipt = (await response.json()) as ManualReauditReceipt
    assert.deepEqual(receipt, {
      requestId: 'brr_synthetic',
      outcome: 'accepted',
      status: 'queued',
      acceptedCount: 2,
      alreadyQueuedCount: 0,
    })
    assert.deepEqual(fixture.enqueued[0]?.callReferences, REFERENCES)
    // Provenance comes from the session, never from the body.
    assert.equal(fixture.enqueued[0]?.requestedByUserId, 'usr_synthetic_admin')
    assert.ok(fixture.enqueued[0]?.correlationId)
    // Billing Audit only, in requested mode, exactly once.
    assert.deepEqual(fixture.dispatched, [
      { system: 'billing', mode: 'requested' },
    ])
    const event = fixture.events.at(-1)
    assert.equal(event?.action, 'billing_reaudit.request')
    assert.equal(event?.resourceType, 'billing_reaudit_request')
    assert.equal(event?.resourceId, 'brr_synthetic')
  } finally {
    await fixture.close()
  }
})

test('an administrator can resume only the durable requested queue', async () => {
  const fixture = await harness()
  try {
    const response = await resume(fixture.base)
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { outcome: 'dispatched' })
    assert.deepEqual(fixture.enqueued, [])
    assert.deepEqual(fixture.dispatched, [
      { system: 'billing', mode: 'requested' },
    ])
    assert.equal(fixture.events.at(-1)?.action, 'billing_reaudit.resume')
    assert.equal(fixture.events.at(-1)?.resourceType, 'billing_reaudit_queue')
    assert.equal(fixture.events.at(-1)?.resourceId, null)
  } finally {
    await fixture.close()
  }
})

test('an operational user cannot resume the requested queue', async () => {
  const fixture = await harness({ roles: ['user'] })
  try {
    const response = await resume(fixture.base)
    assert.equal(response.status, 403)
    assert.deepEqual(fixture.enqueued, [])
    assert.deepEqual(fixture.dispatched, [])
    assert.equal(fixture.events.at(-1)?.action, 'billing_reaudit.resume')
  } finally {
    await fixture.close()
  }
})

test('the receipt never carries an internal call id or a submitted reference', async () => {
  const fixture = await harness()
  try {
    const response = await post(fixture.base, {
      callReferences: REFERENCES,
      idempotencyKey: KEY,
    })
    const body = await response.text()
    for (const secret of [...REFERENCES, KEY, 'call-synthetic', 'usr_']) {
      assert.equal(
        body.includes(secret),
        false,
        `${secret} must not be echoed by the endpoint`,
      )
    }
  } finally {
    await fixture.close()
  }
})

test('a retry of the same request replays and starts no second worker run', async () => {
  const fixture = await harness({
    receipts: [
      {
        requestId: 'brr_synthetic',
        outcome: 'accepted',
        status: 'queued',
        acceptedCount: 2,
        alreadyQueuedCount: 0,
      },
      {
        requestId: 'brr_synthetic',
        outcome: 'replayed',
        status: 'running',
        acceptedCount: 2,
        alreadyQueuedCount: 0,
      },
    ],
  })
  try {
    await post(fixture.base, { callReferences: REFERENCES, idempotencyKey: KEY })
    const retry = await post(fixture.base, {
      callReferences: REFERENCES,
      idempotencyKey: KEY,
    })
    assert.equal(retry.status, 200)
    assert.equal(
      ((await retry.json()) as ManualReauditReceipt).outcome,
      'replayed',
    )
    // The retry key reached the queue unchanged both times…
    assert.deepEqual(
      fixture.enqueued.map((input) => input.idempotencyKey),
      [KEY, KEY],
    )
    // …and only the first, genuinely new acceptance started a worker.
    assert.deepEqual(fixture.dispatched, [
      { system: 'billing', mode: 'requested' },
    ])
    assert.equal(fixture.events.at(-1)?.action, 'billing_reaudit.replay')
  } finally {
    await fixture.close()
  }
})

test('a fully-busy selection queues nothing and starts nothing', async () => {
  const fixture = await harness({
    receipts: [
      {
        requestId: null,
        outcome: 'already_queued',
        status: null,
        acceptedCount: 0,
        alreadyQueuedCount: 2,
      },
    ],
  })
  try {
    const response = await post(fixture.base, {
      callReferences: REFERENCES,
      idempotencyKey: KEY,
    })
    assert.equal(response.status, 200)
    assert.deepEqual(fixture.dispatched, [])
    assert.equal(fixture.events.at(-1)?.resourceId, null)
  } finally {
    await fixture.close()
  }
})

test('an operational user may not queue paid work through the audit surface', async () => {
  const fixture = await harness({ roles: ['user'] })
  try {
    const response = await post(fixture.base, {
      callReferences: REFERENCES,
      idempotencyKey: KEY,
    })
    assert.equal(response.status, 403)
    // Refused BEFORE a byte of the body was read: nothing was queued, and no
    // worker was started.
    assert.deepEqual(fixture.enqueued, [])
    assert.deepEqual(fixture.dispatched, [])
    assert.equal(fixture.events.at(-1)?.outcome, 'denied')
    assert.equal(fixture.events.at(-1)?.action, 'billing_reaudit.request')
  } finally {
    await fixture.close()
  }
})

test('an unauthenticated caller is refused before anything is queued', async () => {
  const fixture = await harness()
  try {
    const response = await fetch(`${fixture.base}${MANUAL_REAUDIT_ROUTE}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ callReferences: REFERENCES, idempotencyKey: KEY }),
    })
    assert.equal(response.status, 401)
    assert.deepEqual(fixture.enqueued, [])
  } finally {
    await fixture.close()
  }
})

test('the route is POST only', async () => {
  const fixture = await harness()
  try {
    const response = await fetch(`${fixture.base}${MANUAL_REAUDIT_ROUTE}`, {
      headers: { cookie: cookie() },
    })
    assert.equal(response.status, 405)
    assert.deepEqual(fixture.enqueued, [])
  } finally {
    await fixture.close()
  }
})

test('an oversized, malformed, or unbounded body is refused without queuing', async () => {
  const fixture = await harness()
  try {
    for (const body of [
      { callReferences: [], idempotencyKey: KEY },
      { callReferences: REFERENCES },
      { callReferences: REFERENCES, idempotencyKey: 'short' },
      {
        callReferences: Array.from(
          { length: MAX_MANUAL_REAUDIT_CALLS + 1 },
          (_unused, index) => `synthetic-task-${index}`,
        ),
        idempotencyKey: KEY,
      },
    ]) {
      const response = await post(fixture.base, body)
      assert.equal(response.status, 400)
      const problem = (await response.json()) as { code: string; title: string }
      assert.equal(problem.code, 'INVALID_REAUDIT_REQUEST')
      assert.equal(problem.title.includes('synthetic-task'), false)
    }
    assert.deepEqual(fixture.enqueued, [])
    assert.deepEqual(fixture.dispatched, [])
  } finally {
    await fixture.close()
  }
})

test('a body larger than the route bound is refused before it is parsed', async () => {
  const fixture = await harness()
  try {
    const response = await fetch(`${fixture.base}${MANUAL_REAUDIT_ROUTE}`, {
      method: 'POST',
      headers: { cookie: cookie(), 'content-type': 'application/json' },
      body: JSON.stringify({
        callReferences: [`synthetic-${'0'.repeat(64 * 1024)}`],
        idempotencyKey: KEY,
      }),
    })
    assert.ok(response.status === 400 || response.status === 413)
    assert.deepEqual(fixture.enqueued, [])
  } finally {
    await fixture.close()
  }
})

test('a deployment that cannot start a worker refuses before queuing paid work', async () => {
  const fixture = await harness({ dispatcher: false })
  try {
    const response = await post(fixture.base, {
      callReferences: REFERENCES,
      idempotencyKey: KEY,
    })
    assert.equal(response.status, 503)
    assert.equal(
      ((await response.json()) as { code: string }).code,
      'AUDIT_WORKER_DISPATCH_NOT_CONFIGURED',
    )
    assert.deepEqual(fixture.enqueued, [])
  } finally {
    await fixture.close()
  }
})

test('a deployment without requested-mode hosting refuses before queuing', async () => {
  const fixture = await harness({ requestedDispatchAvailable: false })
  try {
    const response = await post(fixture.base, {
      callReferences: REFERENCES,
      idempotencyKey: KEY,
    })
    assert.equal(response.status, 503)
    assert.deepEqual(fixture.enqueued, [])
    assert.deepEqual(fixture.dispatched, [])
  } finally {
    await fixture.close()
  }
})

test('a dispatch failure becomes one bounded refusal carrying no provider prose', async () => {
  const fixture = await harness({ dispatchThrows: true })
  try {
    const response = await post(fixture.base, {
      callReferences: REFERENCES,
      idempotencyKey: KEY,
    })
    assert.equal(response.status, 503)
    const problem = (await response.json()) as { code: string; title: string }
    assert.equal(problem.code, 'AUDIT_WORKER_DISPATCH_FAILED')
    assert.equal(problem.title.includes('synthetic failure'), false)
  } finally {
    await fixture.close()
  }
})

test('a queued replay restarts dispatch after an earlier dispatch failure', async () => {
  const queued: ManualReauditReceipt = {
    requestId: 'brr_synthetic',
    outcome: 'replayed',
    status: 'queued',
    acceptedCount: 2,
    alreadyQueuedCount: 0,
  }
  const fixture = await harness({
    receipts: [{ ...queued, outcome: 'accepted' }, queued],
    dispatchThrows: 1,
  })
  try {
    const first = await post(fixture.base, {
      callReferences: REFERENCES,
      idempotencyKey: KEY,
    })
    assert.equal(first.status, 503)

    const retry = await post(fixture.base, {
      callReferences: REFERENCES,
      idempotencyKey: KEY,
    })
    assert.equal(retry.status, 200)
    assert.equal(fixture.dispatched.length, 2)
    assert.deepEqual(fixture.dispatched[1], {
      system: 'billing',
      mode: 'requested',
    })
  } finally {
    await fixture.close()
  }
})

test('a queue refusal keeps its bounded code and quotes nothing', async () => {
  for (const [error, status] of [
    [new ManualReauditError('REAUDIT_SELECTION_INVALID', 400), 400],
    [new ManualReauditError('REAUDIT_REQUEST_CONFLICT', 409), 409],
    [
      new ManualReauditError(
        'REAUDIT_QUEUE_UNAVAILABLE',
        503,
        'Re-audit queue is temporarily unavailable',
      ),
      503,
    ],
  ] as const) {
    const fixture = await harness({ enqueueError: error })
    try {
      const response = await post(fixture.base, {
        callReferences: REFERENCES,
        idempotencyKey: KEY,
      })
      assert.equal(response.status, status)
      const problem = (await response.json()) as {
        code: string
        title: string
      }
      assert.equal(problem.code, error.code)
      for (const secret of [...REFERENCES, KEY]) {
        assert.equal(problem.title.includes(secret), false)
      }
      assert.deepEqual(fixture.dispatched, [])
      assert.equal(fixture.events.at(-1)?.outcome, 'failure')
    } finally {
      await fixture.close()
    }
  }
})
