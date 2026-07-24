// Single-company access model for the Kairali audit platform. Two ORTHOGONAL,
// deny-by-default controls:
//
//   1. ROLES → functional permissions ("who can do what").
//   2. max_sensitivity_tier → who may view health-sensitive (K2/K3) CALL CONTENT.
//
// A billing analyst may hold billing permissions yet still not be allowed to open K2/K3
// audio — the two are independent. Enforcement is pure and testable here; the DB stores
// only which roles a user has (kaudit_user_role) and their tier (kaudit_user).
//
// The role catalog and permission codes below are a PROPOSAL for review — the exact set
// is a Kairali business decision.

export const ROLE_PERMISSIONS: Record<string, readonly string[]> = {
  platform_admin: ['user:manage', 'connection:manage', 'config:manage'],
  audit_manager: ['call:read', 'review:assign', 'review:policy', 'calibration:manage'],
  call_auditor: ['call:read', 'call:review', 'finding:confirm'],
  billing_analyst: ['call:read', 'billing:configure', 'invoice:reconcile'],
  finance_approver: ['billing:approve', 'reconciliation:close', 'dispute:approve'],
  corrective_action_triager: ['cluster:confirm', 'action:route'],
  clinical_safety_reviewer: ['safety:review', 'safety:escalate'],
  security_privacy_admin: ['retention:manage', 'access:review', 'legalhold:manage'],
  operations_viewer: ['call:read', 'metrics:read'],
  management_viewer: ['snapshot:read'],
}

// True if ANY of the user's roles grants the permission.
export function can(roles: readonly string[], permission: string): boolean {
  return roles.some((r) => ROLE_PERMISSIONS[r]?.includes(permission) ?? false)
}

// Sensitivity tiers in ascending order of access required. K4 (card/OTP/credentials) is
// intentionally absent — it is suppressed at source and NEVER viewable by anyone.
export const SENSITIVITY_ORDER: readonly string[] = ['K0', 'K1', 'K2', 'K3']

// Can a user whose ceiling is `maxSensitivityTier` view CONTENT (audio/transcript) of a
// call classified `callTier`? Deny-by-default: unknown tiers and K4 always deny.
export function canViewCallContent(maxSensitivityTier: string, callTier: string): boolean {
  if (callTier === 'K4') return false
  const max = SENSITIVITY_ORDER.indexOf(maxSensitivityTier)
  const need = SENSITIVITY_ORDER.indexOf(callTier)
  if (max < 0 || need < 0) return false // unknown tier → deny
  return max >= need
}
