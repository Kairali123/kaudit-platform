import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  describeDetailedOutcome,
  DETAILED_OUTCOMES,
  DETAILED_OUTCOME_DEFINITIONS,
  DETAILED_OUTCOME_GROUP,
  groupForDetailedOutcome,
  isDetailedOutcome,
  isNoContactOutcome,
  isOutcomeGroup,
  NO_CONTACT_OUTCOMES,
  OUTCOME_GROUPS,
  UnknownDetailedOutcomeError,
  type DetailedOutcome,
} from './outcomes.ts'

/**
 * The authoritative KServe taxonomy, pinned verbatim in vendor order. These are
 * byte-exact vendor values: the odd casing, the underscores, the spaces around
 * the DNC colon, and the vendor spelling `Furthur` are all intentional.
 */
const AUTHORITATIVE: Array<[string, string]> = [
  ['Product Distributor', 'Interested in becoming an authorized product distributor.'],
  ['Product Stockists', 'Interested in stocking Kairali products for wholesale/resale.'],
  ['Individual Products Buying', 'Customer wants to purchase products for personal use.'],
  ['Order Status Enquiry', 'Customer is checking the status of an existing order.'],
  ['Individual Resort Booking', 'Enquiry for booking a resort stay for an individual/family.'],
  ['Group Resort Booking', 'Enquiry for group, corporate, or family resort bookings.'],
  ['Treatment Package for Resort', 'Interested in wellness/treatment packages at the resort.'],
  ['Single Therapy for Individual', 'Interested in a single therapy/session instead of a package.'],
  ['Treatment Package for Kairali Centres', 'Interested in treatment packages at Kairali wellness centres.'],
  ['Franchise', 'Enquiry about opening or owning a Kairali franchise.'],
  ['Jobs Enquiry', 'Job or career-related enquiry.'],
  ['Sanitizers Enquiry', 'Enquiry about sanitizer products.'],
  ['Ayurveda Training', 'Interested in Ayurveda training courses.'],
  ['Yoga Training', 'Interested in Yoga training courses.'],
  ['Ayurveda and Yoga Training', 'Interested in both Ayurveda and Yoga training.'],
  ['Other/Misc Enquiry', "Enquiry doesn't fit any predefined category."],
  ['Did not Enquire', 'Caller contacted but did not ask for any information.'],
  ['Not Connected', 'Call could not be connected.'],
  ['Junk', 'Spam, fake, or irrelevant lead.'],
  ['Other Cases', "Special case that doesn't match existing dispositions."],
  ['Not Interested', 'Customer is not interested in the offering.'],
  ['Contract Manufacturing', 'Interested in third-party or contract manufacturing services.'],
  ['Not Reachable', 'Customer could not be reached after attempts.'],
  ['Cold', 'Customer has low interest and no immediate requirement.'],
  ['Language Issue', 'Communication could not continue due to language barrier.'],
  ['Reverify', 'Information needs verification before proceeding.'],
  ['Expert Required', 'Customer requires assistance from a domain expert/specialist.'],
  ['Already Spoken', 'Customer has already been contacted regarding this enquiry.'],
  ['Prevention_Rejuvenation', 'Interested in preventive health or rejuvenation programs.'],
  ['Doctor Consultation Required', 'Customer needs consultation with an Ayurvedic doctor.'],
  ['Duplicate Lead', 'Lead already exists in the CRM.'],
  ['Ayurvedic Doctor_Panchakarma Center', 'Enquiry for Ayurvedic doctor consultation or Panchakarma centre.'],
  ['Group Resort Booking_yoga retreat', 'Enquiry for group Yoga Retreat booking at the resort.'],
  ['Prevention_rejuvenation', 'Interested in prevention or rejuvenation therapies.'],
  ['Pharmacy_retail', 'Retail pharmacy-related enquiry.'],
  ['Online Sales', 'Interested in purchasing products through online channels.'],
  ['Export_Import', 'Enquiry regarding export or import of products.'],
  ['Treatment package for resort AHV', 'Treatment package enquiry for AHV resort.'],
  ['Prevention_rejuvenation AHV', 'Prevention/Rejuvenation program enquiry for AHV.'],
  ['Group resort booking AHV yoga retreat', 'Group Yoga Retreat booking enquiry for AHV.'],
  ['Ayurvedic Training AHV', 'Ayurveda training enquiry under AHV.'],
  ['Yoga training AHV', 'Yoga training enquiry under AHV.'],
  ['Not interested AHV', 'Customer not interested in AHV offerings.'],
  ['Outreach Stopped', 'No further follow-up should be made.'],
  ['No Answer', 'Call rang but was not answered.'],
  ['Busy', 'Customer was busy during the call.'],
  ['Technical Error', 'Call failed due to a technical issue.'],
  ['Callback Required', 'Customer requested a callback at a later time.'],
  ['Assign To MR', 'Assign the lead to the Medical Representative (MR) for follow-up.'],
  ['Travel Agent', 'Enquiry from or regarding a travel agent/partner.'],
  ['Panchkarma Training', 'Interested in Panchakarma training program.'],
  ['Wants details over Email', 'Customer requested information via email instead of a call.'],
  ["DNC Client : Don't Call Furthur", 'Customer requested not to receive any further calls (Do Not Call).'],
]

/** Labels from the superseded FYI list. None may be accepted or aliased. */
const SUPERSEDED_LABELS = [
  'Treatment Package for Resort AHV',
  'Yoga Training AHV',
  'Not Interested AHV',
  'Assign to MR',
  'Wants Details Over Email',
  "DNC Client: Don't Call Further",
  "DNC Client : Don't Call Further",
  "DNC Client: Don't Call Furthur",
  'Expert Required - KTAHV',
  'Expert Required - Products',
  'Already Spoken - AHV',
  'Already Spoken - KAPPL',
  'Already Spoken - KTAHV',
  'Doctor Consultation Required AHV',
  'Doctor Consultation Required KTAHV',
  'Treatment Package for Resort - KTAHV',
  'Interested-Wants Details on Email',
]

test('pins all 53 authoritative labels in exact vendor order', () => {
  assert.equal(DETAILED_OUTCOMES.length, 53)
  assert.deepEqual(
    [...DETAILED_OUTCOMES],
    AUTHORITATIVE.map(([label]) => label),
  )
})

test('pins all 53 exact descriptions against their labels', () => {
  assert.equal(DETAILED_OUTCOME_DEFINITIONS.length, 53)
  DETAILED_OUTCOME_DEFINITIONS.forEach((definition, index) => {
    const [label, description] = AUTHORITATIVE[index]
    assert.equal(definition.label, label, `label ${index + 1}`)
    assert.equal(definition.description, description, `description for ${label}`)
    assert.equal(describeDetailedOutcome(definition.label), description)
  })
})

test('labels are unique and descriptions are nonblank', () => {
  assert.equal(new Set(DETAILED_OUTCOMES).size, 53)
  for (const definition of DETAILED_OUTCOME_DEFINITIONS) {
    assert.ok(definition.description.trim().length > 0, definition.label)
    assert.equal(definition.description, definition.description.trim())
  }
})

test('the vendor spelling and spacing of the DNC label are exact', () => {
  const dnc = DETAILED_OUTCOMES.filter((label) => label.startsWith('DNC'))
  assert.deepEqual([...dnc], ["DNC Client : Don't Call Furthur"])
  // Vendor spelling, not the dictionary one.
  assert.ok(dnc[0].includes('Furthur'))
  assert.equal(dnc[0].includes('Further'), false)
  // Spaces on BOTH sides of the colon.
  assert.ok(dnc[0].includes(' : '))
  assert.equal(dnc[0].includes('Client:'), false)
})

test('the two Prevention labels are distinct and both valid', () => {
  assert.ok(isDetailedOutcome('Prevention_Rejuvenation'))
  assert.ok(isDetailedOutcome('Prevention_rejuvenation'))
  assert.notEqual('Prevention_Rejuvenation', 'Prevention_rejuvenation')
  assert.notEqual(
    describeDetailedOutcome('Prevention_Rejuvenation'),
    describeDetailedOutcome('Prevention_rejuvenation'),
  )
  // Same group, but they remain two separate taxonomy entries.
  assert.equal(
    groupForDetailedOutcome('Prevention_Rejuvenation'),
    'CONSULTATION_TREATMENT',
  )
  assert.equal(
    groupForDetailedOutcome('Prevention_rejuvenation'),
    'CONSULTATION_TREATMENT',
  )
})

test('preserves the exact casing of tricky vendor labels', () => {
  for (const label of [
    'Treatment package for resort AHV',
    'Yoga training AHV',
    'Not interested AHV',
    'Assign To MR',
    'Wants details over Email',
    'Ayurvedic Training AHV',
    'Group resort booking AHV yoga retreat',
    'Group Resort Booking_yoga retreat',
    'Ayurvedic Doctor_Panchakarma Center',
    'Pharmacy_retail',
    'Export_Import',
    'Panchkarma Training',
    'Other/Misc Enquiry',
    'Did not Enquire',
    'Outreach Stopped',
    'Already Spoken',
  ]) {
    assert.ok(
      (DETAILED_OUTCOMES as readonly string[]).includes(label),
      `${label} is missing or altered`,
    )
  }
})

test('every superseded label is rejected and never aliased', () => {
  for (const label of SUPERSEDED_LABELS) {
    assert.equal(
      isDetailedOutcome(label),
      false,
      `${label} must no longer be accepted`,
    )
    assert.equal(
      (DETAILED_OUTCOMES as readonly string[]).includes(label),
      false,
    )
  }
})

test('near-miss spellings and normalizations are rejected', () => {
  for (const notApproved of [
    'Panchakarma Training',
    'Other / Misc Enquiry',
    'Pharmacy_Retail',
    'not connected',
    'NOT_CONNECTED',
    'assign to mr',
    ' Assign To MR',
    'Assign To MR ',
    'Prevention_REJUVENATION',
    'Wants Details over Email',
  ]) {
    assert.equal(
      isDetailedOutcome(notApproved),
      false,
      `${notApproved} must not be accepted`,
    )
  }
})

test('recognizes approved labels and rejects everything else', () => {
  for (const label of DETAILED_OUTCOMES) {
    assert.ok(isDetailedOutcome(label))
  }
  for (const value of ['', '  ', 'Unknown', null, undefined, 42, {}, []]) {
    assert.equal(isDetailedOutcome(value), false)
  }
})

test('the description lookup rejects unknown labels rather than normalizing', () => {
  for (const label of [
    ...SUPERSEDED_LABELS,
    'Unknown Outcome',
    ' Assign To MR',
    '',
  ]) {
    assert.throws(
      () => describeDetailedOutcome(label as DetailedOutcome),
      UnknownDetailedOutcomeError,
      `${label} must be rejected`,
    )
  }
})

// ---------------------------------------------------------------------------
// Grouping
// ---------------------------------------------------------------------------

test('exposes exactly the twelve approved group codes', () => {
  assert.deepEqual(
    [...OUTCOME_GROUPS],
    [
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
    ],
  )
  assert.equal(new Set(OUTCOME_GROUPS).size, 12)
})

test('the group mapping is total over exactly the 53 outcomes', () => {
  const mapped = Object.keys(DETAILED_OUTCOME_GROUP)
  assert.equal(mapped.length, 53)
  assert.deepEqual(mapped.sort(), [...DETAILED_OUTCOMES].sort())
  for (const outcome of DETAILED_OUTCOMES) {
    assert.ok(
      isOutcomeGroup(groupForDetailedOutcome(outcome)),
      `${outcome} has an unapproved group`,
    )
  }
})

test('every group code is used by at least one outcome', () => {
  const used = new Set(Object.values(DETAILED_OUTCOME_GROUP))
  for (const group of OUTCOME_GROUPS) {
    assert.ok(used.has(group), `${group} is never used`)
  }
})

test('assigns every outcome to its approved group', () => {
  const expected: Record<string, DetailedOutcome[]> = {
    PRODUCTS_COMMERCE: [
      'Individual Products Buying',
      'Order Status Enquiry',
      'Sanitizers Enquiry',
      'Pharmacy_retail',
      'Online Sales',
    ],
    RESORT_HEALING: [
      'Individual Resort Booking',
      'Group Resort Booking',
      'Treatment Package for Resort',
      'Group Resort Booking_yoga retreat',
      'Treatment package for resort AHV',
      'Group resort booking AHV yoga retreat',
    ],
    CONSULTATION_TREATMENT: [
      'Single Therapy for Individual',
      'Treatment Package for Kairali Centres',
      'Prevention_Rejuvenation',
      'Doctor Consultation Required',
      'Ayurvedic Doctor_Panchakarma Center',
      'Prevention_rejuvenation',
      'Prevention_rejuvenation AHV',
    ],
    TRAINING: [
      'Ayurveda Training',
      'Yoga Training',
      'Ayurveda and Yoga Training',
      'Ayurvedic Training AHV',
      'Yoga training AHV',
      'Panchkarma Training',
    ],
    PARTNERSHIP_B2B: [
      'Product Distributor',
      'Product Stockists',
      'Franchise',
      'Contract Manufacturing',
      'Export_Import',
      'Travel Agent',
    ],
    FOLLOW_UP_ACTION: [
      'Reverify',
      'Expert Required',
      'Callback Required',
      'Assign To MR',
      'Wants details over Email',
    ],
    NOT_CONNECTED: ['Not Connected', 'Not Reachable', 'No Answer', 'Busy'],
    NOT_INTERESTED_NO_ENQUIRY: [
      'Did not Enquire',
      'Not Interested',
      'Cold',
      'Not interested AHV',
    ],
    EXISTING_DUPLICATE_DNC: [
      'Already Spoken',
      'Duplicate Lead',
      'Outreach Stopped',
      "DNC Client : Don't Call Furthur",
    ],
    TECHNICAL_LANGUAGE: ['Language Issue', 'Technical Error'],
    EMPLOYMENT_MISC: ['Jobs Enquiry', 'Other/Misc Enquiry'],
    OTHER: ['Junk', 'Other Cases'],
  }

  let total = 0
  for (const [group, outcomes] of Object.entries(expected)) {
    for (const outcome of outcomes) {
      assert.equal(
        groupForDetailedOutcome(outcome),
        group,
        `${outcome} should group as ${group}`,
      )
      total += 1
    }
  }
  assert.equal(total, 53, 'the expectation table must cover every outcome')
})

test('grouping is deterministic', () => {
  for (const outcome of DETAILED_OUTCOMES) {
    assert.equal(
      groupForDetailedOutcome(outcome),
      groupForDetailedOutcome(outcome),
    )
  }
})

test('AHV variants group with their base outcome', () => {
  const pairs: Array<[DetailedOutcome, DetailedOutcome]> = [
    ['Treatment Package for Resort', 'Treatment package for resort AHV'],
    ['Not Interested', 'Not interested AHV'],
    ['Yoga Training', 'Yoga training AHV'],
    ['Ayurveda Training', 'Ayurvedic Training AHV'],
    ['Prevention_Rejuvenation', 'Prevention_rejuvenation AHV'],
    ['Group Resort Booking_yoga retreat', 'Group resort booking AHV yoga retreat'],
  ]
  for (const [base, variant] of pairs) {
    assert.equal(
      groupForDetailedOutcome(variant),
      groupForDetailedOutcome(base),
      `${variant} should group with ${base}`,
    )
  }
})

// ---------------------------------------------------------------------------
// Compliance-sensitive no-contact outcomes
// ---------------------------------------------------------------------------

test('exposes exactly the two no-contact outcomes', () => {
  assert.deepEqual(
    [...NO_CONTACT_OUTCOMES],
    ['Outreach Stopped', "DNC Client : Don't Call Furthur"],
  )
  for (const outcome of NO_CONTACT_OUTCOMES) {
    assert.ok(isDetailedOutcome(outcome), `${outcome} must be approved`)
    assert.ok(isNoContactOutcome(outcome))
    assert.equal(groupForDetailedOutcome(outcome), 'EXISTING_DUPLICATE_DNC')
  }
})

test('no other outcome is treated as no-contact', () => {
  for (const outcome of DETAILED_OUTCOMES) {
    const expected = (NO_CONTACT_OUTCOMES as readonly string[]).includes(
      outcome,
    )
    assert.equal(isNoContactOutcome(outcome), expected, outcome)
  }
  for (const value of [
    'Duplicate Lead',
    'Already Spoken',
    "DNC Client: Don't Call Further",
    'outreach stopped',
    null,
    42,
  ]) {
    assert.equal(isNoContactOutcome(value), false, `${String(value)}`)
  }
})
