/**
 * How much of a month may settle at the vendor's own asserted amount.
 *
 * When an independent audit cannot be produced for a recording-backed call,
 * the standing Finance/Ops rule is to accept KServe's billed amount for it.
 * That rule is correct for a handful of calls and dangerous for a lot of them,
 * because it is the one direction in which THIS platform failing quietly
 * benefits the vendor: every transcription outage converts, silently, into
 * more of the bill being taken on the vendor's word.
 *
 * So the fallback is bounded rather than unconditional. Inside the bound it
 * settles automatically and no one has to think about it. Outside the bound it
 * refuses and says so, because a month where the audit failed at scale is a
 * month someone needs to look at before it is paid, not one to close faster.
 *
 * The bound is deliberately generous: it exists to catch a systemic failure,
 * not to second-guess ordinary attrition.
 */

export const DEFAULT_MAX_VENDOR_ASSERTED_SHARE = 0.02
/**
 * A small month must not trip the share alone. Twenty calls out of two hundred
 * is 10% and still just twenty calls; that is attrition, not an outage.
 */
export const DEFAULT_VENDOR_ASSERTED_FLOOR = 25

export interface VendorAssertedBoundInput {
  exhaustedCandidates: number
  recordingBackedCalls: number
  maxShare?: number
  floor?: number
}

export interface VendorAssertedBound {
  permitted: boolean
  exhaustedCandidates: number
  recordingBackedCalls: number
  /** Null when the month has no recording-backed calls to take a share of. */
  share: number | null
  allowance: number
  reason:
    | 'within_bound'
    | 'nothing_to_settle'
    | 'exceeds_bound'
    | 'population_unknown'
}

export function decideVendorAssertedBound(
  input: VendorAssertedBoundInput,
): VendorAssertedBound {
  const maxShare = input.maxShare ?? DEFAULT_MAX_VENDOR_ASSERTED_SHARE
  const floor = input.floor ?? DEFAULT_VENDOR_ASSERTED_FLOOR
  const { exhaustedCandidates, recordingBackedCalls } = input
  const share =
    recordingBackedCalls > 0
      ? exhaustedCandidates / recordingBackedCalls
      : null
  const allowance = Math.max(
    floor,
    Math.ceil(maxShare * Math.max(recordingBackedCalls, 0)),
  )
  if (exhaustedCandidates <= 0) {
    return {
      permitted: true,
      exhaustedCandidates,
      recordingBackedCalls,
      share,
      allowance,
      reason: 'nothing_to_settle',
    }
  }
  /**
   * A population that could not be counted is not a population of zero. With
   * no denominator the share is unknowable, so the floor is the only bound
   * that can honestly be applied, and beyond it the run refuses rather than
   * assuming the month is large.
   */
  if (recordingBackedCalls <= 0) {
    return {
      permitted: exhaustedCandidates <= floor,
      exhaustedCandidates,
      recordingBackedCalls,
      share,
      allowance: floor,
      reason:
        exhaustedCandidates <= floor ? 'within_bound' : 'population_unknown',
    }
  }
  return {
    permitted: exhaustedCandidates <= allowance,
    exhaustedCandidates,
    recordingBackedCalls,
    share,
    allowance,
    reason:
      exhaustedCandidates <= allowance ? 'within_bound' : 'exceeds_bound',
  }
}
