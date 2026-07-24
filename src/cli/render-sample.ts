import { writeFileSync } from 'node:fs'
import { buildDashboard, type RawMetrics } from '../ui/metrics.ts'
import { renderDashboard } from '../ui/render.ts'

// Writes a STATIC preview of the monitoring dashboard with representative numbers, so the
// look can be shown without a DB connection. The live `ui:monitor` server shows real data.
const sample: RawMetrics = {
  calls: 43245,
  recordingArtifacts: 43245,
  withSourceUrl: 16371,
  withBaseline: 0,
  everVerified: 0,
  evidenceObjects: 43705,
  ingestionBatches: 5,
  ingestionCompleted: 5,
  users: null, // pending migration 0003 + seed
  findings: [],
  generatedAt: new Date().toISOString() + ' (static preview — representative numbers)',
}

const out = process.argv[2] || 'monitor-sample.html'
writeFileSync(out, renderDashboard(buildDashboard(sample)), 'utf8')
console.log(`[monitor] wrote static preview → ${out} (open it in a browser)`)
