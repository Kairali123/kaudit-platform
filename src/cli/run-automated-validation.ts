import fs from 'node:fs'
import mysql from 'mysql2/promise'
import { loadRuntimeConfig } from '../config/runtime.ts'
import {
  collectAutomatedValidationCandidates,
  finalizeAutomatedFindingStates,
  loadPublishedRateCard,
} from '../adapters/mysqlAutomatedValidation.ts'
import { createOpenAiConsensusReviewer } from '../adapters/openaiConsensus.ts'
import { runAutomatedValidation } from '../automation/validationRun.ts'
import { createOpenAiReaudit } from '../adapters/openaiReaudit.ts'
import { parseBillingMonth } from '../reporting/billingMonth.ts'

function required(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`${name} is required`)
  return value
}

function integer(
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const value = Number(process.env[name] || fallback)
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be from ${minimum} to ${maximum}`)
  }
  return value
}

async function main(): Promise<void> {
  const mode = (
    process.env.KAUDIT_AUTO_VALIDATE_MODE?.trim() || 'DRY-RUN'
  ).toUpperCase()
  if (mode !== 'DRY-RUN' && mode !== 'EXECUTE') {
    throw new Error(
      'KAUDIT_AUTO_VALIDATE_MODE must be DRY-RUN or EXECUTE',
    )
  }
  const period = parseBillingMonth(
    required('KAUDIT_AUTO_VALIDATE_MONTH'),
  )
  if (!period) throw new Error('A specific billing month is required')
  const config = loadRuntimeConfig(process.env)
  // Both flags, always: mysql2 skips the hostname check unless `verifyIdentity`
  // is set, so a CA-only pool would accept any host holding any certificate the
  // configured authority ever issued.
  const ssl = config.database.sslCaFile
    ? {
        ca: fs.readFileSync(config.database.sslCaFile, 'utf8'),
        rejectUnauthorized: true,
        verifyIdentity: true,
      }
    : undefined
  const pool = mysql.createPool({
    host: config.database.host,
    port: config.database.port,
    database: config.database.name,
    user: config.database.user,
    password: config.database.password,
    ssl,
    connectionLimit: 3,
  })
  try {
    const rateCard = await loadPublishedRateCard(
      pool,
      required('KAUDIT_AUTO_VALIDATE_RATE_CARD_ID'),
    )
    const candidates = await collectAutomatedValidationCandidates(
      pool,
      {
        start: period.start,
        end: period.end,
        limit: integer('KAUDIT_AUTO_VALIDATE_BATCH', 10, 1, 100),
      },
    )
    const reviewer = createOpenAiConsensusReviewer(
      required('OPENAI_API_KEY'),
    )
    const adjudicator = createOpenAiReaudit(
      required('OPENAI_API_KEY'),
    )
    const summary = {
      mode,
      month: period.month,
      selected: candidates.length,
      accepted: 0,
      unresolved: 0,
      // In DRY-RUN these count what EXECUTE would write; nothing is written.
      finalBillingWritten: 0,
      unresolvedBillingWritten: 0,
      unresolvedReasons: {} as Record<string, number>,
    }
    for (const candidate of candidates) {
      const outcome = await runAutomatedValidation(pool, {
        candidate,
        reviewer,
        adjudicator,
        rateCard,
        correlationId: null,
        decidedAt: new Date().toISOString(),
        // DRY-RUN pays for the same second (and, for a lone category
        // disagreement, third) opinion and computes the same outcome; it
        // simply writes none of it.
        dryRun: mode === 'DRY-RUN',
      })
      if (outcome.status === 'accepted') summary.accepted += 1
      else {
        summary.unresolved += 1
        for (const reason of outcome.reasons) {
          summary.unresolvedReasons[reason] =
            (summary.unresolvedReasons[reason] || 0) + 1
        }
      }
      if (outcome.billingStatus === 'final') {
        summary.finalBillingWritten += 1
      } else {
        summary.unresolvedBillingWritten += 1
      }
    }
    const findingStates =
      mode === 'EXECUTE'
        ? await finalizeAutomatedFindingStates(pool, period)
        : {
            confirmed: 0,
            rejected: 0,
            insertedReplacement: 0,
          }
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`)
    if (mode === 'EXECUTE') {
      process.stdout.write(
        `${JSON.stringify({ findingStates }, null, 2)}\n`,
      )
    }
  } finally {
    await pool.end()
  }
}

main().catch((error) => {
  process.stderr.write(
    `[automated-validation] stopped: ${String(
      (error as Error)?.message || error,
    ).slice(0, 500)}\n`,
  )
  process.exitCode = 1
})
