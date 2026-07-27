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
import {
  clearLocalSessionCookie,
  issueLocalSession,
  localSessionCookie,
  verifyLocalPassword,
  verifyLocalSession,
} from '../auth/localSession.ts'
import type {
  AccessRepository,
  AuthContext,
  TokenVerifier,
} from '../auth/types.ts'
import type { AuditSink } from '../audit/types.ts'
import type { CycleImportService } from '../imports/types.ts'
import type { ImportAnalysisService } from '../imports/analysis.ts'
import type { RuntimeConfig } from '../config/runtime.ts'
import {
  collectBilling,
  collectQuality,
  collectRevenueSnapshots,
} from '../adapters/mysqlFullDashboard.ts'
import { collectMetrics } from '../adapters/mysqlMetrics.ts'
import { collectOperations } from '../adapters/mysqlOperations.ts'
import { collectAuditMonitor } from '../adapters/mysqlAuditMonitor.ts'
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
  imports?: CycleImportService
  importAnalysis?: ImportAnalysisService
  webDistRoot?: string
}

const APP_ROUTES = new Set([
  '/',
  '/login',
  '/overview',
  '/evidence',
  '/findings',
  '/billing',
  '/reports',
  '/operations',
  '/audits',
  '/imports/new',
])

const API_ROUTES = new Set([
  '/api/v1/me',
  '/api/v1/overview',
  '/api/v1/evidence',
  '/api/v1/findings',
  '/api/v1/billing',
  '/api/v1/reports',
  '/api/v1/operations',
  '/api/v1/audits',
  '/api/v1/imports',
])

const PUBLIC_API_ROUTES = new Set(['/api/v1/auth/config'])
const PUBLIC_POST_ROUTES = new Set(['/api/v1/auth/login'])
const IMPORT_WRITE_ROUTES = new Set([
  '/api/v1/imports/usage',
  '/api/v1/imports/invoice',
])
const IMPORT_ANALYSIS_ROUTES = new Set([
  '/api/v1/imports/analyze-usage',
  '/api/v1/imports/analyze-invoice',
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
  if (dependencies.config.auth.mode === 'preview') {
    return {
      user: {
        id: 'local-preview',
        email: 'local-preview@kaudit.invalid',
        status: 'active',
        maxSensitivityTier: 'K0',
        roles: ['user'],
      },
      issuer: 'local-preview',
      subject: 'local-preview',
    }
  }
  if (dependencies.config.auth.mode === 'local') {
    const auth = dependencies.config.auth
    const token = extractBearerToken(
      undefined,
      request.headers.cookie,
      auth.sessionCookie,
    )
    const email = verifyLocalSession(
      token,
      auth.sessionSecret,
      auth.email,
    )
    if (!email) {
      throw new AuthFailure(
        401,
        'AUTH_REQUIRED',
        'Authentication is required',
      )
    }
    return authenticateLocal(
      email,
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
  if (dependencies.config.auth.mode === 'preview') return
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
  headers: Record<string, string> = {},
): void {
  response.writeHead(200, {
    ...JSON_SECURITY_HEADERS,
    'content-type': 'application/json; charset=utf-8',
    'x-correlation-id': correlation,
    ...headers,
  })
  response.end(JSON.stringify(value))
}

async function readRequestBody(
  request: IncomingMessage,
  maximumBytes = 25 * 1024 * 1024,
): Promise<Buffer> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += bytes.byteLength
    if (size > maximumBytes) {
      const error = new Error('Upload exceeds the 25 MB limit')
      Object.assign(error, { code: 'UPLOAD_TOO_LARGE', status: 413 })
      throw error
    }
    chunks.push(bytes)
  }
  if (size === 0) {
    const error = new Error('Upload is empty')
    Object.assign(error, { code: 'EMPTY_UPLOAD', status: 400 })
    throw error
  }
  return Buffer.concat(chunks)
}

function header(request: IncomingMessage, name: string): string {
  const value = request.headers[name]
  if (typeof value !== 'string' || !value.trim()) {
    const error = new Error(`${name} is required`)
    Object.assign(error, { code: 'INVALID_IMPORT_REQUEST', status: 400 })
    throw error
  }
  return value.trim()
}

function releaseGates(
  dependencies: Dependencies,
  billing: ReturnType<typeof buildBillingView>,
): ReleaseGateView[] {
  return [
    {
      code: 'access',
      label: 'Access control',
      detail:
        dependencies.config.auth.mode === 'preview'
          ? 'Local preview only; access control is not enforced'
          : 'Authenticated, role-checked aggregate access',
      status:
        dependencies.config.auth.mode === 'preview'
          ? 'blocked'
          : 'ready',
    },
    {
      code: 'rate-card',
      label: 'Rate card approval',
      detail: billing.rateCardApproved
        ? 'Published with named approval'
        : 'Approved interpretation is not yet published in the database',
      status: billing.rateCardApproved ? 'ready' : 'blocked',
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
      code: 'audit-cycle',
      label: 'Billing-cycle audit',
      detail: billing.cycle.billGenerated
        ? 'Every call is resolved and the verified bill may be released'
        : `${billing.cycleStatusLabel}: ${billing.cycle.auditPendingCalls.toLocaleString('en-IN')} calls remain`,
      status: billing.cycle.billGenerated ? 'ready' : 'blocked',
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

function publicAuthConfig(dependencies: Dependencies): unknown {
  const auth = dependencies.config.auth
  return {
    mode: auth.mode,
    providerLabel:
      auth.mode === 'oidc'
        ? 'Kairali SSO'
        : auth.mode === 'local'
          ? 'Local Kairali account'
          : 'Local preview',
    loginUrl: auth.mode === 'oidc' ? auth.loginUrl : null,
    logoutUrl: auth.mode === 'oidc' ? auth.logoutUrl : '/login',
    accessControlEnforced: auth.mode !== 'preview',
    passwordLoginSupported: auth.mode === 'local',
  }
}

async function apiResponse(
  url: URL,
  dependencies: Dependencies,
  context: AuthContext,
): Promise<unknown> {
  const pathname = url.pathname
  if (pathname === '/api/v1/me') {
    return {
      id: context.user.id,
      email: context.user.email,
      roles: context.user.roles,
      permissions: permissionsFor(context.user.roles),
      authMode: dependencies.config.auth.mode,
      accessControlEnforced:
        dependencies.config.auth.mode !== 'preview',
      contentAccess:
        'Aggregate data only; raw audio and transcripts are not available in this app.',
    }
  }
  if (pathname === '/api/v1/overview') {
    const [metrics, billing] = await Promise.all([
      collectMetrics(dependencies.pool),
      collectBilling(dependencies.pool),
    ])
    const billingView = buildBillingView(billing, {
      calibrationComplete:
        dependencies.config.releaseGates.calibrationComplete,
    })
    return {
      generatedAt: metrics.generatedAt,
      tiles: buildDashboard(metrics).tiles,
      gates: releaseGates(
        dependencies,
        billingView,
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
    const billingView = buildBillingView(billing, {
      calibrationComplete:
        dependencies.config.releaseGates.calibrationComplete,
    })
    return {
      generatedAt: new Date().toISOString(),
      authority: billingView.cycle.billGenerated
        ? 'authoritative'
        : 'audit_pending',
      billing: billingView,
    }
  }
  if (pathname === '/api/v1/reports') {
    const [billing, snapshots] = await Promise.all([
      collectBilling(dependencies.pool),
      collectRevenueSnapshots(dependencies.pool),
    ])
    const billingView = buildBillingView(billing, {
      calibrationComplete:
        dependencies.config.releaseGates.calibrationComplete,
    })
    const billGenerated = billingView.cycle.billGenerated
    return {
      generatedAt: new Date().toISOString(),
      authority:
        billGenerated &&
        dependencies.config.releaseGates.reportingApproved
          ? 'authoritative'
          : billGenerated
            ? 'provisional'
            : 'audit_pending',
      billingCycle: billingView.cycle,
      snapshots: buildRevenueSnapshots(snapshots, {
        releaseVerifiedValues: billGenerated,
      }),
    }
  }
  if (pathname === '/api/v1/operations') {
    return collectOperations(dependencies.pool)
  }
  if (pathname === '/api/v1/audits') {
    const integer = (
      name: string,
      fallback: number,
      min: number,
      max: number,
    ): number => {
      const raw = url.searchParams.get(name)
      const value = raw == null ? fallback : Number(raw)
      return Number.isInteger(value) && value >= min && value <= max
        ? value
        : fallback
    }
    const safeFilter = (name: string): string | null => {
      const value = url.searchParams.get(name)?.trim() || null
      return value && /^[A-Za-z0-9_-]{1,80}$/.test(value)
        ? value
        : null
    }
    return collectAuditMonitor(dependencies.pool, {
      page: integer('page', 1, 1, 100_000),
      pageSize: integer('pageSize', 25, 10, 100),
      category: safeFilter('category'),
      language: safeFilter('language'),
    })
  }
  if (pathname === '/api/v1/imports') {
    if (!dependencies.imports) {
      throw new Error('Cycle import service is not configured')
    }
    return {
      ...(await dependencies.imports.status()),
      invoiceAiEnabled:
        dependencies.importAnalysis?.invoiceAiEnabled ?? false,
    }
  }
  throw new Error('Unsupported API route')
}

function apiPermission(pathname: string): string {
  if (pathname === '/api/v1/audits') return 'audit:inspect'
  if (pathname.startsWith('/api/v1/imports')) return 'import:write'
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

interface ApiCacheEntry {
  expiresAt: number
  value: Promise<unknown>
}

function pruneApiCache(cache: Map<string, ApiCacheEntry>): void {
  const now = Date.now()
  for (const [key, entry] of cache) {
    if (entry.expiresAt <= now) cache.delete(key)
  }
  while (cache.size >= 200) {
    const oldest = cache.keys().next()
    if (oldest.done) break
    cache.delete(oldest.value)
  }
}

function cacheTtlMs(pathname: string): number {
  if (pathname === '/api/v1/me') return 0
  if (
    pathname === '/api/v1/audits' ||
    pathname === '/api/v1/imports'
  ) {
    return 5_000
  }
  return 15_000
}

async function cachedApiResponse(
  url: URL,
  dependencies: Dependencies,
  context: AuthContext,
  cache: Map<string, ApiCacheEntry>,
): Promise<unknown> {
  const ttl = cacheTtlMs(url.pathname)
  if (ttl === 0) return apiResponse(url, dependencies, context)
  const key = `${context.user.roles.slice().sort().join(',')}:${url.pathname}${url.search}`
  const existing = cache.get(key)
  if (existing && existing.expiresAt > Date.now()) {
    return existing.value
  }
  pruneApiCache(cache)
  const value = apiResponse(url, dependencies, context)
  cache.set(key, {
    expiresAt: Date.now() + ttl,
    value,
  })
  try {
    return await value
  } catch (error) {
    cache.delete(key)
    throw error
  }
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
  const apiCache = new Map<string, ApiCacheEntry>()
  return http.createServer(async (request, response) => {
    const correlation = correlationId(
      request.headers['x-correlation-id'],
    )
    const url = requestUrl(request)
    const isImportPost =
      request.method === 'POST' &&
      (IMPORT_WRITE_ROUTES.has(url.pathname) ||
        IMPORT_ANALYSIS_ROUTES.has(url.pathname))
    const isPublicPost =
      request.method === 'POST' &&
      PUBLIC_POST_ROUTES.has(url.pathname)
    if (
      request.method === 'GET' &&
      (IMPORT_WRITE_ROUTES.has(url.pathname) ||
        IMPORT_ANALYSIS_ROUTES.has(url.pathname))
    ) {
      problem(
        response,
        405,
        'METHOD_NOT_ALLOWED',
        'Method not allowed',
        correlation,
      )
      return
    }
    if (
      request.method !== 'GET' &&
      !isImportPost &&
      !isPublicPost
    ) {
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
        const preview =
          dependencies.config.auth.mode === 'preview'
        const [dbResult, identityReady, auditReady] =
          await Promise.all([
            dependencies.pool.query('SELECT 1'),
            preview
              ? Promise.resolve(true)
              : dependencies.access.readiness(),
            preview
              ? Promise.resolve(true)
              : dependencies.audit.readiness(),
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
      PUBLIC_API_ROUTES.has(url.pathname) ||
      PUBLIC_POST_ROUTES.has(url.pathname) ||
      IMPORT_WRITE_ROUTES.has(url.pathname) ||
      IMPORT_ANALYSIS_ROUTES.has(url.pathname) ||
      APP_ROUTES.has(url.pathname) ||
      url.pathname === '/logout' ||
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

    if (url.pathname === '/logout') {
      const auth = dependencies.config.auth
      const location =
        auth.mode === 'oidc' ? auth.logoutUrl : '/login'
      if (!location) {
        problem(
          response,
          503,
          'LOGOUT_NOT_CONFIGURED',
          'Logout is not configured',
          correlation,
        )
        return
      }
      response.writeHead(302, {
        ...HTML_SECURITY_HEADERS,
        location,
        'x-correlation-id': correlation,
        ...(auth.mode === 'local'
          ? {
              'set-cookie': clearLocalSessionCookie(
                auth.sessionCookie,
              ),
            }
          : {}),
      })
      response.end()
      return
    }

    if (PUBLIC_API_ROUTES.has(url.pathname)) {
      sendJson(
        response,
        correlation,
        publicAuthConfig(dependencies),
      )
      return
    }

    if (PUBLIC_POST_ROUTES.has(url.pathname)) {
      const auth = dependencies.config.auth
      if (auth.mode !== 'local') {
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
        const contentType = request.headers['content-type'] || ''
        if (
          typeof contentType !== 'string' ||
          !contentType
            .toLowerCase()
            .startsWith('application/json')
        ) {
          const error = new Error(
            'Login requires application/json',
          )
          Object.assign(error, {
            code: 'INVALID_LOGIN_REQUEST',
            status: 400,
          })
          throw error
        }
        const bytes = await readRequestBody(request, 8 * 1024)
        const input = JSON.parse(bytes.toString('utf8')) as {
          email?: unknown
          password?: unknown
        }
        const email =
          typeof input.email === 'string'
            ? input.email.trim().toLowerCase()
            : ''
        const password =
          typeof input.password === 'string'
            ? input.password
            : ''
        const passwordValid = verifyLocalPassword(
          password,
          auth.passwordHash,
        )
        if (email !== auth.email || !passwordValid) {
          throw new AuthFailure(
            401,
            'AUTH_INVALID',
            'Email or password is incorrect',
          )
        }
        context = await authenticateLocal(email, dependencies.access)
        const token = issueLocalSession(
          email,
          auth.sessionSecret,
          auth.sessionTtlSeconds,
        )
        await auditAccess(
          dependencies,
          request,
          context,
          correlation,
          'success',
          'auth.login',
        )
        sendJson(
          response,
          correlation,
          {
            authenticated: true,
            email: context.user.email,
          },
          {
            'set-cookie': localSessionCookie(
              auth.sessionCookie,
              token,
              auth.sessionTtlSeconds,
            ),
          },
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
            'auth.login',
          )
        } catch {
          // Authentication still fails closed if audit storage is unavailable.
        }
        if (authFailure) {
          problem(
            response,
            error.status,
            error.code,
            error.message,
            correlation,
          )
          return
        }
        const shaped = error as {
          status?: number
          code?: string
          message?: string
        }
        problem(
          response,
          shaped.status ?? 400,
          shaped.code ?? 'INVALID_LOGIN_REQUEST',
          shaped.message ?? 'Login request is invalid',
          correlation,
        )
      }
      return
    }

    if (
      url.pathname === '/login' ||
      url.pathname.startsWith('/assets/')
    ) {
      const served = await serveApp(
        url.pathname,
        response,
        correlation,
        dependencies.webDistRoot ??
          path.resolve(process.cwd(), 'apps/web/dist'),
      )
      if (served) return
      problem(
        response,
        503,
        'APP_NOT_BUILT',
        'Web application is not built',
        correlation,
      )
      return
    }

    let context: AuthContext | null = null
    try {
      context = await authenticate(request, dependencies)
      if (isImportPost) {
        requirePermission(context, 'import:write')
        const bytes = await readRequestBody(request)
        const filename = header(request, 'x-kaudit-filename')
        let body: unknown
        if (IMPORT_ANALYSIS_ROUTES.has(url.pathname)) {
          if (!dependencies.importAnalysis) {
            const error = new Error(
              'OpenAI invoice analysis is not configured',
            )
            Object.assign(error, {
              code: 'IMPORT_ANALYSIS_NOT_CONFIGURED',
              status: 503,
            })
            throw error
          }
          body =
            url.pathname === '/api/v1/imports/analyze-usage'
              ? await dependencies.importAnalysis.analyzeUsage(bytes)
              : await dependencies.importAnalysis.analyzeInvoice(
                  bytes,
                  filename,
                )
        } else {
          if (!dependencies.imports) {
            throw new Error('Cycle import service is not configured')
          }
          body =
            url.pathname === '/api/v1/imports/usage'
              ? await dependencies.imports.importUsage({
                bytes,
                filename,
                periodStart: header(request, 'x-kaudit-period-start'),
                periodEnd: header(request, 'x-kaudit-period-end'),
                correlationId: correlation,
              })
              : await dependencies.imports.importInvoice({
                bytes,
                filename,
                invoiceNumber: header(request, 'x-kaudit-invoice-number'),
                invoiceDate: header(request, 'x-kaudit-invoice-date'),
                periodStart: header(request, 'x-kaudit-period-start'),
                periodEnd: header(request, 'x-kaudit-period-end'),
                subtotalAmount: header(request, 'x-kaudit-subtotal-amount'),
                taxAmount: header(request, 'x-kaudit-tax-amount'),
                totalAmount: header(request, 'x-kaudit-total-amount'),
                correlationId: correlation,
              })
        }
        await auditAccess(
          dependencies,
          request,
          context,
          correlation,
          'success',
          url.pathname.endsWith('/analyze-usage')
            ? 'usage_import.analyze'
            : url.pathname.endsWith('/analyze-invoice')
              ? 'invoice_import.analyze'
              : url.pathname.endsWith('/usage')
                ? 'usage_import.create'
                : 'invoice_import.create',
        )
        apiCache.clear()
        sendJson(response, correlation, body)
        return
      }
      if (API_ROUTES.has(url.pathname)) {
        requirePermission(context, apiPermission(url.pathname))
        const action =
          url.pathname === '/api/v1/me'
            ? 'identity.read'
            : `${url.pathname.split('/').at(-1)}.read`
        const body = await cachedApiResponse(
          url,
          dependencies,
          context,
          apiCache,
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
      requirePermission(
        context,
        url.pathname === '/audits'
          ? 'audit:inspect'
          : url.pathname === '/imports/new'
            ? 'import:write'
            : 'metrics:read',
      )
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
        if (APP_ROUTES.has(url.pathname) && error.status === 401) {
          response.writeHead(302, {
            ...HTML_SECURITY_HEADERS,
            location: '/login',
            'x-correlation-id': correlation,
          })
          response.end()
          return
        }
        problem(
          response,
          error.status,
          error.code,
          error.message,
          correlation,
        )
      } else {
        const shaped = error as {
          status?: number
          code?: string
          message?: string
        }
        if (
          typeof shaped.status === 'number' &&
          shaped.status >= 400 &&
          shaped.status < 500
        ) {
          problem(
            response,
            shaped.status,
            shaped.code ?? 'INVALID_REQUEST',
            shaped.message ?? 'Invalid request',
            correlation,
          )
          return
        }
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
