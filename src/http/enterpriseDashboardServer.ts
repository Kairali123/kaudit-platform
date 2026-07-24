import http, {
  type IncomingMessage,
  type ServerResponse,
} from 'node:http'
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
import { collectFullDashboard } from '../adapters/mysqlFullDashboard.ts'
import { buildFullDashboard } from '../ui/fullDashboard.ts'
import { renderFullDashboard } from '../ui/fullRender.ts'
import { clientAddress } from './clientAddress.ts'
import { correlationId } from './correlation.ts'
import {
  HTML_SECURITY_HEADERS,
  JSON_SECURITY_HEADERS,
} from './securityHeaders.ts'

interface Dependencies {
  config: RuntimeConfig
  pool: Pool
  access: AccessRepository
  audit: AuditSink
  verifier: TokenVerifier | null
}

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
    if (
      !['/', '/api/v1/me', '/api/v1/dashboard'].includes(
        url.pathname,
      )
    ) {
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
      requirePermission(context, 'metrics:read')
      if (url.pathname === '/api/v1/me') {
        await auditAccess(
          dependencies,
          request,
          context,
          correlation,
          'success',
          'identity.read',
        )
        response.writeHead(200, {
          ...JSON_SECURITY_HEADERS,
          'content-type': 'application/json; charset=utf-8',
          'x-correlation-id': correlation,
        })
        response.end(
          JSON.stringify({
            id: context.user.id,
            email: context.user.email,
            roles: context.user.roles,
            maxSensitivityTier:
              context.user.maxSensitivityTier,
          }),
        )
        return
      }

      const dashboard = buildFullDashboard(
        await collectFullDashboard(dependencies.pool),
        { accessControlEnforced: true },
      )
      await auditAccess(
        dependencies,
        request,
        context,
        correlation,
        'success',
        'dashboard.read',
      )
      if (url.pathname === '/api/v1/dashboard') {
        response.writeHead(200, {
          ...JSON_SECURITY_HEADERS,
          'content-type': 'application/json; charset=utf-8',
          'x-correlation-id': correlation,
        })
        response.end(JSON.stringify(dashboard))
        return
      }
      response.writeHead(200, {
        ...HTML_SECURITY_HEADERS,
        'content-type': 'text/html; charset=utf-8',
        'x-correlation-id': correlation,
      })
      response.end(renderFullDashboard(dashboard))
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
            : 'dashboard.read',
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
