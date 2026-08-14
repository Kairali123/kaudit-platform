import {
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'
import {
  FileSpreadsheet,
  FileText,
  ScanSearch,
  ShieldCheck,
  UploadCloud,
} from 'lucide-react'
import {
  type ChangeEvent,
  type FormEvent,
  useState,
} from 'react'
import { PageHeader } from '../components/Metrics'
import {
  ErrorState,
  LoadingState,
  Notice,
} from '../components/States'
import {
  getJson,
  postFile,
  type ImportResult,
  type ImportStatus,
  type InvoiceImportPreview,
  type UsageImportPreview,
} from '../lib/api'

interface InvoiceFields {
  invoiceNumber: string
  invoiceDate: string
  periodStart: string
  periodEnd: string
  subtotalAmount: string
  taxAmount: string
  totalAmount: string
}

const emptyInvoice: InvoiceFields = {
  invoiceNumber: '',
  invoiceDate: '',
  periodStart: '',
  periodEnd: '',
  subtotalAmount: '',
  taxAmount: '',
  totalAmount: '',
}

function ImportResultNotice({
  result,
}: {
  result: ImportResult
}) {
  return (
    <Notice
      tone="success"
      title={
        result.outcome === 'duplicate'
          ? 'Already imported'
          : 'Import completed'
      }
    >
      {result.accepted.toLocaleString('en-IN')} rows accepted,{' '}
      {result.duplicates.toLocaleString('en-IN')} duplicates,{' '}
      {result.auditJobsQueued.toLocaleString('en-IN')} recording
      audits queued.
      {result.missingRecordingUrls > 0 &&
        ` ${result.missingRecordingUrls.toLocaleString('en-IN')} rows have no recording URL and remain explicitly unaudited.`}
    </Notice>
  )
}

function fileFrom(event: ChangeEvent<HTMLInputElement>): File | null {
  return event.currentTarget.files?.[0] ?? null
}

export function ImportPage() {
  const client = useQueryClient()
  const [usageFile, setUsageFile] = useState<File | null>(null)
  const [usagePeriodStart, setUsagePeriodStart] = useState('')
  const [usagePeriodEnd, setUsagePeriodEnd] = useState('')
  const [usagePreview, setUsagePreview] =
    useState<UsageImportPreview | null>(null)
  const [usageResult, setUsageResult] =
    useState<ImportResult | null>(null)

  const [invoiceFile, setInvoiceFile] = useState<File | null>(null)
  const [invoiceFields, setInvoiceFields] =
    useState<InvoiceFields>(emptyInvoice)
  const [invoicePreview, setInvoicePreview] =
    useState<InvoiceImportPreview | null>(null)
  const [invoiceResult, setInvoiceResult] =
    useState<ImportResult | null>(null)

  const query = useQuery({
    queryKey: ['imports'],
    queryFn: () => getJson<ImportStatus>('/api/v1/imports'),
    // Opt-in live monitor: import batches are ingested by background jobs, so
    // the status list advances without navigation. Bounded, and not a default.
    refetchInterval: 30_000,
  })

  const usageAnalysis = useMutation({
    mutationFn: (file: File) =>
      postFile<UsageImportPreview>(
        '/api/v1/imports/analyze-usage',
        file,
        {},
      ),
    onSuccess: (preview) => {
      setUsagePreview(preview)
      setUsagePeriodStart(preview.periodStart)
      setUsagePeriodEnd(preview.periodEnd)
    },
  })

  const invoiceAnalysis = useMutation({
    mutationFn: (file: File) =>
      postFile<InvoiceImportPreview>(
        '/api/v1/imports/analyze-invoice',
        file,
        {},
      ),
    onSuccess: (preview) => {
      setInvoicePreview(preview)
      setInvoiceFields({
        invoiceNumber: preview.invoiceNumber,
        invoiceDate: preview.invoiceDate,
        periodStart: preview.periodStart,
        periodEnd: preview.periodEnd,
        subtotalAmount: preview.subtotalAmount,
        taxAmount: preview.taxAmount,
        totalAmount: preview.totalAmount,
      })
    },
  })

  const usage = useMutation({
    mutationFn: () => {
      if (!usageFile) throw new Error('Select a usage CSV')
      return postFile<ImportResult>(
        '/api/v1/imports/usage',
        usageFile,
        {
          'period-start': usagePeriodStart,
          'period-end': usagePeriodEnd,
        },
      )
    },
    onSuccess: (result) => {
      setUsageResult(result)
      void client.invalidateQueries({ queryKey: ['imports'] })
      void client.invalidateQueries({
        queryKey: ['audit-monitor'],
      })
    },
  })

  const invoice = useMutation({
    mutationFn: () => {
      if (!invoiceFile) throw new Error('Select an invoice PDF')
      return postFile<ImportResult>(
        '/api/v1/imports/invoice',
        invoiceFile,
        {
          'invoice-number': invoiceFields.invoiceNumber,
          'invoice-date': invoiceFields.invoiceDate,
          'period-start': invoiceFields.periodStart,
          'period-end': invoiceFields.periodEnd,
          'subtotal-amount': invoiceFields.subtotalAmount,
          'tax-amount': invoiceFields.taxAmount,
          'total-amount': invoiceFields.totalAmount,
        },
      )
    },
    onSuccess: (result) => {
      setInvoiceResult(result)
      void client.invalidateQueries({ queryKey: ['imports'] })
    },
  })

  if (query.isLoading) return <LoadingState />
  if (query.error) {
    return (
      <ErrorState
        error={query.error}
        retry={() => void query.refetch()}
      />
    )
  }
  const data = query.data!

  const selectUsage = (event: ChangeEvent<HTMLInputElement>) => {
    const file = fileFrom(event)
    setUsageFile(file)
    setUsagePreview(null)
    setUsageResult(null)
    usageAnalysis.reset()
    if (file) usageAnalysis.mutate(file)
  }

  const selectInvoice = (event: ChangeEvent<HTMLInputElement>) => {
    const file = fileFrom(event)
    setInvoiceFile(file)
    setInvoicePreview(null)
    setInvoiceResult(null)
    setInvoiceFields(emptyInvoice)
    invoiceAnalysis.reset()
    if (file && data.invoiceAiEnabled) {
      invoiceAnalysis.mutate(file)
    }
  }

  const submitUsage = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setUsageResult(null)
    usage.mutate()
  }

  const submitInvoice = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setInvoiceResult(null)
    invoice.mutate()
  }

  const updateInvoice = (
    field: keyof InvoiceFields,
    value: string,
  ) => {
    setInvoiceFields((current) => ({
      ...current,
      [field]: value,
    }))
  }

  return (
    <>
      <PageHeader
        eyebrow="Admin · monthly cycle"
        title="Import KServe billing data"
        description="Analyze, verify, and submit the task-level usage CSV and invoice PDF into the Kaudit-controlled SQL workflow."
        badge={
          <span className="status-badge ready">
            <ShieldCheck size={13} /> Admin only
          </span>
        }
      />
      <Notice tone="info" title="Kaudit is self-contained">
        {data.storageBoundary}
      </Notice>
      {!data.enabled && (
        <Notice
          tone="warning"
          title="Source connection needs configuration"
        >
          Set KAUDIT_KSERVE_SOURCE_CONNECTION_ID to the active KServe
          source connection before uploading.
        </Notice>
      )}
      <section className="import-grid">
        <form className="import-card" onSubmit={submitUsage}>
          <FileSpreadsheet size={22} aria-hidden />
          <div>
            <span className="eyebrow">Step 1</span>
            <h2>Usage CSV</h2>
            <p>
              Selecting a file validates its locked columns and derives
              the billing period. Nothing is written until Submit usage
              is pressed.
            </p>
          </div>
          <div className="form-grid">
            <label className="file-field">
              CSV file
              <input
                required
                type="file"
                accept=".csv,text/csv"
                onChange={selectUsage}
              />
            </label>
            <label>
              Period start
              <input
                required
                type="date"
                value={usagePeriodStart}
                onChange={(event) =>
                  setUsagePeriodStart(event.target.value)
                }
              />
            </label>
            <label>
              Period end
              <input
                required
                type="date"
                value={usagePeriodEnd}
                onChange={(event) =>
                  setUsagePeriodEnd(event.target.value)
                }
              />
            </label>
          </div>
          {usageAnalysis.isPending && (
            <Notice tone="info" title="Analyzing usage file">
              Validating columns, dates, task IDs, and recording URL
              coverage…
            </Notice>
          )}
          {usageAnalysis.error && (
            <Notice tone="warning" title="Usage analysis failed">
              {usageAnalysis.error.message}
            </Notice>
          )}
          {usagePreview && (
            <Notice tone="success" title="Usage file ready">
              {usagePreview.rowCount.toLocaleString('en-IN')} calls;
              {' '}
              {usagePreview.recordingUrlCount.toLocaleString('en-IN')}
              {' '}recording URLs. Period fields are editable before
              submission.
              {usagePreview.warnings.length > 0 &&
                ` ${usagePreview.warnings.join(' ')}`}
            </Notice>
          )}
          <button
            className="primary-action"
            type="submit"
            disabled={
              !data.enabled ||
              !usageFile ||
              !usagePreview ||
              usage.isPending ||
              usageAnalysis.isPending
            }
          >
            <UploadCloud size={16} />{' '}
            {usage.isPending ? 'Submitting…' : 'Submit usage'}
          </button>
          {usage.error && (
            <Notice tone="warning" title="Usage import failed">
              {usage.error.message}
            </Notice>
          )}
          {usageResult && (
            <ImportResultNotice result={usageResult} />
          )}
        </form>

        <form className="import-card" onSubmit={submitInvoice}>
          <FileText size={22} aria-hidden />
          <div>
            <span className="eyebrow">Step 2</span>
            <h2>Invoice PDF</h2>
            <p>
              OpenAI extracts printed metadata into editable fields.
              AI suggestions are not authoritative and are not stored
              until Submit invoice is pressed.
            </p>
          </div>
          {!data.invoiceAiEnabled && (
            <Notice
              tone="warning"
              title="Invoice AI is not configured"
            >
              Add OPENAI_API_KEY to the external Kaudit secrets file,
              then restart the server. Manual entry remains available.
            </Notice>
          )}
          <div className="form-grid">
            <label className="file-field">
              Invoice PDF
              <input
                required
                type="file"
                accept=".pdf,application/pdf"
                onChange={selectInvoice}
              />
            </label>
            <label>
              Invoice number
              <input
                required
                autoComplete="off"
                value={invoiceFields.invoiceNumber}
                onChange={(event) =>
                  updateInvoice(
                    'invoiceNumber',
                    event.target.value,
                  )
                }
              />
            </label>
            <label>
              Invoice date
              <input
                required
                type="date"
                value={invoiceFields.invoiceDate}
                onChange={(event) =>
                  updateInvoice('invoiceDate', event.target.value)
                }
              />
            </label>
            <label>
              Period start
              <input
                required
                type="date"
                value={invoiceFields.periodStart}
                onChange={(event) =>
                  updateInvoice('periodStart', event.target.value)
                }
              />
            </label>
            <label>
              Period end
              <input
                required
                type="date"
                value={invoiceFields.periodEnd}
                onChange={(event) =>
                  updateInvoice('periodEnd', event.target.value)
                }
              />
            </label>
            <label>
              Subtotal (INR)
              <input
                required
                type="number"
                min="0"
                step="0.01"
                value={invoiceFields.subtotalAmount}
                onChange={(event) =>
                  updateInvoice(
                    'subtotalAmount',
                    event.target.value,
                  )
                }
              />
            </label>
            <label>
              Tax (INR)
              <input
                required
                type="number"
                min="0"
                step="0.01"
                value={invoiceFields.taxAmount}
                onChange={(event) =>
                  updateInvoice('taxAmount', event.target.value)
                }
              />
            </label>
            <label>
              Total (INR)
              <input
                required
                type="number"
                min="0"
                step="0.01"
                value={invoiceFields.totalAmount}
                onChange={(event) =>
                  updateInvoice('totalAmount', event.target.value)
                }
              />
            </label>
          </div>
          {invoiceAnalysis.isPending && (
            <Notice tone="info" title="AI is reading the invoice">
              Extracting printed dates and totals using a strict
              schema. This can take several seconds.
            </Notice>
          )}
          {invoiceAnalysis.error && (
            <Notice tone="warning" title="Invoice analysis failed">
              {invoiceAnalysis.error.message} You can retry by selecting
              the file again.
            </Notice>
          )}
          {invoicePreview && (
            <Notice tone="success" title="Invoice fields suggested">
              Model {invoicePreview.model}; confidence{' '}
              {(Number(invoicePreview.confidence) * 100).toFixed(0)}%.
              Review every field before submitting.
              {invoicePreview.warnings.length > 0 &&
                ` ${invoicePreview.warnings.join(' ')}`}
            </Notice>
          )}
          <button
            className="primary-action"
            type="submit"
            disabled={
              !data.enabled ||
              !invoiceFile ||
              invoice.isPending ||
              invoiceAnalysis.isPending
            }
          >
            <UploadCloud size={16} />{' '}
            {invoice.isPending
              ? 'Submitting…'
              : 'Submit invoice'}
          </button>
          {invoice.error && (
            <Notice tone="warning" title="Invoice import failed">
              {invoice.error.message}
            </Notice>
          )}
          {invoiceResult && (
            <ImportResultNotice result={invoiceResult} />
          )}
        </form>
      </section>

      <section className="content-section data-table">
        <div className="table-heading">
          <div>
            <span className="eyebrow">SQL gate</span>
            <h2>Recent usage batches</h2>
          </div>
          <ScanSearch size={19} aria-hidden />
        </div>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Period</th>
                <th>Status</th>
                <th>Received</th>
                <th>Accepted</th>
                <th>Duplicates</th>
              </tr>
            </thead>
            <tbody>
              {data.recentBatches.map((batch) => (
                <tr key={batch.id}>
                  <td>
                    {batch.periodStart ?? '—'} –{' '}
                    {batch.periodEnd ?? '—'}
                  </td>
                  <td>{batch.status}</td>
                  <td>
                    {batch.received.toLocaleString('en-IN')}
                  </td>
                  <td>
                    {batch.accepted.toLocaleString('en-IN')}
                  </td>
                  <td>
                    {batch.duplicates.toLocaleString('en-IN')}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  )
}
