export type TileStatus = 'good' | 'warn' | 'neutral' | 'pending'

export interface Tile {
  label: string
  value: string
  sub?: string
  status: TileStatus
}

export interface Gate {
  code: string
  label: string
  detail: string
  status: 'ready' | 'blocked' | 'pending'
}

export interface Profile {
  id: string
  email: string
  roles: string[]
  permissions: string[]
  authMode: string
  accessControlEnforced: boolean
  contentAccess: string
}

export interface AuthConfig {
  mode: 'oidc' | 'local' | 'preview'
  providerLabel: string
  loginUrl: string | null
  logoutUrl: string | null
  accessControlEnforced: boolean
  passwordLoginSupported: boolean
}

export interface BillingPeriodsData {
  generatedAt: string
  defaultMonth: string | null
  months: Array<{
    month: string
    start: string
    end: string
    label: string
    callCount: number
    invoiceCount: number
  }>
}

export interface OverviewData {
  generatedAt: string
  tiles: Tile[]
  gates: Gate[]
}

export interface EvidenceData {
  generatedAt: string
  tiles: Tile[]
  integrityFindings: Array<{ action: string; n: number }>
}

export interface QualityData {
  generatedAt: string
  authority: 'uncalibrated' | 'calibrated' | 'automated'
  quality: {
    tiles: Tile[]
    confirmations: Array<{ label: string; n: number }>
    origins: Array<{ label: string; n: number }>
    topFindings: Array<{
      code: string
      n: number
      avgConfidence: string | null
      confidenceLabel: string
    }>
    catalogLabel: string
  }
}

export interface BillingData {
  generatedAt: string
  authority: 'provisional' | 'authoritative'
  billing: {
    tiles: Tile[]
    rateCardLabel: string
    rateCardApproved: boolean
    rateCardApprovalLabel: string
    calculationsAuthoritative: boolean
    calculationAuthorityLabel: string
    reconciliationStatus: string
    cycleStatusLabel: string
    cycle: BillingCycle
  }
}

export interface BillingCycle {
  periodStart: string | null
  periodEnd: string | null
  totalCalls: number
  recordingAvailableCalls: number
  completedAuditCalls: number
  acceptedAsBilledCalls: number
  finalCalculationCalls: number | null
  unresolvedDecisionCalls: number | null
  processingFailureCalls: number
  resolvedAuditCalls: number
  auditPendingCalls: number
  auditCoveragePercent: string
  rateCardApproved: boolean
  calibrationComplete: boolean
  status:
    | 'no_data'
    | 'audit_pending'
    | 'calibration_pending'
    | 'rate_card_pending'
    | 'calculation_pending'
    | 'ready'
  billGenerated: boolean
}

export interface Snapshot {
  cadence: 'weekly' | 'monthly' | 'quarterly' | 'yearly'
  label: string
  period: string
  verified: string
  vendorClaimed: string
  variance: string
  varianceRaw: string | null
  basisLabel: string
  trend: 'up' | 'down' | 'flat' | 'unknown'
  trendLabel: string
}

export interface ReportsData {
  generatedAt: string
  authority: 'audit_pending' | 'provisional' | 'authoritative'
  billingCycle: BillingCycle
  snapshots: Snapshot[]
  emailDelivery: {
    configured: boolean
    status: string
    attempts: number
    sentAt: string | null
    lastErrorCode: string | null
  } | null
}

export interface StatusCount {
  status: string
  count: number
}

export interface OperationsData {
  generatedAt: string
  outbox: StatusCount[]
  inbox: StatusCount[]
  jobs: StatusCount[]
  idempotency: StatusCount[]
  auditEvents: number | null
  auditChainConfigured: boolean | null
}

export interface AuditMonitorRow {
  callReference: string
  billingPeriodDate: string | null
  category: string
  outcomeTaxonomyVersion: string | null
  confidence: string | null
  confirmationStatus: string
  language: string
  asrProvider: string | null
  asrModel: string | null
  asrModelVersion: string | null
  auditEngineVersion: string | null
  recordedDurationMs: number | null
  speechDurationMs: number | null
  conversationEndMs: number | null
  graceAdjustedDurationMs: number | null
  vendorConnectedDurationMs: number | null
  varianceDurationMs: number | null
  evidenceHashRecorded: boolean
  lastEvidenceVerifiedAt: string | null
  auditedAt: string | null
  aiUsage: {
    inputTokens: number | null
    outputTokens: number | null
    totalTokens: number | null
    audioSeconds: string | null
  }
}

export interface AuditQueueRow {
  callReference: string
  billingPeriodDate: string | null
  processingStatus: string
  attemptCount: number
  evidenceHashRecorded: boolean
  lastEvidenceVerifiedAt: string | null
  vendorBilledMinutes: string | null
  vendorConnectedDurationMs: number | null
  auditorAmount: string | null
  billingStatus: string | null
  billingBasis: string | null
  lastActivityAt: string | null
}

export interface AuditPagination {
  page: number
  pageSize: number
  totalRows: number
  totalPages: number
}

export interface AuditMonitorData {
  generatedAt: string
  summary: {
    totalCalls: number
    aiAuditedCalls: number
    auditCoveragePercent: string
    recordingAvailableCalls: number
    pendingEligibleCalls: number
    noRecordingCalls: number
    processingFailureCalls: number
    reauditV2Calls: number
    aiUsage: {
      trackedAuditRuns: number
      gptInputTokens: number
      gptOutputTokens: number
      gptTotalTokens: number
      whisperAudioSeconds: string
      historicalUsageRecorded: boolean
    }
    auditedFinancials: {
      scopedAuditedCalls: number
      aiSpendTrackedCalls: number
      aiSpendUntrackedCalls: number
      estimatedAiSpendUsd: string
      aiSpendPricingVersion: string
      aiSpendPricingBasis: string
      unpricedAiUsageRows: number
      kservePricedCalls: number
      kserveChargeInr: string
      auditorCalculatedCalls: number
      auditorChargeInr: string
    }
  }
  rows: AuditMonitorRow[]
  pendingRows: AuditQueueRow[]
  noRecordingRows: AuditQueueRow[]
  pagination: AuditPagination
  pendingPagination: AuditPagination
  noRecordingPagination: AuditPagination
  filters: {
    category: string | null
    language: string | null
    availableCategories: string[]
    availableLanguages: string[]
  }
  authority: 'automated'
  contentBoundary: string
}

export interface AdminCallDetailData {
  generatedAt: string
  call: {
    reference: string
    billingPeriodDate: string | null
    sensitivityTier: string
    category: string | null
    confirmationStatus: string | null
    confidence: string | null
    language: string | null
    auditEngineVersion: string | null
    auditedAt: string | null
  }
  evidence: {
    recordingAvailable: boolean
    evidenceHashRecorded: boolean
    lastVerifiedAt: string | null
  }
  durations: {
    recordedMs: number | null
    speechMs: number | null
    finalCustomerExchangeMs: number | null
    vendorConnectedMs: number | null
  }
  comparison: {
    currency: 'INR'
    kserve: {
      basis: string
      billedMinutes: string | null
      unitRate: string
      amount: string | null
    }
    auditor: {
      basis: string | null
      status: string | null
      billableDurationMs: number | null
      billableMinutes: string | null
      unitRate: string | null
      amount: string | null
      ruleCode: string | null
      billingIncrement: string | null
      rateCardVersion: string | null
      rateCardStatus: string | null
    }
    variance: string | null
  }
  transcript: {
    available: boolean
    segments: Array<{
      startMs: number
      endMs: number
      text: string
    }>
  }
}

/**
 * Sanitized Call Audit reporting. Every shape below mirrors the server DTO in
 * `src/reporting/callAuditReport.ts`, which is assembled by explicit field copy:
 * there is deliberately no transcript, lead id, hash, URL, source row id,
 * prompt, model identity, provider error prose, or money field here, and the
 * only call identity is the approved anonymous Task ID.
 */
export type CallAuditCadence = 'daily' | 'monthly' | 'quarterly' | 'yearly'

export interface CallAuditReportBasis {
  cadence: CallAuditCadence
  cadenceLabel: string
  runTypes: string[]
  periodStart: string
  periodEndExclusive: string
  periodLabel: string
  boundaryBasis: 'utc_naive_half_open'
  periodDefaulted: boolean
  resultLimit: number
}

export interface CallAuditBreakdownRow {
  code: string
  label: string
  count: number
  /** Null when nothing was counted — an absent share is never rendered as 0%. */
  sharePercent: string | null
}

export interface CallAuditReportSection {
  key: string
  title: string
  caption: string
  total: number
  rows: CallAuditBreakdownRow[]
  emptyBucketCount: number
}

export interface CallAuditMetricRow {
  metricCode: string
  label: string
  weight: number
  scoredCount: number
  notApplicableCount: number
  /** Null when nothing was scored. Never rendered as a score of zero. */
  averageScore: string | null
  distribution: Record<string, number>
}

export interface CallAuditResultRow {
  resultId: string
  runId: string
  taskId: string | null
  effectiveCallAt: string
  callDurationSeconds: number | null
  hasTranscript: boolean
  company: string | null
  companyByKserve: string | null
  serviceCategory: string | null
  callType: string | null
  callStatus: string | null
  finalCallStatus: string | null
  aiCallCategory: string | null
  customerEngagementLevel: string | null
  interestLevel: string | null
  callOutcome: string | null
  leadStatus: string | null
  finalLeadOutcome: string | null
  calculatedQualificationStatus: string | null
  followupRequired: string | null
  processingStatus: string
  processingStatusLabel: string
  eligibility: string
  eligibilityLabel: string
  ineligibilityReason: string | null
  /** Null means the audit did not determine it; never rendered as "no". */
  callConnected: boolean | null
  customerSpoke: boolean | null
  meaningfulConversation: boolean | null
  intent: string | null
  intentLabel: string | null
  intentConfidence: string | null
  detailedOutcome: string | null
  groupedOutcome: string | null
  groupedOutcomeLabel: string | null
  qualificationLabel: string | null
  nextActionCode: string | null
  nextActionLabel: string | null
  overallScore: string | null
  overallScoreMethod: string | null
  kserveReportedOutcome: string | null
  kserveComparisonLabel: string | null
  kserveComparisonText: string | null
  mismatchSeverity: string | null
  mismatchSeverityText: string | null
  managementFeedback: string | null
  kserveFeedback: string | null
  improvementFeedback: string | null
  issueFlags: Array<{ code: string; label: string }>
  auditedAt: string | null
}

export interface CallAuditReliabilityRow {
  attemptOutcome: string
  label: string
  attemptCount: number
  resultCount: number
  erroredCount: number
  totalTokens: string
  averageLatencyMs: string | null
}

export interface CallAuditReliability {
  attemptCount: number
  resultCount: number
  erroredCount: number
  maxAttemptNumber: number
  inputTokens: string
  outputTokens: string
  totalTokens: string
  averageLatencyMs: string | null
  maxLatencyMs: string | null
  byAttemptOutcome: CallAuditReliabilityRow[]
}

export interface CallAuditRunRow {
  runId: string
  runType: string
  ruleVersionLabel: string
  status: string
  statusLabel: string
  periodStart: string
  periodEndExclusive: string
  periodTimezone: string
  totalCandidates: number
  processedCount: number
  succeededCount: number
  failedCount: number
  skippedCount: number
  contentAuditableCount: number
  operationalOnlyCount: number
  /** Null when the run has no candidates: unknown progress is never 100%. */
  progressPercent: string | null
  errorCode: string | null
  startedAt: string | null
  finishedAt: string | null
}

export interface CallAuditReportData {
  generatedAt: string
  title: string
  aiCaller: string
  contentBoundary: string
  reportBasis: CallAuditReportBasis
  hasResults: boolean
  headline: Tile[]
  summary: {
    resultCount: number
    auditedCallCount: number
    byProcessingStatus: Record<string, number>
    byEligibility: Record<string, number>
    byIntent: Record<string, number>
    byGroupedOutcome: Record<string, number>
    byKserveComparison: Record<string, number>
    byMismatchSeverity: Record<string, number>
    byQualification: Record<string, number>
    byNextAction: Record<string, number>
    byIssueFlag: Record<string, number>
  }
  sections: CallAuditReportSection[]
  metrics: CallAuditMetricRow[]
  results: CallAuditResultRow[]
  resultsTruncated: boolean
  reliability: CallAuditReliability
  runs: CallAuditRunRow[]
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly correlationId: string | null,
  ) {
    super(message)
  }
}

export async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(path, {
    credentials: 'same-origin',
    headers: { accept: 'application/json' },
  })
  const correlationId = response.headers.get('x-correlation-id')
  if (!response.ok) {
    let message = 'The request could not be completed.'
    try {
      const problem = (await response.json()) as { title?: string }
      message = problem.title || message
    } catch {
      // The server intentionally returns a generic client-safe error.
    }
    throw new ApiError(message, response.status, correlationId)
  }
  return response.json() as Promise<T>
}

export async function postJson<T>(
  path: string,
  value: unknown,
): Promise<T> {
  const response = await fetch(path, {
    method: 'POST',
    credentials: 'same-origin',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
    },
    body: JSON.stringify(value),
  })
  const correlationId = response.headers.get('x-correlation-id')
  if (!response.ok) {
    let message = 'The request could not be completed.'
    try {
      const problem = (await response.json()) as { title?: string }
      message = problem.title || message
    } catch {
      // Keep the privacy-safe fallback.
    }
    throw new ApiError(message, response.status, correlationId)
  }
  return response.json() as Promise<T>
}

export interface ImportStatus {
  enabled: boolean
  invoiceAiEnabled: boolean
  storageBoundary: string
  recentBatches: Array<{
    id: string
    type: string
    periodStart: string | null
    periodEnd: string | null
    status: string
    received: number
    accepted: number
    rejected: number
    duplicates: number
    startedAt: string
  }>
  recentInvoices: Array<{
    id: string
    invoiceNumber: string
    periodStart: string
    periodEnd: string
    totalAmount: string
    status: string
  }>
}

export interface UsageImportPreview {
  method: 'deterministic'
  periodStart: string
  periodEnd: string
  rowCount: number
  recordingUrlCount: number
  missingRecordingUrlCount: number
  recognizedColumns: string[]
  warnings: string[]
}

export interface InvoiceImportPreview {
  method: 'openai'
  model: string
  invoiceNumber: string
  invoiceDate: string
  periodStart: string
  periodEnd: string
  subtotalAmount: string
  taxAmount: string
  totalAmount: string
  currency: 'INR'
  confidence: string
  warnings: string[]
}

export interface ImportResult {
  outcome: 'imported' | 'duplicate'
  referenceId: string
  received: number
  accepted: number
  duplicates: number
  auditJobsQueued: number
  missingRecordingUrls: number
}

/**
 * Admin-only Call Audit RULE SETTINGS.
 *
 * Deliberately declared below `ApiError` and apart from the sanitized reporting
 * types above: these shapes carry model configuration and administrator-authored
 * prompt text, which belong to the admin settings screen alone and must never
 * be reachable from the reporting page. There is still no transcript, lead
 * identity, source reference, model output, or money field here — Call Audit is
 * a separate module from Billing Audit.
 */
export interface CallAuditRuleVersion {
  ruleVersionId: string
  versionLabel: string
  status: string
  statusLabel: string
  isActive: boolean
  modelProvider: string
  modelName: string
  modelVersion: string
  /** Fixed-precision decimal string with exactly three places. */
  temperature: string
  ruleContractVersion: string
  outputSchemaVersion: string
  taxonomyVersion: string
  scoringConfigVersion: string
  promptSha256: string
  configSha256: string
  matchesApplicationContract: boolean
  changeReason: string | null
  createdBy: string | null
  createdAt: string | null
  activatedBy: string | null
  activatedAt: string | null
  retiredBy: string | null
  retiredAt: string | null
}

export interface CallAuditRuleVersionDetail extends CallAuditRuleVersion {
  /** Administrator-authored configuration text, never call evidence. */
  businessPrompt: string
  businessPromptLength: number
}

export interface CallAuditSettingsRun {
  runId: string
  ruleVersionId: string
  ruleVersionLabel: string | null
  runType: string
  status: string
  statusLabel: string
  periodStart: string
  periodEndExclusive: string
  periodTimezone: string
  totalCandidates: number
  processedCount: number
  succeededCount: number
  failedCount: number
  skippedCount: number
  errorCode: string | null
  startedAt: string | null
  finishedAt: string | null
}

export interface CallAuditSettingsContract {
  ruleContractVersion: string
  outputSchemaVersion: string
  taxonomyVersion: string
  scoringConfigVersion: string
  configSha256: string
  temperatureDecimals: number
  minTemperature: string
  maxTemperature: string
  maxVersionLabelLength: number
  maxBusinessPromptLength: number
  maxChangeReasonLength: number
  maxModelProviderLength: number
  maxModelNameLength: number
  maxModelVersionLength: number
  editableFields: string[]
  lockedFields: string[]
}

export interface CallAuditSettingsData {
  generatedAt: string
  title: string
  boundary: string
  contract: CallAuditSettingsContract
  activeVersion: CallAuditRuleVersion | null
  versions: CallAuditRuleVersion[]
  versionCount: number
  detail: CallAuditRuleVersionDetail | null
  recentRuns: CallAuditSettingsRun[]
  activationAvailable: boolean
}

export interface CallAuditRuleVersionCreated {
  ruleVersionId: string
  versionLabel: string
  status: string
  statusLabel: string
  outcome: 'inserted' | 'replayed'
  activated: boolean
  promptSha256: string
  configSha256: string
  createdAt: string
}

/**
 * Admin rule TEST LAB response types.
 *
 * These mirror the sanitized server DTO exactly, and their shape is the privacy
 * guarantee: the submitted text, the compiled prompt, the model's prose fields,
 * the raw provider payload, and any provider error message have no field to
 * arrive in. What survives a test is countable or coded — lengths, enum labels,
 * token counts, one bounded error code — so a screen rendering the whole result
 * still cannot render evidence.
 */

/** What was exercised, in facts that carry no submitted content. */
export interface CallAuditRuleTestMetadata {
  versionLabel: string
  modelProvider: string
  modelName: string
  modelVersion: string
  /** Fixed-precision decimal string with exactly three places. */
  temperature: string
  /** Derived from the submitted text; the text itself is never returned. */
  transcriptCharacterCount: number
  transcriptLineCount: number
  /** The safe context actually sent, echoed so a test is reproducible. */
  context: {
    language: string | null
    durationSeconds: number | null
  }
}

/**
 * Lengths of the three free-text fields the model produced. The texts stay
 * server-side; the keys say `CharacterCount` so neither a reader nor a privacy
 * assertion can mistake one for the text.
 */
export interface CallAuditRuleTestFeedbackLengths {
  managementSummaryCharacterCount: number
  kserveFeedbackCharacterCount: number
  improvementFeedbackCharacterCount: number
}

export interface CallAuditRuleTestMetricScore {
  /** Rubric metric code, e.g. 'OPENING'. */
  metric: string
  /** Integer 1–5, or 'NA' when the metric does not apply to the call. */
  score: number | 'NA'
}

/** Every coded field of a validated audit output, and no prose. */
export interface CallAuditRuleTestOutput {
  callConnected: boolean
  customerSpoke: boolean
  meaningfulConversation: boolean
  intent: string
  detailedOutcome: string
  /** Derived server-side from detailedOutcome; a model cannot choose it. */
  groupedOutcome: string
  qualification: string
  nextAction: string
  confidence: number
  metricScores: CallAuditRuleTestMetricScore[]
  /** Derived server-side from metricScores. Fixed-precision decimal string. */
  overallScore: string | null
  issueFlags: string[]
  feedbackLengths: CallAuditRuleTestFeedbackLengths
}

/**
 * Operational facts about one attempt. Token counts are canonical decimal
 * STRINGS so a count beyond Number.MAX_SAFE_INTEGER survives unrounded, and
 * null means the provider reported nothing rather than zero.
 */
export interface CallAuditRuleTestUsage {
  provider: string
  modelName: string
  modelVersion: string
  requestId: string | null
  inputTokens: string | null
  outputTokens: string | null
  totalTokens: string | null
  latencyMs: string
}

/** Why an attempt yielded no validated output. A code, never provider prose. */
export interface CallAuditRuleTestFailure {
  kind: 'refusal' | 'invalid_output' | 'transport'
  errorCode: string
}

export type CallAuditRuleTestResult =
  | {
      status: 'succeeded'
      metadata: CallAuditRuleTestMetadata
      output: CallAuditRuleTestOutput
      usage: CallAuditRuleTestUsage
    }
  | {
      status: 'refused'
      metadata: CallAuditRuleTestMetadata
      failure: CallAuditRuleTestFailure
      usage: CallAuditRuleTestUsage
    }
  | {
      status: 'failed'
      metadata: CallAuditRuleTestMetadata
      failure: CallAuditRuleTestFailure
      /** Null when the port threw and produced no facts at all. */
      usage: CallAuditRuleTestUsage | null
    }

export interface CallAuditRuleTestResponse {
  generatedAt: string
  boundary: string
  /** Which configuration was exercised. Never a call or caller identity. */
  ruleVersionId: string
  result: CallAuditRuleTestResult
}

export async function postFile<T>(
  path: string,
  file: File,
  metadata: Record<string, string>,
): Promise<T> {
  const response = await fetch(path, {
    method: 'POST',
    credentials: 'same-origin',
    headers: {
      accept: 'application/json',
      'content-type': file.type || 'application/octet-stream',
      'x-kaudit-filename': file.name,
      ...Object.fromEntries(
        Object.entries(metadata).map(([name, value]) => [
          `x-kaudit-${name}`,
          value,
        ]),
      ),
    },
    body: file,
  })
  const correlationId = response.headers.get('x-correlation-id')
  if (!response.ok) {
    let message = 'The upload could not be completed.'
    try {
      const problem = (await response.json()) as { title?: string }
      message = problem.title || message
    } catch {
      // Keep the privacy-safe fallback.
    }
    throw new ApiError(message, response.status, correlationId)
  }
  return response.json() as Promise<T>
}
