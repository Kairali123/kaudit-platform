import { test } from 'node:test'
import assert from 'node:assert/strict'
import http, {
  type IncomingMessage,
  type ServerResponse,
} from 'node:http'
import { Socket } from 'node:net'
import { PassThrough } from 'node:stream'
import {
  createServerlessHandler,
  normalizeRequestTarget,
  responseSettled,
  RUNTIME_UNAVAILABLE_BODY,
  type NodeRequestListener,
} from './serverlessAdapter.ts'

/**
 * Synthetic-only. Nothing here binds a port, opens a database, reaches a
 * network, or constructs a paid model: the adapter is handed a listener and
 * never builds one.
 */

interface Exchange {
  request: IncomingMessage
  response: ServerResponse
  read(): { status: number; headers: Record<string, unknown>; body: string }
}

/**
 * A real `IncomingMessage`/`ServerResponse` pair over a detached socket.
 *
 * Real objects rather than doubles, because what is under test is Node's own
 * lifecycle — `writableEnded`, `headersSent`, and the `finish`/`close` events —
 * and a stub would only assert the stub.
 */
function exchange(url: string): Exchange {
  const request = new http.IncomingMessage(new Socket())
  request.url = url
  request.method = 'GET'
  const response = new http.ServerResponse(request)
  const written: Buffer[] = []
  const wire = new PassThrough()
  wire.on('data', (chunk: Buffer) => written.push(chunk))
  response.assignSocket(wire as unknown as Socket)
  return {
    request,
    response,
    read() {
      const raw = Buffer.concat(written).toString('utf8')
      const separator = raw.indexOf('\r\n\r\n')
      const head = raw.slice(0, separator).split('\r\n')
      const headers: Record<string, unknown> = {}
      for (const line of head.slice(1)) {
        const colon = line.indexOf(':')
        if (colon > 0) {
          headers[line.slice(0, colon).toLowerCase()] = line
            .slice(colon + 1)
            .trim()
        }
      }
      return {
        status: Number(head[0]?.split(' ')[1]),
        headers,
        body: raw.slice(separator + 4),
      }
    },
  }
}

// ---------------------------------------------------------------------------
// The request target reaches the application unchanged
// ---------------------------------------------------------------------------

test('paths and queries the router matches on are preserved exactly', () => {
  for (const target of [
    '/',
    '/login',
    '/logout',
    '/health/live',
    '/health/ready',
    '/overview',
    '/audits/call',
    '/call-audit/settings',
    '/imports/new',
    '/api/v1/me',
    '/api/v1/imports/usage',
    '/api/v1/call-audit/report?month=2026-07&ruleVersionId=rv-1',
    '/api/v1/audit-call?callId=a%2Fb%20c&tier=K0',
    '/assets/app-4f3a1b2c.js',
    '/overview?a=1&a=2&empty=&flag',
  ]) {
    assert.equal(normalizeRequestTarget(target), target)
  }
})

test('an absolute-form target is reduced to its path and query', () => {
  assert.equal(
    normalizeRequestTarget('https://audit.example.test/api/v1/me?x=1'),
    '/api/v1/me?x=1',
  )
  assert.equal(normalizeRequestTarget('https://audit.example.test'), '/')
})

test('an absent or rootless target becomes a root path', () => {
  assert.equal(normalizeRequestTarget(undefined), '/')
  assert.equal(normalizeRequestTarget(''), '/')
  assert.equal(normalizeRequestTarget('overview'), '/overview')
})

test('a protocol-relative target cannot smuggle in an authority', () => {
  // `new URL('//evil.test/overview', base)` resolves against `evil.test`.
  assert.equal(normalizeRequestTarget('//evil.test/overview'), '/evil.test/overview')
  assert.equal(
    new URL(
      normalizeRequestTarget('//evil.test/overview'),
      'http://kaudit.invalid',
    ).host,
    'kaudit.invalid',
  )
})

test('the handler hands the normalized target to the listener', async () => {
  const seen: string[] = []
  const handler = createServerlessHandler({
    loadListener: async () => (request, response) => {
      seen.push(request.url as string)
      response.writeHead(200)
      response.end()
    },
  })
  const call = exchange('/api/v1/call-audit/report?month=2026-07')
  await handler(call.request, call.response)
  assert.deepEqual(seen, ['/api/v1/call-audit/report?month=2026-07'])
})

// ---------------------------------------------------------------------------
// The invocation waits for the response
// ---------------------------------------------------------------------------

test('the handler resolves only after an async listener finishes writing', async () => {
  let finished = false
  const listener: NodeRequestListener = (_request, response) => {
    void (async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end('{"status":"ok"}')
      finished = true
    })()
  }
  const handler = createServerlessHandler({ loadListener: async () => listener })
  const call = exchange('/health/live')
  await handler(call.request, call.response)
  assert.equal(
    finished,
    true,
    'returning early would freeze the instance mid-write',
  )
  assert.equal(call.read().body, '{"status":"ok"}')
})

test('a response already ended settles immediately', async () => {
  const call = exchange('/health/live')
  call.response.writeHead(200)
  call.response.end()
  await responseSettled(call.response)
})

// ---------------------------------------------------------------------------
// Startup failure is bounded and says nothing
// ---------------------------------------------------------------------------

test('a startup failure becomes a 503 that carries no detail', async () => {
  let notified = 0
  const secret =
    'DB_PASSWORD=synthetic-secret host=db.internal -----BEGIN CERTIFICATE-----'
  const handler = createServerlessHandler({
    loadListener: async () => {
      throw Object.assign(new Error(secret), {
        sql: 'SELECT 1 FROM kaudit_user',
        config: { password: 'synthetic-secret' },
      })
    },
    onStartupFailure: () => {
      notified += 1
    },
  })
  const call = exchange('/overview')
  await handler(call.request, call.response)
  const result = call.read()
  assert.equal(result.status, 503)
  assert.equal(result.body, RUNTIME_UNAVAILABLE_BODY)
  assert.equal(notified, 1)
  for (const leaked of [
    'synthetic-secret',
    'db.internal',
    'DB_PASSWORD',
    'SELECT',
    'kaudit_user',
    'BEGIN CERTIFICATE',
    'Error',
  ]) {
    assert.equal(
      result.body.includes(leaked),
      false,
      `the 503 body must not carry ${leaked}`,
    )
  }
})

test('the unavailable body is a fixed, bounded problem document', () => {
  const parsed = JSON.parse(RUNTIME_UNAVAILABLE_BODY) as Record<string, unknown>
  assert.deepEqual(Object.keys(parsed).sort(), [
    'code',
    'status',
    'title',
    'type',
  ])
  assert.equal(parsed.status, 503)
  assert.equal(parsed.code, 'RUNTIME_UNAVAILABLE')
  assert.ok(RUNTIME_UNAVAILABLE_BODY.length < 256)
})

test('the 503 is not cacheable and is not sniffable', async () => {
  const handler = createServerlessHandler({
    loadListener: async () => {
      throw new Error('unavailable')
    },
  })
  const call = exchange('/overview')
  await handler(call.request, call.response)
  const { headers } = call.read()
  assert.equal(headers['cache-control'], 'no-store')
  assert.equal(headers['x-content-type-options'], 'nosniff')
  assert.match(
    String(headers['content-type']),
    /^application\/problem\+json/,
  )
})

test('an unknown throw from the listener is not exposed either', async () => {
  const handler = createServerlessHandler({
    loadListener: async () => () => {
      throw new Error('connect ECONNREFUSED db.internal:3306')
    },
  })
  const call = exchange('/overview')
  await handler(call.request, call.response)
  const result = call.read()
  assert.equal(result.status, 503)
  assert.equal(result.body.includes('db.internal'), false)
  assert.equal(result.body, RUNTIME_UNAVAILABLE_BODY)
})

test('a listener that throws after writing is not written over', async () => {
  const handler = createServerlessHandler({
    loadListener: async () => (_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.write('{"partial":true}')
      throw new Error('failed after the headers went out')
    },
  })
  const call = exchange('/api/v1/me')
  await handler(call.request, call.response)
  const result = call.read()
  assert.equal(result.status, 200)
  assert.equal(result.body.includes('RUNTIME_UNAVAILABLE'), false)
})

test('a failed bootstrap is retried rather than cached as broken', async () => {
  let attempts = 0
  const handler = createServerlessHandler({
    loadListener: async () => {
      attempts += 1
      if (attempts === 1) throw new Error('transient')
      return (_request, response) => {
        response.writeHead(200)
        response.end('ok')
      }
    },
  })
  const first = exchange('/health/live')
  await handler(first.request, first.response)
  assert.equal(first.read().status, 503)
  const second = exchange('/health/live')
  await handler(second.request, second.response)
  assert.equal(second.read().status, 200)
})
