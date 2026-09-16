import { createHash, randomUUID } from 'node:crypto'
import { canonicalJson } from '../messaging/canonicalJson.ts'
import { normalizeRecordingUrl } from '../backfill/normalizeRecordingUrl.ts'
import { fromScaled, toScaled } from '../ui/decimal.ts'

/**
 * Domain rules for the RECURRING late-recording correction workflow.
 *
 * KServe supplies some months with a Task ID but no recording. Those calls are
 * settled at INR 0 on the standing `no_recording_zero` rule, because there is
 * no evidence to support a charge. When the recording arrives later, an
 * administrator uploads it against the month it belongs to, and only those
 * exact tasks are audited and re-priced.
 *
 * Pure. No SQL, no HTTP, no clock, no provider client. Everything here is
 * validation, deterministic identity, and fixed-precision arithmetic.
 *
 * The invariants this module owns:
 *
 *   * ONE MONTH, ONE BOUNDED BATCH. At most
 *     {@link MAX_LATE_RECORDING_ROWS} rows against a single named bill month.
 *     Nothing is widened, inferred from a filter, or carried across months.
 *   * A URL IS NEVER A RETURN VALUE. A submitted URL is normalized to the
 *     canonical S3 object URL and then reduced to a SHA-256 for every purpose
 *     except the one column that has to hold it. No preview, receipt, status
 *     read, log line, error, or export may carry it, so nothing in this module
 *     returns one.
 *   * EVIDENCE IS WRITTEN ONCE. `NULL -> canonical URL` is the single
 *     permitted transition, because before it there was no evidence at all.
 *     The same task with the same canonical URL is an idempotent replay; a
 *     different one is a conflict and is refused, never overwritten.
 *   * REJECTIONS NAME NOTHING. Every refusal is a bounded code from the closed
 *     set below, safe to return to a browser and safe to write to a log. A
 *     code never carries a task id, a URL, a count, or a driver message.
 *   * MONEY IS FIXED PRECISION. Correction totals are computed on scale-8
 *     integers and never pass through a float.
 */

/** Admin-only POST that validates an upload and writes nothing. */
export const LATE_RECORDING_PREVIEW_ROUTE =
  '/api/v1/imports/late-recording/preview'

/** Admin-only POST that commits a previewed upload. */
export const LATE_RECORDING_COMMIT_ROUTE =
  '/api/v1/imports/late-recording/commit'

/** Admin-only GET that reports one batch's progress. */
export const LATE_RECORDING_STATUS_ROUTE =
  '/api/v1/imports/late-recording/status'

/** The hard ceiling on one upload, enforced before any statement runs. */
export const MAX_LATE_RECORDING_ROWS = 100

/** Largest accepted upload. Two short columns over a bounded row count. */
export const MAX_LATE_RECORDING_FILE_BYTES = 256 * 1024

/** Longest accepted Task ID. Matches the audit scope bound. */
const MAX_TASK_ID_LENGTH = 191

/** Longest accepted submitted URL, before normalization. */
const MAX_URL_LENGTH = 2_048

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/

/** Bounded caller-supplied retry key: opaque, printable, and fixed-length. */
const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{16,80}$/

const BILL_MONTH = /^\d{4}-(?:0[1-9]|1[0-2])$/

export const REQUIRED_LATE_RECORDING_HEADERS = [
  'Task ID',
  'Recording URL',
] as const

/**
 * Every reason one row can be refused, as a CLOSED set.
 *
 * A caller learns which of these applies to which uploaded row number, and
 * nothing else. There is deliberately no free-text variant and no "other with
 * detail": a code that could carry detail would eventually carry a URL.
 */
export const LATE_RECORDING_REJECTION_CODES = [
  // Shape of the uploaded file itself.
  'TASK_ID_REQUIRED',
  'TASK_ID_DUPLICATE',
  'TASK_ID_TOO_LONG',
  'RECORDING_URL_REQUIRED',
  'RECORDING_URL_TOO_LONG',
  // Shape of the URL.
  'URL_UNPARSEABLE',
  'URL_NOT_HTTPS',
  'URL_NOT_ALLOWLISTED',
  // Resolution of the task against this month.
  'TASK_NOT_FOUND',
  'TASK_AMBIGUOUS',
  'INVOICE_MISSING',
  // Current state of the call.
  'CALL_STATE_INELIGIBLE',
  'RECORDING_ARTIFACT_MISSING',
  'RECORDING_URL_ALREADY_PRESENT',
  'AUDIT_ALREADY_COMPLETED',
  // Deployment preconditions.
  'RATE_CARD_UNAVAILABLE',
] as const

export type LateRecordingRejectionCode =
  (typeof LATE_RECORDING_REJECTION_CODES)[number]

/** What a preview or commit decided about one uploaded row. */
export type LateRecordingRowDecision =
  | { rowNumber: number; outcome: 'accepted' }
  /** The same task already carries this exact canonical URL: a safe replay. */
  | { rowNumber: number; outcome: 'duplicate_replay' }
  | {
      rowNumber: number
      outcome: 'rejected'
      code: LateRecordingRejectionCode
    }

/** Lifecycle of one late-recording batch. */
export const LATE_RECORDING_BATCH_STATUSES = [
  'accepted',
  'running',
  'completed',
  'completed_with_failures',
] as const
export type LateRecordingBatchStatus =
  (typeof LATE_RECORDING_BATCH_STATUSES)[number]

/**
 * Lifecycle of one accepted task inside a batch.
 *
 * `accepted` is the worker's queue and `auditing` is a claim. An item stays in
 * `auditing` across BOTH the audit write and the money write, so a crash
 * between them is recoverable: the correction pass reads durable audit state
 * and finishes the item without ever re-spending on a model. `corrected` is the
 * terminal success and `failed` the terminal refusal.
 */
export const LATE_RECORDING_ITEM_STATES = [
  'accepted',
  'auditing',
  'corrected',
  'failed',
] as const
export type LateRecordingItemState =
  (typeof LATE_RECORDING_ITEM_STATES)[number]

/**
 * A refused request. Carries a bounded code and a status only — never the
 * submitted tasks, a URL, the retry key, an internal id, or a driver message.
 */
export class LateRecordingError extends Error {
  readonly code: string
  readonly status: number

  constructor(
    code = 'INVALID_LATE_RECORDING_REQUEST',
    status = 400,
    message = 'Late recording correction request is invalid',
  ) {
    super(message)
    this.code = code
    this.status = status
  }
}

export interface LateRecordingCsvRow {
  /** 1-based row number as the administrator sees it in the spreadsheet. */
  rowNumber: number
  taskId: string
  /** The submitted URL, still unnormalized. Never leaves the server. */
  submittedUrl: string
}

/**
 * Parses the two-column upload.
 *
 * Structural failures are collected per row rather than failing the file, so a
 * preview can tell the administrator exactly which spreadsheet rows to fix. A
 * missing header or an unterminated quoted value is still a whole-file
 * refusal: neither is a row-level fact.
 */
export function parseLateRecordingCsv(bytes: Buffer): {
  rows: LateRecordingCsvRow[]
  rejections: Array<{
    rowNumber: number
    code: LateRecordingRejectionCode
  }>
} {
  if (bytes.byteLength > MAX_LATE_RECORDING_FILE_BYTES) {
    throw new LateRecordingError(
      'LATE_RECORDING_FILE_TOO_LARGE',
      413,
      'Late recording upload is too large',
    )
  }
  const grid = parseCsvGrid(bytes.toString('utf8').replace(/^\uFEFF/, ''))
  const headers = grid.shift()
  if (!headers) {
    throw new LateRecordingError(
      'LATE_RECORDING_CSV_EMPTY',
      400,
      'Late recording upload is empty',
    )
  }
  const index = new Map(
    headers.map((header, position) => [header, position]),
  )
  if (REQUIRED_LATE_RECORDING_HEADERS.some((header) => !index.has(header))) {
    throw new LateRecordingError(
      'LATE_RECORDING_CSV_HEADERS_INVALID',
      400,
      'Late recording upload must have Task ID and Recording URL columns',
    )
  }
  if (grid.length > MAX_LATE_RECORDING_ROWS) {
    throw new LateRecordingError(
      'LATE_RECORDING_BATCH_TOO_LARGE',
      400,
      'Late recording upload exceeds the bounded batch size',
    )
  }
  if (grid.length === 0) {
    throw new LateRecordingError(
      'LATE_RECORDING_CSV_EMPTY',
      400,
      'Late recording upload contains no rows',
    )
  }
  const rows: LateRecordingCsvRow[] = []
  const rejections: Array<{
    rowNumber: number
    code: LateRecordingRejectionCode
  }> = []
  const seen = new Set<string>()
  grid.forEach((values, position) => {
    // Row 1 is the header, so the first data row is row 2 on screen.
    const rowNumber = position + 2
    const cell = (
      header: (typeof REQUIRED_LATE_RECORDING_HEADERS)[number],
    ): string => values[index.get(header) as number]?.trim() ?? ''
    const taskId = cell('Task ID')
    const submittedUrl = cell('Recording URL')
    const reject = (code: LateRecordingRejectionCode): void => {
      rejections.push({ rowNumber, code })
    }
    if (!taskId) return reject('TASK_ID_REQUIRED')
    if (taskId.length > MAX_TASK_ID_LENGTH || CONTROL_CHARACTERS.test(taskId)) {
      return reject('TASK_ID_TOO_LONG')
    }
    if (seen.has(taskId)) return reject('TASK_ID_DUPLICATE')
    if (!submittedUrl) return reject('RECORDING_URL_REQUIRED')
    if (
      submittedUrl.length > MAX_URL_LENGTH ||
      CONTROL_CHARACTERS.test(submittedUrl)
    ) {
      return reject('RECORDING_URL_TOO_LONG')
    }
    seen.add(taskId)
    rows.push({ rowNumber, taskId, submittedUrl })
  })
  return { rows, rejections }
}

/**
 * Minimal RFC-4180 reader, matching the usage importer's own semantics so an
 * administrator's spreadsheet behaves identically in both places.
 */
function parseCsvGrid(input: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  for (let position = 0; position < input.length; position += 1) {
    const character = input[position]
    if (quoted) {
      if (character === '"' && input[position + 1] === '"') {
        field += '"'
        position += 1
      } else if (character === '"') {
        quoted = false
      } else {
        field += character
      }
      continue
    }
    if (character === '"' && field.length === 0) quoted = true
    else if (character === ',') {
      row.push(field.trim())
      field = ''
    } else if (character === '\n') {
      row.push(field.trim())
      rows.push(row)
      row = []
      field = ''
    } else if (character !== '\r') field += character
  }
  if (quoted) {
    throw new LateRecordingError(
      'LATE_RECORDING_CSV_UNTERMINATED_QUOTE',
      400,
      'Late recording upload contains an unterminated quoted value',
    )
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field.trim())
    rows.push(row)
  }
  return rows.filter((values) => values.some(Boolean))
}

/**
 * Reduces a submitted URL to the canonical, stable S3 object URL.
 *
 * Signed and proxy-wrapped URLs are accepted through the EXISTING normalizer —
 * the same one the backfill uses — and the signing query is discarded, so the
 * only thing that can ever be stored is the stable object URL. A host outside
 * the allowlist, a non-HTTPS scheme, and an unparseable value are each their
 * own bounded rejection so an administrator can tell a typo from a wrong
 * bucket.
 */
export function canonicalizeLateRecordingUrl(
  submittedUrl: string,
  allowedHosts: readonly string[],
): { canonicalUrl: string } | { code: LateRecordingRejectionCode } {
  const normalized = normalizeRecordingUrl(submittedUrl, [...allowedHosts])
  if (normalized.ok && normalized.s3Url) {
    return { canonicalUrl: normalized.s3Url }
  }
  if (normalized.reason === 'not_https') return { code: 'URL_NOT_HTTPS' }
  if (
    normalized.reason === 'unparseable' ||
    normalized.reason === 'empty_path' ||
    normalized.reason === 'too_many_wrappers'
  ) {
    return { code: 'URL_UNPARSEABLE' }
  }
  return { code: 'URL_NOT_ALLOWLISTED' }
}

/**
 * The stable identity of one canonical URL.
 *
 * Everything outside the single `source_url` column compares URLs through this
 * hash: the item row, the replay check, the batch digest. A hash cannot be
 * accidentally rendered, logged, or exported as a playable link, which is the
 * entire reason it exists.
 */
export function canonicalUrlSha256(canonicalUrl: string): string {
  return createHash('sha256').update(canonicalUrl, 'utf8').digest('hex')
}

/** SHA-256 of the uploaded file exactly as received. Batch provenance. */
export function sourceFileSha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/**
 * Order-independent identity of one exact upload against one month.
 *
 * A retry that re-sends the same tasks and the same canonical URLs in a
 * different row order is the same batch; a retry that quietly adds, drops, or
 * re-points one is not, and is refused as a conflict rather than silently
 * committed a second time. Only hashes go into the digest — never a URL.
 */
export function lateRecordingBatchDigest(input: {
  billMonth: string
  items: ReadonlyArray<{ taskId: string; canonicalUrlSha256: string }>
}): string {
  const sorted = [...input.items]
    .map((item) => ({
      taskId: item.taskId,
      canonicalUrlSha256: item.canonicalUrlSha256,
    }))
    .sort((left, right) => left.taskId.localeCompare(right.taskId))
  return createHash('sha256')
    .update(canonicalJson({ billMonth: input.billMonth, items: sorted }))
    .digest('hex')
}

/** Durable opaque ids for a batch, item, or append-only correction result. */
export function lateRecordingId(prefix: 'lrb' | 'lri' | 'lrc'): string {
  return `${prefix}_${randomUUID()}`
}

/**
 * The bounded code stored against a failed item.
 *
 * A worker may hand back any error code it likes; only a value matching this
 * shape is kept, and anything else becomes one fixed code. Provider prose,
 * SQL, URLs and thrown messages cannot reach the batch through this path.
 */
export function safeLateRecordingFailureCode(value: unknown): string {
  return typeof value === 'string' && /^[A-Z][A-Z0-9_]{2,63}$/.test(value)
    ? value
    : 'LATE_RECORDING_ITEM_FAILED'
}

export interface LateRecordingCommitInput {
  billMonth: string
  idempotencyKey: string
}

/**
 * Validates the non-file part of a submission exactly.
 *
 * Every refusal is the same bounded error: a caller learns that the request
 * was invalid, never which field or which rule rejected it.
 */
export function parseLateRecordingSubmission(value: {
  month?: unknown
  idempotencyKey?: unknown
}): LateRecordingCommitInput {
  const billMonth =
    typeof value.month === 'string' ? value.month.trim() : ''
  if (!BILL_MONTH.test(billMonth)) throw new LateRecordingError()
  const idempotencyKey =
    typeof value.idempotencyKey === 'string' ? value.idempotencyKey : ''
  if (!IDEMPOTENCY_KEY.test(idempotencyKey)) throw new LateRecordingError()
  return { billMonth, idempotencyKey }
}

/**
 * Money at fixed scale-8, always.
 *
 * Correction totals are hashed into an append-only row and compared against
 * amounts read straight out of DECIMAL(20,8) columns, so one amount has to
 * produce one set of bytes whichever path computed it.
 */
export function fixed8(value: string): string {
  const scaled = toScaled(value)
  if (scaled == null) {
    throw new TypeError('late recording amount is not a decimal')
  }
  const negative = scaled < 0n
  const absolute = (negative ? -scaled : scaled).toString().padStart(9, '0')
  return `${negative ? '-' : ''}${absolute.slice(0, -8)}.${absolute.slice(-8)}`
}

/** Fixed-precision sum of scale-8 decimal strings. Never a float. */
export function sumFixed8(values: readonly string[]): string {
  let total = 0n
  for (const value of values) {
    const scaled = toScaled(value)
    if (scaled == null) {
      throw new TypeError('late recording amount is not a decimal')
    }
    total += scaled
  }
  return fixed8(fromScaled(total))
}

export interface LateRecordingCorrectionTotals {
  previousVerifiedTotal: string
  revisedVerifiedTotal: string
  /** revised − previous. NEGATIVE when the correction reduces the bill. */
  deltaAmount: string
  correctedCount: number
}

/**
 * The month's correction arithmetic, at fixed precision.
 *
 * A negative delta is preserved rather than clamped: a late recording can only
 * ever raise a `no_recording_zero` call's amount, but the month total is
 * compared as it was actually recomputed, and a figure that silently refuses
 * to go down is a figure nobody can reconcile.
 */
export function lateRecordingCorrectionTotals(input: {
  previousVerifiedTotal: string
  revisedVerifiedTotal: string
  correctedCount: number
}): LateRecordingCorrectionTotals {
  if (!Number.isInteger(input.correctedCount) || input.correctedCount < 0) {
    throw new TypeError('correctedCount must be a non-negative integer')
  }
  const previous = toScaled(input.previousVerifiedTotal)
  const revised = toScaled(input.revisedVerifiedTotal)
  if (previous == null || revised == null) {
    throw new TypeError('late recording totals must be decimals')
  }
  return {
    previousVerifiedTotal: fixed8(input.previousVerifiedTotal),
    revisedVerifiedTotal: fixed8(input.revisedVerifiedTotal),
    deltaAmount: fixed8(fromScaled(revised - previous)),
    correctedCount: input.correctedCount,
  }
}

/**
 * The proposed Finance adjustment for a month, and NOTHING more.
 *
 * `kaudit_kserve_monthly_settlement` records what Finance actually paid. This
 * workflow corrects what the auditor says was payable, which is a different
 * fact, so it never writes that table. It records a PROPOSAL — the delta, and
 * the variance against what was actually paid — and leaves accepting it as an
 * explicit, append-only Finance action.
 */
export function proposedFinanceAdjustment(input: {
  previousVerifiedTotal: string
  revisedVerifiedTotal: string
  /** The current actual-paid settlement, or null when none is recorded. */
  actualPaidAmount: string | null
}): {
  deltaAmount: string
  revisedVariance: string | null
  settlementAction: 'proposed_finance_adjustment' | 'no_settlement_recorded'
} {
  const previous = toScaled(input.previousVerifiedTotal)
  const revised = toScaled(input.revisedVerifiedTotal)
  if (previous == null || revised == null) {
    throw new TypeError('late recording totals must be decimals')
  }
  const paid = toScaled(input.actualPaidAmount ?? '')
  return {
    deltaAmount: fixed8(fromScaled(revised - previous)),
    // Variance keeps the platform's existing orientation: what was paid minus
    // what the auditor now says was payable.
    revisedVariance: paid == null ? null : fixed8(fromScaled(paid - revised)),
    settlementAction:
      paid == null ? 'no_settlement_recorded' : 'proposed_finance_adjustment',
  }
}
