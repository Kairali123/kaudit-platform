import fs from 'node:fs'
import mysql from 'mysql2/promise'
import { loadRuntimeConfig } from '../config/runtime.ts'
import {
  createMysqlCallAuditControlRepository,
  DEFAULT_PERIOD_TIMEZONE,
  RUN_TYPES,
  type CallAuditRunType,
} from '../adapters/mysqlCallAuditControl.ts'
import { createMysqlCallAuditPersistenceRepository } from '../adapters/mysqlCallAuditPersistence.ts'
import { createMysqlCallAuditSourceReader } from '../adapters/mysqlCallAuditSource.ts'
import { createMysqlCallAuditSettingsRepository } from '../adapters/mysqlCallAuditSettings.ts'
import { createOpenAiCallAuditModel } from '../adapters/openaiCallAuditClient.ts'
import {
  runCallAuditBatch,
  CallAuditBatchRunError,
  type CallAuditBatchRunSummary,
} from '../callaudit/batchRunner.ts'
import type { ActivatedContentAuditModel } from '../adapters/openaiCallAuditModel.ts'

/**
 * ONE-SHOT operator entry point for a Call Audit batch.
 *
 * It exists to do one thing: build the real MySQL repositories and the real
 * OpenAI-backed model, hand them to `runCallAuditBatch`, print the safe summary,
 * and exit. Every decision about what a run means already lives elsewhere —
 * the run's identity in the control repository, the period grammar in the source
 * query contract, the audit itself in the processor — and none of it is restated
 * here. This file owns process concerns only: environment, a pool, a clock, one
 * line of stdout, and an exit code.
 *
 * Scheduling is deliberately absent, and stays absent. There is no loop, no
 * poll, no cron cadence, no watch mode, and no timezone conversion: the calendar
 * period and the source window both arrive from the operator, already expressed,
 * exactly as the orchestrator requires. A run happens because a person ran this
 * command once.
 *
 * Spend and writes are gated by an explicit, deny-by-default mode. Anything but
 * the exact word `EXECUTE` stops before a pool is opened, before a paid model
 * client exists, and before the orchestrator is called, so a mistyped command
 * cannot cost money or write an audit result.
 *
 * Privacy boundary, inherited and not weakened. The activated business prompt
 * passes through this file to the model and is never printed, hashed, or copied
 * elsewhere. Nothing here reads a transcript, a lead identity, or a source free
 * text field, and no thrown value is ever inspected, formatted, or written: a
 * pool, a driver, a repository, or a provider can all quote their input in an
 * error, so failures are reported as bounded machine codes chosen in this file.
 *
 * Billing boundary. Call Audit is separate from Billing Audit: nothing here
 * reads, derives, or reports a chargeable figure.
 *
 * Source-table safety: `ai_voice_leads_received` is external and READ-ONLY. The
 * only thing that touches it is the accepted source reader, which SELECTs.
 */

// ---------------------------------------------------------------------------
// Environment names
// ---------------------------------------------------------------------------

/**
 * Every input is named, explicit, and read only here. There is no positional
 * argument parsing and no inferred default for anything that decides which
 * calls get audited: a wrong period is expensive and hard to notice afterwards.
 */
const ENV = {
  mode: 'KAUDIT_CALL_AUDIT_BATCH_MODE',
  apiKey: 'OPENAI_API_KEY',
  runType: 'KAUDIT_CALL_AUDIT_RUN_TYPE',
  periodStart: 'KAUDIT_CALL_AUDIT_PERIOD_START',
  periodEndExclusive: 'KAUDIT_CALL_AUDIT_PERIOD_END_EXCLUSIVE',
  periodTimezone: 'KAUDIT_CALL_AUDIT_PERIOD_TIMEZONE',
  windowStart: 'KAUDIT_CALL_AUDIT_SOURCE_START',
  windowEndExclusive: 'KAUDIT_CALL_AUDIT_SOURCE_END_EXCLUSIVE',
  idempotencyKey: 'KAUDIT_CALL_AUDIT_IDEMPOTENCY_KEY',
  batchSize: 'KAUDIT_CALL_AUDIT_BATCH_SIZE',
  maxPages: 'KAUDIT_CALL_AUDIT_MAX_PAGES',
  maxCandidates: 'KAUDIT_CALL_AUDIT_MAX_CANDIDATES',
  correlationId: 'KAUDIT_CALL_AUDIT_CORRELATION_ID',
  triggeredBy: 'KAUDIT_CALL_AUDIT_TRIGGERED_BY',
} as const

/** The one word that arms writes and model spend. Compared exactly. */
const EXECUTE_MODE = 'EXECUTE'

/**
 * Rows per page when the operator does not say. Small on purpose: the first
 * thing an unattended mistake costs is one page of paid model calls, and a
 * larger default would make that first page more expensive.
 */
const DEFAULT_BATCH_SIZE = 25

// ---------------------------------------------------------------------------
// Failure vocabulary
// ---------------------------------------------------------------------------

/**
 * Every way this entry point can stop, as bounded uppercase machine codes.
 *
 * A code names a STAGE of startup, never an underlying fault, for the same
 * reason the orchestrator codes phases: a stage is safe to print, and a driver,
 * repository, or provider message is not. `runCallAuditBatch` supplies its own
 * codes for anything past this point and they are passed through unchanged.
 */
const BATCH_CLI_ERROR_CODES = {
  /** The execute gate was not armed. Raised before anything is built. */
  modeNotExecute: 'CALL_AUDIT_BATCH_MODE_NOT_EXECUTE',
  /** A required named input was absent or blank. */
  missingInput: 'CALL_AUDIT_BATCH_MISSING_INPUT',
  /** A named input was present but not of the shape this file parses. */
  invalidInput: 'CALL_AUDIT_BATCH_INVALID_INPUT',
  /** Runtime configuration or the connection pool could not be built. */
  configUnavailable: 'CALL_AUDIT_BATCH_CONFIG_UNAVAILABLE',
  /** The active rule version could not be read. */
  ruleReadFailed: 'CALL_AUDIT_BATCH_RULE_READ_FAILED',
  /** No rule version is active, so no contract governs an audit. */
  noActiveRule: 'CALL_AUDIT_BATCH_NO_ACTIVE_RULE',
  /** An active rule version exists but its detail row does not. */
  activeRuleDetailMissing: 'CALL_AUDIT_BATCH_ACTIVE_RULE_DETAIL_MISSING',
  /** The model credential was absent or blank at the point it was needed. */
  modelNotConfigured: 'CALL_AUDIT_BATCH_MODEL_NOT_CONFIGURED',
  /** The model client could not be constructed. */
  modelInitFailed: 'CALL_AUDIT_BATCH_MODEL_INIT_FAILED',
  /** The orchestrator raised rather than settling the run. */
  runNotSettled: 'CALL_AUDIT_BATCH_RUN_NOT_SETTLED',
  /** Anything else. Deliberately opaque: the thrown value is never read. */
  unexpected: 'CALL_AUDIT_BATCH_UNEXPECTED_FAILURE',
} as const

/**
 * The only error this file raises.
 *
 * It carries a bounded code and, for an input mistake, the NAME of the
 * environment variable at fault — never its value. A name is configuration, so
 * printing it helps the operator; a value could be an identifier, a boundary, or
 * a credential, so no value is ever attached.
 */
class CallAuditBatchCliError extends Error {
  readonly code: string
  readonly field: string | null

  constructor(code: string, field: string | null = null) {
    super(code)
    this.code = code
    this.field = field
  }
}

// ---------------------------------------------------------------------------
// Named input parsing
// ---------------------------------------------------------------------------

/**
 * Presence only. The grammar of a period boundary, an id, or a zone belongs to
 * the modules that already enforce it, so nothing is reformatted, widened, or
 * coerced on the way through — the operator's text reaches the validator that
 * owns it.
 */
function requiredText(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) {
    throw new CallAuditBatchCliError(
      BATCH_CLI_ERROR_CODES.missingInput,
      name,
    )
  }
  return value
}

function optionalText(name: string): string | null {
  return process.env[name]?.trim() || null
}

/** A positive integer, or the fallback when unset. Ceilings belong downstream. */
function optionalPositiveInteger(
  name: string,
  fallback: number | null,
): number | null {
  const raw = process.env[name]?.trim()
  if (!raw) return fallback
  if (!/^[1-9][0-9]*$/.test(raw)) {
    throw new CallAuditBatchCliError(
      BATCH_CLI_ERROR_CODES.invalidInput,
      name,
    )
  }
  const value = Number(raw)
  if (!Number.isSafeInteger(value)) {
    throw new CallAuditBatchCliError(
      BATCH_CLI_ERROR_CODES.invalidInput,
      name,
    )
  }
  return value
}

/**
 * Checks the run type against the control repository's own vocabulary rather
 * than a copy of it, so this file can never accept a type the run row would
 * reject or refuse one it would take.
 */
function requiredRunType(): CallAuditRunType {
  const value = requiredText(ENV.runType)
  if (!(RUN_TYPES as readonly string[]).includes(value)) {
    throw new CallAuditBatchCliError(
      BATCH_CLI_ERROR_CODES.invalidInput,
      ENV.runType,
    )
  }
  return value as CallAuditRunType
}

/**
 * The UTC-naive stamp form the result records and run columns accept.
 * `toISOString` is already UTC, so trimming the marker and the trailing `Z`
 * converts nothing: it only drops the notation the columns do not carry.
 */
function utcNaiveNow(): string {
  return new Date().toISOString().replace('T', ' ').slice(0, 23)
}

// ---------------------------------------------------------------------------
// Safe output
// ---------------------------------------------------------------------------

/**
 * Projects the run summary onto stdout, field by field.
 *
 * An explicit allowlist, never a spread of the summary object: if the
 * orchestrator's summary ever grows a field, this line does not, so a new value
 * cannot reach an operator's terminal, log scrape, or ticket by accident. Every
 * field below is an id, a closed enum value, a bounded machine code, or a count.
 */
function safeSummaryLine(summary: CallAuditBatchRunSummary): string {
  return `${JSON.stringify({
    runId: summary.runId,
    runCreateOutcome: summary.runCreateOutcome,
    terminalStatus: summary.terminalStatus,
    failureCode: summary.failureCode,
    stopReason: summary.stopReason,
    pagesRead: summary.pagesRead,
    candidatesSelected: summary.candidatesSelected,
    candidatesProcessed: summary.candidatesProcessed,
    counts: {
      processedTotal: summary.counts.processedTotal,
      succeededTotal: summary.counts.succeededTotal,
      failedTotal: summary.counts.failedTotal,
      skippedTotal: summary.counts.skippedTotal,
      operationalOnlyTotal: summary.counts.operationalOnlyTotal,
      contentAuditedTotal: summary.counts.contentAuditedTotal,
    },
  })}\n`
}

/**
 * Chooses the bounded code for a stopped run WITHOUT reading the thrown value.
 *
 * Only two shapes are recognised, and both are types this repository defines
 * with a documented bounded code. Everything else — a driver error, a provider
 * body, a plain string — is reported as one opaque code, because the only way to
 * guarantee nothing leaks is to never look.
 */
function safeFailureCode(error: unknown): string {
  if (error instanceof CallAuditBatchCliError) return error.code
  if (error instanceof CallAuditBatchRunError) return error.code
  return BATCH_CLI_ERROR_CODES.unexpected
}

/** The offending input NAME, when the failure was an input mistake. */
function safeFailureField(error: unknown): string | null {
  return error instanceof CallAuditBatchCliError ? error.field : null
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

async function main(): Promise<CallAuditBatchRunSummary> {
  // The gate, first and unconditionally. Nothing below this line runs for a
  // command that did not ask to execute: no pool, no credential read, no model
  // client, no run row. The raw value is compared byte for byte — no trim, no
  // case fold, no fallback — so `execute`, `true`, an unset variable, or a
  // stray space is a refusal rather than a costly near-miss. Every other input
  // is still trimmed; consent is the one thing that is not tidied up on the
  // operator's behalf.
  if (process.env[ENV.mode] !== EXECUTE_MODE) {
    throw new CallAuditBatchCliError(BATCH_CLI_ERROR_CODES.modeNotExecute)
  }

  // Named inputs next, still before any connection: an operator who forgot a
  // boundary learns it without a database round trip or a run row.
  const runType = requiredRunType()
  const periodStart = requiredText(ENV.periodStart)
  const periodEndExclusive = requiredText(ENV.periodEndExclusive)
  const periodTimezone =
    optionalText(ENV.periodTimezone) ?? DEFAULT_PERIOD_TIMEZONE
  const windowStart = requiredText(ENV.windowStart)
  const windowEndExclusive = requiredText(ENV.windowEndExclusive)
  // Never minted here. A generated key would make every re-run a NEW run, so a
  // repeated command would pay to audit the same period twice instead of
  // replaying the run it already created.
  const idempotencyKey = requiredText(ENV.idempotencyKey)
  const correlationId = optionalText(ENV.correlationId)
  const triggeredBy = optionalText(ENV.triggeredBy)
  const batchSize =
    optionalPositiveInteger(ENV.batchSize, DEFAULT_BATCH_SIZE) ??
    DEFAULT_BATCH_SIZE
  const maxPages = optionalPositiveInteger(ENV.maxPages, null)
  const maxCandidates = optionalPositiveInteger(ENV.maxCandidates, null)

  let config: ReturnType<typeof loadRuntimeConfig>
  let ssl: { ca: string; rejectUnauthorized: true } | undefined
  try {
    config = loadRuntimeConfig(process.env)
    ssl = config.database.sslCaFile
      ? {
          ca: fs.readFileSync(config.database.sslCaFile, 'utf8'),
          rejectUnauthorized: true,
        }
      : undefined
  } catch {
    // A configuration error can quote a value or a path.
    throw new CallAuditBatchCliError(
      BATCH_CLI_ERROR_CODES.configUnavailable,
    )
  }

  const pool = mysql.createPool({
    host: config.database.host,
    port: config.database.port,
    database: config.database.name,
    user: config.database.user,
    password: config.database.password,
    ssl,
    connectionLimit: 4,
    connectTimeout: 10_000,
    enableKeepAlive: true,
    // Fixed-precision columns stay exact strings; the activated temperature is
    // one of them and must reach the provider as stored.
    decimalNumbers: false,
  })

  try {
    const settings = createMysqlCallAuditSettingsRepository(pool)

    // The governing contract is whatever is ACTIVE in the database. This file
    // invents no prompt, model, or temperature: an audit that ran under settings
    // typed at a terminal would cite a rule version it did not actually use.
    let active: Awaited<ReturnType<typeof settings.getActiveRuleVersion>>
    let detail: Awaited<ReturnType<typeof settings.getRuleVersionDetail>>
    try {
      active = await settings.getActiveRuleVersion()
      detail = active
        ? await settings.getRuleVersionDetail(active.ruleVersionId)
        : null
    } catch {
      throw new CallAuditBatchCliError(BATCH_CLI_ERROR_CODES.ruleReadFailed)
    }
    if (!active) {
      throw new CallAuditBatchCliError(BATCH_CLI_ERROR_CODES.noActiveRule)
    }
    if (!detail) {
      throw new CallAuditBatchCliError(
        BATCH_CLI_ERROR_CODES.activeRuleDetailMissing,
      )
    }

    // Read only once the gate is armed and a real contract exists, so a
    // misconfigured command never even reaches for the credential.
    const apiKey = process.env[ENV.apiKey]?.trim()
    if (!apiKey) {
      throw new CallAuditBatchCliError(
        BATCH_CLI_ERROR_CODES.modelNotConfigured,
        ENV.apiKey,
      )
    }

    // Exactly the stored fields, passed straight through. The prompt travels
    // from this object into the model request and nowhere else.
    const activation: ActivatedContentAuditModel = {
      versionLabel: detail.versionLabel,
      businessPrompt: detail.businessPrompt,
      modelProvider: detail.modelProvider,
      modelName: detail.modelName,
      modelVersion: detail.modelVersion,
      temperature: detail.temperature,
    }

    let model
    try {
      model = createOpenAiCallAuditModel(apiKey)
    } catch {
      // The factory names a missing key; even so, nothing from it is echoed.
      throw new CallAuditBatchCliError(BATCH_CLI_ERROR_CODES.modelInitFailed)
    }

    return await runCallAuditBatch({
      request: {
        ruleVersionId: detail.ruleVersionId,
        runType,
        periodStart,
        periodEndExclusive,
        periodTimezone,
        idempotencyKey,
        correlationId,
        triggeredBy,
      },
      ruleVersionId: detail.ruleVersionId,
      activation,
      sourceWindow: {
        periodStart: windowStart,
        periodEndExclusive: windowEndExclusive,
      },
      batchSize,
      maxPages: maxPages ?? undefined,
      maxCandidates: maxCandidates ?? undefined,
      control: createMysqlCallAuditControlRepository(pool),
      source: createMysqlCallAuditSourceReader(pool),
      persistence: createMysqlCallAuditPersistenceRepository(pool),
      model,
      timestamps: { now: utcNaiveNow },
    })
  } finally {
    // Always, on either path: a leaked pool keeps the process alive after a
    // one-shot command has nothing left to do.
    await pool.end()
  }
}

main().then(
  (summary) => {
    process.stdout.write(safeSummaryLine(summary))
    // A settled-but-failed run is still a failure the operator must notice, and
    // an exit code is the only part of this a shell script reads.
    process.exitCode = summary.terminalStatus === 'completed' ? 0 : 1
  },
  (error: unknown) => {
    // Two bounded tokens and nothing else. The thrown value is never stringified,
    // logged, or inspected beyond the two typed shapes this file defines.
    const field = safeFailureField(error)
    process.stderr.write(
      `[call-audit-batch] stopped ${safeFailureCode(error)}${
        field ? ` field=${field}` : ''
      }\n`,
    )
    process.exitCode = 1
  },
)
