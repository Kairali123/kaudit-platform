import type { IncomingMessage, ServerResponse } from 'node:http'
import { AUDIT_MONITOR_REFRESH_ROUTE } from '../src/http/auditMonitorSnapshot.ts'
import { createVercelDashboardHandler } from '../src/vercel/dashboardFunction.ts'

/**
 * Dedicated long-running function that recomputes Audit Monitor month
 * summaries and stores them, so the 30 s page function only reads snapshots.
 */
const handler = createVercelDashboardHandler()

export default async function auditMonitorRefreshFunction(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const search = new URL(request.url || '/', 'http://kaudit.invalid').search
  request.url = `${AUDIT_MONITOR_REFRESH_ROUTE}${search}`
  await handler(request, response)
}
