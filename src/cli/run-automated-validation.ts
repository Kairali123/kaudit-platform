import fs from 'node:fs'
import mysql from 'mysql2/promise'
import { loadRuntimeConfig } from '../config/runtime.ts'
import {
  collectAutomatedValidationCandidates,
  finalizeAutomatedFindingStates,
  loadPublishedRateCard,
  persistAutomatedValidation,
} from '../adapters/mysqlAutomatedValidation.ts'
import { createOpenAiConsensusReviewer } from '../adapters/openaiConsensus.ts'
import {
  evaluateAutomatedConsensus,
  AUTOMATED_VALIDATION_VERSION,
} from '../automation/consensus.ts'
import {
  mergeTranscriptSegments,
  validateClassification,
} from '../reaudit/core.ts'
import {
  createOpenAiReaudit,
  REAUDIT_CLASSIFIER_RULESET_SHA256,
} from '../adapters/openaiReaudit.ts'
import {
  REAUDIT_CLASSIFIER_RULESET_VERSION,
} from '../reaudit/core.ts'
import {
  canonicalJsonSha256,
  type JsonValue,
} from '../messaging/canonicalJson.ts'
import { calculateVerifiedKServeCharge } from '../billing/calculateVerifiedCharge.ts'
import { persistVerifiedBillingDecision } from '../adapters/mysqlVerifiedBilling.ts'
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
      finalBillingWritten: 0,
      unresolvedBillingWritten: 0,
      unresolvedReasons: {} as Record<string, number>,
    }
    for (const candidate of candidates) {
      const blocks = mergeTranscriptSegments(candidate.segments)
      const secondary = validateClassification(
        await reviewer.classify({
          blocks,
          language: candidate.language,
          recordedDurationMs: candidate.recordedDurationMs,
          speechDurationMs: candidate.speechDurationMs,
          connectedDurationMs: candidate.connectedDurationMs,
        }),
        blocks,
        candidate.recordedDurationMs,
      )
      let consensus = evaluateAutomatedConsensus({
        primary: candidate.primary,
        secondary,
        recordedDurationMs: candidate.recordedDurationMs,
      })
      let adjudication = null
      if (
        consensus.status === 'unresolved' &&
        consensus.reasons.length === 1 &&
        consensus.reasons[0] === 'CATEGORY_DISAGREEMENT'
      ) {
        adjudication = validateClassification(
          await adjudicator.classify({
            blocks,
            language: candidate.language,
            recordedDurationMs: candidate.recordedDurationMs,
            speechDurationMs: candidate.speechDurationMs,
            connectedDurationMs: candidate.connectedDurationMs,
            durationMismatch:
              candidate.connectedDurationMs != null &&
              Math.abs(
                candidate.connectedDurationMs -
                  candidate.recordedDurationMs,
              ) > 5_000,
          }),
          blocks,
          candidate.recordedDurationMs,
        )
        consensus = evaluateAutomatedConsensus({
          primary: candidate.primary,
          secondary,
          adjudicator: adjudication,
          recordedDurationMs: candidate.recordedDurationMs,
        })
      }
      if (consensus.status === 'accepted') summary.accepted += 1
      else {
        summary.unresolved += 1
        for (const reason of consensus.reasons) {
          summary.unresolvedReasons[reason] =
            (summary.unresolvedReasons[reason] || 0) + 1
        }
      }
      if (mode === 'DRY-RUN') continue

      const decidedAt = new Date().toISOString()
      await persistAutomatedValidation(pool, {
        candidate,
        secondary,
        adjudicator: adjudication,
        consensus,
        decidedAt,
      })
      const validationTraceSha256 = canonicalJsonSha256({
        version: consensus.version,
        threshold: consensus.threshold,
        primary: {
          model: candidate.primary.model,
          category: candidate.primary.category,
          confidence: candidate.primary.confidence,
          customerSpoke: candidate.primary.customerSpoke,
          lastMeaningfulCustomerExchangeMs:
            candidate.primary.lastMeaningfulCustomerExchangeMs,
          billableDurationMs: consensus.primaryBillableDurationMs,
        },
        secondary: {
          model: secondary.model,
          category: secondary.category,
          confidence: secondary.confidence,
          customerSpoke: secondary.customerSpoke,
          lastMeaningfulCustomerExchangeMs:
            secondary.lastMeaningfulCustomerExchangeMs,
          billableDurationMs: consensus.secondaryBillableDurationMs,
        },
        adjudicator: adjudication
          ? {
              model: adjudication.model,
              category: adjudication.category,
              confidence: adjudication.confidence,
              customerSpoke: adjudication.customerSpoke,
              lastMeaningfulCustomerExchangeMs:
                adjudication.lastMeaningfulCustomerExchangeMs,
              billableDurationMs:
                consensus.adjudicatorBillableDurationMs,
            }
          : null,
        outcome: {
          status: consensus.status,
          reasons: consensus.reasons,
        },
      } as unknown as JsonValue)
      const input = {
        callId: candidate.callId,
        auditRunId: candidate.auditRunId,
        claimedDurationMs: candidate.claimedDurationMs,
        connectedDurationMs: candidate.connectedDurationMs,
        recordedDurationMs: candidate.recordedDurationMs,
        speechDurationMs: candidate.speechDurationMs,
        conversationAssessment:
          consensus.selectedClassification?.customerSpoke
          ? ('established' as const)
          : ('no_meaningful_exchange' as const),
        lastMeaningfulCustomerExchangeMs:
          consensus.selectedClassification
            ?.lastMeaningfulCustomerExchangeMs ?? null,
        model:
          consensus.selectedClassification?.model ??
          candidate.primary.model,
        classifierRulesetVersion:
          REAUDIT_CLASSIFIER_RULESET_VERSION,
        classifierRulesetSha256:
          REAUDIT_CLASSIFIER_RULESET_SHA256,
        evidence: candidate.evidence,
        authority: {
          calibrationVersion: AUTOMATED_VALIDATION_VERSION,
          calibrationComplete: consensus.status === 'accepted',
          validationMethod: 'automated_consensus' as const,
          validationTraceSha256,
          confidence: consensus.effectiveConfidence,
          threshold: consensus.threshold,
          language: candidate.language,
          findingType:
            consensus.selectedClassification?.category ??
            candidate.primary.category,
          sensitivityTier: 'K0' as const,
          recheckAttempt: 1,
          maximumRechecks: 3,
        },
        calculatedAt: decidedAt,
      }
      const billing = calculateVerifiedKServeCharge(input, rateCard)
      await persistVerifiedBillingDecision(pool, {
        input,
        rateCard,
        result: billing,
        correlationId: null,
      })
      if (billing.status === 'final') {
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
