import { createDashboardRuntime } from '../runtime/dashboardRuntime.ts'

/**
 * The persistent secure dashboard: a long-lived process that owns its port.
 *
 * Dependency construction lives in the shared runtime factory so this entry
 * point and the Vercel Function cannot drift apart on security posture. What is
 * left here is what only a persistent process has: a listening socket and an
 * orderly shutdown.
 */
const { config, pool, server } = createDashboardRuntime({
  poolProfile: 'persistent',
  cycleImports: 'local-disk',
})
let shuttingDown = false

server.on('error', async (error: NodeJS.ErrnoException) => {
  if (error.code === 'EADDRINUSE') {
    process.stderr.write(
      `[secure-dashboard] port ${config.port} is already in use. Stop the existing process or choose another KAUDIT_SECURE_PORT.\n`,
    )
  } else {
    process.stderr.write(
      `[secure-dashboard] could not start (${error.code ?? 'unknown error'})\n`,
    )
  }
  await pool.end()
  process.exit(1)
})

server.listen(config.port, config.host, () => {
  process.stdout.write(
    `[secure-dashboard] listening on http://${config.host}:${config.port} (${config.auth.mode} auth)\n`,
  )
})

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return
  shuttingDown = true
  process.stdout.write(
    `[secure-dashboard] ${signal}; shutting down\n`,
  )
  server.close(async () => {
    await pool.end()
    process.exit(0)
  })
  setTimeout(() => process.exit(1), 10_000).unref()
}

process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('SIGINT', () => void shutdown('SIGINT'))
