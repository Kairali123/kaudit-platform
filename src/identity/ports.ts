import type { IdentityRef, ResolvedUser } from './buildUserSet.ts'

// Collects every identity string across the schema's authorship/actor columns.
export interface IdentitySource {
  collect(): Promise<IdentityRef[]>
}

// Writes the identity foundation: the user directory + role assignments. Idempotent.
export interface IdentityRepo {
  upsertUsers(users: ResolvedUser[]): Promise<{ inserted: number; existing: number }>
  // Assigns each resolved user the given role (idempotent). Returns rows affected.
  assignRole(userKeys: string[], roleCode: string): Promise<number>
}
