import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { AuditWorkerControlPort, CallAuditCheckpoint } from '../auditWorkers/control.ts'
import type { CallAuditPersistenceRepository } from '../adapters/mysqlCallAuditPersistence.ts'
import type { ContentAuditModelAdapter } from '../adapters/openaiCallAuditModel.ts'
import type { CallAuditSettingsReadPort } from './adminSettings.ts'
import type { CallAuditRunControlPort } from './batchRunner.ts'
import { CALL_AUDIT_SOURCE_TABLE, type InternalSourceCandidate } from './sourceTypes.ts'
import {
  AUTOMATIC_CALL_AUDIT_ERROR_CODES,
  runAutomaticCallAuditCycle,
} from './automaticWorker.ts'

function workerControl(desired: 'running' | 'paused') {
  let checkpoint: CallAuditCheckpoint | null = null
  const observations: Array<Record<string, unknown>> = []
  const advances: CallAuditCheckpoint[] = []
  const port: AuditWorkerControlPort = {
    async listPublicStates() { return [] },
    async setDesiredState() { throw new Error('unused') },
    async getDesiredState() { return desired },
    async recordObservation(input) { observations.push(input) },
    async getCallCheckpoint() { return checkpoint },
    async initializeCallCheckpoint(value) { checkpoint ??= value },
    async advanceCallCheckpoint(value) {
      checkpoint = value
      advances.push(value)
    },
    async nextWorkSequence() { return 1 },
  }
  return { port, observations, advances }
}

const unusedRunControl = {} as CallAuditRunControlPort
const unusedPersistence = {} as CallAuditPersistenceRepository
const unusedModel = {} as ContentAuditModelAdapter

function settings(active: boolean): CallAuditSettingsReadPort {
  return {
    async listRuleVersions() { return [] },
    async getActiveRuleVersion() {
      return active
        ? ({ ruleVersionId: 'crv_synthetic' } as never)
        : null
    },
    async getRuleVersionDetail() {
      return active
        ? ({
            ruleVersionId: 'crv_synthetic',
            versionLabel: 'synthetic-v1',
            businessPrompt: 'Synthetic business guidance.',
            modelProvider: 'synthetic',
            modelName: 'synthetic-model',
            modelVersion: 'v1',
            temperature: '0.000',
          } as never)
        : null
    },
    async listRecentRuns() { return [] },
  }
}

test('paused Call Audit performs no source read or model work', async () => {
  const control = workerControl('paused')
  let reads = 0
  const result = await runAutomaticCallAuditCycle({
    workerControl: control.port,
    runControl: unusedRunControl,
    settings: settings(true),
    source: { async listChangedCandidates() { reads += 1; return [] } },
    persistence: unusedPersistence,
    model: unusedModel,
    initialCheckpoint: '2026-08-01 00:00:00.000000',
    batchSize: 25,
    now: () => new Date('2026-08-01T00:01:00.000Z'),
  })

  assert.deepEqual(result, { outcome: 'paused' })
  assert.equal(reads, 0)
  assert.equal(control.observations[0]?.observedState, 'paused')
})

test('a first launch without an approved checkpoint faults before source or model work', async () => {
  const control = workerControl('running')
  let reads = 0
  const result = await runAutomaticCallAuditCycle({
    workerControl: control.port,
    runControl: unusedRunControl,
    settings: settings(true),
    source: { async listChangedCandidates() { reads += 1; return [] } },
    persistence: unusedPersistence,
    model: unusedModel,
    initialCheckpoint: null,
    batchSize: 25,
    now: () => new Date('2026-08-01T00:01:00.000Z'),
  })

  assert.deepEqual(result, {
    outcome: 'faulted',
    errorCode: AUTOMATIC_CALL_AUDIT_ERROR_CODES.checkpointRequired,
  })
  assert.equal(reads, 0)
  assert.equal(control.advances.length, 0)
})

test('missing active rule faults safely and preserves the checkpoint', async () => {
  const control = workerControl('running')
  const result = await runAutomaticCallAuditCycle({
    workerControl: control.port,
    runControl: unusedRunControl,
    settings: settings(false),
    source: { async listChangedCandidates() { throw new Error('must not read') } },
    persistence: unusedPersistence,
    model: unusedModel,
    initialCheckpoint: '2026-08-01 00:00:00.000000',
    batchSize: 25,
    now: () => new Date('2026-08-01T00:01:00.000Z'),
  })

  assert.deepEqual(result, {
    outcome: 'faulted',
    errorCode: AUTOMATIC_CALL_AUDIT_ERROR_CODES.noActiveRule,
  })
  assert.equal(control.advances.length, 0)
})

test('an empty change window advances the durable watermark without a run', async () => {
  const control = workerControl('running')
  const result = await runAutomaticCallAuditCycle({
    workerControl: control.port,
    runControl: unusedRunControl,
    settings: settings(true),
    source: { async listChangedCandidates() { return [] } },
    persistence: unusedPersistence,
    model: unusedModel,
    initialCheckpoint: '2026-08-01 00:00:00.000000',
    batchSize: 25,
    now: () => new Date('2026-08-01T00:01:00.000Z'),
  })

  assert.deepEqual(result, { outcome: 'idle' })
  assert.deepEqual(control.advances, [
    { changedAt: '2026-08-01 00:01:00.000', sourceRowId: '0' },
  ])
})

test('a changed operational row is persisted and checkpointed without model spend', async () => {
  const control = workerControl('running')
  const candidate: InternalSourceCandidate = {
    sourceTable: CALL_AUDIT_SOURCE_TABLE,
    sourceRowId: '701',
    leadId: 'LEAD-SYNTH-AUTO-701',
    transcript: null,
    effectiveCallTime: '2026-08-01 00:00:10.000000',
    sourceUpdatedAt: '2026-08-01 00:00:20.000000',
    callStartedAt: '2026-08-01 00:00:10.000000',
    callEndedAt: null,
    callDurationSec: '00:00:45',
    company_by_kserve: 'Synthetic company',
    company: null,
    data_source: 'synthetic_fixture',
    verified_source: 'synthetic',
    service_category: 'synthetic_service',
    call_type: 'outbound',
    call_status: 'completed',
    call_end_reason: 'synthetic_end',
    final_call_status: 'completed',
    ai_call_category: null,
    customer_engagement_level: null,
    interest_level: null,
    call_outcome: null,
    lead_status: null,
    final_lead_outcome: null,
    calculated_qualification_status: null,
    followup_required: null,
  }
  const runControl: CallAuditRunControlPort = {
    async createRun() { return { id: 'crn_synthetic_auto_1', outcome: 'inserted' } },
    async markRunRunning(input) {
      return { id: input.runId, status: 'running', outcome: 'updated' }
    },
    async updateRunCounters(runId) {
      return { id: runId, status: 'running', outcome: 'updated' }
    },
    async markRunCompleted(input) {
      return { id: input.runId, status: 'completed', outcome: 'updated' }
    },
    async markRunFailed(input) {
      return { id: input.runId, status: 'failed', outcome: 'updated' }
    },
  }
  let resultBundles = 0
  let modelCalls = 0
  const persistence: CallAuditPersistenceRepository = {
    async upsertSourceReference() {
      return { id: `cas_${'a'.repeat(36)}`, outcome: 'inserted' }
    },
    async claimContentAuditSpend() {
      throw new Error('operational-only evidence must not claim model spend')
    },
    async saveResultBundle() {
      resultBundles += 1
      return { outcome: 'inserted' }
    },
    async recordUsageAttempt() {
      throw new Error('operational-only evidence must not record model usage')
    },
  }
  const model: ContentAuditModelAdapter = {
    async auditTranscript() {
      modelCalls += 1
      throw new Error('operational-only evidence must not call the model')
    },
  }

  const result = await runAutomaticCallAuditCycle({
    workerControl: control.port,
    runControl,
    settings: settings(true),
    source: {
      async listChangedCandidates() {
        return [{
          candidate,
          cursor: {
            changedAt: '2026-08-01 00:00:20.000000',
            sourceRowId: candidate.sourceRowId,
          },
        }]
      },
    },
    persistence,
    model,
    initialCheckpoint: '2026-08-01 00:00:00.000000',
    batchSize: 25,
    now: () => new Date('2026-08-01T00:01:00.000Z'),
  })

  assert.equal(result.outcome, 'processed')
  assert.equal(resultBundles, 1)
  assert.equal(modelCalls, 0)
  assert.deepEqual(control.advances.at(-1), {
    changedAt: '2026-08-01 00:00:20.000000',
    sourceRowId: '701',
  })
  assert.equal(control.observations.at(-1)?.processedDelta, 1)
})
