import type { Pool } from 'mysql2/promise'

export interface StatusCount {
  status: string
  count: number
}

export interface OperationsView {
  generatedAt: string
  outbox: StatusCount[]
  inbox: StatusCount[]
  jobs: StatusCount[]
  idempotency: StatusCount[]
  auditEvents: number | null
  auditChainConfigured: boolean | null
}

async function grouped(pool: Pool, table: string): Promise<StatusCount[]> {
  try {
    const [rows] = await pool.query(
      `SELECT status, COUNT(*) AS n FROM \`${table}\` GROUP BY status ORDER BY status`,
    )
    return (rows as Array<{ status: string; n: number }>).map((row) => ({
      status: String(row.status),
      count: Number(row.n),
    }))
  } catch {
    return []
  }
}

async function scalar(pool: Pool, sql: string): Promise<number | null> {
  try {
    const [rows] = await pool.query(sql)
    const row = (rows as Array<Record<string, unknown>>)[0]
    const value = row ? Object.values(row)[0] : null
    return value == null ? null : Number(value)
  } catch {
    return null
  }
}

export async function collectOperations(pool: Pool): Promise<OperationsView> {
  const [outbox, inbox, jobs, idempotency, auditEvents, auditChainRows] =
    await Promise.all([
      grouped(pool, 'kaudit_outbox_message'),
      grouped(pool, 'kaudit_inbox_message'),
      grouped(pool, 'kaudit_job_attempt'),
      grouped(pool, 'kaudit_idempotency_record'),
      scalar(pool, 'SELECT COUNT(*) FROM kaudit_audit_log'),
      scalar(
        pool,
        "SELECT COUNT(*) FROM kaudit_audit_chain_head WHERE chain_name='primary'",
      ),
    ])
  return {
    generatedAt: new Date().toISOString(),
    outbox,
    inbox,
    jobs,
    idempotency,
    auditEvents,
    auditChainConfigured:
      auditChainRows == null ? null : auditChainRows > 0,
  }
}
