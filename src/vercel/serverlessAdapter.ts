import type { IncomingMessage, ServerResponse } from 'node:http'

/**
 * The Node request listener a `http.Server` would have called. The Vercel
 * Function never calls `listen()`, so the listener is invoked directly.
 */
export type NodeRequestListener = (
  request: IncomingMessage,
  response: ServerResponse,
) => void

export interface ServerlessHandlerOptions {
  /**
   * Produces the application's request listener, typically by bootstrapping the
   * runtime once per warm instance. Rejecting means the runtime could not be
   * built at all — a configuration or dependency problem, never something the
   * caller sent.
   */
  loadListener: () => Promise<NodeRequestListener>
  /** Injected by tests. Receives no error object, by construction. */
  onStartupFailure?: () => void
}

/**
 * The bounded body returned when the runtime cannot be built.
 *
 * Fixed text, assembled from nothing. A startup failure is a configuration
 * error, and configuration errors carry hostnames, file paths, credentials and
 * SQL in their messages — none of which may reach a browser. There is
 * deliberately no field into which a message could be interpolated later.
 */
export const RUNTIME_UNAVAILABLE_BODY = JSON.stringify({
  type: 'https://kaudit.kairali.invalid/problems/runtime-unavailable',
  title: 'Service unavailable',
  status: 503,
  code: 'RUNTIME_UNAVAILABLE',
})

const UNAVAILABLE_HEADERS = {
  'content-type': 'application/problem+json; charset=utf-8',
  'cache-control': 'no-store',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
} as const

/**
 * Normalizes the request target the platform handed us into the path + query the
 * application router expects.
 *
 * The path and query are otherwise passed through byte for byte — no decoding,
 * re-encoding, or trailing-slash rewriting — because `/api/v1/*`, `/health/*`,
 * `/login`, `/logout` and every routed page are matched on the exact string.
 *
 * The one alteration is collapsing a leading `//`. A protocol-relative target
 * would make `new URL(target, base)` resolve against an attacker-chosen
 * authority; no application route begins with a double slash, so folding it is
 * free.
 */
export function normalizeRequestTarget(rawUrl: string | undefined): string {
  const raw = typeof rawUrl === 'string' ? rawUrl.trim() : ''
  if (!raw) return '/'
  const schemeEnd = raw.indexOf('://')
  if (schemeEnd > 0 && !raw.startsWith('/')) {
    // Absolute-form target (RFC 9112 §3.2.2), which proxies are allowed to send.
    const pathStart = raw.indexOf('/', schemeEnd + 3)
    return pathStart === -1 ? '/' : collapseLeadingSlashes(raw.slice(pathStart))
  }
  if (!raw.startsWith('/')) return `/${raw}`
  return collapseLeadingSlashes(raw)
}

function collapseLeadingSlashes(target: string): string {
  return target.startsWith('//') ? `/${target.replace(/^\/+/, '')}` : target
}

function respondUnavailable(response: ServerResponse): void {
  if (response.writableEnded) return
  // Read before `writeHead` flips it: a response whose headers were already sent
  // by the application is finished as-is rather than having a second, different
  // document appended to whatever it had started saying.
  const alreadyStarted = response.headersSent
  if (alreadyStarted) {
    response.end()
    return
  }
  response.writeHead(503, {
    ...UNAVAILABLE_HEADERS,
    'content-length': Buffer.byteLength(RUNTIME_UNAVAILABLE_BODY),
  })
  response.end(RUNTIME_UNAVAILABLE_BODY)
}

/**
 * Resolves once the response is finished or the connection is gone.
 *
 * The application handler is `async` and a `http.Server` would keep the process
 * alive until it settled. A function invocation has no such guarantee: returning
 * early freezes the instance mid-write, so the response is what we wait on, not
 * the handler's own promise (which the listener signature discards anyway).
 */
export function responseSettled(response: ServerResponse): Promise<void> {
  if (response.writableEnded) return Promise.resolve()
  return new Promise<void>((resolve) => {
    const settle = (): void => resolve()
    response.once('finish', settle)
    response.once('close', settle)
  })
}

/**
 * Adapts a Node request listener to a Vercel Node Function invocation.
 *
 * Pure with respect to the application: it receives a listener, never builds
 * one, and opens no database, socket, or model client of its own.
 */
export function createServerlessHandler(
  options: ServerlessHandlerOptions,
): (request: IncomingMessage, response: ServerResponse) => Promise<void> {
  return async function handler(request, response) {
    let listener: NodeRequestListener
    try {
      listener = await options.loadListener()
    } catch {
      // The error is not inspected, not logged, and not attached to the
      // response. Nothing about it is safe to surface.
      options.onStartupFailure?.()
      respondUnavailable(response)
      return
    }
    request.url = normalizeRequestTarget(request.url)
    const settled = responseSettled(response)
    try {
      listener(request, response)
    } catch {
      // The application handler has its own bounded error mapping; a throw that
      // escapes it is unknown, so it gets the same contentless 503.
      respondUnavailable(response)
    }
    await settled
  }
}
