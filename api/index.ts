import type { IncomingMessage, ServerResponse } from 'node:http'
import { createVercelDashboardHandler } from '../src/vercel/dashboardFunction.ts'

/**
 * Vercel Node Function entry point for the authenticated web/API application.
 *
 * Every request reaches this file — `vercel.json` sends the whole path space
 * here except Vite's hashed `/assets/`, so page routes keep going through the
 * server's permission checks and access audit rather than being served as static
 * files. `req.url` still carries the original path and query, which is what the
 * existing router matches on.
 *
 * This file starts nothing. No `listen()`, no interval, no worker, no batch: a
 * web deployment answers requests and that is all. The billing worker, Call
 * Audit batch, report-email worker, and migrations stay operator-run processes —
 * see `docs/runbooks/VERCEL_DEPLOYMENT.md`.
 */
const handler = createVercelDashboardHandler()

export default async function vercelDashboardFunction(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  // Awaited so the invocation is not torn down while the application's async
  // handler is still writing the response.
  await handler(request, response)
}
