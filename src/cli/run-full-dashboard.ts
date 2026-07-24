import http from 'node:http'
import mysql from 'mysql2/promise'
import { collectFullDashboard } from '../adapters/mysqlFullDashboard.ts'
import { buildFullDashboard } from '../ui/fullDashboard.ts'
import { renderFullDashboard } from '../ui/fullRender.ts'

// Local-only aggregate dashboard. SELECTs only. No auth is implemented yet, so the
// UI carries a persistent do-not-deploy warning and binds to loopback by default.
function required(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`${name} is required`)
  return value
}

const host = '127.0.0.1'
const port = Number(process.env.KAUDIT_DASHBOARD_PORT || 4174)
const pool = mysql.createPool({
  host: required('DB_HOST'),
  port: Number(process.env.DB_PORT || 3306),
  database: required('DB_NAME'),
  user: required('DB_USER'),
  password: required('DB_PASSWORD'),
  connectionLimit: 4,
  connectTimeout: 30_000,
})

const securityHeaders = {
  'cache-control': 'no-store',
  'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
}

const server = http.createServer(async (request, response) => {
  if (request.url === '/health') {
    response.writeHead(200, { ...securityHeaders, 'content-type': 'text/plain; charset=utf-8' })
    response.end('ok')
    return
  }
  if (request.url !== '/' && !request.url?.startsWith('/?')) {
    response.writeHead(404, { ...securityHeaders, 'content-type': 'text/plain; charset=utf-8' })
    response.end('not found')
    return
  }
  try {
    const html = renderFullDashboard(buildFullDashboard(await collectFullDashboard(pool)))
    response.writeHead(200, {
      ...securityHeaders,
      'content-type': 'text/html; charset=utf-8',
    })
    response.end(html)
  } catch (error) {
    response.writeHead(500, { ...securityHeaders, 'content-type': 'text/plain; charset=utf-8' })
    response.end(`dashboard error: ${String((error as Error)?.message || error)}`)
  }
})

server.listen(port, host, () => {
  console.log(`[dashboard] local aggregate dashboard → http://${host}:${port}`)
  console.log('[dashboard] access control is NOT enforced — local project-team use only')
})
