# W2 — Reliable processing foundation

Status: implemented on `phase1-reliable-processing`; synthetic and disposable-MySQL
validation only. Migration 0005 has not been run against the real database.

## What this slice fixes

The existing outbox, inbox, job-attempt, and idempotency tables were empty and lacked
several fields required to operate safely. Migration 0005 expands them with:

- stable `message_id` and payload SHA-256;
- visible availability, lease owner/expiry, attempts, retry, and dead-letter state;
- correlation and safe error codes;
- consumer payload hash, completion time, and lease state;
- mutation processing/completed/failed state, response reference/hash, and request lock.

The implementation adds:

- deterministic canonical JSON and payload hashing;
- transaction-scoped outbox enqueue with duplicate/no-op behavior;
- an integrity error when the same message ID is reused with different content;
- `FOR UPDATE SKIP LOCKED` publisher claims for concurrent workers;
- publish-after-claim, bounded exponential retry, visible DLQ, and lease ownership checks;
- inbox duplicate-completed no-op, active-lease protection, retry after lease expiry, and
  changed-payload integrity conflict;
- mutation idempotency outcomes: acquired, replay, in-progress, and conflict;
- response references/hashes rather than storing sensitive response bodies in the
  idempotency record.

## Reliability contract

1. The domain mutation and outbox insert use the **same MySQL transaction** by constructing
   `createMysqlOutboxWriter(connection)` from that transaction's connection.
2. A publisher may deliver a message more than once if delivery succeeds but recording
   publication fails. This is expected at-least-once behavior.
3. Every consumer calls inbox `begin` before side effects and `complete` in the same
   transaction as its derived state where practical.
4. The same message ID with different bytes is an integrity incident, never a duplicate.
5. Retrying or replaying never deletes prior attempts or silently resets DLQ state.
6. A lease-lost writer fails rather than falsely claiming success.

## What remains

- Wire the first actual ingestion mutation to domain-write + outbox in one transaction.
- Select and configure the approved queue/DLQ service and implement its transport adapter.
- Add a publisher/consumer process, job-attempt audit events, metrics, alerts, and replay CLI.
- Migrate each existing direct write path incrementally; do not claim D2 fixed until no
  production mutation bypasses the pattern.
- Implement append-only call events and projection rebuilds for D3. This slice supplies
  reliable delivery; it does not create missing historical `kaudit_call_event` evidence.
- Audit any legacy outbox/inbox rows before making the new hash/message columns NOT NULL.

## Verification

- Pure policy and publisher tests cover canonical hashing, changed-byte conflict, completed
  duplicate, active/expired lease behavior, publish ordering, retry, bounded DLQ, and
  idempotent replay/conflict.
- Migration 0005 applied successfully to a disposable MySQL 9.6 database.
- The MySQL integration test produced one published outbox message, one completed inbox
  record, and one completed/replayable idempotency record.
