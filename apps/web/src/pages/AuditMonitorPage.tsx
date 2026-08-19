import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  AlertTriangle,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Clock3,
  FileQuestion,
  LockKeyhole,
  RefreshCw,
  ShieldCheck,
} from 'lucide-react'
import {
  useEffect,
  useMemo,
  useState,
  type Dispatch,
  type SetStateAction,
} from 'react'
import { Link } from 'react-router-dom'
import { MetricGrid, PageHeader, UpdatedAt } from '../components/Metrics'
import { ErrorState, LoadingState, Notice } from '../components/States'
import {
  getJson,
  postJson,
  MANUAL_REAUDIT_ROUTE,
  MANUAL_REAUDIT_RESUME_ROUTE,
  MAX_MANUAL_REAUDIT_CALLS,
  type AuditMonitorData,
  type AuditMonitorRow,
  type AuditPagination,
  type ManualReauditReceipt,
  type ManualReauditResumeReceipt,
  type Profile,
  type Tile,
} from '../lib/api'
import { useBillingPeriod } from '../lib/billingPeriod'
import { AuditWorkerControl } from '../components/AuditWorkerControl'

function seconds(value: number | null): string {
  if (value == null) return '—'
  return `${(value / 1000).toFixed(1)}s`
}

function confidence(value: string | null): string {
  if (value == null) return 'Not stored'
  return `${(Number(value) * 100).toFixed(1)}%`
}

function date(value: string | null): string {
  if (!value) return '—'
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime())
    ? value
    : parsed.toLocaleDateString('en-IN', {
        day: '2-digit',
        month: 'short',
        year: 'numeric',
      })
}

function rowStatus(row: AuditMonitorRow): string {
  return row.confirmationStatus === 'model_output'
    ? 'Model output'
    : row.confirmationStatus
}

/**
 * A row already carrying live re-audit work cannot be selected again.
 *
 * The server enforces one active request per call regardless; disabling the
 * checkbox is how an administrator SEES that, instead of submitting a selection
 * that is silently reported back as already queued.
 */
function reAuditLocked(row: AuditMonitorRow): boolean {
  return row.reAuditStatus != null
}

function reAuditLabel(row: AuditMonitorRow): string {
  if (row.reAuditStatus === 'processing') return 'Re-auditing'
  return row.reAuditStatus === 'queued' ? 'Re-audit queued' : ''
}

/**
 * One retry key per draft selection.
 *
 * Held until a submission SUCCEEDS, so a double-click, a retried fetch, or an
 * impatient second press replays the request already accepted rather than
 * queuing — and paying for — the same calls twice.
 */
function newIdempotencyKey(): string {
  return `rea-${crypto.randomUUID()}`
}

/**
 * What the administrator is told after a submission. Counts and lifecycle only;
 * the browser calculates nothing and no reference is echoed back.
 */
function receiptMessage(receipt: ManualReauditReceipt): string {
  const queued =
    receipt.alreadyQueuedCount > 0
      ? ` ${receipt.alreadyQueuedCount.toLocaleString('en-IN')} already had a re-audit in progress.`
      : ''
  if (receipt.outcome === 'already_queued') {
    return `Nothing new was queued.${queued}`
  }
  const verb = receipt.outcome === 'replayed' ? 'already queued' : 'queued'
  return `${receipt.acceptedCount.toLocaleString('en-IN')} ${
    receipt.acceptedCount === 1 ? 'call' : 'calls'
  } ${verb} for re-audit.${queued}`
}

function money(value: string | null): string {
  if (value == null) return '—'
  return `₹${Number(value).toLocaleString('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`
}

function usd(value: string): string {
  return Number(value).toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 4,
    maximumFractionDigits: 8,
  })
}

function PaginationFooter({
  pagination,
  setPage,
}: {
  pagination: AuditPagination
  setPage: Dispatch<SetStateAction<number>>
}) {
  return (
    <footer className="table-pagination">
      <span>
        Page {pagination.page} of {pagination.totalPages}
      </span>
      <div>
        <button
          type="button"
          disabled={pagination.page <= 1}
          onClick={() =>
            setPage((value) => Math.max(1, value - 1))
          }
        >
          <ChevronLeft size={15} aria-hidden /> Previous
        </button>
        <button
          type="button"
          disabled={pagination.page >= pagination.totalPages}
          onClick={() => setPage((value) => value + 1)}
        >
          Next <ChevronRight size={15} aria-hidden />
        </button>
      </div>
    </footer>
  )
}

export function AuditMonitorPage() {
  const period = useBillingPeriod()
  const client = useQueryClient()
  const profileQuery = useQuery({
    queryKey: ['me'],
    queryFn: () => getJson<Profile>('/api/v1/me'),
    retry: false,
  })
  const isAdmin = profileQuery.data?.roles.includes('admin') === true
  const [page, setPage] = useState(1)
  const [pendingPage, setPendingPage] = useState(1)
  const [noRecordingPage, setNoRecordingPage] = useState(1)
  const [category, setCategory] = useState('')
  const [language, setLanguage] = useState('')
  const queryString = new URLSearchParams({
    page: String(page),
    pendingPage: String(pendingPage),
    noRecordingPage: String(noRecordingPage),
    pageSize: '25',
    ...(category ? { category } : {}),
    ...(language ? { language } : {}),
  }).toString()
  const query = useQuery({
    queryKey: [
      'audit-monitor',
      period.month,
      page,
      pendingPage,
      noRecordingPage,
      category,
      language,
    ],
    queryFn: () =>
      getJson<AuditMonitorData>(
        period.apiPath(`/api/v1/audits?${queryString}`),
      ),
    // Opt-in live monitor: the audit worker moves calls between the pending,
    // audited and no-recording sets while this page is open, so it polls on a
    // bounded interval. Polling is not a client default.
    refetchInterval: 15_000,
  })
  const [selected, setSelected] = useState<string[]>([])
  const [idempotencyKey, setIdempotencyKey] = useState(newIdempotencyKey)
  const [receipt, setReceipt] = useState<ManualReauditReceipt | null>(null)
  const reAudit = useMutation({
    mutationFn: () =>
      postJson<ManualReauditReceipt>(MANUAL_REAUDIT_ROUTE, {
        // The EXACT displayed references, in the order they were selected. No
        // filter, page, or category is sent: nothing widens the selection on
        // the way to a paid model.
        callReferences: selected,
        // The SAME key for every attempt at this selection, replaced only once
        // a submission succeeds.
        idempotencyKey,
      }),
    onSuccess: (result) => {
      setReceipt(result)
      setSelected([])
      setIdempotencyKey(newIdempotencyKey())
      void client.invalidateQueries({ queryKey: ['audit-monitor'] })
      void client.invalidateQueries({ queryKey: ['audit-workers'] })
    },
  })
  const resumeReAudits = useMutation({
    mutationFn: () =>
      postJson<ManualReauditResumeReceipt>(
        MANUAL_REAUDIT_RESUME_ROUTE,
        {},
      ),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['audit-monitor'] })
      void client.invalidateQueries({ queryKey: ['audit-workers'] })
    },
  })
  useEffect(() => {
    setPage(1)
    setPendingPage(1)
    setNoRecordingPage(1)
  }, [period.month])
  // A selection belongs to the rows it was made on. Changing month, page or
  // filter can only clear it — never carry a reference onto a screen the
  // administrator is no longer looking at.
  useEffect(() => {
    setSelected([])
    setReceipt(null)
    setIdempotencyKey(newIdempotencyKey())
  }, [period.month, page, category, language])
  const tiles = useMemo<Tile[]>(() => {
    const summary = query.data?.summary
    if (!summary) return []
    const financials = summary.auditedFinancials
    return [
      {
        label: 'AI-audited calls',
        value: summary.aiAuditedCalls.toLocaleString('en-IN'),
        sub: `${summary.auditCoveragePercent}% of ${summary.totalCalls.toLocaleString('en-IN')} ingested`,
        status: summary.aiAuditedCalls > 0 ? 'good' : 'pending',
      },
      {
        label: 'Eligible, still pending',
        value: summary.pendingEligibleCalls.toLocaleString('en-IN'),
        sub: `${summary.recordingAvailableCalls.toLocaleString('en-IN')} recording URLs · ${summary.processingFailureCalls.toLocaleString('en-IN')} processing failures`,
        status: summary.pendingEligibleCalls > 0 ? 'warn' : 'good',
      },
      {
        label: 'No recording',
        value: summary.noRecordingCalls.toLocaleString('en-IN'),
        sub: 'Cannot be independently AI-audited',
        status: summary.noRecordingCalls > 0 ? 'warn' : 'good',
      },
      {
        label: 'GPT tokens recorded',
        value: summary.aiUsage.historicalUsageRecorded
          ? summary.aiUsage.gptTotalTokens.toLocaleString('en-IN')
          : 'Not recorded',
        sub: summary.aiUsage.historicalUsageRecorded
          ? `${summary.aiUsage.gptInputTokens.toLocaleString('en-IN')} input · ${summary.aiUsage.gptOutputTokens.toLocaleString('en-IN')} output · ${summary.aiUsage.trackedAuditRuns.toLocaleString('en-IN')} audits`
          : 'Tracking begins after migration 0007; legacy usage cannot be reconstructed exactly',
        status:
          summary.aiUsage.historicalUsageRecorded
            ? 'good'
            : 'pending',
      },
      {
        label: 'Whisper audio processed',
        value: summary.aiUsage.historicalUsageRecorded
          ? `${(
              Number(summary.aiUsage.whisperAudioSeconds) / 60
            ).toLocaleString('en-IN', {
              minimumFractionDigits: 2,
              maximumFractionDigits: 2,
            })} min`
          : 'Not recorded',
        sub:
          'Whisper-1 reports billed audio duration, not text tokens',
        status:
          summary.aiUsage.historicalUsageRecorded
            ? 'good'
            : 'pending',
      },
      {
        label: 'Estimated AI spend',
        value: usd(financials.estimatedAiSpendUsd),
        sub:
          `${financials.aiSpendTrackedCalls.toLocaleString('en-IN')} of ` +
          `${financials.scopedAuditedCalls.toLocaleString('en-IN')} audited calls tracked` +
          (financials.aiSpendUntrackedCalls > 0
            ? ` · ${financials.aiSpendUntrackedCalls.toLocaleString('en-IN')} legacy costs unavailable`
            : '') +
          (financials.unpricedAiUsageRows > 0
            ? ` · ${financials.unpricedAiUsageRows.toLocaleString('en-IN')} unpriced model rows`
            : '') +
          ` · ${financials.aiSpendPricingBasis}`,
        status:
          financials.aiSpendUntrackedCalls === 0 &&
          financials.unpricedAiUsageRows === 0
            ? 'good'
            : 'warn',
      },
      {
        label: 'KServe charge · audited calls',
        value: money(financials.kserveChargeInr),
        sub:
          `${financials.kservePricedCalls.toLocaleString('en-IN')} of ` +
          `${financials.scopedAuditedCalls.toLocaleString('en-IN')} audited calls · provider minutes × ₹9.50`,
        status:
          financials.kservePricedCalls ===
          financials.scopedAuditedCalls
            ? 'neutral'
            : 'warn',
      },
      {
        label: 'Auditor capped amount · audited calls',
        value: money(financials.auditorFinalChargeInr),
        sub:
          `${financials.auditorFinalPricedCalls.toLocaleString('en-IN')} of ` +
          `${financials.scopedAuditedCalls.toLocaleString('en-IN')} audited calls priced by audited duration, capped at KServe charge · ` +
          `${financials.auditorUnfinalizedCalls.toLocaleString('en-IN')} missing audited duration`,
        status:
          financials.auditorUnfinalizedCalls === 0
            ? 'good'
            : 'warn',
      },
    ]
  }, [query.data])

  if (query.isLoading) return <LoadingState />
  if (query.error)
    return <ErrorState error={query.error} retry={() => void query.refetch()} />
  const data = query.data!
  const selectable = data.rows
    .filter((row) => !reAuditLocked(row))
    .map((row) => row.callReference)
  const selectedSet = new Set(selected)
  const allSelected =
    selectable.length > 0 &&
    selectable.every((reference) => selectedSet.has(reference))
  const overLimit = selected.length > MAX_MANUAL_REAUDIT_CALLS
  const toggle = (reference: string) =>
    setSelected((current) =>
      current.includes(reference)
        ? current.filter((value) => value !== reference)
        : [...current, reference],
    )
  // Select-all covers THIS page's selectable rows and nothing more: an
  // administrator can never queue a page they have not seen.
  const toggleAll = () =>
    setSelected((current) =>
      allSelected
        ? current.filter((value) => !selectable.includes(value))
        : [...new Set([...current, ...selectable])],
    )
  return (
    <>
      <PageHeader
        eyebrow="Developer control"
        title="Audit monitor"
        description={`Admin-only AI processing coverage and privacy-safe audit metadata for ${period.label}.`}
        badge={
          <span className="status-badge automated">
            <LockKeyhole size={13} aria-hidden /> Admin only
          </span>
        }
      />
      <Notice tone="warning" title="Automated consensus—not human ground truth">
        Use this view to inspect categories, confidence, durations, calculations,
        and stuck processing. Open Call is restricted to administrators and
        every content access is logged. <strong>Auditor capped amount</strong>{' '}
        prices audited duration with the locked KServe rounding rule and caps
        each call at KServe&apos;s charge, so it never exceeds the vendor charge
        for the same call.
      </Notice>
      <AuditWorkerControl system="billing" />
      <MetricGrid tiles={tiles} />

      <section className="content-section audit-control-bar">
        <div>
          <ShieldCheck size={18} aria-hidden />
          <span>{data.contentBoundary}</span>
        </div>
        <label>
          Category
          <select
            value={category}
            onChange={(event) => {
              setCategory(event.target.value)
              setPage(1)
            }}
          >
            <option value="">All categories</option>
            {data.filters.availableCategories.map((value) => (
              <option value={value} key={value}>{value}</option>
            ))}
          </select>
        </label>
        <label>
          Language
          <select
            value={language}
            onChange={(event) => {
              setLanguage(event.target.value)
              setPage(1)
            }}
          >
            <option value="">All languages</option>
            {data.filters.availableLanguages.map((value) => (
              <option value={value} key={value}>{value}</option>
            ))}
          </select>
        </label>
      </section>

      {isAdmin && (
        <section className="content-section reaudit-bar">
          <div className="reaudit-summary">
            <span className="eyebrow">Re-audit</span>
            <strong>
              {selected.length.toLocaleString('en-IN')} selected on this page
            </strong>
            <small>
              Queues a paid AI re-audit of exactly these calls. A successful run
              appends a new audit; a failure leaves the current result in place.
            </small>
          </div>
          <div className="reaudit-state" role="status" aria-live="polite">
            {reAudit.isPending && (
              <span className="reaudit-message pending">
                <RefreshCw size={14} aria-hidden /> Submitting the selection…
              </span>
            )}
            {!reAudit.isPending && reAudit.error && (
              <span className="reaudit-message error">
                <AlertTriangle size={14} aria-hidden />
                {(reAudit.error as Error).message}
              </span>
            )}
            {!reAudit.isPending && !reAudit.error && receipt && (
              <span className="reaudit-message success">
                <CheckCircle2 size={14} aria-hidden /> {receiptMessage(receipt)}
              </span>
            )}
            {resumeReAudits.isPending && (
              <span className="reaudit-message pending">
                <RefreshCw size={14} aria-hidden /> Resuming queued re-audits…
              </span>
            )}
            {!resumeReAudits.isPending && resumeReAudits.error && (
              <span className="reaudit-message error">
                <AlertTriangle size={14} aria-hidden />
                {(resumeReAudits.error as Error).message}
              </span>
            )}
            {resumeReAudits.isSuccess && (
              <span className="reaudit-message success">
                <CheckCircle2 size={14} aria-hidden /> Requested re-audit queue resumed.
              </span>
            )}
            {overLimit && (
              <span className="reaudit-message error">
                <AlertTriangle size={14} aria-hidden /> Select at most{' '}
                {MAX_MANUAL_REAUDIT_CALLS} calls in one request.
              </span>
            )}
          </div>
          <div className="reaudit-actions">
            <button
              type="button"
              className="button-secondary"
              disabled={resumeReAudits.isPending || resumeReAudits.isSuccess}
              title="Restart processing for the existing requested re-audit queue"
              onClick={() => resumeReAudits.mutate()}
            >
              <RefreshCw size={16} aria-hidden />
              Resume queued re-audits
            </button>
            <button
              type="button"
              className="button-primary"
              disabled={reAudit.isPending || selected.length === 0 || overLimit}
              title={
                selected.length === 0
                  ? 'Select audited calls to re-audit'
                  : 'Queue a paid re-audit of the selected calls'
              }
              onClick={() => reAudit.mutate()}
            >
              <RefreshCw size={16} aria-hidden />
              Re-audit selected
            </button>
          </div>
        </section>
      )}

      <section className="data-table content-section audit-table">
        <div className="table-heading">
          <div>
            <span className="eyebrow">Audited calls</span>
            <h2>AI output inspection</h2>
          </div>
          <span className="soft-chip">
            {data.pagination.totalRows.toLocaleString('en-IN')} results
          </span>
        </div>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                {isAdmin && (
                  <th className="select-cell">
                    <input
                      type="checkbox"
                      checked={allSelected}
                      disabled={selectable.length === 0}
                      aria-label="Select every re-auditable call on this page"
                      onChange={toggleAll}
                    />
                  </th>
                )}
                <th>Task / call reference</th>
                <th>Audited</th>
                <th>Category</th>
                <th>Language</th>
                <th>Confidence</th>
                <th>Recorded</th>
                <th>Speech</th>
                <th>Customer end</th>
                <th>Grace-adjusted</th>
                <th>Vendor connected</th>
                <th>Difference</th>
                <th>Evidence</th>
                <th>Model / engine</th>
                <th>AI usage</th>
                <th>State</th>
                <th>Re-audit</th>
                <th>Admin review</th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map((row) => (
                <tr key={`${row.callReference}-${row.auditedAt}`}>
                  {isAdmin && (
                    <td className="select-cell">
                      <input
                        type="checkbox"
                        checked={selectedSet.has(row.callReference)}
                        disabled={reAuditLocked(row)}
                        aria-label={`Select call ${row.callReference} for re-audit`}
                        onChange={() => toggle(row.callReference)}
                      />
                    </td>
                  )}
                  <td>
                    <code>{row.callReference}</code>
                    <small className="cell-sub">
                      {date(row.billingPeriodDate)}
                    </small>
                  </td>
                  <td>{date(row.auditedAt)}</td>
                  <td><code>{row.category}</code></td>
                  <td>{row.language}</td>
                  <td>{confidence(row.confidence)}</td>
                  <td>{seconds(row.recordedDurationMs)}</td>
                  <td>{seconds(row.speechDurationMs)}</td>
                  <td>{seconds(row.conversationEndMs)}</td>
                  <td>{seconds(row.graceAdjustedDurationMs)}</td>
                  <td>{seconds(row.vendorConnectedDurationMs)}</td>
                  <td className={(row.varianceDurationMs ?? 0) > 60_000 ? 'cell-warn' : ''}>
                    {seconds(row.varianceDurationMs)}
                  </td>
                  <td>
                    <span className={`integrity-dot ${row.evidenceHashRecorded ? 'good' : 'missing'}`} />
                    {row.evidenceHashRecorded ? 'Hashed' : 'Not hashed'}
                  </td>
                  <td>
                    {row.asrModel || 'Unknown ASR'}
                    <small className="cell-sub">
                      {row.auditEngineVersion || row.outcomeTaxonomyVersion || 'Version unavailable'}
                    </small>
                  </td>
                  <td>
                    {row.aiUsage.totalTokens == null
                      ? 'Legacy · not recorded'
                      : `${row.aiUsage.totalTokens.toLocaleString('en-IN')} GPT tokens`}
                    <small className="cell-sub">
                      {row.aiUsage.totalTokens == null
                        ? 'Tracking begins with migration 0007'
                        : `${row.aiUsage.inputTokens?.toLocaleString('en-IN') ?? 0} input · ${row.aiUsage.outputTokens?.toLocaleString('en-IN') ?? 0} output · ${row.aiUsage.audioSeconds ?? '0.000'}s Whisper`}
                    </small>
                  </td>
                  <td>{rowStatus(row)}</td>
                  <td>
                    {row.reAuditStatus ? (
                      <span className={`status-badge ${row.reAuditStatus}`}>
                        {row.reAuditStatus === 'processing' ? (
                          <RefreshCw size={13} aria-hidden />
                        ) : (
                          <Clock3 size={13} aria-hidden />
                        )}
                        {reAuditLabel(row)}
                      </span>
                    ) : (
                      '—'
                    )}
                  </td>
                  <td>
                    <Link
                      className="table-action"
                      to={period.routePath(
                        `/audits/call?task=${encodeURIComponent(
                          row.callReference,
                        )}`,
                      )}
                    >
                      Open call
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <PaginationFooter
          pagination={data.pagination}
          setPage={setPage}
        />
      </section>

      <section className="data-table content-section audit-table queue-table pending-table">
        <div className="table-heading">
          <div>
            <span className="eyebrow">Pending for audit</span>
            <h2><Clock3 size={19} aria-hidden /> Recording-backed queue</h2>
          </div>
          <span className="soft-chip">
            {data.pendingPagination.totalRows.toLocaleString('en-IN')} pending
          </span>
        </div>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Task / call reference</th>
                <th>Bill month</th>
                <th>Processing state</th>
                <th>Attempts</th>
                <th>Evidence baseline</th>
                <th>KServe billed minutes</th>
                <th>KServe connected</th>
                <th>Last activity</th>
              </tr>
            </thead>
            <tbody>
              {data.pendingRows.map((row) => (
                <tr key={row.callReference}>
                  <td><code>{row.callReference}</code></td>
                  <td>{date(row.billingPeriodDate)}</td>
                  <td>
                    <span className="status-badge audit_pending">
                      {row.processingStatus}
                    </span>
                  </td>
                  <td>{row.attemptCount}</td>
                  <td>
                    <span className={`integrity-dot ${row.evidenceHashRecorded ? 'good' : 'missing'}`} />
                    {row.evidenceHashRecorded ? 'Hashed' : 'Not hashed'}
                  </td>
                  <td>{row.vendorBilledMinutes || '—'}</td>
                  <td>{seconds(row.vendorConnectedDurationMs)}</td>
                  <td>{date(row.lastActivityAt)}</td>
                </tr>
              ))}
              {data.pendingRows.length === 0 && (
                <tr>
                  <td colSpan={8} className="table-empty">
                    No recording-backed calls are waiting for audit.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <PaginationFooter
          pagination={data.pendingPagination}
          setPage={setPendingPage}
        />
      </section>

      <section className="data-table content-section audit-table queue-table no-recording-table">
        <div className="table-heading">
          <div>
            <span className="eyebrow">No recording URL</span>
            <h2><FileQuestion size={19} aria-hidden /> Cannot be independently audited</h2>
          </div>
          <span className="soft-chip">
            {data.noRecordingPagination.totalRows.toLocaleString('en-IN')} calls
          </span>
        </div>
        <Notice tone="warning" title="KServe supplied no recording evidence">
          <AlertTriangle size={17} aria-hidden /> These calls cannot be
          listened to or transcribed. Admin review shows the available
          KServe usage and billing resolution without inventing evidence.
        </Notice>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Task / call reference</th>
                <th>Bill month</th>
                <th>Evidence state</th>
                <th>KServe billed minutes</th>
                <th>KServe connected</th>
                <th>Billing resolution</th>
                <th>Auditor amount</th>
                <th>Admin review</th>
              </tr>
            </thead>
            <tbody>
              {data.noRecordingRows.map((row) => (
                <tr key={row.callReference}>
                  <td><code>{row.callReference}</code></td>
                  <td>{date(row.billingPeriodDate)}</td>
                  <td>
                    <span className="status-badge provisional">
                      No recording URL
                    </span>
                  </td>
                  <td>{row.vendorBilledMinutes || '—'}</td>
                  <td>{seconds(row.vendorConnectedDurationMs)}</td>
                  <td>
                    {row.billingBasis || row.billingStatus || 'Audit pending'}
                  </td>
                  <td>{money(row.auditorAmount)}</td>
                  <td>
                    <Link
                      className="table-action"
                      to={period.routePath(
                        `/audits/call?task=${encodeURIComponent(
                          row.callReference,
                        )}`,
                      )}
                    >
                      Admin review
                    </Link>
                  </td>
                </tr>
              ))}
              {data.noRecordingRows.length === 0 && (
                <tr>
                  <td colSpan={8} className="table-empty">
                    Every call in this period has a recording URL.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <PaginationFooter
          pagination={data.noRecordingPagination}
          setPage={setNoRecordingPage}
        />
      </section>
      <UpdatedAt value={data.generatedAt} />
    </>
  )
}
