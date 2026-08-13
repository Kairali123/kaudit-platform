export interface PasswordIdentityInput {
  username: string
  email: string
}

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/

export function userPasswordValidationMessage(
  password: string,
  identity: PasswordIdentityInput,
): string | null {
  const requirements: string[] = []
  if (password.length < 12) requirements.push('be at least 12 characters')
  if (password.length > 256) requirements.push('be no more than 256 characters')
  if (!/[a-z]/.test(password)) requirements.push('include a lowercase letter')
  if (!/[A-Z]/.test(password)) requirements.push('include an uppercase letter')
  if (!/[0-9]/.test(password)) requirements.push('include a number')
  if (!/[^A-Za-z0-9]/.test(password)) requirements.push('include a symbol')
  if (CONTROL_CHARACTERS.test(password)) requirements.push('contain no control characters')

  const lowered = password.toLowerCase()
  const identityParts = [
    identity.username.trim().toLowerCase(),
    identity.email.trim().toLowerCase().split('@')[0] ?? '',
  ]
  if (
    identityParts.some((part) => part.length >= 3 && lowered.includes(part))
  ) {
    requirements.push('not contain the username or email name')
  }

  if (requirements.length === 0) return null
  return `Password must ${requirements.join(', ')}.`
}
