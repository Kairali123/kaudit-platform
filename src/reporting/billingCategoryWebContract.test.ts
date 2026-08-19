import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import {
  BILLING_CATEGORY_ANALYSIS_PAGE_ROUTE,
  BILLING_CATEGORY_ANALYSIS_ROUTE,
  BILLING_CATEGORY_SUMMARY_ROUTE,
  DEFAULT_PAGE_SIZE,
} from './billingCategoryAnalysis.ts'

/**
 * Static contract between the category-analysis API and the page that renders
 * it.
 *
 * The project has no browser test runner, so this pins what a render test would
 * otherwise catch: the page is its own destination under Billing Audit, the
 * selected category is announced and not merely coloured, the footer reports
 * scope totals rather than page totals, and no duration is ever formatted as
 * money or an amount through binary floating point.
 *
 * No fixture, identifier, or amount in this file comes from real data.
 */

const WEB_ROOT = path.resolve(import.meta.dirname, '../../apps/web/src')

async function webSource(relative: string): Promise<string> {
  return readFile(path.join(WEB_ROOT, relative), 'utf8')
}

const PAGE = 'pages/BillingCategoryAnalysisPage.tsx'

test('the page is a distinct route, not a section of Call Audit', async () => {
  const app = await webSource('App.tsx')
  assert.match(app, /path="billing\/categories"/)
  assert.match(app, /BillingCategoryAnalysisPage/)
  assert.equal(
    BILLING_CATEGORY_ANALYSIS_PAGE_ROUTE,
    '/billing/categories',
  )
  const callAudit = await webSource('pages/CallAuditReportPage.tsx')
  assert.equal(/billing\/categories/.test(callAudit), false)
})

test('the nav item sits in Billing Audit and is admin-only', async () => {
  const shell = await webSource('components/AppShell.tsx')
  assert.match(
    shell,
    /to: '\/billing\/categories',\s*\n\s*label: 'Category analysis',\s*\n\s*icon: \w+,\s*\n\s*admin: true,/,
  )
  // Billing must stop matching once its own child route is open.
  assert.match(
    shell,
    /to: '\/billing',\s*\n\s*label: 'Billing',\s*\n\s*icon: \w+,\s*\n\s*end: true,/,
  )
})

test('the page reads the admin-only API with a bounded, paged query', async () => {
  const source = await webSource(PAGE)
  assert.ok(source.includes(BILLING_CATEGORY_ANALYSIS_ROUTE))
  assert.match(source, /page: String\(page\)/)
  // Bounded page size, matching the server default. A month can hold tens of
  // thousands of audited calls, so the table must never ask for all of them and
  // narrow the result in the browser.
  assert.equal(DEFAULT_PAGE_SIZE, 25)
  assert.match(source, /const PAGE_SIZE = 25\b/)
  assert.match(source, /pageSize: String\(PAGE_SIZE\)/)
  assert.equal(/pageSize: '?(?:100|1000|0)'?\b/.test(source), false)
  // Selecting a category re-queries; it never navigates.
  assert.equal(/navigate\(/.test(source), false)
  assert.match(source, /setCategory\(kpi\.category\)/)
})

/**
 * The two reads that make a KPI click cheap.
 *
 * The month summary is keyed by MONTH ALONE, so selecting a category cannot
 * invalidate or refetch it; the table is keyed by month, category and page, so
 * every selection is cached independently. A regression that folded them back
 * into one request would have to change these keys.
 */
test('month KPIs and table pages are separate, independently keyed reads', async () => {
  const source = await webSource(PAGE)
  assert.ok(source.includes(BILLING_CATEGORY_SUMMARY_ROUTE))
  assert.match(
    source,
    /queryKey: \['billing-category-summary', period\.month\]/,
  )
  assert.match(
    source,
    /queryKey: \['billing-category-page', period\.month, category, page\]/,
  )
  // The month summary is retained across selections rather than refetched.
  assert.match(source, /staleTime: SUMMARY_STALE_MS/)
  assert.match(source, /const SUMMARY_STALE_MS = 5 \* 60_000/)
})

/**
 * Prefetching is TARGETED, not eager.
 *
 * Warming every selectable category as soon as the month landed turned opening
 * the page into nine bounded reads on top of the summary's two — enough to
 * exhaust a serverless connection pool before the reader had chosen anything.
 * A prefetch now happens only where a reader has shown intent: the pointer is
 * over one KPI, or the keyboard has focused it.
 */
test('only the category a reader targets is prefetched', async () => {
  const source = await webSource(PAGE)
  assert.match(source, /prefetchQuery\(\s*tableQueryOptions\(period, kpi\.category, 1\),?\s*\)/)
  assert.match(source, /onPointerEnter=\{selectable \? onPrefetch : undefined\}/)
  assert.match(source, /onFocus=\{selectable \? onPrefetch : undefined\}/)
  // ONE prefetch call site, reachable only from those two handlers. A second
  // one is how an eager pass would come back.
  assert.equal(source.match(/prefetchQuery/g)?.length, 1)
  assert.equal(/for \(/.test(source), false)
  // No effect prefetches anything: the only effect resets the selection when
  // the bill month changes.
  const effects = [...source.matchAll(/useEffect\(\(\) => \{([\s\S]*?)\n {2}\}, \[/g)]
  assert.equal(effects.length, 1)
  assert.equal(effects[0][1].includes('prefetch'), false)
  assert.match(effects[0][1], /setCategory\(ALL_CATEGORIES\)/)
  // No Recording is a KPI, not a selection: it has no audited-call table, so it
  // is neither selectable nor prefetchable.
  assert.match(source, /return category !== NO_RECORDING/)
  assert.match(source, /selectable=\{isSelectable\(kpi\.category\)\}/)
  // The prefetch and the click resolve the SAME options helper, so a warmed
  // page can never land under a key the click does not read. A prefetched page
  // must also still count as fresh when the reader clicks, or the click
  // refetches what was just fetched and the prefetch buys nothing.
  assert.match(source, /\.\.\.tableQueryOptions\(period, category, page\)/)
  assert.equal(source.match(/tableQueryOptions\(/g)?.length, 3)
  assert.equal(source.match(/'billing-category-page'/g)?.length, 1)
  assert.match(source, /staleTime: TABLE_STALE_MS/)
})

/**
 * Keeping the previous page on screen is what makes an uncached selection feel
 * continuous. It must be React Query's own retention of a server-selected page
 * — never a client-side filter over the twenty-five rows already on hand, which
 * would silently show a fraction of the selected category as if it were all of
 * it.
 */
test('the table keeps the previous server page and never filters rows itself', async () => {
  const source = await webSource(PAGE)
  assert.match(source, /placeholderData: keepPreviousData/)
  assert.equal(/rows\s*\.?\s*\.filter\(/.test(source), false)
  assert.equal(/\.rows\.filter\(/.test(source), false)
  assert.equal(/rows\.slice\(/.test(source), false)
  // The heading, footer and pager describe the page on screen, not the pending
  // selection, so retained rows are never labelled with another category: all
  // four read from the same `shown*` values, which are resolved from the
  // response the table is actually rendering.
  assert.match(source, /const shownCategory = table\?\.scope\.category \?\? category/)
  assert.match(source, /const shownLabel = table\?\.scope\.categoryLabel/)
  assert.match(source, /<span className="eyebrow">\{shownLabel\}<\/span>/)
  assert.match(source, /<ScopeTotalsRow label=\{shownLabel\} totals=\{totals\} \/>/)
  assert.match(source, /Page \{table\?\.pagination\.page \?\? page\}/)
  // Paging is refused while the retained page belongs to another selection, so
  // a Next click can never be applied against a scope that is not on screen.
  assert.match(source, /tableQuery\.isPlaceholderData/)
})

test('the selected category is announced, not only coloured', async () => {
  const source = await webSource(PAGE)
  assert.match(source, /aria-pressed=\{selected\}/)
  // Local state, not the table response: the selection is acknowledged the
  // moment it is made, even while its page is still arriving.
  assert.match(source, /selected=\{kpi\.category === category\}/)
  const styles = await webSource('styles.css')
  assert.match(styles, /\.category-kpi\[aria-pressed='true'\]/)
  assert.match(styles, /\.category-kpi:focus-visible/)
})

test('every required table column is rendered', async () => {
  const source = await webSource(PAGE)
  for (const column of [
    'Task ID',
    'Call Date',
    'Call Start',
    'Call end',
    'Category',
    'Call Duration (Kserve)',
    'Amount Charged (Kserve)',
    'AI Audit Amt',
    'AI Audit Time',
    'Gap',
    'AI Confidence',
    'AI Audit Result',
    'Recording / admin review',
  ]) {
    assert.ok(source.includes(`<th>${column}</th>`), column)
  }
  // The review action is the existing restricted route, keyed by reference.
  assert.match(source, /\/audits\/call\?task=\$\{encodeURIComponent\(/)
})

test('the footer totals the whole scope and labels what does not apply', async () => {
  const source = await webSource(PAGE)
  assert.match(source, /Totals for the whole selected category, not for this page/)
  assert.match(source, /totals\.kserveChargeTimeMinutes/)
  assert.match(source, /totals\.kserveChargeInr/)
  assert.match(source, /totals\.aiAuditedDurationMinutes/)
  assert.match(source, /totals\.gapMinutes/)
  // Columns that cannot be summed say so instead of showing a blank or a zero.
  assert.match(source, /Not applicable/)
  // The footer total is the SAME server-computed KPI the tile shows, selected
  // from the month summary rather than derived from the rows on screen.
  assert.match(
    source,
    /data\.categories\.find\(\(kpi\) => kpi\.category === shownCategory\)/,
  )
  assert.equal(/totals\s*=\s*table/.test(source), false)
})

test('the pager reuses the selected server KPI count', async () => {
  const source = await webSource(PAGE)
  assert.match(source, /const shownTotalRows = totals\?\.auditedCallCount \?\? 0/)
  assert.match(source, /Math\.ceil\(shownTotalRows \/ PAGE_SIZE\)/)
  assert.equal(/rows\.length\s*\//.test(source), false)
  assert.equal(/pagination\.totalRows|pagination\.totalPages/.test(source), false)
  assert.match(source, /tableQuery\.isPlaceholderData/)
})

test('the page reports capped auditor money and missing-duration calls', async () => {
  const source = await webSource(PAGE)
  assert.match(source, /auditorFinalChargeInr/)
  assert.match(source, /kpi\.auditorUnfinalizedCalls/)
  assert.match(source, /auditor capped/)
  assert.match(source, /missing duration/)
  assert.match(source, /kpi\.auditorMoneyComplete \? 'good' : 'warn'/)
})

test('the KPI area renders the management design including No Recording', async () => {
  const source = await webSource(PAGE)
  const server = await readFile(
    path.resolve(import.meta.dirname, 'billingCategoryAnalysis.ts'),
    'utf8',
  )
  assert.match(server, /BILLING_CATEGORY_CATALOG/)
  assert.match(server, /emptyKpi\(category, label, populationCount\)/)
  assert.match(source, /filter\(\(kpi\) => !kpi\.isAllCategories\)/)
  assert.match(source, /kpi\.sharePercent/)
  assert.match(source, /kpi\.chargeGapInr/)
  assert.match(source, /selectable=\{isSelectable\(kpi\.category\)\}/)
  assert.match(source, /KServe billed the log, but no recording URL was provided/)
  for (const label of [
    'Original',
    'Audited',
    'Gap',
    'Original amt',
    'Audited amt',
    'Gap amt',
  ]) {
    assert.ok(source.includes(`>${label}<`), label)
  }
})

test('the management summary and Grand Total surround the KPI area', async () => {
  const source = await webSource(PAGE)
  assert.equal(source.includes('<Notice'), false)
  for (const label of [
    'Total audited calls',
    'Issue found',
    'No issue found',
    'Grand total across',
    'Total calls',
    'Total original time',
    'Total audited time',
    'Total time gap',
    'Total original amount',
    'Total audited amount',
    'Total gap amount',
  ]) {
    assert.ok(source.includes(label), label)
  }
  assert.ok(
    source.indexOf('category-grand-total') <
      source.indexOf('audit-control-bar'),
  )
  assert.match(source, /const grandTotal = data\.grandTotal/)
})

test('no duration is rendered as money, and no amount is parsed as a float', async () => {
  const source = await webSource(PAGE)
  for (const field of [
    'kserveChargeTimeMinutes',
    'aiAuditedDurationMinutes',
    'gapMinutes',
    'kserveChargeTimeMs',
    'aiAuditedDurationMs',
    'gapMs',
  ]) {
    assert.equal(
      new RegExp(`money\\([^)]*${field}`).test(source),
      false,
      `${field} must never be rendered as a currency amount`,
    )
  }
  // The money formatter is integer arithmetic: no Number(), parseFloat, or
  // arithmetic operator ever touches a stored amount. It lives in ONE shared
  // module so two Billing Audit screens cannot round the same figure
  // differently, and the page reaches it by import rather than by copy.
  assert.equal(/Number\([^)]*Inr\)/.test(source), false)
  assert.equal(/parseFloat/.test(source), false)
  assert.match(source, /import \{ money \} from '\.\.\/lib\/money'/)
  assert.equal(/kpi\.kserveChargeInr\s*-/.test(source), false)
  const formatter = await webSource('lib/money.ts')
  assert.match(formatter, /BigInt\(/)
  // Calls, not prose: the module names both in a comment explaining why it
  // uses neither.
  assert.equal(/parseFloat\(|Number\(/.test(formatter), false)
})

test('the client type keeps money as text and durations as metadata', async () => {
  const source = await webSource('lib/api.ts')
  assert.match(source, /kserveChargeInr: string/)
  assert.match(source, /auditorFinalChargeInr: string/)
  assert.match(source, /auditorUnfinalizedCalls: number/)
  assert.match(source, /gapMinutes: string \| null/)
  assert.match(source, /kserveChargeInr: string/)
  assert.match(source, /auditorFinalChargeInr: string \| null/)
  assert.match(source, /aiConfidence: string \| null/)
  assert.match(source, /aiAuditResult: 'Issue found' \| 'No issue found'/)
  assert.match(source, /recordingAvailable: boolean/)
  // No client-side field could carry evidence or an internal identifier.
  const shape = source.slice(
    source.indexOf('export interface BillingCategoryCall '),
    source.indexOf('export interface BillingCategoryDurationBasis'),
  )
  assert.ok(shape.length > 0)
  for (const forbidden of [
    'callId',
    'sourceUrl',
    'recordingUrl',
    'evidenceSha256',
    'transcript',
  ]) {
    assert.equal(shape.includes(forbidden), false, forbidden)
  }
})

/**
 * The client mirrors the server's split, and mirrors it the same way round: the
 * month response carries no rows, and the page response carries no KPI. A
 * client type that still declared both would let a page quietly go back to
 * expecting one request for everything.
 */
test('the client types mirror the month/page split', async () => {
  const source = await webSource('lib/api.ts')
  const summary = source.slice(
    source.indexOf('export interface BillingCategorySummaryData'),
    source.indexOf('export type BillingCategoryScopeKpi'),
  )
  const page = source.slice(
    source.indexOf('export interface BillingCategoryPageData'),
    source.indexOf('export interface KserveSettlementVersion'),
  )
  assert.ok(summary.length > 0)
  assert.ok(page.length > 0)
  assert.match(summary, /categories: BillingCategoryScopeKpi\[\]/)
  assert.match(summary, /grandTotal: BillingCategoryKpi/)
  for (const pageOnly of ['rows', 'pagination', 'categoryLabel']) {
    assert.equal(summary.includes(pageOnly), false, pageOnly)
  }
  assert.match(page, /rows: BillingCategoryCall\[\]/)
  assert.match(page, /pagination:\s*\{\s*page: number\s*pageSize: number\s*\}/)
  assert.equal(page.includes('totalRows'), false)
  assert.equal(page.includes('totalPages'), false)
  for (const monthOnly of ['categories', 'grandTotal', 'totals']) {
    assert.equal(page.includes(monthOnly), false, monthOnly)
  }
  // The KPI states what it totals, so the footer can display the tile's own
  // object instead of a separately derived total.
  assert.match(source, /basis: 'entire_selected_scope'/)
})
