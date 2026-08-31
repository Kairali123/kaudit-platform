import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import {
  MANUAL_REAUDIT_ROUTE,
  MANUAL_REAUDIT_RESUME_ROUTE,
  MAX_MANUAL_REAUDIT_CALLS,
} from '../reaudit/manualRequests.ts'

/**
 * Static contract between the re-audit endpoint and the page that drives it.
 *
 * The project has no browser test runner, so this pins what a render test would
 * otherwise catch: the selection is exact and bounded, a retry cannot double-
 * spend, a row already in flight cannot be selected again, every outcome is
 * visible, and no internal identifier is invented in the browser.
 *
 * No fixture, identifier, or amount in this file comes from real data.
 */

const WEB_ROOT = path.resolve(import.meta.dirname, '../../apps/web/src')

async function webSource(relative: string): Promise<string> {
  return readFile(path.join(WEB_ROOT, relative), 'utf8')
}

test('the client mirrors the server route and its ceiling exactly', async () => {
  const source = await webSource('lib/api.ts')
  assert.match(
    source,
    new RegExp(`MANUAL_REAUDIT_ROUTE = '${MANUAL_REAUDIT_ROUTE}'`),
  )
  assert.match(
    source,
    new RegExp(
      `MANUAL_REAUDIT_RESUME_ROUTE =\\s*'${MANUAL_REAUDIT_RESUME_ROUTE}'`,
    ),
  )
  assert.match(
    source,
    new RegExp(`MAX_MANUAL_REAUDIT_CALLS = ${MAX_MANUAL_REAUDIT_CALLS}`),
  )
})

test('the row type carries safe lifecycle fields and nothing more', async () => {
  const source = await webSource('lib/api.ts')
  const rowType = /interface AuditMonitorRow \{([\s\S]*?)\n\}/.exec(
    source,
  )?.[1]
  assert.ok(rowType)
  assert.match(source, /reAuditStatus: ManualReauditRowStatus \| null/)
  assert.match(source, /reAuditCompletedAt: string \| null/)
  assert.match(source, /reAuditFailureCode: string \| null/)
  assert.match(source, /'queued'[\s\S]{0,80}'processing'[\s\S]{0,80}'completed'[\s\S]{0,80}'failed'/)
  // The queue's internals are never modelled in the browser.
  for (const forbidden of [
    'baselineAuditRunId',
    'itemId',
    'internalCallId',
    'reAuditAttemptCount',
    'lastErrorCode',
  ]) {
    assert.equal(
      new RegExp(`${forbidden}\\??:`).test(rowType),
      false,
      `${forbidden} must not appear in the web client contract`,
    )
  }
})

test('the receipt type is counts and lifecycle only', async () => {
  const source = await webSource('lib/api.ts')
  assert.match(source, /interface ManualReauditReceipt \{[\s\S]*?\n\}/)
  const receipt = /interface ManualReauditReceipt \{([\s\S]*?)\n\}/.exec(
    source,
  )?.[1]
  assert.ok(receipt)
  for (const field of [
    'requestId',
    'outcome',
    'status',
    'acceptedCount',
    'alreadyQueuedCount',
  ]) {
    assert.match(receipt, new RegExp(`${field}:`))
  }
  assert.equal(/callReferences|callId|itemId/.test(receipt), false)
})

test('the page submits exactly the selected references and nothing that widens them', async () => {
  const source = await webSource('pages/AuditMonitorPage.tsx')
  assert.match(source, /postJson<ManualReauditReceipt>\(MANUAL_REAUDIT_ROUTE, \{/)
  assert.match(source, /callReferences: selected,/)
  // No filter, page, category, language, or period rides along with a paid
  // request.
  const submission = /postJson<ManualReauditReceipt>\([\s\S]*?\}\)/
    .exec(source)?.[0]
    // Read against the CODE. The comment beside it is allowed to name what the
    // submission deliberately excludes.
    .replaceAll(/\/\/.*$/gm, '')
  assert.ok(submission)
  for (const forbidden of [
    'category',
    'language',
    'page',
    'pageSize',
    'period',
    'queryString',
  ]) {
    assert.equal(
      new RegExp(`\\b${forbidden}\\b`).test(submission),
      false,
      `${forbidden} must not be sent with a re-audit selection`,
    )
  }
})

test('one retry key covers a draft and is replaced only after a success', async () => {
  const source = await webSource('pages/AuditMonitorPage.tsx')
  assert.match(source, /function newIdempotencyKey\(\): string/)
  assert.match(source, /idempotencyKey,/)
  // Replaced on success, and on any change of the rows the draft was made on.
  assert.match(
    source,
    /onSuccess: \(result\) => \{[\s\S]*?setIdempotencyKey\(newIdempotencyKey\(\)\)/,
  )
  assert.match(
    source,
    /setSelected\(\[\]\)[\s\S]{0,200}setIdempotencyKey\(newIdempotencyKey\(\)\)[\s\S]{0,140}\}, \[period\.month, page, category, language, taskId\]\)/,
  )
})

test('select-all covers this page only, and only live rows cannot be selected', async () => {
  const source = await webSource('pages/AuditMonitorPage.tsx')
  assert.match(source, /const selectable = data\.rows\s*\n?\s*\.filter\(\(row\) => !reAuditLocked\(row\)\)/)
  assert.match(source, /function reAuditLocked\(row: AuditMonitorRow\): boolean/)
  assert.match(
    source,
    /return row\.reAuditStatus === 'queued' \|\| row\.reAuditStatus === 'processing'/,
  )
  assert.match(source, /const toggleAll = \(\)/)
  assert.match(source, /disabled=\{reAuditLocked\(row\)\}/)
  assert.match(
    source,
    /aria-label="Select every re-auditable call on this page"/,
  )
})

test('the action is disabled while pending, empty, or over the ceiling', async () => {
  const source = await webSource('pages/AuditMonitorPage.tsx')
  assert.match(
    source,
    /disabled=\{\s*\n?\s*reAudit\.isPending \|\| selected\.length === 0 \|\| overLimit\s*\n?\s*\}/,
  )
  assert.match(
    source,
    /const overLimit = selected\.length > MAX_MANUAL_REAUDIT_CALLS/,
  )
})

test('the separate recovery action resumes existing work without a selection', async () => {
  const source = await webSource('pages/AuditMonitorPage.tsx')
  assert.match(
    source,
    /postJson<ManualReauditResumeReceipt>\(\s*MANUAL_REAUDIT_RESUME_ROUTE,\s*\{\}/,
  )
  assert.match(source, />\s*Resume queued re-audits\s*</)
  assert.match(
    source,
    /disabled=\{resumeReAudits\.isPending \|\| resumeReAudits\.isSuccess\}/,
  )
  assert.equal(
    /MANUAL_REAUDIT_RESUME_ROUTE[\s\S]{0,180}callReferences/.test(source),
    false,
  )
})

test('pending, success, and error are all visible states', async () => {
  const source = await webSource('pages/AuditMonitorPage.tsx')
  assert.match(source, /role="status" aria-live="polite"/)
  assert.match(source, /reAudit\.isPending && \(/)
  assert.match(source, /reAudit\.error && \(/)
  assert.match(source, /receipt && \(/)
  // And the per-row state is rendered from the server's own word.
  assert.match(source, /row\.reAuditStatus === 'processing'/)
  assert.match(source, /row\.reAuditStatus === 'completed'/)
  assert.match(source, /row\.reAuditStatus === 'failed'/)
  assert.match(source, /Previous audit retained/)
  assert.match(source, /date\(row\.reAuditCompletedAt\)/)
  assert.match(source, /function reAuditLabel\(row: AuditMonitorRow\): string/)
  assert.match(source, /function reAuditFailure\(row: AuditMonitorRow\): string/)
  assert.match(source, /CLASSIFICATION_FAILED: 'Classification failed'/)
})

test('a success refreshes the monitor and the worker state', async () => {
  const source = await webSource('pages/AuditMonitorPage.tsx')
  assert.match(
    source,
    /invalidateQueries\(\{ queryKey: \['audit-monitor'\] \}\)/,
  )
  assert.match(
    source,
    /invalidateQueries\(\{ queryKey: \['audit-workers'\] \}\)/,
  )
})

test('the re-audit bar is a sibling section, never a card nested in the table', async () => {
  const source = await webSource('pages/AuditMonitorPage.tsx')
  const bar = /<section className="content-section reaudit-bar">[\s\S]*?<\/section>/.exec(
    source,
  )?.[0]
  assert.ok(bar, 're-audit bar must be its own top-level section')
  assert.equal(/data-table|metric-card|content-section/.test(
    bar.slice(bar.indexOf('>')),
  ), false)
  // It opens before the audited table, not inside it.
  assert.ok(
    source.indexOf('reaudit-bar') <
      source.indexOf('<section className="data-table content-section audit-table">'),
  )
})

test('the re-audit bar stays responsive and stable at narrow widths', async () => {
  const styles = await readFile(path.join(WEB_ROOT, 'styles.css'), 'utf8')
  assert.match(styles, /\.reaudit-bar \{[\s\S]*?grid-template-columns:[\s\S]*?\}/)
  assert.match(styles, /@media \(max-width: 900px\) \{[\s\S]*?\.reaudit-bar \{/)
  // A fixed minimum height keeps the row from jumping as messages appear.
  assert.match(styles, /\.reaudit-bar \{[\s\S]*?min-height: 78px;/)
  assert.match(styles, /\.select-cell \{/)
  assert.match(styles, /\.reaudit-actions \{/)
})
