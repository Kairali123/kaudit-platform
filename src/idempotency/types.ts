export type IdempotencyBeginResult =
  | { outcome: 'acquired' }
  | {
      outcome: 'replay'
      responseReference: string
      httpStatus: number
      responseHash: string
    }
  | { outcome: 'conflict' }
  | { outcome: 'in_progress' }

export interface IdempotencyRepository {
  begin(options: {
    route: string
    key: string
    requestHash: string
    owner: string
    expiresAt: Date
    lockUntil: Date
    now: Date
  }): Promise<IdempotencyBeginResult>
  complete(options: {
    route: string
    key: string
    owner: string
    responseReference: string
    httpStatus: number
    responseHash: string
  }): Promise<void>
  fail(options: {
    route: string
    key: string
    owner: string
  }): Promise<void>
}
