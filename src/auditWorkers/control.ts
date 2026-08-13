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

export function parseDesiredState(value: unknown): AuditWorkerDesiredState {
  if (!(AUDIT_WORKER_DESIRED_STATES as readonly unknown[]).includes(value)) {
    throw new AuditWorkerControlError('desired state is invalid')
  }
  return value as AuditWorkerDesiredState
}
