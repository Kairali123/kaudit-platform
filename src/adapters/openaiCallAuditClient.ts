import OpenAI from 'openai'
import {
  createContentAuditModelAdapter,
  type ContentAuditChatClient,
  type ContentAuditChatRequest,
  type ContentAuditChatResponse,
  type ContentAuditModelAdapter,
  type MonotonicClock,
} from './openaiCallAuditModel.ts'

/**
 * The OpenAI SDK edge for the Call Audit content model.
 *
 * This module exists so `openaiCallAuditModel.ts` can stay what it is: a pure
 * request builder and reply reader over an INJECTED structural client, with no
 * vendor package, no credential, and no transport of its own. Everything that
 * needs the real SDK lives here, and here it does exactly one thing — construct
 * a client and hand it to `createContentAuditModelAdapter` as the port that
 * module already accepts.
 *
 * Privacy boundary, unchanged and inherited. The transcript travels only inside
 * the request body the pure module built, straight to the SDK. Nothing here
 * logs, hashes, buffers, or copies that body, and nothing here reads a thrown
 * value: a provider error can quote the request it failed on, so the adapter's
 * existing catch-and-drop is left to swallow it into a bounded machine code.
 *
 * Boundaries this module does NOT cross: it reads no environment variable (the
 * key is a parameter, so the startup that owns configuration owns the decision
 * to build this at all), it touches no database, HTTP route, report, or UI, and
 * it knows nothing about money.
 */

/**
 * No SDK-level retry.
 *
 * The adapter documents one transcript, one request, no retry, and returns a
 * transport failure as an outcome the caller records. An SDK retry would resend
 * the transcript to a paid provider behind that contract's back and inflate the
 * measured latency of the attempt it reports, so the SDK is told to do none and
 * retry policy stays with whoever owns the run.
 */
export const CALL_AUDIT_MODEL_MAX_RETRIES = 0

/**
 * Wall-clock ceiling for one attempt. Deliberately shorter than a batch job
 * would want: the only caller today is an administrator waiting on a rule test,
 * and a request past this point should fail as a bounded transport outcome
 * rather than hold a request handler open.
 */
export const CALL_AUDIT_MODEL_TIMEOUT_MS = 60_000

/** Constructor options this module pins. Exported so a test can assert them. */
export interface OpenAiCallAuditClientInit {
  apiKey: string
  maxRetries: number
  timeout: number
}

/**
 * The single SDK surface this module uses, declared structurally so the test
 * seam below can satisfy it without the real package or a network.
 */
export interface OpenAiChatCompletionsClient {
  chat: {
    completions: {
      create(
        request: ContentAuditChatRequest,
      ): Promise<ContentAuditChatResponse>
    }
  }
}

/** How the SDK client is built. Replaceable only for tests. */
export type OpenAiCallAuditClientFactory = (
  init: OpenAiCallAuditClientInit,
) => OpenAiChatCompletionsClient

/**
 * Adapts the SDK's method shape to the structural port the pure module takes.
 *
 * The request object is forwarded BY REFERENCE, unread and unmodified: this
 * layer has no opinion about the body, and rebuilding it here would be a second
 * place where the wire format could drift from the one under test.
 */
export function createOpenAiContentAuditChatClient(
  client: OpenAiChatCompletionsClient,
): ContentAuditChatClient {
  return {
    async createChatCompletion(request) {
      return await client.chat.completions.create(request)
    },
  }
}

export interface OpenAiCallAuditModelOptions {
  /** Defaults to `Date.now`; injected so latency is deterministic in tests. */
  now?: MonotonicClock
  /**
   * Test seam. Defaults to the real SDK constructor; a test passes a fake so
   * no test can construct a real client or reach a network.
   */
  createClient?: OpenAiCallAuditClientFactory
}

/**
 * The real OpenAI SDK constructor.
 *
 * The cast is the one unavoidable seam. `ContentAuditChatRequest` is a narrower
 * hand-written body (readonly messages, a `JsonValue` schema) than the SDK's
 * mutable parameter types accept, and the SDK's reply carries more than the
 * handful of fields `ContentAuditChatResponse` declares. Both differences are
 * width, not shape, and the pure module reads every field it names defensively.
 */
const constructOpenAiClient: OpenAiCallAuditClientFactory = (init) =>
  new OpenAI({
    apiKey: init.apiKey,
    maxRetries: init.maxRetries,
    timeout: init.timeout,
  }) as unknown as OpenAiChatCompletionsClient

/**
 * Builds the content-audit model backed by the real OpenAI SDK.
 *
 * The key is a required parameter rather than an environment read, so a caller
 * cannot get a silently keyless model: a blank key fails here, at startup, in
 * the process that decided to configure this at all.
 */
export function createOpenAiCallAuditModel(
  apiKey: string,
  options: OpenAiCallAuditModelOptions = {},
): ContentAuditModelAdapter {
  const key = typeof apiKey === 'string' ? apiKey.trim() : ''
  if (!key) {
    // Names the missing input and nothing else; the value is never echoed.
    throw new Error('a nonblank OpenAI API key is required')
  }

  const client = (options.createClient ?? constructOpenAiClient)({
    apiKey: key,
    maxRetries: CALL_AUDIT_MODEL_MAX_RETRIES,
    timeout: CALL_AUDIT_MODEL_TIMEOUT_MS,
  })

  return createContentAuditModelAdapter({
    client: createOpenAiContentAuditChatClient(client),
    now: options.now,
  })
}
