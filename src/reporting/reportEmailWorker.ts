import { sha256Hex } from '../lib/hash.ts'
import { retryDelayMs } from '../messaging/outboxPublisher.ts'
import type { ClaimedOutboxMessage } from '../messaging/types.ts'
import type { MonthlyEmailReport } from './monthlyEmailReport.ts'
import { reportContentSha256 } from './monthlyEmailReport.ts'
import {
  parseMonthlyReportEmailPayload,
  type ReportEmailTransport,
} from './reportEmail.ts'
import {
  buildReportEmailHtml,
  buildReportPdf,
  buildReportXlsx,
} from './reportAttachments.ts'

export interface ReportEmailWorkerRepository {
  claim(options: {
    owner: string
    limit: number
    now: Date
    leaseUntil: Date
  }): Promise<ClaimedOutboxMessage[]>
  markPublished(options: {
    id: string
    owner: string
    at: Date
  }): Promise<void>
  markFailed(options: {
    id: string
    owner: string
    at: Date
    availableAt: Date
    deadLetter: boolean
    errorCode: string
  }): Promise<void>
}

export interface ReportEmailWorkerSummary {
  claimed: number
  sent: number
  retried: number
  deadLettered: number
}

function safeErrorCode(error: unknown): string {
  if (
    error &&
    typeof error === 'object' &&
    'code' in error &&
    typeof error.code === 'string' &&
    /^[A-Z0-9_]{1,80}$/.test(error.code)
  ) {
    return error.code
  }
  return 'REPORT_EMAIL_FAILURE'
}

export async function runReportEmailBatch(options: {
  repository: ReportEmailWorkerRepository
  transport: ReportEmailTransport
  loadReport(
    month: string,
    generatedAt: string,
  ): Promise<MonthlyEmailReport>
  owner: string
  now: Date
  limit: number
  leaseMs?: number
  maxAttempts?: number
}): Promise<ReportEmailWorkerSummary> {
  const leaseMs = options.leaseMs ?? 10 * 60_000
  const maxAttempts = options.maxAttempts ?? 6
  const messages = await options.repository.claim({
    owner: options.owner,
    limit: options.limit,
    now: options.now,
    leaseUntil: new Date(options.now.getTime() + leaseMs),
  })
  const summary: ReportEmailWorkerSummary = {
    claimed: messages.length,
    sent: 0,
    retried: 0,
    deadLettered: 0,
  }
  for (const message of messages) {
    try {
      if (sha256Hex(message.payloadJson) !== message.payloadSha256) {
        const error = new Error('Outbox payload hash mismatch')
        ;(error as Error & { code: string }).code =
          'PAYLOAD_HASH_MISMATCH'
        throw error
      }
      const payload = parseMonthlyReportEmailPayload(message)
      const report = await options.loadReport(
        payload.month,
        payload.generatedAt,
      )
      if (reportContentSha256(report) !== payload.reportSha256) {
        const error = new Error(
          'Report source changed after the email was queued',
        )
        ;(error as Error & { code: string }).code =
          'REPORT_MANIFEST_CHANGED'
        throw error
      }
      const [pdf, xlsx] = await Promise.all([
        buildReportPdf(report),
        Promise.resolve(buildReportXlsx(report)),
      ])
      await options.transport.send({
        messageId: message.messageId,
        recipients: payload.recipients,
        subject:
          `Kairali AI Call Audit — ${report.period.label} ` +
          'revenue variance',
        html: buildReportEmailHtml(report),
        attachments: [
          {
            filename:
              `Kairali_${report.period.month}_Revenue_Variance.pdf`,
            contentType: 'application/pdf',
            content: pdf,
          },
          {
            filename:
              `Kairali_${report.period.month}_Call_Level_Backup.xlsx`,
            contentType:
              'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            content: xlsx,
          },
        ],
      })
      await options.repository.markPublished({
        id: message.id,
        owner: options.owner,
        at: options.now,
      })
      summary.sent += 1
    } catch (error) {
      const attemptsAfterFailure = message.attempts + 1
      const permanent =
        safeErrorCode(error) === 'PAYLOAD_HASH_MISMATCH' ||
        safeErrorCode(error) === 'REPORT_MANIFEST_CHANGED'
      const deadLetter =
        permanent || attemptsAfterFailure >= maxAttempts
      await options.repository.markFailed({
        id: message.id,
        owner: options.owner,
        at: options.now,
        availableAt: new Date(
          options.now.getTime() +
            retryDelayMs(attemptsAfterFailure),
        ),
        deadLetter,
        errorCode: safeErrorCode(error),
      })
      if (deadLetter) summary.deadLettered += 1
      else summary.retried += 1
    }
  }
  return summary
}

