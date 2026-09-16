import { useMutation, useQuery } from '@tanstack/react-query'
import { History } from 'lucide-react'
import { type ChangeEvent, type FormEvent, useState } from 'react'
import { Notice } from './States'
import { money } from '../lib/money'
import {
  getJson,
  postFile,
  type LateRecordingProgress,
  type LateRecordingReceipt,
} from '../lib/api'

/**
 * The administrator's late-recording correction screen.
 *
 * One month, one bounded CSV, an explicit preview, and an explicit commit. The
 * preview writes nothing, so the "Check file" button is safe to press as often
 * as the administrator likes; only "Attach and audit" changes anything.
 *
 * NOTHING ON THIS SCREEN IS A URL OR AN INTERNAL ID. The table shows the Task
 * IDs the administrator uploaded, a lifecycle word, a bounded failure code, and
 * money. The batch handle is used as a query key and is never rendered.
 */

/** Every bounded rejection code, in the administrator's own language. */
const REJECTION_LABELS: Readonly<Record<string, string>> = {
  TASK_ID_REQUIRED: 'Task ID column is empty',
  TASK_ID_DUPLICATE: 'Task ID repeats earlier in this file',
  TASK_ID_TOO_LONG: 'Task ID is not a valid reference',
  RECORDING_URL_REQUIRED: 'Recording URL column is empty',
  RECORDING_URL_TOO_LONG: 'Recording URL is not a valid link',
  URL_UNPARSEABLE: 'Recording URL could not be read',
  URL_NOT_HTTPS: 'Recording URL is not HTTPS',
  URL_NOT_ALLOWLISTED: 'Recording URL is not on the approved storage host',
  TASK_NOT_FOUND: 'No call with this Task ID in the selected month',
  TASK_AMBIGUOUS: 'This Task ID matches more than one call',
  INVOICE_MISSING: 'No invoice has been received for this month',
  CALL_STATE_INELIGIBLE: 'This call is already settled on other evidence',
  RECORDING_ARTIFACT_MISSING: 'This call has no recording record to attach to',
  RECORDING_URL_ALREADY_PRESENT: 'A different recording is already attached',
  AUDIT_ALREADY_COMPLETED: 'This call has already been audited',
  RATE_CARD_UNAVAILABLE: 'No published rate card covers this month',
}

const STATE_LABELS: Readonly<Record<string, string>> = {
  accepted: 'Queued',
  auditing: 'Auditing',
  corrected: 'Completed',
  failed: 'Failed',
}

function rejectionLabel(code: string | undefined): string {
  return (code && REJECTION_LABELS[code]) || 'Rejected'
}

/**
 * A bounded, opaque retry key.
 *
 * It exists so a double-clicked button, a retried fetch, or a re-delivered
 * request replays the same batch instead of attaching evidence twice. It is
 * regenerated only when the administrator picks a different file or month.
 */
function retryKey(): string {
  return `lr-${crypto.randomUUID().replaceAll('-', '')}`
}

export function LateRecordingCorrection() {
  const [file, setFile] = useState<File | null>(null)
  const [month, setMonth] = useState('')
  const [key, setKey] = useState(retryKey)
  const [preview, setPreview] = useState<LateRecordingReceipt | null>(null)
  const [batchId, setBatchId] = useState<string | null>(null)

  const upload = (path: string) => {
    if (!file) throw new Error('Select a correction CSV')
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
      throw new Error('Select the bill month this correction applies to')
    }
    return postFile<LateRecordingReceipt>(path, file, {
      month,
      'idempotency-key': key,
    })
  }

  const check = useMutation({
    mutationFn: () => upload('/api/v1/imports/late-recording/preview'),
    onSuccess: (result) => {
      setPreview(result)
      setBatchId(null)
    },
  })

  const commit = useMutation({
    mutationFn: () => upload('/api/v1/imports/late-recording/commit'),
    onSuccess: (result) => {
      setPreview(result)
      setBatchId(result.batchId ?? null)
      setSettled(false)
    },
  })

  /**
   * Live while anything is still moving, and stopped once the batch settles.
   *
   * The query DISABLES itself rather than varying its interval: a finished
   * correction is a fixed fact, and the last answer stays on screen. That also
   * keeps the poll a single fixed number, which is the rule every live monitor
   * in this application follows.
   */
  const settledProgress = (data: LateRecordingProgress | undefined) =>
    data?.finalized === true
  const [settled, setSettled] = useState(false)
  const progress = useQuery({
    queryKey: ['late-recording', batchId],
    enabled: Boolean(batchId) && !settled,
    queryFn: async () => {
      const data = await getJson<LateRecordingProgress>(
        `/api/v1/imports/late-recording/status?batch=${encodeURIComponent(
          batchId as string,
        )}`,
      )
      if (settledProgress(data)) setSettled(true)
      return data
    },
    refetchInterval: 10_000,
  })

  const selectFile = (event: ChangeEvent<HTMLInputElement>) => {
    setFile(event.currentTarget.files?.[0] ?? null)
    setPreview(null)
    setBatchId(null)
    setSettled(false)
    // A different file is a different correction, never a retry of the last.
    setKey(retryKey())
    check.reset()
    commit.reset()
  }

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    check.mutate()
  }

  const rejections = (preview?.decisions ?? []).filter(
    (decision) => decision.outcome === 'rejected',
  )
  const report = progress.data

  return (
    <section className="content-section">
      <div className="table-heading">
        <div>
          <span className="eyebrow">Admin · recurring correction</span>
          <h2>
            <History size={19} aria-hidden /> Late recording correction
          </h2>
        </div>
      </div>
      <p>
        Upload a CSV of <strong>Task ID</strong> and{' '}
        <strong>Recording URL</strong> for calls KServe originally supplied
        without a recording. Up to 100 rows, one bill month at a time. Checking
        the file writes nothing; only <em>Attach and audit</em> attaches the
        evidence, re-audits those exact calls, and revises the month.
      </p>
      <form className="form-grid" onSubmit={submit}>
        <label className="file-field">
          Correction CSV
          <input
            required
            type="file"
            accept=".csv,text/csv"
            onChange={selectFile}
          />
        </label>
        <label>
          Bill month
          <input
            required
            type="month"
            value={month}
            onChange={(event) => {
              setMonth(event.target.value)
              setPreview(null)
              setBatchId(null)
              setKey(retryKey())
            }}
          />
        </label>
        <button
          type="submit"
          className="secondary"
          disabled={!file || !month || check.isPending}
        >
          {check.isPending ? 'Checking…' : 'Check file'}
        </button>
        <button
          type="button"
          disabled={
            !preview ||
            preview.acceptedCount === 0 ||
            commit.isPending ||
            Boolean(batchId)
          }
          onClick={() => commit.mutate()}
        >
          {commit.isPending ? 'Attaching…' : 'Attach and audit'}
        </button>
      </form>

      {(check.error || commit.error) && (
        <Notice tone="warning" title="Correction could not be processed">
          {(check.error ?? commit.error)?.message}
        </Notice>
      )}

      {preview && (
        <Notice
          tone={preview.acceptedCount > 0 ? 'success' : 'warning'}
          title={
            batchId
              ? 'Correction accepted'
              : preview.acceptedCount > 0
                ? 'File is ready to attach'
                : 'Nothing in this file can be attached'
          }
        >
          {preview.submittedCount.toLocaleString('en-IN')} rows read;{' '}
          {preview.acceptedCount.toLocaleString('en-IN')} ready;{' '}
          {preview.duplicateCount.toLocaleString('en-IN')} already attached;{' '}
          {preview.rejectedCount.toLocaleString('en-IN')} rejected.
        </Notice>
      )}

      {rejections.length > 0 && (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>CSV row</th>
                <th>Reason</th>
              </tr>
            </thead>
            <tbody>
              {rejections.map((decision) => (
                <tr key={decision.rowNumber}>
                  <td>{decision.rowNumber}</td>
                  <td>{rejectionLabel(decision.code)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {report && (
        <>
          <section className="call-detail-facts content-section">
            <div>
              <span>Accepted</span>
              <strong>{report.accepted.toLocaleString('en-IN')}</strong>
            </div>
            <div>
              <span>Queued</span>
              <strong>{report.queued.toLocaleString('en-IN')}</strong>
            </div>
            <div>
              <span>Auditing</span>
              <strong>{report.auditing.toLocaleString('en-IN')}</strong>
            </div>
            <div>
              <span>Completed</span>
              <strong>{report.completed.toLocaleString('en-IN')}</strong>
            </div>
            <div>
              <span>Failed</span>
              <strong>{report.failed.toLocaleString('en-IN')}</strong>
            </div>
            <div>
              <span>Month total before</span>
              <strong>{money(report.previousVerifiedTotal)}</strong>
            </div>
            <div>
              <span>Month total after</span>
              <strong>{money(report.revisedVerifiedTotal)}</strong>
            </div>
            <div>
              <span>Total adjustment</span>
              <strong>{money(report.totalAdjustment)}</strong>
            </div>
          </section>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Task ID</th>
                  <th>State</th>
                  <th>Old amount</th>
                  <th>Revised amount</th>
                  <th>Note</th>
                </tr>
              </thead>
              <tbody>
                {report.items.map((item) => (
                  <tr key={item.rowNumber}>
                    <td>{item.taskReference}</td>
                    <td>{STATE_LABELS[item.state] ?? item.state}</td>
                    <td>{money(item.previousAmount)}</td>
                    <td>{money(item.revisedAmount)}</td>
                    <td>{item.failureCode ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="calculation-footnote">
            The revised total is the auditor-verified payable amount. The amount
            Finance actually paid is a separate record and is never changed
            here; this adjustment is a proposal for Finance to accept
            explicitly.
          </p>
        </>
      )}
    </section>
  )
}
