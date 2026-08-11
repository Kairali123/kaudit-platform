/**
 * The authoritative KServe outcome taxonomy: 53 vendor labels with their locked
 * descriptions and management grouping.
 *
 * Labels are BYTE-EXACT vendor values. Casing, spaces, underscores, and vendor
 * spelling are reproduced verbatim — including `Furthur` and the spaces around
 * the colon in the do-not-call label — because a report column is only
 * comparable with KServe's own if the text matches theirs exactly.
 *
 * There are deliberately NO aliases for superseded labels. An old value must
 * fail membership, model-output validation, and KServe comparison rather than
 * be quietly repaired into a current one.
 *
 * Descriptions are locked taxonomy DATA. They steer the model through the
 * compiled prompt, but they are never accepted as an output value and are never
 * a comparison alias.
 */

/** Stable management group codes. Reports roll detailed outcomes up to these. */
export const OUTCOME_GROUPS = [
  'PRODUCTS_COMMERCE',
  'RESORT_HEALING',
  'CONSULTATION_TREATMENT',
  'TRAINING',
  'PARTNERSHIP_B2B',
  'FOLLOW_UP_ACTION',
  'NOT_CONNECTED',
  'NOT_INTERESTED_NO_ENQUIRY',
  'EXISTING_DUPLICATE_DNC',
  'TECHNICAL_LANGUAGE',
  'EMPLOYMENT_MISC',
  'OTHER',
] as const

export type OutcomeGroup = (typeof OUTCOME_GROUPS)[number]

/**
 * The single source of truth. Labels, descriptions, and grouping live together
 * so they cannot drift into independently maintained lists.
 */
export const DETAILED_OUTCOME_DEFINITIONS = [
  {
    label: 'Product Distributor',
    description: 'Interested in becoming an authorized product distributor.',
    group: 'PARTNERSHIP_B2B',
  },
  {
    label: 'Product Stockists',
    description:
      'Interested in stocking Kairali products for wholesale/resale.',
    group: 'PARTNERSHIP_B2B',
  },
  {
    label: 'Individual Products Buying',
    description: 'Customer wants to purchase products for personal use.',
    group: 'PRODUCTS_COMMERCE',
  },
  {
    label: 'Order Status Enquiry',
    description: 'Customer is checking the status of an existing order.',
    group: 'PRODUCTS_COMMERCE',
  },
  {
    label: 'Individual Resort Booking',
    description:
      'Enquiry for booking a resort stay for an individual/family.',
    group: 'RESORT_HEALING',
  },
  {
    label: 'Group Resort Booking',
    description: 'Enquiry for group, corporate, or family resort bookings.',
    group: 'RESORT_HEALING',
  },
  {
    label: 'Treatment Package for Resort',
    description: 'Interested in wellness/treatment packages at the resort.',
    group: 'RESORT_HEALING',
  },
  {
    label: 'Single Therapy for Individual',
    description:
      'Interested in a single therapy/session instead of a package.',
    group: 'CONSULTATION_TREATMENT',
  },
  {
    label: 'Treatment Package for Kairali Centres',
    description:
      'Interested in treatment packages at Kairali wellness centres.',
    group: 'CONSULTATION_TREATMENT',
  },
  {
    label: 'Franchise',
    description: 'Enquiry about opening or owning a Kairali franchise.',
    group: 'PARTNERSHIP_B2B',
  },
  {
    label: 'Jobs Enquiry',
    description: 'Job or career-related enquiry.',
    group: 'EMPLOYMENT_MISC',
  },
  {
    label: 'Sanitizers Enquiry',
    description: 'Enquiry about sanitizer products.',
    group: 'PRODUCTS_COMMERCE',
  },
  {
    label: 'Ayurveda Training',
    description: 'Interested in Ayurveda training courses.',
    group: 'TRAINING',
  },
  {
    label: 'Yoga Training',
    description: 'Interested in Yoga training courses.',
    group: 'TRAINING',
  },
  {
    label: 'Ayurveda and Yoga Training',
    description: 'Interested in both Ayurveda and Yoga training.',
    group: 'TRAINING',
  },
  {
    label: 'Other/Misc Enquiry',
    description: "Enquiry doesn't fit any predefined category.",
    group: 'EMPLOYMENT_MISC',
  },
  {
    label: 'Did not Enquire',
    description: 'Caller contacted but did not ask for any information.',
    group: 'NOT_INTERESTED_NO_ENQUIRY',
  },
  {
    label: 'Not Connected',
    description: 'Call could not be connected.',
    group: 'NOT_CONNECTED',
  },
  {
    label: 'Junk',
    description: 'Spam, fake, or irrelevant lead.',
    group: 'OTHER',
  },
  {
    label: 'Other Cases',
    description: "Special case that doesn't match existing dispositions.",
    group: 'OTHER',
  },
  {
    label: 'Not Interested',
    description: 'Customer is not interested in the offering.',
    group: 'NOT_INTERESTED_NO_ENQUIRY',
  },
  {
    label: 'Contract Manufacturing',
    description:
      'Interested in third-party or contract manufacturing services.',
    group: 'PARTNERSHIP_B2B',
  },
  {
    label: 'Not Reachable',
    description: 'Customer could not be reached after attempts.',
    group: 'NOT_CONNECTED',
  },
  {
    label: 'Cold',
    description: 'Customer has low interest and no immediate requirement.',
    group: 'NOT_INTERESTED_NO_ENQUIRY',
  },
  {
    label: 'Language Issue',
    description:
      'Communication could not continue due to language barrier.',
    group: 'TECHNICAL_LANGUAGE',
  },
  {
    label: 'Reverify',
    description: 'Information needs verification before proceeding.',
    group: 'FOLLOW_UP_ACTION',
  },
  {
    label: 'Expert Required',
    description:
      'Customer requires assistance from a domain expert/specialist.',
    group: 'FOLLOW_UP_ACTION',
  },
  {
    label: 'Already Spoken',
    description:
      'Customer has already been contacted regarding this enquiry.',
    group: 'EXISTING_DUPLICATE_DNC',
  },
  {
    label: 'Prevention_Rejuvenation',
    description:
      'Interested in preventive health or rejuvenation programs.',
    group: 'CONSULTATION_TREATMENT',
  },
  {
    label: 'Doctor Consultation Required',
    description: 'Customer needs consultation with an Ayurvedic doctor.',
    group: 'CONSULTATION_TREATMENT',
  },
  {
    label: 'Duplicate Lead',
    description: 'Lead already exists in the CRM.',
    group: 'EXISTING_DUPLICATE_DNC',
  },
  {
    label: 'Ayurvedic Doctor_Panchakarma Center',
    description:
      'Enquiry for Ayurvedic doctor consultation or Panchakarma centre.',
    group: 'CONSULTATION_TREATMENT',
  },
  {
    label: 'Group Resort Booking_yoga retreat',
    description: 'Enquiry for group Yoga Retreat booking at the resort.',
    group: 'RESORT_HEALING',
  },
  {
    label: 'Prevention_rejuvenation',
    description: 'Interested in prevention or rejuvenation therapies.',
    group: 'CONSULTATION_TREATMENT',
  },
  {
    label: 'Pharmacy_retail',
    description: 'Retail pharmacy-related enquiry.',
    group: 'PRODUCTS_COMMERCE',
  },
  {
    label: 'Online Sales',
    description:
      'Interested in purchasing products through online channels.',
    group: 'PRODUCTS_COMMERCE',
  },
  {
    label: 'Export_Import',
    description: 'Enquiry regarding export or import of products.',
    group: 'PARTNERSHIP_B2B',
  },
  {
    label: 'Treatment package for resort AHV',
    description: 'Treatment package enquiry for AHV resort.',
    group: 'RESORT_HEALING',
  },
  {
    label: 'Prevention_rejuvenation AHV',
    description: 'Prevention/Rejuvenation program enquiry for AHV.',
    group: 'CONSULTATION_TREATMENT',
  },
  {
    label: 'Group resort booking AHV yoga retreat',
    description: 'Group Yoga Retreat booking enquiry for AHV.',
    group: 'RESORT_HEALING',
  },
  {
    label: 'Ayurvedic Training AHV',
    description: 'Ayurveda training enquiry under AHV.',
    group: 'TRAINING',
  },
  {
    label: 'Yoga training AHV',
    description: 'Yoga training enquiry under AHV.',
    group: 'TRAINING',
  },
  {
    label: 'Not interested AHV',
    description: 'Customer not interested in AHV offerings.',
    group: 'NOT_INTERESTED_NO_ENQUIRY',
  },
  {
    label: 'Outreach Stopped',
    description: 'No further follow-up should be made.',
    group: 'EXISTING_DUPLICATE_DNC',
  },
  {
    label: 'No Answer',
    description: 'Call rang but was not answered.',
    group: 'NOT_CONNECTED',
  },
  {
    label: 'Busy',
    description: 'Customer was busy during the call.',
    group: 'NOT_CONNECTED',
  },
  {
    label: 'Technical Error',
    description: 'Call failed due to a technical issue.',
    group: 'TECHNICAL_LANGUAGE',
  },
  {
    label: 'Callback Required',
    description: 'Customer requested a callback at a later time.',
    group: 'FOLLOW_UP_ACTION',
  },
  {
    label: 'Assign To MR',
    description:
      'Assign the lead to the Medical Representative (MR) for follow-up.',
    group: 'FOLLOW_UP_ACTION',
  },
  {
    label: 'Travel Agent',
    description: 'Enquiry from or regarding a travel agent/partner.',
    group: 'PARTNERSHIP_B2B',
  },
  {
    label: 'Panchkarma Training',
    description: 'Interested in Panchakarma training program.',
    group: 'TRAINING',
  },
  {
    label: 'Wants details over Email',
    description:
      'Customer requested information via email instead of a call.',
    group: 'FOLLOW_UP_ACTION',
  },
  {
    label: "DNC Client : Don't Call Furthur",
    description:
      'Customer requested not to receive any further calls (Do Not Call).',
    group: 'EXISTING_DUPLICATE_DNC',
  },
] as const satisfies readonly {
  label: string
  description: string
  group: OutcomeGroup
}[]

export type DetailedOutcomeDefinition =
  (typeof DETAILED_OUTCOME_DEFINITIONS)[number]

export type DetailedOutcome = DetailedOutcomeDefinition['label']

/** The 53 approved labels, in authoritative vendor order. */
export const DETAILED_OUTCOMES: readonly DetailedOutcome[] =
  DETAILED_OUTCOME_DEFINITIONS.map((definition) => definition.label)

/**
 * The single source of truth for grouping, derived from the definitions above,
 * so it is total by construction: a new outcome cannot be added without a group.
 */
export const DETAILED_OUTCOME_GROUP: Record<DetailedOutcome, OutcomeGroup> =
  Object.fromEntries(
    DETAILED_OUTCOME_DEFINITIONS.map((definition) => [
      definition.label,
      definition.group,
    ]),
  ) as Record<DetailedOutcome, OutcomeGroup>

const DESCRIPTION_BY_LABEL: Record<DetailedOutcome, string> =
  Object.fromEntries(
    DETAILED_OUTCOME_DEFINITIONS.map((definition) => [
      definition.label,
      definition.description,
    ]),
  ) as Record<DetailedOutcome, string>

/**
 * Compliance-sensitive no-contact outcomes. A disagreement involving either of
 * these is escalated regardless of grouping, because continuing to call someone
 * who asked you to stop is a regulatory problem, not a classification nuance.
 */
export const NO_CONTACT_OUTCOMES = [
  'Outreach Stopped',
  "DNC Client : Don't Call Furthur",
] as const satisfies readonly DetailedOutcome[]

export type NoContactOutcome = (typeof NO_CONTACT_OUTCOMES)[number]

export class UnknownDetailedOutcomeError extends Error {
  readonly code = 'UNKNOWN_DETAILED_OUTCOME'
}

export function isDetailedOutcome(value: unknown): value is DetailedOutcome {
  return (
    typeof value === 'string' &&
    (DETAILED_OUTCOMES as readonly string[]).includes(value)
  )
}

export function isOutcomeGroup(value: unknown): value is OutcomeGroup {
  return (
    typeof value === 'string' &&
    (OUTCOME_GROUPS as readonly string[]).includes(value)
  )
}

export function isNoContactOutcome(value: unknown): value is NoContactOutcome {
  return (
    typeof value === 'string' &&
    (NO_CONTACT_OUTCOMES as readonly string[]).includes(value)
  )
}

/**
 * Derives the management group for a detailed outcome. Deterministic and total:
 * every approved outcome has exactly one group.
 */
export function groupForDetailedOutcome(
  outcome: DetailedOutcome,
): OutcomeGroup {
  return DETAILED_OUTCOME_GROUP[outcome]
}

/**
 * The locked description for an approved label, for the prompt compiler and the
 * activation config. An unapproved label is REJECTED, never normalized: a
 * near-miss is a different label, not a typo to repair.
 */
export function describeDetailedOutcome(outcome: DetailedOutcome): string {
  if (!isDetailedOutcome(outcome)) {
    throw new UnknownDetailedOutcomeError(
      'outcome is not an approved KServe label',
    )
  }
  return DESCRIPTION_BY_LABEL[outcome]
}
