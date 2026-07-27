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
