import fs from 'node:fs'
import mysql from 'mysql2/promise'
import { createMysqlAccessRepository } from '../adapters/mysqlAccessRepo.ts'
import { createMysqlAuditSink } from '../adapters/mysqlAuditSink.ts'
import { createOidcVerifier } from '../auth/oidcVerifier.ts'
import { loadRuntimeConfig } from '../config/runtime.ts'
import { createEnterpriseDashboardServer } from '../http/enterpriseDashboardServer.ts'

const config = loadRuntimeConfig(process.env)
const ssl = config.database.sslCaFile
  ? {
      ca: fs.readFileSync(config.database.sslCaFile, 'utf8'),
      rejectUnauthorized: true,
    }
  : undefined
const pool = mysql.createPool({
  host: config.database.host,
  port: config.database.port,
  database: config.database.name,
  user: config.database.user,
  password: config.database.password,
  ssl,
  connectionLimit: 8,
  connectTimeout: 10_000,
  enableKeepAlive: true,
  decimalNumbers: false,
})
const access = createMysqlAccessRepository(pool)
const audit = createMysqlAuditSink(pool)
const verifier =
  config.auth.mode === 'oidc'
    ? createOidcVerifier({
        issuer: config.auth.issuer,
        audience: config.auth.audience,
        jwksUri: config.auth.jwksUri,
        algorithms: config.auth.algorithms,
      })
    : null
const server = createEnterpriseDashboardServer({
  config,
  pool,
  access,
  audit,
  verifier,
})

server.listen(config.port, config.host, () => {
  process.stdout.write(
    `[secure-dashboard] listening on http://${config.host}:${config.port} (${config.auth.mode} auth)\n`,
  )
})

async function shutdown(signal: string): Promise<void> {
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
