import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  buildSourceRefIdempotencyKey,
  buildSourceRevision,
  CallAuditSourceRevisionError,
  sourceRevisionCanonicalJson,
} from './sourceRevision.ts'
import {
  CALL_AUDIT_SOURCE_TABLE,
  SOURCE_CATEGORICAL_FIELDS,
  type InternalSourceCandidate,
} from './sourceTypes.ts'

/** Synthetic fixture only — never real customer data. */
function syntheticCandidate(
  overrides: Partial<InternalSourceCandidate> = {},
): InternalSourceCandidate {
  return {
    sourceTable: CALL_AUDIT_SOURCE_TABLE,
    sourceRowId: '4021',
    leadId: 'LEAD-2026-000123',
    transcript: 'Saanvi: hello? Caller: yes, tell me about the package.',
    effectiveCallTime: '2026-08-01 09:15:00.000000',
    sourceUpdatedAt: '2026-08-01 09:20:00.000000',
    callStartedAt: '2026-08-01 09:15:00.000000',
    callEndedAt: '2026-08-01 09:16:24.000000',
    callDurationSec: '00:01:24',
    company_by_kserve: 'Kairali',
    company: 'Kairali Ayurvedic Group',
    data_source: 'website_form',
    verified_source: 'verified_web',
    service_category: 'panchakarma',
    call_type: 'outbound',
    call_status: 'connected',
    call_end_reason: 'customer_hangup',
    final_call_status: 'completed',
    ai_call_category: 'information_request',
    customer_engagement_level: 'engaged',
    interest_level: 'high',
    call_outcome: 'callback_requested',
    lead_status: 'qualified',
    final_lead_outcome: 'followup_scheduled',
    calculated_qualification_status: 'qualified',
    followup_required: 'yes',
    ...overrides,
  }
}

const sha256 = (value: string) =>
  createHash('sha256').update(value).digest('hex')

// ---------------------------------------------------------------------------
// Task ID and hashes
// ---------------------------------------------------------------------------

test('derives the Task ID with the accepted extractTaskId behaviour', () => {
  assert.equal(
    buildSourceRevision(syntheticCandidate()).reference.taskId,
    '000123',
  )
  assert.equal(
    buildSourceRevision(syntheticCandidate({ leadId: '  KS-42  ' })).reference
      .taskId,
    '42',
  )
  assert.equal(
    buildSourceRevision(syntheticCandidate({ leadId: 'plain000777' }))
      .reference.taskId,
    'plain000777',
  )
})

test('leaves the Task ID null when none can be derived', () => {
  for (const leadId of [null, '', '   ', 'LEAD-2026-', '-']) {
    assert.equal(
      buildSourceRevision(syntheticCandidate({ leadId })).reference.taskId,
      null,
      `${JSON.stringify(leadId)} must yield no Task ID`,
    )
  }
})

test('hashes the trimmed full lead ID, or stores null when blank', () => {
  const reference = buildSourceRevision(syntheticCandidate()).reference
  assert.equal(reference.leadIdSha256, sha256('LEAD-2026-000123'))

  const padded = buildSourceRevision(
    syntheticCandidate({ leadId: '  LEAD-2026-000123  ' }),
  ).reference
  assert.equal(padded.leadIdSha256, reference.leadIdSha256)

  for (const leadId of [null, '', '   ', '\t\n']) {
    assert.equal(
      buildSourceRevision(syntheticCandidate({ leadId })).reference
        .leadIdSha256,
      null,
    )
  }
})

test('a lead ID with no derivable Task ID still gets hashed', () => {
  const reference = buildSourceRevision(
    syntheticCandidate({ leadId: 'LEAD-2026-' }),
  ).reference
  assert.equal(reference.taskId, null)
  assert.equal(reference.leadIdSha256, sha256('LEAD-2026-'))
})

// ---------------------------------------------------------------------------
// Transcript presence
// ---------------------------------------------------------------------------

test('a non-blank transcript is present and hashed byte-exactly', () => {
  const transcript = '  Saanvi: hello?  '
  const reference = buildSourceRevision(
    syntheticCandidate({ transcript }),
  ).reference
  assert.equal(reference.hasTranscript, true)
  assert.equal(reference.transcriptSha256, sha256(transcript))
  assert.notEqual(reference.transcriptSha256, sha256(transcript.trim()))
})

test('a missing or whitespace-only transcript is absent and unhashed', () => {
  for (const transcript of [null, '', ' ', '\t', '\n', '  \t\n ']) {
    const reference = buildSourceRevision(
      syntheticCandidate({ transcript }),
    ).reference
    assert.equal(reference.hasTranscript, false)
    assert.equal(reference.transcriptSha256, null)
  }
})

test('the raw transcript is retained only in the processing envelope', () => {
  const transcript = 'Saanvi: hello? Caller: yes.'
  const envelope = buildSourceRevision(syntheticCandidate({ transcript }))
  assert.equal(envelope.transcript, transcript)
  assert.equal('transcript' in envelope.reference, false)
})

// ---------------------------------------------------------------------------
// Revision determinism
// ---------------------------------------------------------------------------

test('identical input yields identical hashes and idempotency keys', () => {
  const first = buildSourceRevision(syntheticCandidate()).reference
  const second = buildSourceRevision(syntheticCandidate()).reference
  assert.equal(first.sourceRevisionSha256, second.sourceRevisionSha256)
  assert.equal(first.sourceRefIdempotencyKey, second.sourceRefIdempotencyKey)
  assert.deepEqual(first, second)
})

test('the revision hash changes when any included fact changes', () => {
  const baseline = buildSourceRevision(syntheticCandidate()).reference
    .sourceRevisionSha256

  const mutations: Array<Partial<InternalSourceCandidate>> = [
    { sourceRowId: '4022' },
    { effectiveCallTime: '2026-08-01 09:15:01.000000' },
    { leadId: 'LEAD-2026-000124' },
    { transcript: 'Saanvi: hello? Caller: no thank you.' },
    { transcript: null },
    { sourceUpdatedAt: '2026-08-01 09:21:00.000000' },
    { callStartedAt: '2026-08-01 09:15:01.000000' },
    { callEndedAt: null },
    { callDurationSec: '00:01:25' },
    ...SOURCE_CATEGORICAL_FIELDS.map((field) => ({ [field]: 'changed' })),
  ]

  for (const mutation of mutations) {
    const changed = buildSourceRevision(
      syntheticCandidate(mutation),
    ).reference.sourceRevisionSha256
    assert.notEqual(
      changed,
      baseline,
      `${JSON.stringify(mutation)} must produce a new revision`,
    )
  }
})

test('every categorical field is covered by the revision hash', () => {
  const canonical = sourceRevisionCanonicalJson(
    buildSourceRevision(syntheticCandidate()).reference,
  )
  for (const field of SOURCE_CATEGORICAL_FIELDS) {
    assert.match(
      canonical,
      new RegExp('"' + field + '":'),
      `${field} is missing from the revision facts`,
    )
  }
  for (const fact of [
    'source_table',
    'source_row_id',
    'effective_call_at',
    'task_id',
    'lead_id_sha256',
    'transcript_sha256',
    'has_transcript',
    'source_updated_at',
    'call_started_at',
    'call_ended_at',
    'call_duration_seconds',
  ]) {
    assert.match(canonical, new RegExp('"' + fact + '":'))
  }
})

test('the revision excludes generated and derived persistence fields', () => {
  const canonical = sourceRevisionCanonicalJson(
    buildSourceRevision(syntheticCandidate()).reference,
  )
  for (const excluded of ['"id"', 'source_ref_idempotency_key', 'created_at']) {
    assert.equal(
      canonical.includes(excluded),
      false,
      `${excluded} must not participate in the revision hash`,
    )
  }
})

test('an unchanged revision reuses the same idempotency key', () => {
  const reference = buildSourceRevision(syntheticCandidate()).reference
  assert.equal(
    reference.sourceRefIdempotencyKey,
    buildSourceRefIdempotencyKey(
      CALL_AUDIT_SOURCE_TABLE,
      '4021',
      reference.sourceRevisionSha256,
    ),
  )
  assert.ok(reference.sourceRefIdempotencyKey.length <= 191)
})

test('a changed revision produces a new idempotency key', () => {
  const before = buildSourceRevision(
    syntheticCandidate({ transcript: null }),
  ).reference
  const after = buildSourceRevision(syntheticCandidate()).reference
  assert.notEqual(
    before.sourceRefIdempotencyKey,
    after.sourceRefIdempotencyKey,
  )
  assert.equal(before.sourceRowId, after.sourceRowId)
})

test('canonical JSON ordering is stable regardless of input key order', () => {
  const ordered = syntheticCandidate()
  const shuffled = Object.fromEntries(
    Object.entries(ordered).reverse(),
  ) as InternalSourceCandidate
  assert.equal(
    buildSourceRevision(ordered).reference.sourceRevisionSha256,
    buildSourceRevision(shuffled).reference.sourceRevisionSha256,
  )
})

// ---------------------------------------------------------------------------
// Duration
// ---------------------------------------------------------------------------

test('parses the duration into whole seconds and never fabricates one', () => {
  assert.equal(
    buildSourceRevision(syntheticCandidate()).reference.callDurationSeconds,
    84,
  )
  for (const callDurationSec of [null, '', '   ', 'abc', '-00:00:10', '90']) {
    assert.equal(
      buildSourceRevision(syntheticCandidate({ callDurationSec })).reference
        .callDurationSeconds,
      null,
      `${JSON.stringify(callDurationSec)} must not yield a duration`,
    )
  }
  assert.equal(
    buildSourceRevision(syntheticCandidate({ callDurationSec: '00:00:00' }))
      .reference.callDurationSeconds,
    0,
  )
})

// ---------------------------------------------------------------------------
// Privacy of the persistence object
// ---------------------------------------------------------------------------

test('the persistence reference exposes no PII, lead ID, or transcript', () => {
  const candidate = syntheticCandidate()
  const { reference } = buildSourceRevision(candidate)
  const keys = Object.keys(reference)

  for (const forbidden of [
    'leadId',
    'lead_id',
    'transcript',
    'transcription',
    'transcriptionViewUrl',
    'transcription_view_url',
    'clientName',
    'client_name',
    'mobile',
    'email',
    'notes',
    'summary',
    'customerContext',
    'customer_context',
  ]) {
    assert.equal(
      keys.includes(forbidden),
      false,
      `the persistence reference must not carry ${forbidden}`,
    )
  }

  const serialized = JSON.stringify(reference)
  assert.equal(serialized.includes(candidate.leadId as string), false)
  assert.equal(serialized.includes(candidate.transcript as string), false)
  assert.equal(serialized.includes('Saanvi'), false)
})

test('no raw source value survives the revision canonical JSON', () => {
  const candidate = syntheticCandidate()
  const canonical = sourceRevisionCanonicalJson(
    buildSourceRevision(candidate).reference,
  )
  assert.equal(canonical.includes(candidate.leadId as string), false)
  assert.equal(canonical.includes(candidate.transcript as string), false)
  // Only the derived Task ID and hashes represent them.
  assert.match(canonical, /"task_id":"000123"/)
  assert.match(canonical, new RegExp('"lead_id_sha256":"[0-9a-f]{64}"'))
})

test('the reference shape matches the migration 0008 column set', () => {
  const reference = buildSourceRevision(syntheticCandidate()).reference
  for (const field of [
    'sourceTable',
    'sourceRowId',
    'sourceRevisionSha256',
    'effectiveCallTime',
    'taskId',
    'leadIdSha256',
    'transcriptSha256',
    'hasTranscript',
    'sourceUpdatedAt',
    'callStartedAt',
    'callEndedAt',
    'callDurationSeconds',
    'sourceRefIdempotencyKey',
    ...SOURCE_CATEGORICAL_FIELDS,
  ]) {
    assert.ok(field in reference, `reference is missing ${field}`)
  }
  assert.match(reference.sourceRevisionSha256, /^[0-9a-f]{64}$/)
})

// ---------------------------------------------------------------------------
// Input integrity
// ---------------------------------------------------------------------------

test('rejects a source row that cannot be identified', () => {
  for (const sourceRowId of [
    '0',
    '-1',
    '1.5',
    '007',
    '',
    'abc',
    '9223372036854775808',
    0 as unknown as string,
    1.5 as unknown as string,
    Number.NaN as unknown as string,
    Number.MAX_VALUE as unknown as string,
    9007199254740993 as unknown as string,
  ]) {
    assert.throws(
      () => buildSourceRevision(syntheticCandidate({ sourceRowId })),
      CallAuditSourceRevisionError,
      `${String(sourceRowId)} must be rejected`,
    )
  }
  assert.throws(
    () => buildSourceRevision(syntheticCandidate({ sourceTable: '  ' })),
    CallAuditSourceRevisionError,
  )
})

test('preserves a BIGINT source row id exactly', () => {
  const reference = buildSourceRevision(
    syntheticCandidate({ sourceRowId: '9007199254740993' }),
  ).reference
  assert.equal(reference.sourceRowId, '9007199254740993')
  assert.match(
    sourceRevisionCanonicalJson(reference),
    /"source_row_id":"9007199254740993"/,
  )
  assert.match(reference.sourceRefIdempotencyKey, /:9007199254740993:/)

  // A neighbouring id that a Number would collapse onto must stay distinct.
  const neighbour = buildSourceRevision(
    syntheticCandidate({ sourceRowId: '9007199254740992' }),
  ).reference
  assert.notEqual(reference.sourceRevisionSha256, neighbour.sourceRevisionSha256)
  assert.notEqual(
    reference.sourceRefIdempotencyKey,
    neighbour.sourceRefIdempotencyKey,
  )
})

test('requires an effective call time', () => {
  for (const effectiveCallTime of [
    null as unknown as string,
    undefined as unknown as string,
    '',
    '   ',
  ]) {
    assert.throws(
      () => buildSourceRevision(syntheticCandidate({ effectiveCallTime })),
      CallAuditSourceRevisionError,
      `${JSON.stringify(effectiveCallTime)} must be rejected`,
    )
  }
})

test('the effective call time is persisted and covered by the revision', () => {
  const reference = buildSourceRevision(syntheticCandidate()).reference
  assert.equal(reference.effectiveCallTime, '2026-08-01 09:15:00.000000')
  assert.match(
    sourceRevisionCanonicalJson(reference),
    /"effective_call_at":"2026-08-01 09:15:00.000000"/,
  )

  // A call with no call_start_time is still fully identified and reportable.
  const noStart = buildSourceRevision(
    syntheticCandidate({ callStartedAt: null }),
  ).reference
  assert.equal(noStart.callStartedAt, null)
  assert.equal(noStart.effectiveCallTime, '2026-08-01 09:15:00.000000')
  assert.notEqual(noStart.sourceRevisionSha256, reference.sourceRevisionSha256)
})

test('does not mutate the candidate it was given', () => {
  const candidate = syntheticCandidate()
  const snapshot = { ...candidate }
  buildSourceRevision(candidate)
  assert.deepEqual(candidate, snapshot)
})
