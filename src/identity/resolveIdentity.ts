// Classifies and normalizes a single identity string found in the existing schema
// (the scattered *_email / created_by / approved_by / actor_email columns).
//
//   'user'    → a real person's email (normalized to lowercase; deduped by email)
//   'system'  → a service/automation actor with no '@' (e.g. 'w3-backfill', 'w3-url-verify')
//   'empty'   → null / blank
//   'invalid' → had an '@' but is not a well-formed email (surfaced for review)

export type IdentityKind = 'user' | 'system' | 'empty' | 'invalid'

export interface ResolvedIdentity {
  kind: IdentityKind
  normalized: string | null // lowercased email ('user') or lowercased name ('system')
  key: string | null // dedup key: 'user:<email>' or 'system:<name>'
}

// Deliberately conservative: requires local@domain.tld. Anything looser is flagged
// 'invalid' for a human to look at rather than silently minted as a user.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export function resolveIdentity(raw: string | null | undefined): ResolvedIdentity {
  const v = (raw ?? '').trim()
  if (!v) return { kind: 'empty', normalized: null, key: null }

  if (!v.includes('@')) {
    const name = v.toLowerCase()
    return { kind: 'system', normalized: name, key: `system:${name}` }
  }

  const email = v.toLowerCase()
  if (!EMAIL_RE.test(email)) return { kind: 'invalid', normalized: null, key: null }
  return { kind: 'user', normalized: email, key: `user:${email}` }
}
