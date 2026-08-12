import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import mysql from 'mysql2/promise'
import { loadRuntimeConfig } from '../config/runtime.ts'
import { collectBillingMonths } from '../adapters/mysqlBillingMonths.ts'
import { collectBilling } from '../adapters/mysqlFullDashboard.ts'
import { buildBillingView } from '../ui/fullDashboard.ts'
import {
  collectMonthlyEmailReport,
} from '../adapters/mysqlMonthlyEmailReport.ts'
import {
  claimMonthlyReportEmails,
  enqueueMonthlyReportEmail,
  markMonthlyReportEmailFailed,
  markMonthlyReportEmailPublished,
  requeueMonthlyReportEmailDeadLetter,
} from '../adapters/mysqlReportEmail.ts'
import {
  createSmtpReportEmailTransport,
} from '../adapters/smtpReportEmail.ts'
import {
  createGmailOAuthReportEmailTransport,
} from '../adapters/gmailOAuthReportEmail.ts'
import { runReportEmailBatch } from '../reporting/reportEmailWorker.ts'
import type { ReportEmailTransport } from '../reporting/reportEmail.ts'
import {
  parseBillingMonth,
  type BillingMonthScope,
} from '../reporting/billingMonth.ts'

function required(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`${name} is required`)
  return value
}

function enabled(name: string): boolean {
  return process.env[name]?.trim().toLowerCase() === 'true'
}

function integer(
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const value = Number(process.env[name] || fallback)
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be ${minimum}..${maximum}`)
  }
  return value
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) =>
    setTimeout(resolve, milliseconds),
  )
}

function createEmailTransport(): {
  mode: 'smtp' | 'gmail-oauth'
  transport: ReportEmailTransport
  verify?: () => Promise<void>
} {
  const mode =
    process.env.KAUDIT_EMAIL_TRANSPORT?.trim() || 'smtp'
  if (mode === 'gmail-oauth') {
    const transport = createGmailOAuthReportEmailTransport({
      clientId: required('KAUDIT_GOOGLE_CLIENT_ID'),
      clientSecret: required('KAUDIT_GOOGLE_CLIENT_SECRET'),
      refreshToken: required('KAUDIT_GOOGLE_REFRESH_TOKEN'),
      from: required('KAUDIT_REPORT_FROM'),
    })
    return {
      mode,
      transport,
      verify: () => transport.verify(),
    }
  }
  if (mode !== 'smtp') {
    throw new Error(
      'KAUDIT_EMAIL_TRANSPORT must be smtp or gmail-oauth',
    )
  }
  return {
    mode,
    transport: createSmtpReportEmailTransport({
      host: required('KAUDIT_SMTP_HOST'),
      port: integer('KAUDIT_SMTP_PORT', 587, 1, 65_535),
      secure: enabled('KAUDIT_SMTP_SECURE'),
      user: process.env.KAUDIT_SMTP_USER?.trim() || null,
      password:
        process.env.KAUDIT_SMTP_PASSWORD?.trim() || null,
      from: required('KAUDIT_REPORT_FROM'),
    }),
  }
}

async function idleUntilStopped(): Promise<void> {
  process.stdout.write(
    '[report-email] disabled; set KAUDIT_REPORT_EMAIL_ENABLED=true after SMTP and reporting approval are configured\n',
  )
  await new Promise<void>((resolve) => {
    process.once('SIGINT', resolve)
    process.once('SIGTERM', resolve)
  })
}

async function main(): Promise<void> {
  if (!enabled('KAUDIT_REPORT_EMAIL_ENABLED')) {
    await idleUntilStopped()
    return
  }
  const config = loadRuntimeConfig(process.env)
  if (!config.releaseGates.reportingApproved) {
    throw new Error(
      'KAUDIT_REPORTING_APPROVED=true is required before email delivery',
    )
  }
  if (
    !config.releaseGates.calibrationComplete &&
    !config.releaseGates.automatedValidationApproved
  ) {
    throw new Error(
      'Automated validation or calibration approval is required before email delivery',
    )
  }
  const recipients = required('KAUDIT_REPORT_RECIPIENTS')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
  const selectedMonth =
    process.env.KAUDIT_REPORT_EMAIL_MONTH?.trim() || null
  const watch = enabled('KAUDIT_REPORT_EMAIL_WATCH')
  const pollMs = integer(
    'KAUDIT_REPORT_EMAIL_POLL_MS',
    60_000,
    10_000,
    3_600_000,
  )
  // Both flags, always: mysql2 skips the hostname check unless `verifyIdentity`
  // is set, so a CA-only pool would accept any host holding any certificate the
  // configured authority ever issued.
  const ssl = config.database.sslCaFile
    ? {
        ca: fs.readFileSync(config.database.sslCaFile, 'utf8'),
        rejectUnauthorized: true,
        verifyIdentity: true,
      }
    : undefined
  const pool = mysql.createPool({
    host: config.database.host,
    port: config.database.port,
    database: config.database.name,
    user: config.database.user,
    password: config.database.password,
    ssl,
    connectionLimit: 4,
  })
  const owner = `report-email-${randomUUID()}`
  const email = createEmailTransport()
  try {
    if (email.verify) {
      await email.verify()
      process.stdout.write(
        `[report-email] ${email.mode} authorization verified\n`,
      )
    }
    if (enabled('KAUDIT_REPORT_EMAIL_REPLAY_DEAD_LETTER')) {
      if (!selectedMonth) {
        throw new Error(
          'KAUDIT_REPORT_EMAIL_MONTH is required for dead-letter replay',
        )
      }
      const replayed =
        await requeueMonthlyReportEmailDeadLetter(
          pool,
          selectedMonth,
        )
      process.stdout.write(
        `[report-email] dead-letter replay=${replayed ? 'requeued' : 'not-found'} month=${selectedMonth}\n`,
      )
    }
    for (;;) {
      const monthData = await collectBillingMonths(pool)
      const periods: BillingMonthScope[] = selectedMonth
        ? [parseBillingMonth(selectedMonth) as BillingMonthScope]
        : monthData.months
      let queued = 0
      let skipped = 0
      for (const period of periods) {
        const billing = await collectBilling(pool, period)
        const view = buildBillingView(billing, {
          calibrationComplete: true,
        })
        if (!view.cycle.billGenerated) {
          skipped += 1
          continue
        }
        const generatedAt = new Date().toISOString()
        const report = await collectMonthlyEmailReport(pool, {
          period,
          generatedAt,
        })
        if (report.summary.invoiceClaimedAmount == null) {
          skipped += 1
          continue
        }
        const result = await enqueueMonthlyReportEmail(pool, {
          report,
          recipients,
        })
        if (result.outcome === 'inserted') queued += 1
      }
      const delivery = await runReportEmailBatch({
        repository: {
          claim: (options) =>
            claimMonthlyReportEmails(pool, options),
          markPublished: (options) =>
            markMonthlyReportEmailPublished(pool, options),
          markFailed: (options) =>
            markMonthlyReportEmailFailed(pool, options),
        },
        transport: email.transport,
        owner,
        now: new Date(),
        limit: 10,
        loadReport: async (month, generatedAt) => {
          const period = parseBillingMonth(month)
          if (!period) throw new Error('Report month is required')
          return collectMonthlyEmailReport(pool, {
            period,
            generatedAt,
          })
        },
      })
      process.stdout.write(
        `[report-email] queued=${queued}; skipped-not-ready=${skipped}; claimed=${delivery.claimed}; sent=${delivery.sent}; retry=${delivery.retried}; dead-letter=${delivery.deadLettered}\n`,
      )
      if (!watch) break
      await wait(pollMs)
    }
  } finally {
    await pool.end()
  }
}

main().catch((error) => {
  process.stderr.write(
    `[report-email] stopped: ${String(
      (error as Error)?.message || error,
    ).slice(0, 500)}\n`,
  )
  process.exitCode = 1
})
