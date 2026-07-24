export class MessageIntegrityError extends Error {
  readonly code = 'MESSAGE_INTEGRITY_CONFLICT'
}

export class LeaseLostError extends Error {
  readonly code = 'PROCESSING_LEASE_LOST'
}
