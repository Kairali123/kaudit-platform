import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

/**
 * Static contract between the audit-monitor API and the page that renders it.
 *
 * The project has no browser test runner, so this pins what a render test
 * would otherwise catch about billing authority: the financial tile reads the
 * final-calculation total, it shows finalized and unfinalized audited calls as
 * two separate numbers, and it never presents an audited duration projection
 * as auditor money.
 *
 * No fixture, identifier, or amount in this file comes from real data.
 */

const WEB_ROOT = path.resolve(import.meta.dirname, '../../apps/web/src')

async function webSource(relative: string): Promise<string> {
  return readFile(path.join(WEB_ROOT, relative), 'utf8')
}

test('the web client type exposes final and unfinalized counts separately', async () => {
  const source = await webSource('lib/api.ts')
  assert.match(source, /auditorFinalChargeInr: string/)
  assert.match(source, /auditorFinalPricedCalls: number/)
  assert.match(source, /auditorUnfinalizedCalls: number/)
  // The blended field is gone, so no caller can read a mixed-authority total.
  assert.equal(/auditorChargeInr\b/.test(source), false)
  assert.equal(/auditorCalculatedCalls\b/.test(source), false)
})

test('the financial tile is labelled as final deterministic billing', async () => {
  const source = await webSource('pages/AuditMonitorPage.tsx')
  assert.match(source, /label: 'Auditor final billing · audited calls'/)
  assert.match(source, /value: money\(financials\.auditorFinalChargeInr\)/)
  assert.match(source, /current final billing calculation/)
  assert.match(source, /deterministic billing engine only, never a model projection/)
})

test('the tile reports finalized and unfinalized audited calls distinctly', async () => {
  const source = await webSource('pages/AuditMonitorPage.tsx')
  assert.match(source, /financials\.auditorFinalPricedCalls\.toLocaleString/)
  assert.match(source, /financials\.auditorUnfinalizedCalls\.toLocaleString/)
  assert.match(source, /not finalized, releasing no auditor charge/)
  // An unfinalized audited call is an open item, not a settled one.
  assert.match(
    source,
    /financials\.auditorUnfinalizedCalls === 0\s*\n?\s*\?\s*'good'\s*\n?\s*:\s*'warn'/,
  )
})

test('supporting copy separates final billing money from duration metadata', async () => {
  const source = await webSource('pages/AuditMonitorPage.tsx')
  assert.match(source, /release no auditor charge and are counted separately/)
  assert.match(
    source,
    /duration\s*\n?\s*columns below are audit metadata for review—they are not a charge/,
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
