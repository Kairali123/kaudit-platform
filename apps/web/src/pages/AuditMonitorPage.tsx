import { useQuery } from '@tanstack/react-query'
import {
  ChevronLeft,
  ChevronRight,
  LockKeyhole,
  ShieldCheck,
} from 'lucide-react'
import { useMemo, useState } from 'react'
import { MetricGrid, PageHeader, UpdatedAt } from '../components/Metrics'
import { ErrorState, LoadingState, Notice } from '../components/States'
import {
  getJson,
  type AuditMonitorData,
  type AuditMonitorRow,
  type Tile,
} from '../lib/api'

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

export function AuditMonitorPage() {
  const [page, setPage] = useState(1)
  const [category, setCategory] = useState('')
  const [language, setLanguage] = useState('')
  const queryString = new URLSearchParams({
    page: String(page),
    pageSize: '25',
    ...(category ? { category } : {}),
    ...(language ? { language } : {}),
  }).toString()
  const query = useQuery({
    queryKey: ['audit-monitor', page, category, language],
    queryFn: () =>
      getJson<AuditMonitorData>(`/api/v1/audits?${queryString}`),
  })
  const tiles = useMemo<Tile[]>(() => {
    const summary = query.data?.summary
    if (!summary) return []
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
        label: 'New V2 re-audit',
        value: summary.reauditV2Calls.toLocaleString('en-IN'),
        sub: 'Persisted production V2 results',
        status: summary.reauditV2Calls > 0 ? 'good' : 'pending',
      },
    ]
  }, [query.data])

  if (query.isLoading) return <LoadingState />
  if (query.error)
    return <ErrorState error={query.error} retry={() => void query.refetch()} />
  const data = query.data!
  return (
    <>
      <PageHeader
        eyebrow="Developer control"
        title="Audit monitor"
        description="Admin-only inspection of AI processing coverage and privacy-safe call-level audit metadata."
        badge={
          <span className="status-badge uncalibrated">
            <LockKeyhole size={13} aria-hidden /> Admin only
          </span>
        }
      />
      <Notice tone="warning" title="Model output is not calibrated ground truth">
        Use this view to detect implausible categories, confidence, durations, or
        stuck processing. These legacy outputs are not authoritative billing or
        clinical decisions.
      </Notice>
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
                <th>State</th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map((row) => (
                <tr key={`${row.callReference}-${row.auditedAt}`}>
                  <td>
                    <code>{row.callReference}</code>
                    <small className="cell-sub">
                      {row.sensitivityTier} · {date(row.billingPeriodDate)}
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
                  <td>{rowStatus(row)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <footer className="table-pagination">
          <span>
            Page {data.pagination.page} of {data.pagination.totalPages}
          </span>
          <div>
            <button
              type="button"
              disabled={page <= 1}
              onClick={() => setPage((value) => Math.max(1, value - 1))}
            >
              <ChevronLeft size={15} aria-hidden /> Previous
            </button>
            <button
              type="button"
              disabled={page >= data.pagination.totalPages}
              onClick={() => setPage((value) => value + 1)}
            >
              Next <ChevronRight size={15} aria-hidden />
            </button>
          </div>
        </footer>
      </section>
      <UpdatedAt value={data.generatedAt} />
    </>
  )
}
