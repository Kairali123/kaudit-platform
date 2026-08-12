import { randomBytes } from 'node:crypto'
import type { AuditEvent } from '../audit/types.ts'
import { normalizeEmail, normalizeUsername } from '../auth/credentialIdentity.ts'
import { CredentialError } from '../auth/credentialTypes.ts'
import {
  checkPasswordPolicy,
  type PasswordIdentityContext,
  type PasswordPolicyViolation,
} from '../auth/passwordHash.ts'
import { sha256Hex } from '../lib/hash.ts'

/**
 * Administrator-driven user lifecycle — the framework-neutral half.
 *
 * Names, input validation, the safety invariants, and the audit event. Nothing
 * here opens a connection, runs a statement, reads the environment, or knows
 * that HTTP exists; the mysql2 half lives in
 * `adapters/mysqlUserAdministration.ts` and is the only place a statement runs.
 *
 * Two things this module deliberately does NOT do:
 *
 *  - It does not decide whether the actor is ALLOWED to administer users. That
 *    is `can(roles, 'user:manage')` in `access.ts`, evaluated by whatever
 *    surface authenticated the actor, before any of this is called. What the
 *    port requires is that an authenticated actor id EXISTS, because every
 *    change is attributed to one and three of the invariants below compare the
 *    actor against the target.
 *  - It never physically deletes anything. A permanent "delete" in the admin UI
 *    is the tombstone in {@link USER_ADMIN_AUDIT_ACTIONS.tombstoned}: the user
 *    row and every actor reference to it survive, the account stops being
 *    usable, and the username is retired rather than freed. Migration 0009
 *    states this policy; this module is where it is enforced.
 */

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

/** Only real people are administrable. `kind='system'` rows are internal actors. */
export const MANAGEABLE_USER_KIND = 'user'

/** The full-access role. Mirrors `access.ts`; not redefined, just named here. */
export const ADMIN_ROLE = 'admin'
/** Day-to-day operational role. */
export const OPERATOR_ROLE = 'user'

/**
 * The complete set of roles this surface may assign — the two that already
 * exist. Adding a third is a product decision with its own permission mapping,
 * so an unknown role is rejected rather than written and discovered later.
 */
export const ASSIGNABLE_ROLES = [ADMIN_ROLE, OPERATOR_ROLE] as const
export type AssignableRole = (typeof ASSIGNABLE_ROLES)[number]

/** `kaudit_user.status` and `kaudit_user_credential.status` share this vocabulary. */
export const ACCOUNT_STATUS = {
  active: 'active',
  disabled: 'disabled',
  tombstoned: 'tombstoned',
} as const
export type AccountStatus = (typeof ACCOUNT_STATUS)[keyof typeof ACCOUNT_STATUS]

/**
 * Sensitivity ceiling given to a newly created account.
 *
 * Deny by default: K1 is general PII only. Raising a ceiling to K2/K3 is a
 * separate, explicitly audited grant (`sensitivity:grant`), so creating a user
 * can never be the act that opens health content.
 */
export const NEW_USER_SENSITIVITY_TIER = 'K1'

/** One action per lifecycle transition. Read by humans; never parameterized. */
export const USER_ADMIN_AUDIT_ACTIONS = {
  created: 'USER_ACCOUNT_CREATED',
  updated: 'USER_ACCOUNT_UPDATED',
  activated: 'USER_ACCOUNT_ACTIVATED',
  deactivated: 'USER_ACCOUNT_DEACTIVATED',
  passwordReset: 'USER_ACCOUNT_PASSWORD_RESET',
  tombstoned: 'USER_ACCOUNT_TOMBSTONED',
} as const

export type UserAdminAuditAction =
  (typeof USER_ADMIN_AUDIT_ACTIONS)[keyof typeof USER_ADMIN_AUDIT_ACTIONS]

/** Recorded on every event so the trail names the surface that wrote it. */
export const USER_ADMIN_AUDIT_CLIENT = 'admin:user-administration'
export const USER_ADMIN_AUDIT_PURPOSE = 'user_administration'

/** `kaudit_user.id` / `kaudit_user_role.id` are varchar(40). */
export const MAX_USER_ID_LENGTH = 40

/** Paging bounds for the admin list. A caller cannot ask for the whole table. */
export const USER_LIST_DEFAULT_LIMIT = 50
export const USER_LIST_MAX_LIMIT = 200
export const USER_LIST_MAX_OFFSET = 100_000

/**
 * `ck_user_credential_password_hash` requires at least 40 characters, and the
 * column is varchar(255). Both a real hash and the revocation sentinel are
 * checked against this before they are written.
 */
export const MIN_PASSWORD_HASH_LENGTH = 40
export const MAX_PASSWORD_HASH_LENGTH = 255

/**
 * Prefix of the value written over a tombstoned password hash.
 *
 * Chosen so the result cannot parse as a hash: the stored encoding is exactly
 * four `$`-separated segments, and `revoked$<random>` is two. Anything that
 * tries to verify against it fails closed rather than comparing.
 */
export const REVOKED_PASSWORD_SENTINEL_PREFIX = 'revoked$'

/** The column is `int unsigned`; incrementing past this would wrap. */
export const MAX_SESSION_VERSION = 4_294_967_295

// ---------------------------------------------------------------------------
// Failure vocabulary
// ---------------------------------------------------------------------------

/** Rejections of the caller's INPUT, decided before any statement runs. */
export const USER_ADMIN_INPUT_CODES = {
  /** No authenticated actor id, or not an id shape. */
  actorInvalid: 'USER_ADMIN_ACTOR_INVALID',
  targetInvalid: 'USER_ADMIN_TARGET_INVALID',
  usernameMalformed: 'USER_ADMIN_USERNAME_MALFORMED',
  emailMalformed: 'USER_ADMIN_EMAIL_MALFORMED',
  roleInvalid: 'USER_ADMIN_ROLE_INVALID',
  /** The password fails the administrator policy. Carries codes, never the value. */
  passwordPolicy: 'USER_ADMIN_PASSWORD_POLICY',
  listWindowInvalid: 'USER_ADMIN_LIST_WINDOW_INVALID',
  activationFlagInvalid: 'USER_ADMIN_ACTIVATION_FLAG_INVALID',
} as const

export type UserAdminInputCode =
  (typeof USER_ADMIN_INPUT_CODES)[keyof typeof USER_ADMIN_INPUT_CODES]

/** Refusals decided from database STATE, after it is read under a lock. */
export const USER_ADMIN_REFUSAL_CODES = {
  userNotFound: 'USER_ADMIN_USER_NOT_FOUND',
  /** A `kind<>'user'` row: a system actor is not a person and is not managed here. */
  userNotManageable: 'USER_ADMIN_USER_NOT_MANAGEABLE',
  /** A user with no `kaudit_user_credential` row is not a database-login account. */
  credentialNotFound: 'USER_ADMIN_CREDENTIAL_NOT_FOUND',
  /** Terminal state: a tombstoned account is never edited, reset, or revived. */
  accountTombstoned: 'USER_ADMIN_ACCOUNT_TOMBSTONED',
  /** Includes a RETIRED username belonging to a tombstoned account. */
  usernameTaken: 'USER_ADMIN_USERNAME_TAKEN',
  emailTaken: 'USER_ADMIN_EMAIL_TAKEN',
  /** A unique key fired between the check and the write. Which one is not said. */
  identifierConflict: 'USER_ADMIN_IDENTIFIER_CONFLICT',
  selfDeactivate: 'USER_ADMIN_SELF_DEACTIVATE_FORBIDDEN',
  selfTombstone: 'USER_ADMIN_SELF_TOMBSTONE_FORBIDDEN',
  selfDemote: 'USER_ADMIN_SELF_DEMOTE_FORBIDDEN',
  /** The change would leave the installation with no active administrator. */
  lastAdmin: 'USER_ADMIN_LAST_ACTIVE_ADMIN',
  /** The session generation cannot be incremented any further. */
  sessionVersionExhausted: 'USER_ADMIN_SESSION_VERSION_EXHAUSTED',
} as const

export type UserAdminRefusalCode =
  (typeof USER_ADMIN_REFUSAL_CODES)[keyof typeof USER_ADMIN_REFUSAL_CODES]

/** Faults: something went wrong, and the transaction was rolled back. */
export const USER_ADMIN_FAULT_CODES = {
  readFailed: 'USER_ADMIN_READ_FAILED',
  writeFailed: 'USER_ADMIN_WRITE_FAILED',
  /** A guarded statement matched a number of rows the plan did not expect. */
  writeCountUnexpected: 'USER_ADMIN_WRITE_COUNT_UNEXPECTED',
  /** A stored value is not a shape this module will act on. */
  stateMalformed: 'USER_ADMIN_STATE_MALFORMED',
  /** The hashing primitive returned something unusable. Nothing is written. */
  hashUnusable: 'USER_ADMIN_HASH_UNUSABLE',
  hashingFailed: 'USER_ADMIN_HASHING_FAILED',
  /** The change was made but could not be audited, so it was rolled back. */
  auditFailed: 'USER_ADMIN_AUDIT_FAILED',
  commitFailed: 'USER_ADMIN_COMMIT_FAILED',
  /** Anything else. Deliberately opaque: the thrown value is never read. */
  unexpected: 'USER_ADMIN_UNEXPECTED_FAILURE',
} as const

export type UserAdminFaultCode =
  (typeof USER_ADMIN_FAULT_CODES)[keyof typeof USER_ADMIN_FAULT_CODES]

export type UserAdminCode =
  | UserAdminInputCode
  | UserAdminRefusalCode
  | UserAdminFaultCode

/** Which of the three groups a code came from, without matching on strings. */
export type UserAdminErrorKind = 'input' | 'refusal' | 'fault'

/**
 * The only error this surface raises.
 *
 * It carries a bounded code and, for a password rejection, the bounded policy
 * violation codes — nothing else. `Error.message` is set to the code, so an
 * accidental `console.error(error)` upstream prints a constant. A submitted
 * username, email, password, hash, or driver message is NEVER attached: driver
 * errors in particular quote the statement and its parameters, which is exactly
 * how a password or an email ends up in a log file.
 */
export class UserAdminError extends Error {
  readonly kind: UserAdminErrorKind
  readonly code: UserAdminCode
  readonly violations: readonly PasswordPolicyViolation[]

  constructor(
    kind: UserAdminErrorKind,
    code: UserAdminCode,
    violations: readonly PasswordPolicyViolation[] = [],
  ) {
    super(code)
    this.name = 'UserAdminError'
    this.kind = kind
    this.code = code
    this.violations = violations
  }
}

export function inputError(
  code: UserAdminInputCode,
  violations: readonly PasswordPolicyViolation[] = [],
): UserAdminError {
  return new UserAdminError('input', code, violations)
}

export function refusal(code: UserAdminRefusalCode): UserAdminError {
  return new UserAdminError('refusal', code)
}

export function fault(code: UserAdminFaultCode): UserAdminError {
  return new UserAdminError('fault', code)
}

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

const USER_ID_PATTERN = /^[A-Za-z0-9_-]+$/

function isUserId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_USER_ID_LENGTH &&
    USER_ID_PATTERN.test(value)
  )
}

/** The authenticated actor. Required by every operation, including the read. */
export function requireActorUserId(value: unknown): string {
  if (!isUserId(value)) throw inputError(USER_ADMIN_INPUT_CODES.actorInvalid)
  return value
}

export function requireTargetUserId(value: unknown): string {
  if (!isUserId(value)) throw inputError(USER_ADMIN_INPUT_CODES.targetInvalid)
  return value
}

export function requireAssignableRole(value: unknown): AssignableRole {
  if (
    typeof value !== 'string' ||
    !(ASSIGNABLE_ROLES as readonly string[]).includes(value)
  ) {
    throw inputError(USER_ADMIN_INPUT_CODES.roleInvalid)
  }
  return value as AssignableRole
}

/**
 * Re-raises `credentialIdentity`'s rejections in this module's vocabulary.
 *
 * The thrown `CredentialError` already carries a bounded code and a fixed
 * sentence, but callers of this port should have to handle exactly one error
 * type, and the mapping keeps the value out of the re-raise.
 */
function mapCredentialError(error: unknown, code: UserAdminInputCode): never {
  if (error instanceof CredentialError) throw inputError(code)
  throw fault(USER_ADMIN_FAULT_CODES.unexpected)
}

export function requireUsername(value: unknown): string {
  try {
    return normalizeUsername(value)
  } catch (error) {
    mapCredentialError(error, USER_ADMIN_INPUT_CODES.usernameMalformed)
  }
}

export function requireEmail(value: unknown): string {
  try {
    return normalizeEmail(value)
  } catch (error) {
    mapCredentialError(error, USER_ADMIN_INPUT_CODES.emailMalformed)
  }
}

/**
 * The password policy gate, run BEFORE any statement and before any KDF work.
 *
 * The violation codes travel with the error because a UI has to be able to say
 * "needs an uppercase letter"; the password itself is not returned, logged, or
 * retained here, and this is the only function in the module that reads it.
 */
export function requireAcceptablePassword(
  password: unknown,
  identity: PasswordIdentityContext,
): string {
  const violations = checkPasswordPolicy(password, identity)
  if (violations.length > 0 || typeof password !== 'string') {
    throw inputError(USER_ADMIN_INPUT_CODES.passwordPolicy, violations)
  }
  return password
}

export interface UserListWindow {
  limit: number
  offset: number
}

/** Bounded paging. Absent values take the defaults; bad ones are refused. */
export function requireListWindow(input: {
  limit?: unknown
  offset?: unknown
}): UserListWindow {
  const limit = input.limit ?? USER_LIST_DEFAULT_LIMIT
  const offset = input.offset ?? 0
  if (
    typeof limit !== 'number' ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > USER_LIST_MAX_LIMIT ||
    typeof offset !== 'number' ||
    !Number.isInteger(offset) ||
    offset < 0 ||
    offset > USER_LIST_MAX_OFFSET
  ) {
    throw inputError(USER_ADMIN_INPUT_CODES.listWindowInvalid)
  }
  return { limit, offset }
}

export function requireActivationFlag(value: unknown): boolean {
  if (typeof value !== 'boolean') {
    throw inputError(USER_ADMIN_INPUT_CODES.activationFlagInvalid)
  }
  return value
}

/** A session generation as read back from the driver, or a fault. */
export function requireSessionVersion(value: unknown): number {
  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && /^[0-9]{1,10}$/.test(value)
        ? Number(value)
        : Number.NaN
  if (
    !Number.isInteger(parsed) ||
    parsed < 1 ||
    parsed > MAX_SESSION_VERSION
  ) {
    throw fault(USER_ADMIN_FAULT_CODES.stateMalformed)
  }
  return parsed
}

/** The generation the row will carry after this transaction increments it. */
export function nextSessionVersion(current: number): number {
  if (current >= MAX_SESSION_VERSION) {
    throw refusal(USER_ADMIN_REFUSAL_CODES.sessionVersionExhausted)
  }
  return current + 1
}

// ---------------------------------------------------------------------------
// The locked state, and the invariants read off it
// ---------------------------------------------------------------------------

/**
 * The target as read inside the transaction, under `FOR UPDATE`.
 *
 * `username` and `email` are present because an edit has to know whether the
 * submitted value actually differs, and a password hash has to know the
 * identity fragments the policy forbids reusing. Neither ever reaches an audit
 * hash or an error.
 */
export interface ManagedAccount {
  userId: string
  kind: string
  userStatus: string
  email: string | null
  username: string | null
  credentialStatus: string | null
  sessionVersion: number | null
  roles: readonly string[]
}

export function isActiveAdmin(account: ManagedAccount): boolean {
  return (
    account.kind === MANAGEABLE_USER_KIND &&
    account.userStatus === ACCOUNT_STATUS.active &&
    account.credentialStatus === ACCOUNT_STATUS.active &&
    account.roles.includes(ADMIN_ROLE)
  )
}

export function isTombstoned(account: ManagedAccount): boolean {
  return (
    account.userStatus === ACCOUNT_STATUS.tombstoned ||
    account.credentialStatus === ACCOUNT_STATUS.tombstoned
  )
}

/**
 * The account is a real person, has database credentials, and is not closed.
 *
 * Every state-changing operation starts here, so a system actor, a
 * directory-only user, and a tombstoned account are refused once, in one place,
 * before any of the operation-specific rules run.
 */
export function requireManageableAccount(
  account: ManagedAccount | null,
): ManagedAccount {
  if (!account) throw refusal(USER_ADMIN_REFUSAL_CODES.userNotFound)
  if (account.kind !== MANAGEABLE_USER_KIND) {
    throw refusal(USER_ADMIN_REFUSAL_CODES.userNotManageable)
  }
  if (account.credentialStatus === null) {
    throw refusal(USER_ADMIN_REFUSAL_CODES.credentialNotFound)
  }
  if (isTombstoned(account)) {
    throw refusal(USER_ADMIN_REFUSAL_CODES.accountTombstoned)
  }
  return account
}

/**
 * An administrator may not lock themselves out.
 *
 * Deactivating, closing, or demoting your own account is always someone else's
 * change to make. The rule is unconditional rather than "unless another admin
 * exists": the last-admin check below covers the installation, this one covers
 * the mistake — and the two together mean neither a slip nor a lone
 * administrator can produce a system nobody can administer.
 */
export function refuseSelfTarget(
  actorUserId: string,
  targetUserId: string,
  code: UserAdminRefusalCode,
): void {
  if (actorUserId === targetUserId) throw refusal(code)
}

/**
 * The installation keeps at least one active administrator.
 *
 * `otherActiveAdmins` is counted inside the same transaction, under a lock, and
 * excludes the target — so a concurrent transaction demoting the only other
 * admin serializes against this one instead of both observing "there is another
 * one" and both proceeding.
 */
export function refuseLastActiveAdmin(
  account: ManagedAccount,
  otherActiveAdmins: number,
): void {
  if (isActiveAdmin(account) && otherActiveAdmins < 1) {
    throw refusal(USER_ADMIN_REFUSAL_CODES.lastAdmin)
  }
}

/**
 * Whether a role edit removes the target's administrator role.
 *
 * A change from `admin` to `user` is the demotion the self- and last-admin
 * rules care about; a change in the other direction, or none at all, is not.
 */
export function removesAdminRole(
  account: ManagedAccount,
  nextRole: AssignableRole,
): boolean {
  return account.roles.includes(ADMIN_ROLE) && nextRole !== ADMIN_ROLE
}

// ---------------------------------------------------------------------------
// The revocation sentinel
// ---------------------------------------------------------------------------

/**
 * The value written over a password hash when an account is closed for good.
 *
 * Cryptographically random, so nothing about the retired hash — not even its
 * length class — survives, and two tombstones are not comparable. Deliberately
 * unparseable, so `verifyPassword` refuses it structurally rather than doing a
 * comparison that could ever succeed. Long enough to satisfy
 * `ck_user_credential_password_hash`, which still requires 40 characters of
 * something in a NOT NULL column.
 */
export function buildRevokedPasswordSentinel(
  random: (bytes: number) => Buffer = randomBytes,
): string {
  const sentinel =
    REVOKED_PASSWORD_SENTINEL_PREFIX + random(32).toString('base64url')
  requireStorablePasswordHash(sentinel)
  return sentinel
}

/**
 * A value may only be written to `password_hash` if the column will accept it.
 *
 * Checked for a real hash too: an injected or future hashing primitive that
 * returned something short or empty would otherwise write an account into a
 * state where nobody can log in and the CHECK constraint is what discovers it.
 */
export function requireStorablePasswordHash(value: string): string {
  if (
    typeof value !== 'string' ||
    value.length < MIN_PASSWORD_HASH_LENGTH ||
    value.length > MAX_PASSWORD_HASH_LENGTH
  ) {
    throw fault(USER_ADMIN_FAULT_CODES.hashUnusable)
  }
  return value
}

// ---------------------------------------------------------------------------
// The audit event
// ---------------------------------------------------------------------------

/**
 * The lifecycle facts an audit row is allowed to pin.
 *
 * Control state only: who the change was about, what they may do, whether the
 * account is usable, and which session generation is current. No username, no
 * email, no display name, no password material — an audit row is read by more
 * people, in more places, than the user table it describes, and a hash of an
 * email is still an email to anyone holding a candidate list.
 */
export interface UserLifecycleFacts {
  userId: string
  userStatus: string
  credentialStatus: string
  roles: readonly string[]
  sessionVersion: number
}

export function userLifecycleHash(facts: UserLifecycleFacts): string {
  return sha256Hex(
    JSON.stringify([
      'kaudit-user-lifecycle',
      facts.userId,
      facts.userStatus,
      facts.credentialStatus,
      [...facts.roles].sort(),
      facts.sessionVersion,
    ]),
  )
}

/** The lifecycle facts of an account as read under the lock. */
export function accountLifecycleFacts(
  account: ManagedAccount,
): UserLifecycleFacts {
  return {
    userId: account.userId,
    userStatus: account.userStatus,
    credentialStatus: account.credentialStatus ?? 'none',
    roles: account.roles,
    sessionVersion: account.sessionVersion ?? 0,
  }
}

/**
 * One administrative change, as the permanent trail records it.
 *
 * The actor is the administrator who made the change; the resource is the
 * account it was made to. Both are ids. `actorEmail` stays null on purpose —
 * the column exists for surfaces that only ever knew an email, and this one
 * knows the actor's id, which is stable across a rename and is not PII.
 */
export function buildUserAdministrationAuditEvent(input: {
  action: UserAdminAuditAction
  actorUserId: string
  targetUserId: string
  beforeHash: string | null
  afterHash: string
  correlationId: string
  occurredAt: Date
}): AuditEvent {
  return {
    actorUserId: input.actorUserId,
    actorEmail: null,
    action: input.action,
    resourceType: 'kaudit_user',
    resourceId: input.targetUserId,
    outcome: 'success',
    purpose: USER_ADMIN_AUDIT_PURPOSE,
    correlationId: input.correlationId,
    ipAddress: null,
    client: USER_ADMIN_AUDIT_CLIENT,
    beforeHash: input.beforeHash,
    afterHash: input.afterHash,
    occurredAt: input.occurredAt,
  }
}

// ---------------------------------------------------------------------------
// The port
// ---------------------------------------------------------------------------

/**
 * The admin list projection.
 *
 * An explicit, bounded column list — never `SELECT *`, and never
 * `password_hash` or anything a session is minted from. Everything here is
 * something an administrator screen has to show to do its job.
 */
export interface UserAdminListItem {
  id: string
  username: string
  email: string | null
  displayName: string | null
  userStatus: string
  credentialStatus: string
  roles: string[]
  maxSensitivityTier: string
  lastLoginAt: string | null
  passwordChangedAt: string | null
  disabledAt: string | null
  createdAt: string | null
}

export interface ListUsersInput {
  actorUserId: string
  limit?: number
  offset?: number
}

export interface UserAdminListPage {
  users: UserAdminListItem[]
  limit: number
  offset: number
}

export interface CreateUserInput {
  actorUserId: string
  username: string
  email: string
  /** Held only long enough to hash it, inside the transaction that stores it. */
  password: string
  role: AssignableRole
}

export interface UpdateUserInput {
  actorUserId: string
  targetUserId: string
  username: string
  email: string
  role: AssignableRole
}

export interface SetUserActivationInput {
  actorUserId: string
  targetUserId: string
  active: boolean
}

export interface ResetUserPasswordInput {
  actorUserId: string
  targetUserId: string
  password: string
}

export interface TombstoneUserInput {
  actorUserId: string
  targetUserId: string
}

/**
 * What happened, in values that are all safe to print.
 *
 * No username, email, hash, or row content — an id the caller already supplied
 * (or, for a create, the one it now needs), the action recorded, whether
 * anything actually changed, and the session generation the account now
 * carries so a caller can reason about revocation.
 */
export interface UserAdminChangeResult {
  userId: string
  action: UserAdminAuditAction
  changed: boolean
  sessionVersion: number
  /** Null when nothing changed, so nothing was audited. */
  auditMode: 'hash-chained' | 'legacy' | null
}

export interface CreateUserResult extends UserAdminChangeResult {
  role: AssignableRole
}

/**
 * Admin-only lifecycle operations over the Kaudit-owned user tables.
 *
 * Every method takes the authenticated actor's id. Every method that changes
 * state does so in ONE transaction that also appends the audit event, and rolls
 * the whole thing back if any part of it fails.
 */
export interface UserAdministrationPort {
  listUsers(input: ListUsersInput): Promise<UserAdminListPage>
  createUser(input: CreateUserInput): Promise<CreateUserResult>
  updateUser(input: UpdateUserInput): Promise<UserAdminChangeResult>
  setUserActivation(
    input: SetUserActivationInput,
  ): Promise<UserAdminChangeResult>
  resetUserPassword(
    input: ResetUserPasswordInput,
  ): Promise<UserAdminChangeResult>
  /** The permanent "delete" in the UI. A state change, never a DELETE. */
  tombstoneUser(input: TombstoneUserInput): Promise<UserAdminChangeResult>
}
