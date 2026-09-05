import type { IncomingMessage, ServerResponse } from 'node:http'
import { createVercelDashboardHandler } from '../src/vercel/dashboardFunction.ts'

/**
 * Dedicated long-running edge for the large per-call CSV only.
 *
 * It still enters the shared authenticated application handler, so identity,
 * authorization, access logging and data selection cannot drift from the web
 * application. The fixed path prevents a rewrite from widening this function
 * into a second general API entry point.
 */
const handler = createVercelDashboardHandler()

export default async function monthlyReportCsvFunction(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const search = new URL(request.url ?? '/', 'http://kaudit.invalid').search
  request.url = `/api/v1/reports/monthly.csv${search}`
  await handler(request, response)
}
