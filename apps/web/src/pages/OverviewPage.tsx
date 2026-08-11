import { useQuery } from '@tanstack/react-query'
import { CheckCircle2, CircleDashed, OctagonAlert } from 'lucide-react'
import { ErrorState, LoadingState } from '../components/States'
import { MetricGrid, PageHeader, UpdatedAt } from '../components/Metrics'
import { getJson, type OverviewData } from '../lib/api'
import { useBillingPeriod } from '../lib/billingPeriod'

export function OverviewPage() {
  const period = useBillingPeriod()
  const query = useQuery({
    queryKey: ['overview', period.month],
    queryFn: () =>
      getJson<OverviewData>(period.apiPath('/api/v1/overview')),
  })
  if (query.isLoading) return <LoadingState />
  if (query.error)
    return <ErrorState error={query.error} retry={() => void query.refetch()} />
  const data = query.data!
  return (
    <>
      <PageHeader
        eyebrow="Overview"
        title="Platform overview"
        description={`Headline system coverage and release readiness for ${period.label}.`}
        badge={<span className="status-badge live">Live aggregates</span>}
      />
      <MetricGrid tiles={data.tiles.slice(0, 4)} />
      <section className="content-section">
        <div className="section-title">
          <div>
            <span className="eyebrow">Release control</span>
            <h2>Authority gates</h2>
          </div>
        </div>
        <div className="gate-list">
          {data.gates.map((gate) => {
            const Icon =
              gate.status === 'ready'
                ? CheckCircle2
                : gate.status === 'blocked'
                  ? OctagonAlert
                  : CircleDashed
            return (
              <article className={gate.status} key={gate.code}>
                <Icon size={19} aria-hidden />
                <div>
                  <strong>{gate.label}</strong>
                  <p>{gate.detail}</p>
                </div>
                <span>{gate.status}</span>
              </article>
            )
          })}
        </div>
      </section>
      <UpdatedAt value={data.generatedAt} />
    </>
  )
}
