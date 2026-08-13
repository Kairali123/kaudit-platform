// Single-company access model for the Kairali audit platform. Two roles + one content gate,
// all deny-by-default:
//
//   • 'admin' → everything (user management, config, financial approvals, and — the control
//     that matters — granting/changing a user's health-content ceiling).
//   • 'user'  → day-to-day operational access (read/review/reconcile/report), NOT admin actions.
//   • 'unassigned' (the seed default) and anything unknown → nothing.
//
// max_sensitivity_tier gates the restricted admin call-review page and audio stream.
// Aggregate audit, billing, and reporting authorization remains role-based.

// Day-to-day operational permissions granted to the 'user' role.
export const USER_PERMISSIONS: readonly string[] = [
  'call:read',
  'call:review',
  'finding:confirm',
  'invoice:reconcile',
  'cluster:confirm',
  'action:route',
  'metrics:read',
  'snapshot:read',
]

// Named admin-only permissions. Admin is granted EVERYTHING; these exist so specific admin
// gates are explicit in code. Note: money-approval + close (billing:approve,
// reconciliation:close, dispute:approve) are admin-only, preserving a do-vs-approve split —
// flag if operational users should also close reconciliations.
export const ADMIN_ONLY_PERMISSIONS: readonly string[] = [
  'user:manage',
  'config:manage',
  'connection:manage',
  'import:write',
  'sensitivity:grant', // grant/change a user's max_sensitivity_tier (audited)
  'billing:approve',
  'reconciliation:close',
  'dispute:approve',
  'retention:manage',
  'access:review',
  'legalhold:manage',
  'policy:publish',
  'audit:inspect',
  'audit:control',
]

// True if the user's roles grant the permission. Admin ⇒ everything.
export function can(roles: readonly string[], permission: string): boolean {
  if (roles.includes('admin')) return true
  if (roles.includes('user')) return USER_PERMISSIONS.includes(permission)
  return false
}

// Only an admin may grant/change a user's health-content ceiling. The change itself must be
// recorded to the audit log by the caller.
export function canGrantSensitivity(roles: readonly string[]): boolean {
  return can(roles, 'sensitivity:grant')
}

// Sensitivity tiers in ascending order of access required. K4 (card/OTP/credentials) is
// intentionally absent — suppressed at source and NEVER viewable by anyone.
export const SENSITIVITY_ORDER: readonly string[] = ['K0', 'K1', 'K2', 'K3']

// Can a user whose ceiling is `maxSensitivityTier` view CONTENT (audio/transcript) of a call
// classified `callTier`? Deny-by-default: unknown tiers and K4 always deny.
export function canViewCallContent(maxSensitivityTier: string, callTier: string): boolean {
  if (callTier === 'K4') return false
  const max = SENSITIVITY_ORDER.indexOf(maxSensitivityTier)
  const need = SENSITIVITY_ORDER.indexOf(callTier)
  if (max < 0 || need < 0) return false
  return max >= need
}
