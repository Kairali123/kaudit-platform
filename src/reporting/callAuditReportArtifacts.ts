import PDFDocument from 'pdfkit'
import {
  CALL_AUDIT_REPORT_TITLE,
  periodLabel,
  sharePercent,
  type CallAuditReportDto,
} from './callAuditReport.ts'
import { KSERVE_AI_CALLER_NAME } from '../callaudit/types.ts'
import type { CallAuditReportCadence } from '../adapters/mysqlCallAuditReporting.ts'
import type { CallAuditRunStatus } from '../adapters/mysqlCallAuditControl.ts'

/**
 * Management / KServe artifacts for the Kserve Call Audit Report.
 *
 * This module turns an already-accepted {@link CallAuditReportDto} into the two
 * artifacts a management or KServe recipient receives: a self-contained escaped
 * HTML report (email body or `.html` attachment) and an A4 PDF, plus the
 * deterministic attachment metadata that names them.
 *
 * It is STRICTER than the browser DTO it reads. The browser drilldown is a
 * per-row surface behind an authenticated session; an artifact is a file that
 * leaves the platform, so this layer is AGGREGATE ONLY:
 *
 *   * `dto.results` is never read. Not filtered, not truncated, not summarised
 *     row by row — the array is not touched at all, so no Task ID, result id,
 *     run id, per-row company/source classification, per-row management, KServe,
 *     or improvement feedback, per-row score, or per-row timestamp can reach a
 *     file. Run progress is folded into anonymous totals with no run id, rule
 *     version, or per-run timestamp.
 *   * No transcript, prompt, raw or provider prose, model identity or setting,
 *     hash, URL, lead id, source row id, phone, email, or name is present on the
 *     DTO shapes this module copies, and none is derivable from what it renders.
 *   * No money. Call Audit never chooses, calculates, imports, or reports
 *     billing money, so there is no cost, price, amount, rate, currency,
 *     invoice, revenue, variance, or billed-minute field here, and this module
 *     imports no money formatter and no billing module. Token counts are audit
 *     reliability, never a cost basis: no per-token rate exists here to multiply
 *     them by.
 *
 * Absent stays distinct from zero: an unscored metric, an unknown share, an
 * unrecorded latency, an unknown run progress, and an empty period each render
 * as their own explicit state, never as a successful zero.
 *
 * Purity: building an artifact reads nothing but its argument. No database,
 * model, filesystem, email transport, scheduler, HTTP client, environment
 * variable, logger, clock, or persistence is touched. The single side effect is
 * PDFKit assembling a document in memory.
 */

// ---------------------------------------------------------------------------
// Bounds. The DTO is already bounded; these are the artifact's own ceiling, so
// a future DTO change cannot silently grow a file that gets emailed.
// ---------------------------------------------------------------------------

export const MAX_ARTIFACT_TILES = 16
export const MAX_ARTIFACT_SECTIONS = 24
export const MAX_ARTIFACT_SECTION_ROWS = 24
export const MAX_ARTIFACT_METRICS = 24
export const MAX_ARTIFACT_RELIABILITY_ROWS = 8
export const MAX_ARTIFACT_RUNS = 64

/** Longest rendered label or caption. Longer text is truncated, never dropped. */
export const MAX_ARTIFACT_TEXT_CHARS = 200

export const MAX_ARTIFACT_HTML_BYTES = 262_144
export const MAX_ARTIFACT_PDF_BYTES = 2_097_152

/** Filenames stay short enough for any mail client and any filesystem. */
export const MAX_ARTIFACT_FILENAME_CHARS = 120

export const CALL_AUDIT_HTML_MEDIA_TYPE = 'text/html; charset=utf-8'
export const CALL_AUDIT_PDF_MEDIA_TYPE = 'application/pdf'

/** Fixed filename stem. Never derived from a database or source value. */
export const CALL_AUDIT_ARTIFACT_FILENAME_STEM = 'kserve-call-audit'

/**
 * Restated on the artifact itself, because a file outlives its session and is
 * read without the platform beside it. The DTO's own boundary sentence is
 * deliberately NOT copied here: it names the very categories an artifact must
 * never mention, and a file that leaves the platform should not carry that
 * vocabulary at all.
 */
export const CALL_AUDIT_ARTIFACT_SCOPE =
  'Aggregate totals only. Individual audited calls, their identifiers, and ' +
  'their per-call notes are not included in this artifact. Raw evidence and ' +
  'audit configuration stay server-internal.'

/**
 * Call Audit is not the billing report, and an artifact recipient is told so in
 * writing. The wording deliberately names no commercial term at all, so the
 * disclaimer itself cannot be mistaken for a financial figure.
 */
export const CALL_AUDIT_ARTIFACT_QUALITY_ONLY_NOTE =
  'This is a quality audit of the conversations the AI caller handled. It ' +
  'reports no financial figure of any kind and is not a commercial or ' +
  'payment document.'

const CADENCES = [
  'daily',
  'monthly',
  'quarterly',
  'yearly',
] as const satisfies readonly CallAuditReportCadence[]

/**
 * Run statuses, restated locally so the artifact can group runs without loading
 * the control adapter at runtime. The status LABEL is resolved from this closed
 * vocabulary rather than copied from the run row: a run row is a per-row shape,
 * and an artifact must not be able to print text that arrived on one.
 */
const RUN_STATUS_LABELS: Record<CallAuditRunStatus, string> = {
  pending: 'Pending',
  running: 'Running',
  completed: 'Completed',
  failed: 'Failed',
  cancelled: 'Cancelled',
}

const TILE_STATUSES = ['good', 'warn', 'neutral', 'pending'] as const

const BOUNDARY_BASIS = 'utc_naive_half_open'

/**
 * The words an absent value renders as. They are words, not dashes: a report
 * that leaves the platform is read without the DTO beside it, and "0.0%" or a
 * bare dash in a share column is exactly the confusion this rule exists to
 * prevent. All three are plain ASCII so the PDF renders them unchanged.
 */
const NOT_SCORED = 'Not scored'
const NOT_RECORDED = 'Not recorded'
const UNKNOWN_SHARE = 'not determined'

// ---------------------------------------------------------------------------
// Errors. Field paths and closed reason codes only — never a rejected value.
// ---------------------------------------------------------------------------

export type CallAuditArtifactErrorCode =
  | 'INVALID_CALL_AUDIT_ARTIFACT_INPUT'
  | 'CALL_AUDIT_ARTIFACT_TOO_LARGE'

/**
 * Closed reason vocabulary. Every message is built from a field path and one of
 * these constants, so an error can never echo a transcript, an identifier, a
 * URL, or any other rejected value into a log or a response.
 */
export type CallAuditArtifactErrorReason =
  | 'is missing'
  | 'is not text'
  | 'is not a whole count'
  | 'is not a numeric string'
  | 'is not an accepted value'
  | 'is not a UTC-naive timestamp'
  | 'is not an ordered half-open period'
  | 'exceeds the artifact bound'

export class CallAuditArtifactError extends Error {
  readonly code: CallAuditArtifactErrorCode
  readonly field: string
  readonly reason: CallAuditArtifactErrorReason

  constructor(
    field: string,
    reason: CallAuditArtifactErrorReason,
    code: CallAuditArtifactErrorCode = 'INVALID_CALL_AUDIT_ARTIFACT_INPUT',
  ) {
    super(`${field}: ${reason}`)
    this.name = 'CallAuditArtifactError'
    this.code = code
    this.field = field
    this.reason = reason
  }
}

function fail(
  field: string,
  reason: CallAuditArtifactErrorReason,
  code?: CallAuditArtifactErrorCode,
): never {
  throw new CallAuditArtifactError(field, reason, code)
}

// ---------------------------------------------------------------------------
// Validation and normalisation of the fields this module is allowed to copy
// ---------------------------------------------------------------------------

const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g

/**
 * Bounded plain text. Control characters are stripped so neither an HTML
 * document nor a PDF content stream can carry an invisible payload, and the
 * result is truncated rather than rejected: an over-long label is a rendering
 * problem, not a reason to withhold a management report.
 */
function text(value: unknown, field: string): string {
  if (value === undefined || value === null) fail(field, 'is missing')
  if (typeof value !== 'string') fail(field, 'is not text')
  const cleaned = value.replace(CONTROL_CHARS, '').trim()
  return cleaned.length > MAX_ARTIFACT_TEXT_CHARS
    ? `${cleaned.slice(0, MAX_ARTIFACT_TEXT_CHARS - 3)}...`
    : cleaned
}

function optionalText(value: unknown, field: string): string | null {
  return value === null || value === undefined ? null : text(value, field)
}

function whole(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    fail(field, 'is not a whole count')
  }
  return value
}

const NUMERIC_STRING = /^-?\d{1,20}(\.\d{1,6})?$/

/** A fixed-precision decimal that arrived as a string, kept exactly as given. */
function numericString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !NUMERIC_STRING.test(value)) {
    fail(field, 'is not a numeric string')
  }
  return value
}

function optionalNumericString(
  value: unknown,
  field: string,
): string | null {
  return value === null || value === undefined
    ? null
    : numericString(value, field)
}

const NAIVE_TIMESTAMP =
  /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})(\.\d{1,6})?$/

/**
 * A UTC-naive literal, verified against the Gregorian calendar. A trailing `Z`
 * or numeric offset fails the pattern rather than being converted, so a period
 * boundary can never silently shift by a timezone on its way into a filename.
 */
function naiveTimestamp(value: unknown, field: string): string {
  if (typeof value !== 'string') fail(field, 'is not a UTC-naive timestamp')
  const match = NAIVE_TIMESTAMP.exec(value)
  if (!match) fail(field, 'is not a UTC-naive timestamp')
  const [year, month, day, hour, minute, second] = match
    .slice(1, 7)
    .map(Number)
  const millis = Date.UTC(year, month - 1, day, hour, minute, second)
  const roundTrip = new Date(millis)
  if (
    roundTrip.getUTCFullYear() !== year ||
    roundTrip.getUTCMonth() + 1 !== month ||
    roundTrip.getUTCDate() !== day ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  ) {
    fail(field, 'is not a UTC-naive timestamp')
  }
  return value
}

const GENERATED_AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/

function generatedAtOf(value: unknown): string {
  if (typeof value !== 'string' || !GENERATED_AT.test(value)) {
    fail('generatedAt', 'is not a UTC-naive timestamp')
  }
  if (Number.isNaN(Date.parse(value))) {
    fail('generatedAt', 'is not a UTC-naive timestamp')
  }
  return value
}

function oneOf<Value extends string>(
  value: unknown,
  accepted: readonly Value[],
  field: string,
): Value {
  if (
    typeof value !== 'string' ||
    !(accepted as readonly string[]).includes(value)
  ) {
    fail(field, 'is not an accepted value')
  }
  return value as Value
}

function bounded<Item>(
  value: unknown,
  limit: number,
  field: string,
): readonly Item[] {
  if (!Array.isArray(value)) fail(field, 'is missing')
  if (value.length > limit) fail(field, 'exceeds the artifact bound')
  return value as readonly Item[]
}

// ---------------------------------------------------------------------------
// The aggregate-only model. Both artifacts render from this and nothing else.
// ---------------------------------------------------------------------------

export interface CallAuditArtifactBasis {
  cadence: CallAuditReportCadence
  cadenceLabel: string
  periodStart: string
  periodEndExclusive: string
  /** Recomputed from the validated boundaries, never copied from the DTO. */
  periodLabel: string
  boundaryBasis: typeof BOUNDARY_BASIS
  boundaryNote: string
  periodDefaulted: boolean
}

export interface CallAuditArtifactTile {
  label: string
  value: string
  sub: string
  status: (typeof TILE_STATUSES)[number]
}

export interface CallAuditArtifactBreakdownRow {
  label: string
  count: number
  /** Null when the section counted nothing: an unknown share is not 0.0%. */
  sharePercent: string | null
}

export interface CallAuditArtifactSection {
  key: string
  title: string
  caption: string
  total: number
  rows: CallAuditArtifactBreakdownRow[]
  emptyBucketCount: number
}

export interface CallAuditArtifactMetric {
  label: string
  weight: number
  scoredCount: number
  /** Explicitly reported; NA is never folded into a score of zero. */
  notApplicableCount: number
  /** Null when nothing was scored. Rendered as "Not scored", never as 0. */
  averageScore: string | null
  distribution: Array<{ score: 1 | 2 | 3 | 4 | 5; count: number }>
}

export interface CallAuditArtifactReliabilityRow {
  label: string
  attemptCount: number
  resultCount: number
  erroredCount: number
  totalTokens: string
  averageLatencyMs: string | null
}

export interface CallAuditArtifactReliability {
  attemptCount: number
  resultCount: number
  erroredCount: number
  maxAttemptNumber: number
  inputTokens: string
  outputTokens: string
  totalTokens: string
  averageLatencyMs: string | null
  maxLatencyMs: string | null
  byAttemptOutcome: CallAuditArtifactReliabilityRow[]
}

/**
 * Run progress with every identifying field folded away: no run id, no rule
 * version, no per-run period, timezone, or timestamp. What management needs is
 * how much of the period was processed, not which run did it.
 */
export interface CallAuditArtifactRunProgress {
  runCount: number
  byStatus: Array<{ label: string; count: number }>
  totalCandidates: number
  processedCount: number
  succeededCount: number
  failedCount: number
  skippedCount: number
  contentAuditableCount: number
  operationalOnlyCount: number
  /** Null when no candidates were claimed: unknown progress is never 100%. */
  progressPercent: string | null
  /** How many runs carry a machine error code. The code itself is not printed. */
  runsWithErrorCount: number
}

export interface CallAuditReportAggregate {
  title: typeof CALL_AUDIT_REPORT_TITLE
  aiCaller: typeof KSERVE_AI_CALLER_NAME
  aiCallerNote: string
  scopeNote: typeof CALL_AUDIT_ARTIFACT_SCOPE
  qualityOnlyNote: typeof CALL_AUDIT_ARTIFACT_QUALITY_ONLY_NOTE
  generatedAt: string
  basis: CallAuditArtifactBasis
  /** False when the period produced no result rows: an empty period, not a zero. */
  hasResults: boolean
  /** Present only when the period is empty, so the state is stated, not implied. */
  emptyStateNote: string | null
  resultCount: number
  auditedCallCount: number
  headline: CallAuditArtifactTile[]
  sections: CallAuditArtifactSection[]
  metrics: CallAuditArtifactMetric[]
  reliability: CallAuditArtifactReliability
  runs: CallAuditArtifactRunProgress
}

const EMPTY_STATE_NOTE =
  'No audited call result was recorded in this period. Every total below is ' +
  'reported as not determined rather than as a zero result.'

const BOUNDARY_NOTE =
  'Period boundaries are UTC-naive and half-open: the start instant is ' +
  'included and the end instant is excluded.'

function aiCallerNoteFor(): string {
  return (
    `Calls audited are the calls the AI caller ${KSERVE_AI_CALLER_NAME} ` +
    'handled. This report audits those conversations; it does not audit or ' +
    'identify any individual customer.'
  )
}

// ---------------------------------------------------------------------------
// DTO → aggregate model
// ---------------------------------------------------------------------------

function basisOf(dto: CallAuditReportDto): CallAuditArtifactBasis {
  const basis = dto.reportBasis
  if (!basis || typeof basis !== 'object') fail('reportBasis', 'is missing')
  const periodStart = naiveTimestamp(
    basis.periodStart,
    'reportBasis.periodStart',
  )
  const periodEndExclusive = naiveTimestamp(
    basis.periodEndExclusive,
    'reportBasis.periodEndExclusive',
  )
  if (periodEndExclusive <= periodStart) {
    fail('reportBasis.periodEndExclusive', 'is not an ordered half-open period')
  }
  if (basis.boundaryBasis !== BOUNDARY_BASIS) {
    fail('reportBasis.boundaryBasis', 'is not an accepted value')
  }
  if (typeof basis.periodDefaulted !== 'boolean') {
    fail('reportBasis.periodDefaulted', 'is not an accepted value')
  }
  return {
    cadence: oneOf(basis.cadence, CADENCES, 'reportBasis.cadence'),
    cadenceLabel: text(basis.cadenceLabel, 'reportBasis.cadenceLabel'),
    periodStart,
    periodEndExclusive,
    // Recomputed from the boundaries this module validated itself.
    periodLabel: periodLabel({ periodStart, periodEndExclusive }),
    boundaryBasis: BOUNDARY_BASIS,
    boundaryNote: BOUNDARY_NOTE,
    periodDefaulted: basis.periodDefaulted,
  }
}

function tilesOf(dto: CallAuditReportDto): CallAuditArtifactTile[] {
  const tiles = bounded<CallAuditReportDto['headline'][number]>(
    dto.headline,
    MAX_ARTIFACT_TILES,
    'headline',
  )
  return tiles.map((tile, index) => ({
    label: text(tile?.label, `headline[${index}].label`),
    value: text(tile?.value, `headline[${index}].value`),
    sub: text(tile?.sub, `headline[${index}].sub`),
    status: oneOf(tile?.status, TILE_STATUSES, `headline[${index}].status`),
  }))
}

function sectionsOf(dto: CallAuditReportDto): CallAuditArtifactSection[] {
  const sections = bounded<CallAuditReportDto['sections'][number]>(
    dto.sections,
    MAX_ARTIFACT_SECTIONS,
    'sections',
  )
  return sections.map((section, index) => {
    const at = `sections[${index}]`
    const rows = bounded<
      CallAuditReportDto['sections'][number]['rows'][number]
    >(section?.rows, MAX_ARTIFACT_SECTION_ROWS, `${at}.rows`)
    return {
      key: text(section?.key, `${at}.key`),
      title: text(section?.title, `${at}.title`),
      caption: text(section?.caption, `${at}.caption`),
      total: whole(section?.total, `${at}.total`),
      rows: rows.map((row, rowIndex) => ({
        label: text(row?.label, `${at}.rows[${rowIndex}].label`),
        count: whole(row?.count, `${at}.rows[${rowIndex}].count`),
        sharePercent: optionalNumericString(
          row?.sharePercent,
          `${at}.rows[${rowIndex}].sharePercent`,
        ),
      })),
      emptyBucketCount: whole(
        section?.emptyBucketCount,
        `${at}.emptyBucketCount`,
      ),
    }
  })
}

const SCORE_VALUES = [1, 2, 3, 4, 5] as const

function metricsOf(dto: CallAuditReportDto): CallAuditArtifactMetric[] {
  const metrics = bounded<CallAuditReportDto['metrics'][number]>(
    dto.metrics,
    MAX_ARTIFACT_METRICS,
    'metrics',
  )
  return metrics.map((metric, index) => {
    const at = `metrics[${index}]`
    const distribution = metric?.distribution
    if (!distribution || typeof distribution !== 'object') {
      fail(`${at}.distribution`, 'is missing')
    }
    return {
      label: text(metric?.label, `${at}.label`),
      weight: whole(metric?.weight, `${at}.weight`),
      scoredCount: whole(metric?.scoredCount, `${at}.scoredCount`),
      notApplicableCount: whole(
        metric?.notApplicableCount,
        `${at}.notApplicableCount`,
      ),
      // Null stays null: a metric nobody scored is not a metric scored zero.
      averageScore: optionalNumericString(
        metric?.averageScore,
        `${at}.averageScore`,
      ),
      distribution: SCORE_VALUES.map((score) => ({
        score,
        count: whole(distribution[score], `${at}.distribution[${score}]`),
      })),
    }
  })
}

function reliabilityOf(
  dto: CallAuditReportDto,
): CallAuditArtifactReliability {
  const reliability = dto.reliability
  if (!reliability || typeof reliability !== 'object') {
    fail('reliability', 'is missing')
  }
  const rows = bounded<
    CallAuditReportDto['reliability']['byAttemptOutcome'][number]
  >(
    reliability.byAttemptOutcome,
    MAX_ARTIFACT_RELIABILITY_ROWS,
    'reliability.byAttemptOutcome',
  )
  return {
    attemptCount: whole(reliability.attemptCount, 'reliability.attemptCount'),
    resultCount: whole(reliability.resultCount, 'reliability.resultCount'),
    erroredCount: whole(reliability.erroredCount, 'reliability.erroredCount'),
    maxAttemptNumber: whole(
      reliability.maxAttemptNumber,
      'reliability.maxAttemptNumber',
    ),
    inputTokens: numericString(
      reliability.inputTokens,
      'reliability.inputTokens',
    ),
    outputTokens: numericString(
      reliability.outputTokens,
      'reliability.outputTokens',
    ),
    totalTokens: numericString(
      reliability.totalTokens,
      'reliability.totalTokens',
    ),
    averageLatencyMs: optionalNumericString(
      reliability.averageLatencyMs,
      'reliability.averageLatencyMs',
    ),
    maxLatencyMs: optionalNumericString(
      reliability.maxLatencyMs,
      'reliability.maxLatencyMs',
    ),
    byAttemptOutcome: rows.map((row, index) => {
      const at = `reliability.byAttemptOutcome[${index}]`
      return {
        label: text(row?.label, `${at}.label`),
        attemptCount: whole(row?.attemptCount, `${at}.attemptCount`),
        resultCount: whole(row?.resultCount, `${at}.resultCount`),
        erroredCount: whole(row?.erroredCount, `${at}.erroredCount`),
        totalTokens: numericString(row?.totalTokens, `${at}.totalTokens`),
        averageLatencyMs: optionalNumericString(
          row?.averageLatencyMs,
          `${at}.averageLatencyMs`,
        ),
      }
    }),
  }
}

/**
 * Folds the run list into anonymous totals. Only the closed status vocabulary
 * and the numeric counters are read; the run id, rule version label, per-run
 * period, timezone, timestamps, and error code text are all left behind.
 */
function runsOf(dto: CallAuditReportDto): CallAuditArtifactRunProgress {
  const runs = bounded<CallAuditReportDto['runs'][number]>(
    dto.runs,
    MAX_ARTIFACT_RUNS,
    'runs',
  )
  const statusCounts = new Map<CallAuditRunStatus, number>()
  const totals = {
    totalCandidates: 0,
    processedCount: 0,
    succeededCount: 0,
    failedCount: 0,
    skippedCount: 0,
    contentAuditableCount: 0,
    operationalOnlyCount: 0,
  }
  let runsWithErrorCount = 0

  runs.forEach((run, index) => {
    const at = `runs[${index}]`
    const status = oneOf(
      run?.status,
      Object.keys(RUN_STATUS_LABELS) as CallAuditRunStatus[],
      `${at}.status`,
    )
    statusCounts.set(status, (statusCounts.get(status) ?? 0) + 1)
    for (const key of Object.keys(totals) as Array<keyof typeof totals>) {
      totals[key] += whole(run?.[key], `${at}.${key}`)
    }
    // Presence only. A machine error code is still a per-run fact.
    if (optionalText(run?.errorCode, `${at}.errorCode`) !== null) {
      runsWithErrorCount += 1
    }
  })

  return {
    runCount: runs.length,
    byStatus: (Object.keys(RUN_STATUS_LABELS) as CallAuditRunStatus[])
      .filter((status) => statusCounts.has(status))
      .map((status) => ({
        label: RUN_STATUS_LABELS[status],
        count: statusCounts.get(status) ?? 0,
      })),
    ...totals,
    // A run set with no candidates has unknown progress, never complete progress.
    progressPercent: sharePercent(
      totals.processedCount,
      totals.totalCandidates,
    ),
    runsWithErrorCount,
  }
}

/**
 * Builds the aggregate-only model an artifact may render.
 *
 * Every field is copied by name. `dto.results` is not read here or anywhere
 * below, so the drilldown cannot reach a file even if the DTO grows.
 */
export function buildCallAuditReportAggregate(
  dto: CallAuditReportDto,
): CallAuditReportAggregate {
  if (!dto || typeof dto !== 'object') fail('report', 'is missing')
  if (dto.title !== CALL_AUDIT_REPORT_TITLE) {
    fail('title', 'is not an accepted value')
  }
  if (dto.aiCaller !== KSERVE_AI_CALLER_NAME) {
    fail('aiCaller', 'is not an accepted value')
  }
  if (typeof dto.hasResults !== 'boolean') {
    fail('hasResults', 'is not an accepted value')
  }
  const summary = dto.summary
  if (!summary || typeof summary !== 'object') fail('summary', 'is missing')

  return {
    title: CALL_AUDIT_REPORT_TITLE,
    aiCaller: KSERVE_AI_CALLER_NAME,
    aiCallerNote: aiCallerNoteFor(),
    scopeNote: CALL_AUDIT_ARTIFACT_SCOPE,
    qualityOnlyNote: CALL_AUDIT_ARTIFACT_QUALITY_ONLY_NOTE,
    generatedAt: generatedAtOf(dto.generatedAt),
    basis: basisOf(dto),
    hasResults: dto.hasResults,
    emptyStateNote: dto.hasResults ? null : EMPTY_STATE_NOTE,
    resultCount: whole(summary.resultCount, 'summary.resultCount'),
    auditedCallCount: whole(
      summary.auditedCallCount,
      'summary.auditedCallCount',
    ),
    headline: tilesOf(dto),
    sections: sectionsOf(dto),
    metrics: metricsOf(dto),
    reliability: reliabilityOf(dto),
    runs: runsOf(dto),
  }
}

// ---------------------------------------------------------------------------
// Presentation helpers shared by both artifacts
// ---------------------------------------------------------------------------

/** Locale-independent digit grouping, so an artifact renders identically anywhere. */
function countText(value: number): string {
  const digits = String(value)
  let grouped = ''
  for (let index = digits.length; index > 0; index -= 3) {
    const start = Math.max(0, index - 3)
    grouped = digits.slice(start, index) + (grouped ? `,${grouped}` : '')
  }
  return grouped
}

function shareText(value: string | null): string {
  return value === null ? UNKNOWN_SHARE : `${value}%`
}

function latencyText(value: string | null): string {
  return value === null ? NOT_RECORDED : `${value} ms`
}

function scoreText(value: string | null): string {
  return value === null ? NOT_SCORED : value
}

function progressText(value: string | null): string {
  return value === null ? 'Unknown — no candidates claimed' : `${value}%`
}

function distributionText(
  metric: CallAuditArtifactMetric,
): string {
  return metric.distribution
    .map((entry) => `${entry.score}: ${countText(entry.count)}`)
    .join('  ·  ')
}

const PERIOD_STATE = (aggregate: CallAuditReportAggregate): string =>
  aggregate.basis.periodDefaulted
    ? 'Period defaulted to the current calendar period'
    : 'Period as requested'

// ---------------------------------------------------------------------------
// HTML artifact
// ---------------------------------------------------------------------------

/** Escapes every HTML/XML-sensitive character. No label can open a tag. */
function escape(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}

const CELL = 'padding:6px 10px;border:1px solid #cbd5e1;text-align:left'
const CELL_RIGHT =
  'padding:6px 10px;border:1px solid #cbd5e1;text-align:right'
const HEAD = `${CELL};background:#f1f5f9;font-weight:bold`
const HEAD_RIGHT = `${CELL_RIGHT};background:#f1f5f9;font-weight:bold`
const MUTED = 'color:#475569;font-size:12px;margin:4px 0 12px'
const H2 = 'font-size:15px;margin:22px 0 4px;color:#0f172a'
const TABLE =
  'border-collapse:collapse;width:100%;font-size:13px;margin:0 0 8px'

function metaRow(label: string, value: string): string {
  return (
    `<tr><td style="${CELL}">${escape(label)}</td>` +
    `<td style="${CELL}">${escape(value)}</td></tr>`
  )
}

function tileHtml(tile: CallAuditArtifactTile): string {
  return (
    `<tr><td style="${CELL}">${escape(tile.label)}</td>` +
    `<td style="${CELL_RIGHT}"><strong>${escape(tile.value)}</strong></td>` +
    `<td style="${CELL}">${escape(tile.sub)}</td>` +
    `<td style="${CELL}">${escape(tile.status)}</td></tr>`
  )
}

function sectionHtml(section: CallAuditArtifactSection): string {
  const rows = section.rows.length
    ? section.rows
        .map(
          (row) =>
            `<tr><td style="${CELL}">${escape(row.label)}</td>` +
            `<td style="${CELL_RIGHT}">${countText(row.count)}</td>` +
            `<td style="${CELL_RIGHT}">${escape(shareText(row.sharePercent))}</td></tr>`,
        )
        .join('')
    : `<tr><td style="${CELL}" colspan="3">No bucket was counted in this period.</td></tr>`
  const omitted =
    section.emptyBucketCount > 0
      ? `<p style="${MUTED}">${countText(section.emptyBucketCount)} bucket(s) with no rows omitted.</p>`
      : ''
  return (
    `<h2 style="${H2}">${escape(section.title)}</h2>` +
    `<p style="${MUTED}">${escape(section.caption)} Section total: ${countText(section.total)}.</p>` +
    `<table role="presentation" style="${TABLE}">` +
    `<tr><th style="${HEAD}">Bucket</th><th style="${HEAD_RIGHT}">Count</th>` +
    `<th style="${HEAD_RIGHT}">Share</th></tr>${rows}</table>${omitted}`
  )
}

function metricsHtml(metrics: CallAuditArtifactMetric[]): string {
  const rows = metrics.length
    ? metrics
        .map(
          (metric) =>
            `<tr><td style="${CELL}">${escape(metric.label)}</td>` +
            `<td style="${CELL_RIGHT}">${countText(metric.weight)}</td>` +
            `<td style="${CELL_RIGHT}">${countText(metric.scoredCount)}</td>` +
            `<td style="${CELL_RIGHT}">${countText(metric.notApplicableCount)}</td>` +
            `<td style="${CELL_RIGHT}">${escape(scoreText(metric.averageScore))}</td>` +
            `<td style="${CELL}">${escape(distributionText(metric))}</td></tr>`,
        )
        .join('')
    : `<tr><td style="${CELL}" colspan="6">No rubric metric was aggregated for this period.</td></tr>`
  return (
    `<h2 style="${H2}">Rubric metrics</h2>` +
    `<p style="${MUTED}">Averages cover scored rows only. Not-applicable rows are ` +
    `counted separately and are never folded into a score of zero; a metric ` +
    `nobody scored reads &quot;${escape(NOT_SCORED)}&quot;.</p>` +
    `<table role="presentation" style="${TABLE}">` +
    `<tr><th style="${HEAD}">Metric</th><th style="${HEAD_RIGHT}">Weight</th>` +
    `<th style="${HEAD_RIGHT}">Scored</th><th style="${HEAD_RIGHT}">NA</th>` +
    `<th style="${HEAD_RIGHT}">Average</th><th style="${HEAD}">Score distribution</th>` +
    `</tr>${rows}</table>`
  )
}

function reliabilityHtml(
  reliability: CallAuditArtifactReliability,
): string {
  const rows = reliability.byAttemptOutcome.length
    ? reliability.byAttemptOutcome
        .map(
          (row) =>
            `<tr><td style="${CELL}">${escape(row.label)}</td>` +
            `<td style="${CELL_RIGHT}">${countText(row.attemptCount)}</td>` +
            `<td style="${CELL_RIGHT}">${countText(row.resultCount)}</td>` +
            `<td style="${CELL_RIGHT}">${countText(row.erroredCount)}</td>` +
            `<td style="${CELL_RIGHT}">${escape(row.totalTokens)}</td>` +
            `<td style="${CELL_RIGHT}">${escape(latencyText(row.averageLatencyMs))}</td></tr>`,
        )
        .join('')
    : `<tr><td style="${CELL}" colspan="6">No audit attempt was recorded in this period.</td></tr>`
  return (
    `<h2 style="${H2}">Audit reliability</h2>` +
    `<p style="${MUTED}">Volume and reliability of the audit itself. Token counts ` +
    `describe audit effort only and are not multiplied by anything here.</p>` +
    `<table role="presentation" style="${TABLE}">` +
    metaRow('Attempts', countText(reliability.attemptCount)) +
    metaRow('Results covered', countText(reliability.resultCount)) +
    metaRow('Errored attempts', countText(reliability.erroredCount)) +
    metaRow('Highest attempt number', countText(reliability.maxAttemptNumber)) +
    metaRow('Input tokens', reliability.inputTokens) +
    metaRow('Output tokens', reliability.outputTokens) +
    metaRow('Total tokens', reliability.totalTokens) +
    metaRow('Average latency', latencyText(reliability.averageLatencyMs)) +
    metaRow('Slowest attempt', latencyText(reliability.maxLatencyMs)) +
    `</table><table role="presentation" style="${TABLE}">` +
    `<tr><th style="${HEAD}">Attempt outcome</th><th style="${HEAD_RIGHT}">Attempts</th>` +
    `<th style="${HEAD_RIGHT}">Results</th><th style="${HEAD_RIGHT}">Errored</th>` +
    `<th style="${HEAD_RIGHT}">Tokens</th><th style="${HEAD_RIGHT}">Avg latency</th>` +
    `</tr>${rows}</table>`
  )
}

function runsHtml(runs: CallAuditArtifactRunProgress): string {
  const statuses = runs.byStatus.length
    ? runs.byStatus
        .map((entry) => `${entry.label}: ${countText(entry.count)}`)
        .join('  ·  ')
    : 'No run covered this period'
  return (
    `<h2 style="${H2}">Run progress</h2>` +
    `<p style="${MUTED}">Summarised across every run covering the period. Individual ` +
    `runs are not identified.</p>` +
    `<table role="presentation" style="${TABLE}">` +
    metaRow('Runs covering the period', countText(runs.runCount)) +
    metaRow('Run status', statuses) +
    metaRow('Candidates', countText(runs.totalCandidates)) +
    metaRow('Processed', countText(runs.processedCount)) +
    metaRow('Progress', progressText(runs.progressPercent)) +
    metaRow('Succeeded', countText(runs.succeededCount)) +
    metaRow('Failed', countText(runs.failedCount)) +
    metaRow('Skipped', countText(runs.skippedCount)) +
    metaRow('Content-auditable', countText(runs.contentAuditableCount)) +
    metaRow('Operational only', countText(runs.operationalOnlyCount)) +
    metaRow('Runs reporting an error', countText(runs.runsWithErrorCount)) +
    '</table>'
  )
}

/**
 * A self-contained escaped HTML report. Inline styles only: no stylesheet, no
 * script, no image, and no remote reference, so it renders the same in an email
 * client as it does saved to disk, and it can fetch nothing when opened.
 */
export function buildCallAuditReportHtml(
  dto: CallAuditReportDto,
): string {
  return renderCallAuditReportHtml(buildCallAuditReportAggregate(dto))
}

export function renderCallAuditReportHtml(
  aggregate: CallAuditReportAggregate,
): string {
  const { basis } = aggregate
  const emptyBanner = aggregate.emptyStateNote
    ? `<p style="padding:10px 12px;border:1px solid #f59e0b;background:#fffbeb;` +
      `color:#92400e;font-size:13px;margin:0 0 14px">` +
      `<strong>Empty period.</strong> ${escape(aggregate.emptyStateNote)}</p>`
    : ''

  const html =
    `<!doctype html>\n<html lang="en"><head><meta charset="utf-8">` +
    `<title>${escape(aggregate.title)}</title></head>` +
    `<body style="margin:0;background:#f8fafc">` +
    `<div style="max-width:860px;margin:0 auto;padding:24px;` +
    `font-family:Arial,Helvetica,sans-serif;color:#0f172a;line-height:1.5;background:#ffffff">` +
    `<h1 style="font-size:21px;margin:0 0 2px">${escape(aggregate.title)}</h1>` +
    `<p style="${MUTED}">${escape(basis.cadenceLabel)} · ${escape(basis.periodLabel)}</p>` +
    emptyBanner +
    `<table role="presentation" style="${TABLE}">` +
    metaRow('Cadence', basis.cadenceLabel) +
    metaRow('Period start (inclusive)', basis.periodStart) +
    metaRow('Period end (exclusive)', basis.periodEndExclusive) +
    metaRow('Boundary basis', basis.boundaryBasis) +
    metaRow('Period selection', PERIOD_STATE(aggregate)) +
    metaRow('Generated at', aggregate.generatedAt) +
    metaRow('AI caller', aggregate.aiCaller) +
    metaRow('Result rows in scope', countText(aggregate.resultCount)) +
    metaRow('Distinct audited calls', countText(aggregate.auditedCallCount)) +
    '</table>' +
    `<p style="${MUTED}">${escape(basis.boundaryNote)}</p>` +
    `<p style="${MUTED}">${escape(aggregate.aiCallerNote)}</p>` +
    `<h2 style="${H2}">Headline</h2>` +
    `<table role="presentation" style="${TABLE}">` +
    `<tr><th style="${HEAD}">Measure</th><th style="${HEAD_RIGHT}">Value</th>` +
    `<th style="${HEAD}">Detail</th><th style="${HEAD}">State</th></tr>` +
    (aggregate.headline.length
      ? aggregate.headline.map(tileHtml).join('')
      : `<tr><td style="${CELL}" colspan="4">No headline measure was produced.</td></tr>`) +
    '</table>' +
    aggregate.sections.map(sectionHtml).join('') +
    metricsHtml(aggregate.metrics) +
    reliabilityHtml(aggregate.reliability) +
    runsHtml(aggregate.runs) +
    `<hr style="border:none;border-top:1px solid #cbd5e1;margin:22px 0 10px">` +
    `<p style="${MUTED}">${escape(aggregate.scopeNote)}</p>` +
    `<p style="${MUTED}">${escape(aggregate.qualityOnlyNote)}</p>` +
    '</div></body></html>'

  if (Buffer.byteLength(html, 'utf8') > MAX_ARTIFACT_HTML_BYTES) {
    fail('html', 'exceeds the artifact bound', 'CALL_AUDIT_ARTIFACT_TOO_LARGE')
  }
  return html
}

// ---------------------------------------------------------------------------
// PDF artifact
// ---------------------------------------------------------------------------

const PAGE_MARGIN = 48
const PAGE_WIDTH = 595.28
const PAGE_HEIGHT = 841.89
const CONTENT_WIDTH = PAGE_WIDTH - PAGE_MARGIN * 2
const PAGE_BOTTOM = PAGE_HEIGHT - PAGE_MARGIN
const LABEL_WIDTH = 250
const VALUE_WIDTH = CONTENT_WIDTH - LABEL_WIDTH - 10

type Pdf = InstanceType<typeof PDFDocument>

const PDF_TRANSLITERATIONS: ReadonlyArray<readonly [RegExp, string]> = [
  [/[‘’‛]/g, "'"],
  [/[“”]/g, '"'],
  [/[–—―•]/g, '-'],
  [/→/g, '->'],
  [/←/g, '<-'],
  [/…/g, '...'],
]

/** Anything the built-in PDF encoding cannot carry. Dropped, never mojibake. */
const PDF_UNSUPPORTED = /[^\u0020-\u007E\u00A0-\u00FF]/g

/**
 * The PDF's built-in fonts encode Latin-1 only, and an unsupported character
 * silently becomes a WRONG glyph rather than a missing one — an arrow arriving
 * as an exclamation mark would misstate the period basis. Common typography is
 * transliterated and anything still unrepresentable is dropped, so the PDF
 * always says what the aggregate model says.
 */
function pdfSafe(value: string): string {
  let result = value
  for (const [pattern, replacement] of PDF_TRANSLITERATIONS) {
    result = result.replace(pattern, replacement)
  }
  return result.replace(PDF_UNSUPPORTED, '')
}

function ensureSpace(document: Pdf, needed: number): void {
  if (document.y + needed > PAGE_BOTTOM) document.addPage()
}

function heading(document: Pdf, value: string): void {
  ensureSpace(document, 46)
  document
    .moveDown(0.8)
    .fillColor('#0f172a')
    .fontSize(12)
    .text(pdfSafe(value), PAGE_MARGIN, document.y, { width: CONTENT_WIDTH })
  document.moveDown(0.2)
}

function note(document: Pdf, value: string): void {
  ensureSpace(document, 28)
  document
    .fillColor('#475569')
    .fontSize(8.5)
    .text(pdfSafe(value), PAGE_MARGIN, document.y, { width: CONTENT_WIDTH })
  document.fillColor('#0f172a')
}

/** One label/value line. Both halves are drawn from the same validated model. */
function pair(document: Pdf, label: string, value: string): void {
  ensureSpace(document, 22)
  const top = document.y
  document
    .fontSize(9.5)
    .fillColor('#475569')
    .text(pdfSafe(label), PAGE_MARGIN, top, { width: LABEL_WIDTH })
  const afterLabel = document.y
  document
    .fillColor('#0f172a')
    .text(pdfSafe(value), PAGE_MARGIN + LABEL_WIDTH + 10, top, {
      width: VALUE_WIDTH,
      align: 'right',
    })
  document.y = Math.max(afterLabel, document.y)
}

function pdfSections(
  document: Pdf,
  sections: CallAuditArtifactSection[],
): void {
  for (const section of sections) {
    heading(document, section.title)
    note(document, `${section.caption} Section total: ${countText(section.total)}.`)
    if (section.rows.length === 0) {
      pair(document, 'No bucket counted', UNKNOWN_SHARE)
    }
    for (const row of section.rows) {
      pair(
        document,
        row.label,
        `${countText(row.count)}   (${shareText(row.sharePercent)})`,
      )
    }
    if (section.emptyBucketCount > 0) {
      note(
        document,
        `${countText(section.emptyBucketCount)} bucket(s) with no rows omitted.`,
      )
    }
  }
}

function pdfMetrics(
  document: Pdf,
  metrics: CallAuditArtifactMetric[],
): void {
  heading(document, 'Rubric metrics')
  note(
    document,
    'Averages cover scored rows only. Not-applicable rows are counted ' +
      `separately and never folded into a score of zero; a metric nobody ` +
      `scored reads "${NOT_SCORED}".`,
  )
  if (metrics.length === 0) {
    pair(document, 'No rubric metric aggregated', NOT_SCORED)
    return
  }
  for (const metric of metrics) {
    pair(
      document,
      metric.label,
      `avg ${scoreText(metric.averageScore)}   scored ${countText(
        metric.scoredCount,
      )}   NA ${countText(metric.notApplicableCount)}   weight ${countText(
        metric.weight,
      )}`,
    )
    note(document, `Score distribution — ${distributionText(metric)}`)
  }
}

function pdfReliability(
  document: Pdf,
  reliability: CallAuditArtifactReliability,
): void {
  heading(document, 'Audit reliability')
  note(
    document,
    'Volume and reliability of the audit itself. Token counts describe audit ' +
      'effort only and are not multiplied by anything here.',
  )
  pair(document, 'Attempts', countText(reliability.attemptCount))
  pair(document, 'Results covered', countText(reliability.resultCount))
  pair(document, 'Errored attempts', countText(reliability.erroredCount))
  pair(
    document,
    'Highest attempt number',
    countText(reliability.maxAttemptNumber),
  )
  pair(document, 'Input tokens', reliability.inputTokens)
  pair(document, 'Output tokens', reliability.outputTokens)
  pair(document, 'Total tokens', reliability.totalTokens)
  pair(document, 'Average latency', latencyText(reliability.averageLatencyMs))
  pair(document, 'Slowest attempt', latencyText(reliability.maxLatencyMs))
  if (reliability.byAttemptOutcome.length === 0) {
    pair(document, 'No audit attempt recorded', NOT_RECORDED)
    return
  }
  for (const row of reliability.byAttemptOutcome) {
    pair(
      document,
      row.label,
      `${countText(row.attemptCount)} attempts   ${countText(
        row.resultCount,
      )} results   ${countText(row.erroredCount)} errored   ${
        row.totalTokens
      } tokens   ${latencyText(row.averageLatencyMs)}`,
    )
  }
}

function pdfRuns(
  document: Pdf,
  runs: CallAuditArtifactRunProgress,
): void {
  heading(document, 'Run progress')
  note(
    document,
    'Summarised across every run covering the period. Individual runs are not ' +
      'identified.',
  )
  pair(document, 'Runs covering the period', countText(runs.runCount))
  pair(
    document,
    'Run status',
    runs.byStatus.length
      ? runs.byStatus
          .map((entry) => `${entry.label}: ${countText(entry.count)}`)
          .join('   ')
      : 'No run covered this period',
  )
  pair(document, 'Candidates', countText(runs.totalCandidates))
  pair(document, 'Processed', countText(runs.processedCount))
  pair(document, 'Progress', progressText(runs.progressPercent))
  pair(document, 'Succeeded', countText(runs.succeededCount))
  pair(document, 'Failed', countText(runs.failedCount))
  pair(document, 'Skipped', countText(runs.skippedCount))
  pair(document, 'Content-auditable', countText(runs.contentAuditableCount))
  pair(document, 'Operational only', countText(runs.operationalOnlyCount))
  pair(document, 'Runs reporting an error', countText(runs.runsWithErrorCount))
}

/**
 * An A4 management PDF.
 *
 * Text is drawn from the aggregate model only, and the document metadata is
 * fixed: the creation date is the report's own `generatedAt`, not a clock read,
 * so the same DTO always produces the same document. Compression is off so the
 * content stream stays inspectable — a report that claims to exclude per-call
 * detail should be verifiable byte by byte.
 */
export function buildCallAuditReportPdf(
  dto: CallAuditReportDto,
): Promise<Buffer> {
  return renderCallAuditReportPdf(buildCallAuditReportAggregate(dto))
}

export function renderCallAuditReportPdf(
  aggregate: CallAuditReportAggregate,
): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const document = new PDFDocument({
      size: 'A4',
      margin: PAGE_MARGIN,
      compress: false,
      info: {
        Title: pdfSafe(aggregate.title),
        Author: 'Kairali Call Audit Platform',
        Subject: pdfSafe(
          `${aggregate.basis.cadenceLabel} call audit aggregates`,
        ),
        CreationDate: new Date(aggregate.generatedAt),
      },
    })
    const chunks: Buffer[] = []
    document.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
    document.on('error', reject)
    document.on('end', () => {
      const pdf = Buffer.concat(chunks)
      if (pdf.byteLength > MAX_ARTIFACT_PDF_BYTES) {
        reject(
          new CallAuditArtifactError(
            'pdf',
            'exceeds the artifact bound',
            'CALL_AUDIT_ARTIFACT_TOO_LARGE',
          ),
        )
        return
      }
      resolve(pdf)
    })

    try {
      const { basis } = aggregate
      document
        .fillColor('#0f172a')
        .fontSize(17)
        .text(pdfSafe(aggregate.title), PAGE_MARGIN, PAGE_MARGIN, {
          width: CONTENT_WIDTH,
        })
        .fontSize(10)
        .fillColor('#475569')
        .text(pdfSafe(`${basis.cadenceLabel} · ${basis.periodLabel}`), {
          width: CONTENT_WIDTH,
        })
      document.moveDown(0.4)

      if (aggregate.emptyStateNote) {
        document
          .fillColor('#92400e')
          .fontSize(10)
          .text(
            pdfSafe(`Empty period. ${aggregate.emptyStateNote}`),
            PAGE_MARGIN,
            document.y,
            { width: CONTENT_WIDTH },
          )
        document.fillColor('#0f172a').moveDown(0.3)
      }

      heading(document, 'Report basis')
      pair(document, 'Cadence', basis.cadenceLabel)
      pair(document, 'Period start (inclusive)', basis.periodStart)
      pair(document, 'Period end (exclusive)', basis.periodEndExclusive)
      pair(document, 'Boundary basis', basis.boundaryBasis)
      pair(document, 'Period selection', PERIOD_STATE(aggregate))
      pair(document, 'Generated at', aggregate.generatedAt)
      pair(document, 'AI caller', aggregate.aiCaller)
      pair(document, 'Result rows in scope', countText(aggregate.resultCount))
      pair(
        document,
        'Distinct audited calls',
        countText(aggregate.auditedCallCount),
      )
      note(document, basis.boundaryNote)
      note(document, aggregate.aiCallerNote)

      heading(document, 'Headline')
      if (aggregate.headline.length === 0) {
        pair(document, 'No headline measure produced', UNKNOWN_SHARE)
      }
      for (const tile of aggregate.headline) {
        pair(document, tile.label, `${tile.value}   (${tile.status})`)
        note(document, tile.sub)
      }

      pdfSections(document, aggregate.sections)
      pdfMetrics(document, aggregate.metrics)
      pdfReliability(document, aggregate.reliability)
      pdfRuns(document, aggregate.runs)

      document.moveDown(0.6)
      note(document, aggregate.scopeNote)
      note(document, aggregate.qualityOnlyNote)
      document.end()
    } catch (error) {
      reject(error)
    }
  })
}

// ---------------------------------------------------------------------------
// Attachment metadata
// ---------------------------------------------------------------------------

export interface CallAuditArtifactDescriptor {
  filename: string
  mediaType: string
  byteLength: number
}

/**
 * A filename built ONLY from the cadence and the two validated period
 * boundaries. Nothing from the database, the source system, a run, a result, or
 * a label reaches it, so a filename cannot leak what the report body excludes.
 * Midnight boundaries render as a plain date; any other instant appends the
 * time, so two adjacent windows never collide.
 */
export function callAuditArtifactFilename(
  cadence: CallAuditReportCadence,
  period: { periodStart: string; periodEndExclusive: string },
  extension: 'html' | 'pdf',
): string {
  const safeCadence = oneOf(cadence, CADENCES, 'reportBasis.cadence')
  const stamp = (value: string, field: string): string => {
    const match = NAIVE_TIMESTAMP.exec(naiveTimestamp(value, field))!
    const [, year, month, day, hour, minute, second] = match
    const time =
      hour === '00' && minute === '00' && second === '00'
        ? ''
        : `t${hour}${minute}${second}`
    return `${year}-${month}-${day}${time}`
  }
  const filename =
    `${CALL_AUDIT_ARTIFACT_FILENAME_STEM}-${safeCadence}-` +
    `${stamp(period.periodStart, 'reportBasis.periodStart')}-to-` +
    `${stamp(period.periodEndExclusive, 'reportBasis.periodEndExclusive')}.${extension}`
  if (
    filename.length > MAX_ARTIFACT_FILENAME_CHARS ||
    !/^[a-z0-9.\-]+$/.test(filename)
  ) {
    fail('filename', 'exceeds the artifact bound', 'CALL_AUDIT_ARTIFACT_TOO_LARGE')
  }
  return filename
}

export interface CallAuditReportArtifacts {
  /** The aggregate model both artifacts were rendered from. */
  aggregate: CallAuditReportAggregate
  html: string
  htmlArtifact: CallAuditArtifactDescriptor
  pdf: Buffer
  pdfArtifact: CallAuditArtifactDescriptor
}

/**
 * Builds every management / KServe artifact for one accepted report DTO.
 *
 * Pure apart from PDFKit assembling bytes in memory: nothing is written to
 * disk, sent, queued, logged, or persisted here. Delivery is somebody else's
 * job, and deliberately out of this module's scope.
 */
export async function buildCallAuditReportArtifacts(
  dto: CallAuditReportDto,
): Promise<CallAuditReportArtifacts> {
  const aggregate = buildCallAuditReportAggregate(dto)
  const html = renderCallAuditReportHtml(aggregate)
  const pdf = await renderCallAuditReportPdf(aggregate)
  const period = {
    periodStart: aggregate.basis.periodStart,
    periodEndExclusive: aggregate.basis.periodEndExclusive,
  }
  return {
    aggregate,
    html,
    htmlArtifact: {
      filename: callAuditArtifactFilename(
        aggregate.basis.cadence,
        period,
        'html',
      ),
      mediaType: CALL_AUDIT_HTML_MEDIA_TYPE,
      byteLength: Buffer.byteLength(html, 'utf8'),
    },
    pdf,
    pdfArtifact: {
      filename: callAuditArtifactFilename(
        aggregate.basis.cadence,
        period,
        'pdf',
      ),
      mediaType: CALL_AUDIT_PDF_MEDIA_TYPE,
      byteLength: pdf.byteLength,
    },
  }
}
