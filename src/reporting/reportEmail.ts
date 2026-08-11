import { canonicalJsonSha256, type JsonValue } from '../messaging/canonicalJson.ts'
import type { ClaimedOutboxMessage } from '../messaging/types.ts'
import type { MonthlyEmailReport } from './monthlyEmailReport.ts'
import { reportContentSha256 } from './monthlyEmailReport.ts'

export const MONTHLY_REPORT_EMAIL_EVENT = 'report.monthly.email'

export interface MonthlyReportEmailPayload {
  schemaVersion: '1'
  month: string
  generatedAt: string
  reportSha256: string
  recipientHash: string
  recipients: string[]
}

export interface ReportEmailMessage {
  messageId: string
  subject: string
  recipients: string[]
  html: string
  attachments: Array<{
    filename: string
    contentType: string
    content: Buffer
  }>
}

export interface ReportEmailTransport {
  send(message: ReportEmailMessage): Promise<{
    providerMessageId: string | null
  }>
}

function normalizedRecipients(
  values: readonly string[],
): string[] {
  const recipients = [
    ...new Set(
      values
        .map((value) => value.trim().toLowerCase())
        .filter(Boolean),
    ),
  ].sort()
  if (
    recipients.length === 0 ||
    recipients.some(
      (value) =>
        value.length > 255 ||
        !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@kairali\.com$/.test(
          value,
        ),
    )
  ) {
    throw new Error(
      'Report recipients must be one or more @kairali.com addresses',
    )
  }
  return recipients
}

export function buildMonthlyReportEmailPayload(
  report: MonthlyEmailReport,
  recipientInput: readonly string[],
): {
  messageId: string
  payload: MonthlyReportEmailPayload
} {
  const recipients = normalizedRecipients(recipientInput)
  const reportSha256 = reportContentSha256(report)
  const recipientHash = canonicalJsonSha256(
    recipients as unknown as JsonValue,
  )
  return {
    messageId:
      `report:${report.period.month}:` +
      `${reportSha256.slice(0, 32)}:` +
      `${recipientHash.slice(0, 16)}`,
    payload: {
      schemaVersion: '1',
      month: report.period.month,
      generatedAt: report.generatedAt,
      reportSha256,
      recipientHash,
      recipients,
    },
  }
}

export function parseMonthlyReportEmailPayload(
  message: ClaimedOutboxMessage,
): MonthlyReportEmailPayload {
  if (message.eventType !== MONTHLY_REPORT_EMAIL_EVENT) {
    throw new Error('Outbox message is not a monthly report email')
  }
  const value = JSON.parse(message.payloadJson) as Partial<
    MonthlyReportEmailPayload
  >
  if (
    value.schemaVersion !== '1' ||
    typeof value.month !== 'string' ||
    !/^\d{4}-\d{2}$/.test(value.month) ||
    typeof value.generatedAt !== 'string' ||
    !Number.isFinite(new Date(value.generatedAt).getTime()) ||
    typeof value.reportSha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.reportSha256) ||
    typeof value.recipientHash !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.recipientHash) ||
    !Array.isArray(value.recipients)
  ) {
    throw new Error('Monthly report email payload is invalid')
  }
  const recipients = normalizedRecipients(
    value.recipients as string[],
  )
  if (
    canonicalJsonSha256(
      recipients as unknown as JsonValue,
    ) !== value.recipientHash
  ) {
    throw new Error('Monthly report recipient hash does not match')
  }
  return {
    schemaVersion: '1',
    month: value.month,
    generatedAt: value.generatedAt,
    reportSha256: value.reportSha256,
    recipientHash: value.recipientHash,
    recipients,
  }
}

