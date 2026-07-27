import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { FileSpreadsheet, FileText, ShieldCheck, UploadCloud } from 'lucide-react'
import { type FormEvent, useState } from 'react'
import { PageHeader } from '../components/Metrics'
import { ErrorState, LoadingState, Notice } from '../components/States'
import {
  getJson,
  postFile,
  type ImportResult,
  type ImportStatus,
} from '../lib/api'

function ImportResultNotice({ result }: { result: ImportResult }) {
  return (
    <Notice tone="success" title={result.outcome === 'duplicate' ? 'Already imported' : 'Import completed'}>
      {result.accepted.toLocaleString('en-IN')} rows accepted,{' '}
      {result.duplicates.toLocaleString('en-IN')} duplicates,{' '}
      {result.auditJobsQueued.toLocaleString('en-IN')} recording audits queued.
      {result.missingRecordingUrls > 0 &&
        ` ${result.missingRecordingUrls.toLocaleString('en-IN')} rows have no recording URL and remain explicitly unaudited.`}
    </Notice>
  )
}

export function ImportPage() {
  const client = useQueryClient()
  const [usageResult, setUsageResult] = useState<ImportResult | null>(null)
  const [invoiceResult, setInvoiceResult] = useState<ImportResult | null>(null)
  const query = useQuery({
    queryKey: ['imports'],
    queryFn: () => getJson<ImportStatus>('/api/v1/imports'),
    refetchInterval: 30_000,
  })
  const usage = useMutation({
    mutationFn: (input: { file: File; periodStart: string; periodEnd: string }) =>
      postFile<ImportResult>('/api/v1/imports/usage', input.file, {
        'period-start': input.periodStart,
        'period-end': input.periodEnd,
      }),
    onSuccess: (result) => {
      setUsageResult(result)
      void client.invalidateQueries({ queryKey: ['imports'] })
      void client.invalidateQueries({ queryKey: ['audit-monitor'] })
    },
  })
  const invoice = useMutation({
    mutationFn: (input: {
      file: File
      invoiceNumber: string
      invoiceDate: string
      periodStart: string
      periodEnd: string
      subtotalAmount: string
      taxAmount: string
      totalAmount: string
    }) =>
      postFile<ImportResult>('/api/v1/imports/invoice', input.file, {
        'invoice-number': input.invoiceNumber,
        'invoice-date': input.invoiceDate,
        'period-start': input.periodStart,
        'period-end': input.periodEnd,
        'subtotal-amount': input.subtotalAmount,
        'tax-amount': input.taxAmount,
        'total-amount': input.totalAmount,
      }),
    onSuccess: (result) => {
      setInvoiceResult(result)
      void client.invalidateQueries({ queryKey: ['imports'] })
    },
  })

  if (query.isLoading) return <LoadingState />
  if (query.error)
    return <ErrorState error={query.error} retry={() => void query.refetch()} />
  const data = query.data!
  const submitUsage = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setUsageResult(null)
    const form = new FormData(event.currentTarget)
    const file = form.get('usage-file')
    if (!(file instanceof File) || file.size === 0) return
    usage.mutate({
      file,
      periodStart: String(form.get('period-start') || ''),
      periodEnd: String(form.get('period-end') || ''),
    })
  }
  const submitInvoice = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setInvoiceResult(null)
    const form = new FormData(event.currentTarget)
    const file = form.get('invoice-file')
    if (!(file instanceof File) || file.size === 0) return
    invoice.mutate({
      file,
      invoiceNumber: String(form.get('invoice-number') || ''),
      invoiceDate: String(form.get('invoice-date') || ''),
      periodStart: String(form.get('period-start') || ''),
      periodEnd: String(form.get('period-end') || ''),
      subtotalAmount: String(form.get('subtotal-amount') || ''),
      taxAmount: String(form.get('tax-amount') || ''),
      totalAmount: String(form.get('total-amount') || ''),
    })
  }

  return (
    <>
      <PageHeader
        eyebrow="Admin · monthly cycle"
        title="Import KServe billing data"
        description="Upload the monthly task-level usage CSV and KServe invoice into the Kaudit-controlled SQL workflow."
        badge={<span className="status-badge ready"><ShieldCheck size={13} /> Admin only</span>}
      />
      <Notice tone="info" title="Kaudit is self-contained">
        {data.storageBoundary}
      </Notice>
      {!data.enabled && (
        <Notice tone="warning" title="Source connection needs configuration">
          Set KAUDIT_KSERVE_SOURCE_CONNECTION_ID to the active KServe source connection before uploading.
        </Notice>
      )}
      <section className="import-grid">
        <form className="import-card" onSubmit={submitUsage}>
          <FileSpreadsheet size={22} aria-hidden />
          <div>
            <span className="eyebrow">Step 1</span>
            <h2>Usage CSV</h2>
            <p>One row per task. Identical files and task IDs are replay-safe and are never duplicated.</p>
          </div>
          <div className="form-grid">
            <label>
              Period start
              <input required type="date" name="period-start" />
            </label>
            <label>
              Period end
              <input required type="date" name="period-end" />
            </label>
            <label className="file-field">
              CSV file
              <input required type="file" name="usage-file" accept=".csv,text/csv" />
            </label>
          </div>
          <button className="primary-action" type="submit" disabled={!data.enabled || usage.isPending}>
            <UploadCloud size={16} /> {usage.isPending ? 'Importing…' : 'Import usage'}
          </button>
          {usage.error && <Notice tone="warning" title="Usage import failed">{usage.error.message}</Notice>}
          {usageResult && <ImportResultNotice result={usageResult} />}
        </form>

        <form className="import-card" onSubmit={submitInvoice}>
          <FileText size={22} aria-hidden />
          <div>
            <span className="eyebrow">Step 2</span>
            <h2>Invoice PDF</h2>
            <p>The PDF is preserved by hash. Enter its printed totals so SQL remains the reconciliation gate.</p>
          </div>
          <div className="form-grid">
            <label>
              Invoice number
              <input required name="invoice-number" autoComplete="off" />
            </label>
            <label>
              Invoice date
              <input required type="date" name="invoice-date" />
            </label>
            <label>
              Period start
              <input required type="date" name="period-start" />
            </label>
            <label>
              Period end
              <input required type="date" name="period-end" />
            </label>
            <label>
              Subtotal (INR)
              <input required type="number" min="0" step="0.01" name="subtotal-amount" />
            </label>
            <label>
              Tax (INR)
              <input required type="number" min="0" step="0.01" name="tax-amount" />
            </label>
            <label>
              Total (INR)
              <input required type="number" min="0" step="0.01" name="total-amount" />
            </label>
            <label className="file-field">
              Invoice PDF
              <input required type="file" name="invoice-file" accept=".pdf,application/pdf" />
            </label>
          </div>
          <button className="primary-action" type="submit" disabled={!data.enabled || invoice.isPending}>
            <UploadCloud size={16} /> {invoice.isPending ? 'Importing…' : 'Import invoice'}
          </button>
          {invoice.error && <Notice tone="warning" title="Invoice import failed">{invoice.error.message}</Notice>}
          {invoiceResult && <ImportResultNotice result={invoiceResult} />}
        </form>
      </section>

      <section className="content-section data-table">
        <div className="table-heading"><div><span className="eyebrow">SQL gate</span><h2>Recent usage batches</h2></div></div>
        <div className="table-scroll">
          <table>
            <thead><tr><th>Period</th><th>Status</th><th>Received</th><th>Accepted</th><th>Duplicates</th></tr></thead>
            <tbody>
              {data.recentBatches.map((batch) => (
                <tr key={batch.id}>
                  <td>{batch.periodStart ?? '—'} – {batch.periodEnd ?? '—'}</td>
                  <td>{batch.status}</td>
                  <td>{batch.received.toLocaleString('en-IN')}</td>
                  <td>{batch.accepted.toLocaleString('en-IN')}</td>
                  <td>{batch.duplicates.toLocaleString('en-IN')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  )
}
