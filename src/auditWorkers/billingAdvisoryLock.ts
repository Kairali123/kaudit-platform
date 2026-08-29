export const BILLING_AUDIT_LOCK_ERROR_CODE = 'BILLING_AUDIT_LOCK_BUSY'

interface BillingAuditLockOptions {
  tryAcquire: () => Promise<boolean>
  timeoutMs: number
  retryMs: number
  wait: (ms: number) => Promise<void>
  now?: () => number
}

/**
 * Waits briefly for a prior worker connection to release the global Billing
 * lock. It never identifies, releases, or kills the owning connection.
 */
export async function acquireBillingAuditLock(
  options: BillingAuditLockOptions,
): Promise<boolean> {
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 0) {
    throw new RangeError('lock timeout must be a non-negative integer')
  }
  if (!Number.isSafeInteger(options.retryMs) || options.retryMs < 1) {
    throw new RangeError('lock retry must be a positive integer')
  }
  const now = options.now ?? Date.now
  const startedAt = now()
  for (;;) {
    if (await options.tryAcquire()) return true
    const remainingMs = options.timeoutMs - (now() - startedAt)
    if (remainingMs <= 0) return false
    await options.wait(Math.min(options.retryMs, remainingMs))
  }
}
