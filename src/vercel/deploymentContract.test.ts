import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

/**
 * Static deployment contract for the Vercel web/API candidate.
 *
 * Static because none of it can be exercised locally: `vercel.json` is
 * interpreted by the platform's router, and the function entry point is chosen
 * by the platform's build. What the repository can still guarantee is the shape
 * of both — in particular that no path reaches the built web files without
 * passing the authenticated server first, and that a web deployment starts no
 * batch or scheduled work.
 *
 * Reads files only. No deployment, no project link, no credentials.
 */

const root = new URL('../../', import.meta.url)

function read(relative: string): string {
  return readFileSync(new URL(relative, root), 'utf8')
}

const VERCEL_JSON_TEXT = read('vercel.json')
const VERCEL = JSON.parse(VERCEL_JSON_TEXT) as {
  routes?: Array<{ src: string; dest?: string; status?: number }>
  functions?: Record<string, { maxDuration?: number; includeFiles?: string }>
  buildCommand?: string
  outputDirectory?: string
  crons?: unknown
  rewrites?: unknown
  redirects?: unknown
}
const API_ENTRY = read('api/index.ts')
const CSV_ENTRY = read('api/monthly-report-csv.ts')
const RECONCILIATION_ENTRY = read('api/reconciliation-batch.ts')
const FUNCTION_SOURCE = read('src/vercel/dashboardFunction.ts')
const ADAPTER_SOURCE = read('src/vercel/serverlessAdapter.ts')
const PACKAGE = JSON.parse(read('package.json')) as {
  engines?: { node?: string }
  scripts?: Record<string, string>
}
const GITIGNORE = read('.gitignore')

/** Comments explain a rule; only executable text can enforce it. */
function code(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
}

const API_ENTRY_CODE = code(API_ENTRY)
const CSV_ENTRY_CODE = code(CSV_ENTRY)
const RECONCILIATION_ENTRY_CODE = code(RECONCILIATION_ENTRY)
const FUNCTION_CODE = code(FUNCTION_SOURCE)

function routes(): Array<{ src: string; dest?: string }> {
  assert.ok(Array.isArray(VERCEL.routes), 'vercel.json must declare routes')
  return VERCEL.routes as Array<{ src: string; dest?: string }>
}

// ---------------------------------------------------------------------------
// Route ordering: everything that is not a hashed asset is authenticated
// ---------------------------------------------------------------------------

test('the last route is a catch-all into the authenticated function', () => {
  const last = routes().at(-1)
  assert.equal(last?.src, '/(.*)')
  assert.equal(last?.dest, '/api')
})

test('only Vite hashed assets are served without the function', () => {
  for (const route of routes().slice(0, -1)) {
    const isAsset = /^\/assets\//.test(route.src)
    const isCsvExport =
      (route.src === '/api/v1/reports/monthly.csv' &&
        route.dest === '/api/monthly-report-csv') ||
      (route.src === '/api/v1/reports/monthly.pdf' &&
        route.dest === '/api/monthly-report-pdf')
    const isReconciliationBatch =
      route.src === '/api/v1/reconciliation/batch' &&
      route.dest === '/api/reconciliation-batch'
    // Same authenticated server handler, in the long-running function.
    const isAuditMonitorRefresh =
      route.src === '/api/v1/audits/refresh' &&
      route.dest === '/api/audit-monitor-refresh'
    // Same handler; the month reads get room to refill their cache.
    const isMonthPage =
      (route.src === '/api/v1/reports' && route.dest === '/api/reports-page') ||
      (route.src === '/api/v1/billing' && route.dest === '/api/billing-page')
    assert.ok(
      isAsset || isCsvExport || isReconciliationBatch || isAuditMonitorRefresh ||
        isMonthPage,
      'every route must reach a reviewed edge',
    )
  }
})

test('no route serves the SPA shell directly', () => {
  // `/`, `/overview`, `/billing`, `/audits/call` and every other deep link must
  // reach `index.html` only through the server, which authenticates the caller,
  // checks the page permission, and writes an access-audit row first. A static
  // `index.html` route would hand the shell to anyone.
  for (const route of routes()) {
    assert.equal(
      /index\.html/.test(route.dest ?? ''),
      false,
      'index.html must not be reachable as a static destination',
    )
  }
  const deepLinks = [
    '/',
    '/login',
    '/overview',
    '/billing',
    '/reports',
    '/audits/call',
    '/call-audit/settings',
    '/imports/new',
    '/api/v1/me',
    '/health/ready',
  ]
  for (const link of deepLinks) {
    const matched = routes().find((route) =>
      new RegExp(`^${route.src}$`).test(link),
    )
    assert.equal(
      matched?.dest,
      '/api',
      `${link} must be handled by the authenticated function`,
    )
  }
})

test('legacy routes are used alone, so nothing is matched before them', () => {
  // `rewrites`/`redirects` cannot be combined with `routes`, and mixing them in
  // would reintroduce Vercel's implicit filesystem step ahead of the catch-all —
  // which is exactly what would serve `index.html` unauthenticated.
  assert.equal('rewrites' in VERCEL, false)
  assert.equal('redirects' in VERCEL, false)
})

test('a hashed asset still resolves to the built asset directory', () => {
  const asset = routes()[0]
  assert.equal(asset?.src, '/assets/(.*)')
  assert.equal(asset?.dest, '/assets/$1')
})

// ---------------------------------------------------------------------------
// Build contract
// ---------------------------------------------------------------------------

test('the build and output match the existing Vite project', () => {
  assert.equal(VERCEL.buildCommand, 'npm run web:build')
  assert.equal(VERCEL.outputDirectory, 'apps/web/dist')
  assert.equal(PACKAGE.scripts?.['web:build'], 'vite build apps/web --config apps/web/vite.config.ts')
})

test('the function bundles the built web files and the source it imports', () => {
  // Both halves matter, and neither is optional: the built web files because
  // the function serves the SPA shell itself, and `src/` because the entry
  // point imports the application through `.ts` specifiers that the platform
  // resolves at runtime. Which paths each glob actually covers is checked
  // against the real import graph in `functionPackaging.test.ts`.
  const fn = VERCEL.functions?.['api/index.ts']
  assert.ok(fn, 'the Node function must be configured')
  const includeFiles = String(fn.includeFiles)
  assert.match(includeFiles, /apps\/web\/dist/)
  assert.match(includeFiles, /(^|[{,/])src([},/]|$)/)
})

test('the function duration is sized for a web request, not a batch', () => {
  const maxDuration = VERCEL.functions?.['api/index.ts']?.maxDuration
  assert.ok(typeof maxDuration === 'number')
  assert.ok(
    maxDuration <= 30,
    'a long duration would invite batch work into a web deployment',
  )
  assert.ok(maxDuration >= 5)
})

test('the streamed monthly CSV has its bounded extended request window', () => {
  const fn = VERCEL.functions?.['api/monthly-report-csv.ts']
  assert.ok(fn, 'the monthly CSV function must be configured')
  assert.equal(fn.maxDuration, 180)
  assert.match(String(fn.includeFiles), /apps\/web\/dist/)
  assert.match(String(fn.includeFiles), /(^|[{,/])src([},/]|$)/)
  assert.match(CSV_ENTRY_CODE, /createVercelDashboardHandler/)
  assert.match(CSV_ENTRY_CODE, /\/api\/v1\/reports\/monthly\.csv/)
  for (const forbidden of [/audit:worker/, /callaudit:worker/, /listen\(/]) {
    assert.doesNotMatch(CSV_ENTRY_CODE, forbidden)
  }
})

test('the 1–3 item reconciliation endpoint has a dedicated bounded window', () => {
  const fn = VERCEL.functions?.['api/reconciliation-batch.ts']
  assert.ok(fn, 'the reconciliation function must be configured')
  assert.equal(fn.maxDuration, 300)
  assert.match(String(fn.includeFiles), /apps\/web\/dist/)
  assert.match(String(fn.includeFiles), /(^|[{,/])src([},/]|$)/)
  assert.match(RECONCILIATION_ENTRY_CODE, /createVercelDashboardHandler/)
  assert.match(RECONCILIATION_ENTRY_CODE, /\/api\/v1\/reconciliation\/batch/)
  for (const forbidden of [/audit:worker/, /callaudit:worker/, /listen\(/]) {
    assert.doesNotMatch(RECONCILIATION_ENTRY_CODE, forbidden)
  }
})

test('Node 22 is selected through the existing engine contract', () => {
  const node = PACKAGE.engines?.node
  assert.ok(typeof node === 'string')
  assert.match(node, /22/)
  for (const unsupported of ['18', '20', '24']) {
    assert.equal(
      node.includes(unsupported),
      false,
      'the project must use the supported platform runtime',
    )
  }
})

test('Vercel local state is ignored', () => {
  assert.match(GITIGNORE, /^\.vercel\/$/m)
})

// ---------------------------------------------------------------------------
// A web deployment runs nothing but the web application
// ---------------------------------------------------------------------------

test('there is no Cron entry anywhere in the deployment config', () => {
  assert.equal('crons' in VERCEL, false)
  assert.equal(/cron/i.test(VERCEL_JSON_TEXT), false)
})

test('the function wires no Call Audit batch, worker, or scheduler', () => {
  for (const source of [API_ENTRY_CODE, FUNCTION_CODE]) {
    for (const forbidden of [
      /run-call-audit-batch/,
      /callAuditBatch/i,
      /run-reaudit-worker/,
      /run-report-email-worker/,
      /run-cycle-close/,
      /run-automated-validation/,
      /\bworker\b/i,
      /setInterval/,
      /schedule/i,
      /cron/i,
    ]) {
      assert.equal(
        forbidden.test(source),
        false,
        `the Vercel entry must not reference ${forbidden}`,
      )
    }
  }
})

test('the function never binds a port', () => {
  for (const source of [API_ENTRY_CODE, FUNCTION_CODE, code(ADAPTER_SOURCE)]) {
    assert.equal(/\.listen\(/.test(source), false)
  }
})

test('the function runs no migration and executes no SQL of its own', () => {
  for (const source of [API_ENTRY_CODE, FUNCTION_CODE]) {
    assert.equal(/migrat/i.test(source), false)
    assert.equal(/\bCREATE TABLE\b|\bINSERT INTO\b|\bALTER TABLE\b/i.test(source), false)
  }
})

// ---------------------------------------------------------------------------
// The function shares the reviewed bootstrap instead of re-deriving it
// ---------------------------------------------------------------------------

test('the entry point delegates to the shared runtime factory', () => {
  assert.match(
    FUNCTION_CODE,
    /import \{[\s\S]*?createDashboardRuntime[\s\S]*?\} from '\.\.\/runtime\/dashboardRuntime\.ts'/,
  )
  assert.match(API_ENTRY_CODE, /createVercelDashboardHandler/)
})

test('the function duplicates no security decision of its own', () => {
  for (const source of [API_ENTRY_CODE, FUNCTION_CODE, code(ADAPTER_SOURCE)]) {
    for (const forbidden of [
      /KAUDIT_CALL_AUDIT_RULE_TEST_ENABLED/,
      /OPENAI_API_KEY/,
      /createOpenAiCallAuditModel/,
      /createOidcVerifier/,
      /requirePermission/,
      /loadRuntimeConfig/,
      /createPool/,
      /DB_SSL_CA/,
    ]) {
      assert.equal(
        forbidden.test(source),
        false,
        `${forbidden} belongs to the shared factory, not to the Vercel entry`,
      )
    }
  }
})

test('the function uses Google Drive-backed cycle imports', () => {
  assert.equal(/createMysqlCycleImportService/.test(FUNCTION_CODE), false)
  assert.equal(/createImportAnalysisService/.test(FUNCTION_CODE), false)
  assert.equal(/KAUDIT_IMPORT_ROOT/.test(FUNCTION_CODE), false)
  // The shared factory constructs the Drive object store; the function only
  // selects the reviewed serverless import mode.
  assert.match(FUNCTION_CODE, /cycleImports:\s*'google-drive'/)
  assert.equal(/\/tmp/.test(FUNCTION_CODE), false)
  assert.equal(/blob|s3/i.test(FUNCTION_CODE), false)
})

test('the function asks for the bounded serverless pool profile', () => {
  assert.match(FUNCTION_CODE, /poolProfile:\s*'serverless'/)
})

test('functions run in Mumbai, next to the Bangalore database', async () => {
  // The MySQL/MariaDB host is in DigitalOcean BLR1 (Bangalore). From the
  // default iad1 region every statement paid a ~230 ms round trip, and a
  // reconciliation batch issues ~165 of them.
  const { readFile } = await import('node:fs/promises')
  const config = JSON.parse(
    await readFile(new URL('../../vercel.json', import.meta.url), 'utf8'),
  ) as { regions?: string[] }
  assert.deepEqual(config.regions, ['bom1'])
})

test('Audit Monitor summaries recompute in their own long-running function', () => {
  const fn = VERCEL.functions?.['api/audit-monitor-refresh.ts']
  assert.equal(fn?.maxDuration, 300)
  const entry = read('api/audit-monitor-refresh.ts')
  assert.match(entry, /createVercelDashboardHandler\(\)/)
  assert.match(entry, /AUDIT_MONITOR_REFRESH_ROUTE/)
  // The page function keeps its short limit; only the refresh is long.
  assert.equal(VERCEL.functions?.['api/index.ts']?.maxDuration, 30)
})

test('Reports and Billing month reads run in their own longer functions', () => {
  for (const page of ['reports', 'billing']) {
    assert.equal(VERCEL.functions?.[`api/${page}-page.ts`]?.maxDuration, 120)
    assert.match(read(`api/${page}-page.ts`), new RegExp(`request\\.url = \`/api/v1/${page}\\$\\{search\\}\``))
  }
  const routes = (JSON.parse(read('vercel.json')) as { routes: Array<{ src: string; dest: string }> }).routes
  const index = (src: string) => routes.findIndex((route) => route.src === src)
  // The CSV export keeps its own route; the catch-all stays last.
  assert.ok(index('/api/v1/reports/monthly.csv') < index('/api/v1/reports'))
  assert.ok(index('/api/v1/billing') < index('/(.*)'))
  assert.equal(VERCEL.functions?.['api/index.ts']?.maxDuration, 30)
})

test('the monthly PDF summary has the same extended window as the CSV', () => {
  assert.equal(VERCEL.functions?.['api/monthly-report-pdf.ts']?.maxDuration, 180)
  assert.match(read('api/monthly-report-pdf.ts'), /request\.url = `\/api\/v1\/reports\/monthly\.pdf\$\{search\}`/)
})
