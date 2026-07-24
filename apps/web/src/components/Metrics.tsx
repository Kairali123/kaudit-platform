import type { ReactNode } from 'react'
import type { Tile } from '../lib/api'

export function MetricGrid({ tiles }: { tiles: Tile[] }) {
  return (
    <div className="metric-grid">
      {tiles.map((tile) => (
        <article className={`metric-card ${tile.status}`} key={tile.label}>
          <div className="metric-label">
            <span>{tile.label}</span>
            <i aria-label={tile.status} />
          </div>
          <strong>{tile.value}</strong>
          <p>{tile.sub || '\u00a0'}</p>
        </article>
      ))}
    </div>
  )
}

export function PageHeader({
  eyebrow,
  title,
  description,
  badge,
}: {
  eyebrow: string
  title: string
  description: string
  badge?: ReactNode
}) {
  return (
    <header className="page-header">
      <div>
        <span className="eyebrow">{eyebrow}</span>
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      {badge}
    </header>
  )
}

export function UpdatedAt({ value }: { value: string }) {
  const date = new Date(value)
  return (
    <p className="updated-at">
      Data refreshed{' '}
      {Number.isNaN(date.getTime())
        ? value
        : date.toLocaleString('en-IN', {
            dateStyle: 'medium',
            timeStyle: 'short',
          })}
    </p>
  )
}
