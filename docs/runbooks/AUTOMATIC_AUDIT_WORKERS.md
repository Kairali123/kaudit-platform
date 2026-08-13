# Automatic audit workers

Billing Audit and Call Audit run independently and default to `running` in
`kaudit_audit_worker_control`. The dashboard reports persisted results only; a
report request never triggers model work.

## Billing Audit

1. An administrator commits the usage CSV and matching invoice for a period.
2. The always-running `npm run audit:worker` process discovers eligible,
   recording-backed calls in SQL.
3. It checks durable administrator intent before every next call. Stop finishes
   the current call, then pauses; Resume continues from SQL.
4. Call-level failures are recorded with bounded codes and scheduled for retry.
   Later calls continue. Calls with no recording remain explicitly unresolved.

The worker does not begin a period until a matching `kaudit_invoice` row is in
an accepted state. Upload order therefore does not matter.

## Call Audit

`npm run callaudit:worker` polls the external source every 60 seconds using
`SELECT`-only keyset pagination over `(change timestamp, source row id)`. Raw
transcripts stay in memory for one model request and are never returned by the
control API.

The durable checkpoint advances only through settled candidates. Model failures
are persisted as failed results and processing continues. Infrastructure/source
failures retain the checkpoint, expose only a bounded error code, and retry on
the next polling cycle. The permanent source-revision spend claim continues to
prevent a second paid request for an unchanged revision.

`KAUDIT_CALL_AUDIT_AUTO_START` is required only before the first checkpoint is
initialized. It must be an independently reviewed UTC-naive boundary. A changed
existing checkpoint is never inferred from the environment.

## Deployment boundary

Vercel hosts the authenticated web/API application and the Stop/Resume command.
It runs neither worker and accepts no durable imports. A production deployment
therefore also requires a persistent worker/import runtime with:

- restart supervision and one instance of each worker;
- the same least-privilege database and model configuration;
- durable private `KAUDIT_IMPORT_ROOT` storage;
- centralized bounded-code logs and heartbeat monitoring; and
- migration `0012_automatic_audit_workers.sql` applied before worker startup.

Applying the migration, starting either production worker, and selecting the
worker host are deployment operations, not build steps.
