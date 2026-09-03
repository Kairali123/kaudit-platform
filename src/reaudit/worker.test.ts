import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ReauditCandidate, ReauditItemResult } from './types.ts'
import { runReauditBatch } from './worker.ts'
import { ReauditFatalError } from './failures.ts'

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

  const failure = await running.then(
    (summary) => summary,
    (error: unknown) => error as ReauditFatalError,
  )
  // The original storage error is never carried outward — only its bounded
  // lifecycle phase and allowlisted category.
  assert.ok(failure instanceof ReauditFatalError)
  assert.equal(failure.phase, 'persist')
  assert.ok(!String(failure).includes('storage unavailable'))
  assert.deepEqual(claimed, ['fatal', 'in-flight'])
  assert.deepEqual(new Set(persisted), new Set(['fatal', 'in-flight']))
})

test('a persistence failure is classified by phase and allowlisted category', async () => {
  const deadlock = Object.assign(new Error('synthetic'), {
    code: 'ER_LOCK_DEADLOCK',
  })
  let persistCalls = 0
  const failure = await runReauditBatch({
    batchSize: 1,
    candidates: {
      async listCandidates() {
        return [candidate('one')]
      },
    },
    results: {
      async markStarted() {
        return 'acquired'
      },
      async persist() {
        persistCalls += 1
        throw deadlock
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
  }).then(
    () => null,
    (error: unknown) => error as ReauditFatalError,
  )
  assert.ok(failure instanceof ReauditFatalError)
  assert.equal(failure.phase, 'persist')
  assert.equal(failure.category, 'DB_DEADLOCK')
  assert.ok(!String(failure).includes('synthetic'))
  assert.equal(persistCalls, 4)
})

test('a transient persistence deadlock reuses staged output without another model call', async () => {
  let processCalls = 0
  let persistCalls = 0
  let stageCalls = 0
  const settled: string[] = []
  const summary = await runReauditBatch({
    batchSize: 1,
    candidates: {
      async listCandidates() { return [candidate('transient-deadlock')] },
    },
    results: {
      async markStarted() { return 'acquired' },
      async persist() {
        persistCalls += 1
        if (persistCalls < 3) {
          throw Object.assign(new Error('synthetic'), {
            code: 'ER_LOCK_DEADLOCK',
          })
        }
        return 'completed'
      },
    },
    spendGuard: {
      async claim() { return { outcome: 'acquired' } },
      async stageResult() { stageCalls += 1 },
      async settle(_candidate, outcome) { settled.push(outcome) },
    },
    processor: {
      async process(item) {
        processCalls += 1
        return {
          callId: item.callId,
          artifactId: item.artifactId,
          outcome: 'classification_failed',
          errorCode: 'CLASSIFICATION_VALIDATION_FAILED',
        }
      },
    },
  })

  assert.equal(processCalls, 1)
  assert.equal(stageCalls, 1)
  assert.equal(persistCalls, 3)
  assert.deepEqual(settled, ['model_spent'])
  assert.equal(summary.completed, 1)
})

test('a no-model result is released for a free retry when persistence fails', async () => {
  const settled: string[] = []
  await assert.rejects(
    () => runReauditBatch({
      batchSize: 1,
      candidates: {
        async listCandidates() { return [candidate('free-retry')] },
      },
      results: {
        async markStarted() { return 'acquired' },
        async persist() {
          throw Object.assign(new Error('synthetic persistence failure'), {
            code: 'ER_LOCK_DEADLOCK',
          })
        },
      },
      spendGuard: {
        async claim() { return { outcome: 'acquired' } },
        async stageResult() { throw new Error('source-missing is not staged') },
        async settle(_candidate, outcome) { settled.push(outcome) },
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
    }),
    ReauditFatalError,
  )
  assert.deepEqual(settled, ['no_model_call'])
})

test('a claim failure is classified without exposing the driver error', async () => {
  const tooManyConnections = Object.assign(new Error('synthetic'), {
    code: 'ER_CON_COUNT_ERROR',
  })
  let processCalls = 0
  const failure = await runReauditBatch({
    batchSize: 2,
    candidates: {
      async listCandidates() {
        return [candidate('one'), candidate('two')]
      },
    },
    results: {
      async markStarted() {
        throw tooManyConnections
      },
      async persist() {
        return 'completed'
      },
    },
    processor: {
      async process() {
        processCalls += 1
        throw new Error('must not process')
      },
    },
  }).then(
    () => null,
    (error: unknown) => error as ReauditFatalError,
  )
  assert.ok(failure instanceof ReauditFatalError)
  assert.equal(failure.phase, 'claim')
  assert.equal(failure.category, 'DB_CONNECTION_LIMIT')
  assert.equal(processCalls, 0)
})

test('a progress/control failure keeps per-item success accurate', async () => {
  const persisted: string[] = []
  let progressFailures = 0
  const outcome = await runReauditBatch({
    batchSize: 3,
    concurrency: 1,
    candidates: {
      async listCandidates() {
        return [candidate('one'), candidate('two'), candidate('three')]
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
        return {
          callId: item.callId,
          artifactId: item.artifactId,
          outcome: 'source_missing',
        }
      },
    },
    onProgress: async () => {
      progressFailures += 1
      throw Object.assign(new Error('control plane down'), {
        code: 'PROTOCOL_CONNECTION_LOST',
      })
    },
  }).then(
    (summary) => ({ summary } as const),
    (error: unknown) => ({ error: error as ReauditFatalError } as const),
  )
  assert.ok('error' in outcome && outcome.error instanceof ReauditFatalError)
  const failure = 'error' in outcome ? outcome.error : null
  assert.ok(failure instanceof ReauditFatalError)
  assert.equal(failure.phase, 'progress')
  assert.equal(failure.category, 'DB_CONNECTION_TIMEOUT')
  assert.ok(!String(outcome.error).includes('control plane down'))
  // ...and every item that WAS processed stays counted accurately.
  assert.equal(progressFailures, 1)
  assert.deepEqual(persisted, ['one'])
})
test('a busy pre-model spend lease skips the model call entirely', async () => {
  const processed: string[] = []
  const claimed: string[] = []
  const settled: Array<[string, string]> = []
  const summary = await runReauditBatch({
    batchSize: 3,
    concurrency: 1,
    candidates: {
      async listCandidates() {
        return [candidate('leased'), candidate('free')]
      },
    },
    results: {
      async markStarted(item) {
        claimed.push(item.callId)
        return 'acquired'
      },
      async persist(item) {
        settled.push([item.callId, 'persisted'])
        return 'completed'
      },
    },
    spendGuard: {
      async claim(candidate) {
        return candidate.callId === 'leased'
          ? { outcome: 'busy' }
          : { outcome: 'acquired' }
      },
      async stageResult(candidate) {
        settled.push([candidate.callId, 'staged'])
      },
      async settle(candidate, outcome) {
        settled.push([candidate.callId, outcome])
      },
    },
    processor: {
      async process(item) {
        processed.push(item.callId)
        return {
          callId: item.callId,
          artifactId: item.artifactId,
          outcome: 'projected',
        } as ReauditItemResult
      },
    },
  })
  assert.deepEqual(processed, ['free'])
  assert.deepEqual(claimed, ['free'])
  assert.equal(summary.spendGuardSkipped, 1)
  assert.equal(summary.completed, 1)
  // The leased item never reached persist; only the free item settles spent.
  assert.deepEqual(settled, [
    ['free', 'staged'],
    ['free', 'persisted'],
    ['free', 'model_spent'],
  ])
})

test('a recovered spend lease persists staged output without another model call', async () => {
  let processCalls = 0
  const persisted: string[] = []
  const summary = await runReauditBatch({
    batchSize: 1,
    candidates: {
      async listCandidates() {
        return [candidate('recover')]
      },
    },
    results: {
      async markStarted() {
        return 'acquired'
      },
      async persist(_item, result) {
        persisted.push(result.outcome)
        return 'completed'
      },
    },
    spendGuard: {
      async claim(item) {
        return {
          outcome: 'recovered',
          result: {
            callId: item.callId,
            artifactId: item.artifactId,
            outcome: 'projected',
          } as ReauditItemResult,
        }
      },
      async stageResult() {
        throw new Error('recovered results are already staged')
      },
      async settle() {},
    },
    processor: {
      async process() {
        processCalls += 1
        throw new Error('must not call model')
      },
    },
  })
  assert.equal(processCalls, 0)
  assert.deepEqual(persisted, ['projected'])
  assert.equal(summary.completed, 1)
})

test('a closed spend lease terminalizes stale work without model or settlement', async () => {
  let processCalls = 0
  let settleCalls = 0
  const persisted: string[] = []
  const summary = await runReauditBatch({
    batchSize: 1,
    candidates: {
      async listCandidates() { return [candidate('closed-stale-work')] },
    },
    results: {
      async markStarted() { return 'acquired' },
      async persist(_candidate, result) {
        persisted.push(result.outcome)
        return 'terminal_failure'
      },
    },
    spendGuard: {
      async claim(item) {
        return {
          outcome: 'closed',
          result: {
            callId: item.callId,
            artifactId: item.artifactId,
            outcome: 'spend_state_unknown',
            errorCode: 'AUDIT_SPEND_STATE_UNKNOWN',
          },
        }
      },
      async stageResult() { throw new Error('closed result must not be staged') },
      async settle() { settleCalls += 1 },
    },
    processor: {
      async process() {
        processCalls += 1
        throw new Error('must not call model')
      },
    },
  })
  assert.equal(processCalls, 0)
  assert.equal(settleCalls, 0)
  assert.deepEqual(persisted, ['spend_state_unknown'])
  assert.equal(summary.terminalFailures, 1)
})

test('a paid failure result is staged and settled after persistence', async () => {
  const staged: string[] = []
  const settled: string[] = []
  const summary = await runReauditBatch({
    batchSize: 1,
    candidates: {
      async listCandidates() {
        return [candidate('failed-paid')]
      },
    },
    results: {
      async markStarted() {
        return 'acquired'
      },
      async persist() {
        return 'retry_scheduled'
      },
    },
    spendGuard: {
      async claim() {
        return { outcome: 'acquired' }
      },
      async stageResult(_candidate, result) {
        staged.push(result.outcome)
      },
      async settle(_candidate, outcome) {
        settled.push(outcome)
      },
    },
    processor: {
      async process(item) {
        return {
          callId: item.callId,
          artifactId: item.artifactId,
          outcome: 'classification_failed',
          errorCode: 'AUDIT_PROCESSOR_FAILED',
        }
      },
    },
  })
  assert.deepEqual(staged, ['classification_failed'])
  assert.deepEqual(settled, ['model_spent'])
  assert.equal(summary.retriesScheduled, 1)
})

test('a recovered paid failure closes the spend lease after persistence', async () => {
  const settled: string[] = []
  const summary = await runReauditBatch({
    batchSize: 1,
    candidates: {
      async listCandidates() {
        return [candidate('recover-failed')]
      },
    },
    results: {
      async markStarted() {
        return 'acquired'
      },
      async persist() {
        return 'retry_scheduled'
      },
    },
    spendGuard: {
      async claim(item) {
        return {
          outcome: 'recovered',
          result: {
            callId: item.callId,
            artifactId: item.artifactId,
            outcome: 'classification_failed',
            errorCode: 'AUDIT_PROCESSOR_FAILED',
          },
        }
      },
      async stageResult() {
        throw new Error('recovered results are already staged')
      },
      async settle(_candidate, outcome) {
        settled.push(outcome)
      },
    },
    processor: {
      async process() {
        throw new Error('must not call model')
      },
    },
  })
  assert.deepEqual(settled, ['model_spent'])
  assert.equal(summary.retriesScheduled, 1)
})

test('a retryable provider rejection releases spend without staging', async () => {
  const item = candidate('provider-retry')
  const staged: string[] = []
  const settled: string[] = []
  const summary = await runReauditBatch({
    candidates: {
      async listCandidates() {
        return [item]
      },
    },
    results: {
      async markStarted() {
        return 'acquired'
      },
      async persist() {
        return 'retry_scheduled'
      },
    },
    processor: {
      async process() {
        return {
          callId: item.callId,
          artifactId: item.artifactId,
          outcome: 'transcription_failed',
          errorCode: 'TRANSCRIPTION_PROVIDER_RETRYABLE',
        }
      },
    },
    spendGuard: {
      async claim() {
        return { outcome: 'acquired' }
      },
      async stageResult() {
        staged.push('staged')
      },
      async settle(_candidate, outcome) {
        settled.push(outcome)
      },
    },
    batchSize: 1,
  })

  assert.equal(summary.retriesScheduled, 1)
  assert.deepEqual(staged, [])
  assert.deepEqual(settled, ['no_model_call'])
})

test('an ambiguous paid boundary persists terminal state without another model call', async () => {
  let processCalls = 0
  const persisted: string[] = []
  const summary = await runReauditBatch({
    batchSize: 1,
    candidates: {
      async listCandidates() { return [candidate('spend-unknown')] },
    },
    results: {
      async markStarted() { return 'acquired' },
      async persist(_candidate, result) {
        persisted.push(result.outcome)
        return 'terminal_failure'
      },
    },
    spendGuard: {
      async claim(item) {
        return {
          outcome: 'recovered',
          result: {
            callId: item.callId,
            artifactId: item.artifactId,
            outcome: 'spend_state_unknown',
            errorCode: 'AUDIT_SPEND_STATE_UNKNOWN',
          },
        }
      },
      async stageResult() { throw new Error('already staged') },
      async settle() {},
    },
    processor: {
      async process() {
        processCalls += 1
        throw new Error('must not call model')
      },
    },
  })
  assert.equal(processCalls, 0)
  assert.deepEqual(persisted, ['spend_state_unknown'])
  assert.equal(summary.terminalFailures, 1)
})

test('a recovered result is never released if work-state claiming fails', async () => {
  const settled: string[] = []
  await assert.rejects(
    () => runReauditBatch({
      batchSize: 1,
      candidates: {
        async listCandidates() { return [candidate('recover-claim-fails')] },
      },
      results: {
        async markStarted() {
          throw Object.assign(new Error('synthetic claim failure'), {
            code: 'ER_LOCK_DEADLOCK',
          })
        },
        async persist() { return 'completed' },
      },
      spendGuard: {
        async claim(item) {
          return {
            outcome: 'recovered',
            result: {
              callId: item.callId,
              artifactId: item.artifactId,
              outcome: 'classification_failed',
            },
          }
        },
        async stageResult() {},
        async settle(_candidate, outcome) { settled.push(outcome) },
      },
      processor: {
        async process() { throw new Error('must not call model') },
      },
    }),
    ReauditFatalError,
  )
  assert.deepEqual(settled, ['unknown'])
})

test('a recovered result already superseded closes as spent, not released', async () => {
  const settled: string[] = []
  const summary = await runReauditBatch({
    batchSize: 1,
    candidates: {
      async listCandidates() { return [candidate('recover-superseded')] },
    },
    results: {
      async markStarted() { return 'already_completed' },
      async persist() { return 'completed' },
    },
    spendGuard: {
      async claim(item) {
        return {
          outcome: 'recovered',
          result: {
            callId: item.callId,
            artifactId: item.artifactId,
            outcome: 'classification_failed',
          },
        }
      },
      async stageResult() {},
      async settle(_candidate, outcome) { settled.push(outcome) },
    },
    processor: {
      async process() { throw new Error('must not call model') },
    },
  })
  assert.deepEqual(settled, ['model_spent'])
  assert.equal(summary.alreadyCompleted, 1)
})
