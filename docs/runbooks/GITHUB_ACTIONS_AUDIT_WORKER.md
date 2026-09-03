# Dashboard-triggered audit workers

GitHub run titles begin with the selected mode. `new / billing` performs the
bounded new-call drain. Every `diagnose-*` mode is read-only, performs no audit,
and exits after printing its diagnostic result. `diagnose-monitor` also requires
an explicit `YYYY-MM` diagnostic month.

This deployment shape is for installations whose dashboard runs on Vercel but
which do not have a persistent worker host. An administrator starts a bounded
GitHub-hosted worker from the Billing Audit or Call Audit report. The worker
drains currently eligible database work and exits when it is idle, paused,
faulted, or near its host deadline.

It is not a persistent process. New Billing Audit source changes that arrive
after a job exits wait for either the next administrator Run action or the next
scheduled Billing workflow. Call Audit has no scheduled workflow while it is out
of use. GitHub-hosted usage is also bounded by the repository owner's Actions
allowance.

## Security boundary

- The browser sends only `billing` or `call` to the authenticated administrator
  endpoint.
- The GitHub token exists only in the dashboard environment and needs the
  fine-grained repository permission **Actions: write**.
- Database, provider, proxy, CA, and source-window values exist only as GitHub
  Actions secrets. Never place them in workflow YAML, repository variables,
  artifacts, or logs.
- Workflow logs contain bounded status and aggregate counts only. The workflow
  uploads no artifact.
- The existing MySQL advisory locks and Call Audit spend claim prevent
  overlapping jobs from duplicating paid work.
- Stop changes durable database intent. A worker finishes its current item,
  checks that intent before claiming another, records `paused`, and exits.

## Required GitHub Actions secrets

Configure these without printing their values:

```
DB_HOST
DB_PORT
DB_NAME
DB_USER
DB_PASSWORD
DB_TLS_MODE
DB_SSL_CA_PEM
KAUDIT_DATABASE_SESSION_SECRET
OPENAI_API_KEY
KAUDIT_ALLOWED_RECORDING_HOSTS
KAUDIT_UNPOD_PROXY_BASE
KAUDIT_CALL_AUDIT_AUTO_START
```

For a deliberately scoped Billing Audit re-audit, configure the temporary
secret `KAUDIT_TARGETED_REAUDIT_SCOPE_B64` to the base64 encoding of the private
cleanup manifest. Dispatch the workflow with `system=billing` and
`mode=targeted`. The runner decodes the secret only under `RUNNER_TEMP`, requires
append-only re-audit mode, processes at most one bounded batch, and removes the
scope in an `always()` cleanup step. Delete the repository secret immediately
after the run. Never use a workflow input, repository variable, artifact, or log
for the manifest because those surfaces expose identifiers.

`DB_SSL_CA_FILE` is not used on a hosted runner. Use the inline PEM secret. If
the production database explicitly uses `DB_TLS_MODE=disabled`, leave the PEM
secret empty; the runtime refuses a CA beside disabled mode.

`KAUDIT_CALL_AUDIT_AUTO_START` is used only if no durable Call Audit checkpoint
exists yet. Once initialized, the database checkpoint is authoritative.

## Required dashboard variables

```
KAUDIT_GITHUB_WORKER_ENABLED=true
KAUDIT_GITHUB_WORKER_REPOSITORY=<owner>/<repository>
KAUDIT_GITHUB_WORKER_REF=main
KAUDIT_GITHUB_WORKER_TOKEN=<fine-grained token>
```

The workflow file must be present on the default branch before dispatch is
enabled. Enabling an incomplete configuration makes dashboard startup fail
closed. A refused provider dispatch becomes only
`AUDIT_WORKER_DISPATCH_FAILED`; provider response text is discarded.

The persistent dashboard token needs only repository **Actions: write**. It
cannot provision repository secrets. Initial secret setup requires a separate,
temporary fine-grained token with repository **Secrets: write**. Keep that
provisioning token out of Vercel and tracked files, remove its local copy as soon
as the secret names are verified, and revoke it after setup.

## Scheduled operation

The repository also contains `.github/workflows/scheduled-audit-workers.yml`.
It calls the same hosted worker workflow with inherited repository secrets:

- Billing Audit runs every 6 hours at minute 47 UTC and drains new eligible
  billing calls until idle or near the GitHub job deadline.
- Call Audit does not run on a schedule. It remains available only through an
  explicit administrator dispatch of the reusable worker workflow.

The hosted new-call drain uses batch size `10` and concurrency `10`. This is the
bounded provider-work setting required for the 14,000-log daily target after
sequential production runs averaged about 30 seconds per attempt. Untouched
logs are selected before retry work. Targeted and requested re-audits remain at
batch size and concurrency `1` so administrator-selected work stays strictly
sequential. Provider parallelism does not widen the four-connection work pool.
Billing control intent and heartbeats use one isolated connection so work-pool
pressure cannot starve liveness or Stop/Resume handling. The MySQL advisory lock
still allows only one Billing Audit worker process. The dashboard
terminal-failure counter no longer increments for scheduled retries; its
pre-change historical value still includes retry attempts.
Concurrent persistence locks the call row before audit history and retries a
rolled-back deadlock transaction up to three times with bounded backoff. These
retries reuse the staged result and never invoke a model again.
While a Billing batch is active, the worker publishes a control heartbeat every
minute independently of per-call completion. A long bounded provider request
therefore cannot be mistaken for a stopped worker by the five-minute monitor.
A new worker waits for that lock for at most 30 seconds. If another database
session still owns it, the worker performs no queue or model work, records
`BILLING_AUDIT_LOCK_BUSY`, marks the monitor faulted, and exits. Never
automatically kill the owner: first establish that the owning database session
is stale rather than legitimate in-flight work.

## Spend-lease migration gate

Migration `0017_billing_spend_lease.sql` must exist before the repaired Billing
Audit worker starts. Apply it only as a separately approved, supervised Billing
workflow dispatch: select `mode=migration-0017` and type `APPLY_0017` in the
confirmation field. The command refuses a missing `0015` queue prerequisite,
validates the complete column/index/constraint contract, and emits only a
bounded result. It performs no worker or model work.

Run `diagnose-requested` after the migration and before enabling Billing worker
runs. Do not combine schema application and worker startup in one operation.

Run `diagnose-failures` with `system=billing` to inspect aggregate failure
families, classification subcodes, current retry-state buckets, and worker
totals. This mode is read-only and model-free. It emits no identifiers, URLs,
transcript content, prompts, raw errors, or amounts.

## Billing read performance diagnostic

Before applying dashboard read indexes, manually dispatch the worker with:

```
system=billing
mode=diagnose-billing-performance
diagnostic_month=YYYY-MM
```

This mode is read-only and model-free. It runs the same seven aggregate reads
used by the billing dashboard with a 45-second database-side limit per query,
then reports:

- database engine family;
- required index state as `present`, `equivalent`, or `missing`;
- timing buckets for each billing read stage; and
- summarized `EXPLAIN FORMAT=JSON` access type, chosen key, and estimated rows.

It never logs query parameters, aggregate values, money, identifiers, URLs,
transcript content, prompts, or raw errors. Unrelated model, proxy, session, and
targeted re-audit secrets are removed from the diagnostic process environment.

Do not set `KAUDIT_BILLING_READ_TIMEOUT_SECONDS` yet. After all required
indexes are confirmed and the post-index p99 is measured, set it to a whole
number from 1 through 25 that is safely above that p99. With the variable
absent, production billing reads remain unbounded; this prevents an unmeasured
timeout from turning the current slow page into a hard outage.

The same variable also bounds the Audit Monitor's aggregates (`/api/v1/audits`).
Those reads previously ran on the unbounded pool, so an aggregate could hold a
pooled connection past the request that asked for it and surface as a host
timeout rather than this server's own `QUERY_TIMEOUT`. Measure the monitor's
sections alongside the billing stages before choosing a value.

For the supervised June 2026 close, `finalize-june-bill-audit` requires the
exact confirmation `FINALIZE_JUNE_BILL_AUDIT`. It performs no model call. It
settles the **exhausted recording-backed cohort only**
(`KAUDIT_CYCLE_CLOSE_COHORT=exhausted-recording`): calls that have a recording,
whose independent audit is finished trying, and which the audit worker will
never claim again. Each is recorded as `accepted_as_billed_unverified` with
reason `INDEPENDENT_AUDIT_EXHAUSTED_ACCEPTED_AS_BILLED`, priced from the stored
KServe amount — or, when KServe supplied no amount, its billed minutes at the
locked rate — and carrying KServe's own claimed and connected durations. No
independently measured duration is invented for a call nothing listened to.

The cohort deliberately excludes two populations. No-recording calls are
already resolved at ₹0.00 under their own `no_recording_zero` basis and must
not be re-priced. Exhausted calls whose last error is
`CLASSIFICATION_VALIDATION_FAILED` or `AUDIT_SPEND_STATE_UNKNOWN` with attempts
still remaining are excluded because the audit worker will re-claim them —
settling those would take money away from an audit that is still going to run.

Run `diagnose-june-bill-audit` first. It is read-only (`DRY-RUN`), needs no
confirmation, and reports the same cohort the money run would settle plus the
rate-card state.

**If either mode exits 3 with `RATE_CARD_RULESET_BINDING_INVALID`,** the stored
`kaudit_rate_card_version.ruleset_sha256` for the named card does not equal the
locked `KSERVE_RULESET_SHA256` in `src/billing/kserveRules.ts`. The output
prints both hashes. Nothing was read past that point and no money was written.
This is the same D-03 gate independent billing enforces, and it is not
bypassable from the command: re-publish the rate card version bound to the
locked ruleset through the approval path, then re-run. Do not edit the locked
ruleset to match a stored hash — that would silently re-date the finance-
approved interpretation.

A successful diagnostic does not authorize a migration. Review its index and
plan output, capture the pre-change API response through the authenticated
operator flow, and obtain separate supervised approval before applying 0014,
0016, or 0018. Run the same diagnostic and compare the sanitized API response
after each approved index change. P1-P5 must not change displayed billing
values.

After that approval, dispatch `system=billing` with
`mode=migration-billing-read-indexes` and the exact confirmation
`APPLY_BILLING_READ_INDEXES`. The command skips any equivalent existing index,
refuses a conflicting named definition, adds only the ten allowlisted indexes
from 0014, 0016, and 0018, requires online `LOCK=NONE` DDL, and verifies every
index after application. A partial infrastructure failure may leave a verified
prefix applied; rerunning the same confirmed command safely skips that prefix.

## Operation

1. Open the matching audit report as an administrator.
2. Press **Run audit**. A second press while it is active is shown as **Stop
   audit** instead of starting another job.
3. Press **Stop audit** to request a graceful stop after the current item.
4. Press **Resume audit** to dispatch a new drain job from durable progress.

An idle job has completed the currently eligible queue, not all future work. A
faulted job requires the bounded error code to be resolved before Run is tried
again.

## Billing imports on Vercel

This worker audits data already present in the database. It does not make the
Vercel upload endpoint durable by itself: invoice PDFs and usage CSVs are durable
only when the Vercel web/API runtime is configured with the Kaudit Google Shared
Drive import-storage variables. Never route upload bytes through GitHub workflow
inputs or artifacts.
