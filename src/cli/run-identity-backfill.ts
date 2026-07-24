import mysql from 'mysql2/promise'
import { buildUserSet } from '../identity/buildUserSet.ts'
import { createMysqlIdentitySource } from '../adapters/mysqlIdentitySource.ts'
import { createMysqlIdentityRepo } from '../adapters/mysqlIdentityRepo.ts'

// Seeds the identity foundation: reads every authorship/actor string in the schema,
// resolves them into a deduped user + system-actor set, and (in EXECUTE) upserts the
// single tenant, the users, and their memberships. Requires migration 0003 applied.
// Defaults to DRY-RUN (report only). Writes only when KAUDIT_IDENTITY_MODE=EXECUTE.
async function main(): Promise<void> {
  const execute = process.env.KAUDIT_IDENTITY_MODE?.trim() === 'EXECUTE'
  const dryRun = !execute
  const tenantId = req('KAUDIT_TENANT_ID')
  const tenantName = process.env.KAUDIT_TENANT_NAME?.trim() || 'Kairali'
  const defaultRole = process.env.KAUDIT_DEFAULT_ROLE?.trim() || 'unassigned'

  const pool = mysql.createPool({
    host: req('DB_HOST'),
    port: Number(process.env.DB_PORT || 3306),
    database: req('DB_NAME'),
    user: req('DB_USER'),
    password: req('DB_PASSWORD'),
    connectionLimit: 5,
    connectTimeout: 30_000,
  })

  const source = createMysqlIdentitySource(pool)
  const refs = await source.collect()
  const result = buildUserSet(refs)

  console.log(`[W1-identity] ${dryRun ? 'DRY-RUN' : 'EXECUTE'} — scanned ${refs.length} identity strings`)
  console.log('[W1-identity] summary:', JSON.stringify({
    users: result.users.filter((u) => u.kind === 'user').length,
    systemActors: result.users.filter((u) => u.kind === 'system').length,
    counts: result.counts,
    invalidSamples: result.invalidSamples,
    bySource: result.bySource,
  }, null, 2))

  if (!dryRun) {
    const repo = createMysqlIdentityRepo(pool)
    await repo.ensureTenant(tenantId, tenantName)
    const up = await repo.upsertUsers(result.users)
    const memberships = await repo.upsertMemberships(tenantId, result.users.map((u) => u.key), defaultRole)
    console.log(`[W1-identity] wrote: users inserted=${up.inserted} existing=${up.existing}; memberships=${memberships}`)
  }
  await pool.end()
}

function req(name: string): string {
  const v = process.env[name]?.trim()
  if (!v) throw new Error(`${name} is required`)
  return v
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
