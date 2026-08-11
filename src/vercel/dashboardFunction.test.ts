import { test } from 'node:test'
import assert from 'node:assert/strict'
import http, { type IncomingMessage, type ServerResponse } from 'node:http'
import type { Pool } from 'mysql2/promise'
import type { DashboardRuntime } from '../runtime/dashboardRuntime.ts'
import {
  createVercelDashboardHandler,
  serverRequestListener,
  warmDashboardRuntime,
} from './dashboardFunction.ts'

/**
 * How the Vercel Function holds its runtime between invocations.
 *
 * Every dependency is injected: no runtime is really bootstrapped, no pool is
 * really created, no port is bound, no network is touched, and no paid model is
 * constructed.
 */

function syntheticRuntime(): DashboardRuntime {
  return {
    config: {} as DashboardRuntime['config'],
    pool: { id: Symbol('pool') } as unknown as Pool,
    server: http.createServer(),
    capabilities: {
      cycleImports: false,
      importAnalysis: false,
      callAuditRuleTest: false,
      recordingProxy: false,
      oidcBrowserFlow: false,
    },
  }
}

/** A scope of its own, so one test cannot warm another's instance. */
function scope(): typeof globalThis {
  return {} as typeof globalThis
}

test('a warm instance builds its runtime — and its pool — exactly once', () => {
  const built: DashboardRuntime[] = []
  const create = (): DashboardRuntime => {
    const runtime = syntheticRuntime()
    built.push(runtime)
    return runtime
  }
  const instance = scope()
  const first = warmDashboardRuntime(create, instance)
  const second = warmDashboardRuntime(create, instance)
  const third = warmDashboardRuntime(create, instance)
  assert.equal(built.length, 1, 'a second pool per instance doubles the ceiling')
  assert.equal(second, first)
  assert.equal(third, first)
  assert.equal(second.pool, first.pool)
})

test('the runtime is held on a shared symbol, not a module variable', () => {
  // A bundler or a runtime that evaluates the module twice would otherwise give
  // the same instance two pools.
  const instance = scope()
  const runtime = warmDashboardRuntime(syntheticRuntime, instance)
  const key = Object.getOwnPropertySymbols(instance).find(
    (symbol) => symbol.description === 'kaudit.vercel.dashboardRuntime',
  )
  assert.ok(key, 'the runtime must be reachable through a registered symbol')
  assert.equal(Symbol.for('kaudit.vercel.dashboardRuntime'), key)
  assert.equal(
    (instance as unknown as Record<symbol, DashboardRuntime>)[key],
    runtime,
  )
})

test('separate instances do not share a runtime', () => {
  const first = warmDashboardRuntime(syntheticRuntime, scope())
  const second = warmDashboardRuntime(syntheticRuntime, scope())
  assert.notEqual(first, second)
})

test('the listener runs the server handler without binding a port', async () => {
  const seen: string[] = []
  const runtime = syntheticRuntime()
  runtime.server.on('request', (request: IncomingMessage) => {
    seen.push(request.url as string)
  })
  const listener = serverRequestListener(runtime)
  listener(
    { url: '/api/v1/me' } as IncomingMessage,
    {} as ServerResponse,
  )
  assert.deepEqual(seen, ['/api/v1/me'])
  assert.equal(runtime.server.listening, false)
})

test('the handler routes through the warmed runtime it is given', async () => {
  const runtime = syntheticRuntime()
  runtime.server.on(
    'request',
    (_request: IncomingMessage, response: ServerResponse) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end('{"status":"ok"}')
    },
  )
  let warmed = 0
  const handler = createVercelDashboardHandler({
    warm: () => {
      warmed += 1
      return runtime
    },
  })
  const server = http.createServer((request, response) => {
    void handler(request, response)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const port = (server.address() as { port: number }).port
    const first = await fetch(`http://127.0.0.1:${port}/health/live`)
    assert.equal(first.status, 200)
    assert.equal(await first.text(), '{"status":"ok"}')
    const second = await fetch(`http://127.0.0.1:${port}/api/v1/me`)
    assert.equal(second.status, 200)
    await second.text()
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    )
  }
  assert.equal(warmed, 2, 'warming is memoized inside the factory, not skipped')
})
