import type { AuditEvent } from '../audit/types.ts'
import { sha256Hex } from '../lib/hash.ts'
import { normalizeKairaliEmail } from './adminGrant.ts'

/**
 * Explicit operator binding of ONE pre-provisioned `kaudit_user` to ONE OIDC
 * identity — the pure half: names, validation, and the decision.
 *
 * This is authorization plumbing and nothing else. Binding decides only WHICH
 * identity a login is matched against; it never creates a user, never activates
 * or disables one, never grants or revokes a role, and never moves a sensitivity
 * ceiling. A bound user with no role and a bound user that is disabled both stay
 * exactly as unable to do anything as they were before the binding existed.
 *
 * The one inference this module refuses to make is the important one: an OIDC
 * subject is NEVER derived from an email address. The provider's `sub` is an
 * opaque identifier that only a validated ID token (or the provider's own
 * identity-admin surface) can tell you, and a guessed value either matches
 * nobody or, worse, matches the wrong person forever. So the subject arrives
 * from the operator as its own explicit input and is checked for exactly the
 * mistake that would make it a guess.
 *
 * Nothing here reads the environment, opens a connection, logs, or throws a
 * value carrying operator input — see {@link OidcBindingInputError}.
 */

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

/** Every input, named and read in exactly one place (the CLI). */
export const OIDC_BIND_ENV = {
  mode: 'KAUDIT_OIDC_BIND_MODE',
  email: 'KAUDIT_OIDC_BIND_EMAIL',
  issuer: 'KAUDIT_OIDC_BIND_ISSUER',
  subject: 'KAUDIT_OIDC_BIND_SUBJECT',
} as const

/** The one word that arms a write. Compared byte for byte, never folded. */
export const OIDC_BIND_EXECUTE_MODE = 'EXECUTE'

/** The audit action recorded when a binding is actually written. */
export const OIDC_BINDING_AUDIT_ACTION = 'USER_OIDC_IDENTITY_BOUND'

/** Recorded on the audit event so the trail names the command that wrote it. */
export const OIDC_BINDING_AUDIT_CLIENT = 'w1:bind-oidc'

/**
 * Column widths from migration 0003. A value longer than the column would be
 * refused (or, on a permissive server, truncated into a binding that silently
 * matches nothing), so the ceiling is enforced before any statement runs.
 */
const MAX_EMAIL_LENGTH = 255
const MAX_ISSUER_LENGTH = 255
const MAX_SUBJECT_LENGTH = 255

// ---------------------------------------------------------------------------
// Failure vocabulary
// ---------------------------------------------------------------------------

/** Rejections of the operator's INPUT, before anything is read or written. */
export const OIDC_BIND_INPUT_CODES = {
  /** A named input was absent or blank. */
  missing: 'OIDC_BIND_MISSING_INPUT',
  /** Not the exact Kairali administrator email policy. */
  invalidEmail: 'OIDC_BIND_INVALID_EMAIL',
  /** Not an HTTPS issuer, or carrying credentials, a query, or a fragment. */
  invalidIssuer: 'OIDC_BIND_INVALID_ISSUER',
  /** Empty, over-long, or not an opaque printable token. */
  invalidSubject: 'OIDC_BIND_INVALID_SUBJECT',
  /** The subject looks like it was typed from the email rather than a token. */
  subjectDerivedFromEmail: 'OIDC_BIND_SUBJECT_LOOKS_DERIVED',
} as const

export type OidcBindInputCode =
  (typeof OIDC_BIND_INPUT_CODES)[keyof typeof OIDC_BIND_INPUT_CODES]

/** Refusals decided from database STATE, after the row is read under a lock. */
export const OIDC_BIND_REFUSAL_CODES = {
  /** No `kaudit_user` has this email. This command never creates one. */
  userNotFound: 'OIDC_BIND_USER_NOT_FOUND',
  /** The row is a system actor, not a person who signs in through a provider. */
  userNotBindable: 'OIDC_BIND_USER_NOT_BINDABLE',
  /** The target already carries a different binding — complete OR partial. */
  userAlreadyBound: 'OIDC_BIND_USER_ALREADY_BOUND',
  /** This issuer+subject already belongs to some other user row. */
  identityTaken: 'OIDC_BIND_IDENTITY_TAKEN',
  /** The guarded UPDATE matched no row: state changed under the lock. */
  updateGuardFailed: 'OIDC_BIND_UPDATE_GUARD_FAILED',
} as const

export type OidcBindRefusalCode =
  (typeof OIDC_BIND_REFUSAL_CODES)[keyof typeof OIDC_BIND_REFUSAL_CODES]

/**
 * An input rejection.
 *
 * It carries a bounded code and the NAME of the environment variable at fault —
 * never the value, and never a message derived from it. `Error.message` is set
 * to the code for the same reason: an accidental `console.error(error)` upstream
 * can then print only a code and a variable name.
 */
export class OidcBindingInputError extends Error {
  readonly code: OidcBindInputCode
  readonly field: string

  constructor(code: OidcBindInputCode, field: string) {
    super(code)
    this.name = 'OidcBindingInputError'
    this.code = code
    this.field = field
  }
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/** The operator's three values, checked and safe to hand to a statement. */
export interface NormalizedOidcBinding {
  email: string
  issuer: string
  subject: string
}

function requiredValue(value: string | undefined, field: string): string {
  const trimmed = value?.trim()
  if (!trimmed) {
    throw new OidcBindingInputError(OIDC_BIND_INPUT_CODES.missing, field)
  }
  return trimmed
}

/**
 * The email, under the policy this repository already states.
 *
 * `normalizeKairaliEmail` owns the rule; it is called rather than copied so a
 * future change to the administrator email policy cannot apply to a grant and
 * miss a binding. Its thrown message mentions the domain, not the value, but it
 * is replaced regardless: only a code and a variable name leave this module.
 */
function normalizeEmail(value: string): string {
  let email: string
  try {
    email = normalizeKairaliEmail(value)
  } catch {
    throw new OidcBindingInputError(
      OIDC_BIND_INPUT_CODES.invalidEmail,
      OIDC_BIND_ENV.email,
    )
  }
  if (email.length > MAX_EMAIL_LENGTH) {
    throw new OidcBindingInputError(
      OIDC_BIND_INPUT_CODES.invalidEmail,
      OIDC_BIND_ENV.email,
    )
  }
  return email
}

/**
 * The issuer, validated but deliberately NOT rewritten.
 *
 * Login compares the token's `iss` claim to this column with exact string
 * equality, and a URL round trip is not identity-preserving: `new URL(
 * 'https://accounts.google.com').toString()` appends a trailing slash, which the
 * provider does not send. A normalizing rewrite would therefore produce a
 * binding that looks correct in the database and matches nobody at sign-in. So
 * the URL parse is used as a CHECK and the operator's exact text (minus
 * surrounding whitespace) is what gets stored.
 *
 * The accepted shape is the one `loadRuntimeConfig` already requires of
 * `KAUDIT_OIDC_ISSUER`: HTTPS, no embedded credentials, no fragment. A query
 * string is refused too — an issuer identifier does not carry one, and a
 * copied-out-of-a-browser URL with `?...` is a paste mistake, not an issuer.
 */
function normalizeIssuer(value: string): string {
  if (value.length > MAX_ISSUER_LENGTH || /\s/.test(value)) {
    throw new OidcBindingInputError(
      OIDC_BIND_INPUT_CODES.invalidIssuer,
      OIDC_BIND_ENV.issuer,
    )
  }
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new OidcBindingInputError(
      OIDC_BIND_INPUT_CODES.invalidIssuer,
      OIDC_BIND_ENV.issuer,
    )
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.hash ||
    url.search ||
    !url.hostname
  ) {
    throw new OidcBindingInputError(
      OIDC_BIND_INPUT_CODES.invalidIssuer,
      OIDC_BIND_ENV.issuer,
    )
  }
  return value
}

/**
 * The subject: opaque, bounded, and provably not the email again.
 *
 * A provider's `sub` is a printable token with no whitespace — Google's is
 * digits — so the accepted set is printable ASCII excluding space. The two
 * rejections that matter are the ones that catch a guess rather than a copy: a
 * value equal to the email, and any value containing `@`. Neither is a shape a
 * `sub` claim takes, and both are exactly what gets typed when someone assumes
 * the subject can be worked out from the address.
 */
function normalizeSubject(value: string, email: string): string {
  if (
    value.length > MAX_SUBJECT_LENGTH ||
    !/^[\x21-\x7e]+$/.test(value)
  ) {
    throw new OidcBindingInputError(
      OIDC_BIND_INPUT_CODES.invalidSubject,
      OIDC_BIND_ENV.subject,
    )
  }
  if (value.includes('@') || value.toLowerCase() === email) {
    throw new OidcBindingInputError(
      OIDC_BIND_INPUT_CODES.subjectDerivedFromEmail,
      OIDC_BIND_ENV.subject,
    )
  }
  return value
}

/**
 * Validates the three explicit operator values.
 *
 * Order is deliberate: the email is normalized first because the subject check
 * compares against it. Nothing is inferred from anything — three inputs in,
 * three checked values out.
 */
export function normalizeOidcBinding(input: {
  email: string | undefined
  issuer: string | undefined
  subject: string | undefined
}): NormalizedOidcBinding {
  const email = normalizeEmail(requiredValue(input.email, OIDC_BIND_ENV.email))
  const issuer = normalizeIssuer(
    requiredValue(input.issuer, OIDC_BIND_ENV.issuer),
  )
  const subject = normalizeSubject(
    requiredValue(input.subject, OIDC_BIND_ENV.subject),
    email,
  )
  return { email, issuer, subject }
}

// ---------------------------------------------------------------------------
// The decision
// ---------------------------------------------------------------------------

/** The target row, as read under `FOR UPDATE`. */
export interface OidcBindingTargetUser {
  id: string
  kind: string
  status: string
  oidcIssuer: string | null
  oidcSubject: string | null
}

/** Everything the decision depends on, read inside the one transaction. */
export interface OidcBindingState {
  /** The row located by normalized email, or null when there is none. */
  user: OidcBindingTargetUser | null
  /** The row that already owns this exact issuer+subject, if any. */
  identityOwnerUserId: string | null
}

export type OidcBindingPlan =
  | { action: 'bind'; userId: string }
  | { action: 'no-op'; userId: string }
  | { action: 'refuse'; code: OidcBindRefusalCode; userId: string | null }

/**
 * Decides, from locked state alone, whether this binding may be written.
 *
 * Deny by default in every ambiguous case. The rules, in order:
 *
 *  - no row for the email → refuse. Provisioning is a separate, audited act.
 *  - a system actor → refuse. Those rows use `('system', name)` in the OIDC
 *    columns as an internal marker and must never be reachable by a login.
 *  - already exactly this binding → no-op. Re-running the command is safe.
 *  - any other issuer or subject already present, INCLUDING a half-set pair →
 *    refuse. Overwriting an existing binding is how an account gets silently
 *    handed to a different identity, so it is never done implicitly; a partial
 *    pair is a repair, not a binding, and belongs to a reviewed operation.
 *  - this issuer+subject already owned by another row → refuse. The unique key
 *    would stop it anyway; refusing here makes the reason legible.
 */
export function planOidcBinding(
  request: NormalizedOidcBinding,
  state: OidcBindingState,
): OidcBindingPlan {
  const { user, identityOwnerUserId } = state
  if (!user) {
    return {
      action: 'refuse',
      code: OIDC_BIND_REFUSAL_CODES.userNotFound,
      userId: null,
    }
  }
  if (user.kind !== 'user') {
    return {
      action: 'refuse',
      code: OIDC_BIND_REFUSAL_CODES.userNotBindable,
      userId: user.id,
    }
  }
  const takenByAnother =
    identityOwnerUserId !== null && identityOwnerUserId !== user.id
  if (
    user.oidcIssuer === request.issuer &&
    user.oidcSubject === request.subject
  ) {
    // The unique key makes "already ours, yet owned elsewhere" impossible; it is
    // still checked, because a no-op is the one outcome that reports success.
    return takenByAnother
      ? {
          action: 'refuse',
          code: OIDC_BIND_REFUSAL_CODES.identityTaken,
          userId: user.id,
        }
      : { action: 'no-op', userId: user.id }
  }
  if (user.oidcIssuer !== null || user.oidcSubject !== null) {
    return {
      action: 'refuse',
      code: OIDC_BIND_REFUSAL_CODES.userAlreadyBound,
      userId: user.id,
    }
  }
  if (takenByAnother) {
    return {
      action: 'refuse',
      code: OIDC_BIND_REFUSAL_CODES.identityTaken,
      userId: user.id,
    }
  }
  return { action: 'bind', userId: user.id }
}

// ---------------------------------------------------------------------------
// The audit event
// ---------------------------------------------------------------------------

/**
 * A stable digest of the binding, and the only representation of it that
 * reaches the audit log.
 *
 * The pair is what changed, so the trail has to pin it — but an audit row is
 * read by more people, in more places, than the user table it describes, so it
 * gets the hash and not the values. Two hashes match iff the same identity was
 * bound; nothing about the issuer or subject can be recovered from either.
 */
export function oidcBindingHash(request: NormalizedOidcBinding): string {
  return sha256Hex(
    JSON.stringify(['oidc-binding', request.issuer, request.subject]),
  )
}

/**
 * The identity-provisioning event for a written binding.
 *
 * Identifiers and hashes only, and no actor at all. The target user is the
 * SUBJECT of this change, not its author: they have not authenticated — that is
 * the whole reason the binding is being written — and they are not necessarily
 * the operator who ran the command. Naming them `actorUserId` would put a false
 * statement in the permanent trail, and a false one in the direction that
 * matters, since an actor is who gets asked about a change later. This command
 * establishes no operator identity of its own, so both actor columns stay null
 * and the row says plainly what is known: the fixed CLI client made this change
 * to this `resourceId`.
 *
 * `beforeHash` is null because the guarded UPDATE only ever runs against a row
 * with no binding at all — the prior state is "unbound", not a hidden value.
 */
export function buildOidcBindingAuditEvent(input: {
  /** The row that was bound. The subject of the change, never its actor. */
  targetUserId: string
  bindingHash: string
  correlationId: string
  occurredAt: Date
}): AuditEvent {
  return {
    actorUserId: null,
    actorEmail: null,
    action: OIDC_BINDING_AUDIT_ACTION,
    resourceType: 'kaudit_user',
    resourceId: input.targetUserId,
    outcome: 'success',
    purpose: 'identity_provisioning',
    correlationId: input.correlationId,
    ipAddress: null,
    client: OIDC_BINDING_AUDIT_CLIENT,
    beforeHash: null,
    afterHash: input.bindingHash,
    occurredAt: input.occurredAt,
  }
}
