import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

/**
 * Static contract between the audit-monitor API and the page that renders it.
 *
 * The project has no browser test runner, so this pins what a render test
 * would otherwise catch about billing authority: the financial tile reads the
 * capped auditor amount, reports priced and missing-duration audited calls as
 * two separate numbers, and does not calculate money in the browser.
 *
 * No fixture, identifier, or amount in this file comes from real data.
 */

const WEB_ROOT = path.resolve(import.meta.dirname, '../../apps/web/src')

async function webSource(relative: string): Promise<string> {
  return readFile(path.join(WEB_ROOT, relative), 'utf8')
}

test('the web client type exposes capped amount and missing-duration counts', async () => {
  const source = await webSource('lib/api.ts')
  assert.match(source, /auditorFinalChargeInr: string/)
  assert.match(source, /auditorFinalPricedCalls: number/)
  assert.match(source, /auditorUnfinalizedCalls: number/)
  // The blended field is gone, so no caller can read a mixed-authority total.
  assert.equal(/auditorChargeInr\b/.test(source), false)
  assert.equal(/auditorCalculatedCalls\b/.test(source), false)
})

test('the financial tile is labelled as capped auditor money', async () => {
  const source = await webSource('pages/AuditMonitorPage.tsx')
  assert.match(source, /label: 'Auditor capped amount · audited calls'/)
  assert.match(source, /value: money\(financials\.auditorFinalChargeInr\)/)
  assert.match(source, /capped at KServe charge/)
})

test('the tile reports priced and missing-duration audited calls distinctly', async () => {
  const source = await webSource('pages/AuditMonitorPage.tsx')
  assert.match(source, /financials\.auditorFinalPricedCalls\.toLocaleString/)
  assert.match(source, /financials\.auditorUnfinalizedCalls\.toLocaleString/)
  assert.match(source, /missing audited duration/)
  // A missing-duration audited call is an open item, not a priced one.
  assert.match(
    source,
    /financials\.auditorUnfinalizedCalls === 0\s*\n?\s*\?\s*'good'\s*\n?\s*:\s*'warn'/,
  )
})

test('supporting copy states the per-call cap', async () => {
  const source = await webSource('pages/AuditMonitorPage.tsx')
  assert.match(
    source,
    /caps\s*\n?\s*each call at KServe/,
  )
})

test('no audited duration is formatted as money anywhere on the page', async () => {
  const source = await webSource('pages/AuditMonitorPage.tsx')
  const durationFields = [
    'recordedDurationMs',
    'speechDurationMs',
    'conversationEndMs',
    'graceAdjustedDurationMs',
    'vendorConnectedDurationMs',
    'varianceDurationMs',
  ]
  for (const field of durationFields) {
    assert.equal(
      new RegExp(`money\\([^)]*${field}`).test(source),
      false,
      `${field} must never be rendered as a currency amount`,
    )
  }
})

test('Task ID search is exact, submitted deliberately, and clearable', async () => {
  const source = await webSource('pages/AuditMonitorPage.tsx')
  assert.match(source, /placeholder="Exact Task ID"/)
  assert.match(source, /onSubmit=\{applyTaskSearch\}/)
  assert.match(source, /\.\.\.\(taskId \? \{ taskId \} : \{\}\)/)
  assert.match(source, /setPendingPage\(1\)/)
  assert.match(source, /setNoRecordingPage\(1\)/)
  assert.match(source, /aria-label="Search exact Task ID"/)
  assert.match(source, /aria-label="Clear Task ID search"/)
  assert.match(source, /No audited call matches this Task ID/)
  assert.match(source, /No pending call matches this Task ID/)
  assert.match(source, /No no-recording call matches this Task ID/)
})

test('pending queue displays the exact recording URL with a safe link', async () => {
  const api = await webSource('lib/api.ts')
  const page = await webSource('pages/AuditMonitorPage.tsx')
  assert.match(api, /recordingUrl\?: string/)
  assert.match(page, /<th>Recording URL<\/th>/)
  assert.match(page, /\{row\.recordingUrl\}/)
  assert.match(page, /parsed\.protocol === 'https:'/)
  assert.match(page, /target="_blank"/)
  assert.match(page, /rel="noreferrer"/)
})
