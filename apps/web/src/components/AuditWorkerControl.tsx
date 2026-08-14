import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, Pause, Play, RefreshCw } from 'lucide-react'
import {
  getJson,
  postJson,
  type AuditSystem,
  type AuditWorkerControlData,
  type AuditWorkerState,
} from '../lib/api'
import { ErrorState, LoadingState } from './States'

const LABELS: Record<AuditSystem, string> = {
  billing: 'Billing Audit',
  call: 'Call Audit',
}

function stateLabel(state: AuditWorkerState): string {
  if (
    state.desiredState === 'paused' &&
    (state.observedState === 'running' || state.observedState === 'pausing')
  ) {
    return 'Stopping'
  }
  return state.observedState.charAt(0).toUpperCase() +
    state.observedState.slice(1)
}

export function AuditWorkerControl({ system }: { system: AuditSystem }) {
  const client = useQueryClient()
  const query = useQuery({
    queryKey: ['audit-workers'],
    queryFn: () =>
      getJson<AuditWorkerControlData>('/api/v1/audit-workers'),
    // Opt-in live monitor: a worker's observed state changes outside this app
    // (a worker starts, stops, or picks up the desired state), so the control
    // polls on a bounded interval. Polling is not a client default.
    refetchInterval: 5_000,
  })
  const mutation = useMutation({
    mutationFn: (desiredState: 'running' | 'paused') =>
      postJson<AuditWorkerState>('/api/v1/audit-workers/control', {
        system,
        desiredState,
      }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['audit-workers'] })
      void client.invalidateQueries({ queryKey: ['audit-monitor'] })
      void client.invalidateQueries({ queryKey: ['call-audit-report'] })
    },
  })

  if (query.isLoading) return <LoadingState />
  if (query.error) {
    return <ErrorState error={query.error} retry={() => void query.refetch()} />
  }
  const state = query.data?.systems.find((item) => item.system === system)
  if (!state) return null
  const dispatchAvailable = query.data?.dispatchAvailable ?? false
  const stopping =
    state.desiredState === 'paused' &&
    (state.observedState === 'running' || state.observedState === 'pausing')
  const active =
    state.observedState === 'running' || state.observedState === 'pausing'
  const stopAction = state.desiredState === 'running' && active
  const startLabel = state.desiredState === 'paused' ? 'Resume audit' : 'Run audit'

  return (
    <section className="audit-worker-control" aria-label={`${LABELS[system]} control`}>
      <div className="audit-worker-state">
        <span className={`worker-indicator ${state.observedState}`} aria-hidden />
        <div>
          <span className="eyebrow">Automatic worker</span>
          <strong>{LABELS[system]}</strong>
        </div>
        <span className={`status-badge ${state.observedState}`}>
          {state.observedState === 'faulted' && <AlertTriangle size={13} aria-hidden />}
          {stopping && <RefreshCw size={13} aria-hidden />}
          {stateLabel(state)}
        </span>
      </div>
      <dl className="audit-worker-facts">
        <div>
          <dt>Processed</dt>
          <dd>{state.processedTotal.toLocaleString('en-IN')}</dd>
        </div>
        <div>
          <dt>Failures</dt>
          <dd>{state.failedTotal.toLocaleString('en-IN')}</dd>
        </div>
        <div>
          <dt>Last error</dt>
          <dd>{state.lastErrorCode ?? 'None'}</dd>
        </div>
      </dl>
      <button
        type="button"
        className={stopAction ? 'button-danger' : 'button-primary'}
        disabled={
          mutation.isPending ||
          stopping ||
          (!dispatchAvailable && !stopAction)
        }
        title={
          stopAction
            ? 'Stop after the current item'
            : dispatchAvailable
              ? startLabel
              : 'Audit worker start unavailable'
        }
        onClick={() => mutation.mutate(stopAction ? 'paused' : 'running')}
      >
        {stopAction ? <Pause size={16} aria-hidden /> : <Play size={16} aria-hidden />}
        {stopAction ? 'Stop audit' : startLabel}
      </button>
    </section>
  )
}
