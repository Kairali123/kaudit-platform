import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { KSERVE_SETTLEMENT_ROUTE } from './kserveSettlement.ts'
import { MAX_SETTLEMENT_HISTORY } from '../billing/kserveSettlement.ts'

/**
 * Static contract between the settlement API and the Billing Audit screen that
 * records it.
 *
 * The project has no browser test runner, so this pins what a render test would
 * otherwise catch: the section lives on the Billing Audit screen for the
 * selected month, it is labelled exactly as the product requires, saving takes
 * a deliberate second action and cannot be double-submitted, the browser never
 * calculates savings, and absence is never rendered as zero.
 *
 * No fixture, identifier, or amount in this file comes from real data.
 */

const WEB_ROOT = path.resolve(import.meta.dirname, '../../apps/web/src')

async function webSource(relative: string): Promise<string> {
  return readFile(path.join(WEB_ROOT, relative), 'utf8')
}

const PANEL = 'components/KserveSettlement.tsx'

test('the section sits on the Billing Audit screen, not on its own route', async () => {
  const billing = await webSource('pages/BillingPage.tsx')
  assert.match(billing, /KserveSettlementPanel/)
  assert.match(billing, /month=\{period\.month\}/)
  // It is a section of Billing, so it adds no route and no nav item.
  const app = await webSource('App.tsx')
  assert.equal(app.includes('settlement'), false)
  const shell = await webSource('components/AppShell.tsx')
  assert.equal(shell.toLowerCase().includes('settlement'), false)
})

test('the field carries the exact product label', async () => {
  const source = await webSource(PANEL)
  assert.ok(source.includes('<h2>Final amount paid to KServe</h2>'))
  assert.ok(
    source.includes('<span>Final amount paid to KServe (INR)</span>'),
  )
})

test('the panel reads the admin-only route for the selected month', async () => {
  const source = await webSource(PANEL)
  assert.ok(source.includes(KSERVE_SETTLEMENT_ROUTE))
  assert.match(source, /month=\$\{encodeURIComponent\(month\)\}/)
  // A non-administrator never renders it, and neither does "All periods".
  assert.match(source, /if \(!isAdmin\) return null/)
  assert.match(source, /const singleMonth = month !== 'all'/)
})

test('saving is deliberate and cannot be double-submitted', async () => {
  const source = await webSource(PANEL)
  // A first press asks for confirmation; only a second press saves.
  assert.match(source, /if \(!confirming\) \{\s*\n\s*setConfirming\(true\)/)
  // In-flight and invalid submissions never become a request.
  assert.match(source, /if \(pending \|\| !draftValid\) return/)
  assert.match(source, /disabled=\{pending \|\| !draftValid\}/)
  // Editing the amount withdraws the confirmation.
  assert.match(source, /setConfirming\(false\)/)
})

test('every attempt at one draft carries the same retry key', async () => {
  const source = await webSource(PANEL)
  assert.match(source, /idempotencyKey,/)
  // The key is replaced only after a save succeeds, and when the month changes.
  const onSuccess = source.slice(
    source.indexOf('onSuccess: (result)'),
    source.indexOf('if (!isAdmin)'),
  )
  assert.match(onSuccess, /setIdempotencyKey\(newIdempotencyKey\(\)\)/)
  assert.equal(
    /onChange[\s\S]{0,200}setIdempotencyKey/.test(source),
    false,
    'typing must not mint a new retry key',
  )
})

test('the browser never calculates savings or any other amount', async () => {
  for (const relative of [PANEL, 'pages/ReportsPage.tsx']) {
    const source = await webSource(relative)
    // No subtraction, no parsing, no float anywhere near an amount.
    assert.equal(/parseFloat\(/.test(source), false, relative)
    assert.equal(/Number\([^)]*Inr\)/.test(source), false, relative)
    assert.equal(
      /(chargeInr|finalPaidAmountInr|savingsInr|amountInr)\s*[-+*/]\s/.test(
        source,
      ),
      false,
      `${relative} performs arithmetic on an amount`,
    )
    // Money is formatted by the one shared integer/BigInt formatter.
    assert.match(source, /import \{ money \} from '\.\.\/lib\/money'/)
  }
})

test('absent money is labelled, never rendered as zero', async () => {
  const source = await webSource(PANEL)
  assert.ok(source.includes('Not recorded yet'))
  assert.ok(source.includes('Unavailable'))
  // Rendering is gated on the server's own availability flags.
  assert.match(source, /data\.savings\.available/)
  assert.match(source, /data\.vendorBilled\.available/)
  assert.match(source, /data\.current\s*$/m)
  const reports = await webSource('pages/ReportsPage.tsx')
  assert.ok(reports.includes('Not recorded'))
  assert.match(reports, /data\.settlement\.savingsAvailable/)
})

test('a failed settlement read is labelled as such, never as "not recorded"', async () => {
  const reports = await webSource('pages/ReportsPage.tsx')
  // The three states are all rendered, and the failure has its own bounded
  // prose: "not recorded" describes the month, and a failed read established
  // nothing about the month.
  assert.match(reports, /data\.settlement\.status === 'unavailable'/)
  assert.ok(reports.includes('Settlement temporarily unavailable'))
  assert.ok(reports.includes('No settlement exists for this period'))
  // Nothing about the failure itself is rendered — no message, no code, no
  // field, no value.
  for (const forbidden of ['error', 'Error', 'reason', 'detail']) {
    const settlementBlock = reports.slice(
      reports.indexOf('settlement-summary'),
      reports.indexOf('snapshot-grid'),
    )
    assert.equal(settlementBlock.includes(forbidden), false, forbidden)
  }
})

test('pending, error and success states are all rendered', async () => {
  const source = await webSource(PANEL)
  assert.match(source, /query\.isLoading &&/)
  assert.match(source, /query\.error &&/)
  assert.match(source, /failureMessage &&/)
  assert.match(source, /saved &&/)
  // A replay is announced as a replay, not as a second version.
  assert.ok(source.includes('Already recorded — nothing was duplicated'))
})

test('history is shown, bounded, and marks superseded versions', async () => {
  const source = await webSource(PANEL)
  for (const column of ['Version', 'Status', 'Amount paid', 'Recorded']) {
    assert.ok(source.includes(`<th>${column}</th>`), column)
  }
  assert.match(source, /data\.historyTruncated/)
  assert.match(source, /version\.status === 'current'/)
  // The server-side maximum exists and is a real bound.
  assert.ok(MAX_SETTLEMENT_HISTORY > 0 && MAX_SETTLEMENT_HISTORY <= 100)
})

test('the panel reuses the existing form and control styles', async () => {
  const source = await webSource(PANEL)
  for (const className of [
    'cas-form',
    'cas-actions',
    'cas-activate',
    'cas-facts',
    'content-section',
    'data-table',
  ]) {
    assert.ok(source.includes(className), className)
  }
  const styles = await webSource('styles.css')
  assert.match(styles, /\.settlement-facts/)
  assert.match(styles, /\.settlement-form/)
})

test('the client type keeps money as text and exposes no identity', async () => {
  const source = await webSource('lib/api.ts')
  assert.match(source, /finalPaidAmountInr: string/)
  assert.match(source, /amountInr: string \| null/)
  assert.match(source, /finallyPaidInr: string \| null/)
  const shape = source.slice(
    source.indexOf('export interface KserveSettlementVersion'),
    source.indexOf('export interface KserveSettlementSummary'),
  )
  for (const forbidden of [
    'settlementId',
    'idempotencyKey',
    'requestDigest',
    'recordedByUserId',
    'correlationId',
    'callId',
    'transcript',
  ]) {
    assert.equal(shape.includes(forbidden), false, forbidden)
  }
})
