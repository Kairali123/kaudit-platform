import OpenAI from 'openai'
import {
  parseUsageCsv,
  REQUIRED_USAGE_HEADERS,
} from './csv.ts'

export const INVOICE_EXTRACTION_MODEL =
  'gpt-4o-mini-2024-07-18'

export interface UsageImportPreview {
  method: 'deterministic'
  periodStart: string
  periodEnd: string
  rowCount: number
  recordingUrlCount: number
  missingRecordingUrlCount: number
  recognizedColumns: string[]
  warnings: string[]
}

export interface InvoiceImportPreview {
  method: 'openai'
  model: string
  invoiceNumber: string
  invoiceDate: string
  periodStart: string
  periodEnd: string
  subtotalAmount: string
  taxAmount: string
  totalAmount: string
  currency: 'INR'
  confidence: string
  warnings: string[]
}

export interface ImportAnalysisService {
  readonly invoiceAiEnabled: boolean
  analyzeUsage(bytes: Buffer): Promise<UsageImportPreview>
  analyzeInvoice(
    bytes: Buffer,
    filename: string,
  ): Promise<InvoiceImportPreview>
}

interface InvoiceExtraction {
  invoice_number: string | null
  invoice_date: string | null
  period_start: string | null
  period_end: string | null
  subtotal_amount: string | null
  tax_amount: string | null
  total_amount: string | null
  currency: 'INR'
  confidence: number
  warnings: string[]
}

const invoiceSchema = {
  type: 'json_schema',
  name: 'kserve_invoice_metadata',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      invoice_number: {
        anyOf: [{ type: 'string' }, { type: 'null' }],
      },
      invoice_date: {
        anyOf: [
          { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
          { type: 'null' },
        ],
      },
      period_start: {
        anyOf: [
          { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
          { type: 'null' },
        ],
      },
      period_end: {
        anyOf: [
          { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
          { type: 'null' },
        ],
      },
      subtotal_amount: {
        anyOf: [
          { type: 'string', pattern: '^\\d+(?:\\.\\d{1,2})?$' },
          { type: 'null' },
        ],
      },
      tax_amount: {
        anyOf: [
          { type: 'string', pattern: '^\\d+(?:\\.\\d{1,2})?$' },
          { type: 'null' },
        ],
      },
      total_amount: {
        anyOf: [
          { type: 'string', pattern: '^\\d+(?:\\.\\d{1,2})?$' },
          { type: 'null' },
        ],
      },
      currency: { type: 'string', enum: ['INR'] },
      confidence: { type: 'number', minimum: 0, maximum: 1 },
      warnings: {
        type: 'array',
        items: { type: 'string', maxLength: 240 },
        maxItems: 10,
      },
    },
    required: [
      'invoice_number',
      'invoice_date',
      'period_start',
      'period_end',
      'subtotal_amount',
      'tax_amount',
      'total_amount',
      'currency',
      'confidence',
      'warnings',
    ],
  },
} as const

function datePart(value: string): string | null {
  const iso = value.match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`
  const indian = value.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/)
  if (!indian) return null
  return `${indian[3]}-${indian[2].padStart(2, '0')}-${indian[1].padStart(2, '0')}`
}

export function analyzeUsageCsv(
  bytes: Buffer,
): UsageImportPreview {
  const rows = parseUsageCsv(bytes)
  if (rows.length === 0) {
    throw new Error('Usage CSV contains no call rows')
  }
  const dates = rows
    .map((row) => datePart(row.callStartTime))
    .filter((value): value is string => value != null)
    .sort()
  if (dates.length === 0) {
    throw new Error(
      'Usage CSV does not contain a recognizable Call Start Time',
    )
  }
  const recordingUrlCount = rows.filter(
    (row) => row.recordingUrl,
  ).length
  const warnings: string[] = []
  if (dates.length !== rows.length) {
    warnings.push(
      `${rows.length - dates.length} rows have an unrecognized Call Start Time; verify the period before submitting.`,
    )
  }
  if (recordingUrlCount !== rows.length) {
    warnings.push(
      `${rows.length - recordingUrlCount} rows have no recording URL and will remain explicitly unaudited.`,
    )
  }
  return {
    method: 'deterministic',
    periodStart: dates[0] as string,
    periodEnd: dates.at(-1) as string,
    rowCount: rows.length,
    recordingUrlCount,
    missingRecordingUrlCount: rows.length - recordingUrlCount,
    recognizedColumns: [...REQUIRED_USAGE_HEADERS],
    warnings,
  }
}

function cleanDate(value: string | null): string {
  return value && /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? value
    : ''
}

function cleanMoney(value: string | null): string {
  return value && /^\d+(?:\.\d{1,2})?$/.test(value)
    ? Number(value).toFixed(2)
    : ''
}

export function normalizeInvoiceExtraction(
  value: InvoiceExtraction,
  model = INVOICE_EXTRACTION_MODEL,
): InvoiceImportPreview {
  if (
    !Number.isFinite(value.confidence) ||
    value.confidence < 0 ||
    value.confidence > 1
  ) {
    throw new Error('Invoice extraction returned invalid confidence')
  }
  return {
    method: 'openai',
    model,
    invoiceNumber: value.invoice_number?.trim() || '',
    invoiceDate: cleanDate(value.invoice_date),
    periodStart: cleanDate(value.period_start),
    periodEnd: cleanDate(value.period_end),
    subtotalAmount: cleanMoney(value.subtotal_amount),
    taxAmount: cleanMoney(value.tax_amount),
    totalAmount: cleanMoney(value.total_amount),
    currency: 'INR',
    confidence: value.confidence.toFixed(4),
    warnings: value.warnings.map((warning) => warning.trim()).filter(Boolean),
  }
}

export function createImportAnalysisService(
  apiKey: string | null,
): ImportAnalysisService {
  const client = apiKey?.trim()
    ? new OpenAI({
        apiKey,
        maxRetries: 3,
        timeout: 120_000,
      })
    : null
  return {
    invoiceAiEnabled: client != null,
    async analyzeUsage(bytes) {
      return analyzeUsageCsv(bytes)
    },
    async analyzeInvoice(bytes, filename) {
      if (!client) {
        const error = new Error(
          'OPENAI_API_KEY is required for invoice analysis',
        )
        Object.assign(error, {
          code: 'IMPORT_ANALYSIS_NOT_CONFIGURED',
          status: 503,
        })
        throw error
      }
      if (
        bytes.byteLength < 5 ||
        bytes.subarray(0, 5).toString('ascii') !== '%PDF-'
      ) {
        throw new Error('Invoice upload is not a valid PDF')
      }
      const response = await client.responses.create({
        model: INVOICE_EXTRACTION_MODEL,
        store: false,
        input: [
          {
            role: 'user',
            content: [
              {
                type: 'input_file',
                filename: filename.slice(0, 120),
                file_data: `data:application/pdf;base64,${bytes.toString('base64')}`,
                detail: 'low',
              },
              {
                type: 'input_text',
                text: `Extract only printed billing metadata from this KServe invoice.
Return dates as YYYY-MM-DD and monetary values as non-negative decimal strings
without commas or currency symbols. Do not calculate or infer a missing amount.
The service period may appear in a line-item description. Use null for anything
not present and explain uncertainty briefly in warnings.`,
              },
            ],
          },
        ],
        text: { format: invoiceSchema },
      })
      if (!response.output_text) {
        throw new Error('OpenAI invoice extraction returned no output')
      }
      return normalizeInvoiceExtraction(
        JSON.parse(response.output_text) as InvoiceExtraction,
      )
    },
  }
}
