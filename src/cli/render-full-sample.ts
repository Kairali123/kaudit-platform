import { writeFileSync } from 'node:fs'
import { sampleFullRaw } from '../fixtures/fullDashboardSample.ts'
import { buildFullDashboard } from '../ui/fullDashboard.ts'
import { renderFullDashboard } from '../ui/fullRender.ts'

const output = process.argv[2] || 'dashboard-sample.html'
writeFileSync(output, renderFullDashboard(buildFullDashboard(sampleFullRaw)), 'utf8')
console.log(`[dashboard] wrote static aggregate preview → ${output}`)
