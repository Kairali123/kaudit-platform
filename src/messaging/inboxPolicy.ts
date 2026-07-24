import type { InboxBeginResult } from './types.ts'

export interface ExistingInboxState {
  payloadSha256: string | null
  status: string
  leaseOwner: string | null
  leaseExpiresAt: Date | null
}

export function classifyInboxAttempt(options: {
  existing: ExistingInboxState | null
  incomingPayloadSha256: string
  owner: string
  now: Date
}): InboxBeginResult {
  const existing = options.existing
  if (
    !existing ||
    existing.payloadSha256 !== options.incomingPayloadSha256
  ) {
    return { outcome: 'integrity_conflict' }
  }
  if (existing.status === 'completed') {
    return { outcome: 'duplicate_completed' }
  }
  if (
    existing.status === 'processing' &&
    existing.leaseOwner !== options.owner &&
    existing.leaseExpiresAt != null &&
    existing.leaseExpiresAt.getTime() > options.now.getTime()
  ) {
    return { outcome: 'in_progress' }
  }
  return { outcome: 'acquired' }
}
