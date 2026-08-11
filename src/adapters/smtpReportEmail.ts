import nodemailer from 'nodemailer'
import type {
  ReportEmailMessage,
  ReportEmailTransport,
} from '../reporting/reportEmail.ts'

export interface SmtpReportConfig {
  host: string
  port: number
  secure: boolean
  user: string | null
  password: string | null
  from: string
}

export function createSmtpReportEmailTransport(
  config: SmtpReportConfig,
): ReportEmailTransport {
  const transport = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth:
      config.user && config.password
        ? {
            user: config.user,
            pass: config.password,
          }
        : undefined,
    connectionTimeout: 30_000,
    greetingTimeout: 30_000,
    socketTimeout: 120_000,
  })
  return {
    async send(message: ReportEmailMessage) {
      const response = await transport.sendMail({
        from: config.from,
        to: message.recipients,
        subject: message.subject,
        html: message.html,
        messageId:
          `<${message.messageId.replaceAll(':', '.')}` +
          '@kaudit.kairali.internal>',
        attachments: message.attachments,
      })
      return {
        providerMessageId:
          typeof response.messageId === 'string'
            ? response.messageId
            : null,
      }
    },
  }
}

