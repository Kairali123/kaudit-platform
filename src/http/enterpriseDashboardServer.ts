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
  parseCookie,
  requirePermission,
} from '../auth/authenticate.ts'
import {
  boundedFlowFailure,
  callbackUrlFor,
  clearOidcIdentityCookie,
  clearOidcTransactionCookie,
  identityCookieMaxAge,
  oidcIdentityCookie,
  oidcTransactionCookie,
  stateMatches,
  OidcBrowserFlowError,
  OIDC_CALLBACK_ROUTE,
  OIDC_LOGIN_ROUTE,
  OIDC_LOGIN_SUCCESS_PATH,
  OIDC_TRANSACTION_COOKIE,
} from '../auth/oidcBrowserFlow.ts'
import type { OidcAuthorizationClient } from '../auth/oidcAuthorizationClient.ts'
import type { CredentialRepository } from '../auth/credentialTypes.ts'
import type { LoginServicePort } from '../auth/loginService.ts'
import {
  clearUserSessionCookie,
  isSessionCurrent,
  issueUserSession,
  userSessionCookie,
  verifyUserSession,
} from '../auth/userSession.ts'
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
import {
  UserAdminError,
  type AssignableRole,
  type UserAdministrationPort,
} from '../identity/userAdministration.ts'
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
import { createMysqlAuditWorkerControl } from '../adapters/mysqlAuditWorkerControl.ts'
import {
  parseAuditSystem,
  parseDesiredState,
  settleStaleWorker,
  type AuditWorkerControlPort,
} from '../auditWorkers/control.ts'
import {
  AuditWorkerDispatchError,
  type AuditWorkerDispatcher,
} from '../auditWorkers/dispatcher.ts'
import {
  ManualReauditError,
  parseManualReauditRequest,
  MANUAL_REAUDIT_ROUTE,
  type ManualReauditRequestPort,
} from '../reaudit/manualRequests.ts'
import { createMysqlManualReauditRequestRepository } from '../adapters/mysqlManualReauditQueue.ts'
import { collectBillingMonths } from '../adapters/mysqlBillingMonths.ts'
import {
  createMysqlBillingCategoryAnalysisRepository,
  type BillingCategoryAnalysisPort,
} from '../adapters/mysqlBillingCategoryAnalysis.ts'
import {
  buildBillingCategoryAnalysis,
  parseBillingCategoryAnalysisQuery,
  BILLING_CATEGORY_ANALYSIS_PAGE_ROUTE,
  BILLING_CATEGORY_ANALYSIS_ROUTE,
} from '../reporting/billingCategoryAnalysis.ts'
import {
  createMysqlKserveSettlementRepository,
  type KserveSettlementRepository,
} from '../adapters/mysqlKserveSettlement.ts'
import {
  createMysqlKserveVendorBilledRepository,
  type KserveVendorBilledPort,
} from '../adapters/mysqlKserveVendorBilled.ts'
import {
  buildKserveSettlementView,
  toSettlementSummary,
  unavailableSettlementSummary,
  KSERVE_SETTLEMENT_ROUTE,
  type KserveSettlementDto,
  type KserveSettlementSummary,
} from '../reporting/kserveSettlement.ts'
import {
  KserveSettlementConflictError,
  KserveSettlementInputError,
  KserveSettlementUnavailableError,
  asSafeSettlementError,
  parseHistoryLimit,
  parseSettlementMonth,
  DEFAULT_SETTLEMENT_HISTORY,
} from '../billing/kserveSettlement.ts'
import {
  collectReportEmailDeliveryStatus,
} from '../adapters/mysqlReportEmail.ts'
import {
  parseBillingMonth,
  type BillingMonthScope,
} from '../reporting/billingMonth.ts'
import { USER_PERMISSIONS } from '../identity/access.ts'
import { canViewCallContent } from '../identity/access.ts'
import {
  collectAdminCallDetail,
  resolveAdminCallAccess,
  type AdminCallAccess,
} from '../adapters/mysqlAdminCallDetail.ts'
import { createMysqlCallAuditReportingRepository } from '../adapters/mysqlCallAuditReporting.ts'
import type { CallAuditReportingRepository } from '../adapters/mysqlCallAuditReporting.ts'
import {
  buildCallAuditReport,
  parseCallAuditReportQuery,
  CALL_AUDIT_PAGE_ROUTE,
  CALL_AUDIT_REPORT_ROUTE,
} from '../reporting/callAuditReport.ts'
import {
  createMysqlCallAuditSettingsRepository,
} from '../adapters/mysqlCallAuditSettings.ts'
import {
  createMysqlCallAuditControlRepository,
  CallAuditControlConflictError,
  CallAuditControlError,
  type CallAuditControlRepository,
} from '../adapters/mysqlCallAuditControl.ts'
import {
  buildCallAuditSettings,
  applicationConfigSha256,
  naiveUtcTimestamp,
  parseCallAuditSettingsActivate,
  parseCallAuditSettingsCreate,
  parseCallAuditSettingsQuery,
  toActivateResultDto,
  toCreateResultDto,
  isSafeRuleVersionId,
  CALL_AUDIT_RULE_ACTIVATE_ROUTE,
  CALL_AUDIT_RULE_TEST_ROUTE,
  CALL_AUDIT_SETTINGS_PAGE_ROUTE,
  CALL_AUDIT_SETTINGS_ROUTE,
  type CallAuditRuleVersionDetailRecord,
  type CallAuditSettingsActivateResultDto,
  type CallAuditSettingsCreateResultDto,
  type CallAuditSettingsReadPort,
} from '../callaudit/adminSettings.ts'
import { buildRuleActivation } from '../callaudit/ruleActivation.ts'
import { CallAuditRuleError } from '../callaudit/ruleContract.ts'
import {
  parseCallAuditRuleTestSubmission,
  runCallAuditRuleTest,
  CALL_AUDIT_RULE_TEST_BOUNDARY,
  CallAuditRuleTestError,
  type CallAuditRuleTestResult,
} from '../callaudit/ruleTestLab.ts'
import { CallAuditModelRequestError } from '../adapters/openaiCallAuditModel.ts'
import type { ContentAuditModelAdapter } from '../adapters/openaiCallAuditModel.ts'
import type { UrlFetcher } from '../storage/ports.ts'
import { isSafeVendorUrl } from '../security/urlSafety.ts'
import { sha256Hex } from '../lib/hash.ts'
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
import {
  recordApiCache,
  startRequestTiming,
  timeAudit,
} from '../runtime/performance.ts'

interface Dependencies {
  config: RuntimeConfig
  pool: Pool
  access: AccessRepository
  audit: AuditSink
  verifier: TokenVerifier | null
  credentials?: CredentialRepository
  loginService?: LoginServicePort
  userAdministration?: UserAdministrationPort
  /**
   * The authorization-code browser flow's protocol edge. Constructed by the
   * shared runtime factory only when `config.auth.browserFlow` is set, and
   * injected here so a server test can exercise the routes with no provider,
   * no discovery request, and no socket. Absent means the routes report
   * themselves unknown.
   */
  oidcAuthorizationClient?: OidcAuthorizationClient
  imports?: CycleImportService
  importAnalysis?: ImportAnalysisService
  recordingFetcher?: UrlFetcher
  allowedRecordingHosts?: string[]
  /**
   * Sanitized Call Audit reporting reads. Defaults to the MySQL repository over
   * the same pool; injectable so a server test can run against a synthetic
   * repository without a database.
   */
  callAuditReporting?: CallAuditReportingRepository
  /**
   * Admin-only Billing Audit category analysis. Defaults to the read-only MySQL
   * read model over the same pool; injectable so a server test can exercise the
   * route against synthetic rows without a database.
   */
  billingCategoryAnalysis?: BillingCategoryAnalysisPort
  /**
   * Append-only monthly KServe settlement store. Defaults to the MySQL
   * repository over the same pool; injectable so a server test can exercise the
   * admin-only read and save against synthetic rows without a database.
   */
  kserveSettlement?: KserveSettlementRepository
  /**
   * THE shared KServe vendor-billed read model. The settlement page and the
   * monthly report both take the billed side of "savings" from here, so the two
   * surfaces cannot drift onto different definitions of the vendor's charge.
   */
  kserveVendorBilled?: KserveVendorBilledPort
  /**
   * Admin-only Call Audit settings reads. Defaults to the read-only MySQL
   * repository over the same pool; injectable for tests.
   */
  callAuditSettings?: CallAuditSettingsReadPort
  /**
   * Immutable Call Audit rule snapshots plus audited lifecycle switches.
   * Lifecycle writes never modify prompt, model, schema, taxonomy, or hashes.
   */
  callAuditControl?: CallAuditControlRepository
  /**
   * Content model port for the admin rule TEST LAB. Injected only: this server
   * configures no provider client, so the endpoint reports itself unavailable
   * rather than reaching for a network or an environment variable.
   */
  callAuditRuleTestModel?: ContentAuditModelAdapter
  /** Durable administrator intent and privacy-safe worker observations. */
  auditWorkerControl?: AuditWorkerControlPort
  /**
   * The durable, Kaudit-owned queue behind the Audit Monitor's re-audit action.
   * Defaults to the MySQL repository over the same pool; injectable so a server
   * test can exercise authorization, privacy and idempotency against synthetic
   * receipts without a database and without any model spend.
   */
  manualReauditRequests?: ManualReauditRequestPort
  /** Starts a bounded external worker without exposing its provider details. */
  auditWorkerDispatcher?: AuditWorkerDispatcher
  webDistRoot?: string
}

const APP_ROUTES = new Set([
  '/',
  '/login',
  '/overview',
  '/evidence',
  '/findings',
  '/billing',
  BILLING_CATEGORY_ANALYSIS_PAGE_ROUTE,
  '/reports',
  '/operations',
  '/audits',
  '/audits/call',
  CALL_AUDIT_PAGE_ROUTE,
  '/users',
  CALL_AUDIT_SETTINGS_PAGE_ROUTE,
  '/imports/new',
])

const API_ROUTES = new Set([
  '/api/v1/me',
  '/api/v1/periods',
  '/api/v1/overview',
  '/api/v1/evidence',
  '/api/v1/findings',
  '/api/v1/billing',
  BILLING_CATEGORY_ANALYSIS_ROUTE,
  KSERVE_SETTLEMENT_ROUTE,
  '/api/v1/reports',
  '/api/v1/operations',
  '/api/v1/audits',
  '/api/v1/audit-workers',
  '/api/v1/audit-call',
  '/api/v1/audit-audio',
  '/api/v1/imports',
  '/api/v1/users',
  CALL_AUDIT_REPORT_ROUTE,
  CALL_AUDIT_SETTINGS_ROUTE,
  CALL_AUDIT_RULE_ACTIVATE_ROUTE,
  CALL_AUDIT_RULE_TEST_ROUTE,
])

/**
 * Administrator-authored Call Audit rule settings. POST only; the GET of the
 * same path is the admin read above. Both are gated on `config:manage`.
 */
const CALL_AUDIT_SETTINGS_WRITE_ROUTES = new Set([
  CALL_AUDIT_SETTINGS_ROUTE,
  CALL_AUDIT_RULE_ACTIVATE_ROUTE,
])

/**
 * The rule test lab. POST only — there is nothing to GET, because a test is
 * transient and no attempt is stored — and gated on the same `config:manage`
 * boundary as the settings it exercises.
 */
const CALL_AUDIT_RULE_TEST_ROUTES = new Set([CALL_AUDIT_RULE_TEST_ROUTE])
const AUDIT_WORKER_CONTROL_ROUTE = '/api/v1/audit-workers/control'
const AUDIT_WORKER_WRITE_ROUTES = new Set([AUDIT_WORKER_CONTROL_ROUTE])

/**
 * Administrator-requested Billing Audit re-audits. POST only — there is nothing
 * to GET, because the per-row state the page needs already rides on the audit
 * monitor read — and gated on the same `audit:control` boundary as starting a
 * worker, because this queues PAID model work.
 */
const MANUAL_REAUDIT_WRITE_ROUTES = new Set([MANUAL_REAUDIT_ROUTE])

/**
 * At most 100 displayed references and one bounded retry key. The byte bound is
 * applied before a single byte is parsed, so an unbounded stream is never
 * buffered on the way to a validator that would refuse it anyway.
 */
const MAX_MANUAL_REAUDIT_BODY_BYTES = 32 * 1024

/**
 * Recording the amount finally paid to KServe. POST only on the same path as
 * the admin read above, exactly as the Call Audit settings routes do, and gated
 * on the same `billing:approve` money boundary as that read.
 */
const KSERVE_SETTLEMENT_WRITE_ROUTES = new Set([KSERVE_SETTLEMENT_ROUTE])

/**
 * A settlement body is one month, one amount, and one retry key. Anything
 * larger is a bug, and the bound is applied before a byte is parsed.
 */
const MAX_KSERVE_SETTLEMENT_BODY_BYTES = 2 * 1024

/** An administrator's settings submission is small; anything larger is a bug. */
const MAX_SETTINGS_BODY_BYTES = 64 * 1024

/**
 * A test submission carries a whole transcript, so it is bounded separately and
 * far more generously than a settings save — but still bounded. The adapter
 * holds the authoritative character limit; this only keeps an unbounded stream
 * from being buffered before that limit can be applied.
 */
const MAX_RULE_TEST_BODY_BYTES = 1024 * 1024

const PUBLIC_API_ROUTES = new Set(['/api/v1/auth/config'])
const PUBLIC_POST_ROUTES = new Set(['/api/v1/auth/login'])
const USER_ADMIN_WRITE_ROUTES = new Set([
  '/api/v1/users/create',
  '/api/v1/users/update',
  '/api/v1/users/activation',
  '/api/v1/users/password',
  '/api/v1/users/tombstone',
])
const MAX_USER_ADMIN_BODY_BYTES = 16 * 1024
const MAX_AUDIT_WORKER_BODY_BYTES = 2 * 1024

/**
 * The two public GETs of the authorization-code browser flow.
 *
 * Public by necessity — a caller starting a sign-in has no session yet, and the
 * provider's redirect back arrives without one either. Neither reads a body,
 * neither touches the database beyond the access-audit write, and neither
 * returns anything but a redirect or a fixed problem document.
 */
const OIDC_BROWSER_FLOW_ROUTES = new Set([
  OIDC_LOGIN_ROUTE,
  OIDC_CALLBACK_ROUTE,
])
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
  /** Extra response headers; used to clear a cookie while refusing. */
  headers: Record<string, string | string[]> = {},
): void {
  response.writeHead(status, {
    ...JSON_SECURITY_HEADERS,
    'content-type':
      'application/problem+json; charset=utf-8',
    'x-correlation-id': correlation,
    ...headers,
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
  if (dependencies.config.auth.mode === 'database') {
    const auth = dependencies.config.auth
    const token = parseCookie(request.headers.cookie, auth.sessionCookie)
    const claims = verifyUserSession(token, auth.sessionSecret)
    if (!claims || !dependencies.credentials || !dependencies.access.findById) {
      throw new AuthFailure(401, 'AUTH_REQUIRED', 'Authentication is required')
    }
    const state = await dependencies.credentials.getSessionState(claims.sub)
    if (!isSessionCurrent(claims, state)) {
      throw new AuthFailure(401, 'AUTH_INVALID', 'Authentication session is invalid')
    }
    const user = await dependencies.access.findById(claims.sub)
    if (!user || user.id !== claims.sub || user.status !== 'active') {
      throw new AuthFailure(401, 'AUTH_INVALID', 'Authentication session is invalid')
    }
    return { user, issuer: 'kaudit-database', subject: user.id }
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

/**
 * What the browser flow needs, or null when this deployment does not run it.
 *
 * All four conditions are required together. `config.auth.browserFlow` is the
 * operator's deny-by-default gate, `tokenCookie` is where a validated token
 * would go, and the client is the dependency the runtime factory only builds
 * when the first two hold. A missing piece means the routes do not exist here —
 * not that they exist in a degraded form.
 */
interface OidcBrowserFlowRuntime {
  client: OidcAuthorizationClient
  redirectUri: string
  tokenCookie: string
  maxTokenAgeSeconds: number
}

function oidcBrowserFlowRuntime(
  dependencies: Dependencies,
): OidcBrowserFlowRuntime | null {
  const auth = dependencies.config.auth
  if (auth.mode !== 'oidc' || !auth.browserFlow || !auth.tokenCookie) {
    return null
  }
  const client = dependencies.oidcAuthorizationClient
  if (!client) return null
  return {
    client,
    redirectUri: auth.browserFlow.redirectUri,
    tokenCookie: auth.tokenCookie,
    maxTokenAgeSeconds: auth.maxTokenAgeSeconds,
  }
}

/**
 * The only thing written to the process log for a sign-in.
 *
 * A fixed event name, one of the flow's bounded codes, and the correlation id.
 * No query string, no code, no state, no nonce, no verifier, no token, no
 * provider text, no client id, no claim, and no thrown value — the request is
 * not even in scope here, so none of that can be reached by a later edit.
 */
function logOidcFlowEvent(
  event: 'oidc_login_started' | 'oidc_callback_completed' | 'oidc_flow_refused',
  code: string,
  correlation: string,
): void {
  process.stderr.write(
    `${JSON.stringify({
      level: event === 'oidc_flow_refused' ? 'warn' : 'info',
      event,
      code,
      correlationId: correlation,
      occurredAt: new Date().toISOString(),
    })}\n`,
  )
}

/**
 * Starts a sign-in: mint state, nonce and a PKCE S256 pair, park them in the
 * transaction cookie, and redirect to the provider's authorization endpoint.
 *
 * The authorization URL is built by the library from discovered metadata, so
 * neither the provider's endpoints nor this deployment's hostname is written
 * down. Nothing is stored server-side, and the response has no body.
 */
async function handleOidcLogin(
  flow: OidcBrowserFlowRuntime,
  response: ServerResponse,
  correlation: string,
): Promise<void> {
  try {
    const start = await flow.client.beginAuthorization()
    logOidcFlowEvent('oidc_login_started', 'OIDC_LOGIN_REDIRECT', correlation)
    response.writeHead(302, {
      ...HTML_SECURITY_HEADERS,
      location: start.authorizationUrl.toString(),
      // The sealed envelope, never the raw transaction: only a value this
      // deployment's key authenticated is accepted back at the callback.
      'set-cookie': oidcTransactionCookie(start.transactionCookie),
      'x-correlation-id': correlation,
    })
    response.end()
  } catch (error) {
    const failure =
      error instanceof OidcBrowserFlowError
        ? error
        : new OidcBrowserFlowError('OIDC_LOGIN_START_FAILED')
    logOidcFlowEvent('oidc_flow_refused', failure.code, correlation)
    problem(
      response,
      failure.status,
      failure.code,
      failure.message,
      correlation,
      // A started transaction that cannot be redirected is not resumable.
      { 'set-cookie': clearOidcTransactionCookie() },
    )
  }
}

/**
 * What a callback turned out to be, before anything is written to the browser.
 *
 * `authenticated` is not yet a sign-in: it says the exchange and the ID token
 * validation succeeded and names the cookie that *would* be issued. Whether it
 * is issued at all is decided after the access audit, by the caller.
 */
type OidcCallbackResolution =
  | { kind: 'authenticated'; idToken: string; maxAgeSeconds: number }
  | { kind: 'refused'; failure: OidcBrowserFlowError }

/**
 * Resolves a callback. Writes nothing, logs nothing, sets no cookie.
 *
 * The order is deliberate. A provider refusal is recognized before anything
 * else is read; the transaction cookie must open under this deployment's key;
 * the returned `state` must match it exactly before a code is presented
 * anywhere; the exchange runs server to server against a callback URL rebuilt
 * from configuration; and only a validated ID token yields `authenticated`.
 *
 * Keeping the response out of this function is what makes the audit ordering in
 * the caller structural rather than a matter of statement order: there is no
 * `response` in scope here, so nothing in this path can commit one early.
 *
 * Authorization is unchanged and is not performed here: the identity cookie
 * only carries a verified token, and the next request still has to resolve a
 * provisioned, active user through the existing `authenticate` path.
 */
async function resolveOidcCallback(
  flow: OidcBrowserFlowRuntime,
  request: IncomingMessage,
  url: URL,
): Promise<OidcCallbackResolution> {
  try {
    if (url.searchParams.has('error')) {
      // The parameter's value is never read. `error_description` is provider
      // prose and `error_uri` is a provider URL; reflecting either is how a
      // callback becomes a content-injection surface.
      throw new OidcBrowserFlowError('OIDC_PROVIDER_REFUSED')
    }
    // Opened behind the authorization client's edge, under the key derived
    // from the client secret. A cookie written by a sibling host on a shared
    // parent domain carries no valid authenticator and is refused here — one
    // bounded code, and before any code reaches the token endpoint.
    const transaction = flow.client.openTransaction(
      parseCookie(request.headers.cookie, OIDC_TRANSACTION_COOKIE),
    )
    if (!stateMatches(url.searchParams.get('state'), transaction.state)) {
      throw new OidcBrowserFlowError('OIDC_STATE_MISMATCH')
    }
    const verified = await flow.client.exchange({
      callbackUrl: callbackUrlFor(flow.redirectUri, url.search),
      expectedState: transaction.state,
      expectedNonce: transaction.nonce,
      codeVerifier: transaction.codeVerifier,
    })
    const maxAgeSeconds = identityCookieMaxAge(
      verified.expiresAtSeconds,
      flow.maxTokenAgeSeconds,
      Math.floor(Date.now() / 1000),
    )
    if (maxAgeSeconds <= 0) {
      // Validated but already spent. Setting a cookie the verifier would reject
      // on the very next request would present itself to the operator as a
      // successful sign-in that silently does not work.
      throw new OidcBrowserFlowError('OIDC_IDENTITY_UNVERIFIED')
    }
    return { kind: 'authenticated', idToken: verified.idToken, maxAgeSeconds }
  } catch (error) {
    // The thrown value is dropped unread; only a fixed code survives.
    return { kind: 'refused', failure: boundedFlowFailure(error) }
  }
}

/**
 * How a refusal is recorded, matching the local login path.
 *
 * There, an `AuthFailure` — a 4xx the caller caused — is `denied`, and anything
 * else is `failure`. The browser flow's codes carry the same distinction in
 * their status: a missing transaction, a state mismatch or an unverifiable
 * identity is `denied`; an unreachable provider or a failed exchange is a
 * `failure` of this deployment's dependency, not a rejected caller.
 */
function oidcAuditOutcome(
  failure: OidcBrowserFlowError,
): 'denied' | 'failure' {
  return failure.status >= 500 ? 'failure' : 'denied'
}

/**
 * Completes a sign-in, or refuses it, writing exactly one response.
 *
 * The rule this function exists to enforce: **a successful exchange sets no
 * identity cookie and produces no success redirect until the durable access
 * audit for it has completed.** That is the same order the local password
 * login uses — `auditAccess` is awaited before `issueLocalSession`'s cookie is
 * handed to `sendJson` — and it is why the audit here is not a fire-and-forget
 * write after the response.
 *
 * If the audit sink cannot record the event, the sign-in fails closed: a
 * bounded 502, the transaction cookie cleared, no identity cookie, and nothing
 * from the thrown value in the log. An operator sees a failed sign-in they can
 * retry, rather than a session with no record that it was ever granted.
 *
 * A refusal still audits — `denied` or `failure` — but an audit sink that is
 * itself unavailable cannot turn a refusal into something else, so that write
 * is bounded and its failure changes nothing about the response.
 *
 * Every outcome clears the transaction cookie, so a code replayed against the
 * same transaction finds nothing to replay against.
 */
async function handleOidcCallback(
  dependencies: Dependencies,
  flow: OidcBrowserFlowRuntime,
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  correlation: string,
): Promise<void> {
  const resolution = await resolveOidcCallback(flow, request, url)
  // Recorded with a null actor: the callback resolves no user, and the claims
  // it did validate are not written anywhere. Only that a sign-in completed or
  // was refused, from this address, at this time.
  let recorded = true
  try {
    await auditAccess(
      dependencies,
      request,
      null,
      correlation,
      resolution.kind === 'authenticated'
        ? 'success'
        : oidcAuditOutcome(resolution.failure),
      'auth.oidc_callback',
    )
  } catch {
    // Nothing from the thrown value is read, kept, or logged.
    recorded = false
  }

  if (resolution.kind === 'authenticated' && recorded) {
    logOidcFlowEvent(
      'oidc_callback_completed',
      'OIDC_LOGIN_COMPLETE',
      correlation,
    )
    response.writeHead(302, {
      ...HTML_SECURITY_HEADERS,
      location: OIDC_LOGIN_SUCCESS_PATH,
      'set-cookie': [
        clearOidcTransactionCookie(),
        oidcIdentityCookie(
          flow.tokenCookie,
          resolution.idToken,
          resolution.maxAgeSeconds,
        ),
      ],
      'x-correlation-id': correlation,
    })
    response.end()
    return
  }

  const failure =
    resolution.kind === 'authenticated'
      ? new OidcBrowserFlowError('OIDC_ACCESS_NOT_RECORDED')
      : resolution.failure
  logOidcFlowEvent('oidc_flow_refused', failure.code, correlation)
  problem(response, failure.status, failure.code, failure.message, correlation, {
    'set-cookie': clearOidcTransactionCookie(),
  })
}

async function auditAccess(
  dependencies: Dependencies,
  request: IncomingMessage,
  context: AuthContext | null,
  correlation: string,
  outcome: 'success' | 'denied' | 'failure',
  action: string,
  resourceType = 'aggregate_dashboard',
  resourceId: string | null = null,
  purpose = 'audit_operations',
): Promise<void> {
  if (dependencies.config.auth.mode === 'preview') return
  await timeAudit(() => dependencies.audit.record({
    actorUserId: context?.user.id ?? null,
    actorEmail: context?.user.email ?? null,
    action,
    resourceType,
    resourceId,
    outcome,
    purpose,
    correlationId: correlation,
    ipAddress: clientAddress(
      request,
      dependencies.config.trustProxy,
    ),
    client: userAgent(request),
    occurredAt: new Date(),
  }))
}

async function resolveContentCall(
  url: URL,
  dependencies: Dependencies,
  context: AuthContext,
): Promise<AdminCallAccess> {
  const task = url.searchParams.get('task')?.trim() || ''
  const access = await resolveAdminCallAccess(
    dependencies.pool,
    task,
  )
  if (!access) {
    const error = new Error('Call was not found')
    Object.assign(error, { code: 'CALL_NOT_FOUND', status: 404 })
    throw error
  }
  if (
    !canViewCallContent(
      context.user.maxSensitivityTier,
      access.sensitivityTier,
    )
  ) {
    throw new AuthFailure(
      403,
      'PERMISSION_DENIED',
      'Your account cannot access this call content',
    )
  }
  return access
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
      label: dependencies.config.releaseGates
        .automatedValidationApproved
        ? 'Automated validation'
        : 'AI calibration',
      detail: dependencies.config.releaseGates
        .automatedValidationApproved
        ? 'Leadership-approved model consensus is active; this is not human-labeled ground truth'
        : dependencies.config.releaseGates.calibrationComplete
          ? 'Human-labeled calibration gate recorded complete'
          : 'Accuracy has not been measured',
      status: (
        dependencies.config.releaseGates.calibrationComplete ||
        dependencies.config.releaseGates
          .automatedValidationApproved
      )
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
  const browserFlow = Boolean(oidcBrowserFlowRuntime(dependencies))
  return {
    mode: auth.mode,
    providerLabel:
      auth.mode === 'oidc'
        ? 'Kairali SSO'
        : auth.mode === 'database'
          ? 'Kairali account'
        : auth.mode === 'local'
          ? 'Local Kairali account'
          : 'Local preview',
    // The browser flow's own route when this deployment runs it, so the
    // existing UI navigates here instead of to a provider URL. Configuration
    // rejects having both, so this is a choice between exclusive states rather
    // than a precedence rule. Neither value carries a client id or a secret.
    loginUrl: browserFlow
      ? OIDC_LOGIN_ROUTE
      : auth.mode === 'oidc'
        ? auth.loginUrl
        : null,
    logoutUrl:
      auth.mode === 'oidc'
        ? (auth.logoutUrl ?? (browserFlow ? '/login' : null))
        : '/login',
    accessControlEnforced: auth.mode !== 'preview',
    passwordLoginSupported:
      auth.mode === 'local' || auth.mode === 'database',
  }
}

function settingsRepository(
  dependencies: Dependencies,
): CallAuditSettingsReadPort {
  return (
    dependencies.callAuditSettings ??
    createMysqlCallAuditSettingsRepository(dependencies.pool)
  )
}

/**
 * Re-shapes a typed Call Audit settings failure into the client-safe problem
 * the server already knows how to render.
 *
 * Every message below names an entity and a FIELD only — the rule contract and
 * the control repository both refuse to echo a submitted value — so a rejected
 * save can be returned and logged without leaking a prompt, a label, or a hash.
 */
function callAuditSettingsFailure(error: unknown): never {
  if (
    error instanceof CallAuditRuleError ||
    error instanceof CallAuditControlConflictError ||
    error instanceof CallAuditControlError
  ) {
    throw Object.assign(new Error(error.message), {
      code: error.code,
      // A conflicting or forbidden lifecycle is a state disagreement, not a
      // malformed request: an activated contract is immutable by design.
      status: error instanceof CallAuditRuleError ? 400 : 409,
    })
  }
  throw error
}

/**
 * Creates a new immutable rule-version snapshot, optionally activated.
 *
 * Create-and-activate inserts a new active snapshot and therefore succeeds only
 * while no version is live. Switching to a stored version is the distinct
 * lifecycle route below; neither path edits rule contents.
 */
async function createCallAuditRuleVersion(
  dependencies: Dependencies,
  body: unknown,
  actorUserId: string | null,
): Promise<CallAuditSettingsCreateResultDto> {
  try {
    const request = parseCallAuditSettingsCreate(body, actorUserId)
    const snapshot = buildRuleActivation(request.settings)
    const createdAt = naiveUtcTimestamp()
    const control =
      dependencies.callAuditControl ??
      createMysqlCallAuditControlRepository(dependencies.pool)
    const status = request.activate ? 'active' : 'draft'
    const saved = await control.saveRuleVersionSnapshot(snapshot, {
      status,
      createdBy: request.createdBy,
      changeReason: request.changeReason,
      activatedBy: request.activate ? request.createdBy : null,
      activatedAt: request.activate ? createdAt : null,
    })
    return toCreateResultDto({
      ruleVersionId: saved.id,
      versionLabel: snapshot.versionLabel,
      status,
      outcome: saved.outcome,
      promptSha256: snapshot.promptSha256,
      configSha256: snapshot.configSha256,
      createdAt,
    })
  } catch (error) {
    callAuditSettingsFailure(error)
  }
}

/** Atomically switches the live pointer to one compatible stored snapshot. */
async function activateCallAuditRuleVersion(
  dependencies: Dependencies,
  body: unknown,
  actorUserId: string | null,
): Promise<CallAuditSettingsActivateResultDto> {
  try {
    const request = parseCallAuditSettingsActivate(body, actorUserId)
    const activatedAt = naiveUtcTimestamp()
    const control =
      dependencies.callAuditControl ??
      createMysqlCallAuditControlRepository(dependencies.pool)
    const activated = await control.activateRuleVersion({
      ruleVersionId: request.ruleVersionId,
      activatedBy: request.activatedBy,
      activatedAt,
      requiredConfigSha256: applicationConfigSha256(),
    })
    return toActivateResultDto({
      ruleVersionId: activated.id,
      outcome: activated.outcome,
      activatedAt,
    })
  } catch (error) {
    callAuditSettingsFailure(error)
  }
}

/** Reads and parses a small JSON request body, rejecting any other media type. */
async function readJsonBody(
  request: IncomingMessage,
  maximumBytes: number,
  code = 'INVALID_CALL_AUDIT_SETTINGS_REQUEST',
): Promise<unknown> {
  const type = request.headers['content-type'] || ''
  if (
    typeof type !== 'string' ||
    !type.toLowerCase().startsWith('application/json')
  ) {
    const error = new Error('Request requires application/json')
    Object.assign(error, { code, status: 415 })
    throw error
  }
  let bytes: Buffer
  try {
    bytes = await readRequestBody(request, maximumBytes)
  } catch (error) {
    // The shared reader's prose is sized for 25 MB file imports; a JSON body
    // states its own bound instead. Its code and status carry through, and
    // neither message quotes the submitted text.
    const shaped = error as { code?: string; status?: number }
    throw Object.assign(
      new Error(
        shaped.code === 'UPLOAD_TOO_LARGE'
          ? `Request body exceeds the ${maximumBytes} byte limit`
          : 'Request body is required',
      ),
      { code: shaped.code ?? code, status: shaped.status ?? 400 },
    )
  }
  try {
    return JSON.parse(bytes.toString('utf8')) as unknown
  } catch {
    // The parser message can quote the submitted body, so it is discarded.
    const error = new Error('Request body is not valid JSON')
    Object.assign(error, { code, status: 400 })
    throw error
  }
}

/**
 * Re-shapes a typed rule-test failure into a client-safe problem.
 *
 * Both typed errors name a FIELD and never echo a value, so the message is safe
 * to return and to log. A stored version that no longer satisfies the rule
 * contract is a state disagreement rather than a malformed request, so it
 * answers 409 and the administrator is pointed at the version, not the paste.
 */
function callAuditRuleTestFailure(error: unknown): never {
  if (
    error instanceof CallAuditRuleTestError ||
    error instanceof CallAuditModelRequestError
  ) {
    throw Object.assign(new Error(error.message), {
      code: error.code,
      status: 400,
    })
  }
  if (error instanceof CallAuditRuleError) {
    throw Object.assign(new Error(error.message), {
      code: error.code,
      status: 409,
    })
  }
  throw error
}

/** A rule version could not be resolved. Says which lookup failed, nothing else. */
function ruleVersionUnavailable(
  status: number,
  code: string,
  message: string,
): never {
  throw Object.assign(new Error(message), { code, status })
}

/**
 * Resolves the version under test: the explicitly requested one, or the active
 * one. The prompt read is EXPLICIT and separate, so it happens once a version
 * is known and never as a side effect of listing.
 */
async function resolveRuleTestVersion(
  repository: CallAuditSettingsReadPort,
  ruleVersionId: string | null,
): Promise<CallAuditRuleVersionDetailRecord> {
  let wanted = ruleVersionId
  if (wanted === null) {
    const active = await repository.getActiveRuleVersion()
    if (!active) {
      ruleVersionUnavailable(
        409,
        'CALL_AUDIT_RULE_VERSION_NOT_ACTIVE',
        'No rule version is active; activate one or name a version to test',
      )
    }
    wanted = active.ruleVersionId
  } else if (!isSafeRuleVersionId(wanted)) {
    // The same id grammar the settings query uses, so a crafted id cannot reach
    // the repository at all.
    throw new CallAuditRuleTestError('ruleVersionId', 'must be a rule version id')
  }
  const detail = await repository.getRuleVersionDetail(wanted)
  if (!detail) {
    ruleVersionUnavailable(
      404,
      'CALL_AUDIT_RULE_VERSION_NOT_FOUND',
      'Rule version was not found',
    )
  }
  return detail
}

/** The transient test-lab response. Carries the sanitized DTO and nothing else. */
interface CallAuditRuleTestResponseDto {
  generatedAt: string
  boundary: string
  /** Which configuration was exercised. Never a call, lead, or source identity. */
  ruleVersionId: string
  result: CallAuditRuleTestResult
}

/**
 * Runs one transient rule test.
 *
 * The submitted transcript lives in this call only: it is passed to the test lab
 * and to no other collaborator, is never written, logged, hashed, or placed on
 * the response, and no attempt row is created — a test is not an audit of a
 * call. Nothing identifying a caller is accepted in the first place.
 */
async function runRuleTest(
  dependencies: Dependencies,
  model: ContentAuditModelAdapter,
  body: unknown,
): Promise<CallAuditRuleTestResponseDto> {
  try {
    const submission = parseCallAuditRuleTestSubmission(body)
    const version = await resolveRuleTestVersion(
      settingsRepository(dependencies),
      submission.ruleVersionId,
    )
    const result = await runCallAuditRuleTest({
      activation: {
        versionLabel: version.versionLabel,
        businessPrompt: version.businessPrompt,
        modelProvider: version.modelProvider,
        modelName: version.modelName,
        modelVersion: version.modelVersion,
        temperature: version.temperature,
      },
      transcript: submission.transcript,
      context: submission.context,
      model,
    })
    return {
      generatedAt: new Date().toISOString(),
      boundary: CALL_AUDIT_RULE_TEST_BOUNDARY,
      ruleVersionId: version.ruleVersionId,
      result,
    }
  } catch (error) {
    callAuditRuleTestFailure(error)
  }
}

// ---------------------------------------------------------------------------
// Monthly KServe settlement
// ---------------------------------------------------------------------------

/**
 * A settlement always covers ONE complete bill month.
 *
 * "All periods" is refused rather than folded into an aggregate: the amount
 * finally paid is a per-month negotiation, and a savings figure summed across
 * every month ever billed would be a number nobody agreed to.
 */
function settlementMonthScope(value: unknown): BillingMonthScope {
  const scope = parseBillingMonth(parseSettlementMonth(value))
  if (!scope) {
    throw new KserveSettlementInputError('month', 'must be a single bill month')
  }
  return scope
}

function requireSettlementMonth(url: URL): BillingMonthScope {
  return settlementMonthScope(url.searchParams.get('month'))
}

function settlementRepository(
  dependencies: Dependencies,
): KserveSettlementRepository {
  return (
    dependencies.kserveSettlement ??
    createMysqlKserveSettlementRepository(dependencies.pool)
  )
}

function vendorBilledRepository(
  dependencies: Dependencies,
): KserveVendorBilledPort {
  return (
    dependencies.kserveVendorBilled ??
    createMysqlKserveVendorBilledRepository(dependencies.pool)
  )
}

/**
 * THE one settlement read, shared by the admin route, the reports API, and the
 * emailed monthly report.
 *
 * Two bounded reads, issued together: the month's vendor billed charge and the
 * month's newest settlement versions. Both are scoped to the same complete
 * month before either runs, so the page and the report cannot describe
 * different periods, and neither can drift onto a different vendor basis.
 */
async function collectKserveSettlement(
  dependencies: Dependencies,
  month: BillingMonthScope,
  historyLimit: number,
): Promise<KserveSettlementDto> {
  const billMonth = parseSettlementMonth(month.month)
  try {
    const [vendorBilled, history] = await Promise.all([
      vendorBilledRepository(dependencies).readMonthlyBilledCharge({
        periodStart: month.start,
        periodEnd: month.end,
      }),
      settlementRepository(dependencies).readHistory(billMonth, historyLimit),
    ])
    return buildKserveSettlementView({ month, vendorBilled, history })
  } catch (error) {
    // A driver message, a column value, or an unknown thrown value never
    // travels past this point.
    throw asSafeSettlementError(error)
  }
}

/**
 * The settlement summary a monthly report carries.
 *
 * NULL MEANS "NOT SCOPED TO ONE MONTH" AND NOTHING ELSE. The revenue report
 * predates settlements and must still render for every month, including the old
 * periods that will never have one, so a failed read does not propagate — but
 * it is reported as an explicit `unavailable` summary with no money in it, not
 * as null and not as `pending`. A transient failure must never be published as
 * "no settlement exists for this period".
 *
 * Nothing about the failure crosses this boundary: the summary is constructed
 * from the month alone, so no driver message, table name, value or identity can
 * reach the response.
 */
async function collectSettlementSummary(
  dependencies: Dependencies,
  month: BillingMonthScope | null,
): Promise<KserveSettlementSummary | null> {
  if (!month) return null
  try {
    return toSettlementSummary(
      await collectKserveSettlement(dependencies, month, 1),
    )
  } catch {
    return unavailableSettlementSummary(month.month)
  }
}

async function apiResponse(
  url: URL,
  dependencies: Dependencies,
  context: AuthContext,
): Promise<unknown> {
  const pathname = url.pathname
  const period = parseBillingMonth(url.searchParams.get('month'))
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
  if (pathname === '/api/v1/users') {
    const limit = Number(url.searchParams.get('limit') ?? 50)
    const offset = Number(url.searchParams.get('offset') ?? 0)
    const administration = dependencies.userAdministration
    if (!administration) {
      throw Object.assign(new Error('User administration is unavailable'), {
        code: 'USER_ADMIN_UNAVAILABLE',
        status: 503,
      })
    }
    return administration.listUsers({
      actorUserId: context.user.id,
      limit,
      offset,
    })
  }
  if (pathname === '/api/v1/periods') {
    return collectBillingMonths(dependencies.pool)
  }
  if (pathname === '/api/v1/overview') {
    const [metrics, billing] = await Promise.all([
      collectMetrics(dependencies.pool, period),
      collectBilling(dependencies.pool, period),
    ])
    const billingView = buildBillingView(billing, {
      calibrationComplete:
        dependencies.config.releaseGates.calibrationComplete ||
        dependencies.config.releaseGates
          .automatedValidationApproved,
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
    const metrics = await collectMetrics(dependencies.pool, period)
    const dashboard = buildDashboard(metrics)
    return {
      generatedAt: metrics.generatedAt,
      tiles: dashboard.tiles,
      integrityFindings: dashboard.findings,
    }
  }
  if (pathname === '/api/v1/findings') {
    const [metrics, quality] = await Promise.all([
      collectMetrics(dependencies.pool, period),
      collectQuality(dependencies.pool, period),
    ])
    return {
      generatedAt: metrics.generatedAt,
      authority: dependencies.config.releaseGates
        .automatedValidationApproved
        ? 'automated'
        : dependencies.config.releaseGates.calibrationComplete
          ? 'calibrated'
        : 'uncalibrated',
      quality: buildQualityView(quality, metrics.calls),
    }
  }
  if (pathname === '/api/v1/billing') {
    const billing = await collectBilling(dependencies.pool, period)
    const billingView = buildBillingView(billing, {
      calibrationComplete:
        dependencies.config.releaseGates.calibrationComplete ||
        dependencies.config.releaseGates
          .automatedValidationApproved,
    })
    return {
      generatedAt: new Date().toISOString(),
      authority: billingView.cycle.billGenerated
        ? 'authoritative'
        : 'provisional',
      billing: billingView,
    }
  }
  if (pathname === KSERVE_SETTLEMENT_ROUTE) {
    // ADMINISTRATOR-ONLY money. Gated on `billing:approve` below; the response
    // carries amounts, versions and timestamps and nothing that identifies who
    // recorded them or which row holds them.
    return collectKserveSettlement(
      dependencies,
      requireSettlementMonth(url),
      parseHistoryLimit(url.searchParams.get('history')),
    )
  }
  if (pathname === BILLING_CATEGORY_ANALYSIS_ROUTE) {
    // ADMINISTRATOR-ONLY. The response carries per-call task references and
    // drives the restricted admin review action, so it takes the audit
    // inspection gate rather than the aggregate metrics permission, and the
    // read model returns no recording reference, hash, or internal id.
    const repository =
      dependencies.billingCategoryAnalysis ??
      createMysqlBillingCategoryAnalysisRepository(dependencies.pool)
    return buildBillingCategoryAnalysis(
      repository,
      parseBillingCategoryAnalysisQuery(url.searchParams),
      period,
    )
  }
  if (pathname === '/api/v1/reports') {
    const [billing, snapshots, emailDelivery, settlement] =
      await Promise.all([
        collectBilling(dependencies.pool, period),
        collectRevenueSnapshots(dependencies.pool, period),
        period
          ? collectReportEmailDeliveryStatus(
              dependencies.pool,
              period.month,
            )
          : Promise.resolve(null),
        // Monthly only, and null ONLY when the report is not scoped to one bill
        // month. A month with no settlement reports itself as pending rather
        // than as a zero payment with total savings, and a month whose
        // settlement could not be read reports itself as unavailable rather
        // than as either of those.
        collectSettlementSummary(dependencies, period),
      ])
    const billingView = buildBillingView(billing, {
      calibrationComplete:
        dependencies.config.releaseGates.calibrationComplete ||
        dependencies.config.releaseGates
          .automatedValidationApproved,
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
      emailDelivery,
      settlement,
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
      pendingPage: integer('pendingPage', 1, 1, 100_000),
      noRecordingPage: integer(
        'noRecordingPage',
        1,
        1,
        100_000,
      ),
      pageSize: integer('pageSize', 25, 10, 100),
      category: safeFilter('category'),
      language: safeFilter('language'),
      periodStart: period?.start ?? null,
      periodEnd: period?.end ?? null,
    })
  }
  if (pathname === '/api/v1/audit-workers') {
    const control =
      dependencies.auditWorkerControl ??
      createMysqlAuditWorkerControl(dependencies.pool)
    const systems = await control.listPublicStates()
    return {
      generatedAt: new Date().toISOString(),
      dispatchAvailable: Boolean(dependencies.auditWorkerDispatcher),
      systems: systems.map((state) => settleStaleWorker(state)),
    }
  }
  if (pathname === '/api/v1/audit-call') {
    const access = await resolveContentCall(
      url,
      dependencies,
      context,
    )
    return collectAdminCallDetail(dependencies.pool, access)
  }
  if (pathname === CALL_AUDIT_REPORT_ROUTE) {
    // Sanitized aggregate reporting, ADMINISTRATOR-ONLY. The rows stay
    // sanitized — no transcript, identity, hash, prompt, provider prose or
    // money ever reaches this DTO — but even the sanitized per-call view is
    // an audit surface, so the route is gated on `audit:inspect` alongside the
    // rest of the audit module rather than on the aggregate metrics permission
    // an ordinary user holds.
    const repository =
      dependencies.callAuditReporting ??
      createMysqlCallAuditReportingRepository(dependencies.pool)
    return buildCallAuditReport(
      repository,
      parseCallAuditReportQuery(url.searchParams),
    )
  }
  if (pathname === CALL_AUDIT_SETTINGS_ROUTE) {
    // Admin-only rule administration. Metadata by default; the prompt is read
    // only when an explicit detail id is asked for.
    return buildCallAuditSettings(
      settingsRepository(dependencies),
      parseCallAuditSettingsQuery(url.searchParams),
    )
  }
  if (pathname === '/api/v1/imports') {
    if (!dependencies.imports) {
      // A runtime with no durable storage never advertises imports as enabled;
      // it says so with a bounded 503 rather than a generic failure.
      const error = new Error('Imports are not available on this server')
      Object.assign(error, {
        code: 'IMPORT_NOT_AVAILABLE',
        status: 503,
      })
      throw error
    }
    return {
      ...(await dependencies.imports.status()),
      invoiceAiEnabled:
        dependencies.importAnalysis?.invoiceAiEnabled ?? false,
    }
  }
  throw new Error('Unsupported API route')
}

/**
 * Codes a dependency may raise to say "this deployment cannot do that", with the
 * exact title returned for each.
 *
 * A 503 is allowed out of the generic error path only through this table, and
 * the title is read from here rather than from the error. An unavailability
 * reason is a fact about the deployment; an error's own message is not, and a
 * driver or provider error that happens to carry a 503 must never be able to
 * describe itself to a browser.
 */
const BOUNDED_UNAVAILABLE_TITLES: Readonly<Record<string, string>> = {
  IMPORT_NOT_AVAILABLE: 'Imports are not available on this server',
  IMPORT_ANALYSIS_NOT_CONFIGURED:
    'Import analysis is not configured on this server',
  USER_ADMIN_UNAVAILABLE:
    'User administration is not available on this server',
  AUDIT_WORKER_DISPATCH_NOT_CONFIGURED:
    'Audit worker start is not configured on this server',
  AUDIT_WORKER_DISPATCH_FAILED:
    'Audit worker could not be started',
  // One bounded title for every re-audit queue storage failure. The repository
  // has already dropped the driver's own message, so nothing about the cause —
  // a column, a constraint, a call id, a reference — can reach a browser.
  REAUDIT_QUEUE_UNAVAILABLE:
    'Re-audit queue is temporarily unavailable',
  // One bounded title for every settlement storage failure. The repository has
  // already dropped the driver's own message, so nothing about the cause — a
  // column, a constraint, an amount — can reach a browser through this route.
  KSERVE_SETTLEMENT_UNAVAILABLE:
    'Monthly settlement is temporarily unavailable',
}

/**
 * Audit-log action for an import POST. The same name is recorded whether the
 * upload succeeded or was refused, so a reviewer sees the attempt either way.
 */
function importAction(pathname: string): string {
  if (pathname.endsWith('/analyze-usage')) return 'usage_import.analyze'
  if (pathname.endsWith('/analyze-invoice')) return 'invoice_import.analyze'
  return pathname.endsWith('/usage')
    ? 'usage_import.create'
    : 'invoice_import.create'
}

/** Audit-log action for an API read. Distinct per route, never derived loosely. */
function apiAction(pathname: string): string {
  if (pathname === '/api/v1/me') return 'identity.read'
  if (pathname === '/api/v1/users') return 'user_accounts.read'
  if (pathname.startsWith('/api/v1/users/')) {
    return `user_accounts.${pathname.slice('/api/v1/users/'.length)}`
  }
  if (pathname === CALL_AUDIT_REPORT_ROUTE) {
    return 'call_audit_report.read'
  }
  // Named explicitly: the trailing-segment default would record it as the
  // shapeless 'categories.read', and an admin read of per-call references has
  // to be distinguishable in the access log.
  if (pathname === BILLING_CATEGORY_ANALYSIS_ROUTE) {
    return 'billing_category_analysis.read'
  }
  // Reading what was paid and RECORDING what was paid are two different money
  // events, so they never share an action name in the access log. The write
  // action is chosen at the call site; this is the read.
  if (pathname === KSERVE_SETTLEMENT_ROUTE) {
    return 'kserve_settlement.read'
  }
  if (pathname === CALL_AUDIT_SETTINGS_ROUTE) {
    return 'call_audit_settings.read'
  }
  if (pathname === CALL_AUDIT_RULE_ACTIVATE_ROUTE) {
    return 'call_audit_rule_version.activate'
  }
  // Distinct from every settings action: a test runs a model, and an auditor
  // must be able to tell one apart from a configuration read or a save.
  if (pathname === CALL_AUDIT_RULE_TEST_ROUTE) {
    return 'call_audit_rule_test.run'
  }
  if (pathname === AUDIT_WORKER_CONTROL_ROUTE) {
    return 'audit_worker.control'
  }
  // Named explicitly: the trailing-segment default would record queuing paid
  // model work as the shapeless 're-audit.read'.
  if (pathname === MANUAL_REAUDIT_ROUTE) {
    return 'billing_reaudit.request'
  }
  return `${pathname.split('/').at(-1)}.read`
}

function apiPermission(pathname: string): string {
  // Rule administration is configuration, not reporting: admin-only, and never
  // reachable with the aggregate metrics permission a normal user holds.
  if (
    pathname === CALL_AUDIT_SETTINGS_ROUTE ||
    pathname === CALL_AUDIT_RULE_ACTIVATE_ROUTE ||
    pathname === CALL_AUDIT_RULE_TEST_ROUTE
  ) return 'config:manage'
  // Queuing a paid re-audit is worker CONTROL, not audit inspection: reading
  // the monitor must never be enough to spend money on a model.
  if (
    pathname === '/api/v1/audit-workers' ||
    pathname === AUDIT_WORKER_CONTROL_ROUTE ||
    pathname === MANUAL_REAUDIT_ROUTE
  ) return 'audit:control'
  if (pathname === '/api/v1/users') return 'user:manage'
  // Recording and reading the amount finally paid to KServe is a money
  // decision, so it takes the admin-only money gate rather than the aggregate
  // metrics permission an ordinary operational user holds.
  if (pathname === KSERVE_SETTLEMENT_ROUTE) return 'billing:approve'
  // Audit inspection, including the sanitized Call Audit report: administrator
  // only. Call Audit reporting shares the gate with the Billing Audit monitor
  // but stays a separate module with its own route, DTO and page.
  if (
    pathname === '/api/v1/audits' ||
    pathname === '/api/v1/audit-call' ||
    pathname === '/api/v1/audit-audio' ||
    pathname === CALL_AUDIT_REPORT_ROUTE ||
    // Category analysis exposes per-call references and the review action.
    pathname === BILLING_CATEGORY_ANALYSIS_ROUTE
  ) return 'audit:inspect'
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

function timingOperation(pathname: string): string {
  if (API_ROUTES.has(pathname) || PUBLIC_API_ROUTES.has(pathname)) {
    return apiAction(pathname)
  }
  if (
    PUBLIC_POST_ROUTES.has(pathname) ||
    USER_ADMIN_WRITE_ROUTES.has(pathname) ||
    AUDIT_WORKER_WRITE_ROUTES.has(pathname) ||
    MANUAL_REAUDIT_WRITE_ROUTES.has(pathname) ||
    IMPORT_WRITE_ROUTES.has(pathname) ||
    IMPORT_ANALYSIS_ROUTES.has(pathname) ||
    KSERVE_SETTLEMENT_WRITE_ROUTES.has(pathname) ||
    CALL_AUDIT_SETTINGS_WRITE_ROUTES.has(pathname) ||
    CALL_AUDIT_RULE_TEST_ROUTES.has(pathname)
  ) {
    return apiAction(pathname)
  }
  if (APP_ROUTES.has(pathname)) return 'app_document.read'
  if (OIDC_BROWSER_FLOW_ROUTES.has(pathname)) return 'oidc_browser_flow.read'
  if (pathname === '/logout') return 'session.logout'
  if (pathname.startsWith('/assets/')) return 'static_asset.read'
  if (pathname.startsWith('/api/')) return 'unknown_api.request'
  return 'unknown_request'
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
  if (pathname === '/api/v1/users') return 0
  if (
    pathname === '/api/v1/audit-call' ||
    pathname === '/api/v1/audit-audio'
  ) return 0
  // Rule administration must read its own writes: a cached version list would
  // hide the snapshot an administrator just created.
  if (pathname === CALL_AUDIT_SETTINGS_ROUTE) return 0
  if (pathname === '/api/v1/audit-workers') return 0
  // Money reads its own writes. A cached settlement would let one
  // administrator save a correction and another keep seeing the superseded
  // amount as "finally paid" for the rest of the window.
  if (pathname === KSERVE_SETTLEMENT_ROUTE) return 0
  // The month catalog changes only when a new billing period is imported.
  // A one-minute bound removes repeat scans during navigation without allowing
  // an old default month to survive an operator workflow for long.
  if (pathname === '/api/v1/periods') return 60_000
  if (
    pathname === '/api/v1/audits' ||
    pathname === BILLING_CATEGORY_ANALYSIS_ROUTE ||
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
  if (ttl === 0) {
    recordApiCache('bypass')
    return apiResponse(url, dependencies, context)
  }
  const key = `${context.user.roles.slice().sort().join(',')}:${url.pathname}${url.search}`
  const existing = cache.get(key)
  if (existing && existing.expiresAt > Date.now()) {
    recordApiCache('hit')
    return existing.value
  }
  recordApiCache('miss')
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
    const finishTiming = startRequestTiming({
      operation: timingOperation(url.pathname),
      method: request.method ?? 'UNKNOWN',
    })
    response.once('finish', () => finishTiming(response.statusCode))
    response.once('close', () => finishTiming(response.statusCode))
    const isImportPost =
      request.method === 'POST' &&
      (IMPORT_WRITE_ROUTES.has(url.pathname) ||
        IMPORT_ANALYSIS_ROUTES.has(url.pathname))
    const isPublicPost =
      request.method === 'POST' &&
      PUBLIC_POST_ROUTES.has(url.pathname)
    const isSettingsPost =
      request.method === 'POST' &&
      CALL_AUDIT_SETTINGS_WRITE_ROUTES.has(url.pathname)
    const isRuleTestPost =
      request.method === 'POST' &&
      CALL_AUDIT_RULE_TEST_ROUTES.has(url.pathname)
    const isUserAdminPost =
      request.method === 'POST' &&
      USER_ADMIN_WRITE_ROUTES.has(url.pathname)
    const isAuditWorkerPost =
      request.method === 'POST' &&
      AUDIT_WORKER_WRITE_ROUTES.has(url.pathname)
    const isManualReauditPost =
      request.method === 'POST' &&
      MANUAL_REAUDIT_WRITE_ROUTES.has(url.pathname)
    const isSettlementPost =
      request.method === 'POST' &&
      KSERVE_SETTLEMENT_WRITE_ROUTES.has(url.pathname)
    if (
      request.method === 'GET' &&
      (IMPORT_WRITE_ROUTES.has(url.pathname) ||
        IMPORT_ANALYSIS_ROUTES.has(url.pathname) ||
        CALL_AUDIT_RULE_TEST_ROUTES.has(url.pathname) ||
        MANUAL_REAUDIT_WRITE_ROUTES.has(url.pathname) ||
        url.pathname === CALL_AUDIT_RULE_ACTIVATE_ROUTE)
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
      !isPublicPost &&
      !isSettingsPost &&
      !isRuleTestPost &&
      !isUserAdminPost &&
      !isAuditWorkerPost &&
      !isManualReauditPost &&
      !isSettlementPost
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
        const databaseAuth =
          dependencies.config.auth.mode === 'database'
        const [dbResult, identityReady, auditReady, credentialsReady, guardReady] =
          await Promise.all([
            dependencies.pool.query('SELECT 1'),
            preview
              ? Promise.resolve(true)
              : dependencies.access.readiness(),
            preview
              ? Promise.resolve(true)
              : dependencies.audit.readiness(),
            databaseAuth
              ? dependencies.credentials?.readiness() ?? Promise.resolve(false)
              : Promise.resolve(true),
            databaseAuth
              ? dependencies.pool.query(
                  `SELECT COUNT(*) AS n
                   FROM information_schema.COLUMNS
                   WHERE TABLE_SCHEMA = DATABASE()
                     AND TABLE_NAME = 'kaudit_login_guard'
                     AND COLUMN_NAME IN
                       ('guard_scope','guard_digest','failure_count','blocked_until','expires_at')`,
                )
              : Promise.resolve([[{ n: 5 }], []]),
          ])
        const guardCount = Number(
          Array.isArray(guardReady) && Array.isArray(guardReady[0])
            ? (guardReady[0][0] as { n?: unknown } | undefined)?.n
            : 0,
        )
        if (
          !dbResult ||
          !identityReady ||
          !auditReady ||
          !credentialsReady ||
          guardCount !== 5
        ) {
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
      USER_ADMIN_WRITE_ROUTES.has(url.pathname) ||
      AUDIT_WORKER_WRITE_ROUTES.has(url.pathname) ||
      MANUAL_REAUDIT_WRITE_ROUTES.has(url.pathname) ||
      IMPORT_WRITE_ROUTES.has(url.pathname) ||
      IMPORT_ANALYSIS_ROUTES.has(url.pathname) ||
      APP_ROUTES.has(url.pathname) ||
      OIDC_BROWSER_FLOW_ROUTES.has(url.pathname) ||
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

    if (OIDC_BROWSER_FLOW_ROUTES.has(url.pathname)) {
      const flow = oidcBrowserFlowRuntime(dependencies)
      if (!flow) {
        // Deny by default. A deployment that does not run the browser flow does
        // not have these routes at all, and says so exactly as it would for any
        // other unknown path.
        problem(
          response,
          404,
          'NOT_FOUND',
          'Not found',
          correlation,
        )
        return
      }
      if (url.pathname === OIDC_LOGIN_ROUTE) {
        await handleOidcLogin(flow, response, correlation)
        return
      }
      // Owns its own audit write, because the audit has to complete before the
      // response and the identity cookie are committed.
      await handleOidcCallback(
        dependencies,
        flow,
        request,
        response,
        url,
        correlation,
      )
      return
    }

    if (url.pathname === '/logout') {
      const auth = dependencies.config.auth
      const browserFlow = auth.mode === 'oidc' ? auth.browserFlow : null
      const location =
        auth.mode !== 'oidc'
          ? '/login'
          : // A provider end-session endpoint when one is configured; otherwise
            // the application's own sign-in page, which is reachable only
            // because the browser flow owns a login route on this origin. Both
            // are validated destinations — the first as an HTTPS URL at
            // configuration load, the second a fixed same-origin path — and
            // neither can be influenced by the request.
            (auth.logoutUrl ?? (browserFlow ? '/login' : null))
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
      /**
       * Local sign-out happens first and unconditionally.
       *
       * The provider's end-session endpoint is a redirect this server cannot
       * observe: the browser may never arrive, the provider may refuse, the
       * operator may close the tab. If the identity cookie were left for that
       * round trip to clear, a "logged out" browser would keep presenting a
       * valid token to this origin until the token expired on its own.
       */
      const cleared: string[] = []
      if (auth.mode === 'database') {
        cleared.push(clearUserSessionCookie(auth.sessionCookie))
      }
      if (auth.mode === 'local') {
        cleared.push(clearLocalSessionCookie(auth.sessionCookie))
      }
      if (auth.mode === 'oidc' && auth.tokenCookie) {
        cleared.push(clearOidcIdentityCookie(auth.tokenCookie))
      }
      if (browserFlow) {
        cleared.push(clearOidcTransactionCookie())
      }
      response.writeHead(302, {
        ...HTML_SECURITY_HEADERS,
        location,
        'x-correlation-id': correlation,
        ...(cleared.length > 0 ? { 'set-cookie': cleared } : {}),
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
      if (auth.mode !== 'local' && auth.mode !== 'database') {
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
          login?: unknown
          email?: unknown
          password?: unknown
        }
        const password =
          typeof input.password === 'string'
            ? input.password
            : ''
        let token: string
        let cookie: string
        if (auth.mode === 'database') {
          const login =
            typeof input.login === 'string'
              ? input.login
              : typeof input.email === 'string'
                ? input.email
                : ''
          const source = clientAddress(request, dependencies.config.trustProxy)
          if (!dependencies.loginService || !source) {
            throw new Error('Database login is unavailable')
          }
          const result = await dependencies.loginService.authenticate({
            login,
            password,
            clientSource: source,
          })
          if (!result.ok) {
            throw new AuthFailure(
              401,
              'AUTH_INVALID',
              'Username/email or password is incorrect',
            )
          }
          token = issueUserSession(
            {
              userId: result.authorization.userId,
              sessionVersion: result.authorization.sessionVersion,
            },
            auth.sessionSecret,
            auth.sessionTtlSeconds,
          )
          cookie = userSessionCookie(
            auth.sessionCookie,
            token,
            auth.sessionTtlSeconds,
          )
        } else {
          const email =
            typeof input.email === 'string'
              ? input.email.trim().toLowerCase()
              : typeof input.login === 'string'
                ? input.login.trim().toLowerCase()
                : ''
          const passwordValid = verifyLocalPassword(password, auth.passwordHash)
          if (email !== auth.email || !passwordValid) {
            throw new AuthFailure(
              401,
              'AUTH_INVALID',
              'Email or password is incorrect',
            )
          }
          context = await authenticateLocal(email, dependencies.access)
          token = issueLocalSession(
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
          cookie = localSessionCookie(
            auth.sessionCookie,
            token,
            auth.sessionTtlSeconds,
          )
        }
        sendJson(
          response,
          correlation,
          {
            authenticated: true,
          },
          {
            'set-cookie': cookie,
          },
        )
      } catch (error) {
        const authFailure = error instanceof AuthFailure
        if (auth.mode === 'local') {
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
        if (auth.mode === 'database') {
          problem(
            response,
            503,
            'AUTH_UNAVAILABLE',
            'Sign-in is temporarily unavailable',
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
      if (isAuditWorkerPost) {
        requirePermission(context, 'audit:control')
        const body = await readJsonBody(
          request,
          MAX_AUDIT_WORKER_BODY_BYTES,
          'INVALID_AUDIT_WORKER_CONTROL',
        )
        const input =
          body && typeof body === 'object' && !Array.isArray(body)
            ? body as Record<string, unknown>
            : {}
        let system
        let desiredState
        try {
          system = parseAuditSystem(input.system)
          desiredState = parseDesiredState(input.desiredState)
        } catch {
          throw Object.assign(new Error('Audit worker control is invalid'), {
            code: 'INVALID_AUDIT_WORKER_CONTROL',
            status: 400,
          })
        }
        const control =
          dependencies.auditWorkerControl ??
          createMysqlAuditWorkerControl(dependencies.pool)
        if (
          desiredState === 'running' &&
          !dependencies.auditWorkerDispatcher
        ) {
          throw Object.assign(
            new Error('Audit worker start is not configured'),
            {
              code: 'AUDIT_WORKER_DISPATCH_NOT_CONFIGURED',
              status: 503,
            },
          )
        }
        const storedPreviousState =
          (await control.listPublicStates()).find(
            (item) => item.system === system,
          ) ?? null
        const previousState = storedPreviousState
          ? settleStaleWorker(storedPreviousState)
          : null
        const shouldDispatch =
          desiredState === 'running' &&
          previousState?.observedState !== 'running' &&
          previousState?.observedState !== 'pausing'
        const state = await control.setDesiredState({
          system,
          desiredState,
        })
        if (shouldDispatch) {
          try {
            await dependencies.auditWorkerDispatcher?.dispatch(system)
          } catch {
            await control.recordObservation({
              system,
              observedState: 'faulted',
              errorCode: 'AUDIT_WORKER_DISPATCH_FAILED',
              failedDelta: 1,
            })
            throw new AuditWorkerDispatchError()
          }
        }
        await auditAccess(
          dependencies,
          request,
          context,
          correlation,
          'success',
          desiredState === 'paused'
            ? 'audit_worker.pause'
            : 'audit_worker.resume',
          'audit_worker',
          system,
          'audit_operations',
        )
        apiCache.clear()
        sendJson(response, correlation, state)
        return
      }
      if (isManualReauditPost) {
        /**
         * Administrator-selected Billing Audit re-audit.
         *
         * Order matters and is structural:
         *
         *   1. `audit:control` BEFORE a byte of the body is read. An operator
         *      who may inspect the monitor must never be able to spend on a
         *      model by posting to it.
         *   2. The dispatcher is checked BEFORE anything is queued, so a
         *      deployment that cannot start a worker refuses the request
         *      instead of parking paid work nothing will drain.
         *   3. The body is bounded, then validated exactly.
         *   4. Provenance — the actor and the correlation id — comes from the
         *      authenticated session, never from the body, and neither is
         *      echoed back.
         */
        requirePermission(context, 'audit:control')
        if (
          !dependencies.auditWorkerDispatcher ||
          dependencies.auditWorkerDispatcher.canDispatch?.(
            'billing',
            'requested',
          ) === false
        ) {
          throw Object.assign(
            new Error('Audit worker start is not configured'),
            { code: 'AUDIT_WORKER_DISPATCH_NOT_CONFIGURED', status: 503 },
          )
        }
        const submitted = parseManualReauditRequest(
          await readJsonBody(
            request,
            MAX_MANUAL_REAUDIT_BODY_BYTES,
            'INVALID_REAUDIT_REQUEST',
          ),
        )
        const receipt = await (
          dependencies.manualReauditRequests ??
          createMysqlManualReauditRequestRepository(dependencies.pool)
        ).enqueue({
          callReferences: submitted.callReferences,
          idempotencyKey: submitted.idempotencyKey,
          requestedByUserId: context.user.id,
          correlationId: correlation,
          requestedAt: new Date(),
        })
        if (
          receipt.outcome === 'accepted' ||
          (receipt.outcome === 'replayed' && receipt.status === 'queued')
        ) {
          // A queued replay recovers an earlier dispatch failure. Running or
          // completed replays are already covered and do not start another
          // serialized host job.
          try {
            await dependencies.auditWorkerDispatcher.dispatch(
              'billing',
              'requested',
            )
          } catch {
            throw new AuditWorkerDispatchError()
          }
        }
        await auditAccess(
          dependencies,
          request,
          context,
          correlation,
          'success',
          receipt.outcome === 'accepted'
            ? 'billing_reaudit.request'
            : 'billing_reaudit.replay',
          'billing_reaudit_request',
          // The request's own handle, or nothing. Never a call, artifact, or
          // audit-run id, and never a displayed reference.
          receipt.requestId,
          'audit_operations',
        )
        apiCache.clear()
        sendJson(response, correlation, receipt)
        return
      }
      if (isSettlementPost) {
        // The same admin-only money gate as the read, applied before a byte of
        // the body is read.
        requirePermission(context, 'billing:approve')
        const body = await readJsonBody(
          request,
          MAX_KSERVE_SETTLEMENT_BODY_BYTES,
          'INVALID_KSERVE_SETTLEMENT',
        )
        const input =
          body && typeof body === 'object' && !Array.isArray(body)
            ? body as Record<string, unknown>
            : {}
        // Validated before the write so a malformed month cannot reach a
        // statement, and reused afterwards so the response describes exactly
        // the month that was saved.
        const settlementMonth = settlementMonthScope(input.month)
        const saved = await settlementRepository(
          dependencies,
        ).recordSettlement({
          month: settlementMonth.month,
          finalPaidAmountInr: input.finalPaidAmountInr,
          idempotencyKey: input.idempotencyKey,
          // Provenance the caller cannot choose. The actor is the authenticated
          // administrator, never a value from the body, and neither the actor
          // nor the correlation id is echoed in the response below.
          recordedByUserId: context.user.id,
          correlationId: correlation,
        })
        // A distinct write action: reading what was paid and recording what was
        // paid must be separable in the access log.
        await auditAccess(
          dependencies,
          request,
          context,
          correlation,
          'success',
          saved.outcome === 'replayed'
            ? 'kserve_settlement.replay'
            : 'kserve_settlement.record',
          'kserve_monthly_settlement',
          // The bill month, which is the resource. Never the row id, the retry
          // key, the digest, or the amount.
          settlementMonth.month,
          'billing_settlement',
        )
        apiCache.clear()
        // The saved state is re-read and returned in the SAME shape the GET
        // returns, so a browser never has to assemble a settlement of its own
        // or compute savings from a write response.
        sendJson(response, correlation, {
          ...(await collectKserveSettlement(
            dependencies,
            settlementMonth,
            DEFAULT_SETTLEMENT_HISTORY,
          )),
          outcome: saved.outcome,
        })
        return
      }
      if (isUserAdminPost) {
        requirePermission(context, 'user:manage')
        const administration = dependencies.userAdministration
        if (!administration) {
          throw Object.assign(new Error('User administration is unavailable'), {
            code: 'USER_ADMIN_UNAVAILABLE',
            status: 503,
          })
        }
        const body = await readJsonBody(
          request,
          MAX_USER_ADMIN_BODY_BYTES,
          'INVALID_USER_ADMIN_REQUEST',
        )
        const input =
          body && typeof body === 'object' && !Array.isArray(body)
            ? body as Record<string, unknown>
            : {}
        const actorUserId = context.user.id
        const result =
          url.pathname === '/api/v1/users/create'
            ? await administration.createUser({
                actorUserId,
                username: input.username as string,
                email: input.email as string,
                password: input.password as string,
                role: input.role as AssignableRole,
              })
            : url.pathname === '/api/v1/users/update'
              ? await administration.updateUser({
                  actorUserId,
                  targetUserId: input.userId as string,
                  username: input.username as string,
                  email: input.email as string,
                  role: input.role as AssignableRole,
                })
              : url.pathname === '/api/v1/users/activation'
                ? await administration.setUserActivation({
                    actorUserId,
                    targetUserId: input.userId as string,
                    active: input.active as boolean,
                  })
                : url.pathname === '/api/v1/users/password'
                  ? await administration.resetUserPassword({
                      actorUserId,
                      targetUserId: input.userId as string,
                      password: input.password as string,
                    })
                  : await administration.tombstoneUser({
                      actorUserId,
                      targetUserId: input.userId as string,
                    })
        apiCache.clear()
        sendJson(response, correlation, result)
        return
      }
      if (isSettingsPost) {
        requirePermission(context, 'config:manage')
        const input = await readJsonBody(request, MAX_SETTINGS_BODY_BYTES)
        const created =
          url.pathname === CALL_AUDIT_RULE_ACTIVATE_ROUTE
            ? await activateCallAuditRuleVersion(
                dependencies,
                input,
                context.user.id,
              )
            : await createCallAuditRuleVersion(
                dependencies,
                input,
                context.user.id,
              )
        await auditAccess(
          dependencies,
          request,
          context,
          correlation,
          'success',
          url.pathname === CALL_AUDIT_RULE_ACTIVATE_ROUTE ||
            ('activated' in created && created.activated)
            ? 'call_audit_rule_version.activate'
            : 'call_audit_rule_version.create',
          'call_audit_rule_version',
          created.ruleVersionId,
          'call_audit_configuration',
        )
        apiCache.clear()
        sendJson(response, correlation, created)
        return
      }
      if (isRuleTestPost) {
        requirePermission(context, 'config:manage')
        const model = dependencies.callAuditRuleTestModel
        if (!model) {
          // Checked before the body is read and before any prompt is fetched:
          // with no port there is nothing to test, and no transcript should be
          // accepted only to be discarded.
          await auditAccess(
            dependencies,
            request,
            context,
            correlation,
            'failure',
            'call_audit_rule_test.run',
            'call_audit_rule_version',
            null,
            'call_audit_configuration',
          )
          problem(
            response,
            503,
            'CALL_AUDIT_RULE_TEST_UNAVAILABLE',
            'Rule testing is not configured on this server',
            correlation,
          )
          return
        }
        const tested = await runRuleTest(
          dependencies,
          model,
          await readJsonBody(
            request,
            MAX_RULE_TEST_BODY_BYTES,
            'INVALID_CALL_AUDIT_RULE_TEST_REQUEST',
          ),
        )
        await auditAccess(
          dependencies,
          request,
          context,
          correlation,
          'success',
          'call_audit_rule_test.run',
          'call_audit_rule_version',
          tested.ruleVersionId,
          'call_audit_configuration',
        )
        // Nothing was written, so no cached read can have gone stale.
        sendJson(response, correlation, tested)
        return
      }
      if (isImportPost) {
        requirePermission(context, 'import:write')
        const isAnalysis = IMPORT_ANALYSIS_ROUTES.has(url.pathname)
        /**
         * Availability is decided before a single body byte is read.
         *
         * A runtime without durable storage (a serverless function) has no
         * cycle import service at all. Reading the upload first would pull up
         * to 25 MB of an operator's usage CSV or invoice PDF into memory only
         * to discard it — bytes this deployment cannot store and has no reason
         * to hold. The refusal is bounded and says nothing about the upload.
         */
        if (
          isAnalysis ? !dependencies.importAnalysis : !dependencies.imports
        ) {
          await auditAccess(
            dependencies,
            request,
            context,
            correlation,
            'failure',
            importAction(url.pathname),
          )
          problem(
            response,
            503,
            isAnalysis
              ? 'IMPORT_ANALYSIS_NOT_CONFIGURED'
              : 'IMPORT_NOT_AVAILABLE',
            isAnalysis
              ? 'Import analysis is not configured on this server'
              : 'Imports are not available on this server',
            correlation,
          )
          return
        }
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
          importAction(url.pathname),
        )
        apiCache.clear()
        sendJson(response, correlation, body)
        return
      }
      if (url.pathname === '/api/v1/audit-audio') {
        requirePermission(context, 'audit:inspect')
        const access = await resolveContentCall(
          url,
          dependencies,
          context,
        )
        if (
          !access.sourceUrl ||
          !access.evidenceSha256 ||
          !dependencies.recordingFetcher
        ) {
          const error = new Error(
            'Verified recording is not available',
          )
          Object.assign(error, {
            code: 'RECORDING_NOT_AVAILABLE',
            status: 404,
          })
          throw error
        }
        const safety = isSafeVendorUrl(
          access.sourceUrl,
          dependencies.allowedRecordingHosts || [],
        )
        if (!safety.safe) {
          const error = new Error(
            'Recording reference is not permitted',
          )
          Object.assign(error, {
            code: 'UNSAFE_RECORDING_REFERENCE',
            status: 409,
          })
          throw error
        }
        const fetched = await dependencies.recordingFetcher.fetch(
          access.sourceUrl,
        )
        if (!fetched.ok) {
          const error = new Error(
            'Recording could not be retrieved from KServe',
          )
          Object.assign(error, {
            code: 'RECORDING_FETCH_FAILED',
            status: 502,
          })
          throw error
        }
        if (sha256Hex(fetched.bytes) !== access.evidenceSha256) {
          const error = new Error(
            'Recording no longer matches its evidence hash',
          )
          Object.assign(error, {
            code: 'EVIDENCE_ALTERED',
            status: 409,
          })
          throw error
        }
        await auditAccess(
          dependencies,
          request,
          context,
          correlation,
          'success',
          'call_audio.read',
          'call',
          access.callId,
          'admin_call_review',
        )
        response.writeHead(200, {
          ...JSON_SECURITY_HEADERS,
          'content-type':
            fetched.contentType || 'audio/ogg',
          'content-length': String(fetched.bytes.byteLength),
          'cache-control': 'private, no-store, max-age=0',
          'content-disposition': 'inline',
          'x-content-type-options': 'nosniff',
          'x-correlation-id': correlation,
        })
        response.end(fetched.bytes)
        return
      }
      if (url.pathname === '/api/v1/audit-call') {
        requirePermission(context, 'audit:inspect')
        const access = await resolveContentCall(
          url,
          dependencies,
          context,
        )
        const body = await collectAdminCallDetail(
          dependencies.pool,
          access,
        )
        await auditAccess(
          dependencies,
          request,
          context,
          correlation,
          'success',
          'call_content.read',
          'call',
          access.callId,
          'admin_call_review',
        )
        sendJson(response, correlation, body)
        return
      }
      if (API_ROUTES.has(url.pathname)) {
        requirePermission(context, apiPermission(url.pathname))
        const action = apiAction(url.pathname)
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
        // CALL_AUDIT_PAGE_ROUTE is matched exactly, so the settings child route
        // below still takes its own, stricter gate.
        url.pathname === '/audits' ||
          url.pathname === '/audits/call' ||
          url.pathname === CALL_AUDIT_PAGE_ROUTE ||
          // The category page renders per-call references and links into the
          // restricted review route, so the page takes the API's own gate.
          url.pathname === BILLING_CATEGORY_ANALYSIS_PAGE_ROUTE
          ? 'audit:inspect'
          : url.pathname === '/users'
            ? 'user:manage'
          : url.pathname === '/imports/new'
            ? 'import:write'
            : url.pathname === CALL_AUDIT_SETTINGS_PAGE_ROUTE
              ? 'config:manage'
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
          url.pathname.startsWith('/api/')
            ? isSettingsPost
              ? url.pathname === CALL_AUDIT_RULE_ACTIVATE_ROUTE
                ? 'call_audit_rule_version.activate'
                : 'call_audit_rule_version.create'
              // A refused SAVE is logged as a refused save, never as a read:
              // the two are different money events even when both fail.
              : isSettlementPost
                ? 'kserve_settlement.record'
                : apiAction(url.pathname)
            : 'app.read',
        )
      } catch {
        // Privacy-safe structured logging below is the fallback when the
        // protected database audit sink is unavailable.
      }
      const userAdminFailure = error instanceof UserAdminError
      /**
       * A settlement failure logs its own bounded code rather than a generic
       * INTERNAL_ERROR. All three carry a field name at most: the input and
       * conflict errors never quote an amount, a month, or a retry key, and the
       * unavailable error carries nothing about the cause at all.
       */
      const settlementFailure =
        error instanceof KserveSettlementInputError ||
        error instanceof KserveSettlementConflictError ||
        error instanceof KserveSettlementUnavailableError
      /**
       * A refused re-audit logs its own bounded code. Every one of them names a
       * rule, never a value: no submitted reference, retry key, internal id, or
       * driver message exists on the error to leak.
       */
      const reauditFailure = error instanceof ManualReauditError
      const safeLog = {
        level: authFailure ? 'warn' : 'error',
        event: authFailure
          ? 'access_denied'
          : 'dashboard_request_failed',
        code: authFailure
          ? error.code
          : userAdminFailure || settlementFailure || reauditFailure
            ? error.code
            : 'INTERNAL_ERROR',
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
      } else if (userAdminFailure) {
        const status = error.kind === 'input'
          ? 400
          : error.kind === 'refusal'
            ? 409
            : 503
        problem(
          response,
          status,
          error.code,
          error.kind === 'input'
            ? 'User details are invalid'
            : error.kind === 'refusal'
              ? 'User account change was refused'
              : 'User administration is temporarily unavailable',
          correlation,
        )
      } else {
        const shaped = error as {
          status?: number
          code?: string
          message?: string
        }
        const unavailableTitle =
          typeof shaped.code === 'string'
            ? BOUNDED_UNAVAILABLE_TITLES[shaped.code]
            : undefined
        if (shaped.status === 503 && unavailableTitle) {
          problem(
            response,
            503,
            shaped.code as string,
            unavailableTitle,
            correlation,
          )
          return
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
