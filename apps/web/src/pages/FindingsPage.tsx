import { useQuery } from '@tanstack/react-query'
import { ErrorState, LoadingState, Notice } from '../components/States'
import { MetricGrid, PageHeader, UpdatedAt } from '../components/Metrics'
import { getJson, type QualityData } from '../lib/api'

function CountList({
  title,
  rows,
}: {
  title: string
  rows: Array<{ label: string; n: number }>
}) {
  return (
    <article className="list-card">
      <h3>{title}</h3>
      {rows.length ? (
        rows.map((row) => (
          <div key={row.label}>
            <code>{row.label}</code>
            <strong>{row.n.toLocaleString('en-IN')}</strong>
          </div>
        ))
      ) : (
        <p className="muted">No aggregate data available.</p>
      )}
    </article>
  )
}

export function FindingsPage() {
  const query = useQuery({
    queryKey: ['findings'],
    queryFn: () => getJson<QualityData>('/api/v1/findings'),
  })
  if (query.isLoading) return <LoadingState />
  if (query.error)
    return <ErrorState error={query.error} retry={() => void query.refetch()} />
  const data = query.data!
  return (
    <>
      <PageHeader
        eyebrow="Quality"
        title="Findings"
        description="Aggregate automated quality signals, confidence, and current decision state."
        badge={
          <span className={`status-badge ${data.authority}`}>
            {data.authority}
          </span>
        }
      />
      {data.authority === 'uncalibrated' && (
        <Notice tone="warning" title="Accuracy has not been measured">
          Confidence is model output, not ground-truth accuracy. These results are
          monitoring signals and are not authoritative for safety or billing.
        </Notice>
      )}
      <MetricGrid tiles={data.quality.tiles} />
      <section className="split-section content-section">
        <div className="data-table">
          <div className="table-heading">
            <div>
              <span className="eyebrow">Finding catalog</span>
              <h2>Top finding types</h2>
            </div>
            <span className="soft-chip">{data.quality.catalogLabel}</span>
          </div>
          <table>
            <thead>
              <tr>
                <th>Finding code</th>
                <th>Count</th>
                <th>Avg confidence</th>
              </tr>
            </thead>
            <tbody>
              {data.quality.topFindings.map((finding) => (
                <tr key={finding.code}>
                  <td><code>{finding.code}</code></td>
                  <td>{finding.n.toLocaleString('en-IN')}</td>
                  <td>{finding.confidenceLabel}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="stack">
          <CountList title="Decision state" rows={data.quality.confirmations} />
          <CountList title="Finding origin" rows={data.quality.origins} />
        </div>
      </section>
      <UpdatedAt value={data.generatedAt} />
    </>
  )
}
