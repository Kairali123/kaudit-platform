import path from 'node:path'
import type http from 'node:http'
import mysql, { type Pool, type PoolOptions } from 'mysql2/promise'
import { createMysqlAccessRepository } from '../adapters/mysqlAccessRepo.ts'
import { createMysqlAuditSink } from '../adapters/mysqlAuditSink.ts'
import { createMysqlUserCredentialRepository } from '../adapters/mysqlUserCredentialRepo.ts'
import { createMysqlLoginService } from '../adapters/mysqlLoginService.ts'
import { createMysqlUserAdministration } from '../adapters/mysqlUserAdministration.ts'
import { createOidcVerifier } from '../auth/oidcVerifier.ts'
import { createOidcAuthorizationClient } from '../auth/oidcAuthorizationClient.ts'
import { loadRuntimeConfig, type RuntimeConfig } from '../config/runtime.ts'
import { createEnterpriseDashboardServer } from '../http/enterpriseDashboardServer.ts'
import { createMysqlCycleImportService } from '../adapters/mysqlCycleImport.ts'
import { createLocalImportObjectStore } from '../adapters/localImportObjectStore.ts'
import { createGoogleDriveImportObjectStore } from '../adapters/googleDriveImportObjectStore.ts'
import { createImportAnalysisService } from '../imports/analysis.ts'
import { createProxyResolvingFetcher } from '../adapters/proxyResolvingFetcher.ts'
import { createOpenAiCallAuditModel } from '../adapters/openaiCallAuditClient.ts'
import { resolveDatabaseTls, type CaFileReader } from './databaseTls.ts'
import { createGitHubActionsAuditWorkerDispatcher } from '../auditWorkers/dispatcher.ts'

/**
 * How the runtime holds MySQL connections.
 *
 * `persistent` is a long-lived process that owns its port: one pool for the life
 * of the process, keep-alive on.
 *
 * `serverless` is a Vercel Function instance. Many instances can be warm at once
 * and each one holds its own pool, so the per-instance ceiling has to be small
 * or the database's connection limit is reached by concurrency alone. Idle
 * connections are also released quickly, because a warm instance can sit unused
 * for minutes between requests while still holding whatever it opened.
 */
export type DashboardPoolProfile = 'persistent' | 'serverless'

/**
 * Whether the monthly cycle import service is constructed.
 *
 * `local-disk` content-addresses uploaded bytes under `KAUDIT_IMPORT_ROOT` on
 * the local filesystem.
 *
 * `google-drive` content-addresses uploaded bytes inside the configured Kaudit
 * Google Shared Drive boundary.
 *
 * `unavailable` is for a runtime with no durable filesystem. It is not a
 * degraded mode — the dependency is simply absent, which is what makes the
 * import endpoints report themselves unavailable before they read a body.
 */
export type CycleImportMode = 'local-disk' | 'google-drive' | 'unavailable'

export interface DashboardRuntimeOptions {
  poolProfile: DashboardPoolProfile
  cycleImports: CycleImportMode
  /** Defaults to `process.env`; injected by tests. */
  env?: NodeJS.ProcessEnv
  /** Injected by tests so no socket is opened. */
  createPool?: (options: PoolOptions) => Pool
  /** Injected by tests so no CA file has to exist on disk. */
  readCaFile?: CaFileReader
  /** Overrides the built web root; defaults to the server's own resolution. */
  webDistRoot?: string
}

/**
 * What the runtime actually wired up. Booleans only — no dependency, credential,
 * or path is exposed — so a caller (or a test) can state the deployment's shape
 * without reaching into the server.
 */
export interface DashboardCapabilities {
  cycleImports: boolean
  importAnalysis: boolean
  callAuditRuleTest: boolean
  recordingProxy: boolean
  /** Whether this deployment runs the OIDC authorization-code browser flow. */
  oidcBrowserFlow: boolean
}

export interface DashboardRuntime {
  config: RuntimeConfig
  pool: Pool
  server: http.Server
  capabilities: DashboardCapabilities
}

function hostList(env: NodeJS.ProcessEnv): string[] {
  return (env.KAUDIT_ALLOWED_RECORDING_HOSTS || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
}

function poolLimits(profile: DashboardPoolProfile): PoolOptions {
  return profile === 'serverless'
    ? {
        // Every warm instance multiplies this. Two is enough for one request
        // that fans out a couple of reads and no more.
        connectionLimit: 2,
        // Bounded queue: a burst waits briefly and is then refused, instead of
        // accumulating callers behind a pool that cannot grow.
        queueLimit: 24,
        maxIdle: 1,
        idleTimeout: 30_000,
        // A frozen instance cannot answer keep-alive probes, so the server sees
        // a half-open connection instead of a closed one.
        enableKeepAlive: false,
      }
    : {
        connectionLimit: 8,
        enableKeepAlive: true,
      }
}

/**
 * The one place the authenticated dashboard's dependencies are constructed.
 *
 * Both entry points — the persistent CLI and the Vercel Function — call this and
 * differ only by the two options above. Duplicating this wiring is how a
 * deployment quietly ends up with a different security posture than the one that
 * was reviewed, so the security decisions below live here and nowhere else.
 */
export function createDashboardRuntime(
  options: DashboardRuntimeOptions,
): DashboardRuntime {
  const env = options.env ?? process.env
  const config = loadRuntimeConfig(env)
  const ssl = resolveDatabaseTls(config, env, options.readCaFile)
  const createPool = options.createPool ?? mysql.createPool
  const pool = createPool({
    host: config.database.host,
    port: config.database.port,
    database: config.database.name,
    user: config.database.user,
    password: config.database.password,
    // Present only when there is a handshake to configure. mysql2 decides
    // whether to negotiate TLS from whether this key carries options, so a
    // plaintext runtime hands the driver no `ssl` key at all rather than one
    // holding `undefined` — the pool options then say what the connection is.
    ...(ssl ? { ssl } : {}),
    connectTimeout: 10_000,
    decimalNumbers: false,
    ...poolLimits(options.poolProfile),
  })
  const access = createMysqlAccessRepository(pool)
  const audit = createMysqlAuditSink(pool)
  const credentials =
    config.auth.mode === 'database'
      ? createMysqlUserCredentialRepository(pool)
      : undefined
  const loginService =
    config.auth.mode === 'database' && credentials
      ? createMysqlLoginService(pool, credentials, {
          sessionSecret: config.auth.sessionSecret,
        })
      : undefined
  const userAdministration =
    config.auth.mode === 'database'
      ? createMysqlUserAdministration(pool)
      : undefined
  const allowedRecordingHosts = hostList(env)
  const importObjectStore =
    options.cycleImports === 'local-disk'
      ? createLocalImportObjectStore(
          path.resolve(env.KAUDIT_IMPORT_ROOT?.trim() || '.data/imports'),
        )
      : options.cycleImports === 'google-drive'
        ? createGoogleDriveImportObjectStore({
            clientId: env.KAUDIT_GOOGLE_DRIVE_CLIENT_ID?.trim() || '',
            clientSecret: env.KAUDIT_GOOGLE_DRIVE_CLIENT_SECRET?.trim() || '',
            refreshToken: env.KAUDIT_GOOGLE_DRIVE_REFRESH_TOKEN?.trim() || '',
            sharedDriveId:
              env.KAUDIT_GOOGLE_DRIVE_SHARED_DRIVE_ID?.trim() || '',
            rootFolderId:
              env.KAUDIT_GOOGLE_DRIVE_ROOT_FOLDER_ID?.trim() || null,
          })
        : undefined
  const imports =
    importObjectStore
      ? createMysqlCycleImportService(pool, {
          objectStore: importObjectStore,
          sourceConnectionId:
            env.KAUDIT_KSERVE_SOURCE_CONNECTION_ID?.trim() || null,
          allowedRecordingHosts,
        })
      : undefined
  // Analysis previews the bytes of an upload that only the import service can
  // accept. With no import service there is nothing to preview, so the analysis
  // endpoints report themselves unavailable too rather than spending a paid
  // model on a file that cannot be stored.
  const importAnalysis =
    imports
      ? createImportAnalysisService(env.OPENAI_API_KEY?.trim() || null)
      : undefined
  const recordingFetcher = env.KAUDIT_UNPOD_PROXY_BASE?.trim()
    ? createProxyResolvingFetcher(env.KAUDIT_UNPOD_PROXY_BASE.trim())
    : undefined
  /**
   * Admin rule TEST LAB wiring, and the only place it is decided.
   *
   * Two independent conditions, both required. A key alone must NOT arm this: the
   * same OPENAI_API_KEY is already present for unrelated import analysis, so
   * treating its presence as consent would silently turn a paid content model on
   * for every deployment that has one. The dedicated flag is the consent, and it
   * is deny-by-default — anything but the exact word `true` leaves the dependency
   * undefined and the endpoint keeps reporting itself unavailable before it reads
   * a body or fetches a prompt.
   */
  const callAuditRuleTestEnabled =
    env.KAUDIT_CALL_AUDIT_RULE_TEST_ENABLED?.trim().toLowerCase() === 'true'
  const callAuditRuleTestApiKey = env.OPENAI_API_KEY?.trim() || ''
  const callAuditRuleTestModel =
    callAuditRuleTestEnabled && callAuditRuleTestApiKey
      ? createOpenAiCallAuditModel(callAuditRuleTestApiKey)
      : undefined
  const auditWorkerDispatcher =
    createGitHubActionsAuditWorkerDispatcher(env)
  const verifier =
    config.auth.mode === 'oidc'
      ? createOidcVerifier({
          issuer: config.auth.issuer,
          audience: config.auth.audience,
          jwksUri: config.auth.jwksUri,
          algorithms: config.auth.algorithms,
          maxTokenAgeSeconds: config.auth.maxTokenAgeSeconds,
        })
      : null
  /**
   * OIDC authorization-code browser flow, and the only place it is decided.
   *
   * `config.auth.browserFlow` is the operator's dedicated deny-by-default gate,
   * already validated as all-or-nothing, so nothing is inferred here from a
   * stray variable. With no gate the client is never constructed and the
   * deployment keeps its existing token-only/identity-proxy behaviour.
   *
   * The client secret is read from the environment on this line and handed
   * straight to the client. It is not placed in `config`, not returned in the
   * runtime, not stored in a local that outlives this call, and not logged —
   * the same treatment `resolveDatabaseTls` gives the inline CA PEM.
   */
  const oidcAuthorizationClient =
    config.auth.mode === 'oidc' && config.auth.browserFlow
      ? createOidcAuthorizationClient({
          issuer: config.auth.issuer,
          clientId: config.auth.browserFlow.clientId,
          clientSecret: env.KAUDIT_OIDC_CLIENT_SECRET?.trim() || '',
          redirectUri: config.auth.browserFlow.redirectUri,
        })
      : undefined
  const server = createEnterpriseDashboardServer({
    config,
    pool,
    access,
    audit,
    imports,
    importAnalysis,
    recordingFetcher,
    allowedRecordingHosts,
    callAuditRuleTestModel,
    auditWorkerDispatcher,
    verifier,
    credentials,
    loginService,
    userAdministration,
    oidcAuthorizationClient,
    webDistRoot: options.webDistRoot,
  })
  return {
    config,
    pool,
    server,
    capabilities: {
      cycleImports: Boolean(imports),
      importAnalysis: Boolean(importAnalysis),
      callAuditRuleTest: Boolean(callAuditRuleTestModel),
      recordingProxy: Boolean(recordingFetcher),
      oidcBrowserFlow: Boolean(oidcAuthorizationClient),
    },
  }
}
