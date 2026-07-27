import { useQuery } from '@tanstack/react-query'
import { ErrorState, LoadingState, Notice } from '../components/States'
import { MetricGrid, PageHeader, UpdatedAt } from '../components/Metrics'
import { getJson, type BillingData } from '../lib/api'

export function BillingPage() {
  const query = useQuery({
    queryKey: ['billing'],
    queryFn: () => getJson<BillingData>('/api/v1/billing'),
  })
  if (query.isLoading) return <LoadingState />
  if (query.error)
    return <ErrorState error={query.error} retry={() => void query.refetch()} />
  const data = query.data!
  return (
    <>
      <PageHeader
        eyebrow="Finance"
        title="Billing"
        description="Independent calculation totals and the current reconciliation posture."
        badge={
          <span className={`status-badge ${data.authority}`}>
            {data.billing.cycleStatusLabel}
          </span>
        }
      />
      {data.authority === 'audit_pending' && (
        <Notice tone="warning" title="Verified bill withheld — audit pending">
          The platform will not release Kairali&apos;s verified bill while this
          cycle has unresolved calls. Calls without recordings count as resolved
          only after the cycle-close fallback explicitly records them as
          accepted-as-billed; they are never silently treated as audited.
        </Notice>
      )}
      <MetricGrid tiles={data.billing.tiles} />
      <section className="billing-facts content-section">
        <article>
          <span>Rate card</span>
          <strong>{data.billing.rateCardLabel}</strong>
          <p>{data.billing.rateCardApprovalLabel}</p>
        </article>
        <article>
          <span>Reconciliation</span>
          <strong>{data.billing.reconciliationStatus}</strong>
          <p>Variance remains identified—not recovered—until a closed reconciliation.</p>
        </article>
        <article>
          <span>Cycle completion</span>
          <strong>{data.billing.cycle.auditCoveragePercent}%</strong>
          <p>
            {data.billing.cycle.resolvedAuditCalls.toLocaleString('en-IN')} of{' '}
            {data.billing.cycle.totalCalls.toLocaleString('en-IN')} calls
            resolved
          </p>
        </article>
      </section>
      <UpdatedAt value={data.generatedAt} />
    </>
  )
}
