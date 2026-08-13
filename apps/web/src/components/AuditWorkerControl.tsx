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
  if (state.desiredState === 'paused' && state.observedState === 'running') {
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
  const stopping =
    state.desiredState === 'paused' && state.observedState !== 'paused'
  const running = state.desiredState === 'running'

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
        className={running ? 'button-danger' : 'button-primary'}
        disabled={mutation.isPending || stopping}
        title={running ? 'Stop after the current call' : 'Resume automatic auditing'}
        onClick={() => mutation.mutate(running ? 'paused' : 'running')}
      >
        {running ? <Pause size={16} aria-hidden /> : <Play size={16} aria-hidden />}
        {running ? 'Stop audit' : 'Resume audit'}
      </button>
    </section>
  )
}
