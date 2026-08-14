import { canonicalJsonSha256 } from '../messaging/canonicalJson.ts'

/**
 * Domain rules for the MONTHLY KSERVE SETTLEMENT — the one business value an
 * administrator supplies for a bill month: the amount actually paid to KServe
 * after negotiation.
 *
 * Pure. No SQL, no HTTP, no clock of its own, no model call. Everything here is
 * validation, deterministic identity, and fixed-precision subtraction.
 *
 * The invariants this module owns:
 *
 *   * MONEY IS TEXT, and arithmetic is scaled BigInt. `Number`, `parseFloat`,
 *     `+`, and `-` never touch an amount: a rupee figure that survived
 *     DECIMAL(20,8) must not lose its last places to a binary float on the way
 *     to a screen or a report.
 *   * A PAID AMOUNT IS NEVER NEGATIVE. A refund or credit note is a different
 *     business fact with its own approval path, not a minus sign here.
 *   * SAVINGS IS SUBTRACTION AND NOTHING ELSE: the final vendor/KServe billed
 *     charge for the complete month MINUS the current final amount paid. Its
 *     SIGN IS PRESERVED — paying more than was billed is a real, reportable
 *     outcome, and clamping it to zero would hide an overpayment.
 *   * ABSENT IS NOT ZERO. With no settlement recorded, or with no vendor billed
 *     evidence for the month, both "finally paid" and "savings" are
 *     unavailable. Neither is ever reported as 0.00.
 *   * ERRORS NAME A FIELD, NEVER A VALUE. No submitted amount, key, month, or
 *     stored figure appears in an error message, so a refusal is safe to return
 *     to a browser and safe to write to a log.
 */

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Rejected before any statement runs. Names a field, never a value. */
export class KserveSettlementInputError extends Error {
  readonly code = 'INVALID_KSERVE_SETTLEMENT'
  readonly status = 400
  readonly field: string

  constructor(field: string, reason: string) {
    super(`${field}: ${reason}`)
    this.field = field
  }
}

/**
 * A stored version already answers to this request in a way the request
 * contradicts — most importantly the same idempotency key carrying a different
 * amount. The message names the field only; neither the stored nor the
 * submitted amount is echoed.
 */
export class KserveSettlementConflictError extends Error {
  readonly code = 'KSERVE_SETTLEMENT_CONFLICT'
  readonly status = 409
  readonly field: string

  constructor(field: string, reason: string) {
    super(`${field}: ${reason}`)
    this.field = field
  }
}

/**
 * The settlement store could not answer. Deliberately carries NOTHING about the
 * cause: an unknown driver error, a lost connection, or a constraint the
 * application did not anticipate all surface as this one bounded refusal, so no
 * database prose, provider prose, or thrown message can reach a caller or a log.
 */
export class KserveSettlementUnavailableError extends Error {
  readonly code = 'KSERVE_SETTLEMENT_UNAVAILABLE'
  readonly status = 503

  constructor() {
    super('Monthly settlement storage is unavailable')
  }
}

/**
 * Wraps anything that is not already a typed settlement failure.
 *
 * Used at every boundary that touches the driver. A duplicate-key race, a
 * dropped connection and a bug all become the same bounded 503, and the
 * original error — which may quote SQL, a column value, or a stored amount —
 * is dropped here rather than carried outward.
 */
export function asSafeSettlementError(error: unknown): Error {
  if (
    error instanceof KserveSettlementInputError ||
    error instanceof KserveSettlementConflictError ||
    error instanceof KserveSettlementUnavailableError
  ) {
    return error
  }
  return new KserveSettlementUnavailableError()
}

// ---------------------------------------------------------------------------
// Fixed-precision money
// ---------------------------------------------------------------------------

/** DECIMAL(20,8): the platform's money type. */
export const MONEY_SCALE_DIGITS = 8
const MONEY_SCALE = 10n ** BigInt(MONEY_SCALE_DIGITS)

/**
 * The largest amount this surface accepts: eleven integer digits, comfortably
 * inside DECIMAL(20,8)'s twelve, so a valid input can never be silently
 * truncated or rejected by the column instead of by this check.
 */
export const MAX_FINAL_PAID_AMOUNT_INR = '99999999999.99999999'
const MAX_FINAL_PAID_SCALED = 9_999_999_999_999_999_999n

/**
 * Input length bound, applied BEFORE the grammar. It is generous next to the
 * value bound above and exists to stop a megabyte of digits from being
 * regex-matched and BigInt-parsed at all.
 */
export const MAX_AMOUNT_TEXT_LENGTH = 32

/**
 * Exact decimal grammar: optional sign, digits, optional fraction. No
 * exponent, no thousands separator, no leading '+', no whitespace inside, no
 * bare '.5' or '5.'. Anything outside it is refused rather than coerced.
 */
const EXACT_DECIMAL = /^(-?)(\d{1,12})(?:\.(\d{1,8}))?$/

/**
 * Parses exact decimal TEXT into a scaled integer.
 *
 * `Number` and `parseFloat` are deliberately absent: `Number('0.1')` is not
 * 0.1, and a money path that admits one float admits every rounding error
 * downstream of it. Only the digit characters are read, and they are read into
 * a BigInt.
 */
export function parseExactDecimal(
  value: unknown,
  field: string,
): bigint {
  if (typeof value !== 'string') {
    throw new KserveSettlementInputError(field, 'must be a decimal string')
  }
  const text = value.trim()
  if (text === '') {
    throw new KserveSettlementInputError(field, 'must not be blank')
  }
  if (text.length > MAX_AMOUNT_TEXT_LENGTH) {
    throw new KserveSettlementInputError(
      field,
      `must be at most ${MAX_AMOUNT_TEXT_LENGTH} characters`,
    )
  }
  const match = EXACT_DECIMAL.exec(text)
  if (!match) {
    throw new KserveSettlementInputError(
      field,
      'must be a plain decimal amount with at most 12 whole digits and ' +
        '8 decimal places',
    )
  }
  const [, sign, whole, fraction = ''] = match
  const magnitude = BigInt(
    `${whole}${fraction.padEnd(MONEY_SCALE_DIGITS, '0')}`,
  )
  return sign === '-' ? -magnitude : magnitude
}

/** Scaled integer back to fixed-precision text with exactly eight places. */
export function formatScaledMoney(value: bigint): string {
  const negative = value < 0n
  const digits = (negative ? -value : value)
    .toString()
    .padStart(MONEY_SCALE_DIGITS + 1, '0')
  const whole = digits.slice(0, -MONEY_SCALE_DIGITS)
  const fraction = digits.slice(-MONEY_SCALE_DIGITS)
  return `${negative ? '-' : ''}${whole}.${fraction}`
}

/**
 * The administrator's amount: exact decimal text, non-negative, bounded.
 *
 * A negative amount is refused HERE rather than left to the column's check
 * constraint, so the caller gets a named field instead of a driver error, and
 * so no negative value is ever bound to a statement in the first place.
 */
export function parseFinalPaidAmount(value: unknown): string {
  const scaled = parseExactDecimal(value, 'finalPaidAmountInr')
  if (scaled < 0n) {
    throw new KserveSettlementInputError(
      'finalPaidAmountInr',
      'must not be negative; a refund is a separate approved decision',
    )
  }
  if (scaled > MAX_FINAL_PAID_SCALED) {
    throw new KserveSettlementInputError(
      'finalPaidAmountInr',
      `must be at most ${MAX_FINAL_PAID_AMOUNT_INR}`,
    )
  }
  return formatScaledMoney(scaled)
}

/**
 * Normalizes a decimal the DATABASE produced, without accepting anything else.
 *
 * Stored money is trusted to be a decimal, but not trusted to be formatted:
 * MySQL renders DECIMAL(20,8) with all eight places while a SUM() over an
 * empty set arrives as NULL and a computed column can arrive with a different
 * scale. Null stays null so "no evidence" never becomes "0.00".
 */
export function readStoredDecimal(
  value: unknown,
  field: string,
): string | null {
  if (value === null || value === undefined) return null
  return formatScaledMoney(parseExactDecimal(String(value), field))
}

/**
 * Savings for the month: vendor/KServe billed charge MINUS the amount finally
 * paid, in scaled integer arithmetic.
 *
 * Null when either side is missing — an unrecorded settlement or a month with
 * no vendor billed evidence yields "unavailable", never a zero that would read
 * as "we saved nothing". The sign is preserved: a negative result means the
 * payment exceeded what was billed.
 */
export function calculateSettlementSavings(
  vendorBilledChargeInr: string | null,
  finalPaidAmountInr: string | null,
): string | null {
  if (vendorBilledChargeInr == null || finalPaidAmountInr == null) {
    return null
  }
  return formatScaledMoney(
    parseExactDecimal(vendorBilledChargeInr, 'vendorBilledChargeInr') -
      parseExactDecimal(finalPaidAmountInr, 'finalPaidAmountInr'),
  )
}

// ---------------------------------------------------------------------------
// Period identity
// ---------------------------------------------------------------------------

const BILL_MONTH = /^(\d{4})-(\d{2})$/
const MIN_BILL_YEAR = 2000
const MAX_BILL_YEAR = 2100

/**
 * The monthly period identity, `YYYY-MM`.
 *
 * A settlement covers a WHOLE month and nothing else, so there is no "all
 * periods" settlement and no partial range: a missing or open-ended month is a
 * refused request, not a silent aggregate over everything ever billed.
 */
export function parseSettlementMonth(value: unknown): string {
  if (typeof value !== 'string') {
    throw new KserveSettlementInputError('month', 'must be a YYYY-MM string')
  }
  const text = value.trim()
  const match = BILL_MONTH.exec(text)
  if (!match) {
    throw new KserveSettlementInputError('month', 'must use YYYY-MM')
  }
  const year = Number(match[1])
  const month = Number(match[2])
  if (
    year < MIN_BILL_YEAR ||
    year > MAX_BILL_YEAR ||
    month < 1 ||
    month > 12
  ) {
    throw new KserveSettlementInputError(
      'month',
      'is outside the supported range',
    )
  }
  return text
}

/** Inclusive calendar bounds of a validated bill month, in UTC. */
export function settlementMonthBounds(billMonth: string): {
  periodStart: string
  periodEnd: string
} {
  const [year, month] = billMonth.split('-').map(Number)
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate()
  return {
    periodStart: `${billMonth}-01`,
    periodEnd: `${billMonth}-${String(lastDay).padStart(2, '0')}`,
  }
}

// ---------------------------------------------------------------------------
// Idempotency and identity
// ---------------------------------------------------------------------------

/** Matches the varchar(80) column; the grammar keeps it a machine token. */
export const MAX_IDEMPOTENCY_KEY_LENGTH = 80
const MIN_IDEMPOTENCY_KEY_LENGTH = 8
const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]+$/

export function parseIdempotencyKey(value: unknown): string {
  if (typeof value !== 'string') {
    throw new KserveSettlementInputError('idempotencyKey', 'must be a string')
  }
  const text = value.trim()
  if (
    text.length < MIN_IDEMPOTENCY_KEY_LENGTH ||
    text.length > MAX_IDEMPOTENCY_KEY_LENGTH
  ) {
    throw new KserveSettlementInputError(
      'idempotencyKey',
      `must be ${MIN_IDEMPOTENCY_KEY_LENGTH} to ` +
        `${MAX_IDEMPOTENCY_KEY_LENGTH} characters`,
    )
  }
  if (!IDEMPOTENCY_KEY.test(text)) {
    throw new KserveSettlementInputError(
      'idempotencyKey',
      'must use letters, digits, hyphen, or underscore only',
    )
  }
  return text
}

/** kaudit_user.id of the administrator. Provenance only; never returned. */
export const MAX_ACTOR_ID_LENGTH = 40
export const MAX_CORRELATION_ID_LENGTH = 120

function optionalToken(
  value: unknown,
  field: string,
  maxLength: number,
): string | null {
  if (value === null || value === undefined) return null
  if (typeof value !== 'string') {
    throw new KserveSettlementInputError(field, 'must be a string or null')
  }
  const text = value.trim()
  if (text === '') return null
  if (text.length > maxLength) {
    throw new KserveSettlementInputError(
      field,
      `must be at most ${maxLength} characters`,
    )
  }
  return text
}

export const KSERVE_SETTLEMENT_CURRENCY = 'INR'

/** Everything a caller may supply. Nothing else reaches a column. */
export interface RecordSettlementRequest {
  month: unknown
  finalPaidAmountInr: unknown
  idempotencyKey: unknown
  recordedByUserId?: unknown
  correlationId?: unknown
}

export interface ValidatedSettlementRequest {
  billMonth: string
  periodStart: string
  periodEnd: string
  currency: typeof KSERVE_SETTLEMENT_CURRENCY
  finalPaidAmountInr: string
  idempotencyKey: string
  recordedByUserId: string | null
  correlationId: string | null
  /** Deterministic id of the row this request would create or replay. */
  settlementId: string
  /** Digest of the payload, so a retry can be proven identical. */
  requestDigest: string
}

/**
 * Stable prefix, so a raw id is self-describing in a log or a join. Four
 * characters of prefix plus thirty-six of digest fill the varchar(40) exactly.
 */
const SETTLEMENT_ID_PREFIX = 'kms_'
const ID_HASH_LENGTH = 40 - SETTLEMENT_ID_PREFIX.length

/**
 * Deterministic row id, derived from exactly the pair the database already
 * makes unique (`uq_kserve_settlement_month_key`). A retried writer therefore
 * computes the same id, and an id can be logged without carrying the amount.
 */
export function buildSettlementId(
  billMonth: string,
  idempotencyKey: string,
): string {
  const digest = canonicalJsonSha256({ billMonth, idempotencyKey })
  return `${SETTLEMENT_ID_PREFIX}${digest.slice(0, ID_HASH_LENGTH)}`
}

/**
 * Digest of everything that makes the request what it is.
 *
 * The AMOUNT is the point: a retry that carries the same key with a different
 * amount produces a different digest and is refused as a conflict instead of
 * quietly replaying the first save — or, worse, appending a second version the
 * administrator never asked for. The actor and correlation id are deliberately
 * excluded: the same correction submitted twice is the same correction even
 * when the second attempt arrives on a new request.
 */
export function buildSettlementRequestDigest(input: {
  billMonth: string
  currency: string
  finalPaidAmountInr: string
  idempotencyKey: string
}): string {
  return canonicalJsonSha256({
    billMonth: input.billMonth,
    currency: input.currency,
    finalPaidAmountInr: input.finalPaidAmountInr,
    idempotencyKey: input.idempotencyKey,
  })
}

/**
 * Validates a save request completely, before any connection is taken. Every
 * failure names a field and quotes nothing.
 */
export function validateRecordSettlementRequest(
  request: RecordSettlementRequest,
): ValidatedSettlementRequest {
  if (!request || typeof request !== 'object') {
    throw new KserveSettlementInputError('request', 'must be an object')
  }
  const billMonth = parseSettlementMonth(request.month)
  const bounds = settlementMonthBounds(billMonth)
  const finalPaidAmountInr = parseFinalPaidAmount(request.finalPaidAmountInr)
  const idempotencyKey = parseIdempotencyKey(request.idempotencyKey)
  return {
    billMonth,
    periodStart: bounds.periodStart,
    periodEnd: bounds.periodEnd,
    currency: KSERVE_SETTLEMENT_CURRENCY,
    finalPaidAmountInr,
    idempotencyKey,
    recordedByUserId: optionalToken(
      request.recordedByUserId,
      'recordedByUserId',
      MAX_ACTOR_ID_LENGTH,
    ),
    correlationId: optionalToken(
      request.correlationId,
      'correlationId',
      MAX_CORRELATION_ID_LENGTH,
    ),
    settlementId: buildSettlementId(billMonth, idempotencyKey),
    requestDigest: buildSettlementRequestDigest({
      billMonth,
      currency: KSERVE_SETTLEMENT_CURRENCY,
      finalPaidAmountInr,
      idempotencyKey,
    }),
  }
}

// ---------------------------------------------------------------------------
// History bounds
// ---------------------------------------------------------------------------

/**
 * Server-side maximum number of versions any read returns.
 *
 * History is reviewable, not unbounded: a month that somehow accumulated
 * thousands of corrections must not be able to turn one page load into an
 * unbounded result set. The newest versions are the ones that matter, so the
 * cut is taken from the oldest end and the response says it was truncated.
 */
export const MAX_SETTLEMENT_HISTORY = 50
export const DEFAULT_SETTLEMENT_HISTORY = 10

export function parseHistoryLimit(raw: string | null | undefined): number {
  if (raw == null || raw.trim() === '') return DEFAULT_SETTLEMENT_HISTORY
  if (!/^\d{1,3}$/.test(raw.trim())) {
    throw new KserveSettlementInputError(
      'history',
      `must be an integer between 1 and ${MAX_SETTLEMENT_HISTORY}`,
    )
  }
  const value = Number(raw.trim())
  if (value < 1 || value > MAX_SETTLEMENT_HISTORY) {
    throw new KserveSettlementInputError(
      'history',
      `must be an integer between 1 and ${MAX_SETTLEMENT_HISTORY}`,
    )
  }
  return value
}
