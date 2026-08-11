import nodemailer from 'nodemailer'
import type {
  ReportEmailMessage,
  ReportEmailTransport,
} from '../reporting/reportEmail.ts'

const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token'
const GMAIL_SEND_URL =
  'https://gmail.googleapis.com/gmail/v1/users/me/messages/send'

type FetchLike = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>

export interface GmailOAuthReportConfig {
  clientId: string
  clientSecret: string
  refreshToken: string
  from: string
}

export interface GmailOAuthReportEmailTransport
  extends ReportEmailTransport {
  verify(): Promise<void>
}

function codedError(code: string, message: string): Error {
  const error = new Error(message) as Error & { code: string }
  error.code = code
  return error
}

export function createGmailOAuthReportEmailTransport(
  config: GmailOAuthReportConfig,
  dependencies: { fetch?: FetchLike } = {},
): GmailOAuthReportEmailTransport {
  const fetcher = dependencies.fetch ?? fetch
  const mimeTransport = nodemailer.createTransport({
    streamTransport: true,
    buffer: true,
    newline: 'unix',
  })
  let cachedToken: {
    value: string
    expiresAt: number
  } | null = null

  async function accessToken(): Promise<string> {
    if (
      cachedToken &&
      cachedToken.expiresAt > Date.now() + 60_000
    ) {
      return cachedToken.value
    }
    const response = await fetcher(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        refresh_token: config.refreshToken,
        grant_type: 'refresh_token',
      }),
    })
    if (!response.ok) {
      throw codedError(
        'GOOGLE_OAUTH_TOKEN_FAILED',
        `Google OAuth token exchange failed with HTTP ${response.status}`,
      )
    }
    const body = (await response.json()) as {
      access_token?: unknown
      expires_in?: unknown
    }
    if (
      typeof body.access_token !== 'string' ||
      !body.access_token
    ) {
      throw codedError(
        'GOOGLE_OAUTH_TOKEN_INVALID',
        'Google OAuth response did not contain an access token',
      )
    }
    const expiresIn =
      typeof body.expires_in === 'number' &&
      Number.isFinite(body.expires_in)
        ? Math.max(60, body.expires_in)
        : 3_600
    cachedToken = {
      value: body.access_token,
      expiresAt: Date.now() + expiresIn * 1_000,
    }
    return cachedToken.value
  }

  return {
    async verify() {
      await accessToken()
    },
    async send(message: ReportEmailMessage) {
      const token = await accessToken()
      const rendered = await mimeTransport.sendMail({
        from: config.from,
        to: message.recipients,
        subject: message.subject,
        html: message.html,
        messageId:
          `<${message.messageId.replaceAll(':', '.')}` +
          '@kaudit.kairali.internal>',
        attachments: message.attachments,
      })
      const mime = (rendered as { message?: unknown }).message
      if (!Buffer.isBuffer(mime)) {
        throw codedError(
          'REPORT_MIME_BUILD_FAILED',
          'Report email could not be rendered as MIME',
        )
      }
      const response = await fetcher(GMAIL_SEND_URL, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          raw: mime.toString('base64url'),
        }),
      })
      if (!response.ok) {
        throw codedError(
          'GMAIL_API_SEND_FAILED',
          `Gmail API send failed with HTTP ${response.status}`,
        )
      }
      const body = (await response.json()) as { id?: unknown }
      return {
        providerMessageId:
          typeof body.id === 'string' ? body.id : null,
      }
    },
  }
}
