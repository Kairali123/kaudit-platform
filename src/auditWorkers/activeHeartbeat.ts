export interface ActiveHeartbeat {
  stop(): Promise<void>
}

interface HeartbeatTimer {
  unref?: () => void
}

export function startActiveHeartbeat(options: {
  intervalMs: number
  record: () => Promise<void>
  schedule?: (callback: () => void, intervalMs: number) => unknown
  cancel?: (timer: unknown) => void
}): ActiveHeartbeat {
  if (!Number.isSafeInteger(options.intervalMs) || options.intervalMs < 1) {
    throw new RangeError('heartbeat interval must be a positive integer')
  }
  const schedule = options.schedule ??
    ((callback: () => void, intervalMs: number) =>
      setInterval(callback, intervalMs))
  const cancel = options.cancel ??
    ((timer: unknown) =>
      clearInterval(timer as ReturnType<typeof setInterval>))
  let stopped = false
  let pending = Promise.resolve()
  const timer = schedule(() => {
    if (stopped) return
    // Serialize ticks so one slow control write cannot create an unbounded
    // stack of concurrent heartbeat writes.
    pending = pending
      .then(() => options.record())
      .catch(() => undefined)
  }, options.intervalMs)
  ;(timer as HeartbeatTimer | null)?.unref?.()

  return {
    async stop() {
      if (stopped) return
      stopped = true
      cancel(timer)
      await pending
    },
  }
}
