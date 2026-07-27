import { useQuery } from '@tanstack/react-query'
import { ArrowDownRight, ArrowRight, ArrowUpRight, Minus } from 'lucide-react'
import { ErrorState, LoadingState, Notice } from '../components/States'
import { PageHeader, UpdatedAt } from '../components/Metrics'
import { getJson, type ReportsData } from '../lib/api'

export function ReportsPage() {
  const query = useQuery({
    queryKey: ['reports'],
    queryFn: () => getJson<ReportsData>('/api/v1/reports'),
  })
  if (query.isLoading) return <LoadingState />
  if (query.error)
    return <ErrorState error={query.error} retry={() => void query.refetch()} />
  const data = query.data!
  return (
    <>
      <PageHeader
        eyebrow="D-12"
        title="Revenue snapshots"
        description="Short management views at weekly, monthly, quarterly, and yearly cadence."
        badge={
          <span className={`status-badge ${data.authority}`}>
            {data.authority === 'audit_pending'
              ? 'Audit pending'
              : data.authority}
          </span>
        }
      />
      {data.authority === 'audit_pending' && (
        <Notice tone="warning" title="Report generation waiting for audit">
          Verified revenue and variance are withheld until all{' '}
          {data.billingCycle.totalCalls.toLocaleString('en-IN')} calls in the
          billing cycle are resolved. Vendor-claimed values may be visible, but
          they are not Kairali&apos;s verified bill.
        </Notice>
      )}
      {data.authority === 'provisional' && (
        <Notice tone="warning" title="Projection—not an approved management snapshot">
          D-03 and D-12-A remain open. Periods and values are live aggregates, not
          signed financial statements.
        </Notice>
      )}
      <Notice tone="info" title="Current delivery: protected dashboard">
        PDF/Excel export and automatic finance/management notifications are not
        active yet. When implemented, they will run only after this cycle gate
        releases the verified figures.
      </Notice>
      <div className="snapshot-grid">
        {data.snapshots.map((snapshot) => {
          const TrendIcon =
            snapshot.trend === 'up'
              ? ArrowUpRight
              : snapshot.trend === 'down'
                ? ArrowDownRight
                : snapshot.trend === 'flat'
                  ? ArrowRight
                  : Minus
          return (
            <article className="snapshot-card" key={snapshot.cadence}>
              <header>
                <div>
                  <span className="eyebrow">{snapshot.cadence}</span>
                  <h2>{snapshot.label}</h2>
                  <p>{snapshot.period}</p>
                </div>
                <span className={`trend ${snapshot.trend}`}>
                  <TrendIcon size={15} aria-hidden />
                  {snapshot.trendLabel}
                </span>
              </header>
              <dl>
                <div>
                  <dt>Verified billable</dt>
                  <dd>{snapshot.verified}</dd>
                </div>
                <div>
                  <dt>Vendor claim</dt>
                  <dd>{snapshot.vendorClaimed}</dd>
                  <small>{snapshot.basisLabel}</small>
                </div>
                <div>
                  <dt>Variance identified</dt>
                  <dd>{snapshot.variance}</dd>
                  <small>not recovered savings</small>
                </div>
              </dl>
            </article>
          )
        })}
      </div>
      <UpdatedAt value={data.generatedAt} />
    </>
  )
}
