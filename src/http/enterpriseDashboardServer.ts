import http, {
  type IncomingMessage,
  type ServerResponse,
} from 'node:http'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import type { Pool } from 'mysql2/promise'
import {
  AuthFailure,
  authenticateLocal,
  authenticateOidc,
  extractBearerToken,
  requirePermission,
} from '../auth/authenticate.ts'
import type {
  AccessRepository,
  AuthContext,
  TokenVerifier,
} from '../auth/types.ts'
import type { AuditSink } from '../audit/types.ts'
import type { RuntimeConfig } from '../config/runtime.ts'
import {
  collectBilling,
  collectQuality,
  collectRevenueSnapshots,
} from '../adapters/mysqlFullDashboard.ts'
import { collectMetrics } from '../adapters/mysqlMetrics.ts'
import { collectOperations } from '../adapters/mysqlOperations.ts'
import { USER_PERMISSIONS } from '../identity/access.ts'
import {
  buildBillingView,
  buildQualityView,
  buildRevenueSnapshots,
  type ReleaseGateView,
} from '../ui/fullDashboard.ts'
import { buildDashboard } from '../ui/metrics.ts'
import { clientAddress } from './clientAddress.ts'
import { correlationId } from './correlation.ts'
import {
  HTML_SECURITY_HEADERS,
  JSON_SECURITY_HEADERS,
  STATIC_SECURITY_HEADERS,
} from './securityHeaders.ts'

interface Dependencies {
  config: RuntimeConfig
  pool: Pool
  access: AccessRepository
  audit: AuditSink
  verifier: TokenVerifier | null
  webDistRoot?: string
}

const APP_ROUTES = new Set([
  '/',
  '/overview',
  '/evidence',
  '/findings',
  '/billing',
  '/reports',
  '/operations',
])

const API_ROUTES = new Set([
  '/api/v1/me',
  '/api/v1/overview',
  '/api/v1/evidence',
  '/api/v1/findings',
  '/api/v1/billing',
  '/api/v1/reports',
  '/api/v1/operations',
])

function userAgent(request: IncomingMessage): string | null {
  const value = request.headers['user-agent']
  return typeof value === 'string' ? value.slice(0, 120) : null
}

function requestUrl(request: IncomingMessage): URL {
  return new URL(request.url || '/', 'http://kaudit.invalid')
}

function problem(
  response: ServerResponse,
  status: number,
  code: string,
  title: string,
  correlation: string,
): void {
  response.writeHead(status, {
    ...JSON_SECURITY_HEADERS,
    'content-type':
      'application/problem+json; charset=utf-8',
    'x-correlation-id': correlation,
  })
  response.end(
    JSON.stringify({
      type: `https://kaudit.kairali.invalid/problems/${code
        .toLowerCase()
        .replaceAll('_', '-')}`,
      title,
      status,
      code,
      correlationId: correlation,
    }),
  )
}

async function authenticate(
  request: IncomingMessage,
  dependencies: Dependencies,
): Promise<AuthContext> {
  if (dependencies.config.auth.mode === 'local') {
    return authenticateLocal(
      dependencies.config.auth.email,
      dependencies.access,
    )
  }
  if (!dependencies.verifier) {
    throw new Error('OIDC verifier is unavailable')
  }
  const token = extractBearerToken(
    request.headers.authorization,
    request.headers.cookie,
    dependencies.config.auth.tokenCookie,
  )
  return authenticateOidc(
    token,
    dependencies.verifier,
    dependencies.access,
  )
}

async function auditAccess(
  dependencies: Dependencies,
  request: IncomingMessage,
  context: AuthContext | null,
  correlation: string,
  outcome: 'success' | 'denied' | 'failure',
  action: string,
): Promise<void> {
  await dependencies.audit.record({
    actorUserId: context?.user.id ?? null,
    actorEmail: context?.user.email ?? null,
    action,
    resourceType: 'aggregate_dashboard',
    resourceId: null,
    outcome,
    purpose: 'audit_operations',
    correlationId: correlation,
    ipAddress: clientAddress(
      request,
      dependencies.config.trustProxy,
    ),
    client: userAgent(request),
    occurredAt: new Date(),
  })
}

function sendJson(
  response: ServerResponse,
  correlation: string,
  value: unknown,
): void {
  response.writeHead(200, {
    ...JSON_SECURITY_HEADERS,
    'content-type': 'application/json; charset=utf-8',
    'x-correlation-id': correlation,
  })
  response.end(JSON.stringify(value))
}

function rateCardApproved(
  billing: Awaited<ReturnType<typeof collectBilling>>,
): boolean {
  return (
    billing.rateCardStatus === 'published' &&
    Boolean(billing.rateCardApprovedBy) &&
    Boolean(billing.rateCardApprovedAt)
  )
}

function releaseGates(
  dependencies: Dependencies,
  approvedRateCard: boolean,
): ReleaseGateView[] {
  return [
    {
      code: 'access',
      label: 'Access control',
      detail: 'Authenticated, role-checked aggregate access',
      status: 'ready',
    },
    {
      code: 'rate-card',
      label: 'Rate card approval',
      detail: approvedRateCard
        ? 'Published with named approval'
        : 'D-03 open; billing is provisional',
      status: approvedRateCard ? 'ready' : 'blocked',
    },
    {
      code: 'calibration',
      label: 'AI calibration',
      detail: dependencies.config.releaseGates.calibrationComplete
        ? 'Calibration gate recorded complete'
        : 'Accuracy has not been measured',
      status: dependencies.config.releaseGates.calibrationComplete
        ? 'ready'
        : 'blocked',
    },
    {
      code: 'k2-k3',
      label: 'K2/K3 automation',
      detail: dependencies.config.releaseGates.k23AutomationEnabled
        ? 'Enabled with named safety owner'
        : 'Inactive pending clinical/safety sign-off',
      status: dependencies.config.releaseGates.k23AutomationEnabled
        ? 'ready'
        : 'blocked',
    },
    {
      code: 'reporting',
      label: 'Management snapshots',
      detail: dependencies.config.releaseGates.reportingApproved
        ? 'Reporting conventions approved'
        : 'D-12-A conventions pending approval',
      status: dependencies.config.releaseGates.reportingApproved
        ? 'ready'
        : 'pending',
    },
  ]
}

function permissionsFor(roles: readonly string[]): string[] {
  return roles.includes('admin')
    ? ['*']
    : roles.includes('user')
      ? [...USER_PERMISSIONS]
      : []
}

async function apiResponse(
  pathname: string,
  dependencies: Dependencies,
  context: AuthContext,
): Promise<unknown> {
  if (pathname === '/api/v1/me') {
    return {
      id: context.user.id,
      email: context.user.email,
      roles: context.user.roles,
      permissions: permissionsFor(context.user.roles),
      maxSensitivityTier: context.user.maxSensitivityTier,
      authMode: dependencies.config.auth.mode,
      contentAccess:
        'Aggregate data only; raw audio and transcripts are not available in this app.',
    }
  }
  if (pathname === '/api/v1/overview') {
    const [metrics, billing] = await Promise.all([
      collectMetrics(dependencies.pool),
      collectBilling(dependencies.pool),
    ])
    return {
      generatedAt: metrics.generatedAt,
      tiles: buildDashboard(metrics).tiles,
      gates: releaseGates(
        dependencies,
        rateCardApproved(billing),
      ),
    }
  }
  if (pathname === '/api/v1/evidence') {
    const metrics = await collectMetrics(dependencies.pool)
    const dashboard = buildDashboard(metrics)
    return {
      generatedAt: metrics.generatedAt,
      tiles: dashboard.tiles,
      integrityFindings: dashboard.findings,
    }
  }
  if (pathname === '/api/v1/findings') {
    const [metrics, quality] = await Promise.all([
      collectMetrics(dependencies.pool),
      collectQuality(dependencies.pool),
    ])
    return {
      generatedAt: metrics.generatedAt,
      authority: dependencies.config.releaseGates
        .calibrationComplete
        ? 'calibrated'
        : 'uncalibrated',
      quality: buildQualityView(quality, metrics.calls),
    }
  }
  if (pathname === '/api/v1/billing') {
    const billing = await collectBilling(dependencies.pool)
    return {
      generatedAt: new Date().toISOString(),
      authority: rateCardApproved(billing)
        ? 'authoritative'
        : 'provisional',
      billing: buildBillingView(billing),
    }
  }
  if (pathname === '/api/v1/reports') {
    const [billing, snapshots] = await Promise.all([
      collectBilling(dependencies.pool),
      collectRevenueSnapshots(dependencies.pool),
    ])
    return {
      generatedAt: new Date().toISOString(),
      authority:
        rateCardApproved(billing) &&
        dependencies.config.releaseGates.reportingApproved
          ? 'authoritative'
          : 'provisional',
      snapshots: buildRevenueSnapshots(snapshots),
    }
  }
  if (pathname === '/api/v1/operations') {
    return collectOperations(dependencies.pool)
  }
  throw new Error('Unsupported API route')
}

function apiPermission(pathname: string): string {
  return pathname === '/api/v1/reports'
    ? 'snapshot:read'
    : 'metrics:read'
}

function contentType(filePath: string): string {
  if (filePath.endsWith('.js')) return 'text/javascript; charset=utf-8'
  if (filePath.endsWith('.css')) return 'text/css; charset=utf-8'
  if (filePath.endsWith('.svg')) return 'image/svg+xml'
  if (filePath.endsWith('.png')) return 'image/png'
  if (filePath.endsWith('.woff2')) return 'font/woff2'
  return 'application/octet-stream'
}

async function serveApp(
  pathname: string,
  response: ServerResponse,
  correlation: string,
  webDistRoot: string,
): Promise<boolean> {
  const isAsset = pathname.startsWith('/assets/')
  if (!isAsset && !APP_ROUTES.has(pathname)) return false
  const relative = isAsset ? pathname.slice(1) : 'index.html'
  const root = path.resolve(webDistRoot)
  const filePath = path.resolve(root, relative)
  if (!filePath.startsWith(`${root}${path.sep}`)) return false
  try {
    const body = await readFile(filePath)
    response.writeHead(200, {
      ...(isAsset ? STATIC_SECURITY_HEADERS : HTML_SECURITY_HEADERS),
      'content-type': isAsset
        ? contentType(filePath)
        : 'text/html; charset=utf-8',
      'x-correlation-id': correlation,
    })
    response.end(body)
    return true
  } catch {
    return false
  }
}

export function createEnterpriseDashboardServer(
  dependencies: Dependencies,
): http.Server {
  return http.createServer(async (request, response) => {
    const correlation = correlationId(
      request.headers['x-correlation-id'],
    )
    const url = requestUrl(request)
    if (request.method !== 'GET') {
      problem(
        response,
        405,
        'METHOD_NOT_ALLOWED',
        'Method not allowed',
        correlation,
      )
      return
    }
    if (url.pathname === '/health/live') {
      response.writeHead(200, {
        ...JSON_SECURITY_HEADERS,
        'content-type': 'application/json; charset=utf-8',
        'x-correlation-id': correlation,
      })
      response.end('{"status":"ok"}')
      return
    }
    if (url.pathname === '/health/ready') {
      try {
        const [dbResult, identityReady, auditReady] =
          await Promise.all([
            dependencies.pool.query('SELECT 1'),
            dependencies.access.readiness(),
            dependencies.audit.readiness(),
          ])
        if (!dbResult || !identityReady || !auditReady) {
          throw new Error('dependency not ready')
        }
        response.writeHead(200, {
          ...JSON_SECURITY_HEADERS,
          'content-type': 'application/json; charset=utf-8',
          'x-correlation-id': correlation,
        })
        response.end('{"status":"ready"}')
      } catch {
        problem(
          response,
          503,
          'NOT_READY',
          'Service not ready',
          correlation,
        )
      }
      return
    }
    const isKnownRoute =
      API_ROUTES.has(url.pathname) ||
      APP_ROUTES.has(url.pathname) ||
      url.pathname.startsWith('/assets/')
    if (!isKnownRoute) {
      problem(
        response,
        404,
        'NOT_FOUND',
        'Not found',
        correlation,
      )
      return
    }

    let context: AuthContext | null = null
    try {
      context = await authenticate(request, dependencies)
      if (API_ROUTES.has(url.pathname)) {
        requirePermission(context, apiPermission(url.pathname))
        const action =
          url.pathname === '/api/v1/me'
            ? 'identity.read'
            : `${url.pathname.split('/').at(-1)}.read`
        const body = await apiResponse(
          url.pathname,
          dependencies,
          context,
        )
        await auditAccess(
          dependencies,
          request,
          context,
          correlation,
          'success',
          action,
        )
        sendJson(response, correlation, body)
        return
      }
      requirePermission(context, 'metrics:read')
      if (url.pathname.startsWith('/assets/')) {
        const served = await serveApp(
          url.pathname,
          response,
          correlation,
          dependencies.webDistRoot ??
            path.resolve(process.cwd(), 'apps/web/dist'),
        )
        if (served) return
      }
      await auditAccess(
        dependencies,
        request,
        context,
        correlation,
        'success',
        'app.read',
      )
      const served = await serveApp(
        url.pathname,
        response,
        correlation,
        dependencies.webDistRoot ??
          path.resolve(process.cwd(), 'apps/web/dist'),
      )
      if (served) {
        return
      }
      problem(
        response,
        503,
        'APP_NOT_BUILT',
        'Web application is not built',
        correlation,
      )
    } catch (error) {
      const authFailure = error instanceof AuthFailure
      try {
        await auditAccess(
          dependencies,
          request,
          context,
          correlation,
          authFailure ? 'denied' : 'failure',
          url.pathname === '/api/v1/me'
            ? 'identity.read'
            : url.pathname.startsWith('/api/')
              ? `${url.pathname.split('/').at(-1)}.read`
              : 'app.read',
        )
      } catch {
        // Privacy-safe structured logging below is the fallback when the
        // protected database audit sink is unavailable.
      }
      const safeLog = {
        level: authFailure ? 'warn' : 'error',
        event: authFailure
          ? 'access_denied'
          : 'dashboard_request_failed',
        code: authFailure ? error.code : 'INTERNAL_ERROR',
        correlationId: correlation,
        occurredAt: new Date().toISOString(),
      }
      process.stderr.write(`${JSON.stringify(safeLog)}\n`)
      if (authFailure) {
        problem(
          response,
          error.status,
          error.code,
          error.message,
          correlation,
        )
      } else {
        problem(
          response,
          500,
          'INTERNAL_ERROR',
          'Request could not be completed',
          correlation,
        )
      }
    }
  })
}
