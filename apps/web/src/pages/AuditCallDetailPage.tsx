import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import {
  ArrowLeft,
  FileText,
  Headphones,
  ShieldAlert,
} from 'lucide-react'
import { Link, useSearchParams } from 'react-router-dom'
import { PageHeader, UpdatedAt } from '../components/Metrics'
import { ErrorState, LoadingState, Notice } from '../components/States'
import {
  getJson,
  type AdminCallDetailData,
} from '../lib/api'
import { useBillingPeriod } from '../lib/billingPeriod'

function seconds(value: number | null): string {
  return value == null ? '—' : `${(value / 1000).toFixed(1)} sec`
}

function money(value: string | null): string {
  if (value == null) return '—'
  return `₹${Number(value).toLocaleString('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`
}

function timestamp(value: number): string {
  const seconds = Math.max(0, Math.floor(value / 1000))
  const minutes = Math.floor(seconds / 60)
  return `${minutes}:${String(seconds % 60).padStart(2, '0')}`
}

export function AuditCallDetailPage() {
  const period = useBillingPeriod()
  const [params] = useSearchParams()
  const [audioState, setAudioState] = useState<
    'pending' | 'verifying' | 'ready' | 'failed'
  >('pending')
  const task = params.get('task') || ''
  const encoded = encodeURIComponent(task)
  const query = useQuery({
    queryKey: ['admin-call-detail', task],
    queryFn: () =>
      getJson<AdminCallDetailData>(
        `/api/v1/audit-call?task=${encoded}`,
      ),
    enabled: Boolean(task),
    staleTime: 0,
  })
  if (!task) {
    return (
      <ErrorState
        error={new Error('No call reference was selected.')}
        retry={() => window.history.back()}
      />
    )
  }
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
  return (
    <>
      <Link
        className="back-link"
        to={period.routePath('/audits')}
      >
        <ArrowLeft size={15} aria-hidden /> Back to audit monitor
      </Link>
      <PageHeader
        eyebrow="Admin call review"
        title="Call evidence and calculation"
        description={data.call.reference}
        badge={
          <span className="status-badge automated">
            {data.call.confirmationStatus || 'Not finalized'}
          </span>
        }
      />
      <Notice tone="warning" title="Restricted customer content">
        <ShieldAlert size={17} aria-hidden />{' '}
        {data.evidence.recordingAvailable
          ? 'This page contains a recording and may contain a transcript.'
          : 'KServe supplied no recording; this page contains only the available call and billing metadata.'}{' '}
        Access is admin-only, sensitivity-checked, non-cacheable, and
        written to the audit log.
      </Notice>

      <section className="call-review-grid content-section">
        <article className="review-card">
          <span>KServe sheet charge</span>
          <strong>{money(data.comparison.kserve.amount)}</strong>
          <p>
            {data.comparison.kserve.billedMinutes || '—'} minutes × ₹
            {Number(data.comparison.kserve.unitRate).toFixed(2)}
          </p>
          <small>{data.comparison.kserve.basis}</small>
        </article>
        <article className="review-card">
          <span>Auditor verified charge</span>
          <strong>{money(data.comparison.auditor.amount)}</strong>
          <p>
            {data.comparison.auditor.billableMinutes || '—'} minutes × ₹
            {data.comparison.auditor.unitRate
              ? Number(data.comparison.auditor.unitRate).toFixed(2)
              : '—'}
          </p>
          <small>
            {data.comparison.auditor.ruleCode || 'No calculation'} ·{' '}
            {data.comparison.auditor.billingIncrement || '—'}
          </small>
        </article>
        <article className="review-card variance-card">
          <span>Per-call variance</span>
          <strong>{money(data.comparison.variance)}</strong>
          <p>KServe amount minus auditor amount</p>
          <small>
            Rate card {data.comparison.auditor.rateCardVersion || '—'} ·{' '}
            {data.comparison.auditor.rateCardStatus || '—'}
          </small>
        </article>
      </section>
      <p className="calculation-footnote">
        Per-call amounts are pre-tax subtotals. IGST, TDS, and invoice
        round-off are applied only when the complete billing cycle is
        reconciled.
      </p>

      <section className="call-detail-facts content-section">
        <div><span>Category</span><strong>{data.call.category || '—'}</strong></div>
        <div><span>Confidence</span><strong>{data.call.confidence ? `${(Number(data.call.confidence) * 100).toFixed(1)}%` : '—'}</strong></div>
        <div><span>Language</span><strong>{data.call.language || '—'}</strong></div>
        <div><span>Recorded</span><strong>{seconds(data.durations.recordedMs)}</strong></div>
        <div><span>Speech</span><strong>{seconds(data.durations.speechMs)}</strong></div>
        <div><span>Customer end</span><strong>{seconds(data.durations.finalCustomerExchangeMs)}</strong></div>
        <div><span>KServe connected</span><strong>{seconds(data.durations.vendorConnectedMs)}</strong></div>
        <div><span>Auditor billable</span><strong>{seconds(data.comparison.auditor.billableDurationMs)}</strong></div>
      </section>

      <section className="content-section evidence-player">
        <div className="table-heading">
          <div>
            <span className="eyebrow">Recording evidence</span>
            <h2><Headphones size={19} aria-hidden /> Listen to call</h2>
          </div>
          <span className={`soft-chip audio-state-${audioState}`}>
            {audioState === 'ready'
              ? 'SHA-256 verified · ready to play'
              : audioState === 'verifying'
                ? 'Fetching and verifying recording…'
                : audioState === 'failed'
                  ? 'Verification or playback failed'
                  : data.evidence.evidenceHashRecorded
                    ? 'Press play to verify current bytes'
                    : 'Hash unavailable'}
          </span>
        </div>
        {data.evidence.recordingAvailable ? (
          <>
            <audio
              controls
              preload="metadata"
              src={`/api/v1/audit-audio?task=${encoded}`}
              onLoadStart={() => setAudioState('verifying')}
              onCanPlay={() => setAudioState('ready')}
              onError={() => setAudioState('failed')}
            >
              Your browser does not support audio playback.
            </audio>
            <p className="player-help">
              The server fetches the current KServe recording and compares
              its SHA-256 with the stored ingestion hash before sending any
              playable bytes. If the source is missing or changed, playback
              fails closed.
            </p>
          </>
        ) : (
          <p className="muted">KServe supplied no recording for this call.</p>
        )}
      </section>

      <section className="content-section transcript-panel">
        <div className="table-heading">
          <div>
            <span className="eyebrow">Timestamped ASR</span>
            <h2><FileText size={19} aria-hidden /> Transcript</h2>
          </div>
          <span className="soft-chip">
            {data.transcript.segments.length} segments
          </span>
        </div>
        {data.transcript.available ? (
          <ol>
            {data.transcript.segments.map((segment, index) => (
              <li key={`${segment.startMs}-${index}`}>
                <time>
                  {timestamp(segment.startMs)}–{timestamp(segment.endMs)}
                </time>
                <p>{segment.text}</p>
              </li>
            ))}
          </ol>
        ) : (
          <p className="muted">No transcript is available.</p>
        )}
      </section>
      <UpdatedAt value={data.generatedAt} />
    </>
  )
}
