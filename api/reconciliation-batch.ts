import type { IncomingMessage, ServerResponse } from 'node:http'
import { createVercelDashboardHandler } from '../src/vercel/dashboardFunction.ts'

/** Dedicated bounded function for 1–3 reconciliation items. */
const handler = createVercelDashboardHandler()

export default async function reconciliationBatchFunction(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  request.url = '/api/v1/reconciliation/batch'
  await handler(request, response)
}
