import { useQuery } from '@tanstack/react-query'
import { ErrorState, LoadingState, Notice } from '../components/States'
import { MetricGrid, PageHeader, UpdatedAt } from '../components/Metrics'
import { KserveSettlementPanel } from '../components/KserveSettlement'
import { getJson, type BillingData, type Profile } from '../lib/api'
import { useBillingPeriod } from '../lib/billingPeriod'

export function BillingPage() {
  const period = useBillingPeriod()
  const query = useQuery({
    queryKey: ['billing', period.month],
    queryFn: () =>
      getJson<BillingData>(period.apiPath('/api/v1/billing')),
  })
  /**
   * Already fetched and cached by the app shell. Recording what was paid is an
   * admin-only money action, so the section is hidden for everyone else —
   * presentation only: the API refuses a non-administrator regardless.
   */
  const profileQuery = useQuery({
    queryKey: ['me'],
    queryFn: () => getJson<Profile>('/api/v1/me'),
    retry: false,
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
        description={`Independent calculation and reconciliation posture for ${period.label}.`}
        badge={
          <span className={`status-badge ${data.authority}`}>
            {data.billing.cycleStatusLabel}
          </span>
        }
      />
      {data.authority === 'provisional' && (
        <Notice
          tone="warning"
          title={`Verified bill withheld — ${data.billing.cycleStatusLabel.toLowerCase()}`}
        >
          The platform will not release Kairali&apos;s verified bill until
          every release gate for this cycle is complete. Calls without
          recordings count as resolved only after the cycle-close fallback
          explicitly records them as accepted-as-billed; they are never
          silently treated as audited.
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
      <KserveSettlementPanel
        month={period.month}
        monthLabel={period.label}
        isAdmin={profileQuery.data?.roles.includes('admin') === true}
      />
      <UpdatedAt value={data.generatedAt} />
    </>
  )
}
