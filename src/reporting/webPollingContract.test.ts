import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'

/**
 * Static contract for background polling in the web client.
 *
 * The project has no browser test runner, so this pins what a running app
 * would otherwise have to demonstrate: the query client does NOT poll by
 * default, every poll is declared by the one screen that needs it, each
 * declared interval is a bounded number rather than `true`, and the static
 * screens (home, overview, evidence, findings, billing, reports, and the
 * shell's profile/auth/period reads) declare none — they refetch on mount and
 * on invalidation only.
 *
 * No fixture, identifier, or amount in this file comes from real data.
 */

const WEB_ROOT = path.resolve(import.meta.dirname, '../../apps/web/src')

async function webSource(relative: string): Promise<string> {
  return readFile(path.join(WEB_ROOT, relative), 'utf8')
}

/** Every `.tsx`/`.ts` module under apps/web/src, repo-relative to that root. */
async function webModules(): Promise<string[]> {
  const found: string[] = []
  async function walk(relative: string): Promise<void> {
    const entries = await readdir(path.join(WEB_ROOT, relative), {
      withFileTypes: true,
    })
    for (const entry of entries) {
      const next = relative ? `${relative}/${entry.name}` : entry.name
      if (entry.isDirectory()) await walk(next)
      else if (/\.tsx?$/.test(entry.name)) found.push(next)
    }
  }
  await walk('')
  return found.sort()
}

/**
 * The only modules allowed to poll: state that genuinely moves while the
 * operator watches it, because a worker or an ingestion job is changing it.
 */
const LIVE_MONITORS = new Set([
  'components/AuditWorkerControl.tsx',
  'pages/AuditMonitorPage.tsx',
  'pages/ImportPage.tsx',
])

/** Screens that only change when the operator navigates or submits. */
const STATIC_SCREENS = [
  'components/AppShell.tsx',
  'components/KserveSettlement.tsx',
  'pages/AuditCallDetailPage.tsx',
  'pages/BillingCategoryAnalysisPage.tsx',
  'pages/BillingPage.tsx',
  'pages/CallAuditReportPage.tsx',
  'pages/CallAuditSettingsPage.tsx',
  'pages/EvidencePage.tsx',
  'pages/FindingsPage.tsx',
  'pages/HomePage.tsx',
  'pages/LoginPage.tsx',
  'pages/OperationsPage.tsx',
  'pages/OverviewPage.tsx',
  'pages/ReportsPage.tsx',
  'pages/UserManagementPage.tsx',
]

test('the query client does not poll the whole app by default', async () => {
  const source = await webSource('main.tsx')
  assert.equal(
    /refetchInterval\s*:/.test(source),
    false,
    'no global refetchInterval may be configured',
  )
  // The rest of the default read behaviour is deliberate and still stated.
  assert.match(source, /staleTime: 30_000/)
  assert.match(
    source,
    /error instanceof ApiError && error\.status === 504/,
  )
  assert.match(source, /failureCount < 1/)
  assert.match(source, /refetchOnWindowFocus: false/)
})

test('every polling screen is one of the declared live monitors', async () => {
  const polling: string[] = []
  for (const relative of await webModules()) {
    const source = await webSource(relative)
    if (/refetchInterval\s*:/.test(source)) polling.push(relative)
  }
  assert.deepEqual(polling, [...LIVE_MONITORS].sort())
})

test('static screens declare no polling of their own', async () => {
  for (const relative of STATIC_SCREENS) {
    const source = await webSource(relative)
    assert.equal(
      /refetchInterval\s*:|refetchOnWindowFocus: true|refetchOnMount: 'always'/.test(
        source,
      ),
      false,
      `${relative} must not poll in the background`,
    )
  }
  // The shell's profile, auth and period reads are the ones every page mounts.
  const shell = await webSource('components/AppShell.tsx')
  for (const key of ["'me'", "'auth-config'", "'billing-periods'"]) {
    assert.match(shell, new RegExp(`queryKey: \\[${key}\\]`))
  }
})

test('month-scoped pages wait for periods instead of firing all-period aggregates', async () => {
  const shell = await webSource('components/AppShell.tsx')
  assert.match(shell, /pageReadNeedsBillMonth/)
  assert.match(shell, /pageNeedsMonth && periodsQuery\.isLoading/)
  assert.match(shell, /return <LoadingState \/>/)
  assert.match(shell, /pageNeedsMonth && periodsQuery\.error/)
  assert.match(
    shell,
    /enabled: profileQuery\.isSuccess && billMonthInScope/,
  )
})

test('each declared interval is a bounded number, never unconditional', async () => {
  const declared = new Map<string, number[]>()
  for (const relative of LIVE_MONITORS) {
    const source = await webSource(relative)
    const intervals = [...source.matchAll(/refetchInterval:\s*([^,\n]+)/g)].map(
      (match) => match[1].trim(),
    )
    assert.notEqual(intervals.length, 0, `${relative} declares no interval`)
    declared.set(
      relative,
      intervals.map((raw) => {
        assert.match(
          raw,
          /^[\d_]+$/,
          `${relative} must poll on a fixed number of ms, not ${raw}`,
        )
        return Number(raw.replaceAll('_', ''))
      }),
    )
  }
  for (const [relative, intervals] of declared) {
    for (const ms of intervals) {
      // Fast enough to be live, slow enough not to hammer the aggregates.
      assert.ok(ms >= 5_000, `${relative} polls too fast: ${ms}ms`)
      assert.ok(ms <= 60_000, `${relative} polls too slowly: ${ms}ms`)
    }
  }
  assert.deepEqual(declared.get('components/AuditWorkerControl.tsx'), [15_000])
  assert.deepEqual(
    declared.get('pages/AuditMonitorPage.tsx'),
    [60_000, 60_000, 60_000, 60_000],
  )
  assert.deepEqual(declared.get('pages/ImportPage.tsx'), [30_000])
})

test('audit monitor isolates row tables before expensive summaries', async () => {
  const source = await webSource('pages/AuditMonitorPage.tsx')
  assert.match(source, /section=rows&table=audited/)
  assert.match(source, /section=rows&table=pending/)
  assert.match(source, /section=rows&table=no-recording/)
  assert.match(source, /section: 'summary'/)
  assert.match(source, /auditedRowsQuery\.isFetched/)
  assert.match(source, /pendingRowsQuery\.isFetched/)
  assert.match(source, /noRecordingRowsQuery\.isFetched/)
  assert.doesNotMatch(source, /!auditedRowsQuery\.isFetching/)
  assert.doesNotMatch(source, /!pendingRowsQuery\.isFetching/)
  assert.doesNotMatch(source, /!noRecordingRowsQuery\.isFetching/)
  assert.match(source, /placeholderData: keepPreviousData/)
  assert.match(source, /const totalsFinal = summaryData != null/)
  assert.match(source, /function withTotalRows/)
  assert.match(source, /auditedRowsQuery\.isLoading && <LoadingState/)
  assert.match(source, /pendingRowsQuery\.isLoading && <LoadingState/)
  assert.match(source, /noRecordingRowsQuery\.isLoading && <LoadingState/)
  assert.match(source, /summaryQuery\.isLoading && <LoadingState \/>/)
})
