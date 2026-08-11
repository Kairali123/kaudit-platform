import type { Pool, RowDataPacket } from 'mysql2/promise'
import { parseBillingMonth } from '../reporting/billingMonth.ts'

interface MonthRow extends RowDataPacket {
  month: string
  call_count: number | string
  invoice_count: number | string
}

export async function collectBillingMonths(pool: Pool) {
  const [rows] = await pool.query<MonthRow[]>(
    `SELECT month_rows.month,
            SUM(month_rows.call_count) AS call_count,
            SUM(month_rows.invoice_count) AS invoice_count
     FROM (
       SELECT DATE_FORMAT(billing_period_date, '%Y-%m') AS month,
              COUNT(*) AS call_count, 0 AS invoice_count
       FROM kaudit_call
       WHERE billing_period_date IS NOT NULL
       GROUP BY DATE_FORMAT(billing_period_date, '%Y-%m')
       UNION ALL
       SELECT DATE_FORMAT(period_start, '%Y-%m') AS month,
              0 AS call_count, COUNT(*) AS invoice_count
       FROM kaudit_invoice
       GROUP BY DATE_FORMAT(period_start, '%Y-%m')
     ) month_rows
     GROUP BY month_rows.month
     ORDER BY month_rows.month DESC`,
  )
  const months = rows.map((row) => {
    const scope = parseBillingMonth(String(row.month))
    if (!scope) throw new Error('Database returned an empty billing month')
    return {
      ...scope,
      callCount: Number(row.call_count || 0),
      invoiceCount: Number(row.invoice_count || 0),
    }
  })
  return {
    generatedAt: new Date().toISOString(),
    defaultMonth: months[0]?.month ?? null,
    months,
  }
}
