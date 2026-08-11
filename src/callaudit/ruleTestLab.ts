import {
  CallAuditModelRequestError,
  CONTENT_AUDIT_ERROR_CODES,
  type ActivatedContentAuditModel,
  type ContentAuditCallContext,
  type ContentAuditFailure,
  type ContentAuditModelAdapter,
  type ContentAuditModelResult,
  type ContentAuditUsageFacts,
} from '../adapters/openaiCallAuditModel.ts'
import type { ValidatedContentAuditOutput } from './modelOutput.ts'
import { validateRuleDraft, type ValidatedRuleSettings } from './ruleContract.ts'

/**
 * Admin-only Call Audit RULE TEST LAB: run one activated rule version against
 * one transient transcript and report what the rule would have produced.
 *
 * Scope, and nothing else: validate the caller's own inputs, call the injected
 * content-audit model port exactly once, and project the outcome into a
 * sanitized DTO an admin settings screen can render. This module owns no HTTP
 * route, page, database, run, batch, scheduler, retry policy, clock, or id
 * generator, and it persists nothing — a test-lab attempt leaves no record.
 *
 * Privacy boundary. The transcript is TRANSIENT. It reaches exactly one place,
 * the injected adapter's request, and is never persisted, logged, hashed,
 * echoed into an error, or placed on the returned value. Neither is the
 * business prompt, the compiled prompt, the raw provider payload, a refusal
 * string, or a provider error message. Only two derived facts about the
 * transcript survive the call — its character and line counts — and neither
 * reveals content. Nothing identifying a caller (lead ID, Task ID, source row
 * id, source URL, name, phone, email, or any source column) exists in any shape
 * here, because none of it is accepted as input in the first place.
 *
 * Separation. Call Audit is not Billing Audit. No money value is read, derived,
 * returned, or imported; token counts and elapsed milliseconds pass through as
 * operational facts about one attempt and are never turned into a chargeable
 * figure. The accompanying test asserts the whole vocabulary of money is absent
 * from this file.
 *
 * Validation ownership. The rule contract validator and the model adapter stay
 * authoritative for the settings and the transcript respectively, and their
 * typed, value-free errors propagate unchanged rather than being restated here.
 * Only this module's own inputs — the request envelope, the injected port, and
 * the transcript's TYPE — are checked below.
 */

/** Stated on the surface so the screen can label what it is showing. */
export const CALL_AUDIT_RULE_TEST_BOUNDARY =
  'Administrator test space. The submitted transcript is held in memory for ' +
  'one model call and is never stored, logged, or returned. Results are for ' +
  'inspecting a rule version and are not recorded as an audit of any call.'

/** Typed input failure. Names the offending field, never its value. */
export class CallAuditRuleTestError extends Error {
  readonly code = 'INVALID_CALL_AUDIT_RULE_TEST'
  readonly field: string

  constructor(field: string, reason: string) {
    super(`${field}: ${reason}`)
    this.field = field
  }
}

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

export interface CallAuditRuleTestRequest {
  /**
   * The activated/validated rule version under test. A full rule activation
   * satisfies it and may be passed straight through.
   */
  activation: ActivatedContentAuditModel
  /**
   * The administrator's synthetic or pasted transcript. In memory only, for
   * this one request; never persisted or returned.
   */
  transcript: string
  /** Optional safe context, limited to what the adapter already accepts. */
  context?: ContentAuditCallContext
  /** Injected content model port. Called exactly once. */
  model: ContentAuditModelAdapter
}

/**
 * One administrator submission, before a rule version has been resolved.
 *
 * This is the whole vocabulary the surface accepts. There is no lead id, source
 * row id, URL, phone, email, customer name, source column, or money field in it,
 * so none can be submitted, forwarded, or echoed back.
 */
export interface CallAuditRuleTestSubmission {
  transcript: string
  /** Null means "whatever version is active"; the caller resolves it. */
  ruleVersionId: string | null
  context: ContentAuditCallContext
}

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

/**
 * What was tested, in facts that carry no content.
 *
 * Enough to make a result interpretable — which version, which model, which
 * sampling temperature, how much text, what context was sent — and nothing
 * more. The prompt itself is deliberately absent: it is available on the
 * settings detail read, and repeating it here would put it on every result.
 */
export interface CallAuditRuleTestMetadata {
  versionLabel: string
  modelProvider: string
  modelName: string
  modelVersion: string
  /** The fixed three-decimal string the administrator approved. */
  temperature: string
  transcriptCharacterCount: number
  /** Newline-separated segments of the submitted text. */
  transcriptLineCount: number
  /** The safe context actually sent, echoed so the test is reproducible. */
  context: {
    language: string | null
    durationSeconds: number | null
  }
}

/**
 * Lengths of the three sanitized free-text fields the model produced.
 *
 * The texts themselves are model prose derived from the transcript and stay
 * out of this DTO; a length is enough to see that a field was produced and
 * roughly how much of its budget it used. The keys say `CharacterCount` so no
 * reader — and no privacy assertion — can mistake one for the text.
 */
export interface CallAuditRuleTestFeedbackLengths {
  managementSummaryCharacterCount: number
  kserveFeedbackCharacterCount: number
  improvementFeedbackCharacterCount: number
}

/**
 * The inspectable part of a validated audit output.
 *
 * `Omit` makes the exclusion of the free-text fields STRUCTURAL: one cannot be
 * added back without a compile error, and the projection below picks every
 * remaining field by name rather than spreading.
 */
export type CallAuditRuleTestOutput = Omit<
  ValidatedContentAuditOutput,
  'managementSummary' | 'kserveFeedback' | 'improvementFeedback'
> & {
  feedbackLengths: CallAuditRuleTestFeedbackLengths
}

/**
 * The test-lab result. Provider and validation problems are RETURNED so the
 * screen can show what went wrong; only a caller-side input mistake throws.
 *
 * `usage` is null only when the adapter produced no usage facts at all — a
 * thrown port. An invented zero would read as a real measurement of no tokens
 * and no time.
 */
export type CallAuditRuleTestResult =
  | {
      status: 'succeeded'
      metadata: CallAuditRuleTestMetadata
      output: CallAuditRuleTestOutput
      usage: ContentAuditUsageFacts
    }
  | {
      status: 'refused'
      metadata: CallAuditRuleTestMetadata
      failure: ContentAuditFailure & { kind: 'refusal' }
      usage: ContentAuditUsageFacts
    }
  | {
      status: 'failed'
      metadata: CallAuditRuleTestMetadata
      failure: ContentAuditFailure & { kind: 'invalid_output' | 'transport' }
      usage: ContentAuditUsageFacts | null
    }

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

function requireObject<T>(value: unknown, field: string): T {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new CallAuditRuleTestError(field, 'must be an object')
  }
  return value as T
}

function requireModel(value: unknown): ContentAuditModelAdapter {
  const model = requireObject<ContentAuditModelAdapter>(value, 'model')
  if (typeof model.auditTranscript !== 'function') {
    throw new CallAuditRuleTestError('model.auditTranscript', 'must be a function')
  }
  return model
}

/**
 * The ONE piece of transcript validation mirrored here, and only because the
 * counts below index into the value. Blankness, length, and character safety
 * stay with the adapter, which is authoritative for what may reach a model —
 * restating those bounds would let the two drift apart. The text is never
 * inspected, quoted, or measured beyond its type at this point.
 */
function requireTranscriptType(value: unknown): string {
  if (typeof value !== 'string') {
    throw new CallAuditRuleTestError('transcript', 'must be a string')
  }
  return value
}

/**
 * Rebuilds the context from its two known keys.
 *
 * Picking by name rather than forwarding the caller's object is the point: an
 * extra property an admin surface attached — an id, a name, a URL — cannot ride
 * along into the request body. The values themselves are left for the adapter
 * to validate.
 */
function safeContext(context: ContentAuditCallContext | undefined): {
  language: string | null
  durationSeconds: number | null
} {
  return {
    language: context?.language ?? null,
    durationSeconds: context?.durationSeconds ?? null,
  }
}

/**
 * Parses one submitted request envelope into the three things this module can
 * use. Transport-agnostic: it takes an already-decoded value and owns no route.
 *
 * Every field is picked BY NAME, so anything else a submission carried — an id,
 * a name, a URL, a source column — is dropped here and can reach neither the
 * model request nor the returned value. The id's grammar is left to the caller,
 * which owns the id space; only its type is checked. Errors name a field and
 * never quote what was submitted.
 */
export function parseCallAuditRuleTestSubmission(
  body: unknown,
): CallAuditRuleTestSubmission {
  const record = requireObject<Record<string, unknown>>(body, 'body')
  const ruleVersionId = record.ruleVersionId
  if (
    ruleVersionId !== undefined &&
    ruleVersionId !== null &&
    typeof ruleVersionId !== 'string'
  ) {
    throw new CallAuditRuleTestError(
      'ruleVersionId',
      'must be a string or absent',
    )
  }
  const context = record.context
  if (context !== undefined && context !== null) {
    requireObject<ContentAuditCallContext>(context, 'context')
  }
  return {
    transcript: requireTranscriptType(record.transcript),
    ruleVersionId: ruleVersionId?.trim() || null,
    context: safeContext(
      (context as ContentAuditCallContext | null | undefined) ?? undefined,
    ),
  }
}

// ---------------------------------------------------------------------------
// Projection
// ---------------------------------------------------------------------------

function buildMetadata(
  settings: ValidatedRuleSettings,
  transcript: string,
  context: { language: string | null; durationSeconds: number | null },
): CallAuditRuleTestMetadata {
  return {
    versionLabel: settings.versionLabel,
    // The ACTIVATED identity, not a value echoed by a provider: a test result
    // must be attributable to the version that produced it.
    modelProvider: settings.modelProvider,
    modelName: settings.modelName,
    modelVersion: settings.modelVersion,
    temperature: settings.temperature,
    transcriptCharacterCount: transcript.length,
    transcriptLineCount: transcript.split(/\r?\n/).length,
    context,
  }
}

/** Copies every non-text field by name; arrays are copied, not aliased. */
function projectOutput(
  output: ValidatedContentAuditOutput,
): CallAuditRuleTestOutput {
  return {
    callConnected: output.callConnected,
    customerSpoke: output.customerSpoke,
    meaningfulConversation: output.meaningfulConversation,
    intent: output.intent,
    detailedOutcome: output.detailedOutcome,
    groupedOutcome: output.groupedOutcome,
    qualification: output.qualification,
    nextAction: output.nextAction,
    confidence: output.confidence,
    metricScores: output.metricScores.map((entry) => ({
      metric: entry.metric,
      score: entry.score,
    })),
    overallScore: output.overallScore,
    issueFlags: [...output.issueFlags],
    feedbackLengths: {
      managementSummaryCharacterCount: output.managementSummary.length,
      kserveFeedbackCharacterCount: output.kserveFeedback.length,
      improvementFeedbackCharacterCount: output.improvementFeedback.length,
    },
  }
}

// ---------------------------------------------------------------------------
// The test lab
// ---------------------------------------------------------------------------

/**
 * Runs one rule version against one transient transcript.
 *
 * The settings are validated through the SAME contract validator that accepted
 * them, before the port is touched, so a hand-built or mutated snapshot cannot
 * reach a model and no attempt is made for an input the administrator got
 * wrong.
 *
 * A refusal, an invalid output, or a transport failure is an expected result of
 * testing and is returned as a sanitized DTO. Should the port itself throw —
 * which its contract says it will not, outside caller-side input errors — the
 * thrown value is deliberately NOT bound, inspected, wrapped, or reported: it
 * can quote the request body, transcript included. Only the adapter's own typed
 * input error is allowed through, because it names a field and carries no
 * submitted value.
 */
export async function runCallAuditRuleTest(
  request: CallAuditRuleTestRequest,
): Promise<CallAuditRuleTestResult> {
  const input = requireObject<CallAuditRuleTestRequest>(request, 'request')
  const model = requireModel(input.model)
  const settings = validateRuleDraft(input.activation)
  const transcript = requireTranscriptType(input.transcript)
  const context = safeContext(input.context)
  const metadata = buildMetadata(settings, transcript, context)

  const result = await attemptOnce(model, {
    activation: input.activation,
    transcript,
    context,
  })

  if (result === null) {
    return {
      status: 'failed',
      metadata,
      failure: {
        kind: 'transport',
        // The adapter's own code for "the client threw", so a thrown port and a
        // returned transport failure read the same on the screen.
        errorCode: CONTENT_AUDIT_ERROR_CODES.requestFailed,
      },
      usage: null,
    }
  }
  if (result.status === 'succeeded') {
    return {
      status: 'succeeded',
      metadata,
      output: projectOutput(result.output),
      usage: result.usage,
    }
  }
  if (result.status === 'refused') {
    return {
      status: 'refused',
      metadata,
      failure: result.failure,
      usage: result.usage,
    }
  }
  // A refusal and an invalid output stay distinct outcomes; both carry the
  // bounded machine code and nothing else from the provider.
  return {
    status: 'failed',
    metadata,
    failure: result.failure,
    usage: result.usage,
  }
}

/**
 * Calls the port exactly once. Null means it threw, and nothing about the
 * thrown value is knowable after this point — which is the guarantee.
 */
async function attemptOnce(
  model: ContentAuditModelAdapter,
  request: {
    activation: ActivatedContentAuditModel
    transcript: string
    context: ContentAuditCallContext
  },
): Promise<ContentAuditModelResult | null> {
  try {
    return await model.auditTranscript(request)
  } catch (error) {
    if (error instanceof CallAuditModelRequestError) {
      // The adapter's own input error: field-named, value-free, and the
      // caller's bug rather than an outcome to display.
      throw error
    }
    return null
  }
}
