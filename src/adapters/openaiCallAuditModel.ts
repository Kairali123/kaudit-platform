import type { JsonValue } from '../messaging/canonicalJson.ts'
import { buildContentAuditSchema } from '../callaudit/modelSchema.ts'
import {
  validateContentAuditOutput,
  type ValidatedContentAuditOutput,
} from '../callaudit/modelOutput.ts'
import { compileSystemPrompt } from '../callaudit/promptCompiler.ts'
import {
  validateRuleDraft,
  type ValidatedRuleSettings,
} from '../callaudit/ruleContract.ts'
import type { CallAuditRuleActivation } from '../callaudit/ruleActivation.ts'

/**
 * OpenAI-compatible content-audit model adapter for ONE call transcript.
 *
 * Responsibilities, and nothing else: compile the deterministic system prompt,
 * send it with the transcript under a strict structured-output schema, validate
 * the untrusted reply through the application validator, and report safe usage
 * facts for the attempt. It persists nothing, retries nothing, schedules
 * nothing, and knows about no database, worker, HTTP route, or report.
 *
 * Privacy boundary. The transcript exists only inside the request body built
 * here. It is never logged, hashed, echoed into an error, or placed on the
 * returned value; neither is the compiled prompt, the raw model payload, a
 * refusal string, or a provider error message. Every failure leaves through a
 * bounded uppercase machine code from {@link CONTENT_AUDIT_ERROR_CODES}.
 *
 * Billing boundary. Nothing here touches money, and the accompanying test
 * asserts the whole vocabulary of it is absent from this file. Token counts and
 * elapsed milliseconds are operational facts about an attempt; turning them
 * into a chargeable figure is not this module's business, nor Call Audit's.
 *
 * Derivation boundary. `groupedOutcome` and `overallScore` are produced only by
 * `validateContentAuditOutput`. The strict schema does not offer either field
 * and the validator rejects any object that carries one, so a model cannot
 * choose its own management group or score.
 */

/** Structured-output schema name sent with the request. */
export const CONTENT_AUDIT_SCHEMA_NAME = 'kserve_content_audit'

/**
 * Guard on the transcript that reaches a paid model. The bound is an
 * administration guard, not a storage limit: a longer transcript is REJECTED
 * rather than truncated, because silently trimming evidence would audit a
 * different call than the one on record.
 */
export const MAX_TRANSCRIPT_LENGTH = 100_000

/** Bounds on the optional operational context echoed into the user message. */
export const MAX_LANGUAGE_LENGTH = 40
export const MAX_DURATION_SECONDS = 86_400

/**
 * Every code this adapter can emit. All are uppercase machine codes within the
 * 80-character `error_code` column, so a caller may record one verbatim.
 */
export const CONTENT_AUDIT_ERROR_CODES = {
  /** The model declined to answer. Distinct from a malformed answer. */
  refused: 'MODEL_REFUSED',
  /** A reply arrived with no message content to parse. */
  emptyResponse: 'MODEL_EMPTY_RESPONSE',
  /** Message content was not parseable JSON. */
  notJson: 'MODEL_RESPONSE_NOT_JSON',
  /** Parsed JSON failed the authoritative application validator. */
  invalidOutput: 'MODEL_OUTPUT_INVALID',
  /** The client threw: transport, provider, auth, throttling, or timeout. */
  requestFailed: 'MODEL_REQUEST_FAILED',
} as const

export type ContentAuditErrorCode =
  (typeof CONTENT_AUDIT_ERROR_CODES)[keyof typeof CONTENT_AUDIT_ERROR_CODES]

/** Typed input failure. Names the offending field, never its value. */
export class CallAuditModelRequestError extends Error {
  readonly code = 'INVALID_CALL_AUDIT_MODEL_REQUEST'
  readonly field: string

  constructor(field: string, reason: string) {
    super(`${field}: ${reason}`)
    this.field = field
  }
}

// ---------------------------------------------------------------------------
// Injected client
// ---------------------------------------------------------------------------

/** The request body this adapter builds. Structural, so any client can take it. */
export interface ContentAuditChatRequest {
  model: string
  /** Converted from the fixed-decimal setting only here, at the boundary. */
  temperature: number
  response_format: {
    type: 'json_schema'
    json_schema: {
      name: string
      strict: true
      schema: JsonValue
    }
  }
  messages: readonly {
    role: 'system' | 'user'
    content: string
  }[]
}

/** The subset of an OpenAI-compatible reply this adapter reads. */
export interface ContentAuditChatResponse {
  choices?: readonly ({
    message?: {
      content?: string | null
      refusal?: string | null
    } | null
  } | null)[]
  usage?: {
    prompt_tokens?: unknown
    completion_tokens?: unknown
    total_tokens?: unknown
  } | null
  /** OpenAI SDK convention; other compatible clients may omit it. */
  _request_id?: unknown
}

/**
 * Minimal OpenAI-compatible chat client. Declared structurally and injected, so
 * tests drive a fake and no test can reach a network.
 */
export interface ContentAuditChatClient {
  createChatCompletion(
    request: ContentAuditChatRequest,
  ): Promise<ContentAuditChatResponse>
}

/** Millisecond clock, injectable so elapsed time is assertable in tests. */
export type MonotonicClock = () => number

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

/**
 * The narrow slice of an activated rule version this adapter needs. A full
 * {@link CallAuditRuleActivation} satisfies it, so a caller can pass the
 * activation snapshot straight through.
 */
export type ActivatedContentAuditModel = Pick<
  CallAuditRuleActivation,
  | 'versionLabel'
  | 'businessPrompt'
  | 'modelProvider'
  | 'modelName'
  | 'modelVersion'
  | 'temperature'
>

/**
 * Safe operational context for the user message. Deliberately tiny: only facts
 * already represented locally and carrying no identity. There is no lead ID,
 * Task ID, name, phone, email, URL, or timestamp here.
 */
export interface ContentAuditCallContext {
  /** Detected language label, e.g. 'hi'. Absent means unknown. */
  language?: string | null
  /** Recorded call duration in whole seconds. Absent means unknown. */
  durationSeconds?: number | null
}

export interface ContentAuditModelRequest {
  activation: ActivatedContentAuditModel
  /** The single call's transcript. Request-body only; never returned. */
  transcript: string
  context?: ContentAuditCallContext
}

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

/**
 * Safe facts about one attempt, present whether it succeeded, was refused, or
 * failed. Counts are canonical decimal STRINGS so a provider count beyond
 * `Number.MAX_SAFE_INTEGER` survives to a BIGINT column unrounded, and a
 * non-numeric or negative count becomes null rather than a guess.
 */
export interface ContentAuditUsageFacts {
  /** The activated provider identity, not a value read back from the reply. */
  provider: string
  modelName: string
  modelVersion: string
  /** Provider-reported correlation id when the client exposes one. */
  requestId: string | null
  inputTokens: string | null
  outputTokens: string | null
  /** Provider-reported; never recomputed from the parts. */
  totalTokens: string | null
  /** Elapsed wall time around the client call, as a canonical decimal string. */
  latencyMs: string
}

/** Why an attempt did not yield validated output. */
export type ContentAuditFailureKind = 'refusal' | 'invalid_output' | 'transport'

export interface ContentAuditFailure {
  kind: ContentAuditFailureKind
  /** Bounded machine code. Never provider prose. */
  errorCode: ContentAuditErrorCode
}

/**
 * The adapter's return value. Provider and validation problems are RETURNED,
 * not thrown, so a caller can record a usage attempt for every outcome; only a
 * caller-side input mistake throws.
 *
 * `status` matches the usage-attempt outcome vocabulary a persistence layer
 * already uses, so mapping is a direct copy rather than a translation.
 */
export type ContentAuditModelResult =
  | {
      status: 'succeeded'
      output: ValidatedContentAuditOutput
      usage: ContentAuditUsageFacts
    }
  | {
      status: 'refused'
      failure: ContentAuditFailure & { kind: 'refusal' }
      usage: ContentAuditUsageFacts
    }
  | {
      status: 'failed'
      failure: ContentAuditFailure & { kind: 'invalid_output' | 'transport' }
      usage: ContentAuditUsageFacts
    }

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

/** Tab and newline are legitimate transcript formatting; nothing else is. */
const UNSAFE_TRANSCRIPT_CHARACTER =
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/
const CANONICAL_UNSIGNED = /^(0|[1-9][0-9]*)$/

function requireTranscript(value: unknown): string {
  if (typeof value !== 'string') {
    throw new CallAuditModelRequestError('transcript', 'must be a string')
  }
  // Only the length and shape are inspected. The text is never logged, hashed,
  // or copied into an error message.
  if (value.trim() === '') {
    throw new CallAuditModelRequestError(
      'transcript',
      'must not be blank; a blank transcript is operational-only and is not audited here',
    )
  }
  if (value.length > MAX_TRANSCRIPT_LENGTH) {
    throw new CallAuditModelRequestError(
      'transcript',
      `must be at most ${MAX_TRANSCRIPT_LENGTH} characters`,
    )
  }
  if (UNSAFE_TRANSCRIPT_CHARACTER.test(value)) {
    throw new CallAuditModelRequestError(
      'transcript',
      'must not contain control characters other than tab and newline',
    )
  }
  return value
}

function requireLanguage(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null
  }
  if (typeof value !== 'string') {
    throw new CallAuditModelRequestError('context.language', 'must be a string')
  }
  const text = value.trim()
  if (!text) {
    return null
  }
  if (text.length > MAX_LANGUAGE_LENGTH) {
    throw new CallAuditModelRequestError(
      'context.language',
      `must be at most ${MAX_LANGUAGE_LENGTH} characters`,
    )
  }
  if (CONTROL_CHARACTER.test(text)) {
    throw new CallAuditModelRequestError(
      'context.language',
      'must not contain control characters',
    )
  }
  return text
}

function requireDurationSeconds(value: unknown): number | null {
  if (value === null || value === undefined) {
    return null
  }
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > MAX_DURATION_SECONDS
  ) {
    throw new CallAuditModelRequestError(
      'context.durationSeconds',
      `must be an integer between 0 and ${MAX_DURATION_SECONDS}`,
    )
  }
  return value
}

/**
 * Re-validates the activated settings through the SAME contract validator that
 * accepted them, so a hand-built or mutated snapshot cannot smuggle a blank
 * model name or an out-of-range temperature to the provider.
 */
function requireActivation(value: unknown): ValidatedRuleSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new CallAuditModelRequestError('activation', 'must be an object')
  }
  return validateRuleDraft(value)
}

// ---------------------------------------------------------------------------
// Request building
// ---------------------------------------------------------------------------

/**
 * THE ONLY temperature conversion in the module.
 *
 * The fixed three-decimal string is the authoritative value everywhere else —
 * it is what the administrator approved, what decimal(4,3) stores, and what the
 * activation snapshot carries. A binary float appears here and nowhere else,
 * because the wire protocol has no decimal type.
 */
function temperatureForRequest(temperature: string): number {
  const value = Number(temperature)
  if (!Number.isFinite(value)) {
    throw new CallAuditModelRequestError(
      'activation.temperature',
      'did not convert to a finite request value',
    )
  }
  return value
}

/**
 * Builds the user message. The transcript is last and clearly delimited, and
 * the only other content is the bounded operational context.
 */
function buildUserMessage(
  transcript: string,
  context: { language: string | null; durationSeconds: number | null },
): string {
  return [
    'CALL CONTEXT',
    `Detected language: ${context.language ?? 'unknown'}`,
    `Recorded duration: ${
      context.durationSeconds === null
        ? 'unknown'
        : `${context.durationSeconds} seconds`
    }`,
    '',
    'TRANSCRIPT',
    transcript,
  ].join('\n')
}

/**
 * Builds the exact request body for one call.
 *
 * Exported so a test can assert what would be sent — the schema, the strict
 * flag, the converted temperature, and the fact that the transcript appears in
 * the body and only there.
 */
export function buildContentAuditRequest(
  request: ContentAuditModelRequest,
): ContentAuditChatRequest {
  const settings = requireActivation(request.activation)
  const transcript = requireTranscript(request.transcript)
  const context = request.context ?? {}
  const userMessage = buildUserMessage(transcript, {
    language: requireLanguage(context.language),
    durationSeconds: requireDurationSeconds(context.durationSeconds),
  })

  return {
    // The administrator-entered model identifier is what the provider is asked
    // for; modelVersion is provenance recorded alongside the attempt. An
    // identifier the provider does not know fails loudly rather than being
    // silently repaired into a different model.
    model: settings.modelName,
    temperature: temperatureForRequest(settings.temperature),
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: CONTENT_AUDIT_SCHEMA_NAME,
        strict: true,
        schema: buildContentAuditSchema(),
      },
    },
    messages: [
      { role: 'system', content: compileSystemPrompt(settings) },
      { role: 'user', content: userMessage },
    ],
  }
}

// ---------------------------------------------------------------------------
// Reply reading
// ---------------------------------------------------------------------------

/**
 * Normalizes an untrusted provider count into a canonical decimal string, or
 * null. A negative, fractional, unsafe, or non-numeric count is DISCARDED: a
 * repaired count would be a fabricated operational fact.
 */
function readCount(value: unknown): string | null {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value >= 0 ? String(value) : null
  }
  if (typeof value === 'bigint') {
    return value >= 0n ? value.toString() : null
  }
  if (typeof value === 'string') {
    const text = value.trim()
    return CANONICAL_UNSIGNED.test(text) ? text : null
  }
  return null
}

/** Reads a correlation id only when it is a safe bounded identifier. */
function readRequestId(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null
  }
  const text = value.trim()
  if (!text || text.length > 120 || CONTROL_CHARACTER.test(text)) {
    return null
  }
  return text
}

function elapsedMs(startedAt: number, endedAt: number): string {
  const elapsed = Math.round(endedAt - startedAt)
  return String(Number.isFinite(elapsed) && elapsed > 0 ? elapsed : 0)
}

interface UsageInputs {
  settings: ValidatedRuleSettings
  response: ContentAuditChatResponse | null
  startedAt: number
  endedAt: number
}

function usageFacts(inputs: UsageInputs): ContentAuditUsageFacts {
  const usage = inputs.response?.usage ?? null
  return {
    // Model identity is the ACTIVATED identity, never a value echoed by the
    // provider: an attempt must be attributable to the version that ran it.
    provider: inputs.settings.modelProvider,
    modelName: inputs.settings.modelName,
    modelVersion: inputs.settings.modelVersion,
    requestId: readRequestId(inputs.response?._request_id),
    inputTokens: readCount(usage?.prompt_tokens),
    outputTokens: readCount(usage?.completion_tokens),
    totalTokens: readCount(usage?.total_tokens),
    latencyMs: elapsedMs(inputs.startedAt, inputs.endedAt),
  }
}

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

export interface ContentAuditModelAdapter {
  auditTranscript(
    request: ContentAuditModelRequest,
  ): Promise<ContentAuditModelResult>
}

export interface ContentAuditModelAdapterOptions {
  client: ContentAuditChatClient
  /** Defaults to `Date.now`. Injected so latency is deterministic in tests. */
  now?: MonotonicClock
}

/**
 * Creates the adapter over an injected OpenAI-compatible client.
 *
 * One transcript, one request, no retry. Retry policy, attempt numbering, and
 * persistence belong to the caller that owns the run.
 */
export function createContentAuditModelAdapter(
  options: ContentAuditModelAdapterOptions,
): ContentAuditModelAdapter {
  const client = options.client
  const now = options.now ?? Date.now

  return {
    async auditTranscript(request) {
      // Input problems are the CALLER's bug and throw before any spend; a
      // provider or model problem is an expected outcome and is returned.
      const settings = requireActivation(request.activation)
      const body = buildContentAuditRequest(request)

      const startedAt = now()
      let response: ContentAuditChatResponse
      try {
        response = await client.createChatCompletion(body)
      } catch {
        // The thrown value is deliberately not inspected. A provider error can
        // quote the request — transcript included — so nothing from it is read,
        // wrapped, re-thrown, or attached to the result.
        return {
          status: 'failed',
          failure: {
            kind: 'transport',
            errorCode: CONTENT_AUDIT_ERROR_CODES.requestFailed,
          },
          usage: usageFacts({
            settings,
            response: null,
            startedAt,
            endedAt: now(),
          }),
        }
      }
      const usage = usageFacts({
        settings,
        response,
        startedAt,
        endedAt: now(),
      })

      const message = response.choices?.[0]?.message ?? null

      // A refusal is a deliberate model decision, not a malformed answer, and
      // stays a distinct outcome. The refusal TEXT is never read.
      if (typeof message?.refusal === 'string' && message.refusal.trim()) {
        return {
          status: 'refused',
          failure: {
            kind: 'refusal',
            errorCode: CONTENT_AUDIT_ERROR_CODES.refused,
          },
          usage,
        }
      }

      const content = message?.content
      if (typeof content !== 'string' || content.trim() === '') {
        return {
          status: 'failed',
          failure: {
            kind: 'invalid_output',
            errorCode: CONTENT_AUDIT_ERROR_CODES.emptyResponse,
          },
          usage,
        }
      }

      let parsed: unknown
      try {
        parsed = JSON.parse(content)
      } catch {
        // The unparseable text is model output derived from the transcript, so
        // it is dropped rather than reported.
        return {
          status: 'failed',
          failure: {
            kind: 'invalid_output',
            errorCode: CONTENT_AUDIT_ERROR_CODES.notJson,
          },
          usage,
        }
      }

      try {
        // The application validator is authoritative. groupedOutcome and
        // overallScore come out of it derived; a model that volunteered either
        // is rejected here as an unaccepted field.
        const output = validateContentAuditOutput(parsed, {
          eligibility: 'content_auditable',
        })
        return { status: 'succeeded', output, usage }
      } catch {
        return {
          status: 'failed',
          failure: {
            kind: 'invalid_output',
            errorCode: CONTENT_AUDIT_ERROR_CODES.invalidOutput,
          },
          usage,
        }
      }
    },
  }
}
