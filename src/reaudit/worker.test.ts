import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ReauditCandidate, ReauditItemResult } from './types.ts'
import { runReauditBatch } from './worker.ts'

const candidate = (id: string): ReauditCandidate => ({
  callId: id,
  artifactId: `artifact-${id}`,
  sourceUrl: `https://recordings.example.test/${id}.ogg`,
  baselineSha256: null,
  claimedDurationMs: 30_000,
  connectedDurationMs: 30_000,
  vendorBilledMinutes: '1.00000000',
})

test('worker processes each selected unaudited candidate once', async () => {
  const processed: string[] = []
  const persisted: string[] = []
  const summary = await runReauditBatch({
    batchSize: 10,
    candidates: {
      async listCandidates() {
        return [candidate('one'), candidate('two')]
      },
    },
    results: {
      async markStarted() {
        return 'acquired'
      },
      async persist(item) {
        persisted.push(item.callId)
        return 'completed'
      },
    },
    processor: {
      async process(item): Promise<ReauditItemResult> {
        processed.push(item.callId)
        return {
          callId: item.callId,
          artifactId: item.artifactId,
          outcome: 'source_missing',
          errorCode: 'synthetic',
        }
      },
    },
  })
  assert.deepEqual(processed, ['one', 'two'])
  assert.deepEqual(persisted, ['one', 'two'])
  assert.equal(summary.completed, 2)
  assert.equal(summary.stoppedEarly, false)
})

test('worker never processes a candidate already completed by another run', async () => {
  let processCalls = 0
  const summary = await runReauditBatch({
    batchSize: 1,
    candidates: {
      async listCandidates() {
        return [candidate('already-done')]
      },
    },
    results: {
      async markStarted() {
        return 'already_completed'
      },
      async persist() {
        throw new Error('must not persist')
      },
    },
    processor: {
      async process() {
        processCalls += 1
        throw new Error('must not process')
      },
    },
  })
  assert.equal(processCalls, 0)
  assert.equal(summary.alreadyCompleted, 1)
})

test('worker pauses before claiming the next call', async () => {
  const claimed: string[] = []
  let checks = 0
  const summary = await runReauditBatch({
    batchSize: 2,
    candidates: {
      async listCandidates() {
        return [candidate('one'), candidate('two')]
      },
    },
    results: {
      async markStarted(item) {
        claimed.push(item.callId)
        return 'acquired'
      },
      async persist() {
        return 'completed'
      },
    },
    processor: {
      async process(item) {
        return {
          callId: item.callId,
          artifactId: item.artifactId,
          outcome: 'source_missing',
        }
      },
    },
    async shouldContinue() {
      checks += 1
      return checks === 1
    },
  })

  assert.deepEqual(claimed, ['one'])
  assert.equal(summary.completed, 1)
  assert.equal(summary.stoppedEarly, true)
})

test('an unexpected call processor failure is persisted and later calls continue', async () => {
  const persisted: ReauditItemResult[] = []
  const summary = await runReauditBatch({
    batchSize: 2,
    candidates: {
      async listCandidates() {
        return [candidate('broken'), candidate('next')]
      },
    },
    results: {
      async markStarted() {
        return 'acquired'
      },
      async persist(_candidate, result) {
        persisted.push(result)
        return result.errorCode ? 'retry_scheduled' : 'completed'
      },
    },
    processor: {
      async process(item) {
        if (item.callId === 'broken') throw new Error('private provider prose')
        return {
          callId: item.callId,
          artifactId: item.artifactId,
          outcome: 'source_missing',
        }
      },
    },
  })

  assert.equal(persisted[0]?.errorCode, 'AUDIT_PROCESSOR_FAILED')
  assert.equal(persisted[1]?.callId, 'next')
  assert.equal(summary.retriesScheduled, 1)
  assert.equal(summary.completed, 1)
})
