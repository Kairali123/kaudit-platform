import { randomUUID } from 'node:crypto'
import type { PoolConnection } from 'mysql2/promise'
import type { AiUsage } from '../reaudit/types.ts'

export interface AiUsageEvent {
  auditRunId: string
  callId: string
  operation: 'transcription' | 'classification'
  passName:
    | 'primary_asr'
    | 'primary_classifier'
    | 'consensus_secondary'
    | 'consensus_adjudicator'
  providerName: string
  modelName: string
  modelVersion: string
  usage: AiUsage
  recordedAt: Date
}

function nonNegativeInteger(
  value: number | null,
  name: string,
): number | null {
  if (value == null) return null
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer`)
  }
  return value
}

function audioSeconds(value: number | null): string | null {
  if (value == null) return null
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError('audioSeconds must be non-negative')
  }
  return value.toFixed(3)
}

export async function insertAiUsageEvent(
  connection: PoolConnection,
  event: AiUsageEvent,
): Promise<void> {
  const inputTokens = nonNegativeInteger(
    event.usage.inputTokens,
    'inputTokens',
  )
  const outputTokens = nonNegativeInteger(
    event.usage.outputTokens,
    'outputTokens',
  )
  const totalTokens = nonNegativeInteger(
    event.usage.totalTokens,
    'totalTokens',
  )
  if (
    event.operation === 'classification' &&
    totalTokens != null &&
    inputTokens != null &&
    outputTokens != null &&
    totalTokens < inputTokens + outputTokens
  ) {
    throw new RangeError(
      'totalTokens cannot be less than inputTokens + outputTokens',
    )
  }
  await connection.execute(
    `INSERT INTO kaudit_ai_usage_event
       (id, audit_run_id, call_id, operation, pass_name,
        provider_name, model_name, model_version,
        input_tokens, output_tokens, total_tokens, audio_seconds,
        request_id, recorded_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE id = id`,
    [
      randomUUID(),
      event.auditRunId,
      event.callId,
      event.operation,
      event.passName,
      event.providerName,
      event.modelName,
      event.modelVersion,
      inputTokens,
      outputTokens,
      totalTokens,
      audioSeconds(event.usage.audioSeconds),
      event.usage.requestId,
      event.recordedAt,
    ],
  )
}
