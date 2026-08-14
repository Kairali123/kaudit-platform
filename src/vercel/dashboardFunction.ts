import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  createDashboardRuntime,
  type DashboardRuntime,
  type DashboardRuntimeOptions,
} from '../runtime/dashboardRuntime.ts'
import {
  createServerlessHandler,
  type NodeRequestListener,
} from './serverlessAdapter.ts'

/**
 * One runtime — and therefore one MySQL pool — per warm instance.
 *
 * Held on `globalThis` rather than in a module variable because a bundler or a
 * runtime that evaluates this module more than once would otherwise give the
 * same instance a second pool, and the connection ceiling the serverless profile
 * is built around would be wrong by exactly that factor.
 */
const RUNTIME_KEY = Symbol.for('kaudit.vercel.dashboardRuntime')

type RuntimeGlobal = typeof globalThis & {
  [RUNTIME_KEY]?: DashboardRuntime
}

/**
 * Vercel Function options, fixed by what the platform is and is not.
 *
 * `serverless` bounds the pool. `google-drive` gives imports durable object
 * storage in the configured Kaudit Google Shared Drive boundary; a function's
 * local filesystem is still never used for uploads.
 *
 * Nothing else differs from the persistent server: the same factory applies the
 * same authentication, permission, release-gate and Call Audit rule-test rules.
 */
const VERCEL_RUNTIME_OPTIONS: DashboardRuntimeOptions = {
  poolProfile: 'serverless',
  cycleImports: 'google-drive',
}

export function warmDashboardRuntime(
  createRuntime: (
    options: DashboardRuntimeOptions,
  ) => DashboardRuntime = createDashboardRuntime,
  scope: RuntimeGlobal = globalThis as RuntimeGlobal,
): DashboardRuntime {
  const existing = scope[RUNTIME_KEY]
  if (existing) return existing
  const runtime = createRuntime({
    ...VERCEL_RUNTIME_OPTIONS,
    webDistRoot: process.env.KAUDIT_WEB_DIST_ROOT?.trim() || undefined,
  })
  scope[RUNTIME_KEY] = runtime
  return runtime
}

/**
 * Invokes the server's own request listener without binding a port.
 *
 * `createEnterpriseDashboardServer` returns a `http.Server` whose listener holds
 * all routing and authorization. Emitting `request` runs exactly that listener,
 * so the function shares one code path with the persistent server instead of
 * re-deriving routes.
 */
export function serverRequestListener(
  runtime: DashboardRuntime,
): NodeRequestListener {
  return (request, response) => {
    runtime.server.emit('request', request, response)
  }
}

export function createVercelDashboardHandler(options?: {
  warm?: () => DashboardRuntime
}): (request: IncomingMessage, response: ServerResponse) => Promise<void> {
  const warm = options?.warm ?? (() => warmDashboardRuntime())
  return createServerlessHandler({
    // Bootstrapping is deferred to the first request so an invocation that
    // cannot build the runtime answers 503 instead of failing to import.
    loadListener: async () => serverRequestListener(warm()),
    onStartupFailure: () => {
      // Privacy-safe and detail-free: enough to see that a deployment is
      // misconfigured, nothing that describes how.
      process.stderr.write(
        `${JSON.stringify({
          level: 'error',
          event: 'vercel_runtime_bootstrap_failed',
          occurredAt: new Date().toISOString(),
        })}\n`,
      )
    },
  })
}
