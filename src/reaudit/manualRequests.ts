import { createHash, randomUUID } from 'node:crypto'
import { canonicalJson } from '../messaging/canonicalJson.ts'

/**
 * Domain rules for ADMINISTRATOR-REQUESTED Billing Audit re-audits.
 *
 * Pure. No SQL, no HTTP, no provider client, no clock of its own. Everything
 * here is validation, deterministic identity, and the two lifecycle decisions
 * a manual re-audit turns on.
 *
 * The invariants this module owns:
 *
 *   * A REQUEST IS EXACT AND BOUNDED. At most
 *     {@link MAX_MANUAL_REAUDIT_CALLS} displayed call references, each one a
 *     trimmed, control-character-free, non-duplicated string. Nothing is
 *     widened, pattern-matched, or inferred from a filter.
 *   * A RETRY IS NOT A SECOND SPEND. The caller's idempotency key plus the
 *     digest of the exact selection decide whether a POST is a new request or
 *     a replay of one already accepted.
 *   * A BASELINE DECIDES WHETHER TO SPEND. Each item records the audit run
 *     that was current when it was queued. If the call moved on before the
 *     worker reached it, the item is SKIPPED rather than re-audited, so an
 *     administrator never pays for an answer to a stale question.
 *   * SAME RULESET IS STILL A VALID RE-AUDIT. The prior AI output may simply
 *     be wrong, so nothing here compares classifier ruleset versions. The
 *     manual identity below is what keeps a same-ruleset rerun from colliding
 *     with the run it is replacing.
 *   * ERRORS NAME NOTHING. No reference, key, id, count, or thrown value ever
 *     appears in an error message, so a refusal is safe to return to a browser
 *     and safe to write to a log.
 */

/** Admin-only POST that queues an exact, bounded, paid re-audit. */
export const MANUAL_REAUDIT_ROUTE = '/api/v1/audits/re-audit'

/** Admin-only POST that restarts the bounded durable requested-queue drain. */
export const MANUAL_REAUDIT_RESUME_ROUTE =
  '/api/v1/audits/re-audit/resume'

/** The hard ceiling on one request, enforced before any statement runs. */
export const MAX_MANUAL_REAUDIT_CALLS = 100

/**
 * How many times one queued call may be claimed.
 *
 * A claim can cross the paid-provider boundary, so it is never reclaimed
 * automatically. An interrupted claim is settled as failed and an
 * administrator must explicitly select the call again.
 */
export const MAX_MANUAL_REAUDIT_ATTEMPTS = 1

/**
 * How long a claimed item may stay `processing` before it is marked as an
 * interrupted terminal failure. It is never reclaimed automatically.
 */
export const MANUAL_REAUDIT_CLAIM_TIMEOUT_MINUTES = 30

/** Longest accepted displayed reference. Matches the audit scope bound. */
const MAX_REFERENCE_LENGTH = 191

/** Bounded caller-supplied retry key: opaque, printable, and fixed-length. */
const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{16,80}$/

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/

/**
 * A refused request. Carries a bounded code and a status only — never the
 * submitted references, the retry key, an internal id, or a driver message.
 */
export class ManualReauditError extends Error {
  readonly code: string
  readonly status: number

  constructor(
    code = 'INVALID_REAUDIT_REQUEST',
    status = 400,
    message = 'Re-audit request is invalid',
  ) {
    super(message)
    this.code = code
    this.status = status
  }
}

/** Lifecycle of one administrator request. */
export const MANUAL_REAUDIT_REQUEST_STATUSES = [
  'queued',
  'running',
  'completed',
  'completed_with_failures',
] as const
export type ManualReauditRequestStatus =
  (typeof MANUAL_REAUDIT_REQUEST_STATUSES)[number]

/** Lifecycle of one selected call inside a request. */
export const MANUAL_REAUDIT_ITEM_STATUSES = [
  'queued',
  'processing',
  'completed',
  'skipped',
  'failed',
] as const
export type ManualReauditItemStatus =
  (typeof MANUAL_REAUDIT_ITEM_STATUSES)[number]

/**
 * The ONLY per-row re-audit lifecycle the monitor exposes.
 *
 * Deliberately not the item id, request id, baseline run, or attempt count.
 * Failed items may carry only the already-sanitized application error code.
 */
export type ManualReauditRowStatus =
  | 'queued'
  | 'processing'
  | 'completed'
  | 'failed'

export interface ManualReauditRowLifecycle {
  status: ManualReauditRowStatus
  completedAt: Date | string | null
  failureCode: string | null
}

export interface ManualReauditRequestInput {
  callReferences: string[]
  idempotencyKey: string
}

/**
 * What the endpoint returns. No internal call id appears here, and no count is
 * derived in the browser.
 *
 * `requestId` is the queue request's own handle — never a call, artifact, or
 * audit-run id — and is null when nothing new was queued.
 */
export interface ManualReauditReceipt {
  requestId: string | null
  outcome: 'accepted' | 'replayed' | 'already_queued'
  status: ManualReauditRequestStatus | null
  acceptedCount: number
  alreadyQueuedCount: number
}

export interface ManualReauditEnqueueInput {
  callReferences: readonly string[]
  idempotencyKey: string
  /** The authenticated administrator, never a value from the body. */
  requestedByUserId: string | null
  correlationId: string
  requestedAt: Date
}

export interface ManualReauditRequestPort {
  enqueue(input: ManualReauditEnqueueInput): Promise<ManualReauditReceipt>
}

/**
 * Validates the submitted body exactly.
 *
 * Every refusal is the same bounded error: a caller learns that the request was
 * invalid, never which reference or which rule rejected it.
 */
export function parseManualReauditRequest(
  value: unknown,
): ManualReauditRequestInput {
  const input =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {}
  if (!Array.isArray(input.callReferences)) {
    throw new ManualReauditError()
  }
  if (
    input.callReferences.length < 1 ||
    input.callReferences.length > MAX_MANUAL_REAUDIT_CALLS
  ) {
    throw new ManualReauditError()
  }
  const callReferences = input.callReferences.map((raw) => {
    if (typeof raw !== 'string' || CONTROL_CHARACTERS.test(raw)) {
      throw new ManualReauditError()
    }
    const reference = raw.trim()
    if (!reference || reference.length > MAX_REFERENCE_LENGTH) {
      throw new ManualReauditError()
    }
    return reference
  })
  if (new Set(callReferences).size !== callReferences.length) {
    throw new ManualReauditError()
  }
  if (
    typeof input.idempotencyKey !== 'string' ||
    !IDEMPOTENCY_KEY.test(input.idempotencyKey)
  ) {
    throw new ManualReauditError()
  }
  return { callReferences, idempotencyKey: input.idempotencyKey }
}

/**
 * Order-independent identity of one exact selection.
 *
 * A retry that re-sends the same calls in a different order is the same
 * request; a retry that quietly adds or drops one is not, and is refused as a
 * conflict rather than silently queued a second time.
 */
export function manualReauditDigest(
  callReferences: readonly string[],
): string {
  return createHash('sha256')
    .update(canonicalJson({ callReferences: [...callReferences].sort() }))
    .digest('hex')
}

/** `brr_` for a request row, `bri_` for one selected call inside it. */
export function manualReauditId(prefix: 'brr' | 'bri'): string {
  return `${prefix}_${randomUUID()}`
}

/**
 * Whether a claimed item may still be audited.
 *
 * The baseline was the call's current audit run when the administrator asked
 * for the re-audit. If the pointer has moved since — an automatic worker
 * finished it, a targeted re-audit landed, or a crashed attempt of this very
 * item actually committed — the question has already been answered and the
 * item is skipped WITHOUT calling a model.
 */
export function manualReauditBaselineDecision(input: {
  baselineAuditRunId: string
  latestAuditRunId: string | null
}): 'proceed' | 'skip_baseline_changed' {
  return input.latestAuditRunId === input.baselineAuditRunId
    ? 'proceed'
    : 'skip_baseline_changed'
}

/**
 * Outbox identity for a manual re-audit completion.
 *
 * The ordinary identity is the input manifest hash, which is IDENTICAL for two
 * runs of the same call under the same ruleset over the same evidence — the
 * exact case a manual re-audit exists to serve. Binding the item id in gives
 * every administrator-requested rerun its own message while keeping the
 * message itself replay-safe within that item.
 */
export function manualReauditOutboxMessageId(input: {
  itemId: string
  inputManifestSha256: string
}): string {
  return `audit-completed:manual:${input.itemId}:${input.inputManifestSha256}`
}

/**
 * The bounded code stored against a failed item.
 *
 * A processor may hand back any error code it likes; only a value matching this
 * shape is kept, and anything else becomes one fixed code. Provider prose, SQL,
 * URLs and thrown messages cannot reach the queue through this path.
 */
export function safeManualReauditErrorCode(value: unknown): string {
  return typeof value === 'string' && /^[A-Z][A-Z0-9_]{2,63}$/.test(value)
    ? value
    : 'REAUDIT_ITEM_FAILED'
}

/**
 * The latest lifecycle a monitor row reports.
 *
 * Skipped items are intentionally not displayed, but a newer skipped item still
 * suppresses older visible terminal state.
 */
export function manualReauditRowLifecycle(
  items: readonly {
    status: ManualReauditItemStatus
    createdAt: Date | string
    completedAt?: Date | string | null
    failureCode?: string | null
  }[],
): ManualReauditRowLifecycle | null {
  const latest = [...items].sort(
    (left, right) =>
      new Date(right.createdAt).getTime() -
        new Date(left.createdAt).getTime() ||
      String(right.createdAt).localeCompare(String(left.createdAt)),
  )[0]
  if (
    !latest ||
    !['queued', 'processing', 'completed', 'failed'].includes(latest.status)
  ) {
    return null
  }
  return {
    status: latest.status as ManualReauditRowStatus,
    completedAt:
      latest.status === 'completed' || latest.status === 'failed'
        ? latest.completedAt ?? null
        : null,
    failureCode:
      latest.status === 'failed'
        ? safeManualReauditErrorCode(latest.failureCode)
        : null,
  }
}
