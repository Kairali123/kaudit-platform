import { randomUUID } from 'node:crypto'
import {
  recordAuditEventInTransaction,
  type AuditWriteMode,
} from '../audit/transactionalAuditWriter.ts'
import {
  buildOidcBindingAuditEvent,
  oidcBindingHash,
  OIDC_BIND_REFUSAL_CODES,
  planOidcBinding,
  type NormalizedOidcBinding,
  type OidcBindRefusalCode,
  type OidcBindingTargetUser,
} from '../identity/oidcBinding.ts'

/**
 * The transactional half of the operator binding command.
 *
 * One transaction covers the whole decision: the target row and the identity
 * that might already own the requested pair are both read under `FOR UPDATE`,
 * the plan is computed from that locked state, and the write — if there is one —
 * is a guarded UPDATE that can only match a row still in the state the plan saw.
 * A concurrent binding therefore loses safely: it either blocks on the lock and
 * then fails the guard, or trips the `uq_user_oidc` unique key. Neither path can
 * overwrite an existing binding.
 *
 * Dry-run is the default and takes the same locks, so what an operator reviews is
 * the decision the executing run would make — and then rolls back, having
 * written nothing.
 *
 * The connection's lifecycle belongs to the caller; the transaction on it
 * belongs to this function.
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
export interface OidcBindingConnection {
  execute(sql: string, values?: any): Promise<unknown>
  query(sql: string, values?: any): Promise<unknown>
  beginTransaction(): Promise<void>
  commit(): Promise<void>
  rollback(): Promise<void>
}

/**
 * Every statement this module runs, in one place so a test can assert the exact
 * text — particularly the two locking reads and the guard on the UPDATE.
 */
export const OIDC_BINDING_SQL = {
  /** The target, located by normalized email and locked for the transaction. */
  selectTargetForUpdate: `SELECT id, kind, status, oidc_issuer, oidc_subject
     FROM kaudit_user
     WHERE email = ?
     LIMIT 1
     FOR UPDATE`,
  /** Whoever already owns the requested pair. Locked for the same reason. */
  selectIdentityOwnerForUpdate: `SELECT id
     FROM kaudit_user
     WHERE oidc_issuer = ? AND oidc_subject = ?
     LIMIT 1
     FOR UPDATE`,
  /** Reported, never changed: a binding grants nothing on its own. */
  countRoles: `SELECT COUNT(*) AS n
     FROM kaudit_user_role
     WHERE user_id = ?`,
  /**
   * The only write. The SET list is the binding and its timestamp — status,
   * kind, roles, sensitivity, display name, and email are all absent, so this
   * statement cannot change authorization even if it is somehow misaimed. The
   * WHERE clause re-states every fact the plan relied on, so a row that changed
   * after the read matches nothing instead of being overwritten.
   */
  guardedUpdate: `UPDATE kaudit_user
     SET oidc_issuer = ?,
         oidc_subject = ?,
         updated_at = CURRENT_TIMESTAMP(6)
     WHERE id = ?
       AND email = ?
       AND kind = 'user'
       AND oidc_issuer IS NULL
       AND oidc_subject IS NULL`,
} as const

// ---------------------------------------------------------------------------
// Failure vocabulary
// ---------------------------------------------------------------------------

/** Faults, as opposed to refusals. Bounded codes; no thrown value is read. */
export const OIDC_BIND_WRITE_CODES = {
  /** A read inside the transaction failed. */
  readFailed: 'OIDC_BIND_READ_FAILED',
  /** The guarded UPDATE itself raised. */
  updateFailed: 'OIDC_BIND_UPDATE_FAILED',
  /** The binding was written but could not be audited, so it was rolled back. */
  auditFailed: 'OIDC_BIND_AUDIT_FAILED',
  /** The transaction could not be committed. */
  commitFailed: 'OIDC_BIND_COMMIT_FAILED',
  /** Anything else. Deliberately opaque: the thrown value is never read. */
  unexpected: 'OIDC_BIND_UNEXPECTED_FAILURE',
} as const

export type OidcBindWriteCode =
  (typeof OIDC_BIND_WRITE_CODES)[keyof typeof OIDC_BIND_WRITE_CODES]

/**
 * The only error this module raises. It carries a bounded code and nothing
 * else: a driver error can quote the statement, its parameters, or a server
 * message, so the original is discarded rather than wrapped.
 */
export class OidcBindingWriteError extends Error {
  readonly code: OidcBindWriteCode

  constructor(code: OidcBindWriteCode) {
    super(code)
    this.name = 'OidcBindingWriteError'
    this.code = code
  }
}

/**
 * The unique-key violation, recognised without reading the error.
 *
 * `code` on a mysql2 error is a stable driver constant, not a message: matching
 * it exactly tells us the last defense fired and leaks nothing. Everything else
 * stays an opaque fault.
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
// Result
// ---------------------------------------------------------------------------

/**
 * What happened, in values that are all safe to print.
 *
 * No user id, no email, no issuer, no subject, no count that could identify a
 * row — closed enums, bounded codes, and booleans only. `userActive` and
 * `userHasRole` are here because the honest answer to "did the binding work" is
 * incomplete without them: binding a disabled or role-less account succeeds and
 * still leaves that account unable to do anything, and the operator should not
 * have to discover that at the login screen.
 */
export interface OidcBindingResult {
  mode: 'dry-run' | 'execute'
  outcome: 'bind' | 'no-op' | 'refused'
  refusalCode: OidcBindRefusalCode | null
  userFound: boolean
  userActive: boolean
  userHasRole: boolean
  bindingWritten: boolean
  auditMode: AuditWriteMode | null
}

interface UserRow {
  id: string
  kind: string
  status: string
  oidc_issuer: string | null
  oidc_subject: string | null
}

interface IdRow {
  id: string
}

interface CountRow {
  n: number | string
}

interface UpdateResult {
  affectedRows?: number
}

function rows<T>(result: unknown): T[] {
  const first = Array.isArray(result) ? (result[0] as unknown) : undefined
  return Array.isArray(first) ? (first as T[]) : []
}

function affectedRows(result: unknown): number {
  const header = Array.isArray(result) ? (result[0] as UpdateResult) : undefined
  return Number(header?.affectedRows ?? 0)
}

/**
 * Releases the transaction on a failure path.
 *
 * A rollback that itself fails means the connection is already unusable, and
 * the pool discards it on release; raising that fault here would replace the
 * bounded code describing what actually went wrong with an unbounded driver
 * error, so it is swallowed rather than read.
 */
async function safeRollback(connection: OidcBindingConnection): Promise<void> {
  try {
    await connection.rollback()
  } catch {
    // Nothing to add, and nothing safe to say about it.
  }
}

export interface BindOidcIdentityOptions {
  /** Deny by default. Only the CLI's exact-mode check may pass true. */
  execute: boolean
  /** Injected so a test can assert the recorded event without a clock race. */
  now?: () => Date
  /** Injected for the same reason; the audit event id and correlation id. */
  newId?: () => string
}

/**
 * Binds one pre-provisioned user to one OIDC identity, or explains why not.
 *
 * Never creates, activates, disables, promotes, or demotes anything. The only
 * statement that can write is {@link OIDC_BINDING_SQL.guardedUpdate}, it runs
 * only under `execute`, and only for a plan that read an unbound row of kind
 * `user` under a lock.
 */
export async function bindOidcIdentity(
  connection: OidcBindingConnection,
  request: NormalizedOidcBinding,
  options: BindOidcIdentityOptions,
): Promise<OidcBindingResult> {
  const mode: OidcBindingResult['mode'] = options.execute
    ? 'execute'
    : 'dry-run'
  const now = options.now ?? (() => new Date())
  const newId = options.newId ?? randomUUID

  await connection.beginTransaction()
  try {
    let user: OidcBindingTargetUser | null
    let identityOwnerUserId: string | null
    let userHasRole = false
    try {
      const targetRow = rows<UserRow>(
        await connection.execute(OIDC_BINDING_SQL.selectTargetForUpdate, [
          request.email,
        ]),
      )[0]
      user = targetRow
        ? {
            id: targetRow.id,
            kind: targetRow.kind,
            status: targetRow.status,
            oidcIssuer: targetRow.oidc_issuer,
            oidcSubject: targetRow.oidc_subject,
          }
        : null
      identityOwnerUserId =
        rows<IdRow>(
          await connection.execute(
            OIDC_BINDING_SQL.selectIdentityOwnerForUpdate,
            [request.issuer, request.subject],
          ),
        )[0]?.id ?? null
      if (user) {
        userHasRole =
          Number(
            rows<CountRow>(
              await connection.execute(OIDC_BINDING_SQL.countRoles, [user.id]),
            )[0]?.n ?? 0,
          ) > 0
      }
    } catch {
      await safeRollback(connection)
      throw new OidcBindingWriteError(OIDC_BIND_WRITE_CODES.readFailed)
    }

    const plan = planOidcBinding(request, { user, identityOwnerUserId })
    const observed = {
      userFound: user !== null,
      userActive: user?.status === 'active',
      userHasRole,
    }

    // Refusals and the idempotent no-op both end here, on either mode: there is
    // nothing to write, so the transaction is released rather than committed.
    if (plan.action !== 'bind') {
      await connection.rollback()
      return {
        mode,
        outcome: plan.action === 'no-op' ? 'no-op' : 'refused',
        refusalCode: plan.action === 'refuse' ? plan.code : null,
        ...observed,
        bindingWritten: false,
        auditMode: null,
      }
    }

    // A dry-run has now taken the same locks and reached the same plan as an
    // executing run would. That is the whole point of doing the reads inside a
    // transaction — and the rollback is what keeps it a dry run.
    if (!options.execute) {
      await connection.rollback()
      return {
        mode,
        outcome: 'bind',
        refusalCode: null,
        ...observed,
        bindingWritten: false,
        auditMode: null,
      }
    }

    let updated: unknown
    try {
      updated = await connection.execute(OIDC_BINDING_SQL.guardedUpdate, [
        request.issuer,
        request.subject,
        plan.userId,
        request.email,
      ])
    } catch (error) {
      await safeRollback(connection)
      // The unique key is the final defense: another transaction committed this
      // exact pair onto a different row between our read and our write.
      if (isDuplicateEntry(error)) {
        return {
          mode,
          outcome: 'refused',
          refusalCode: OIDC_BIND_REFUSAL_CODES.identityTaken,
          ...observed,
          bindingWritten: false,
          auditMode: null,
        }
      }
      throw new OidcBindingWriteError(OIDC_BIND_WRITE_CODES.updateFailed)
    }

    if (affectedRows(updated) !== 1) {
      // The guard held: the row is no longer the unbound row the plan read.
      await connection.rollback()
      return {
        mode,
        outcome: 'refused',
        refusalCode: OIDC_BIND_REFUSAL_CODES.updateGuardFailed,
        ...observed,
        bindingWritten: false,
        auditMode: null,
      }
    }

    let auditMode: AuditWriteMode
    try {
      auditMode = await recordAuditEventInTransaction(
        connection,
        buildOidcBindingAuditEvent({
          targetUserId: plan.userId,
          bindingHash: oidcBindingHash(request),
          correlationId: newId(),
          occurredAt: now(),
        }),
        newId(),
      )
    } catch {
      // An unauditable change is not made. The binding goes back with it.
      await safeRollback(connection)
      throw new OidcBindingWriteError(OIDC_BIND_WRITE_CODES.auditFailed)
    }

    try {
      await connection.commit()
    } catch {
      await safeRollback(connection)
      throw new OidcBindingWriteError(OIDC_BIND_WRITE_CODES.commitFailed)
    }

    return {
      mode,
      outcome: 'bind',
      refusalCode: null,
      ...observed,
      bindingWritten: true,
      auditMode,
    }
  } catch (error) {
    // Typed faults have already rolled back at the point they were raised; this
    // is the net for anything else, and it reads nothing off the value.
    if (error instanceof OidcBindingWriteError) throw error
    await safeRollback(connection)
    throw new OidcBindingWriteError(OIDC_BIND_WRITE_CODES.unexpected)
  }
}
