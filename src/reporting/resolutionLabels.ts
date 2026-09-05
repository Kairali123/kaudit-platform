/**
 * How each billing basis reads to a person outside this codebase.
 *
 * These strings go in front of the vendor. A basis name is precise but it is
 * internal vocabulary, and "accepted_as_billed_unverified" in a meeting invites
 * exactly the wrong reading — that something was verified and accepted. Each
 * label therefore says what was actually done AND what was not, because the
 * difference between "we measured this" and "we could not, so we took your
 * number" is the whole substance of the conversation.
 *
 * An unrecognised basis is never guessed at. It is passed through as itself, so
 * a future basis shows up as an unfamiliar word rather than being silently
 * folded into a category it does not belong to.
 */

export interface ResolutionLabel {
  /** Short label for a table cell. */
  label: string
  /** One sentence a vendor can be shown without further explanation. */
  explanation: string
  /**
   * Whether this platform independently established the billable duration.
   * `false` means the vendor's own figure was accepted for want of evidence.
   */
  independentlyMeasured: boolean
}

const LABELS: Record<string, ResolutionLabel> = {
  independent_conversation_end: {
    label: 'Audited — consensus verified',
    explanation:
      'Recording transcribed and classified, conversation end independently established and cross-checked by a second review.',
    independentlyMeasured: true,
  },
  independent_category_service_end: {
    label: 'Audited — category service end',
    explanation:
      'Recording transcribed and classified, chargeable duration measured to the approved service endpoint for the call category.',
    independentlyMeasured: true,
  },
  independent_audited_projection: {
    label: 'Audited — single-pass',
    explanation:
      'Recording transcribed and classified, duration measured and priced under the locked rate rules and capped at the vendor charge. Classification was single-pass; no second-opinion review was run.',
    independentlyMeasured: true,
  },
  accepted_as_billed_unverified: {
    label: 'Vendor figure accepted — not verified',
    explanation:
      'The audit could not establish a chargeable duration for this call, so the vendor amount was accepted as billed. No independent measurement supports it.',
    independentlyMeasured: false,
  },
  no_recording_zero: {
    label: 'No recording supplied — no evidence',
    explanation:
      'The vendor supplied no recording for this call, so it cannot be listened to, transcribed or verified by any means, and no evidence supports a charge.',
    independentlyMeasured: false,
  },
}

export function resolutionLabel(basis: string): ResolutionLabel {
  return (
    LABELS[basis] ?? {
      label: basis,
      explanation:
        'Unrecognised billing basis; shown as recorded rather than grouped.',
      independentlyMeasured: false,
    }
  )
}

export function knownResolutionBases(): string[] {
  return Object.keys(LABELS)
}
