export interface ImportStatus {
  enabled: boolean
  storageBoundary: string
  recentBatches: Array<{
    id: string
    type: string
    periodStart: string | null
    periodEnd: string | null
    status: string
    received: number
    accepted: number
    rejected: number
    duplicates: number
    startedAt: string
  }>
  recentInvoices: Array<{
    id: string
    invoiceNumber: string
    periodStart: string
    periodEnd: string
    totalAmount: string
    status: string
  }>
}

export interface UsageImportRequest {
  bytes: Buffer
  filename: string
  periodStart: string
  periodEnd: string
  correlationId: string
}

export interface InvoiceImportRequest {
  bytes: Buffer
  filename: string
  invoiceNumber: string
  invoiceDate: string
  periodStart: string
  periodEnd: string
  subtotalAmount: string
  taxAmount: string
  totalAmount: string
  correlationId: string
}

/**
 * One bounded per-row usage validation failure, safe to return to the
 * importing client: a batch-relative 0-based row index, a canonical field
 * name, and an allowlisted error code. Never the offending value.
 */
export interface UsageRowIssue {
  rowIndex: number
  field: string
  code: string
}

/**
 * A usage batch that contains permanently invalid rows.
 *
 * The batch itself is refused atomically (no Drive object, no database rows),
 * but the client receives bounded descriptors so it can mark exactly those
 * source rows as needing review and resubmit only the valid remainder.
 */
export class UsageImportValidationError extends Error {
  readonly code = 'INVALID_IMPORT_ROWS'
  readonly status = 400
  readonly issues: readonly UsageRowIssue[]
  constructor(issues: readonly UsageRowIssue[]) {
    super('Usage batch contains invalid rows')
    this.issues = issues
  }
}

export interface ImportResult {
  outcome: 'imported' | 'duplicate'
  referenceId: string
  received: number
  accepted: number
  duplicates: number
  auditJobsQueued: number
  missingRecordingUrls: number
}

export interface CycleImportService {
  status(): Promise<ImportStatus>
  importUsage(request: UsageImportRequest): Promise<ImportResult>
  importInvoice(request: InvoiceImportRequest): Promise<ImportResult>
}
