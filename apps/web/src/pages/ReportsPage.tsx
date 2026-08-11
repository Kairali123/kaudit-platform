import { useQuery } from '@tanstack/react-query'
import { ArrowDownRight, ArrowRight, ArrowUpRight, Minus } from 'lucide-react'
import { ErrorState, LoadingState, Notice } from '../components/States'
import { PageHeader, UpdatedAt } from '../components/Metrics'
import { getJson, type ReportsData } from '../lib/api'
import { useBillingPeriod } from '../lib/billingPeriod'

export function ReportsPage() {
  const period = useBillingPeriod()
  const query = useQuery({
    queryKey: ['reports', period.month],
    queryFn: () =>
      getJson<ReportsData>(period.apiPath('/api/v1/reports')),
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
        description={
          period.month === 'all'
            ? 'Short management views at weekly, monthly, quarterly, and yearly cadence.'
            : `Monthly revenue snapshot for ${period.label}; choose All periods for cross-cadence reporting.`
        }
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
      <Notice
        tone={
          data.emailDelivery?.status === 'published'
            ? 'success'
            : data.emailDelivery?.status === 'dead_letter'
              ? 'warning'
              : 'info'
        }
        title="Automated PDF + Excel email delivery"
      >
        {period.month === 'all'
          ? 'Choose one bill month to see its delivery status.'
          : data.emailDelivery?.status === 'published'
            ? `Sent ${data.emailDelivery.sentAt ? new Date(data.emailDelivery.sentAt).toLocaleString('en-IN') : ''}.`
            : data.emailDelivery?.status === 'pending' ||
                data.emailDelivery?.status === 'retry' ||
                data.emailDelivery?.status === 'publishing'
              ? `Delivery is ${data.emailDelivery.status}; ${data.emailDelivery.attempts} failed attempt(s).`
              : data.emailDelivery?.status === 'dead_letter'
                ? `Delivery stopped after ${data.emailDelivery.attempts} attempt(s): ${data.emailDelivery.lastErrorCode || 'unknown failure'}.`
                : 'Not queued. Email is created automatically only after the full audit, final traced billing, published rate card, uploaded invoice, and reporting approval are all present.'}
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
