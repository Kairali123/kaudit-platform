import mysql from 'mysql2/promise'
import { createProxyResolvingFetcher } from '../adapters/proxyResolvingFetcher.ts'
import { createMysqlReauditReadRepo } from '../adapters/mysqlReauditReadRepo.ts'
import { createOpenAiReaudit } from '../adapters/openaiReaudit.ts'
import { auditOneCall } from '../reaudit/core.ts'

function required(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`${name} is required`)
  return value
}

function positiveInteger(name: string, fallback: number, maximum: number): number {
  const value = Number(process.env[name] || fallback)
  if (!Number.isInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${name} must be an integer from 1 to ${maximum}`)
  }
  return value
}

async function main(): Promise<void> {
  const limit = positiveInteger('KAUDIT_REAUDIT_LIMIT', 5, 50)
  const allowedHosts = required('KAUDIT_ALLOWED_RECORDING_HOSTS')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
  const pool = mysql.createPool({
    host: required('DB_HOST'),
    port: Number(process.env.DB_PORT || 3306),
    database: required('DB_NAME'),
    user: required('DB_USER'),
    password: required('DB_PASSWORD'),
    connectionLimit: 3,
    connectTimeout: 30_000,
  })
  try {
    const repo = createMysqlReauditReadRepo(pool)
    const candidates = await repo.listCandidates({
      limit,
      includePreviouslyClassified: false,
    })
    const fetcher = createProxyResolvingFetcher(
      required('KAUDIT_UNPOD_PROXY_BASE'),
    )
    const ai = createOpenAiReaudit(required('OPENAI_API_KEY'))
    const counts: Record<string, number> = {}
    const categories: Record<string, number> = {}
    const languages: Record<string, number> = {}
    let projectedPaise = 0n
    let projectedHalfMinutes = 0n
    console.log(
      `[reaudit-sample] read-only shadow run; candidates=${candidates.length}; no database writes`,
    )
    for (const candidate of candidates) {
      const result = await auditOneCall({
        candidate,
        fetcher,
        ai,
        allowedHosts,
      })
      counts[result.outcome] = (counts[result.outcome] || 0) + 1
      if (result.analysis) {
        categories[result.analysis.category] =
          (categories[result.analysis.category] || 0) + 1
        languages[result.analysis.language] =
          (languages[result.analysis.language] || 0) + 1
      }
      if (result.projection) {
        projectedPaise += result.projection.amountPaise
        projectedHalfMinutes += BigInt(
          Math.round(Number(result.projection.billableMinutes) * 2),
        )
      }
      console.log(
        `[reaudit-sample] ${Object.values(counts).reduce((a, b) => a + b, 0)}/${candidates.length} outcome=${result.outcome}`,
      )
    }
    console.log(
      '[reaudit-sample] summary:',
      JSON.stringify(
        {
          total: candidates.length,
          outcomes: counts,
          categories,
          languages,
          projectedBillableMinutes: Number(projectedHalfMinutes) / 2,
          projectedAmount: `INR ${(Number(projectedPaise) / 100).toFixed(2)}`,
          authority: 'PROVISIONAL — calibration and rate-card publication still required',
          databaseWrites: 0,
        },
        null,
        2,
      ),
    )
  } finally {
    await pool.end()
  }
}

main().catch((error) => {
  console.error('[reaudit-sample] failed:', error)
  process.exitCode = 1
})
