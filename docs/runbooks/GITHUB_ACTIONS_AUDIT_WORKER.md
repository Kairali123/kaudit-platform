# Dashboard-triggered audit workers

This deployment shape is for installations whose dashboard runs on Vercel but
which do not have a persistent worker host. An administrator starts a bounded
GitHub-hosted worker from the Billing Audit or Call Audit report. The worker
drains currently eligible database work and exits when it is idle, paused,
faulted, or near its host deadline.

It is not a persistent process. New source changes that arrive after a job exits
wait for either the next administrator Run action or the next scheduled
workflow. GitHub-hosted usage is also bounded by the repository owner's Actions
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
- Call Audit runs every 12 hours at minute 17 UTC.

Every hosted Billing Audit mode sets `KAUDIT_AUDIT_CONCURRENCY=1` and
`KAUDIT_AUDIT_BATCH=1`. Keep Billing work sequential until measured database
headroom supports a reviewed change; the MySQL advisory lock still allows only
one Billing Audit worker process.

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
