import type { JsonValue } from './canonicalJson.ts'

export interface NewOutboxMessage {
  messageId: string
  aggregateType: string
  aggregateId: string
  eventType: string
  payload: JsonValue
  correlationId: string | null
}

export interface ClaimedOutboxMessage {
  id: string
  messageId: string
  aggregateType: string
  aggregateId: string
  eventType: string
  payloadJson: string
  payloadSha256: string
  correlationId: string | null
  attempts: number
}

export interface OutboxWriter {
  enqueue(message: NewOutboxMessage): Promise<'inserted' | 'duplicate'>
}

export interface OutboxRepository {
  claim(options: {
    owner: string
    limit: number
    now: Date
    leaseUntil: Date
  }): Promise<ClaimedOutboxMessage[]>
  markPublished(id: string, owner: string, at: Date): Promise<void>
  markFailed(options: {
    id: string
    owner: string
    nextStatus: 'retry' | 'dead_letter'
    availableAt: Date
    errorCode: string
  }): Promise<void>
}

export interface MessageTransport {
  publish(message: ClaimedOutboxMessage): Promise<void>
}

export type InboxBeginResult =
  | { outcome: 'acquired' }
  | { outcome: 'duplicate_completed' }
  | { outcome: 'in_progress' }
  | { outcome: 'integrity_conflict' }

export interface InboxRepository {
  begin(options: {
    consumer: string
    messageId: string
    payloadSha256: string
    owner: string
    now: Date
    leaseUntil: Date
  }): Promise<InboxBeginResult>
  complete(options: {
    consumer: string
    messageId: string
    owner: string
    result: JsonValue | null
    at: Date
  }): Promise<void>
  fail(options: {
    consumer: string
    messageId: string
    owner: string
    errorCode: string
  }): Promise<void>
}
