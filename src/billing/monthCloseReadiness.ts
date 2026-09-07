/**
 * Whether a month's data is complete enough to settle automatically.
 *
 * The standing close originally waited only for the month to END, on the
 * reasoning that "once the month is closed there is nothing further to wait
 * for". That is false here. A month's calls are uploaded well after the month
 * itself finishes -- sometimes a month or more later -- and the audit runs
 * later still. So an ended month can be empty, half-loaded, or loaded but
 * entirely unaudited, and all three look identical to a calendar.
 *
 * That gap is dangerous in one specific direction. A call with no recording
 * settles at INR 0.00, correctly, because the vendor supplied no evidence to
 * support a charge. But a call whose recording simply HAS NOT ARRIVED YET is
 * indistinguishable from one at the moment it is read -- so an automatic close
 * over a freshly-uploaded month would settle the whole month at zero and mark
 * it done. Silently paying nothing is not a safe failure.
 *
 * So automation waits for evidence that the month is actually finished, rather
 * than for the calendar to say it ought to be:
 *
 *   * it has calls at all -- an empty month is not "closed at zero", it is
 *     "not loaded yet";
 *   * nothing has been ingested into it recently, so an upload in progress is
 *     not mistaken for an upload that never happened; and
 *   * no recording-backed call is still waiting to be audited, because that is
 *     what "the audit is done" actually means.
 *
 * None of this restricts an operator naming a month deliberately. It restricts
 * the unattended job, which is the one that cannot look at what it is doing.
 */

/** How long a month must go without new calls before it counts as loaded. */
export const DEFAULT_INGEST_QUIET_PERIOD_MS = 48 * 60 * 60 * 1000

export interface MonthCloseReadinessInput {
  totalCalls: number
  /**
   * Recording-backed calls with no completed audit that are also not
   * terminally exhausted. An exhausted call is finished with the audit -- it
   * settles on the vendor's figure -- so it is not something to wait for.
   */
  recordingBackedAwaitingAudit: number
  /** Milliseconds since the newest call was ingested; null when none exist. */
  millisecondsSinceNewestCall: number | null
  quietPeriodMs?: number
}

export type MonthCloseBlockReason =
  | 'no_calls_loaded'
  | 'ingest_in_progress'
  | 'audit_incomplete'

export interface MonthCloseReadiness {
  ready: boolean
  reason: 'ready' | MonthCloseBlockReason
  totalCalls: number
  recordingBackedAwaitingAudit: number
  millisecondsSinceNewestCall: number | null
  quietPeriodMs: number
}

export function decideMonthCloseReadiness(
  input: MonthCloseReadinessInput,
): MonthCloseReadiness {
  const quietPeriodMs = input.quietPeriodMs ?? DEFAULT_INGEST_QUIET_PERIOD_MS
  const base = {
    totalCalls: input.totalCalls,
    recordingBackedAwaitingAudit: input.recordingBackedAwaitingAudit,
    millisecondsSinceNewestCall: input.millisecondsSinceNewestCall,
    quietPeriodMs,
  }
  if (input.totalCalls <= 0) {
    return { ...base, ready: false, reason: 'no_calls_loaded' }
  }
  /**
   * An unknown ingest age is treated as "still arriving", not as "long ago".
   * The whole point of this check is to be wrong in the direction that waits.
   */
  if (
    input.millisecondsSinceNewestCall == null ||
    input.millisecondsSinceNewestCall < quietPeriodMs
  ) {
    return { ...base, ready: false, reason: 'ingest_in_progress' }
  }
  if (input.recordingBackedAwaitingAudit > 0) {
    return { ...base, ready: false, reason: 'audit_incomplete' }
  }
  return { ...base, ready: true, reason: 'ready' }
}
