import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderFullDashboard } from './fullRender.ts'
import { buildFullDashboard } from './fullDashboard.ts'
import { sampleFullRaw } from '../fixtures/fullDashboardSample.ts'

test('renders all requested sections with visible gates', () => {
  const html = renderFullDashboard(buildFullDashboard(sampleFullRaw))
  for (const text of [
    'Calls & evidence',
    'Findings & quality',
    'Billing & revenue',
    'Revenue snapshots',
    'ACCESS CONTROL NOT YET ENFORCED',
    'Pending formal rate-card approval',
    'Accuracy has not been measured',
    'provisional',
  ]) {
    assert.ok(html.includes(text), `missing: ${text}`)
  }
})

test('renders no scripts, external requests, or raw call-content affordance', () => {
  const html = renderFullDashboard(buildFullDashboard(sampleFullRaw))
  assert.ok(!html.includes('<script'))
  assert.ok(!html.includes('http://'))
  assert.ok(!html.includes('https://'))
  assert.ok(!html.includes('audio controls'))
  assert.ok(!html.includes('transcript text'))
})

test('escapes database-derived labels', () => {
  const raw = structuredClone(sampleFullRaw)
  raw.quality.topFindings[0].code = '<img src=x onerror=alert(1)>'
  const html = renderFullDashboard(buildFullDashboard(raw))
  assert.ok(!html.includes('<img src=x'))
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'))
})
