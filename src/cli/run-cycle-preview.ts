import fs from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import mysql from 'mysql2/promise'
import { loadRuntimeConfig } from '../config/runtime.ts'
import {
  buildCyclePreviewRow,
  sumCyclePreview,
} from '../reporting/cyclePreview.ts'
import {
  collectCyclePreviewInputs,
  persistProvisionalReconciliation,
} from '../adapters/mysqlCyclePreview.ts'
import { parseBillingMonth } from '../reporting/billingMonth.ts'

const month = process.env.KAUDIT_REPORT_MONTH?.trim()
if (!month) throw new Error('KAUDIT_REPORT_MONTH is required')
const period = parseBillingMonth(month)
if (!period) throw new Error('A specific billing month is required')
const outputRoot = path.resolve(
  process.env.KAUDIT_REPORT_OUTPUT?.trim() ||
    path.join(
      process.env.HOME || '.',
      '.kcrm-audit',
      'test-runs',
      `${period.month}-cycle-preview`,
    ),
)
const config = loadRuntimeConfig(process.env)
const ssl = config.database.sslCaFile
  ? {
      ca: fs.readFileSync(config.database.sslCaFile, 'utf8'),
      rejectUnauthorized: true,
    }
  : undefined
const pool = mysql.createPool({
  host: config.database.host,
  port: config.database.port,
  database: config.database.name,
  user: config.database.user,
  password: config.database.password,
  ssl,
  connectionLimit: 2,
})

try {
  const inputs = await collectCyclePreviewInputs(pool, period)
  const rows = inputs.map(buildCyclePreviewRow)
  const totals = sumCyclePreview(rows)
  const [invoiceRows] = await pool.execute<any[]>(
    `SELECT invoice_number, CAST(subtotal_amount AS CHAR) AS subtotal,
            CAST(tax_amount AS CHAR) AS tax,
            CAST(total_amount AS CHAR) AS total
     FROM kaudit_invoice
     WHERE period_start = ? AND period_end = ?
     ORDER BY revision_no DESC, created_at DESC LIMIT 1`,
    [period.start, period.end],
  )
  const payload = {
    schemaVersion: '1',
    authority: 'PROVISIONAL_UNCALIBRATED_TEST_ONLY',
    warning:
      'Not an authoritative bill or vendor dispute. Five AI results have not been calibrated against ground truth.',
    period,
    generatedAt: new Date().toISOString(),
    invoice: invoiceRows[0] ?? null,
    counts: {
      calls: rows.length,
      independentlyAudited: rows.filter(
        (row) =>
          row.auditResolution === 'provisional_ai_uncalibrated',
      ).length,
      acceptedAsBilledUnverified: rows.filter(
        (row) =>
          row.auditResolution === 'accepted_as_billed_unverified',
      ).length,
    },
    totals,
    rows,
  }
  await mkdir(outputRoot, { recursive: true, mode: 0o700 })
  const outputPath = path.join(
    outputRoot,
    `Kairali_${period.month}_Variance_PREVIEW.json`,
  )
  await writeFile(
    outputPath,
    `${JSON.stringify(payload, null, 2)}\n`,
    { mode: 0o600 },
  )
  let reconciliation: 'not_requested' | 'inserted' | 'duplicate' =
    'not_requested'
  if (process.env.KAUDIT_REPORT_PERSIST_PREVIEW === 'true') {
    const rateCardId =
      process.env.KAUDIT_REPORT_RATE_CARD_ID?.trim()
    if (!rateCardId) {
      throw new Error(
        'KAUDIT_REPORT_RATE_CARD_ID is required to persist a preview',
      )
    }
    reconciliation = await persistProvisionalReconciliation(
      pool,
      {
        period,
        rateCardId,
        createdBy:
          process.env.KAUDIT_REPORT_CREATED_BY?.trim() ||
          'system',
        inputs,
        rows,
        totals,
      },
    )
  }
  process.stdout.write(`${JSON.stringify({
    outputPath,
    authority: payload.authority,
    counts: payload.counts,
    invoice: payload.invoice,
    totals,
    reconciliation,
  }, null, 2)}\n`)
} finally {
  await pool.end()
}
