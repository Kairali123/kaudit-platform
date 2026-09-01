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
