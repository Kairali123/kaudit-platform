import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import {
  CALL_AUDIT_ARTIFACT_FILENAME_STEM,
  CALL_AUDIT_ARTIFACT_QUALITY_ONLY_NOTE,
  CALL_AUDIT_ARTIFACT_SCOPE,
  CALL_AUDIT_HTML_MEDIA_TYPE,
  CALL_AUDIT_PDF_MEDIA_TYPE,
  CallAuditArtifactError,
  MAX_ARTIFACT_HTML_BYTES,
  MAX_ARTIFACT_PDF_BYTES,
  MAX_ARTIFACT_SECTIONS,
  MAX_ARTIFACT_TEXT_CHARS,
  buildCallAuditReportAggregate,
  buildCallAuditReportArtifacts,
  buildCallAuditReportHtml,
  buildCallAuditReportPdf,
  callAuditArtifactFilename,
} from './callAuditReportArtifacts.ts'
import {
  CALL_AUDIT_REPORT_TITLE,
  buildCallAuditReport,
  type CallAuditReportDto,
  type CallAuditReportQuery,
} from './callAuditReport.ts'
import {
  ELIGIBILITIES,
  KSERVE_COMPARISON_LABELS,
  MISMATCH_SEVERITIES,
  PROCESSING_STATUSES,
  UNDETERMINED_BUCKET,
  type CallAuditPeriodSummary,
  type CallAuditReportCadence,
  type CallAuditReportingRepository,
  type CallAuditResultReportRow,
  type CallAuditRunProgress,
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
import { CALL_INTENTS, KSERVE_AI_CALLER_NAME } from '../callaudit/types.ts'

// ---------------------------------------------------------------------------
// Synthetic sentinels.
//
// Every one of these is planted on a DRILLDOWN or per-row field of the fake
// repository: result rows, run rows, and usage rows. None of them is real data,
// and every assertion below exists to prove that none of them survives into an
// artifact, a filename, artifact metadata, or an error message.
// ---------------------------------------------------------------------------

const SENTINELS = {
  taskId: 'KA-SENTINEL-TASKID-0001',
  resultId: 'KA-SENTINEL-RESULTID-0002',
  runId: 'KA-SENTINEL-RUNID-0003',
  sourceRefId: 'KA-SENTINEL-SOURCEREF-0004',
  company: 'KA-SENTINEL-COMPANY-0005',
  companyByKserve: 'KA-SENTINEL-KSERVECOMPANY-0006',
  serviceCategory: 'KA-SENTINEL-SERVICE-0007',
  detailedOutcome: 'KA-SENTINEL-DETAILEDOUTCOME-0008',
  kserveReportedOutcome: 'KA-SENTINEL-KSERVEOUTCOME-0009',
  managementFeedback: 'KA-SENTINEL-MGMTFEEDBACK-0010',
  kserveFeedback: 'KA-SENTINEL-KSERVEFEEDBACK-0011',
  improvementFeedback: 'KA-SENTINEL-IMPROVEFEEDBACK-0012',
  ineligibilityReason: 'KA-SENTINEL-INELIGIBILITY-0013',
  overallScoreMethod: 'KA-SENTINEL-SCOREMETHOD-0014',
  transcript: 'KA-SENTINEL-TRANSCRIPT-0015',
  leadId: 'KA-SENTINEL-LEADID-0016',
  leadIdSha256: 'KA-SENTINEL-HASH-0017',
  sourceUrl: 'https://sentinel.invalid/KA-SENTINEL-URL-0018.mp3',
  phone: '+911234500018',
  email: 'ka-sentinel-0019@sentinel.invalid',
  customerName: 'KA-SENTINEL-NAME-0020',
  amountInr: '987654.32',
  currency: 'KA-SENTINEL-CURRENCY-0021',
  resultJson: '{"ka":"KA-SENTINEL-RESULTJSON-0022"}',
  errorDetail: 'KA-SENTINEL-PROVIDERPROSE-0023',
  businessPrompt: 'KA-SENTINEL-PROMPT-0024',
  rowCallAt: '2031-12-24 03:04:05.000000',
  rowAuditedAt: '2031-12-25 06:07:08.000000',
  ruleVersionId: 'KA-SENTINEL-RULEVERSIONID-0025',
  ruleVersionLabel: 'KA-SENTINEL-RULELABEL-0026',
  runTimezone: 'Antarctica/Troll',
  runErrorCode: 'KA-SENTINEL-RUNERRORCODE-0027',
  runPeriodStart: '2033-03-03 00:00:00.000000',
  runStartedAt: '2032-01-02 03:04:05.000000',
  providerName: 'KA-SENTINEL-PROVIDER-0028',
  modelName: 'KA-SENTINEL-MODEL-0029',
  modelVersion: 'KA-SENTINEL-MODELVERSION-0030',
} as const

/** Substrings that must not appear anywhere an artifact can be read. */
const FORBIDDEN_SUBSTRINGS: readonly string[] = [
  ...Object.values(SENTINELS),
  'KA-SENTINEL',
  'sentinel.invalid',
  'Antarctica',
  '2031-12-2',
  '2032-01-02',
  '2033-03-03',
  '987654.32',
  'https://',
  '@',
]

function assertNoSentinel(haystack: string, where: string): void {
  for (const needle of FORBIDDEN_SUBSTRINGS) {
    assert.equal(
      haystack.includes(needle),
      false,
      `${where} leaked a forbidden value`,
    )
  }
}

// ---------------------------------------------------------------------------
// Synthetic repository fixtures
// ---------------------------------------------------------------------------

function tally<Bucket extends string>(
  vocabulary: readonly Bucket[],
  counts: Partial<Record<Bucket | typeof UNDETERMINED_BUCKET, number>> = {},
): CallAuditTally<Bucket> {
  return Object.fromEntries(
    [...vocabulary, UNDETERMINED_BUCKET].map((bucket) => [
      bucket,
      (counts as Record<string, number>)[bucket] ?? 0,
    ]),
  ) as CallAuditTally<Bucket>
}

const PERIOD = {
  periodStart: '2026-07-01 00:00:00',
  periodEndExclusive: '2026-08-01 00:00:00',
}

const EMPTY_SUMMARY: CallAuditPeriodSummary = {
  period: PERIOD,
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
 * A drilldown row soaked in sentinels, including fields the browser DTO is
 * allowed to carry and extra columns cast on to mimic a future repository
 * shape. An artifact must not read this row at all.
 */
function sentinelResultRow(index: number): CallAuditResultReportRow {
  return {
    resultId: `${SENTINELS.resultId}-${index}`,
    runId: SENTINELS.runId,
    sourceRefId: SENTINELS.sourceRefId,
    taskId: `${SENTINELS.taskId}-${index}`,
    effectiveCallAt: SENTINELS.rowCallAt,
    callDurationSeconds: 132 + index,
    hasTranscript: true,
    company: SENTINELS.company,
    companyByKserve: SENTINELS.companyByKserve,
    serviceCategory: SENTINELS.serviceCategory,
    callType: 'outbound',
    callStatus: 'completed',
    finalCallStatus: 'completed',
    aiCallCategory: 'enquiry',
    customerEngagementLevel: 'medium',
    interestLevel: 'warm',
    callOutcome: SENTINELS.detailedOutcome,
    leadStatus: 'open',
    finalLeadOutcome: 'follow_up',
    calculatedQualificationStatus: 'qualified',
    followupRequired: 'yes',
    processingStatus: 'succeeded',
    eligibility: 'content_auditable',
    ineligibilityReason: SENTINELS.ineligibilityReason,
    callConnected: true,
    customerSpoke: true,
    meaningfulConversation: null,
    intent: 'WARM',
    intentConfidence: '0.720',
    detailedOutcome: SENTINELS.detailedOutcome,
    groupedOutcome: 'PRODUCTS_COMMERCE',
    qualificationLabel: 'QUALIFIED',
    nextActionCode: 'CALLBACK',
    overallScore: '78.250',
    overallScoreMethod: SENTINELS.overallScoreMethod,
    kserveReportedOutcome: SENTINELS.kserveReportedOutcome,
    kserveComparisonLabel: 'match',
    mismatchSeverity: 'none',
    managementFeedback: SENTINELS.managementFeedback,
    kserveFeedback: SENTINELS.kserveFeedback,
    improvementFeedback: SENTINELS.improvementFeedback,
    issueFlags: ['WEAK_NEXT_STEP'],
    auditedAt: SENTINELS.rowAuditedAt,
    // Columns an artifact must never surface even if the repository grows them:
    transcript: SENTINELS.transcript,
    leadId: SENTINELS.leadId,
    leadIdSha256: SENTINELS.leadIdSha256,
    sourceUrl: SENTINELS.sourceUrl,
    customerPhone: SENTINELS.phone,
    customerEmail: SENTINELS.email,
    customerName: SENTINELS.customerName,
    amountInr: SENTINELS.amountInr,
    currency: SENTINELS.currency,
    resultJson: SENTINELS.resultJson,
    errorDetail: SENTINELS.errorDetail,
    businessPrompt: SENTINELS.businessPrompt,
  } as unknown as CallAuditResultReportRow
}

function sentinelRun(
  runType: CallAuditReportCadence,
  overrides: Partial<CallAuditRunProgress> = {},
): CallAuditRunProgress {
  return {
    runId: SENTINELS.runId,
    ruleVersionId: SENTINELS.ruleVersionId,
    ruleVersionLabel: SENTINELS.ruleVersionLabel,
    runType,
    periodStart: SENTINELS.runPeriodStart,
    periodEndExclusive: SENTINELS.runPeriodStart,
    periodTimezone: SENTINELS.runTimezone,
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
    errorCode: SENTINELS.runErrorCode,
    scheduledAt: SENTINELS.runStartedAt,
    startedAt: SENTINELS.runStartedAt,
    finishedAt: SENTINELS.runStartedAt,
    ...overrides,
  }
}

const SENTINEL_USAGE: CallAuditUsageAggregate[] = [
  {
    providerName: SENTINELS.providerName,
    modelName: SENTINELS.modelName,
    modelVersion: SENTINELS.modelVersion,
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
    providerName: SENTINELS.providerName,
    modelName: SENTINELS.modelName,
    modelVersion: SENTINELS.modelVersion,
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

interface RepositoryOptions {
  empty?: boolean
  runs?: CallAuditRunProgress[]
}

function fakeRepository(
  cadence: CallAuditReportCadence,
  options: RepositoryOptions = {},
): CallAuditReportingRepository {
  const empty = options.empty === true
  return {
    async getRunProgress() {
      return null
    },
    async listRuns() {
      return options.runs ?? (empty ? [] : [sentinelRun(cadence)])
    },
    async getPeriodSummary() {
      return empty ? EMPTY_SUMMARY : POPULATED_SUMMARY
    },
    async listMetricScoreAggregates() {
      return CALL_AUDIT_METRIC_CODES.map((metricCode, index) => ({
        metricCode,
        // The first metric is deliberately NA-only: nothing was scored, so its
        // average must stay absent rather than becoming a clean zero.
        scoredCount: empty || index === 0 ? 0 : 20,
        notApplicableCount: empty ? 0 : index === 0 ? 7 : 1,
        averageScore: empty || index === 0 ? null : '3.750',
        distribution: empty
          ? { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 }
          : { 1: 1, 2: 2, 3: 5, 4: 8, 5: 4 },
      }))
    },
    async listResults(query) {
      return empty
        ? []
        : Array.from({ length: Math.min(4, query.limit) }, (_, index) =>
            sentinelResultRow(index),
          )
    },
    async listUsageAggregates() {
      return empty ? [] : SENTINEL_USAGE
    },
  }
}

const PERIODS: Record<
  CallAuditReportCadence,
  { periodStart: string; periodEndExclusive: string }
> = {
  daily: {
    periodStart: '2026-07-14 00:00:00',
    periodEndExclusive: '2026-07-15 00:00:00',
  },
  monthly: PERIOD,
  quarterly: {
    periodStart: '2026-07-01 00:00:00',
    periodEndExclusive: '2026-10-01 00:00:00',
  },
  yearly: {
    periodStart: '2026-01-01 00:00:00',
    periodEndExclusive: '2027-01-01 00:00:00',
  },
}

const CADENCES: readonly CallAuditReportCadence[] = [
  'daily',
  'monthly',
  'quarterly',
  'yearly',
]

function queryFor(cadence: CallAuditReportCadence): CallAuditReportQuery {
  return {
    cadence,
    period: PERIODS[cadence],
    limit: 25,
    periodDefaulted: false,
  }
}

async function reportFor(
  cadence: CallAuditReportCadence,
  options: RepositoryOptions = {},
): Promise<CallAuditReportDto> {
  return buildCallAuditReport(
    fakeRepository(cadence, options),
    queryFor(cadence),
    new Date('2026-08-01T04:05:06.000Z'),
  )
}

// ---------------------------------------------------------------------------
// PDF text extraction. Compression is off, so the content stream is readable
// and an artifact's claim to exclude per-call detail is directly checkable.
// ---------------------------------------------------------------------------

function pdfText(pdf: Buffer): string {
  const raw = pdf.toString('latin1')
  const parts: string[] = []
  for (const operator of raw.matchAll(/\[([^\]]*)\]\s*TJ/g)) {
    let line = ''
    for (const run of operator[1].matchAll(/<([0-9a-fA-F]*)>/g)) {
      line += Buffer.from(run[1], 'hex').toString('latin1')
    }
    parts.push(line)
  }
  // Document metadata strings (Title, Author, Subject) are literal strings.
  for (const literal of raw.matchAll(/\(((?:\\.|[^\\()])*)\)/g)) {
    parts.push(literal[1])
  }
  return parts.join('\n')
}

// ---------------------------------------------------------------------------
// Cadences
// ---------------------------------------------------------------------------

for (const cadence of CADENCES) {
  test(`builds HTML, PDF, and metadata for the ${cadence} cadence`, async () => {
    const dto = await reportFor(cadence)
    const artifacts = await buildCallAuditReportArtifacts(dto)
    const period = PERIODS[cadence]

    assert.equal(artifacts.aggregate.title, CALL_AUDIT_REPORT_TITLE)
    assert.equal(artifacts.aggregate.title, 'Kserve Call Audit Report')
    assert.equal(artifacts.aggregate.aiCaller, KSERVE_AI_CALLER_NAME)
    assert.equal(artifacts.aggregate.basis.cadence, cadence)
    assert.equal(artifacts.aggregate.basis.periodStart, period.periodStart)
    assert.equal(
      artifacts.aggregate.basis.periodEndExclusive,
      period.periodEndExclusive,
    )
    assert.equal(artifacts.aggregate.basis.boundaryBasis, 'utc_naive_half_open')

    // The exact half-open UTC-naive basis is stated in both artifacts.
    const text = pdfText(artifacts.pdf)
    for (const body of [artifacts.html, text]) {
      assert.ok(body.includes('Kserve Call Audit Report'))
      assert.ok(body.includes(period.periodStart))
      assert.ok(body.includes(period.periodEndExclusive))
      assert.ok(body.includes('utc_naive_half_open'))
      assert.ok(body.includes(KSERVE_AI_CALLER_NAME))
      assert.ok(body.includes('2026-08-01T04:05:06.000Z'))
    }

    assert.equal(
      artifacts.pdfArtifact.filename,
      `${CALL_AUDIT_ARTIFACT_FILENAME_STEM}-${cadence}-` +
        `${period.periodStart.slice(0, 10)}-to-` +
        `${period.periodEndExclusive.slice(0, 10)}.pdf`,
    )
    assert.equal(
      artifacts.htmlArtifact.filename,
      artifacts.pdfArtifact.filename.replace(/\.pdf$/, '.html'),
    )
  })
}

test('a populated period renders headline, sections, metrics, and totals', async () => {
  const dto = await reportFor('monthly')
  const { html, pdf, aggregate } = await buildCallAuditReportArtifacts(dto)
  const text = pdfText(pdf)

  assert.equal(aggregate.hasResults, true)
  assert.equal(aggregate.emptyStateNote, null)
  assert.equal(aggregate.resultCount, 40)
  assert.equal(aggregate.auditedCallCount, 38)

  for (const body of [html, text]) {
    assert.ok(body.includes('Calls audited'))
    assert.ok(body.includes('Grouped outcome'))
    assert.ok(body.includes('KServe comparison'))
    assert.ok(body.includes('Rubric metrics'))
    assert.ok(body.includes('Audit reliability'))
    assert.ok(body.includes('Run progress'))
    assert.ok(body.includes('Products &'))
  }
  // Aggregate counts, never a row.
  assert.ok(html.includes('>12</td>'))
  assert.ok(html.includes('30.0%'))
})

test('an empty period is reported as pending, not as a successful zero', async () => {
  const dto = await reportFor('monthly', { empty: true })
  const { html, pdf, aggregate } = await buildCallAuditReportArtifacts(dto)
  const text = pdfText(pdf)

  assert.equal(aggregate.hasResults, false)
  assert.ok(aggregate.emptyStateNote)
  assert.equal(aggregate.resultCount, 0)
  assert.equal(aggregate.runs.progressPercent, null)
  assert.equal(aggregate.runs.runCount, 0)

  for (const body of [html, text]) {
    assert.ok(body.includes('Empty period'))
    assert.ok(body.includes('No audited call result was recorded'))
    assert.ok(body.includes('Not scored'))
    assert.ok(body.includes('Unknown'))
    assert.ok(body.includes('No run covered this period'))
  }
  // Every headline tile reports the pending state rather than a zero value.
  for (const tile of aggregate.headline) {
    assert.equal(tile.status, 'pending')
    assert.equal(tile.value, '—')
  }
})

// ---------------------------------------------------------------------------
// NA metric handling
// ---------------------------------------------------------------------------

test('an unscored metric keeps its NA count and never averages to zero', async () => {
  const dto = await reportFor('monthly')
  const { html, pdf, aggregate } = await buildCallAuditReportArtifacts(dto)

  const unscored = aggregate.metrics[0]!
  assert.equal(unscored.scoredCount, 0)
  assert.equal(unscored.notApplicableCount, 7)
  assert.equal(unscored.averageScore, null)

  const scored = aggregate.metrics[1]!
  assert.equal(scored.averageScore, '3.750')
  assert.equal(scored.notApplicableCount, 1)

  for (const body of [html, pdfText(pdf)]) {
    assert.ok(body.includes('Not scored'))
    assert.ok(body.includes('3.750'))
    assert.ok(body.includes('NA'))
  }
  // The unscored metric's row must not claim a 0 average.
  assert.equal(/Product &amp; service knowledge<\/td>.*?>0(\.0+)?<\/td>\s*<td[^>]*>0/.test(html), false)
})

// ---------------------------------------------------------------------------
// Reliability and run aggregation
// ---------------------------------------------------------------------------

test('reliability totals are summed and carry no model identity', async () => {
  const dto = await reportFor('monthly')
  const { html, pdf, aggregate } = await buildCallAuditReportArtifacts(dto)
  const reliability = aggregate.reliability

  assert.equal(reliability.attemptCount, 35)
  assert.equal(reliability.resultCount, 34)
  assert.equal(reliability.erroredCount, 5)
  assert.equal(reliability.totalTokens, '1215000')
  assert.equal(reliability.maxLatencyMs, '9000')
  assert.deepEqual(
    reliability.byAttemptOutcome.map((row) => row.label),
    ['Succeeded', 'Failed'],
  )

  for (const body of [html, pdfText(pdf)]) {
    assert.ok(body.includes('1215000'))
    assert.ok(body.includes('Errored attempts'))
    assert.equal(body.includes(SENTINELS.modelName), false)
    assert.equal(body.includes(SENTINELS.providerName), false)
  }
})

test('run progress is summarized across runs with no identifier at all', async () => {
  const dto = await reportFor('monthly', {
    runs: [
      sentinelRun('monthly'),
      sentinelRun('monthly', {
        status: 'running',
        errorCode: null,
        counters: {
          totalCandidates: 10,
          processedCount: 4,
          succeededCount: 4,
          failedCount: 0,
          skippedCount: 0,
          contentAuditableCount: 3,
          operationalOnlyCount: 1,
        },
      }),
    ],
  })
  const { html, pdf, aggregate } = await buildCallAuditReportArtifacts(dto)
  const runs = aggregate.runs

  assert.equal(runs.runCount, 2)
  assert.equal(runs.totalCandidates, 50)
  assert.equal(runs.processedCount, 44)
  assert.equal(runs.succeededCount, 35)
  assert.equal(runs.progressPercent, '88.0')
  assert.equal(runs.runsWithErrorCount, 1)
  assert.deepEqual(runs.byStatus, [
    { label: 'Running', count: 1 },
    { label: 'Completed', count: 1 },
  ])
  // The exact shape, so no identifying field can be added without review.
  assert.deepEqual(Object.keys(runs).sort(), [
    'byStatus',
    'contentAuditableCount',
    'failedCount',
    'operationalOnlyCount',
    'processedCount',
    'progressPercent',
    'runCount',
    'runsWithErrorCount',
    'skippedCount',
    'succeededCount',
    'totalCandidates',
  ])

  for (const body of [html, pdfText(pdf)]) {
    assert.ok(body.includes('88.0%'))
    assert.ok(body.includes('Runs reporting an error'))
  }
})

test('run progress with no candidates is unknown, never complete', async () => {
  const dto = await reportFor('monthly', {
    runs: [
      sentinelRun('monthly', {
        status: 'pending',
        counters: {
          totalCandidates: 0,
          processedCount: 0,
          succeededCount: 0,
          failedCount: 0,
          skippedCount: 0,
          contentAuditableCount: 0,
          operationalOnlyCount: 0,
        },
      }),
    ],
  })
  const { html, aggregate } = await buildCallAuditReportArtifacts(dto)
  assert.equal(aggregate.runs.progressPercent, null)
  assert.ok(html.includes('Unknown — no candidates claimed'))
  assert.equal(html.includes('>100.0%<'), false)
})

// ---------------------------------------------------------------------------
// Escaping
// ---------------------------------------------------------------------------

test('every label is escaped, so no label can inject markup or script', async () => {
  const dto = await reportFor('monthly')
  const hostile = '<script>alert("x")</script><img src=x onerror=\'y\'>'
  dto.sections[0]!.title = hostile
  dto.sections[0]!.caption = hostile
  dto.sections[0]!.rows[0]!.label = hostile
  dto.headline[0]!.label = hostile
  dto.headline[0]!.sub = hostile
  dto.metrics[0]!.label = hostile
  dto.reliability.byAttemptOutcome[0]!.label = hostile
  dto.reportBasis.cadenceLabel = hostile

  const html = buildCallAuditReportHtml(dto)
  assert.equal(html.includes('<script'), false)
  assert.equal(html.includes('</script'), false)
  // The attribute survives only as inert text: its quotes and brackets are gone.
  assert.equal(html.includes("onerror='y'"), false)
  assert.equal(html.includes('<img'), false)
  assert.equal(/<[a-z]+[^>]*\son[a-z]+=/i.test(html), false)
  assert.ok(html.includes('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;'))
  assert.ok(html.includes('&apos;y&apos;'))

  // The same hostile text reaches the PDF as inert text, not as a marker.
  const text = pdfText(await buildCallAuditReportPdf(dto))
  assert.ok(text.includes('<script>alert("x")</script>'))
})

test('control characters are stripped and over-long labels are truncated', async () => {
  const dto = await reportFor('monthly')
  dto.sections[0]!.title = `Hidden\u0000payload\u001f here`
  dto.sections[1]!.title = 'L'.repeat(MAX_ARTIFACT_TEXT_CHARS + 50)

  const aggregate = buildCallAuditReportAggregate(dto)
  assert.equal(aggregate.sections[0]!.title, 'Hiddenpayload here')
  assert.equal(
    aggregate.sections[1]!.title.length,
    MAX_ARTIFACT_TEXT_CHARS,
  )
  assert.ok(aggregate.sections[1]!.title.endsWith('...'))
})

// ---------------------------------------------------------------------------
// PDF shape and size
// ---------------------------------------------------------------------------

test('the PDF is a real A4 document within the artifact size bound', async () => {
  const dto = await reportFor('quarterly')
  const { pdf, pdfArtifact, html, htmlArtifact } =
    await buildCallAuditReportArtifacts(dto)

  assert.equal(pdf.subarray(0, 5).toString('latin1'), '%PDF-')
  assert.ok(pdf.subarray(-1024).toString('latin1').includes('%%EOF'))
  assert.ok(pdf.toString('latin1').includes('/MediaBox [0 0 595.28 841.89]'))
  assert.ok(pdf.byteLength > 1000)
  assert.ok(pdf.byteLength <= MAX_ARTIFACT_PDF_BYTES)
  assert.equal(pdfArtifact.byteLength, pdf.byteLength)
  assert.equal(pdfArtifact.mediaType, CALL_AUDIT_PDF_MEDIA_TYPE)

  assert.ok(html.startsWith('<!doctype html>'))
  assert.equal(htmlArtifact.byteLength, Buffer.byteLength(html, 'utf8'))
  assert.ok(htmlArtifact.byteLength <= MAX_ARTIFACT_HTML_BYTES)
  assert.equal(htmlArtifact.mediaType, CALL_AUDIT_HTML_MEDIA_TYPE)
})

test('the HTML is self-contained: no remote reference and no script', async () => {
  const html = buildCallAuditReportHtml(await reportFor('monthly'))
  for (const pattern of [
    /<script/i,
    /<link/i,
    /<iframe/i,
    /https?:\/\//i,
    /url\(/i,
    /on[a-z]+=/i,
    /<img/i,
  ]) {
    assert.equal(pattern.test(html), false, `${pattern} must not appear`)
  }
  assert.ok(html.includes(CALL_AUDIT_ARTIFACT_SCOPE))
  assert.ok(html.includes(CALL_AUDIT_ARTIFACT_QUALITY_ONLY_NOTE))
})

test('the same DTO always produces byte-identical artifacts', async () => {
  const dto = await reportFor('yearly')
  const first = await buildCallAuditReportArtifacts(dto)
  const second = await buildCallAuditReportArtifacts(dto)
  assert.equal(first.html, second.html)
  assert.ok(first.pdf.equals(second.pdf))
})

// ---------------------------------------------------------------------------
// Filenames and media metadata
// ---------------------------------------------------------------------------

test('a filename is derived only from cadence and validated period dates', () => {
  assert.equal(
    callAuditArtifactFilename('monthly', PERIOD, 'pdf'),
    'kserve-call-audit-monthly-2026-07-01-to-2026-08-01.pdf',
  )
  assert.equal(
    callAuditArtifactFilename(
      'daily',
      {
        periodStart: '2026-07-01 09:30:00',
        periodEndExclusive: '2026-07-02 09:30:00',
      },
      'html',
    ),
    'kserve-call-audit-daily-2026-07-01t093000-to-2026-07-02t093000.html',
  )
  for (const cadence of CADENCES) {
    const filename = callAuditArtifactFilename(cadence, PERIOD, 'pdf')
    assert.match(filename, /^[a-z0-9.\-]+$/)
    assert.ok(filename.length <= 120)
  }
})

test('a filename cannot be built from an unaccepted cadence or period', () => {
  assert.throws(
    () =>
      callAuditArtifactFilename(
        'weekly' as CallAuditReportCadence,
        PERIOD,
        'pdf',
      ),
    (error: unknown) =>
      error instanceof CallAuditArtifactError &&
      error.code === 'INVALID_CALL_AUDIT_ARTIFACT_INPUT' &&
      error.field === 'reportBasis.cadence',
  )
  assert.throws(
    () =>
      callAuditArtifactFilename(
        'monthly',
        {
          periodStart: '2026-07-01T00:00:00Z',
          periodEndExclusive: '2026-08-01 00:00:00',
        },
        'pdf',
      ),
    (error: unknown) =>
      error instanceof CallAuditArtifactError &&
      error.field === 'reportBasis.periodStart' &&
      error.reason === 'is not a UTC-naive timestamp',
  )
})

// ---------------------------------------------------------------------------
// Aggregate-only guarantee
// ---------------------------------------------------------------------------

test('the drilldown array is never read while building an artifact', async () => {
  const dto = await reportFor('monthly')
  assert.ok(dto.results.length > 0, 'the fixture must carry drilldown rows')

  const guarded = { ...dto }
  Object.defineProperty(guarded, 'results', {
    enumerable: true,
    get() {
      throw new Error('the artifact builder read dto.results')
    },
  })

  const artifacts = await buildCallAuditReportArtifacts(
    guarded as CallAuditReportDto,
  )
  assert.ok(artifacts.pdf.byteLength > 0)
  assert.equal(
    Object.keys(artifacts.aggregate).includes('results'),
    false,
  )
})

test('no planted sentinel survives into any artifact surface', async () => {
  for (const cadence of CADENCES) {
    const dto = await reportFor(cadence)
    const artifacts = await buildCallAuditReportArtifacts(dto)

    assertNoSentinel(artifacts.html, `${cadence} html`)
    assertNoSentinel(pdfText(artifacts.pdf), `${cadence} pdf text`)
    assertNoSentinel(
      artifacts.pdf.toString('latin1'),
      `${cadence} pdf bytes`,
    )
    assertNoSentinel(artifacts.htmlArtifact.filename, `${cadence} html name`)
    assertNoSentinel(artifacts.pdfArtifact.filename, `${cadence} pdf name`)
    assertNoSentinel(
      JSON.stringify(artifacts.aggregate),
      `${cadence} aggregate metadata`,
    )
    assertNoSentinel(
      JSON.stringify([artifacts.htmlArtifact, artifacts.pdfArtifact]),
      `${cadence} attachment metadata`,
    )
  }
})

test('no money, billing, or source field reaches an artifact', async () => {
  const { html, pdf, aggregate } = await buildCallAuditReportArtifacts(
    await reportFor('monthly'),
  )
  const surfaces = [html, pdfText(pdf), JSON.stringify(aggregate)]
  for (const surface of surfaces) {
    for (const pattern of [
      /money/i,
      /currency/i,
      /invoice/i,
      /revenue/i,
      /variance/i,
      /\bprice/i,
      /\bamount/i,
      /\bcost/i,
      /billing/i,
      /billable/i,
      /\brate\b/i,
      /₹|\bINR\b|\bRs\.?\b|\$|€/,
      /task id/i,
      /taskId/,
      /resultId/,
      /runId/i,
      /sha256/i,
      /recording/i,
      /hasTranscript/i,
      /businessPrompt/i,
      /scoringConfig/i,
      /errorDetail/i,
      /resultJson/i,
    ]) {
      assert.equal(
        pattern.test(surface),
        false,
        `${pattern} must not appear in an artifact`,
      )
    }
  }
  // The bare words "transcript" and "prompt" are not banned outright: the
  // accepted DTO's eligibility caption is written in report language. What is
  // banned is a transcript or a prompt VALUE, which the sentinel test proves.
  assert.ok(
    html.includes('Whether a usable transcript existed for content scoring.'),
  )
  assert.equal(html.includes(SENTINELS.transcript), false)
  assert.equal(html.includes(SENTINELS.businessPrompt), false)
})

// ---------------------------------------------------------------------------
// Bounds and errors
// ---------------------------------------------------------------------------

test('a DTO beyond an artifact bound is rejected with a stable field and code', async () => {
  const dto = await reportFor('monthly')
  const oversized = {
    ...dto,
    sections: Array.from(
      { length: MAX_ARTIFACT_SECTIONS + 1 },
      () => dto.sections[0]!,
    ),
  }
  assert.throws(
    () => buildCallAuditReportHtml(oversized as CallAuditReportDto),
    (error: unknown) =>
      error instanceof CallAuditArtifactError &&
      error.code === 'INVALID_CALL_AUDIT_ARTIFACT_INPUT' &&
      error.field === 'sections' &&
      error.reason === 'exceeds the artifact bound',
  )
})

test('a rejected value is never echoed by the error it causes', async () => {
  const dto = await reportFor('monthly')
  const broken = {
    ...dto,
    reliability: {
      ...dto.reliability,
      totalTokens: SENTINELS.resultJson,
    },
  }
  assert.throws(
    () => buildCallAuditReportHtml(broken as CallAuditReportDto),
    (error: unknown) => {
      assert.ok(error instanceof CallAuditArtifactError)
      assert.equal(error.field, 'reliability.totalTokens')
      assert.equal(error.reason, 'is not a numeric string')
      assertNoSentinel(String(error.message), 'error message')
      assertNoSentinel(String(error.stack ?? ''), 'error stack')
      return true
    },
  )
})

test('a report that is not the accepted Call Audit report is rejected', async () => {
  const dto = await reportFor('monthly')
  for (const [field, mutation] of [
    ['title', { title: 'Monthly Revenue Report' }],
    ['aiCaller', { aiCaller: 'Someone Else' }],
    [
      'reportBasis.boundaryBasis',
      { reportBasis: { ...dto.reportBasis, boundaryBasis: 'local_closed' } },
    ],
    [
      'reportBasis.periodEndExclusive',
      {
        reportBasis: {
          ...dto.reportBasis,
          periodEndExclusive: dto.reportBasis.periodStart,
        },
      },
    ],
  ] as const) {
    assert.throws(
      () =>
        buildCallAuditReportAggregate({
          ...dto,
          ...mutation,
        } as CallAuditReportDto),
      (error: unknown) =>
        error instanceof CallAuditArtifactError && error.field === field,
      `${field} must be rejected`,
    )
  }
})

// ---------------------------------------------------------------------------
// Module boundaries
// ---------------------------------------------------------------------------

const MODULE_SOURCE = readFileSync(
  new URL('./callAuditReportArtifacts.ts', import.meta.url),
  'utf8',
)

/** Source with comments, then string and template literals, blanked out. */
const EXECUTABLE_SOURCE = MODULE_SOURCE.split('\n')
  .filter((line) => !line.trimStart().startsWith('*'))
  .filter((line) => !line.trimStart().startsWith('//'))
  .filter((line) => line.trimStart() !== '/**')
  .join('\n')
  .replace(/"(?:\\.|[^"\\])*"/g, '""')
  .replace(/'(?:\\.|[^'\\])*'/g, "''")
  .replace(/`(?:\\.|[^`\\])*`/g, '``')

function importSpecifiers(source: string): string[] {
  return [...source.matchAll(/from\s+'([^']+)'/g)].map((match) => match[1])
}

test('the artifact module imports no billing, source, model, transport, or storage module', () => {
  const specifiers = importSpecifiers(MODULE_SOURCE)
  assert.deepEqual(specifiers.sort(), [
    '../adapters/mysqlCallAuditControl.ts',
    '../adapters/mysqlCallAuditReporting.ts',
    '../callaudit/types.ts',
    './callAuditReport.ts',
    'pdfkit',
  ])
  for (const specifier of specifiers) {
    for (const forbidden of [
      /^mysql2/,
      /^openai$/,
      /^nodemailer$/,
      /^jose$/,
      /^fflate$/,
      /^express$/,
      /^@aws-sdk/,
      /^node:/,
      /billing/i,
      /monthlyEmailReport/,
      /reportAttachments/i,
      /reportEmail/i,
      /cyclePreview/i,
      /\/ui\//,
      /\/http\//,
      /\/cli\//,
      /\/storage\//,
      /\/security\//,
      /\/vercel\//,
      /email/i,
      /scheduler/i,
      /worker/i,
      /kcrm/i,
      /decimal/i,
      /openai/i,
    ]) {
      assert.equal(
        forbidden.test(specifier),
        false,
        `${specifier} must not be imported here`,
      )
    }
  }
})

test('both MySQL adapters are type-only ports, so no database module is loaded', () => {
  for (const adapter of [
    '../adapters/mysqlCallAuditReporting.ts',
    '../adapters/mysqlCallAuditControl.ts',
  ]) {
    assert.match(
      MODULE_SOURCE,
      new RegExp(`import type \\{[^}]*\\} from '${adapter.replace(/\./g, '\\.')}'`),
    )
  }
})

test('the artifact module names no money, drilldown, or per-row identifier', () => {
  for (const forbidden of [
    /money/i,
    /currency/i,
    /invoice/i,
    /revenue/i,
    /variance/i,
    /\bprice/i,
    /\bamount/i,
    /\bcost/i,
    /billing/i,
    /billable/i,
    /\brate\b/i,
    /formatMoney/,
    /\bresults\b/,
    /taskId/i,
    /resultId/i,
    /\brunId\b/i,
    /sourceRefId/i,
    /transcript/i,
    /\bprompt/i,
    /sha256/i,
    /providerName/i,
    /modelName/i,
    /modelVersion/i,
    /managementFeedback/i,
    /kserveFeedback/i,
    /improvementFeedback/i,
    /ruleVersion/i,
    /process\.env/,
    /require\(/,
    /readFile|writeFile/i,
    /fetch\(/,
    /console\./,
  ]) {
    assert.equal(
      forbidden.test(EXECUTABLE_SOURCE),
      false,
      `${forbidden} must not appear in the executable source`,
    )
  }
})
