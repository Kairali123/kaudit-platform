import { test } from 'node:test'
import assert from 'node:assert/strict'
import mysql from 'mysql2/promise'
import {
  billingSpendLeaseId,
  MAX_SPEND_LEASE_ATTEMPTS,
} from './mysqlBillingSpendLease.ts'
import { classifyErrorCategory } from '../reaudit/failures.ts'
import type { ReauditCandidate } from '../reaudit/types.ts'

/**
 * Real-MySQL coverage for the durable pre-model Billing spend lease
 * (migration 0017). Runs ONLY against an isolated local fixture socket under
 * /tmp — never against production or any shared environment. All rows are
 * synthetic identifiers.
 */
const socketPath = process.env.KAUDIT_TEST_MYSQL_SOCKET
const safeSocket =
  socketPath?.startsWith('/tmp/kaudit-') && socketPath.endsWith('/mysql.sock')
    ? socketPath
    : null

const candidate = (id: string): ReauditCandidate => ({
  callId: id,
  artifactId: `artifact-${id}`,
  sourceUrl: `https://recordings.example.test/${id}.ogg`,
  baselineSha256: null,
  claimedDurationMs: 30_000,
  connectedDurationMs: 30_000,
  vendorBilledMinutes: '1',
})

const claimOutcome = (claim: { outcome: string }): string => claim.outcome

test(
  'spend leases survive real MySQL concurrency, expiry, and lock timeouts',
  { skip: safeSocket == null },
  async () => {
    const pool = mysql.createPool({
      socketPath: safeSocket as string,
      user: 'root',
      database: 'kaudit_verify',
      connectionLimit: 6,
    })
    try {
      await pool.query('DELETE FROM kaudit_billing_spend_lease')
      const guard = (
        await import('./mysqlBillingSpendLease.ts')
      ).createMysqlBillingSpendGuard(pool)
      const at = new Date()

      // 1+2. Two overlapping runs race for the same question: exactly one may
      // spend. A DIFFERENT question claims freely.
      const [first, second, other] = await Promise.all([
        guard.claim(candidate('race-a')),
        guard.claim(candidate('race-a')),
        guard.claim(candidate('race-b')),
      ])
      assert.equal(
        [first, second].filter((r) => r.outcome === 'acquired').length,
        1,
      )
      assert.equal(other.outcome, 'acquired')

      // 3. Settling as completed closes the question forever.
      const completedId = billingSpendLeaseId(candidate('settled-done'))
      assert.equal(claimOutcome(await guard.claim(candidate('settled-done'))), 'acquired')
      await guard.settle(candidate('settled-done'), 'model_spent')
      const [doneRow] = await pool.execute<mysql.RowDataPacket[]>(
        'SELECT status FROM kaudit_billing_spend_lease WHERE id = ?',
        [completedId],
      )
      assert.equal(doneRow[0]?.status, 'completed')
      assert.equal(
        claimOutcome(await guard.claim(candidate('settled-done'))),
        'closed',
      )

      // 4. Proving NO model call happened releases the question immediately.
      assert.equal(claimOutcome(await guard.claim(candidate('released'))), 'acquired')
      await guard.settle(candidate('released'), 'no_model_call')
      assert.equal(
        claimOutcome(await guard.claim(candidate('released'))),
        'acquired',
      )

      // 5. An unknown outcome keeps the lease ACTIVE: a persistence failure
      // after model completion must never free the question for a second paid
      // call while the lease lives.
      assert.equal(claimOutcome(await guard.claim(candidate('unknown'))), 'acquired')
      await guard.settle(candidate('unknown'), 'unknown')
      const [statusRow] = await pool.execute<mysql.RowDataPacket[]>(
        'SELECT status FROM kaudit_billing_spend_lease WHERE id = ?',
        [billingSpendLeaseId(candidate('unknown'))],
      )
      assert.equal(statusRow[0]?.status, 'active')

      // 5a. A different guard cannot stage or settle another worker's active
      // claim, even when it knows the deterministic work identity.
      const ownership = candidate('ownership')
      assert.equal(claimOutcome(await guard.claim(ownership)), 'acquired')
      const competingGuard = (
        await import('./mysqlBillingSpendLease.ts')
      ).createMysqlBillingSpendGuard(pool)
      await assert.rejects(
        () => competingGuard.stageResult(ownership, {
          callId: ownership.callId,
          artifactId: ownership.artifactId,
          outcome: 'classification_failed',
          errorCode: 'CLASSIFICATION_FAILED',
        }),
        (error: Error & { code?: string }) =>
          error.code === 'REAUDIT_ITEM_STATE_CONFLICT',
      )
      await assert.rejects(
        () => competingGuard.settle(ownership, 'model_spent'),
        (error: Error & { code?: string }) =>
          error.code === 'REAUDIT_ITEM_STATE_CONFLICT',
      )
      await guard.settle(ownership, 'no_model_call')

      // 5b. If the paid model result was staged before persistence failed, a
      // later worker recovers that result and must not call the model again.
      const staged = candidate('staged')
      assert.equal(claimOutcome(await guard.claim(staged)), 'acquired')
      await guard.stageResult(staged, {
        callId: staged.callId,
        artifactId: staged.artifactId,
        outcome: 'classification_failed',
        errorCode: 'CLASSIFICATION_FAILED',
      })
      await pool.execute(
        `UPDATE kaudit_billing_spend_lease
         SET lease_expires_at = ?
         WHERE id = ?`,
        [new Date(Date.now() - 1000), billingSpendLeaseId(staged)],
      )
      const recovered = await guard.claim(staged)
      assert.equal(recovered.outcome, 'recovered')
      assert.equal(
        recovered.outcome === 'recovered'
          ? recovered.result.outcome
          : null,
        'classification_failed',
      )

      // 6. An unstaged interruption never gets a second paid attempt. Recovery
      // returns a bounded terminal result for the normal persistence path.
      const backdated = new Date(Date.now() - 3 * 3600_000)
      const expiresPast = new Date(backdated.getTime() - 60_000)
      const interrupted = candidate('interrupted')
      const leaseId = billingSpendLeaseId(interrupted)
      await pool.execute(
        `INSERT INTO kaudit_billing_spend_lease
           (id, call_id, artifact_id, status, attempt_count,
            worker_id, claimed_at, lease_expires_at)
         VALUES (?, ?, ?, 'active', 1, 'ghost-worker', ?, ?)`,
        [
          leaseId,
          interrupted.callId,
          interrupted.artifactId,
          backdated,
          expiresPast,
        ],
      )
      const interruptedRecovery = await guard.claim(interrupted)
      assert.equal(interruptedRecovery.outcome, 'recovered')
      assert.equal(
        interruptedRecovery.outcome === 'recovered'
          ? interruptedRecovery.result.outcome
          : null,
        'spend_state_unknown',
      )
      const [reclaimed] = await pool.execute<mysql.RowDataPacket[]>(
        'SELECT attempt_count, status FROM kaudit_billing_spend_lease WHERE id = ?',
        [leaseId],
      )
      assert.equal(Number(reclaimed[0]?.attempt_count), 1)
      await guard.settle(interrupted, 'model_spent')
      assert.equal(
        claimOutcome(await guard.claim(interrupted)),
        'closed',
      )
      const [terminal] = await pool.execute<mysql.RowDataPacket[]>(
        'SELECT status FROM kaudit_billing_spend_lease WHERE id = ?',
        [leaseId],
      )
      assert.equal(terminal[0]?.status, 'completed')
      assert.ok(MAX_SPEND_LEASE_ATTEMPTS === 1)

      // 7. Lock contention surfaces as ONE allowlisted category. A dedicated
      // single-connection pool gets a 1s lock-wait timeout; a blocker
      // transaction holds the row the guard needs to update.
      const locked = candidate('locked')
      const lockedLeaseId = billingSpendLeaseId(locked)
      await pool.execute(
        `INSERT INTO kaudit_billing_spend_lease
           (id, call_id, artifact_id, status, attempt_count,
            worker_id, claimed_at, lease_expires_at)
         VALUES (?, ?, ?, 'active', 1, 'w', ?, ?)`,
        [
          lockedLeaseId,
          locked.callId,
          locked.artifactId,
          new Date(),
          new Date(Date.now() + 3600_000),
        ],
      )
      const slowPool = mysql.createPool({
        socketPath: safeSocket as string,
        user: 'root',
        database: 'kaudit_verify',
        connectionLimit: 1,
      })
      try {
        await slowPool.query('SET SESSION innodb_lock_wait_timeout = 1')
        const slowGuard = (
          await import('./mysqlBillingSpendLease.ts')
        ).createMysqlBillingSpendGuard(slowPool)
        const blocker = await pool.getConnection()
        try {
          await blocker.beginTransaction()
          await blocker.execute(
            'SELECT id FROM kaudit_billing_spend_lease WHERE id = ? FOR UPDATE',
            [lockedLeaseId],
          )
          const failure = await slowGuard
            .settle(locked, 'model_spent')
            .then(() => null)
            .catch((error: unknown) => error)
          assert.ok(failure instanceof Error, 'settle should fail on lock wait')
          assert.equal(classifyErrorCategory(failure), 'DB_LOCK_TIMEOUT')
          // The bounded classification never quotes driver detail.
          assert.ok(!String(failure).includes('kaudit_verify'))
        } finally {
          await blocker.rollback().catch(() => undefined)
          blocker.release()
        }
      } finally {
        await slowPool.end()
      }
    } finally {
      await pool.end()
    }
  },
)
