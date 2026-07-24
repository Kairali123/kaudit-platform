import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildDashboard, type RawMetrics } from './metrics.ts'

const full: RawMetrics = {
  calls: 43245,
  recordingArtifacts: 43245,
  withSourceUrl: 16371,
  withBaseline: 0,
  everVerified: 0,
  evidenceObjects: 43705,
  ingestionBatches: 5,
  ingestionCompleted: 5,
  users: 7,
  findings: [],
  generatedAt: '2026-07-24T10:00:00Z',
}

test('builds tiles from full metrics', () => {
  const v = buildDashboard(full)
  assert.equal(v.reachable, true)
  const byLabel = Object.fromEntries(v.tiles.map((t) => [t.label, t]))
  assert.equal(byLabel['Calls ingested'].value, (43245).toLocaleString('en-IN'))
  assert.equal(byLabel['Recordings referenced'].status, 'good')
  assert.match(byLabel['Recordings referenced'].sub ?? '', /% of/)
  assert.equal(byLabel['Integrity findings'].status, 'good') // none detected
  assert.equal(byLabel['Integrity findings'].value, '0')
})

test('null metrics render as pending, not fabricated', () => {
  const empty: RawMetrics = {
    calls: null, recordingArtifacts: null, withSourceUrl: null, withBaseline: null,
    everVerified: null, evidenceObjects: null, ingestionBatches: null,
    ingestionCompleted: null, users: null, findings: [], generatedAt: 't',
  }
  const v = buildDashboard(empty)
  assert.equal(v.reachable, false)
  const users = v.tiles.find((t) => t.label === 'Users provisioned')
  assert.equal(users?.value, '—')
  assert.equal(users?.status, 'pending')
})

test('integrity findings warn when anomalies are present', () => {
  const v = buildDashboard({ ...full, findings: [{ action: 'evidence_source_missing', n: 12 }] })
  const f = v.tiles.find((t) => t.label === 'Integrity findings')
  assert.equal(f?.value, '12')
  assert.equal(f?.status, 'warn')
})
