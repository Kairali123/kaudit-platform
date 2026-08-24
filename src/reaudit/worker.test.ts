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

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

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

test('append re-audit explicitly requests previously classified candidates', async () => {
  let includePreviouslyClassified: boolean | undefined
  await runReauditBatch({
    batchSize: 1,
    includePreviouslyClassified: true,
    candidates: {
      async listCandidates(options) {
        includePreviouslyClassified = options.includePreviouslyClassified
        return []
      },
    },
    results: {
      async markStarted() {
        return 'acquired'
      },
      async persist() {
        return 'completed'
      },
    },
    processor: {
      async process() {
        throw new Error('no candidate should run')
      },
    },
  })

  assert.equal(includePreviouslyClassified, true)
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

test('worker awaits durable progress before claiming the next call', async () => {
  const events: string[] = []
  const summary = await runReauditBatch({
    batchSize: 2,
    candidates: {
      async listCandidates() {
        return [candidate('one'), candidate('two')]
      },
    },
    results: {
      async markStarted(item) {
        events.push(`claim:${item.callId}`)
        return 'acquired'
      },
      async persist(_candidate, _result) {
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
    async onProgress(progress) {
      await Promise.resolve()
      events.push(`progress:${progress.completed}`)
    },
  })

  assert.equal(summary.completed, 2)
  assert.deepEqual(events, [
    'claim:one',
    'progress:1',
    'claim:two',
    'progress:2',
  ])
})

test('worker defaults to sequential processing', async () => {
  let active = 0
  let peak = 0
  const summary = await runReauditBatch({
    batchSize: 3,
    candidates: {
      async listCandidates() {
        return [candidate('one'), candidate('two'), candidate('three')]
      },
    },
    results: {
      async markStarted() {
        return 'acquired'
      },
      async persist() {
        return 'completed'
      },
    },
    processor: {
      async process(item) {
        active += 1
        peak = Math.max(peak, active)
        await tick()
        active -= 1
        return {
          callId: item.callId,
          artifactId: item.artifactId,
          outcome: 'source_missing',
        }
      },
    },
  })

  assert.equal(summary.completed, 3)
  assert.equal(peak, 1)
})

test('worker honors bounded concurrency and never processes a candidate twice', async () => {
  let active = 0
  let peak = 0
  const processed: string[] = []
  const persisted: string[] = []
  const summary = await runReauditBatch({
    batchSize: 5,
    concurrency: 2,
    candidates: {
      async listCandidates() {
        return [
          candidate('one'),
          candidate('two'),
          candidate('three'),
          candidate('four'),
          candidate('five'),
        ]
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
      async process(item) {
        processed.push(item.callId)
        active += 1
        peak = Math.max(peak, active)
        await tick()
        active -= 1
        return {
          callId: item.callId,
          artifactId: item.artifactId,
          outcome: 'source_missing',
        }
      },
    },
  })

  assert.equal(summary.completed, 5)
  assert.equal(peak, 2)
  assert.equal(new Set(processed).size, 5)
  assert.deepEqual(new Set(persisted), new Set(processed))
})

test('worker records exact aggregate progress for out-of-order completions', async () => {
  let releaseSlow: (() => void) | null = null
  const progress: number[] = []
  const summary = await runReauditBatch({
    batchSize: 2,
    concurrency: 2,
    candidates: {
      async listCandidates() {
        return [candidate('slow'), candidate('fast')]
      },
    },
    results: {
      async markStarted() {
        return 'acquired'
      },
      async persist() {
        return 'completed'
      },
    },
    processor: {
      async process(item) {
        if (item.callId === 'slow') {
          await new Promise<void>((resolve) => {
            releaseSlow = resolve
          })
        } else {
          releaseSlow?.()
        }
        return {
          callId: item.callId,
          artifactId: item.artifactId,
          outcome: 'source_missing',
        }
      },
    },
    onProgress(current) {
      progress.push(current.completed)
    },
  })

  assert.equal(summary.completed, 2)
  assert.deepEqual(progress, [1, 2])
})

test('worker stops new claims while letting in-flight concurrent items settle', async () => {
  const claimed: string[] = []
  let checks = 0
  const summary = await runReauditBatch({
    batchSize: 3,
    concurrency: 2,
    candidates: {
      async listCandidates() {
        return [candidate('one'), candidate('two'), candidate('three')]
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
        await tick()
        return {
          callId: item.callId,
          artifactId: item.artifactId,
          outcome: 'source_missing',
        }
      },
    },
    async shouldContinue() {
      checks += 1
      return checks <= 2
    },
  })

  assert.deepEqual(claimed, ['one', 'two'])
  assert.equal(summary.completed, 2)
  assert.equal(summary.stoppedEarly, true)
})

test('worker waits for in-flight persistence and stops new claims after a fatal error', async () => {
  let markInFlightStarted!: () => void
  let releaseInFlight!: () => void
  const inFlightStarted = new Promise<void>((resolve) => {
    markInFlightStarted = resolve
  })
  const inFlightCanFinish = new Promise<void>((resolve) => {
    releaseInFlight = resolve
  })
  const claimed: string[] = []
  const persisted: string[] = []
  let settled = false

  const running = runReauditBatch({
    batchSize: 3,
    concurrency: 2,
    candidates: {
      async listCandidates() {
        return [candidate('fatal'), candidate('in-flight'), candidate('never')]
      },
    },
    results: {
      async markStarted(item) {
        claimed.push(item.callId)
        return 'acquired'
      },
      async persist(item) {
        persisted.push(item.callId)
        if (item.callId === 'fatal') throw new Error('storage unavailable')
        return 'completed'
      },
    },
    processor: {
      async process(item) {
        if (item.callId === 'fatal') {
          await inFlightStarted
        } else if (item.callId === 'in-flight') {
          markInFlightStarted()
          await inFlightCanFinish
        }
        return {
          callId: item.callId,
          artifactId: item.artifactId,
          outcome: 'source_missing',
        }
      },
    },
  })
  running.then(
    () => {
      settled = true
    },
    () => {
      settled = true
    },
  )

  await inFlightStarted
  await tick()
  assert.equal(settled, false)
  releaseInFlight()

  await assert.rejects(running, /storage unavailable/)
  assert.deepEqual(claimed, ['fatal', 'in-flight'])
  assert.deepEqual(new Set(persisted), new Set(['fatal', 'in-flight']))
})
