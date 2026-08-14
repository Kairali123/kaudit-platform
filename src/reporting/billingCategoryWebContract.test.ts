import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import {
  BILLING_CATEGORY_ANALYSIS_PAGE_ROUTE,
  BILLING_CATEGORY_ANALYSIS_ROUTE,
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
  assert.match(source, /pageSize: '25'/)
  // Selecting a category re-queries; it never navigates.
  assert.equal(/navigate\(/.test(source), false)
  assert.match(source, /setCategory\(kpi\.category\)/)
})

test('the selected category is announced, not only coloured', async () => {
  const source = await webSource(PAGE)
  assert.match(source, /aria-pressed=\{selected\}/)
  assert.match(source, /selected=\{kpi\.category === data\.scope\.category\}/)
  const styles = await webSource('styles.css')
  assert.match(styles, /\.category-kpi\[aria-pressed='true'\]/)
  assert.match(styles, /\.category-kpi:focus-visible/)
})

test('every required table column is rendered', async () => {
  const source = await webSource(PAGE)
  for (const column of [
    'Task / call reference',
    'Call date',
    'Call start',
    'Call end',
    'Recording / admin review',
    'Category',
    'KServe charge time',
    'AI-audited duration',
    'Gap',
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
  assert.match(source, /totals\.aiAuditedDurationMinutes/)
  assert.match(source, /totals\.gapMinutes/)
  // Columns that cannot be summed say so instead of showing a blank or a zero.
  assert.match(source, /Not applicable/)
  assert.match(source, /comparableCalls\)\}\s*\n?\s*comparable calls/)
})

test('the page separates final auditor money from unfinalized calls', async () => {
  const source = await webSource(PAGE)
  assert.match(source, /auditorFinalChargeInr/)
  assert.match(source, /kpi\.auditorFinalPricedCalls/)
  assert.match(source, /kpi\.auditorUnfinalizedCalls/)
  assert.match(source, /not finalized/)
  assert.match(source, /kpi\.auditorMoneyComplete \? 'good' : 'warn'/)
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
  assert.match(source, /recordingAvailable: boolean/)
  // No client-side field could carry evidence or an internal identifier.
  const shape = source.slice(
    source.indexOf('export interface BillingCategoryCall '),
    source.indexOf('export interface BillingCategoryAnalysisData'),
  )
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
