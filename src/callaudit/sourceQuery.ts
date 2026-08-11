import { normalizeSourceRowId } from './sourceRowId.ts'
import type { InternalSourceCandidate } from './sourceTypes.ts'

export class CallAuditSourceQueryError extends Error {
  readonly code = 'INVALID_CALL_AUDIT_SOURCE_QUERY'
}

/** Largest batch a single read may claim, so one query cannot scan the table. */
export const MAX_SOURCE_BATCH_SIZE = 1000

/**
 * UTC-naive datetime literal, matching the source columns.
 *
 * The caller must supply boundaries ALREADY CONVERTED to the source's UTC-naive
 * form. A trailing Z or a numeric offset is rejected rather than converted: a
 * silent conversion here would shift every boundary and quietly change which
 * calls a period contains. Turning an Asia/Kolkata calendar period into these
 * boundaries is a scheduling concern, deliberately outside this module.
 */
const NAIVE_DATETIME =
  /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?$/

/** Keyset position: the last row already consumed. */
export interface SourceCandidateCursor {
  effectiveCallTime: string
  /** Canonical decimal string; the source column is BIGINT. */
  sourceRowId: string
}

export interface SourceCandidateQuery {
  /** Inclusive period start, UTC-naive. */
  periodStart: string
  /** EXCLUSIVE period end, UTC-naive. */
  periodEndExclusive: string
  batchSize: number
  cursor?: SourceCandidateCursor | null
}

export interface ValidatedSourceCandidateQuery {
  periodStart: string
  periodEndExclusive: string
  batchSize: number
  cursor: SourceCandidateCursor | null
}

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeapYear(year) ? 29 : 28
  return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31
}

/**
 * Normalizes to 'YYYY-MM-DD HH:MM:SS.ffffff' so comparison is lexicographic.
 *
 * Every component is checked explicitly against the Gregorian calendar. Date
 * parsing is deliberately NOT used: JavaScript rolls impossible dates forward,
 * so '2026-02-30' would become 2 March and a caller's typo would silently
 * shift the audited period.
 */
function normalizeDatetime(value: unknown, label: string): string {
  if (typeof value !== 'string') {
    throw new CallAuditSourceQueryError(`${label} must be a string`)
  }
  const match = NAIVE_DATETIME.exec(value.trim())
  if (!match) {
    throw new CallAuditSourceQueryError(
      `${label} must be a UTC-naive 'YYYY-MM-DD HH:MM:SS' datetime`,
    )
  }
  const [, yearText, monthText, dayText, hourText, minuteText, secondText] =
    match
  const fraction = match[7] ?? ''
  const year = Number(yearText)
  const month = Number(monthText)
  const day = Number(dayText)
  const hour = Number(hourText)
  const minute = Number(minuteText)
  const second = Number(secondText)

  if (year < 1) {
    throw new CallAuditSourceQueryError(`${label} has an invalid year`)
  }
  if (month < 1 || month > 12) {
    throw new CallAuditSourceQueryError(`${label} has an invalid month`)
  }
  if (day < 1 || day > daysInMonth(year, month)) {
    throw new CallAuditSourceQueryError(
      `${label} has an invalid day for that month`,
    )
  }
  if (hour > 23) {
    throw new CallAuditSourceQueryError(`${label} has an invalid hour`)
  }
  if (minute > 59) {
    throw new CallAuditSourceQueryError(`${label} has an invalid minute`)
  }
  if (second > 59) {
    throw new CallAuditSourceQueryError(`${label} has an invalid second`)
  }
  return (
    `${yearText}-${monthText}-${dayText} ` +
    `${hourText}:${minuteText}:${secondText}.${fraction.padEnd(6, '0')}`
  )
}

/**
 * Validates the half-open period, the batch size, and the keyset cursor before
 * any SQL runs. Everything reaching the adapter is a checked placeholder value.
 */
export function validateSourceCandidateQuery(
  query: SourceCandidateQuery,
): ValidatedSourceCandidateQuery {
  const periodStart = normalizeDatetime(query.periodStart, 'periodStart')
  const periodEndExclusive = normalizeDatetime(
    query.periodEndExclusive,
    'periodEndExclusive',
  )
  if (periodEndExclusive <= periodStart) {
    throw new CallAuditSourceQueryError(
      'periodEndExclusive must be strictly after periodStart',
    )
  }

  const { batchSize } = query
  if (
    typeof batchSize !== 'number' ||
    !Number.isSafeInteger(batchSize) ||
    batchSize < 1 ||
    batchSize > MAX_SOURCE_BATCH_SIZE
  ) {
    throw new CallAuditSourceQueryError(
      `batchSize must be an integer between 1 and ${MAX_SOURCE_BATCH_SIZE}`,
    )
  }

  const cursor = query.cursor ?? null
  if (cursor === null) {
    return { periodStart, periodEndExclusive, batchSize, cursor: null }
  }
  if (typeof cursor !== 'object') {
    throw new CallAuditSourceQueryError('cursor must be an object or null')
  }
  const effectiveCallTime = normalizeDatetime(
    cursor.effectiveCallTime,
    'cursor.effectiveCallTime',
  )
  // A cursor outside the period would either re-scan rows already audited or
  // skip the head of the period entirely.
  if (effectiveCallTime < periodStart) {
    throw new CallAuditSourceQueryError(
      'cursor.effectiveCallTime must not precede periodStart',
    )
  }
  if (effectiveCallTime >= periodEndExclusive) {
    throw new CallAuditSourceQueryError(
      'cursor.effectiveCallTime must be before periodEndExclusive',
    )
  }
  const sourceRowId = normalizeSourceRowId(cursor.sourceRowId)
  if (sourceRowId === null) {
    throw new CallAuditSourceQueryError(
      'cursor.sourceRowId must be a canonical positive decimal within BIGINT range',
    )
  }
  return {
    periodStart,
    periodEndExclusive,
    batchSize,
    cursor: { effectiveCallTime, sourceRowId },
  }
}

/**
 * Cursor for the next page, or null when the batch was empty. Callers page by
 * passing this back — never by an OFFSET, which would skip or repeat rows as
 * the source changes underneath a long reconciliation.
 */
export function nextSourceCandidateCursor(
  candidates: readonly InternalSourceCandidate[],
): SourceCandidateCursor | null {
  const last = candidates[candidates.length - 1]
  if (!last) {
    return null
  }
  return {
    effectiveCallTime: last.effectiveCallTime,
    sourceRowId: last.sourceRowId,
  }
}
