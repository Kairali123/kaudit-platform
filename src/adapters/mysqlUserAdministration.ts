import { randomUUID } from 'node:crypto'
import type { Pool } from 'mysql2/promise'
import {
  recordAuditEventInTransaction,
  type AuditWriteMode,
  type TransactionalAuditConnection,
} from '../audit/transactionalAuditWriter.ts'
import { CredentialError } from '../auth/credentialTypes.ts'
import {
  hashPassword,
  type PasswordIdentityContext,
} from '../auth/passwordHash.ts'
import {
  accountLifecycleFacts,
  ACCOUNT_STATUS,
  buildRevokedPasswordSentinel,
  buildUserAdministrationAuditEvent,
  fault,
  inputError,
  nextSessionVersion,
  refusal,
  refuseLastActiveAdmin,
  refuseSelfTarget,
  removesAdminRole,
  requireAcceptablePassword,
  requireActivationFlag,
  requireActorUserId,
  requireAssignableRole,
  requireEmail,
  requireListWindow,
  requireManageableAccount,
  requireSessionVersion,
  requireStorablePasswordHash,
  requireTargetUserId,
  requireUsername,
  userLifecycleHash,
  UserAdminError,
  USER_ADMIN_AUDIT_ACTIONS,
  USER_ADMIN_FAULT_CODES,
  USER_ADMIN_INPUT_CODES,
  USER_ADMIN_REFUSAL_CODES,
  type CreateUserInput,
  type CreateUserResult,
  type ListUsersInput,
  type ManagedAccount,
  type ResetUserPasswordInput,
  type SetUserActivationInput,
  type TombstoneUserInput,
  type UpdateUserInput,
  type UserAdministrationPort,
  type UserAdminChangeResult,
  type UserAdminListItem,
  type UserAdminListPage,
} from '../identity/userAdministration.ts'

/**
 * The mysql2 half of user administration — the only place a statement runs.
 *
 * Every statement is a module constant in {@link USER_ADMIN_SQL} with bound
 * placeholders. No table, column, filter, or value is ever assembled from a
 * caller value, so there is no dynamic SQL anywhere in this file; which of the
 * fixed statements run varies, their text never does.
 *
 * Every state change is one transaction that:
 *   1. locks the target (and, where an invariant depends on it, the active-admin
 *      set) with `FOR UPDATE`;
 *   2. decides from that locked state, using the invariants in
 *      `identity/userAdministration.ts`;
 *   3. writes guarded statements whose affected-row count is checked exactly;
 *   4. appends the audit event through `recordAuditEventInTransaction` in the
 *      SAME transaction;
 *   5. commits — or rolls the whole thing back. A change that cannot be
 *      validated, guarded, counted, or audited is not made.
 *
 * The tables touched are `kaudit_user`, `kaudit_user_credential`,
 * `kaudit_user_role`, and the audit-chain tables the writer owns. Nothing else.
 */

// ---------------------------------------------------------------------------
// Connection surface
// ---------------------------------------------------------------------------

/**
 * The narrow slice of a pooled connection used here.
 *
 * Parameter and result types are widened for the reason given in
 * `audit/transactionalAuditWriter.ts`: a real `PoolConnection` and a recording
 * fake both satisfy this, and every result is narrowed before it is read.
 */
export interface UserAdminConnection extends TransactionalAuditConnection {
  beginTransaction(): Promise<void>
  commit(): Promise<void>
  rollback(): Promise<void>
  release(): void
}

export interface UserAdminPool {
  query(sql: string, values?: any): Promise<unknown>
  getConnection(): Promise<UserAdminConnection>
}

/** Compile-time proof that a real mysql2 pool satisfies the structural port. */
export function fromMysqlPool(pool: Pool): UserAdminPool {
  return pool
}

// ---------------------------------------------------------------------------
// Statements
// ---------------------------------------------------------------------------

/**
 * The admin list projection, stated column by column.
 *
 * `password_hash` and `session_version` are absent on purpose: the first is
 * credential material that no screen may render, and the second is what a
 * session is validated against, so neither belongs in a list a browser holds.
 */
const LIST_COLUMNS = `
    u.id                    AS id,
    u.email                 AS email,
    u.display_name          AS display_name,
    u.status                AS user_status,
    u.max_sensitivity_tier  AS max_sensitivity_tier,
    u.last_login_at         AS last_login_at,
    u.created_at            AS created_at,
    c.username_normalized   AS username_normalized,
    c.status                AS credential_status,
    c.password_changed_at   AS password_changed_at,
    c.disabled_at           AS disabled_at,
    GROUP_CONCAT(DISTINCT r.role_code ORDER BY r.role_code SEPARATOR ',') AS roles`

export const USER_ADMIN_SQL = {
  /**
   * The admin page read. Bounded by a validated LIMIT/OFFSET and restricted to
   * real people — a `kind='system'` actor is not an account and is never listed.
   */
  listUsers: `SELECT${LIST_COLUMNS}
  FROM kaudit_user u
  JOIN kaudit_user_credential c ON c.user_id = u.id
  LEFT JOIN kaudit_user_role r ON r.user_id = u.id
  WHERE u.kind = 'user'
  GROUP BY u.id, u.email, u.display_name, u.status, u.max_sensitivity_tier,
           u.last_login_at, u.created_at, c.username_normalized, c.status,
           c.password_changed_at, c.disabled_at
  ORDER BY c.username_normalized ASC
  LIMIT ? OFFSET ?`,

  /**
   * The target, locked for the transaction.
   *
   * LEFT JOIN, so a directory-only user (no credential row) is distinguishable
   * from an id that does not exist at all, and a system actor is refused for
   * being a system actor rather than reported missing.
   */
  selectTargetForUpdate: `SELECT
    u.id                  AS id,
    u.kind                AS kind,
    u.status              AS user_status,
    u.email               AS email,
    c.username_normalized AS username_normalized,
    c.status              AS credential_status,
    c.session_version     AS session_version
  FROM kaudit_user u
  LEFT JOIN kaudit_user_credential c ON c.user_id = u.id
  WHERE u.id = ?
  LIMIT 1
  FOR UPDATE`,

  /** The target's roles, locked so a concurrent grant cannot slip past a check. */
  selectTargetRolesForUpdate: `SELECT role_code
  FROM kaudit_user_role
  WHERE user_id = ?
  ORDER BY role_code
  FOR UPDATE`,

  /**
   * Active administrators OTHER than the target, locked.
   *
   * This is the statement that makes "never zero active admins" hold under
   * concurrency: two transactions each demoting one of the last two admins
   * serialize on these rows, so the second one sees the first one's effect
   * instead of both reading a count of one.
   */
  countOtherActiveAdminsForUpdate: `SELECT COUNT(*) AS n
  FROM kaudit_user u
  JOIN kaudit_user_credential c ON c.user_id = u.id
  JOIN kaudit_user_role r ON r.user_id = u.id
  WHERE u.kind = 'user'
    AND u.status = 'active'
    AND c.status = 'active'
    AND r.role_code = 'admin'
    AND u.id <> ?
  FOR UPDATE`,

  /**
   * Who holds this username, locked.
   *
   * A tombstoned account still holds its row, so a retired username is found
   * here and refused — which is exactly the point: it is never reissued.
   */
  selectUsernameOwnerForUpdate: `SELECT user_id
  FROM kaudit_user_credential
  WHERE username_normalized = ?
  LIMIT 1
  FOR UPDATE`,

  selectEmailOwnerForUpdate: `SELECT id
  FROM kaudit_user
  WHERE email = ?
  LIMIT 1
  FOR UPDATE`,

  /**
   * A new person. `kind`, tier, and status are fixed literals: this statement
   * cannot create a system actor and cannot open health content.
   */
  insertUser: `INSERT INTO kaudit_user
    (id, kind, email, max_sensitivity_tier, status)
  VALUES (?, 'user', ?, 'K1', 'active')`,

  insertCredential: `INSERT INTO kaudit_user_credential
    (user_id, username_normalized, password_hash, session_version, status)
  VALUES (?, ?, ?, 1, 'active')`,

  /** `granted_by` carries the acting administrator's id — an id, never an email. */
  insertRole: `INSERT INTO kaudit_user_role
    (id, user_id, role_code, granted_by)
  VALUES (?, ?, ?, ?)`,

  /** Role replacement is delete-then-insert, so the account is never roleless after. */
  deleteRoles: `DELETE FROM kaudit_user_role WHERE user_id = ?`,

  /** The guard restates the username the plan read; a closed account is frozen. */
  updateUsername: `UPDATE kaudit_user_credential
     SET username_normalized = ?,
         updated_at = CURRENT_TIMESTAMP(6)
   WHERE user_id = ?
     AND username_normalized = ?
     AND status <> 'tombstoned'`,

  updateEmail: `UPDATE kaudit_user
     SET email = ?,
         updated_at = CURRENT_TIMESTAMP(6)
   WHERE id = ?
     AND kind = 'user'
     AND status <> 'tombstoned'`,

  /**
   * Deactivation. The session generation ALWAYS advances, so every outstanding
   * session for this user is revoked by this one write.
   */
  disableCredential: `UPDATE kaudit_user_credential
     SET status = 'disabled',
         disabled_at = COALESCE(disabled_at, CURRENT_TIMESTAMP(6)),
         session_version = session_version + 1,
         updated_at = CURRENT_TIMESTAMP(6)
   WHERE user_id = ?
     AND status <> 'tombstoned'`,

  /** Re-enable: back to active, `disabled_at` cleared, generation rotated. */
  enableCredential: `UPDATE kaudit_user_credential
     SET status = 'active',
         disabled_at = NULL,
         session_version = session_version + 1,
         updated_at = CURRENT_TIMESTAMP(6)
   WHERE user_id = ?
     AND status <> 'tombstoned'`,

  disableUser: `UPDATE kaudit_user
     SET status = 'disabled',
         updated_at = CURRENT_TIMESTAMP(6)
   WHERE id = ?
     AND kind = 'user'
     AND status <> 'tombstoned'`,

  enableUser: `UPDATE kaudit_user
     SET status = 'active',
         updated_at = CURRENT_TIMESTAMP(6)
   WHERE id = ?
     AND kind = 'user'
     AND status <> 'tombstoned'`,

  /** A new password revokes every session minted under the old one. */
  updatePassword: `UPDATE kaudit_user_credential
     SET password_hash = ?,
         password_changed_at = CURRENT_TIMESTAMP(6),
         session_version = session_version + 1,
         updated_at = CURRENT_TIMESTAMP(6)
   WHERE user_id = ?
     AND status <> 'tombstoned'`,

  /**
   * The permanent close-out. The row survives — so every `created_by`,
   * `granted_by`, and audit actor reference to this person still resolves — but
   * the stored hash is replaced with a random unparseable sentinel, so no hash
   * from this account outlives it.
   */
  tombstoneCredential: `UPDATE kaudit_user_credential
     SET status = 'tombstoned',
         disabled_at = COALESCE(disabled_at, CURRENT_TIMESTAMP(6)),
         password_hash = ?,
         session_version = session_version + 1,
         updated_at = CURRENT_TIMESTAMP(6)
   WHERE user_id = ?
     AND status <> 'tombstoned'`,

  tombstoneUser: `UPDATE kaudit_user
     SET status = 'tombstoned',
         updated_at = CURRENT_TIMESTAMP(6)
   WHERE id = ?
     AND kind = 'user'
     AND status <> 'tombstoned'`,
} as const

// ---------------------------------------------------------------------------
// Result narrowing
// ---------------------------------------------------------------------------

interface AccountRow {
  id: string
  kind: string
  user_status: string
  email: string | null
  username_normalized: string | null
  credential_status: string | null
  session_version: number | string | null
}

interface RoleRow {
  role_code: string
}

interface CountRow {
  n: number | string
}

interface IdRow {
  id: string
}

interface UserIdRow {
  user_id: string
}

interface ListRow {
  id: string
  email: string | null
  display_name: string | null
  user_status: string
  max_sensitivity_tier: string
  last_login_at: unknown
  created_at: unknown
  username_normalized: string
  credential_status: string
  password_changed_at: unknown
  disabled_at: unknown
  roles: string | null
}

function rows<T>(result: unknown): T[] {
  const first = Array.isArray(result) ? (result[0] as unknown) : undefined
  return Array.isArray(first) ? (first as T[]) : []
}

function affectedRows(result: unknown): number {
  const header = Array.isArray(result)
    ? (result[0] as { affectedRows?: unknown })
    : undefined
  return Number(header?.affectedRows ?? 0)
}

/** Timestamps as something a UI can render; never a driver object. */
function toTimestamp(value: unknown): string | null {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString()
  }
  if (typeof value === 'string' && value.length > 0 && value.length <= 40) {
    return value
  }
  return null
}

function splitRoles(value: string | null): string[] {
  return value ? value.split(',').filter(Boolean) : []
}

/**
 * The unique-key violation, recognised without reading the error.
 *
 * `code` on a mysql2 error is a stable driver constant; its `message` quotes the
 * duplicate VALUE, which for this table is a username or an email. The constant
 * is matched and the error is then discarded unread.
 */
function isDuplicateEntry(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ER_DUP_ENTRY'
  )
}

// ---------------------------------------------------------------------------
// Transaction plumbing
// ---------------------------------------------------------------------------

/**
 * Releases the transaction on a failure path.
 *
 * A rollback that itself fails means the connection is already unusable and the
 * pool discards it on release; raising that fault would replace the bounded code
 * describing what actually went wrong with an unbounded driver error.
 */
async function safeRollback(connection: UserAdminConnection): Promise<void> {
  try {
    await connection.rollback()
  } catch {
    // Nothing to add, and nothing safe to say about it.
  }
}

/** Bounded translation. A value thrown by the driver is never read or wrapped. */
function asUserAdminError(error: unknown): UserAdminError {
  if (error instanceof UserAdminError) return error
  return fault(USER_ADMIN_FAULT_CODES.unexpected)
}

interface TransactionOutcome<T> {
  /** False for a decided no-op: there is nothing to write, so nothing is kept. */
  commit: boolean
  value: T
}

async function inTransaction<T>(
  pool: UserAdminPool,
  body: (connection: UserAdminConnection) => Promise<TransactionOutcome<T>>,
): Promise<T> {
  let connection: UserAdminConnection
  try {
    connection = await pool.getConnection()
  } catch {
    throw fault(USER_ADMIN_FAULT_CODES.unexpected)
  }
  try {
    try {
      await connection.beginTransaction()
    } catch {
      throw fault(USER_ADMIN_FAULT_CODES.unexpected)
    }
    let outcome: TransactionOutcome<T>
    try {
      outcome = await body(connection)
    } catch (error) {
      await safeRollback(connection)
      throw asUserAdminError(error)
    }
    if (!outcome.commit) {
      await safeRollback(connection)
      return outcome.value
    }
    try {
      await connection.commit()
    } catch {
      await safeRollback(connection)
      throw fault(USER_ADMIN_FAULT_CODES.commitFailed)
    }
    return outcome.value
  } finally {
    connection.release()
  }
}

async function read<T>(
  connection: UserAdminConnection,
  sql: string,
  parameters: unknown[],
): Promise<T[]> {
  try {
    return rows<T>(await connection.execute(sql, parameters))
  } catch {
    throw fault(USER_ADMIN_FAULT_CODES.readFailed)
  }
}

/**
 * One guarded write, with its row count checked exactly.
 *
 * `expected` comes from the locked state, not from the statement: a guard that
 * matched a different number of rows than the plan decided on means the state
 * moved, and the transaction is abandoned rather than reconciled.
 */
async function write(
  connection: UserAdminConnection,
  sql: string,
  parameters: unknown[],
  expected: number,
): Promise<void> {
  let result: unknown
  try {
    result = await connection.execute(sql, parameters)
  } catch (error) {
    if (isDuplicateEntry(error)) {
      throw refusal(USER_ADMIN_REFUSAL_CODES.identifierConflict)
    }
    throw fault(USER_ADMIN_FAULT_CODES.writeFailed)
  }
  if (affectedRows(result) !== expected) {
    throw fault(USER_ADMIN_FAULT_CODES.writeCountUnexpected)
  }
}

async function appendAudit(
  connection: UserAdminConnection,
  event: Parameters<typeof recordAuditEventInTransaction>[1],
  eventId: string,
): Promise<AuditWriteMode> {
  try {
    return await recordAuditEventInTransaction(connection, event, eventId)
  } catch {
    // An unauditable change is not made; the caller rolls it back with this.
    throw fault(USER_ADMIN_FAULT_CODES.auditFailed)
  }
}

// ---------------------------------------------------------------------------
// Locked reads
// ---------------------------------------------------------------------------

async function readAccount(
  connection: UserAdminConnection,
  targetUserId: string,
): Promise<ManagedAccount | null> {
  const row = (
    await read<AccountRow>(connection, USER_ADMIN_SQL.selectTargetForUpdate, [
      targetUserId,
    ])
  )[0]
  if (!row) return null
  const roleRows = await read<RoleRow>(
    connection,
    USER_ADMIN_SQL.selectTargetRolesForUpdate,
    [targetUserId],
  )
  return {
    userId: row.id,
    kind: row.kind,
    userStatus: row.user_status,
    email: row.email ?? null,
    username: row.username_normalized ?? null,
    credentialStatus: row.credential_status ?? null,
    sessionVersion:
      row.session_version === null || row.session_version === undefined
        ? null
        : requireSessionVersion(row.session_version),
    roles: roleRows.map((entry) => entry.role_code),
  }
}

async function countOtherActiveAdmins(
  connection: UserAdminConnection,
  targetUserId: string,
): Promise<number> {
  const row = (
    await read<CountRow>(
      connection,
      USER_ADMIN_SQL.countOtherActiveAdminsForUpdate,
      [targetUserId],
    )
  )[0]
  const count = Number(row?.n ?? 0)
  if (!Number.isInteger(count) || count < 0) {
    throw fault(USER_ADMIN_FAULT_CODES.stateMalformed)
  }
  return count
}

// ---------------------------------------------------------------------------
// Hashing
// ---------------------------------------------------------------------------

/**
 * The password hashing primitive, injected so a test never buys real KDF work.
 * Production always passes the module default.
 */
export type PasswordHasher = (
  password: string,
  identity: PasswordIdentityContext,
) => Promise<string>

/**
 * Hashes the plaintext and forgets it.
 *
 * This is the ONLY place a submitted password is read, and the value never
 * leaves the call: what comes back is a one-way hash, and every thrown value is
 * replaced with a bounded code before it can carry parameters or a candidate.
 */
async function hashForStorage(
  hasher: PasswordHasher,
  password: string,
  identity: PasswordIdentityContext,
): Promise<string> {
  let hashed: string
  try {
    hashed = await hasher(password, identity)
  } catch (error) {
    if (error instanceof CredentialError && error.code === 'PASSWORD_POLICY') {
      throw inputError(USER_ADMIN_INPUT_CODES.passwordPolicy)
    }
    throw fault(USER_ADMIN_FAULT_CODES.hashingFailed)
  }
  return requireStorablePasswordHash(hashed)
}

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

export interface MysqlUserAdministrationOptions {
  /** Injected so a test can assert the recorded event without a clock race. */
  now?: () => Date
  /** Injected for the same reason: user ids, role ids, and correlation ids. */
  newId?: () => string
  hashPassword?: PasswordHasher
}

export function createMysqlUserAdministration(
  pool: UserAdminPool,
  options: MysqlUserAdministrationOptions = {},
): UserAdministrationPort {
  const now = options.now ?? (() => new Date())
  const newId = options.newId ?? randomUUID
  const hasher = options.hashPassword ?? hashPassword

  return {
    /**
     * The admin page read. No transaction and no audit event: this changes
     * nothing, and an audit row per page view would bury the changes that
     * matter under reads.
     *
     * Bound through `query` rather than `execute` because LIMIT/OFFSET
     * placeholders are the one case where the prepared-statement path is
     * driver-version sensitive; both bind, neither interpolates, and the two
     * values are validated integers before they get here.
     */
    async listUsers(input: ListUsersInput): Promise<UserAdminListPage> {
      requireActorUserId(input?.actorUserId)
      const window = requireListWindow(input ?? {})
      let result: unknown
      try {
        result = await pool.query(USER_ADMIN_SQL.listUsers, [
          window.limit,
          window.offset,
        ])
      } catch {
        throw fault(USER_ADMIN_FAULT_CODES.readFailed)
      }
      const users: UserAdminListItem[] = rows<ListRow>(result).map((row) => ({
        id: row.id,
        username: row.username_normalized,
        email: row.email ?? null,
        displayName: row.display_name ?? null,
        userStatus: row.user_status,
        credentialStatus: row.credential_status,
        roles: splitRoles(row.roles),
        maxSensitivityTier: row.max_sensitivity_tier,
        lastLoginAt: toTimestamp(row.last_login_at),
        passwordChangedAt: toTimestamp(row.password_changed_at),
        disabledAt: toTimestamp(row.disabled_at),
        createdAt: toTimestamp(row.created_at),
      }))
      return { users, limit: window.limit, offset: window.offset }
    },

    /**
     * One user, one credential, exactly one role — or nothing at all.
     *
     * The uniqueness reads happen first, under a lock, so a taken or retired
     * username is refused precisely instead of surfacing as a driver error; the
     * unique keys remain the last defense against the race between them.
     */
    async createUser(input: CreateUserInput): Promise<CreateUserResult> {
      const actorUserId = requireActorUserId(input?.actorUserId)
      const username = requireUsername(input?.username)
      const email = requireEmail(input?.email)
      const role = requireAssignableRole(input?.role)
      // Read once, here, and again by the hasher. Nothing else sees it.
      const password = requireAcceptablePassword(input?.password, {
        username,
        email,
      })

      return inTransaction<CreateUserResult>(pool, async (connection) => {
        const usernameOwner = (
          await read<UserIdRow>(
            connection,
            USER_ADMIN_SQL.selectUsernameOwnerForUpdate,
            [username],
          )
        )[0]
        if (usernameOwner) {
          throw refusal(USER_ADMIN_REFUSAL_CODES.usernameTaken)
        }
        const emailOwner = (
          await read<IdRow>(
            connection,
            USER_ADMIN_SQL.selectEmailOwnerForUpdate,
            [email],
          )
        )[0]
        if (emailOwner) throw refusal(USER_ADMIN_REFUSAL_CODES.emailTaken)

        const passwordHashValue = await hashForStorage(hasher, password, {
          username,
          email,
        })
        const userId = newId()

        await write(connection, USER_ADMIN_SQL.insertUser, [userId, email], 1)
        await write(
          connection,
          USER_ADMIN_SQL.insertCredential,
          [userId, username, passwordHashValue],
          1,
        )
        await write(
          connection,
          USER_ADMIN_SQL.insertRole,
          [newId(), userId, role, actorUserId],
          1,
        )

        const auditMode = await appendAudit(
          connection,
          buildUserAdministrationAuditEvent({
            action: USER_ADMIN_AUDIT_ACTIONS.created,
            actorUserId,
            targetUserId: userId,
            beforeHash: null,
            afterHash: userLifecycleHash({
              userId,
              userStatus: ACCOUNT_STATUS.active,
              credentialStatus: ACCOUNT_STATUS.active,
              roles: [role],
              sessionVersion: 1,
            }),
            correlationId: newId(),
            occurredAt: now(),
          }),
          newId(),
        )

        return {
          commit: true,
          value: {
            userId,
            role,
            action: USER_ADMIN_AUDIT_ACTIONS.created,
            changed: true,
            sessionVersion: 1,
            auditMode,
          },
        }
      })
    },

    /**
     * Username, email, and role, changed together or not at all.
     *
     * Roles are replaced rather than merged, so the account ends with exactly
     * the one requested — an update can never leave it roleless, and can never
     * leave a stale second role behind. A demotion does not rotate the session
     * generation: authorization is re-read from the database on every request,
     * so the change is already in force on the next one.
     */
    async updateUser(input: UpdateUserInput): Promise<UserAdminChangeResult> {
      const actorUserId = requireActorUserId(input?.actorUserId)
      const targetUserId = requireTargetUserId(input?.targetUserId)
      const username = requireUsername(input?.username)
      const email = requireEmail(input?.email)
      const role = requireAssignableRole(input?.role)

      return inTransaction<UserAdminChangeResult>(pool, async (connection) => {
        const account = requireManageableAccount(
          await readAccount(connection, targetUserId),
        )

        if (removesAdminRole(account, role)) {
          refuseSelfTarget(
            actorUserId,
            targetUserId,
            USER_ADMIN_REFUSAL_CODES.selfDemote,
          )
          refuseLastActiveAdmin(
            account,
            await countOtherActiveAdmins(connection, targetUserId),
          )
        }

        const usernameChanged = username !== account.username
        const emailChanged = email !== account.email
        const roleChanged =
          account.roles.length !== 1 || account.roles[0] !== role

        if (usernameChanged) {
          const owner = (
            await read<UserIdRow>(
              connection,
              USER_ADMIN_SQL.selectUsernameOwnerForUpdate,
              [username],
            )
          )[0]
          if (owner && owner.user_id !== targetUserId) {
            throw refusal(USER_ADMIN_REFUSAL_CODES.usernameTaken)
          }
          await write(
            connection,
            USER_ADMIN_SQL.updateUsername,
            [username, targetUserId, account.username],
            1,
          )
        }

        if (emailChanged) {
          const owner = (
            await read<IdRow>(
              connection,
              USER_ADMIN_SQL.selectEmailOwnerForUpdate,
              [email],
            )
          )[0]
          if (owner && owner.id !== targetUserId) {
            throw refusal(USER_ADMIN_REFUSAL_CODES.emailTaken)
          }
          await write(
            connection,
            USER_ADMIN_SQL.updateEmail,
            [email, targetUserId],
            1,
          )
        }

        if (roleChanged) {
          await write(
            connection,
            USER_ADMIN_SQL.deleteRoles,
            [targetUserId],
            account.roles.length,
          )
          await write(
            connection,
            USER_ADMIN_SQL.insertRole,
            [newId(), targetUserId, role, actorUserId],
            1,
          )
        }

        const before = accountLifecycleFacts(account)
        const auditMode = await appendAudit(
          connection,
          buildUserAdministrationAuditEvent({
            action: USER_ADMIN_AUDIT_ACTIONS.updated,
            actorUserId,
            targetUserId,
            beforeHash: userLifecycleHash(before),
            afterHash: userLifecycleHash({ ...before, roles: [role] }),
            correlationId: newId(),
            occurredAt: now(),
          }),
          newId(),
        )

        return {
          commit: true,
          value: {
            userId: targetUserId,
            action: USER_ADMIN_AUDIT_ACTIONS.updated,
            changed: usernameChanged || emailChanged || roleChanged,
            sessionVersion: before.sessionVersion,
            auditMode,
          },
        }
      })
    },

    /**
     * Enable or disable an account.
     *
     * Either direction rotates the session generation, so a deactivation
     * revokes every outstanding session in one write and a re-enable never
     * resurrects one that was minted before the account was closed off.
     */
    async setUserActivation(
      input: SetUserActivationInput,
    ): Promise<UserAdminChangeResult> {
      const actorUserId = requireActorUserId(input?.actorUserId)
      const targetUserId = requireTargetUserId(input?.targetUserId)
      const active = requireActivationFlag(input?.active)
      const action = active
        ? USER_ADMIN_AUDIT_ACTIONS.activated
        : USER_ADMIN_AUDIT_ACTIONS.deactivated

      return inTransaction<UserAdminChangeResult>(pool, async (connection) => {
        const account = requireManageableAccount(
          await readAccount(connection, targetUserId),
        )

        if (!active) {
          refuseSelfTarget(
            actorUserId,
            targetUserId,
            USER_ADMIN_REFUSAL_CODES.selfDeactivate,
          )
          refuseLastActiveAdmin(
            account,
            await countOtherActiveAdmins(connection, targetUserId),
          )
        }

        const desired = active
          ? ACCOUNT_STATUS.active
          : ACCOUNT_STATUS.disabled
        const currentVersion = requireSessionVersion(account.sessionVersion)

        // Already exactly where it was asked to be: nothing to write, so
        // nothing is kept — including an audit row for a change that is not one.
        if (
          account.userStatus === desired &&
          account.credentialStatus === desired
        ) {
          return {
            commit: false,
            value: {
              userId: targetUserId,
              action,
              changed: false,
              sessionVersion: currentVersion,
              auditMode: null,
            },
          }
        }

        const resultingVersion = nextSessionVersion(currentVersion)
        await write(
          connection,
          active
            ? USER_ADMIN_SQL.enableCredential
            : USER_ADMIN_SQL.disableCredential,
          [targetUserId],
          1,
        )
        if (account.userStatus !== desired) {
          await write(
            connection,
            active ? USER_ADMIN_SQL.enableUser : USER_ADMIN_SQL.disableUser,
            [targetUserId],
            1,
          )
        }

        const before = accountLifecycleFacts(account)
        const auditMode = await appendAudit(
          connection,
          buildUserAdministrationAuditEvent({
            action,
            actorUserId,
            targetUserId,
            beforeHash: userLifecycleHash(before),
            afterHash: userLifecycleHash({
              ...before,
              userStatus: desired,
              credentialStatus: desired,
              sessionVersion: resultingVersion,
            }),
            correlationId: newId(),
            occurredAt: now(),
          }),
          newId(),
        )

        return {
          commit: true,
          value: {
            userId: targetUserId,
            action,
            changed: true,
            sessionVersion: resultingVersion,
            auditMode,
          },
        }
      })
    },

    /**
     * Set a new password and revoke everything minted under the old one.
     *
     * The policy is checked twice: once on shape alone before any statement
     * runs, and once against the target's own username and email after they are
     * read under the lock — the second check is what stops a password that is
     * just the account's own handle spelled out.
     */
    async resetUserPassword(
      input: ResetUserPasswordInput,
    ): Promise<UserAdminChangeResult> {
      const actorUserId = requireActorUserId(input?.actorUserId)
      const targetUserId = requireTargetUserId(input?.targetUserId)
      // Shape only; the identity-reuse rule needs the row and runs below.
      requireAcceptablePassword(input?.password, {})

      return inTransaction<UserAdminChangeResult>(pool, async (connection) => {
        const account = requireManageableAccount(
          await readAccount(connection, targetUserId),
        )
        const identity: PasswordIdentityContext = {
          username: account.username,
          email: account.email,
        }
        const password = requireAcceptablePassword(input.password, identity)
        const resultingVersion = nextSessionVersion(
          requireSessionVersion(account.sessionVersion),
        )
        const passwordHashValue = await hashForStorage(
          hasher,
          password,
          identity,
        )

        await write(
          connection,
          USER_ADMIN_SQL.updatePassword,
          [passwordHashValue, targetUserId],
          1,
        )

        const before = accountLifecycleFacts(account)
        const auditMode = await appendAudit(
          connection,
          buildUserAdministrationAuditEvent({
            action: USER_ADMIN_AUDIT_ACTIONS.passwordReset,
            actorUserId,
            targetUserId,
            beforeHash: userLifecycleHash(before),
            afterHash: userLifecycleHash({
              ...before,
              sessionVersion: resultingVersion,
            }),
            correlationId: newId(),
            occurredAt: now(),
          }),
          newId(),
        )

        return {
          commit: true,
          value: {
            userId: targetUserId,
            action: USER_ADMIN_AUDIT_ACTIONS.passwordReset,
            changed: true,
            sessionVersion: resultingVersion,
            auditMode,
          },
        }
      })
    },

    /**
     * The permanent close-out behind the UI's "delete".
     *
     * Nothing is removed: the user row, its role rows, and every actor
     * reference to it survive, so historical audit entries still name a person
     * who exists. What ends is the account — both statuses go terminal, the
     * session generation advances one last time, and the stored hash is
     * replaced by a random sentinel nothing can verify against. The username
     * stays occupied by this row, which is what retires it.
     */
    async tombstoneUser(
      input: TombstoneUserInput,
    ): Promise<UserAdminChangeResult> {
      const actorUserId = requireActorUserId(input?.actorUserId)
      const targetUserId = requireTargetUserId(input?.targetUserId)

      return inTransaction<UserAdminChangeResult>(pool, async (connection) => {
        const account = requireManageableAccount(
          await readAccount(connection, targetUserId),
        )
        refuseSelfTarget(
          actorUserId,
          targetUserId,
          USER_ADMIN_REFUSAL_CODES.selfTombstone,
        )
        refuseLastActiveAdmin(
          account,
          await countOtherActiveAdmins(connection, targetUserId),
        )

        const resultingVersion = nextSessionVersion(
          requireSessionVersion(account.sessionVersion),
        )

        await write(
          connection,
          USER_ADMIN_SQL.tombstoneCredential,
          [buildRevokedPasswordSentinel(), targetUserId],
          1,
        )
        await write(
          connection,
          USER_ADMIN_SQL.tombstoneUser,
          [targetUserId],
          1,
        )

        const before = accountLifecycleFacts(account)
        const auditMode = await appendAudit(
          connection,
          buildUserAdministrationAuditEvent({
            action: USER_ADMIN_AUDIT_ACTIONS.tombstoned,
            actorUserId,
            targetUserId,
            beforeHash: userLifecycleHash(before),
            afterHash: userLifecycleHash({
              ...before,
              userStatus: ACCOUNT_STATUS.tombstoned,
              credentialStatus: ACCOUNT_STATUS.tombstoned,
              sessionVersion: resultingVersion,
            }),
            correlationId: newId(),
            occurredAt: now(),
          }),
          newId(),
        )

        return {
          commit: true,
          value: {
            userId: targetUserId,
            action: USER_ADMIN_AUDIT_ACTIONS.tombstoned,
            changed: true,
            sessionVersion: resultingVersion,
            auditMode,
          },
        }
      })
    },
  }
}
