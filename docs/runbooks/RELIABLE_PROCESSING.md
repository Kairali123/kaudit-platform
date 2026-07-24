# Reliable processing rollout runbook

## Before staging

1. Confirm outbox/inbox/job/idempotency row counts and inspect only metadata/status fields.
2. Review migration 0005 for the deployed MySQL version and expected lock duration.
3. Restore the latest backup into an isolated environment and apply 0005 there first.
4. Run `KAUDIT_TEST_MYSQL_SOCKET=<isolated socket> npm run test:reliability:mysql`.
5. Confirm no legacy row has a reused message ID or unexplained status.

## Staged activation order

1. Apply migration 0005 (expand only).
2. Deploy compatible readers/writers while old direct writers remain unchanged.
3. Wire one low-risk ingestion mutation to domain state plus outbox in one transaction.
4. Run a no-external-effects transport in staging; inspect claims, retries, leases, and DLQ.
5. Activate one real queue transport in staging with synthetic events.
6. Kill a publisher after delivery but before `markPublished`; verify redelivery and inbox
   duplicate suppression produce one derived result.
7. Send the same message ID with changed bytes; verify an integrity incident and no side
   effect.
8. Only after each direct production write path is migrated and observed may D2 be closed.

## Stop conditions

- Do not apply 0005 to production without backup/restore evidence and a supervised owner.
- Do not acknowledge source evidence before durable capture.
- Do not publish raw payloads, recording URLs, transcripts, PII/health content, or secrets
  in queue messages; send opaque IDs and reload authorized state.
- Do not delete or reset DLQ/inbox/idempotency history to make a retry succeed.
- Do not use queue delivery as proof of exactly-once behavior.
