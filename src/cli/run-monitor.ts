import http from 'node:http'
import mysql from 'mysql2/promise'
import { collectMetrics } from '../adapters/mysqlMetrics.ts'
import { buildDashboard } from '../ui/metrics.ts'
import { renderDashboard } from '../ui/render.ts'

// Read-only monitoring server. Serves aggregate evidence-integrity + ingestion status.
// Only runs SELECT COUNTs — never writes, never returns row data / PII / health content.
// Run locally against .env; refresh the page to update.
function req(name: string): string {
  const v = process.env[name]?.trim()
  if (!v) throw new Error(`${name} is required`)
  return v
}

const port = Number(process.env.KAUDIT_MONITOR_PORT || 4173)
const pool = mysql.createPool({
  host: req('DB_HOST'),
  port: Number(process.env.DB_PORT || 3306),
  database: req('DB_NAME'),
  user: req('DB_USER'),
  password: req('DB_PASSWORD'),
  connectionLimit: 3,
  connectTimeout: 30_000,
})

const server = http.createServer(async (request, res) => {
  if (request.url === '/health') {
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end('ok')
    return
  }
  try {
    const html = renderDashboard(buildDashboard(await collectMetrics(pool)))
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    res.end(html)
  } catch (err) {
    res.writeHead(500, { 'content-type': 'text/plain' })
    res.end('monitor error: ' + String((err as Error)?.message || err))
  }
})

server.listen(port, () => {
  console.log(`[monitor] read-only dashboard → http://localhost:${port}`)
})
