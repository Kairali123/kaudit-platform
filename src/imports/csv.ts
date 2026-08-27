export const REQUIRED_USAGE_HEADERS = [
  'Task ID',
  'Destination Number',
  'Call Start Time',
  'Call Connected Time',
  'Call End Time',
  'Duration (Seconds) With Ringing',
  'Duration (Seconds) Without Ringing',
  'Duration (Minutes) - Actual Billing Mins',
  'Actual Billing Amount',
  'Recording URL',
] as const

export interface UsageRow {
  taskId: string
  destinationNumber: string
  callStartTime: string
  callConnectedTime: string
  callEndTime: string
  durationWithRingingSec: string
  durationWithoutRingingSec: string
  durationMinutes: string
  billedAmount: string | null
  recordingUrl: string | null
}

export class UsageCsvError extends Error {
  readonly code = 'INVALID_USAGE_CSV'
  readonly status = 400
}

/**
 * One bounded per-row validation failure.
 *
 * `field` is a canonical input-contract field name and `code` comes from a
 * closed allowlist. Neither ever carries the offending cell value, so these
 * descriptors are safe to return to the importing client.
 */
export interface UsageRowIssue {
  rowIndex: number
  field: string
  code:
    | 'TASK_ID_REQUIRED'
    | 'TASK_ID_DUPLICATE'
    | 'DURATION_INVALID'
    | 'AMOUNT_INVALID'
}

export const MAX_REPORTED_USAGE_ROW_ISSUES = 1000

/**
 * Parses usage CSV rows WITHOUT failing the whole batch on the first bad row.
 *
 * Structural contract checks are collected per data row (0-based, excluding
 * the header) so a caller can reject a batch atomically while telling the
 * importer exactly which spreadsheet rows are permanently invalid. Duplicate
 * Task IDs inside one batch flag every repeat occurrence; the first occurrence
 * remains valid.
 */
export function scanUsageCsv(bytes: Buffer): {
  /** Every CSV data row in original order; null where structurally invalid. */
  entries: Array<{ rowIndex: number; row: UsageRow | null }>
  issues: UsageRowIssue[]
} {
  const text = bytes.toString('utf8').replace(/^\uFEFF/, '')
  const rows = parseRows(text)
  const headers = rows.shift()
  if (!headers) throw new UsageCsvError('CSV is empty')
  const index = new Map(headers.map((header, position) => [header, position]))
  const missing = REQUIRED_USAGE_HEADERS.filter((header) => !index.has(header))
  if (missing.length) {
    throw new UsageCsvError(`Missing required columns: ${missing.join(', ')}`)
  }
  const issues: UsageRowIssue[] = []
  const seenTaskIds = new Set<string>()
  const entries: Array<{ rowIndex: number; row: UsageRow | null }> = []
  rows.forEach((values, rowIndex) => {
    const value = (header: (typeof REQUIRED_USAGE_HEADERS)[number]): string =>
      values[index.get(header) as number]?.trim() || ''
    const taskId = value('Task ID')
    let rowValid = true
    if (!taskId) {
      issues.push({ rowIndex, field: 'taskId', code: 'TASK_ID_REQUIRED' })
      rowValid = false
    } else if (seenTaskIds.has(taskId)) {
      issues.push({ rowIndex, field: 'taskId', code: 'TASK_ID_DUPLICATE' })
      rowValid = false
    } else {
      seenTaskIds.add(taskId)
    }
    for (const durationHeader of [
      'Duration (Seconds) With Ringing',
      'Duration (Seconds) Without Ringing',
      'Duration (Minutes) - Actual Billing Mins',
    ] as const) {
      if (!/^\d+(?:\.\d+)?$/.test(value(durationHeader))) {
        issues.push({
          rowIndex,
          field:
            durationHeader === 'Duration (Seconds) With Ringing'
              ? 'durationWithRingingSec'
              : durationHeader === 'Duration (Seconds) Without Ringing'
                ? 'durationWithoutRingingSec'
                : 'durationMinutes',
          code: 'DURATION_INVALID',
        })
        rowValid = false
      }
    }
    const billedAmount = value('Actual Billing Amount')
    if (billedAmount && !/^\d+(?:\.\d{1,8})?$/.test(billedAmount)) {
      issues.push({ rowIndex, field: 'billedAmount', code: 'AMOUNT_INVALID' })
      rowValid = false
    }
    if (!rowValid) {
      entries.push({ rowIndex, row: null })
      return
    }
    entries.push({
      rowIndex,
      row: {
        taskId,
        destinationNumber: value('Destination Number'),
        callStartTime: value('Call Start Time'),
        callConnectedTime: value('Call Connected Time'),
        callEndTime: value('Call End Time'),
        durationWithRingingSec: value('Duration (Seconds) With Ringing'),
        durationWithoutRingingSec: value('Duration (Seconds) Without Ringing'),
        durationMinutes: value('Duration (Minutes) - Actual Billing Mins'),
        billedAmount: billedAmount || null,
        recordingUrl: value('Recording URL') || null,
      },
    })
  })
  return { entries, issues }
}

function parseRows(input: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  for (let index = 0; index < input.length; index += 1) {
    const character = input[index]
    if (quoted) {
      if (character === '"' && input[index + 1] === '"') {
        field += '"'
        index += 1
      } else if (character === '"') {
        quoted = false
      } else {
        field += character
      }
      continue
    }
    if (character === '"' && field.length === 0) {
      quoted = true
    } else if (character === ',') {
      row.push(field.trim())
      field = ''
    } else if (character === '\n') {
      row.push(field.trim())
      rows.push(row)
      row = []
      field = ''
    } else if (character !== '\r') {
      field += character
    }
  }
  if (quoted) throw new UsageCsvError('CSV contains an unterminated quoted value')
  if (field.length > 0 || row.length > 0) {
    row.push(field.trim())
    rows.push(row)
  }
  return rows.filter((values) => values.some(Boolean))
}

export function parseUsageCsv(bytes: Buffer): UsageRow[] {
  const text = bytes.toString('utf8').replace(/^\uFEFF/, '')
  const rows = parseRows(text)
  const headers = rows.shift()
  if (!headers) throw new UsageCsvError('CSV is empty')
  const index = new Map(headers.map((header, position) => [header, position]))
  const missing = REQUIRED_USAGE_HEADERS.filter((header) => !index.has(header))
  if (missing.length) {
    throw new UsageCsvError(`Missing required columns: ${missing.join(', ')}`)
  }
  const taskIds = new Set<string>()
  return rows.map((values, rowIndex) => {
    const value = (header: (typeof REQUIRED_USAGE_HEADERS)[number]): string =>
      values[index.get(header) as number]?.trim() || ''
    const taskId = value('Task ID')
    if (!taskId) throw new UsageCsvError(`Row ${rowIndex + 2}: Task ID is required`)
    if (taskIds.has(taskId)) {
      throw new UsageCsvError(`Row ${rowIndex + 2}: duplicate Task ID`)
    }
    taskIds.add(taskId)
    for (const durationHeader of [
      'Duration (Seconds) With Ringing',
      'Duration (Seconds) Without Ringing',
      'Duration (Minutes) - Actual Billing Mins',
    ] as const) {
      const raw = value(durationHeader)
      if (!/^\d+(?:\.\d+)?$/.test(raw)) {
        throw new UsageCsvError(
          `Row ${rowIndex + 2}: ${durationHeader} must be a non-negative number`,
        )
      }
    }
    const billedAmount = value('Actual Billing Amount')
    if (billedAmount && !/^\d+(?:\.\d{1,8})?$/.test(billedAmount)) {
      throw new UsageCsvError(
        `Row ${rowIndex + 2}: Actual Billing Amount must be a non-negative decimal with at most 8 decimal places`,
      )
    }
    return {
      taskId,
      destinationNumber: value('Destination Number'),
      callStartTime: value('Call Start Time'),
      callConnectedTime: value('Call Connected Time'),
      callEndTime: value('Call End Time'),
      durationWithRingingSec: value('Duration (Seconds) With Ringing'),
      durationWithoutRingingSec: value('Duration (Seconds) Without Ringing'),
      durationMinutes: value('Duration (Minutes) - Actual Billing Mins'),
      billedAmount: billedAmount || null,
      recordingUrl: value('Recording URL') || null,
    }
  })
}
