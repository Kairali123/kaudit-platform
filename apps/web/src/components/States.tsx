import { AlertTriangle, RefreshCw } from 'lucide-react'
import type { ReactNode } from 'react'
import { ApiError } from '../lib/api'

export function LoadingState() {
  return (
    <div className="skeleton-grid" aria-label="Loading">
      {Array.from({ length: 4 }, (_, index) => (
        <div className="skeleton-card" key={index}>
          <span />
          <strong />
          <span />
        </div>
      ))}
    </div>
  )
}

export function ErrorState({
  error,
  retry,
}: {
  error: Error
  retry: () => void
}) {
  const correlation =
    error instanceof ApiError ? error.correlationId : null
  return (
    <div className="error-state" role="alert">
      <AlertTriangle size={22} aria-hidden />
      <div>
        <strong>Data could not be loaded</strong>
        <p>{error.message}</p>
        {correlation && <small>Reference: {correlation}</small>}
      </div>
      <button className="button secondary" onClick={retry} type="button">
        <RefreshCw size={15} aria-hidden />
        Retry
      </button>
    </div>
  )
}

export function Notice({
  tone,
  title,
  children,
}: {
  tone: 'warning' | 'info' | 'success'
  title: string
  children: ReactNode
}) {
  return (
    <div className={`notice ${tone}`}>
      <AlertTriangle size={18} aria-hidden />
      <div>
        <strong>{title}</strong>
        <p>{children}</p>
      </div>
    </div>
  )
}
