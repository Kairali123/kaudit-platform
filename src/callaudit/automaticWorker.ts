import { canonicalJsonSha256 } from '../messaging/canonicalJson.ts'
import type { CallAuditPersistenceRepository } from '../adapters/mysqlCallAuditPersistence.ts'
import type { CallAuditSettingsReadPort } from './adminSettings.ts'
import type { ContentAuditModelAdapter } from '../adapters/openaiCallAuditModel.ts'
import type { ChangedCallAuditCandidate } from '../adapters/mysqlCallAuditSource.ts'
import type { AuditWorkerControlPort } from '../auditWorkers/control.ts'
import { validateSourceChangeQuery } from './sourceQuery.ts'
import {
  runCallAuditBatch,
  type CallAuditBatchRunSummary,
  type CallAuditRunControlPort,
  type CallAuditSourceReaderPort,
} from './batchRunner.ts'
import { processCallAuditCandidate } from './processor.ts'

export const AUTOMATIC_CALL_AUDIT_ERROR_CODES = {
  noActiveRule: 'CALL_AUDIT_AUTO_NO_ACTIVE_RULE',
  activeRuleMissing: 'CALL_AUDIT_AUTO_RULE_DETAIL_MISSING',
  checkpointRequired: 'CALL_AUDIT_AUTO_CHECKPOINT_REQUIRED',
  sourceFailed: 'CALL_AUDIT_AUTO_SOURCE_FAILED',
  batchFailed: 'CALL_AUDIT_AUTO_BATCH_FAILED',
} as const

export interface AutomaticCallAuditSource {
  listChangedCandidates(input: {
    changedAfter: { changedAt: string; sourceRowId: string }
    changedBeforeExclusive: string
    batchSize: number
  }): Promise<ChangedCallAuditCandidate[]>
}

export type AutomaticCallAuditCycleResult =
  | { outcome: 'paused' | 'idle' }
  | {
      outcome: 'processed'
      summary: CallAuditBatchRunSummary
    }
  | { outcome: 'faulted'; errorCode: string }

function naiveUtc(date: Date): string {
  return date.toISOString().replace('T', ' ').replace('Z', '')
}

export async function runAutomaticCallAuditCycle(input: {
  workerControl: AuditWorkerControlPort
  runControl: CallAuditRunControlPort
  settings: CallAuditSettingsReadPort
  source: AutomaticCallAuditSource
  persistence: CallAuditPersistenceRepository
  model: ContentAuditModelAdapter
  initialCheckpoint: string | null
  batchSize: number
  now?: () => Date
  /** Optional host budget, checked only between candidates. */
  shouldContinue?: () => Promise<boolean>
}): Promise<AutomaticCallAuditCycleResult> {
  if ((await input.workerControl.getDesiredState('call')) === 'paused') {
    await input.workerControl.recordObservation({
      system: 'call',
      observedState: 'paused',
    })
    return { outcome: 'paused' }
  }

  let checkpoint = await input.workerControl.getCallCheckpoint()
  if (!checkpoint) {
    if (!input.initialCheckpoint) {
      await input.workerControl.recordObservation({
        system: 'call',
        observedState: 'faulted',
        errorCode: AUTOMATIC_CALL_AUDIT_ERROR_CODES.checkpointRequired,
        failedDelta: 1,
      })
      return {
        outcome: 'faulted',
        errorCode: AUTOMATIC_CALL_AUDIT_ERROR_CODES.checkpointRequired,
      }
    }
    let initial
    try {
      initial = validateSourceChangeQuery({
        changedAfter: {
          changedAt: input.initialCheckpoint,
          sourceRowId: '0',
        },
        changedBeforeExclusive: '9999-12-31 23:59:59.999999',
        batchSize: 1,
      }).changedAfter
    } catch {
      await input.workerControl.recordObservation({
        system: 'call',
        observedState: 'faulted',
        errorCode: AUTOMATIC_CALL_AUDIT_ERROR_CODES.checkpointRequired,
        failedDelta: 1,
      })
      return {
        outcome: 'faulted',
        errorCode: AUTOMATIC_CALL_AUDIT_ERROR_CODES.checkpointRequired,
      }
    }
    checkpoint = {
      changedAt: initial.changedAt,
      sourceRowId: initial.sourceRowId,
    }
    await input.workerControl.initializeCallCheckpoint(checkpoint)
    checkpoint = (await input.workerControl.getCallCheckpoint()) ?? checkpoint
  }

  const pollEnd = naiveUtc((input.now ?? (() => new Date()))())
  if (pollEnd <= checkpoint.changedAt) {
    await input.workerControl.recordObservation({
      system: 'call',
      observedState: 'idle',
    })
    return { outcome: 'idle' }
  }

  const active = await input.settings.getActiveRuleVersion()
  if (!active) {
    await input.workerControl.recordObservation({
      system: 'call',
      observedState: 'faulted',
      errorCode: AUTOMATIC_CALL_AUDIT_ERROR_CODES.noActiveRule,
      failedDelta: 1,
    })
    return {
      outcome: 'faulted',
      errorCode: AUTOMATIC_CALL_AUDIT_ERROR_CODES.noActiveRule,
    }
  }
  const detail = await input.settings.getRuleVersionDetail(
    active.ruleVersionId,
  )
  if (!detail) {
    await input.workerControl.recordObservation({
      system: 'call',
      observedState: 'faulted',
      errorCode: AUTOMATIC_CALL_AUDIT_ERROR_CODES.activeRuleMissing,
      failedDelta: 1,
    })
    return {
      outcome: 'faulted',
      errorCode: AUTOMATIC_CALL_AUDIT_ERROR_CODES.activeRuleMissing,
    }
  }

  let changed: ChangedCallAuditCandidate[]
  try {
    changed = await input.source.listChangedCandidates({
      changedAfter: checkpoint,
      changedBeforeExclusive: pollEnd,
      batchSize: input.batchSize,
    })
  } catch {
    await input.workerControl.recordObservation({
      system: 'call',
      observedState: 'faulted',
      errorCode: AUTOMATIC_CALL_AUDIT_ERROR_CODES.sourceFailed,
      failedDelta: 1,
    })
    return {
      outcome: 'faulted',
      errorCode: AUTOMATIC_CALL_AUDIT_ERROR_CODES.sourceFailed,
    }
  }

  if (changed.length === 0) {
    await input.workerControl.advanceCallCheckpoint({
      changedAt: pollEnd,
      sourceRowId: '0',
    })
    await input.workerControl.recordObservation({
      system: 'call',
      observedState: 'idle',
    })
    return { outcome: 'idle' }
  }

  const sequence = await input.workerControl.nextWorkSequence('call')
  const idempotencyKey = `callaudit-auto:${canonicalJsonSha256({
    ruleVersionId: detail.ruleVersionId,
    changedAfter: checkpoint.changedAt,
    changedBefore: changed.at(-1)?.cursor.changedAt ?? pollEnd,
    sequence,
  })}`
  let delivered = false
  const memorySource: CallAuditSourceReaderPort = {
    async listCandidates() {
      if (delivered) return []
      delivered = true
      return changed.map((item) => item.candidate)
    },
  }
  const cursorByRow = new Map(
    changed.map((item) => [item.candidate.sourceRowId, item.cursor]),
  )
  let settledCheckpoint = checkpoint

  await input.workerControl.recordObservation({
    system: 'call',
    observedState: 'running',
  })

  let summary: CallAuditBatchRunSummary
  try {
    summary = await runCallAuditBatch({
      request: {
        ruleVersionId: detail.ruleVersionId,
        runType: 'manual',
        periodStart: checkpoint.changedAt,
        periodEndExclusive: pollEnd,
        periodTimezone: 'UTC',
        idempotencyKey,
      },
      ruleVersionId: detail.ruleVersionId,
      activation: {
        versionLabel: detail.versionLabel,
        businessPrompt: detail.businessPrompt,
        modelProvider: detail.modelProvider,
        modelName: detail.modelName,
        modelVersion: detail.modelVersion,
        temperature: detail.temperature,
      },
      sourceWindow: {
        periodStart: checkpoint.changedAt,
        periodEndExclusive: pollEnd,
      },
      batchSize: changed.length,
      maxPages: 1,
      control: input.runControl,
      source: memorySource,
      processCandidate: async (candidateInput) => {
        const result = await processCallAuditCandidate(candidateInput)
        const cursor = cursorByRow.get(candidateInput.candidate.sourceRowId)
        if (cursor) settledCheckpoint = cursor
        return result
      },
      persistence: input.persistence,
      model: input.model,
      timestamps: { now: () => naiveUtc((input.now ?? (() => new Date()))()) },
      shouldContinue: async () =>
        (await input.workerControl.getDesiredState('call')) === 'running' &&
        (input.shouldContinue ? await input.shouldContinue() : true),
    })
  } catch {
    await input.workerControl.recordObservation({
      system: 'call',
      observedState: 'faulted',
      errorCode: AUTOMATIC_CALL_AUDIT_ERROR_CODES.batchFailed,
      failedDelta: 1,
    })
    return {
      outcome: 'faulted',
      errorCode: AUTOMATIC_CALL_AUDIT_ERROR_CODES.batchFailed,
    }
  }

  if (
    settledCheckpoint.changedAt !== checkpoint.changedAt ||
    settledCheckpoint.sourceRowId !== checkpoint.sourceRowId
  ) {
    await input.workerControl.advanceCallCheckpoint(settledCheckpoint)
  }
  const failed = summary.counts.failedTotal
  await input.workerControl.recordObservation({
    system: 'call',
    observedState:
      summary.stopReason === 'paused'
        ? (await input.workerControl.getDesiredState('call')) === 'paused'
          ? 'paused'
          : 'idle'
        : 'running',
    errorCode: summary.failureCode,
    processedDelta: summary.candidatesProcessed,
    failedDelta: failed,
    progressed: summary.candidatesProcessed > 0,
  })
  return { outcome: 'processed', summary }
}
