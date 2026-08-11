import { useQuery } from '@tanstack/react-query'
import { CheckCircle2, ShieldAlert } from 'lucide-react'
import { ErrorState, LoadingState, Notice } from '../components/States'
import { PageHeader, UpdatedAt } from '../components/Metrics'
import { getJson, type OperationsData, type StatusCount } from '../lib/api'

function StatusPanel({ title, rows }: { title: string; rows: StatusCount[] }) {
  const total = rows.reduce((sum, row) => sum + row.count, 0)
  return (
    <article className="status-panel">
      <header>
        <h2>{title}</h2>
        <strong>{total.toLocaleString('en-IN')}</strong>
      </header>
      {rows.length ? (
        <div>
          {rows.map((row) => (
            <p key={row.status}>
              <code>{row.status}</code>
              <span>{row.count.toLocaleString('en-IN')}</span>
            </p>
          ))}
        </div>
      ) : (
        <p className="muted">No records or migration not applied.</p>
      )}
    </article>
  )
}

export function OperationsPage() {
  const query = useQuery({
    queryKey: ['operations'],
    queryFn: () => getJson<OperationsData>('/api/v1/operations'),
  })
  if (query.isLoading) return <LoadingState />
  if (query.error)
    return <ErrorState error={query.error} retry={() => void query.refetch()} />
  const data = query.data!
  return (
    <>
      <PageHeader
        eyebrow="Reliability"
        title="Operations"
        description="Aggregate queue, retry, idempotency, and security-audit posture."
        badge={<span className="status-badge live">Operational</span>}
      />
      <Notice tone="info" title="System-wide view">
        Operations data spans all billing months. The global bill-month filter
        does not change queues, retries, idempotency, or access-audit totals.
      </Notice>
      {data.auditChainConfigured ? (
        <Notice tone="success" title="Hash-chained audit control is configured">
          {data.auditEvents?.toLocaleString('en-IN') ?? '—'} access and system
          events are currently recorded.
        </Notice>
      ) : (
        <Notice tone="warning" title="Security audit migration is not ready">
          The hash-chain head is unavailable. Do not expose this app beyond local use.
        </Notice>
      )}
      <div className="operations-grid">
        <StatusPanel title="Outbox" rows={data.outbox} />
        <StatusPanel title="Inbox" rows={data.inbox} />
        <StatusPanel title="Job attempts" rows={data.jobs} />
        <StatusPanel title="Idempotency" rows={data.idempotency} />
      </div>
      <section className="control-strip">
        {data.auditChainConfigured ? (
          <CheckCircle2 size={19} aria-hidden />
        ) : (
          <ShieldAlert size={19} aria-hidden />
        )}
        <div>
          <strong>Audit events</strong>
          <span>{data.auditEvents?.toLocaleString('en-IN') ?? 'Unavailable'}</span>
        </div>
      </section>
      <UpdatedAt value={data.generatedAt} />
    </>
  )
}
