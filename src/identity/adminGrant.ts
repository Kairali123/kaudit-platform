export const FULL_ACCESS_ROLE = 'admin'
export const FULL_ACCESS_SENSITIVITY_TIER = 'K3'

export interface ExistingAdminIdentity {
  id: string
  email: string
  status: string
  maxSensitivityTier: string
  roles: string[]
}

export interface AdminGrantPlan {
  email: string
  userExists: boolean
  activateUser: boolean
  grantAdminRole: boolean
  raiseSensitivityToK3: boolean
  alreadyFullyAuthorized: boolean
}

export interface AdminAccessState {
  email: string
  status: 'active'
  maxSensitivityTier: typeof FULL_ACCESS_SENSITIVITY_TIER
  roles: string[]
}

export function normalizeKairaliEmail(value: string): string {
  const email = value.trim().toLowerCase()
  if (
    email.length > 255 ||
    !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@kairali\.com$/.test(email)
  ) {
    throw new Error('Administrator email must be a valid @kairali.com address')
  }
  return email
}

export function planAdminGrant(
  emailInput: string,
  current: ExistingAdminIdentity | null,
): AdminGrantPlan {
  const email = normalizeKairaliEmail(emailInput)
  const activateUser = current !== null && current.status !== 'active'
  const grantAdminRole =
    current === null || !current.roles.includes(FULL_ACCESS_ROLE)
  const raiseSensitivityToK3 =
    current === null ||
    current.maxSensitivityTier !== FULL_ACCESS_SENSITIVITY_TIER

  return {
    email,
    userExists: current !== null,
    activateUser,
    grantAdminRole,
    raiseSensitivityToK3,
    alreadyFullyAuthorized:
      current !== null &&
      !activateUser &&
      !grantAdminRole &&
      !raiseSensitivityToK3,
  }
}

export function targetAdminAccessState(
  emailInput: string,
  currentRoles: readonly string[] = [],
): AdminAccessState {
  const roles = [...new Set([...currentRoles, FULL_ACCESS_ROLE])].sort()
  return {
    email: normalizeKairaliEmail(emailInput),
    status: 'active',
    maxSensitivityTier: FULL_ACCESS_SENSITIVITY_TIER,
    roles,
  }
}
