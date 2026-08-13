/**
 * The Call Audit SPEND CLAIM contract: the permanent, default-deny gate that a
 * candidate must pass before any paid content-model call is made for it.
 *
 * Why this exists. A Call Audit result is identified by
 * (run_id, source_ref_id, rule_version_id), so replaying one run is already
 * safe — but a NEW run over an overlapping period mints a NEW result identity
 * for a source revision that an earlier run already audited, and would call the
 * model, and pay for it, a second time for identical evidence.
 *
 * What identifies "identical evidence". The claim is keyed by `sourceRefId`
 * alone. That id is derived deterministically from the exact immutable source
 * revision — (source_table, source_row_id, source_revision_sha256) — and from
 * nothing else, so:
 *
 *   * the same unchanged source row always maps to the same claim, across runs,
 *     periods, rule versions, and years; and
 *   * a CHANGED source row is different evidence, hashes to a different
 *     `sourceRefId`, and is therefore freely claimable and freely auditable.
 *
 * Default deny. A claim is taken BEFORE the model call and is never released,
 * expired, or deleted — a claim that released itself when a run failed would
 * re-open the very window it exists to close, because the failed run may
 * already have been billed by the provider. This module deliberately defines no
 * force, override, or re-audit outcome: a deliberate historical re-audit is an
 * administrator decision that needs its own approved and audited path, not a
 * flag on this contract.
 *
 * Privacy. Nothing in these shapes is content-bearing. Only hash-derived ids,
 * a caller-supplied timestamp, and closed machine codes cross this boundary —
 * never a transcript, prompt, provider response, lead ID, Task ID, source row
 * value, URL, or money figure.
 *
 * Billing boundary. This contract governs PERMISSION to call a model. It never
 * reads, derives, stores, or reports what a call cost; that is Billing Audit's
 * concern and stays separate.
 */

/**
 * Why a candidate was denied the model, as bounded uppercase machine codes.
 *
 * The grammar matches what `kaudit_call_audit_result.error_code` accepts, so a
 * code chosen here is always storable on the skipped result that keeps the run
 * truthfully accountable.
 */
export const CALL_AUDIT_SPEND_SKIP_CODES = {
  /**
   * An earlier run already produced a Call Audit result for this exact source
   * revision. Covers history written before claims existed, and any result
   * whose claim row was never taken.
   */
  priorResult: 'CALL_AUDIT_DUPLICATE_PRIOR_RESULT',
  /**
   * Another run holds the permanent claim for this exact source revision. This
   * is the outcome a LOSING concurrent run sees: the winner's claim was
   * committed first, so only the winner may call the model.
   */
  priorClaim: 'CALL_AUDIT_DUPLICATE_PRIOR_CLAIM',
} as const

export type CallAuditSpendSkipCode =
  (typeof CALL_AUDIT_SPEND_SKIP_CODES)[keyof typeof CALL_AUDIT_SPEND_SKIP_CODES]

/** Every skip code, for exhaustive checks and reporting allowlists. */
export const CALL_AUDIT_SPEND_SKIP_CODE_VALUES: readonly CallAuditSpendSkipCode[] =
  Object.freeze([
    CALL_AUDIT_SPEND_SKIP_CODES.priorResult,
    CALL_AUDIT_SPEND_SKIP_CODES.priorClaim,
  ])

export function isCallAuditSpendSkipCode(
  value: unknown,
): value is CallAuditSpendSkipCode {
  return (
    typeof value === 'string' &&
    (CALL_AUDIT_SPEND_SKIP_CODE_VALUES as readonly string[]).includes(value)
  )
}

/** What one run asks for when it wants permission to spend on one revision. */
export interface ContentAuditSpendClaimInput {
  /** The persisted source-reference id: the exact immutable revision. */
  sourceRefId: string
  /** The run asking. Recorded on the claim so spend stays accountable. */
  runId: string
  /** The contract that run is executing. Pinned with the run, compositely. */
  ruleVersionId: string
  /**
   * Caller-supplied UTC-naive instant, in the same form every other Call Audit
   * timestamp takes. No clock is read behind this port.
   */
  claimedAt: string
}

/**
 * The answer, and the only two shapes it may take.
 *
 * `claimed` is the ONLY outcome that permits a model call. Anything else — an
 * unrecognised shape, a rejected promise — must be treated as no permission,
 * because the default is deny.
 */
export type CallAuditSpendClaimResult =
  | { outcome: 'claimed' }
  | { outcome: 'duplicate'; skipCode: CallAuditSpendSkipCode }

/** The port the processor needs. Implemented by the MySQL persistence layer. */
export interface CallAuditSpendClaimPort {
  claimContentAuditSpend(
    input: ContentAuditSpendClaimInput,
  ): Promise<CallAuditSpendClaimResult>
}
