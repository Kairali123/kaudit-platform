import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'
import {
  AlertTriangle,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Clock3,
  FileQuestion,
  LockKeyhole,
  RefreshCw,
  Search,
  ShieldCheck,
  X,
} from 'lucide-react'
import {
  useEffect,
  useMemo,
  useState,
  type Dispatch,
  type FormEvent,
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
  type AuditMonitorCoreSummaryData,
  type AuditMonitorFinancialSummaryData,
  type AuditMonitorRowsData,
  type AuditMonitorRow,
  type AuditMonitorUsageSummaryData,
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
  return row.reAuditStatus === 'queued' || row.reAuditStatus === 'processing'
}

function reAuditLabel(row: AuditMonitorRow): string {
  if (row.reAuditStatus === 'processing') return 'Re-auditing'
  if (row.reAuditStatus === 'queued') return 'Re-audit queued'
  if (row.reAuditStatus === 'completed') return 'Re-audited'
  return row.reAuditStatus === 'failed' ? 'Re-audit failed' : ''
}

function reAuditFailure(row: AuditMonitorRow): string {
  const labels: Record<string, string> = {
    REAUDIT_WORKER_INTERRUPTED: 'Worker interrupted',
    REAUDIT_RECORDING_UNAVAILABLE: 'Recording unavailable',
    TRANSCRIPTION_FAILED: 'Transcription failed',
    CLASSIFICATION_FAILED: 'Classification failed',
    CLASSIFICATION_MODEL_FAILED: 'Classification model failed',
    CLASSIFICATION_VALIDATION_FAILED: 'Classification output inconsistent',
    CLASSIFICATION_OUTPUT_UNRECOVERABLE: 'Classification output could not be safely repaired',
    AUDIT_SPEND_STATE_UNKNOWN: 'Model request state unknown',
    AUDIT_PROCESSOR_FAILED: 'Audit processor failed',
  }
  return row.reAuditFailureCode
    ? labels[row.reAuditFailureCode] ?? 'Re-audit processing failed'
    : 'Re-audit processing failed'
}

function reAuditIcon(row: AuditMonitorRow) {
  if (row.reAuditStatus === 'processing') {
    return <RefreshCw size={13} aria-hidden />
  }
  if (row.reAuditStatus === 'completed') {
    return <CheckCircle2 size={13} aria-hidden />
  }
  if (row.reAuditStatus === 'failed') {
    return <AlertTriangle size={13} aria-hidden />
  }
  return <Clock3 size={13} aria-hidden />
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

function withTotalRows(
  pagination: AuditPagination | undefined,
  totalRows: number | undefined,
  page: number,
): AuditPagination {
  const current = pagination ?? {
    page,
    pageSize: 25,
    totalRows: 0,
    totalPages: 1,
  }
  if (totalRows == null) return current
  return {
    ...current,
    totalRows,
    totalPages: Math.max(1, Math.ceil(totalRows / current.pageSize)),
  }
}

function resultCount(totalRows: number, final: boolean): string {
  return `${totalRows.toLocaleString('en-IN')}${final ? '' : '+'}`
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
  const [taskIdDraft, setTaskIdDraft] = useState('')
  const [taskId, setTaskId] = useState('')
  const queryString = new URLSearchParams({
    page: String(page),
    pendingPage: String(pendingPage),
    noRecordingPage: String(noRecordingPage),
    pageSize: '25',
    ...(category ? { category } : {}),
    ...(taskId ? { taskId } : {}),
  }).toString()
  const summaryFilterQueryString = new URLSearchParams({
    ...(category ? { category } : {}),
    ...(taskId ? { taskId } : {}),
  }).toString()
  const auditedRowsQuery = useQuery({
    queryKey: [
      'audit-monitor',
      'rows',
      'audited',
      period.month,
      page,
      category,
      taskId,
    ],
    queryFn: () =>
      getJson<AuditMonitorRowsData>(
        period.apiPath(
          `/api/v1/audits?section=rows&table=audited&${queryString}`,
        ),
      ),
    // Keep the last completed page visible while the live worker moves rows.
    // A minute is current enough for operations without continuously rerunning
    // the monitor's audited/pending/no-recording joins against the worker DB.
    placeholderData: keepPreviousData,
    retry: false,
    refetchInterval: 60_000,
  })
  const pendingRowsQuery = useQuery({
    queryKey: [
      'audit-monitor',
      'rows',
      'pending',
      period.month,
      pendingPage,
      taskId,
    ],
    queryFn: () =>
      getJson<AuditMonitorRowsData>(
        period.apiPath(
          `/api/v1/audits?section=rows&table=pending&${queryString}`,
        ),
      ),
    // Each table's page read is a separate multi-join scan over the same call
    // and artifact tables. Issuing all three at once was the monitor's largest
    // single burst, so they now follow the summaries' rule and start in the
    // order they appear on screen.
    enabled: auditedRowsQuery.isFetched,
    placeholderData: keepPreviousData,
    retry: false,
    refetchInterval: 60_000,
  })
  const noRecordingRowsQuery = useQuery({
    queryKey: [
      'audit-monitor',
      'rows',
      'no-recording',
      period.month,
      noRecordingPage,
      taskId,
    ],
    queryFn: () =>
      getJson<AuditMonitorRowsData>(
        period.apiPath(
          `/api/v1/audits?section=rows&table=no-recording&${queryString}`,
        ),
      ),
    enabled: pendingRowsQuery.isFetched,
    placeholderData: keepPreviousData,
    retry: false,
    refetchInterval: 60_000,
  })
  const summaryEnabled =
    auditedRowsQuery.isFetched &&
    pendingRowsQuery.isFetched &&
    noRecordingRowsQuery.isFetched
  const coreSummaryQuery = useQuery({
    queryKey: [
      'audit-monitor',
      'summary-core',
      period.month,
      category,
      taskId,
    ],
    queryFn: () =>
      getJson<AuditMonitorCoreSummaryData>(
        period.apiPath(
          `/api/v1/audits?section=summary-core&${summaryFilterQueryString}`,
        ),
      ),
    // Start after each table has made its first attempt. The three summaries
    // then start in priority order so the database is not asked to run its
    // heaviest monitor aggregates at the same time.
    enabled: summaryEnabled,
    retry: false,
    refetchInterval: 60_000,
  })
  const usageSummaryQuery = useQuery({
    queryKey: [
      'audit-monitor',
      'summary-usage',
      period.month,
      category,
      taskId,
    ],
    queryFn: () =>
      getJson<AuditMonitorUsageSummaryData>(
        period.apiPath(
          `/api/v1/audits?section=summary-usage&${summaryFilterQueryString}`,
        ),
      ),
    enabled: coreSummaryQuery.isFetched,
    retry: false,
    refetchInterval: 60_000,
  })
  const financialSummaryQuery = useQuery({
    queryKey: [
      'audit-monitor',
      'summary-financial',
      period.month,
      category,
      taskId,
    ],
    queryFn: () =>
      getJson<AuditMonitorFinancialSummaryData>(
        period.apiPath(
          `/api/v1/audits?section=summary-financial&${summaryFilterQueryString}`,
        ),
      ),
    enabled: usageSummaryQuery.isFetched,
    retry: false,
    refetchInterval: 60_000,
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
  }, [period.month, page, category, taskId])
  const resetPages = () => {
    setPage(1)
    setPendingPage(1)
    setNoRecordingPage(1)
  }
  const applyTaskSearch = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const nextTaskId = taskIdDraft.trim()
    setTaskId(nextTaskId)
    setTaskIdDraft(nextTaskId)
    setCategory('')
    resetPages()
  }
  const clearTaskSearch = () => {
    setTaskId('')
    setTaskIdDraft('')
    resetPages()
  }
  const tiles = useMemo<Tile[]>(() => {
    const summary = coreSummaryQuery.data?.summary
    const usage = usageSummaryQuery.data
    const financials = financialSummaryQuery.data?.auditedFinancials
    const result: Tile[] = []
    if (summary) {
      result.push({
        label: 'Bill-audited calls',
        value: summary.billAuditedCalls.toLocaleString('en-IN'),
        sub: `${summary.auditCoveragePercent}% of ${summary.totalCalls.toLocaleString('en-IN')} ingested · ${summary.aiAuditedCalls.toLocaleString('en-IN')} independently analyzed`,
        status: summary.billAuditedCalls > 0 ? 'good' : 'pending',
      }, {
        label: 'Eligible, still pending',
        value: summary.pendingEligibleCalls.toLocaleString('en-IN'),
        sub: `${summary.recordingAvailableCalls.toLocaleString('en-IN')} recording URLs · ${summary.processingFailureCalls.toLocaleString('en-IN')} processing failures`,
        status: summary.pendingEligibleCalls > 0 ? 'warn' : 'good',
      }, {
        label: 'No recording',
        value: summary.noRecordingCalls.toLocaleString('en-IN'),
        // States the fact, not an outcome. These calls carry a billing
        // determination only once cycle close records one; until then they
        // are unverifiable and unpriced, and saying otherwise reported a
        // month as fully audited while most of it had no amount at all.
        sub: 'KServe supplied no recording · cannot be independently audited',
        status: summary.noRecordingCalls > 0 ? 'warn' : 'good',
      })
    }
    if (usage) {
      result.push({
        label: 'GPT tokens recorded',
        value: usage.aiUsage.historicalUsageRecorded
          ? usage.aiUsage.gptTotalTokens.toLocaleString('en-IN')
          : 'Not recorded',
        sub: usage.aiUsage.historicalUsageRecorded
          ? `${usage.aiUsage.gptInputTokens.toLocaleString('en-IN')} input · ${usage.aiUsage.gptOutputTokens.toLocaleString('en-IN')} output · ${usage.aiUsage.trackedAuditRuns.toLocaleString('en-IN')} audits`
          : 'Tracking begins after migration 0007; legacy usage cannot be reconstructed exactly',
        status:
          usage.aiUsage.historicalUsageRecorded
            ? 'good'
            : 'pending',
      }, {
        label: 'Whisper audio processed',
        value: usage.aiUsage.historicalUsageRecorded
          ? `${(
              Number(usage.aiUsage.whisperAudioSeconds) / 60
            ).toLocaleString('en-IN', {
              minimumFractionDigits: 2,
              maximumFractionDigits: 2,
            })} min`
          : 'Not recorded',
        sub:
          'Whisper-1 reports billed audio duration, not text tokens',
        status:
          usage.aiUsage.historicalUsageRecorded
            ? 'good'
            : 'pending',
      })
    }
    if (usage && financials) {
      const untrackedCalls = Math.max(
        0,
        financials.scopedAuditedCalls - usage.aiSpend.aiSpendTrackedCalls,
      )
      result.push({
        label: 'Estimated AI spend',
        value: usd(usage.aiSpend.estimatedAiSpendUsd),
        sub:
          `${usage.aiSpend.aiSpendTrackedCalls.toLocaleString('en-IN')} of ` +
          `${financials.scopedAuditedCalls.toLocaleString('en-IN')} audited calls tracked` +
          (untrackedCalls > 0
            ? ` · ${untrackedCalls.toLocaleString('en-IN')} legacy costs unavailable`
            : '') +
          (usage.aiSpend.unpricedAiUsageRows > 0
            ? ` · ${usage.aiSpend.unpricedAiUsageRows.toLocaleString('en-IN')} unpriced model rows`
            : '') +
          ` · ${usage.aiSpend.aiSpendPricingBasis}`,
        status:
          untrackedCalls === 0 &&
          usage.aiSpend.unpricedAiUsageRows === 0
            ? 'good'
            : 'warn',
      })
    }
    if (financials) {
      result.push({
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
      }, {
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
      })
    }
    return result
  }, [
    coreSummaryQuery.data,
    financialSummaryQuery.data,
    usageSummaryQuery.data,
  ])

  const pageChrome = (
    <>
      <PageHeader
        eyebrow="Developer control"
        title="Audit monitor"
        description={`Admin-only bill-audit coverage and privacy-safe audit metadata for ${period.label}.`}
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
    </>
  )
  const data = auditedRowsQuery.data
  const pendingData = pendingRowsQuery.data
  const noRecordingData = noRecordingRowsQuery.data
  const summaryData = coreSummaryQuery.data
  const financialSummaryData = financialSummaryQuery.data
  const generatedAt =
    data?.generatedAt ??
    pendingData?.generatedAt ??
    noRecordingData?.generatedAt ??
    summaryData?.generatedAt ??
    usageSummaryQuery.data?.generatedAt ??
    financialSummaryData?.generatedAt
  const queueTotalsFinal = summaryData != null
  const auditedTotalFinal = financialSummaryData != null
  const auditedPagination = withTotalRows(
    data?.pagination,
    financialSummaryData?.auditedFinancials.scopedAuditedCalls,
    page,
  )
  const pendingPagination = withTotalRows(
    pendingData?.pendingPagination,
    summaryData?.summary.pendingEligibleCalls,
    pendingPage,
  )
  const noRecordingPagination = withTotalRows(
    noRecordingData?.noRecordingPagination,
    summaryData?.summary.noRecordingCalls,
    noRecordingPage,
  )
  const selectable = (data?.rows ?? [])
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
      {pageChrome}
      {coreSummaryQuery.isLoading && <LoadingState />}
      {coreSummaryQuery.error && <ErrorState
        error={coreSummaryQuery.error}
        retry={() => void coreSummaryQuery.refetch()}
      />}
      {usageSummaryQuery.error && <ErrorState
        error={usageSummaryQuery.error}
        retry={() => void usageSummaryQuery.refetch()}
      />}
      {financialSummaryQuery.error && <ErrorState
        error={financialSummaryQuery.error}
        retry={() => void financialSummaryQuery.refetch()}
      />}
      {tiles.length > 0 && <MetricGrid tiles={tiles} />}

      <section className="content-section audit-control-bar">
        <div>
          <ShieldCheck size={18} aria-hidden />
          <span>
            Admin-only audit metadata. Use Admin review for restricted evidence,
            transcript, and per-call billing context when available.
          </span>
        </div>
        <form className="audit-task-search" onSubmit={applyTaskSearch}>
          <label htmlFor="audit-task-id">Task ID</label>
          <div className="audit-search-field">
            <input
              id="audit-task-id"
              type="search"
              value={taskIdDraft}
              maxLength={191}
              pattern="[A-Za-z0-9_-]{1,191}"
              autoComplete="off"
              spellCheck={false}
              placeholder="Exact Task ID"
              onChange={(event) => setTaskIdDraft(event.target.value)}
            />
            {(taskIdDraft || taskId) && (
              <button
                type="button"
                className="icon-button"
                title="Clear Task ID search"
                aria-label="Clear Task ID search"
                onClick={clearTaskSearch}
              >
                <X size={15} aria-hidden />
              </button>
            )}
            <button
              type="submit"
              className="icon-button audit-search-submit"
              title="Search exact Task ID"
              aria-label="Search exact Task ID"
            >
              <Search size={16} aria-hidden />
            </button>
          </div>
        </form>
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
            {(summaryData?.filters.availableCategories ?? []).map((value) => (
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
            {resultCount(auditedPagination.totalRows, auditedTotalFinal)} results
          </span>
        </div>
        {auditedRowsQuery.isLoading && <LoadingState />}
        {auditedRowsQuery.error && <ErrorState
          error={auditedRowsQuery.error}
          retry={() => void auditedRowsQuery.refetch()}
        />}
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
              {(data?.rows ?? []).map((row) => (
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
                        {reAuditIcon(row)}
                        {reAuditLabel(row)}
                        {(row.reAuditStatus === 'completed' ||
                          row.reAuditStatus === 'failed') && (
                          <small className="cell-sub">
                            {date(row.reAuditCompletedAt)}
                            {row.reAuditStatus === 'failed'
                              ? ` · ${reAuditFailure(row)} · Previous audit retained`
                              : ''}
                          </small>
                        )}
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
              {auditedRowsQuery.isSuccess && data?.rows.length === 0 && (
                <tr>
                  <td colSpan={isAdmin ? 18 : 17} className="table-empty">
                    {taskId
                      ? 'No audited call matches this Task ID in the selected bill month.'
                      : 'No audited calls match the current filters.'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <PaginationFooter
          pagination={auditedPagination}
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
            {resultCount(pendingPagination.totalRows, queueTotalsFinal)} pending
          </span>
        </div>
        {pendingRowsQuery.isLoading && <LoadingState />}
        {pendingRowsQuery.error && <ErrorState
          error={pendingRowsQuery.error}
          retry={() => void pendingRowsQuery.refetch()}
        />}
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
              {(pendingData?.pendingRows ?? []).map((row) => (
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
              {pendingRowsQuery.isSuccess &&
                pendingData?.pendingRows.length === 0 && (
                <tr>
                  <td colSpan={8} className="table-empty">
                    {taskId
                      ? 'No pending call matches this Task ID in the selected bill month.'
                      : 'No recording-backed calls are waiting for audit.'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <PaginationFooter
          pagination={pendingPagination}
          setPage={setPendingPage}
        />
      </section>

      <section className="data-table content-section audit-table queue-table no-recording-table">
        <div className="table-heading">
          <div>
            <span className="eyebrow">No recording supplied</span>
            <h2><FileQuestion size={19} aria-hidden /> Bill audited at zero</h2>
          </div>
          <span className="soft-chip">
            {resultCount(noRecordingPagination.totalRows, queueTotalsFinal)} calls
          </span>
        </div>
        <Notice tone="warning" title="No Recording Found">
          <AlertTriangle size={17} aria-hidden /> The bill audit found no
          recording URL, so the audited amount is ₹0.00. No listening or
          transcription result is claimed.
        </Notice>
        {noRecordingRowsQuery.isLoading && <LoadingState />}
        {noRecordingRowsQuery.error && <ErrorState
          error={noRecordingRowsQuery.error}
          retry={() => void noRecordingRowsQuery.refetch()}
        />}
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
                <th>Remarks</th>
                <th>Admin review</th>
              </tr>
            </thead>
            <tbody>
              {(noRecordingData?.noRecordingRows ?? []).map((row) => (
                <tr key={row.callReference}>
                  <td><code>{row.callReference}</code></td>
                  <td>{date(row.billingPeriodDate)}</td>
                  <td>
                    <span className="status-badge provisional">
                      No recording supplied
                    </span>
                  </td>
                  <td>{row.vendorBilledMinutes || '—'}</td>
                  <td>{seconds(row.vendorConnectedDurationMs)}</td>
                  <td>
                    {row.billingBasis || 'Audited · no recording'}
                  </td>
                  <td>{money(row.auditorAmount)}</td>
                  <td>{row.auditRemark || '—'}</td>
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
              {noRecordingRowsQuery.isSuccess &&
                noRecordingData?.noRecordingRows.length === 0 && (
                <tr>
                  <td colSpan={9} className="table-empty">
                    {taskId
                      ? 'No no-recording call matches this Task ID in the selected bill month.'
                      : 'Every call in this period has a recording URL.'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <PaginationFooter
          pagination={noRecordingPagination}
          setPage={setNoRecordingPage}
        />
      </section>
      {generatedAt && <UpdatedAt value={generatedAt} />}
    </>
  )
}
