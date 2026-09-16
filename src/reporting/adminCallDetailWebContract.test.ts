import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const root = process.cwd()

test('the call detail contract distinguishes final, projected, and unavailable', async () => {
  const api = await readFile(
    path.join(root, 'apps/web/src/lib/api.ts'),
    'utf8',
  )

  assert.match(
    api,
    /authority: 'final' \| 'projected' \| 'unavailable'/,
  )
  assert.match(api, /projectionRulesetVersion: string \| null/)
  assert.match(api, /cappedByVendorAmount: boolean/)
})

test('the browser displays the server amount and never calculates money', async () => {
  const page = await readFile(
    path.join(root, 'apps/web/src/pages/AuditCallDetailPage.tsx'),
    'utf8',
  )

  assert.match(page, /auditor\.authority === 'projected'/)
  assert.match(page, /money\(data\.comparison\.auditor\.amount\)/)
  assert.match(page, /AI audit charge/)
  assert.match(page, /Auditor verified charge/)
  assert.doesNotMatch(page, /roundKServeChargeableDuration/)
  assert.doesNotMatch(page, /KSERVE_RATE_PER_MINUTE/)
})

test('the page exposes the stored endpoint, grace, and adjusted duration', async () => {
  const page = await readFile(
    path.join(root, 'apps/web/src/pages/AuditCallDetailPage.tsx'),
    'utf8',
  )

  assert.match(page, /durations\.chargeableServiceEndMs/)
  assert.match(page, /durations\.appliedBillingGraceMs/)
  assert.match(page, /durations\.adjustedChargeableMs/)
})

test('an agent failure explains why a zero-rated category carried a charge', async () => {
  const [api, page] = await Promise.all([
    readFile(path.join(root, 'apps/web/src/lib/api.ts'), 'utf8'),
    readFile(
      path.join(root, 'apps/web/src/pages/AuditCallDetailPage.tsx'),
      'utf8',
    ),
  ])

  // AGENT_FAILURE is the one zero-rated category whose charge can be non-zero,
  // so the evidence behind that is shown rather than left to be inferred.
  assert.match(api, /mode: 'start' \| 'mid_conversation'/)
  assert.match(api, /meaningfulServiceBeforeFailure: boolean/)
  assert.match(api, /failureStartMs: number \| null/)
  assert.match(page, /data\.agentFailure\.mode === 'mid_conversation'/)
  assert.match(page, /data\.agentFailure\.meaningfulServiceBeforeFailure/)
  assert.match(page, /seconds\(data\.agentFailure\.failureStartMs\)/)
})
