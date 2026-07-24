import type { IdentityRef, ResolvedUser } from './buildUserSet.ts'

// Collects every identity string across the schema's authorship/actor columns.
export interface IdentitySource {
  collect(): Promise<IdentityRef[]>
}

// Writes the resolved identity foundation: the single tenant, the user directory,
// and memberships. All upserts are idempotent (safe to re-run).
export interface IdentityRepo {
  ensureTenant(id: string, name: string): Promise<void>
  upsertUsers(users: ResolvedUser[]): Promise<{ inserted: number; existing: number }>
  // Assigns each resolved user a membership in the tenant with the given default role.
  upsertMemberships(tenantId: string, userKeys: string[], defaultRole: string): Promise<number>
}
