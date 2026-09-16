import type {
  LateRecordingRejectionCode,
  LateRecordingRowDecision,
} from './corrections.ts'

/**
 * Whether ONE uploaded row may attach a late recording, decided from facts
 * only.
 *
 * Pure on purpose. The adapter reads the database and hashes the artifact's
 * existing URL before it gets here, so this module never sees a URL at all and
 * the whole eligibility rule can be proven with synthetic fixtures instead of a
 * database.
 *
 * The order of the checks is the order of the refusals an administrator should
 * see. A row that fails several of them reports the FIRST one, so the message
 * names the thing to fix rather than a downstream consequence of it.
 */

/**
 * One call this platform resolved for an uploaded Task ID.
 *
 * Every field is a fact already established by the resolution query. Nothing
 * here is a URL: the artifact's existing `source_url`, when there is one, has
 * already been reduced to `existingUrlSha256`.
 */
export interface LateRecordingCallFacts {
  callId: string
  /** The final recording artifact, or null when the call has none. */
  artifactId: string | null
  /** SHA-256 of the artifact's existing canonical URL, or null when unset. */
  existingUrlSha256: string | null
  /** Whether the artifact already carries an evidence hash. */
  evidenceHashRecorded: boolean
  /** Whether an invoice covering this call's bill month has been received. */
  invoicePresent: boolean
  /** Whether a completed audit run already exists for this call. */
  auditCompleted: boolean
  /** The current final calculation captured before evidence is attached. */
  liveCalculationId: string | null
  /**
   * The basis of the call's CURRENT final calculation, or null when the call
   * is still unsettled. Only `no_recording_zero` may be corrected.
   */
  liveCalculationBasis: string | null
  /** Fixed-precision amount of that current calculation, or null if unsettled. */
  liveTotalAmount: string | null
}

export interface LateRecordingRowFacts {
  rowNumber: number
  taskId: string
  /** SHA-256 of the canonical URL the administrator submitted for this row. */
  canonicalUrlSha256: string
  /**
   * Every call the uploaded Task ID resolved to, within the selected month
   * only. Zero means not found; more than one means ambiguous.
   */
  matches: readonly LateRecordingCallFacts[]
}

export interface LateRecordingRowOutcome {
  decision: LateRecordingRowDecision
  /** The call to correct, present only when the row was accepted. */
  callId?: string
  artifactId?: string
  previousAmount?: string | null
  supersededCalculationId?: string | null
}

export function decideLateRecordingRow(input: {
  row: LateRecordingRowFacts
  /**
   * Whether a formally published rate card is available for the month. Money
   * cannot be written without one, so an upload that could never be priced is
   * refused before anything is written rather than after.
   */
  rateCardAvailable: boolean
}): LateRecordingRowOutcome {
  const { row } = input
  const reject = (
    code: LateRecordingRejectionCode,
  ): LateRecordingRowOutcome => ({
    decision: { rowNumber: row.rowNumber, outcome: 'rejected', code },
  })
  if (!input.rateCardAvailable) return reject('RATE_CARD_UNAVAILABLE')
  // Exactly one call, or nothing happens. Attaching evidence to a call the
  // administrator did not mean to name is the failure this check exists to
  // prevent, and a guess is never better than a refusal.
  const callIds = new Set(row.matches.map((match) => match.callId))
  if (callIds.size === 0) return reject('TASK_NOT_FOUND')
  if (callIds.size > 1) return reject('TASK_AMBIGUOUS')
  const call = row.matches[0] as LateRecordingCallFacts
  if (!call.invoicePresent) return reject('INVOICE_MISSING')
  if (call.auditCompleted) return reject('AUDIT_ALREADY_COMPLETED')
  /**
   * Unsettled, or settled as the current no-recording zero. Anything else is a
   * call whose money rests on evidence somebody else already established, and
   * this workflow does not reopen it.
   */
  if (
    call.liveCalculationBasis != null &&
    call.liveCalculationBasis !== 'no_recording_zero'
  ) {
    return reject('CALL_STATE_INELIGIBLE')
  }
  if (!call.artifactId) return reject('RECORDING_ARTIFACT_MISSING')
  if (call.existingUrlSha256 != null) {
    /**
     * The artifact already points somewhere.
     *
     * The same canonical URL is a replay -- a re-uploaded spreadsheet, a
     * retried request -- and is reported as such so a retry is safe. A
     * DIFFERENT one is a conflict: evidence is immutable once attached, and
     * this workflow refuses rather than overwrites.
     */
    return call.existingUrlSha256 === row.canonicalUrlSha256
      ? {
          decision: { rowNumber: row.rowNumber, outcome: 'duplicate_replay' },
        }
      : reject('RECORDING_URL_ALREADY_PRESENT')
  }
  if (call.evidenceHashRecorded) {
    // No URL but a recorded hash: something was fetched and hashed here once.
    // Whatever produced that state, this is no longer an empty artifact.
    return reject('RECORDING_URL_ALREADY_PRESENT')
  }
  return {
    decision: { rowNumber: row.rowNumber, outcome: 'accepted' },
    callId: call.callId,
    artifactId: call.artifactId,
    previousAmount: call.liveTotalAmount,
    supersededCalculationId: call.liveCalculationId,
  }
}

export interface LateRecordingPreview {
  decisions: LateRecordingRowDecision[]
  submittedCount: number
  acceptedCount: number
  duplicateCount: number
  rejectedCount: number
  /** Counts per bounded rejection code, for a compact administrator summary. */
  rejectionCounts: Record<string, number>
}

/** Rolls per-row decisions up into the summary a preview and a commit return. */
export function summarizeLateRecordingDecisions(
  decisions: readonly LateRecordingRowDecision[],
  submittedCount: number,
): LateRecordingPreview {
  const rejectionCounts: Record<string, number> = {}
  let acceptedCount = 0
  let duplicateCount = 0
  let rejectedCount = 0
  for (const decision of decisions) {
    if (decision.outcome === 'accepted') acceptedCount += 1
    else if (decision.outcome === 'duplicate_replay') duplicateCount += 1
    else {
      rejectedCount += 1
      rejectionCounts[decision.code] =
        (rejectionCounts[decision.code] ?? 0) + 1
    }
  }
  return {
    decisions: [...decisions].sort(
      (left, right) => left.rowNumber - right.rowNumber,
    ),
    submittedCount,
    acceptedCount,
    duplicateCount,
    rejectedCount,
    rejectionCounts,
  }
}

/**
 * What one attached recording's money outcome is, from persisted audit state.
 *
 * Deterministic, total, and pure. The three answers are the three things that
 * can actually have happened to an attached recording: it was audited, the
 * audit is finished trying, or it is still in flight and this run leaves it
 * alone. Nothing here calls a model, and money is decided from the answer, not
 * from a worker's memory of what it just did.
 */
export function decideLateRecordingOutcome(facts: {
  /** The audit produced a completed, classified result for this call. */
  auditCompleted: boolean
  /** The audit is finished trying and will never be claimed again. */
  auditExhausted: boolean
}): 'audited_projection' | 'accepted_as_billed_unverified' | 'in_flight' {
  if (facts.auditCompleted) return 'audited_projection'
  if (facts.auditExhausted) return 'accepted_as_billed_unverified'
  return 'in_flight'
}
