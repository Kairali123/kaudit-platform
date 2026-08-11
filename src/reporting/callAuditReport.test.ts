import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  CALL_AUDIT_CONTENT_BOUNDARY,
  CALL_AUDIT_REPORT_SECTION_KEYS,
  CALL_AUDIT_REPORT_TITLE,
  CallAuditReportRequestError,
  DEFAULT_RESULT_LIMIT,
  MAX_PERIOD_DAYS,
  MAX_RESULT_LIMIT,
  averageOf,
  buildCallAuditReport,
  buildHeadlineTiles,
  buildReliability,
  buildSections,
  defaultPeriodFor,
  parseCallAuditReportQuery,
  periodLabel,
  sharePercent,
  toMetricRow,
  toResultRow,
} from './callAuditReport.ts'
import {
  ELIGIBILITIES,
  KSERVE_COMPARISON_LABELS,
  MISMATCH_SEVERITIES,
  PROCESSING_STATUSES,
  UNDETERMINED_BUCKET,
  type CallAuditPeriodSummary,
  type CallAuditReportingRepository,
  type CallAuditResultReportRow,
  type CallAuditTally,
  type CallAuditUsageAggregate,
} from '../adapters/mysqlCallAuditReporting.ts'
import { CALL_AUDIT_METRIC_CODES } from '../callaudit/rubric.ts'
import { OUTCOME_GROUPS } from '../callaudit/outcomes.ts'
import {
  ISSUE_FLAGS,
  NEXT_ACTION_CODES,
  QUALIFICATIONS,
  type IssueFlag,
} from '../callaudit/modelOutput.ts'
import { CALL_INTENTS } from '../callaudit/types.ts'

// ---------------------------------------------------------------------------
// Synthetic fixtures. No real transcript, lead, hash, URL, PII, or money.
// ---------------------------------------------------------------------------

function tally<Bucket extends string>(
  vocabulary: readonly Bucket[],
  counts: Partial<Record<Bucket | typeof UNDETERMINED_BUCKET, number>> = {},
): CallAuditTally<Bucket> {
  const result = Object.fromEntries(
    [...vocabulary, UNDETERMINED_BUCKET].map((bucket) => [
      bucket,
      (counts as Record<string, number>)[bucket] ?? 0,
    ]),
  ) as CallAuditTally<Bucket>
  return result
}

const EMPTY_SUMMARY: CallAuditPeriodSummary = {
  period: {
    periodStart: '2026-07-01 00:00:00.000000',
    periodEndExclusive: '2026-08-01 00:00:00.000000',
  },
  runTypes: ['monthly'],
  runId: null,
  resultCount: 0,
  auditedCallCount: 0,
  byProcessingStatus: tally(PROCESSING_STATUSES),
  byEligibility: tally(ELIGIBILITIES),
  byIntent: tally(CALL_INTENTS),
  byGroupedOutcome: tally(OUTCOME_GROUPS),
  byKserveComparison: tally(KSERVE_COMPARISON_LABELS),
  byMismatchSeverity: tally(MISMATCH_SEVERITIES),
  byQualification: tally(QUALIFICATIONS),
  byNextAction: tally(NEXT_ACTION_CODES),
  byIssueFlag: Object.fromEntries(
    ISSUE_FLAGS.map((flag) => [flag, 0]),
  ) as Record<IssueFlag, number>,
}

const POPULATED_SUMMARY: CallAuditPeriodSummary = {
  ...EMPTY_SUMMARY,
  resultCount: 40,
  auditedCallCount: 38,
  byProcessingStatus: tally(PROCESSING_STATUSES, {
    succeeded: 31,
    failed: 3,
    skipped: 5,
    pending: 1,
  }),
  byEligibility: tally(ELIGIBILITIES, {
    content_auditable: 27,
    operational_only: 13,
  }),
  byIntent: tally(CALL_INTENTS, {
    HIGH: 6,
    WARM: 9,
    LOW: 11,
    NONE: 8,
    [UNDETERMINED_BUCKET]: 6,
  }),
  byGroupedOutcome: tally(OUTCOME_GROUPS, {
    PRODUCTS_COMMERCE: 12,
    RESORT_HEALING: 7,
    NOT_CONNECTED: 9,
    [UNDETERMINED_BUCKET]: 12,
  }),
  byKserveComparison: tally(KSERVE_COMPARISON_LABELS, {
    match: 21,
    mismatch: 8,
    not_comparable: 11,
  }),
  byMismatchSeverity: tally(MISMATCH_SEVERITIES, {
    none: 21,
    low: 4,
    medium: 3,
    high: 1,
    [UNDETERMINED_BUCKET]: 11,
  }),
  byQualification: tally(QUALIFICATIONS, {
    QUALIFIED: 9,
    NON_QUALIFIED: 14,
    UNCERTAIN: 4,
    NOT_APPLICABLE: 13,
  }),
  byNextAction: tally(NEXT_ACTION_CODES, {
    CALLBACK: 10,
    NONE: 18,
    SCHEDULE_BOOKING: 3,
  }),
  byIssueFlag: {
    ...EMPTY_SUMMARY.byIssueFlag,
    WEAK_NEXT_STEP: 7,
    NO_CUSTOMER_SPEECH: 4,
    LANGUAGE_ISSUE: 2,
  },
}

/**
 * A sanitized repository row carrying EXTRA fields that must never reach a
 * browser. They are cast on deliberately: the DTO is built by explicit copy, so
 * a column the repository might grow later has to be reviewed before it renders.
 */
function syntheticResultRow(
  index: number,
): CallAuditResultReportRow {
  return {
    resultId: `res-${index}`,
    runId: 'run-monthly-1',
    sourceRefId: `src-${index}`,
    taskId: `TASK-${1000 + index}`,
    effectiveCallAt: `2026-07-0${(index % 9) + 1} 09:15:00.000000`,
    callDurationSeconds: 132 + index,
    hasTranscript: index % 2 === 0,
    company: 'Synthetic Wellness Pvt Ltd',
    companyByKserve: 'Synthetic Wellness',
    serviceCategory: 'PRODUCTS',
    callType: 'outbound',
    callStatus: 'completed',
    finalCallStatus: 'completed',
    aiCallCategory: 'enquiry',
    customerEngagementLevel: 'medium',
    interestLevel: 'warm',
    callOutcome: 'Individual Products Buying',
    leadStatus: 'open',
    finalLeadOutcome: 'follow_up',
    calculatedQualificationStatus: 'qualified',
    followupRequired: 'yes',
    processingStatus: 'succeeded',
    eligibility: 'content_auditable',
    ineligibilityReason: null,
    callConnected: true,
    customerSpoke: index % 3 !== 0,
    meaningfulConversation: null,
    intent: 'WARM',
    intentConfidence: '0.720',
    detailedOutcome: 'Individual Products Buying',
    groupedOutcome: 'PRODUCTS_COMMERCE',
    qualificationLabel: 'QUALIFIED',
    nextActionCode: 'CALLBACK',
    overallScore: '78.250',
    overallScoreMethod: 'weighted_rubric_v1',
    kserveReportedOutcome: 'Individual Products Buying',
    kserveComparisonLabel: 'match',
    mismatchSeverity: 'none',
    managementFeedback: 'Synthetic sanitized management note.',
    kserveFeedback: 'Synthetic sanitized comparison note.',
    improvementFeedback: 'Synthetic sanitized coaching note.',
    issueFlags: ['WEAK_NEXT_STEP'],
    auditedAt: '2026-07-09 02:11:00.000000',
    // Fields that must be dropped by the explicit copy:
    transcript: 'SYNTHETIC-TRANSCRIPT-MUST-NOT-LEAK',
    leadId: 'SYNTHETIC-LEAD-MUST-NOT-LEAK',
    leadIdSha256: 'SYNTHETIC-HASH-MUST-NOT-LEAK',
    sourceUrl: 'https://synthetic.invalid/recording-must-not-leak',
    sourceRowId: 987654,
    resultJson: '{"synthetic":"must-not-leak"}',
    errorDetail: 'SYNTHETIC-PROVIDER-PROSE-MUST-NOT-LEAK',
    businessPrompt: 'SYNTHETIC-PROMPT-MUST-NOT-LEAK',
    amountInr: '1234.56',
  } as unknown as CallAuditResultReportRow
}

const USAGE: CallAuditUsageAggregate[] = [
  {
    providerName: 'synthetic-provider',
    modelName: 'synthetic-model',
    modelVersion: '2026-01-01',
    attemptOutcome: 'succeeded',
    attemptCount: 30,
    resultCount: 30,
    maxAttemptNumber: 2,
    inputTokensTotal: '900000',
    outputTokensTotal: '300000',
    totalTokensTotal: '1200000',
    latencyMsTotal: '60000',
    latencyMsMax: '4100',
    erroredCount: 0,
  },
  {
    providerName: 'synthetic-provider',
    modelName: 'synthetic-model',
    modelVersion: '2026-01-01',
    attemptOutcome: 'failed',
    attemptCount: 5,
    resultCount: 4,
    maxAttemptNumber: 3,
    inputTokensTotal: '15000',
    outputTokensTotal: '0',
    totalTokensTotal: '15000',
    latencyMsTotal: '20000',
    latencyMsMax: '9000',
    erroredCount: 5,
  },
]

function fakeRepository(
  overrides: Partial<CallAuditReportingRepository> = {},
  rowCount = 3,
): CallAuditReportingRepository {
  return {
    async getRunProgress() {
      return null
    },
    async listRuns() {
      return [
        {
          runId: 'run-monthly-1',
          ruleVersionId: 'rule-1',
          ruleVersionLabel: 'v3',
          runType: 'monthly',
          periodStart: '2026-07-01 00:00:00.000000',
          periodEndExclusive: '2026-08-01 00:00:00.000000',
          periodTimezone: 'Asia/Kolkata',
          status: 'completed',
          counters: {
            totalCandidates: 40,
            processedCount: 40,
            succeededCount: 31,
            failedCount: 3,
            skippedCount: 5,
            contentAuditableCount: 27,
            operationalOnlyCount: 13,
          },
          errorCode: null,
          scheduledAt: '2026-08-01 01:00:00.000000',
          startedAt: '2026-08-01 01:00:05.000000',
          finishedAt: '2026-08-01 01:22:41.000000',
        },
      ]
    },
    async getPeriodSummary() {
      return POPULATED_SUMMARY
    },
    async listMetricScoreAggregates() {
      return CALL_AUDIT_METRIC_CODES.map((metricCode, index) => ({
        metricCode,
        scoredCount: index === 0 ? 0 : 20,
        notApplicableCount: index === 0 ? 7 : 1,
        averageScore: index === 0 ? null : '3.750',
        distribution: { 1: 1, 2: 2, 3: 5, 4: 8, 5: 4 },
      }))
    },
    async listResults(query) {
      return Array.from({ length: Math.min(rowCount, query.limit) }, (_, index) =>
        syntheticResultRow(index),
      )
    },
    async listUsageAggregates() {
      return USAGE
    },
    ...overrides,
  }
}

function deepKeys(value: unknown, keys = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const entry of value) deepKeys(entry, keys)
  } else if (value && typeof value === 'object') {
    for (const [key, entry] of Object.entries(value)) {
      keys.add(key)
      deepKeys(entry, keys)
    }
  }
  return keys
}

const FORBIDDEN_KEYS = [
  'transcript',
  'transcriptSha256',
  'leadId',
  'leadIdSha256',
  'sourceRowId',
  'sourceRefId',
  'sourceUrl',
  'recordingUrl',
  'resultJson',
  'resultSha256',
  'sourceRevisionSha256',
  'errorDetail',
  'businessPrompt',
  'scoringConfigJson',
  'prompt',
  'temperature',
  'providerName',
  'modelName',
  'modelVersion',
  'phone',
  'amount',
  'amountInr',
  'currency',
  'price',
  'rate',
  'cost',
  'invoice',
]

const FORBIDDEN_VALUES = [
  'SYNTHETIC-TRANSCRIPT-MUST-NOT-LEAK',
  'SYNTHETIC-LEAD-MUST-NOT-LEAK',
  'SYNTHETIC-HASH-MUST-NOT-LEAK',
  'recording-must-not-leak',
  'SYNTHETIC-PROVIDER-PROSE-MUST-NOT-LEAK',
  'SYNTHETIC-PROMPT-MUST-NOT-LEAK',
  '987654',
  '1234.56',
  'synthetic-provider',
  'synthetic-model',
]

// ---------------------------------------------------------------------------
// Query parsing
// ---------------------------------------------------------------------------

test('query defaults to the current UTC monthly period', () => {
  const query = parseCallAuditReportQuery(
    new URLSearchParams(),
    new Date('2026-07-14T18:44:00Z'),
  )
  assert.equal(query.cadence, 'monthly')
  assert.equal(query.limit, DEFAULT_RESULT_LIMIT)
  assert.equal(query.periodDefaulted, true)
  assert.deepEqual(query.period, {
    periodStart: '2026-07-01 00:00:00',
    periodEndExclusive: '2026-08-01 00:00:00',
  })
})

test('each cadence defaults to its own current UTC calendar period', () => {
  const now = new Date('2026-05-14T18:44:00Z')
  assert.deepEqual(defaultPeriodFor('daily', now), {
    periodStart: '2026-05-14 00:00:00',
    periodEndExclusive: '2026-05-15 00:00:00',
  })
  assert.deepEqual(defaultPeriodFor('quarterly', now), {
    periodStart: '2026-04-01 00:00:00',
    periodEndExclusive: '2026-07-01 00:00:00',
  })
  assert.deepEqual(defaultPeriodFor('yearly', now), {
    periodStart: '2026-01-01 00:00:00',
    periodEndExclusive: '2027-01-01 00:00:00',
  })
})

test('calendar dates are completed to UTC-naive midnight boundaries', () => {
  const query = parseCallAuditReportQuery(
    new URLSearchParams({
      cadence: 'daily',
      start: '2026-02-28',
      end: '2026-03-01',
      limit: '10',
    }),
  )
  assert.equal(query.cadence, 'daily')
  assert.equal(query.limit, 10)
  assert.equal(query.periodDefaulted, false)
  assert.equal(query.period.periodStart, '2026-02-28 00:00:00.000000')
  assert.equal(
    query.period.periodEndExclusive,
    '2026-03-01 00:00:00.000000',
  )
})

test('a zoned or impossible boundary is rejected, never converted', () => {
  const invalid: Array<Record<string, string>> = [
    { start: '2026-07-01T00:00:00Z', end: '2026-08-01' },
    { start: '2026-07-01+05:30', end: '2026-08-01' },
    { start: '2026-02-30', end: '2026-03-01' },
    { start: '2026-08-01', end: '2026-07-01' },
    { start: '2026-07-01', end: '2026-07-01' },
    { start: '2026-07-01', end: '' },
  ]
  for (const params of invalid) {
    assert.throws(
      () => parseCallAuditReportQuery(new URLSearchParams(params)),
      CallAuditReportRequestError,
      `expected ${JSON.stringify(params)} to be rejected`,
    )
  }
})

test('cadence, limit, and window length are bounded', () => {
  assert.throws(
    () =>
      parseCallAuditReportQuery(
        new URLSearchParams({ cadence: 'weekly' }),
      ),
    /cadence/,
  )
  assert.throws(
    () =>
      parseCallAuditReportQuery(
        new URLSearchParams({ cadence: 'manual' }),
      ),
    /cadence/,
  )
  for (const limit of ['0', '2.5', String(MAX_RESULT_LIMIT + 1), 'all']) {
    assert.throws(
      () => parseCallAuditReportQuery(new URLSearchParams({ limit })),
      /limit/,
    )
  }
  assert.throws(
    () =>
      parseCallAuditReportQuery(
        new URLSearchParams({ start: '2020-01-01', end: '2026-01-01' }),
      ),
    new RegExp(`${MAX_PERIOD_DAYS} days`),
  )
  const atLimit = parseCallAuditReportQuery(
    new URLSearchParams({ start: '2026-01-01', end: '2027-01-01' }),
  )
  assert.equal(atLimit.period.periodStart, '2026-01-01 00:00:00.000000')
})

test('the period label states the UTC half-open basis', () => {
  assert.equal(
    periodLabel({
      periodStart: '2026-07-01 00:00:00.000000',
      periodEndExclusive: '2026-08-01 00:00:00.000000',
    }),
    '1 Jul 2026 → 1 Aug 2026 (UTC, end exclusive)',
  )
})

// ---------------------------------------------------------------------------
// Folding
// ---------------------------------------------------------------------------

test('an empty period reports pending tiles, never a clean zero', () => {
  const tiles = buildHeadlineTiles(EMPTY_SUMMARY)
  assert.equal(tiles.length, 8)
  for (const tile of tiles) {
    assert.equal(tile.status, 'pending', tile.label)
    assert.equal(tile.value, '—', tile.label)
    assert.notEqual(tile.sub, '')
    assert.doesNotMatch(tile.sub, /^0 /)
  }
})

test('populated tiles warn on failures, mismatches, and severity', () => {
  const tiles = buildHeadlineTiles(POPULATED_SUMMARY)
  const byLabel = new Map(tiles.map((tile) => [tile.label, tile]))
  assert.equal(byLabel.get('Calls audited')?.value, '38')
  assert.match(byLabel.get('Calls audited')?.sub ?? '', /40 result rows/)
  assert.equal(byLabel.get('Content-auditable')?.value, '27')
  assert.equal(byLabel.get('Audits succeeded')?.value, '31')
  assert.equal(byLabel.get('Audits succeeded')?.status, 'warn')
  assert.equal(byLabel.get('High intent')?.value, '6')
  assert.equal(byLabel.get('Qualified leads')?.value, '9')
  assert.equal(byLabel.get('Agrees with KServe')?.status, 'warn')
  assert.equal(byLabel.get('High-severity mismatches')?.value, '1')
  assert.equal(byLabel.get('High-severity mismatches')?.status, 'warn')
  assert.equal(byLabel.get('Issue flags raised')?.value, '13')
  assert.match(
    byLabel.get('Issue flags raised')?.sub ?? '',
    /Weak next step \(7\)/,
  )
})

test('sections keep the undetermined bucket and compact the long vocabularies', () => {
  const sections = buildSections(POPULATED_SUMMARY)
  assert.deepEqual(
    sections.map((section) => section.key),
    [...CALL_AUDIT_REPORT_SECTION_KEYS],
  )
  const byKey = new Map(sections.map((section) => [section.key, section]))

  const comparison = byKey.get('kserve_comparison')!
  assert.deepEqual(
    comparison.rows.map((row) => row.code),
    ['match', 'mismatch', 'not_comparable', UNDETERMINED_BUCKET],
  )
  assert.equal(comparison.rows[0].sharePercent, '52.5')
  assert.equal(comparison.emptyBucketCount, 0)

  const intent = byKey.get('intent')!
  assert.equal(
    intent.rows.find((row) => row.code === UNDETERMINED_BUCKET)?.label,
    'Not determined',
  )

  const grouped = byKey.get('grouped_outcome')!
  assert.deepEqual(
    grouped.rows.map((row) => row.code),
    [
      'PRODUCTS_COMMERCE',
      UNDETERMINED_BUCKET,
      'NOT_CONNECTED',
      'RESORT_HEALING',
    ],
  )
  assert.equal(grouped.emptyBucketCount, 9)

  const flags = byKey.get('issue_flags')!
  assert.equal(flags.total, 13)
  assert.deepEqual(
    flags.rows.map((row) => row.label),
    ['Weak next step', 'No customer speech', 'Language issue'],
  )
  assert.match(flags.caption, /do not sum/)
})

test('an empty section reports null shares rather than zero percent', () => {
  const sections = buildSections(EMPTY_SUMMARY)
  for (const section of sections) {
    for (const row of section.rows) {
      assert.equal(row.sharePercent, null)
    }
  }
  assert.equal(sharePercent(0, 0), null)
  assert.equal(sharePercent(1, 3), '33.3')
  assert.equal(sharePercent(2, 3), '66.7')
})

test('an unscored metric keeps a null average and its rubric weight', () => {
  const unscored = toMetricRow({
    metricCode: 'COMPLIANCE_PRIVACY',
    scoredCount: 0,
    notApplicableCount: 4,
    averageScore: null,
    distribution: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 },
  })
  assert.equal(unscored.averageScore, null)
  assert.equal(unscored.notApplicableCount, 4)
  assert.equal(unscored.weight, 5)
  assert.equal(unscored.label, 'Compliance & privacy')
})

test('reliability drops model identity and keeps BIGINT totals as strings', () => {
  const reliability = buildReliability(USAGE)
  assert.equal(reliability.attemptCount, 35)
  assert.equal(reliability.erroredCount, 5)
  assert.equal(reliability.maxAttemptNumber, 3)
  assert.equal(reliability.totalTokens, '1215000')
  assert.equal(reliability.averageLatencyMs, '2286')
  assert.equal(reliability.maxLatencyMs, '9000')
  assert.deepEqual(
    reliability.byAttemptOutcome.map((row) => row.label),
    ['Succeeded', 'Failed'],
  )
  const keys = deepKeys(reliability)
  for (const forbidden of ['providerName', 'modelName', 'modelVersion']) {
    assert.equal(keys.has(forbidden), false, forbidden)
  }
  assert.equal(buildReliability([]).averageLatencyMs, null)
  assert.equal(averageOf('7', 2), '4')
  assert.equal(averageOf('5', 0), null)
})

test('a result row is copied field by field, dropping anything unreviewed', () => {
  const row = toResultRow(syntheticResultRow(2))
  assert.equal(row.taskId, 'TASK-1002')
  assert.equal(row.intentLabel, 'Warm intent')
  assert.equal(row.groupedOutcomeLabel, 'Products & commerce')
  assert.equal(row.kserveComparisonText, 'Matches KServe')
  assert.deepEqual(row.issueFlags, [
    { code: 'WEAK_NEXT_STEP', label: 'Weak next step' },
  ])
  // Byte-exact vendor taxonomy survives the mapping unaliased.
  assert.equal(row.detailedOutcome, 'Individual Products Buying')
  // Not determined stays null and is never rendered as false.
  assert.equal(row.meaningfulConversation, null)
  const keys = deepKeys(row)
  for (const forbidden of FORBIDDEN_KEYS) {
    assert.equal(keys.has(forbidden), false, forbidden)
  }
})

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

test('the report DTO carries the approved title, caller, and basis', async () => {
  const report = await buildCallAuditReport(
    fakeRepository(),
    parseCallAuditReportQuery(
      new URLSearchParams({
        cadence: 'quarterly',
        start: '2026-07-01',
        end: '2026-10-01',
        limit: '25',
      }),
    ),
    new Date('2026-08-05T10:00:00Z'),
  )
  assert.equal(report.title, CALL_AUDIT_REPORT_TITLE)
  assert.equal(report.title, 'Kserve Call Audit Report')
  assert.equal(report.aiCaller, 'Saanvi')
  assert.equal(report.contentBoundary, CALL_AUDIT_CONTENT_BOUNDARY)
  assert.equal(report.generatedAt, '2026-08-05T10:00:00.000Z')
  assert.equal(report.reportBasis.cadence, 'quarterly')
  assert.equal(report.reportBasis.cadenceLabel, 'Quarterly')
  assert.deepEqual(report.reportBasis.runTypes, ['quarterly'])
  assert.equal(report.reportBasis.boundaryBasis, 'utc_naive_half_open')
  assert.equal(report.reportBasis.periodDefaulted, false)
  assert.equal(report.hasResults, true)
  assert.equal(report.metrics.length, 8)
  assert.equal(report.summary.resultCount, 40)
  assert.equal(report.summary.auditedCallCount, 38)
  assert.equal(report.runs.length, 1)
  assert.equal(report.runs[0].progressPercent, '100.0')
  assert.equal(report.runs[0].statusLabel, 'Completed')
})

test('the cadence scopes every read to that run type', async () => {
  const scopes: unknown[] = []
  const repository = fakeRepository({
    async getPeriodSummary(query) {
      scopes.push(query)
      return EMPTY_SUMMARY
    },
    async listMetricScoreAggregates(query) {
      scopes.push(query)
      return []
    },
    async listUsageAggregates(query) {
      scopes.push(query)
      return []
    },
    async listResults(query) {
      scopes.push(query)
      return []
    },
    async listRuns(query) {
      scopes.push(query)
      return []
    },
  })
  const report = await buildCallAuditReport(
    repository,
    parseCallAuditReportQuery(
      new URLSearchParams({
        cadence: 'daily',
        start: '2026-07-04',
        end: '2026-07-05',
      }),
    ),
  )
  assert.equal(scopes.length, 5)
  for (const scope of scopes as Array<Record<string, unknown>>) {
    assert.deepEqual(scope.runTypes, ['daily'])
    assert.deepEqual(scope.period, {
      periodStart: '2026-07-04 00:00:00.000000',
      periodEndExclusive: '2026-07-05 00:00:00.000000',
    })
  }
  assert.equal(report.hasResults, false)
  assert.equal(report.results.length, 0)
  assert.equal(report.resultsTruncated, false)
})

test('the drilldown is truncated honestly, never silently', async () => {
  const query = parseCallAuditReportQuery(
    new URLSearchParams({ limit: '3' }),
  )
  const truncated = await buildCallAuditReport(
    fakeRepository({}, 9),
    query,
  )
  assert.equal(truncated.results.length, 3)
  assert.equal(truncated.resultsTruncated, true)
  assert.equal(truncated.reportBasis.resultLimit, 3)

  const complete = await buildCallAuditReport(
    fakeRepository({}, 2),
    query,
  )
  assert.equal(complete.results.length, 2)
  assert.equal(complete.resultsTruncated, false)
})

test('no forbidden field or value survives anywhere in the DTO', async () => {
  const report = await buildCallAuditReport(
    fakeRepository({}, 5),
    parseCallAuditReportQuery(new URLSearchParams({ limit: '5' })),
  )
  const keys = deepKeys(report)
  for (const forbidden of FORBIDDEN_KEYS) {
    assert.equal(keys.has(forbidden), false, `key ${forbidden} leaked`)
  }
  const serialized = JSON.stringify(report)
  for (const forbidden of FORBIDDEN_VALUES) {
    assert.equal(
      serialized.includes(forbidden),
      false,
      `value ${forbidden} leaked`,
    )
  }
  // The approved anonymous identifier is the only call identity present.
  assert.match(serialized, /TASK-1000/)
})
