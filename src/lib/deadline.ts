/**
 * A bound on how long an OPTIONAL read may hold a request open.
 *
 * Some reads on a page are the page: if they fail, there is nothing honest to
 * render and the request should fail. Others are one card, already designed to
 * degrade to an explicit "unavailable" state that says nothing false about the
 * data. The second kind must never be able to take down the first.
 *
 * The billing page learned this the hard way. Its settlement read sat behind a
 * table that did not exist, so it failed instantly and the page rendered around
 * it. Creating the table removed the fast failure and revealed that the read
 * underneath was slow and completely unbounded -- no statement timeout applied
 * to it -- so the whole page then hung until the platform killed the request,
 * and every card on it disappeared to report one card's problem.
 *
 * This does NOT cancel the underlying work; the database keeps running the
 * statement until it finishes or the connection closes. It bounds only how long
 * a caller waits before degrading, which is the difference between one card
 * saying "unavailable" and a page saying nothing at all.
 */

export class DeadlineExceededError extends Error {
  readonly code = 'READ_DEADLINE_EXCEEDED'
  readonly milliseconds: number

  constructor(milliseconds: number) {
    super('read exceeded its deadline')
    this.name = 'DeadlineExceededError'
    this.milliseconds = milliseconds
  }
}

export function isDeadlineExceeded(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === 'READ_DEADLINE_EXCEEDED'
  )
}

export async function withDeadline<T>(
  work: Promise<T>,
  milliseconds: number,
): Promise<T> {
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) {
    throw new TypeError('milliseconds must be a positive number')
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  const expiry = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new DeadlineExceededError(milliseconds)),
      milliseconds,
    )
    // The timer must not by itself keep a process alive; a CLI that has
    // finished its work should exit rather than wait out a deadline it no
    // longer needs.
    timer.unref?.()
  })
  try {
    return await Promise.race([work, expiry])
  } finally {
    if (timer) clearTimeout(timer)
    /**
     * The losing promise still settles later. Without this, a read that fails
     * AFTER its deadline has passed becomes an unhandled rejection and, in a
     * strict runtime, takes down the process -- turning a degraded card into an
     * outage, which is the exact failure this exists to prevent.
     */
    void work.catch(() => {})
  }
}
