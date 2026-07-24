import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderDashboard } from './render.ts'
import { buildDashboard, type RawMetrics } from './metrics.ts'

const m: RawMetrics = {
  calls: 43245, recordingArtifacts: 43245, withSourceUrl: 16371, withBaseline: 0,
  everVerified: 0, evidenceObjects: 43705, ingestionBatches: 5, ingestionCompleted: 5,
  users: 7, findings: [{ action: 'evidence_source_missing', n: 3 }], generatedAt: '2026-07-24T10:00:00Z',
}

test('renders a self-contained HTML page with real tiles + caveat', () => {
  const html = renderDashboard(buildDashboard(m))
  assert.match(html, /^<!doctype html>/)
  assert.ok(html.includes('Calls ingested'))
  assert.ok(html.includes((16371).toLocaleString('en-IN')))
  assert.ok(html.includes('Read-only monitoring'))
  assert.ok(html.includes('evidence_source_missing')) // findings table row
})

test('page is safe: no scripts and no external requests', () => {
  const html = renderDashboard(buildDashboard(m))
  assert.ok(!html.includes('<script'))
  assert.ok(!html.includes('http://'))
  assert.ok(!html.includes('https://'))
})

test('escapes values (no raw HTML injection from finding names)', () => {
  const html = renderDashboard(buildDashboard({ ...m, findings: [{ action: '<b>x</b>', n: 1 }] }))
  assert.ok(!html.includes('<b>x</b>'))
  assert.ok(html.includes('&lt;b&gt;x&lt;/b&gt;'))
})
