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
            {data.authority}
          </span>
        }
      />
      {data.authority === 'provisional' && (
        <Notice tone="warning" title="Pending formal rate-card approval (D-03)">
          Existing calculations used a draft rate card. Amounts are visible for
          monitoring only and must not be treated as payable, receivable, or recovered.
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
      </section>
      <UpdatedAt value={data.generatedAt} />
    </>
  )
}
