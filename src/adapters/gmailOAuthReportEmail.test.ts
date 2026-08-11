import assert from 'node:assert/strict'
import test from 'node:test'
import { createGmailOAuthReportEmailTransport } from './gmailOAuthReportEmail.ts'

test('exchanges a refresh token and sends a MIME report through Gmail API', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  const transport = createGmailOAuthReportEmailTransport(
    {
      clientId: 'synthetic-client',
      clientSecret: 'synthetic-secret',
      refreshToken: 'synthetic-refresh',
      from: 'dme@kairali.com',
    },
    {
      async fetch(input, init) {
        const url = String(input)
        calls.push({ url, init })
        if (url.includes('/token')) {
          return new Response(
            JSON.stringify({
              access_token: 'synthetic-access',
              expires_in: 3_600,
            }),
            {
              status: 200,
              headers: { 'content-type': 'application/json' },
            },
          )
        }
        return new Response(
          JSON.stringify({ id: 'gmail-message-1' }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          },
        )
      },
    },
  )

  await transport.verify()
  const result = await transport.send({
    messageId: 'report:2026-04:synthetic',
    recipients: ['dme@kairali.com'],
    subject: 'Synthetic report',
    html: '<p>Aggregate test data only</p>',
    attachments: [
      {
        filename: 'report.pdf',
        contentType: 'application/pdf',
        content: Buffer.from('synthetic'),
      },
    ],
  })

  assert.equal(result.providerMessageId, 'gmail-message-1')
  assert.equal(calls.length, 2)
  assert.match(calls[0]?.url || '', /oauth2\.googleapis\.com\/token/)
  assert.match(
    calls[1]?.url || '',
    /gmail\.googleapis\.com\/gmail\/v1\/users\/me\/messages\/send/,
  )
  const sendHeaders = new Headers(calls[1]?.init?.headers)
  assert.equal(
    sendHeaders.get('authorization'),
    'Bearer synthetic-access',
  )
  const sendBody = JSON.parse(
    String(calls[1]?.init?.body),
  ) as { raw?: unknown }
  assert.equal(typeof sendBody.raw, 'string')
  assert.ok((sendBody.raw as string).length > 100)
})

test('reports a safe code when refresh-token exchange fails', async () => {
  const transport = createGmailOAuthReportEmailTransport(
    {
      clientId: 'synthetic-client',
      clientSecret: 'synthetic-secret',
      refreshToken: 'synthetic-refresh',
      from: 'dme@kairali.com',
    },
    {
      async fetch() {
        return new Response(
          JSON.stringify({ error: 'invalid_grant' }),
          { status: 400 },
        )
      },
    },
  )
  await assert.rejects(
    transport.verify(),
    (error: Error & { code?: string }) =>
      error.code === 'GOOGLE_OAUTH_TOKEN_FAILED' &&
      !error.message.includes('synthetic-refresh'),
  )
})
