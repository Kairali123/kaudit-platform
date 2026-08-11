import { useQuery } from '@tanstack/react-query'
import { CheckCircle2 } from 'lucide-react'
import { ErrorState, LoadingState, Notice } from '../components/States'
import { MetricGrid, PageHeader, UpdatedAt } from '../components/Metrics'
import { getJson, type EvidenceData } from '../lib/api'
import { useBillingPeriod } from '../lib/billingPeriod'

export function EvidencePage() {
  const period = useBillingPeriod()
  const query = useQuery({
    queryKey: ['evidence', period.month],
    queryFn: () =>
      getJson<EvidenceData>(period.apiPath('/api/v1/evidence')),
  })
  if (query.isLoading) return <LoadingState />
  if (query.error)
    return <ErrorState error={query.error} retry={() => void query.refetch()} />
  const data = query.data!
  return (
    <>
      <PageHeader
        eyebrow="Evidence"
        title="Calls & evidence"
        description={`Coverage of calls, recording references, and hash checks for ${period.label}.`}
        badge={<span className="status-badge live">Read-only</span>}
      />
      <Notice tone="warning" title="Vendor-hosted evidence trade-off">
        Recording bytes remain on KServe. Stored SHA-256 baselines detect change only
        while a source URL remains reachable.
      </Notice>
      <MetricGrid tiles={data.tiles.slice(0, 4)} />
      <section className="content-section">
        <div className="section-title">
          <div>
            <span className="eyebrow">Integrity log</span>
            <h2>Evidence events</h2>
          </div>
        </div>
        {data.integrityFindings.length ? (
          <div className="data-table">
            <table>
              <thead>
                <tr>
                  <th>Event</th>
                  <th>Count</th>
                </tr>
              </thead>
              <tbody>
                {data.integrityFindings.map((finding) => (
                  <tr key={finding.action}>
                    <td><code>{finding.action}</code></td>
                    <td>{finding.n.toLocaleString('en-IN')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="empty-state">
            <CheckCircle2 size={22} aria-hidden />
            <strong>No integrity anomalies logged</strong>
            <p>No missing or altered-evidence event is present in the current aggregate.</p>
          </div>
        )}
      </section>
      <UpdatedAt value={data.generatedAt} />
    </>
  )
}
