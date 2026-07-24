import { resolveIdentity, type IdentityKind } from './resolveIdentity.ts'

// A raw identity value found in the schema, tagged with where it came from.
export interface IdentityRef {
  source: string // e.g. 'kaudit_review.reviewer_email'
  raw: string | null
}

export interface ResolvedUser {
  key: string // 'user:<email>' | 'system:<name>'
  kind: 'user' | 'system'
  identity: string // the email or the system-actor name
}

export interface UserSetResult {
  users: ResolvedUser[]
  mapping: Record<string, string> // normalized value → user key
  counts: Record<IdentityKind, number>
  bySource: Record<string, Record<IdentityKind, number>>
  invalidSamples: string[]
}

// Collapses every identity string found across the schema into a deduped set of users
// + system actors, with per-source and per-kind counts for review. Pure — no DB.
export function buildUserSet(refs: IdentityRef[]): UserSetResult {
  const users = new Map<string, ResolvedUser>()
  const mapping: Record<string, string> = {}
  const counts: Record<IdentityKind, number> = { user: 0, system: 0, empty: 0, invalid: 0 }
  const bySource: Record<string, Record<IdentityKind, number>> = {}
  const invalidSamples: string[] = []

  for (const ref of refs) {
    const r = resolveIdentity(ref.raw)
    counts[r.kind] += 1
    const srcCounts = bySource[ref.source] ?? { user: 0, system: 0, empty: 0, invalid: 0 }
    srcCounts[r.kind] += 1
    bySource[ref.source] = srcCounts

    if ((r.kind === 'user' || r.kind === 'system') && r.key && r.normalized) {
      if (!users.has(r.key)) users.set(r.key, { key: r.key, kind: r.kind, identity: r.normalized })
      mapping[r.normalized] = r.key
    } else if (r.kind === 'invalid' && ref.raw && invalidSamples.length < 20) {
      invalidSamples.push(ref.raw)
    }
  }

  return { users: [...users.values()], mapping, counts, bySource, invalidSamples }
}
