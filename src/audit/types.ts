export type AuditOutcome = 'success' | 'denied' | 'failure'

export interface AuditEvent {
  actorUserId: string | null
  actorEmail: string | null
  action: string
  resourceType: string
  resourceId: string | null
  outcome: AuditOutcome
  purpose: string
  correlationId: string
  ipAddress: string | null
  client: string | null
  beforeHash?: string | null
  afterHash?: string | null
  occurredAt: Date
}

export interface AuditSink {
  record(event: AuditEvent): Promise<void>
  readiness(): Promise<boolean>
}
