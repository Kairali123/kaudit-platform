import type { IncomingMessage, ServerResponse } from 'node:http'
import { createVercelDashboardHandler } from '../src/vercel/dashboardFunction.ts'

/**
 * The Reports page's month read, in its own longer function. A finished
 * month is served from the month-summary cache; refilling it after a change
 * walks every call in the month (39k for June), which ran past the 30 s
 * page limit. Here it has room to finish and store the result.
 */
const handler = createVercelDashboardHandler()

export default async function reportsPageFunction(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const search = new URL(request.url ?? '/', 'http://kaudit.invalid').search
  request.url = `/api/v1/reports${search}`
  await handler(request, response)
}
