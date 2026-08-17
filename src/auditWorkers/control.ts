export const AUDIT_SYSTEMS = ['billing', 'call'] as const
export type AuditSystem = (typeof AUDIT_SYSTEMS)[number]

export const AUDIT_WORKER_DESIRED_STATES = ['running', 'paused'] as const
export type AuditWorkerDesiredState =
  (typeof AUDIT_WORKER_DESIRED_STATES)[number]

export const AUDIT_WORKER_OBSERVED_STATES = [
  'idle',
  'running',
  'pausing',
  'paused',
  'faulted',
] as const
export type AuditWorkerObservedState =
  (typeof AUDIT_WORKER_OBSERVED_STATES)[number]

export interface AuditWorkerPublicState {
  system: AuditSystem
  desiredState: AuditWorkerDesiredState
  observedState: AuditWorkerObservedState
  stateVersion: number
  lastHeartbeatAt: string | null
  lastProgressAt: string | null
  lastErrorCode: string | null
  processedTotal: number
  failedTotal: number
}

export const AUDIT_WORKER_HEARTBEAT_STALE_MS = 5 * 60 * 1000

export function settleStaleWorker(
  state: AuditWorkerPublicState,
  nowMs = Date.now(),
): AuditWorkerPublicState {
  const heartbeatMs = state.lastHeartbeatAt
    ? Date.parse(state.lastHeartbeatAt)
    : Number.NaN
  const heartbeatIsFresh =
    Number.isFinite(heartbeatMs) &&
    nowMs - heartbeatMs <= AUDIT_WORKER_HEARTBEAT_STALE_MS

  if (state.desiredState === 'paused') {
    if (
      state.observedState === 'paused' ||
      state.observedState === 'faulted' ||
      heartbeatIsFresh
    ) {
      return state
    }
    return { ...state, observedState: 'paused' }
  }

  if (
    (state.observedState === 'running' || state.observedState === 'pausing') &&
    !heartbeatIsFresh
  ) {
    return {
      ...state,
      observedState: 'faulted',
      lastErrorCode: 'AUDIT_WORKER_HEARTBEAT_STALE',
    }
  }
  return state
}

export interface CallAuditCheckpoint {
  changedAt: string
  sourceRowId: string
}

export interface AuditWorkerControlPort {
  listPublicStates(): Promise<AuditWorkerPublicState[]>
  setDesiredState(input: {
    system: AuditSystem
    desiredState: AuditWorkerDesiredState
  }): Promise<AuditWorkerPublicState>
  getDesiredState(system: AuditSystem): Promise<AuditWorkerDesiredState>
  recordObservation(input: {
    system: AuditSystem
    observedState: AuditWorkerObservedState
    errorCode?: string | null
    processedDelta?: number
    failedDelta?: number
    progressed?: boolean
  }): Promise<void>
  getCallCheckpoint(): Promise<CallAuditCheckpoint | null>
  initializeCallCheckpoint(checkpoint: CallAuditCheckpoint): Promise<void>
  advanceCallCheckpoint(checkpoint: CallAuditCheckpoint): Promise<void>
  nextWorkSequence(system: AuditSystem): Promise<number>
}

export class AuditWorkerControlError extends Error {
  readonly code = 'INVALID_AUDIT_WORKER_CONTROL'
}

export function parseAuditSystem(value: unknown): AuditSystem {
  if (!(AUDIT_SYSTEMS as readonly unknown[]).includes(value)) {
    throw new AuditWorkerControlError('audit system is invalid')
  }
  return value as AuditSystem
}

/**
 * How a worker run was asked for.
 *
 * `ordinary` is the existing behaviour and stays the default everywhere, so no
 * current caller changes shape. `requested` is the administrator-selected
 * Billing Audit re-audit: an exact, bounded, one-shot drain of the durable
 * request queue, allowed while the general billing queue is paused.
 */
export const AUDIT_DISPATCH_MODES = ['ordinary', 'requested'] as const
export type AuditDispatchMode = (typeof AUDIT_DISPATCH_MODES)[number]

/**
 * Validates a dispatch, system and mode together.
 *
 * Call Audit has no durable request queue and no manual selection surface, so
 * `requested` is refused for it here rather than being handed to a workflow
 * that would only exit non-zero. The refusal is a closed-set failure, and it
 * names neither a provider, a repository, nor a token.
 */
export function parseAuditDispatch(
  system: unknown,
  mode: unknown = 'ordinary',
): { system: AuditSystem; mode: AuditDispatchMode } {
  const parsedSystem = parseAuditSystem(system)
  if (!(AUDIT_DISPATCH_MODES as readonly unknown[]).includes(mode)) {
    throw new AuditWorkerControlError('audit dispatch mode is invalid')
  }
  const parsedMode = mode as AuditDispatchMode
  if (parsedMode === 'requested' && parsedSystem !== 'billing') {
    throw new AuditWorkerControlError(
      'requested dispatch mode is Billing Audit only',
    )
  }
  return { system: parsedSystem, mode: parsedMode }
}

export function parseDesiredState(value: unknown): AuditWorkerDesiredState {
  if (!(AUDIT_WORKER_DESIRED_STATES as readonly unknown[]).includes(value)) {
    throw new AuditWorkerControlError('desired state is invalid')
  }
  return value as AuditWorkerDesiredState
}
