import type { IncomingMessage, ServerResponse } from 'node:http'
import { createVercelDashboardHandler } from '../src/vercel/dashboardFunction.ts'

/**
 * Dedicated long-running edge for the monthly PDF summary only; its month
 * aggregates over 39k calls ran past the 30 s page limit.
 *
 * It still enters the shared authenticated application handler, so identity,
 * authorization, access logging and data selection cannot drift from the web
 * application. The fixed path prevents a rewrite from widening this function
 * into a second general API entry point.
 */
const handler = createVercelDashboardHandler()

export default async function monthlyReportPdfFunction(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const search = new URL(request.url ?? '/', 'http://kaudit.invalid').search
  request.url = `/api/v1/reports/monthly.pdf${search}`
  await handler(request, response)
}
