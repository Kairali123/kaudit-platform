# Automatic audit workers

Billing Audit and Call Audit run independently and default to `running` in
`kaudit_audit_worker_control`. The dashboard reports persisted results only; a
report request never triggers model work. Call Audit currently has no automatic
launcher: it must be started only by an explicit administrator operation while
the system is out of use.

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

### Pre-model spend leases (migration 0017)

Before any paid model call, the worker commits a row in
`kaudit_billing_spend_lease` keyed by the exact work identity (call, artifact,
evidence hash, ruleset/engine versions, manual queue item). Two overlapping
runs race on this primary key: exactly one may spend.

- `completed` — results were durably written; the question never re-spends.
- `released` — the worker proved no model call happened (for example the
  recording could not be fetched); the ordinary retry policy continues freely.
- `active` with staged output — an interrupted persistence step. The exclusively
  locked recovery worker persists the staged Kaudit-owned result instead of
  calling the model again.
- `active` with no staged output — ambiguous paid state. Recovery persists a
  bounded terminal `SPEND_STATE_UNKNOWN` result and never invokes the model.
- A persistence failure after model completion leaves staged output on the
  lease, so recovery cannot silently pay twice while persistence is pending.

Temporary staging contains only normalized fields required by the existing
final audit writer. It excludes URLs, prompts, raw responses/errors, displayed
references, and monetary projections, and is cleared after final persistence.

### Failure classification

Fatal infrastructure failures are reduced to a lifecycle phase (`claim`,
`processor`, `persist`, `progress`, `pool_acquisition`) plus ONE allowlisted
category (`DB_CONNECTION_LIMIT`, `DB_CONNECTION_TIMEOUT`, `DB_LOCK_TIMEOUT`,
`DB_DEADLOCK`, `DB_CONSTRAINT`, `WORKER_LIFECYCLE`, `DB_UNKNOWN`). Raw driver
or provider errors are never logged or persisted; the control row records e.g.
`BILLING_AUDIT_BATCH_FAILED_DB_DEADLOCK`. In-flight items drain after the first
fatal error, per-item success counts stay accurate even if progress reporting
fails, and advisory locking (`kaudit-independent-reaudit-v2`) still prevents
overlapping worker runs.

Concurrency defaults to `KAUDIT_AUDIT_CONCURRENCY=1`. The hosted scheduled
new-call drain deliberately sets concurrency and batch size to `10` for the
14,000-log daily target; administrator-selected re-audits stay at `1`. Every
mode keeps a fixed four-connection pool, so provider parallelism cannot widen
the database connection budget. Untouched logs are selected before retry work,
and only terminal outcomes increment the public failure counter.


## Call Audit

When explicitly started, `npm run callaudit:worker` polls the external source
every 60 seconds using `SELECT`-only keyset pagination over `(change timestamp,
source row id)`. Raw transcripts stay in memory for one model request and are
never returned by the control API.

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
It runs neither worker. Durable imports on Vercel require the configured Kaudit
Google Shared Drive storage; worker execution still requires a persistent worker
runtime with:

- restart supervision and one instance of each worker;
- the same least-privilege database and model configuration;
- durable import storage available before imports are submitted;
- centralized bounded-code logs and heartbeat monitoring; and
- migrations `0012_automatic_audit_workers.sql`, `0015_billing_reaudit_requests.sql`,
  and `0017_billing_spend_lease.sql` applied before worker startup.

Applying the migration, starting either production worker, and selecting the
worker host are deployment operations, not build steps.

Migration `0017` has a guarded hosted command for supervised installations:
dispatch the Billing workflow with `mode=migration-0017` and the exact
confirmation `APPLY_0017`. Apply and verify it as its own operation before any
repaired Billing worker starts; the migration command never starts a worker.

## Persistent dashboard control

Set `KAUDIT_AUDIT_WORKER_CONTROL_MODE=persistent` on the Vercel dashboard/API.
In this mode Resume updates `desired_state` in MySQL and performs no workflow
dispatch or provider request. The already-supervised process notices the state
on its next poll. Stop uses the same durable row and each worker checks it before
claiming another candidate.

Leave the variable unset to preserve the existing
`KAUDIT_GITHUB_WORKER_ENABLED` fallback. `disabled` makes Resume unavailable;
`github` explicitly selects the hosted workflow dispatcher.

## Host discovery gate

Do not install service files until the host has been inspected. Record these
facts without copying secret values into a ticket, shell history, or this file:

1. OS and version, init/process manager, and whether containers are already the
   established deployment pattern.
2. Unprivileged deployment account, repository or immutable release path, and
   writable state directories.
3. Node/npm paths and the exact supported Node major from `package.json`.
4. Secret delivery mechanism by name only: systemd credentials/environment
   file, container secret, or the host's existing secret manager.
5. Outbound access to MySQL, the model provider, and the recording proxy.

The selected supervisor must run Billing Audit as an independent service,
restart on failure with a bounded delay, send SIGTERM for graceful stop, cap
retained logs, and start only after networking and secret mounts are available.
Do not configure a Call Audit service while Call Audit is out of use. Never put
an environment value on a command line.

## Release shape

Build and verify an immutable release directory, then repoint the host's
`current` reference and restart one worker at a time. Keep the previous release
available for rollback. The Billing worker process needs this fixed command:

```text
npm run audit:worker
```

Billing Audit must receive `KAUDIT_AUDIT_MODE=EXECUTE` and
`KAUDIT_AUDIT_WATCH=true`. If Call Audit is later re-enabled by reviewed
administrator decision, it must retain the approved `KAUDIT_CALL_AUDIT_AUTO_START`
boundary for first initialization; once the SQL checkpoint exists, changing the
environment does not rewrite it.

## Safe smoke checks

After each service starts, verify only process status and the bounded public
worker state. Do not run `callaudit:batch`, the rule test lab, a sample audit, or
any command that sends evidence to a paid model. Confirm that:

- the Billing service process remains active and holds its advisory lock;
- heartbeats advance while desired state is `running`;
- Stop settles after the current candidate and Resume returns to polling;
- service logs contain only bounded codes and aggregate counters; and
- a second copy exits without processing because it cannot acquire the lock.

Rollback repoints `current` to the prior verified release and restarts services
separately. Database checkpoints, results, usage events, and permanent spend
claims are never rolled back or deleted with application code.
