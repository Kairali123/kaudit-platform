# Runbook — Vercel web/API production candidate

Status: **code foundation only.** Nothing here has been deployed, no Vercel project
is linked, and no production approval is claimed or implied.

## What a Vercel deployment is, and is not

Vercel hosts **the authenticated web/API application only** — the routed pages, the
`/api/v1/*` reads, `/health/live`, `/health/ready`, and OIDC login/logout. One Node.js
24 Function (`api/index.ts`) serves all of it through the same server, the same
permission checks, and the same access-audit writes as the persistent
`npm run ui:secure` process.

A web deployment starts **none** of the following. Each remains an independently
supervised operator process, exactly as it is today:

| Not started by a web deployment | Where it stays |
| --- | --- |
| Monthly billing cycle close | `npm run billing:cycle-close` |
| Continuous re-audit worker | `npm run audit:worker` |
| Continuous Call Audit worker | `npm run callaudit:worker` |
| Call Audit backfill/batch processing | `npm run callaudit:batch`, `docs/runbooks/CALL_AUDIT_BATCH.md` |
| Automated report email worker | `npm run report:email-worker`, `docs/runbooks/AUTOMATED_REPORT_EMAIL.md` |
| Automated validation pass | `npm run automation:validate` |
| Database migrations | Supervised, approved operations only |
| Monthly usage/invoice imports | Persistent server with a durable `KAUDIT_IMPORT_ROOT` |

There are **no Cron entries** in `vercel.json` and no scheduler in the function. This
is enforced by `src/vercel/deploymentContract.test.ts`, not only by convention.

Vercel does expose the authenticated administrator Stop/Resume API. It writes
only durable desired state in MySQL; it never executes a model call. The two
persistent workers observe that state before claiming each next call.

### Imports are disabled on Vercel, deliberately

The cycle import service content-addresses the uploaded bytes under
`KAUDIT_IMPORT_ROOT` on the local filesystem. A Function's disk is not shared between
instances and does not survive a freeze, so the service is **not constructed** in the
Vercel runtime. `/tmp` is not used as a stand-in, and no object store was added in this
slice.

The effect is a bounded refusal *before the upload is read*:

- `POST /api/v1/imports/usage` and `/api/v1/imports/invoice` → `503 IMPORT_NOT_AVAILABLE`
- `POST /api/v1/imports/analyze-usage` and `/api/v1/imports/analyze-invoice` →
  `503 IMPORT_ANALYSIS_NOT_CONFIGURED`
- `GET /api/v1/imports` → `503 IMPORT_NOT_AVAILABLE` (never a 200 claiming imports work)

The refusal happens after authorization and before the request body, so an
unauthenticated caller learns nothing, and no uploaded byte is buffered, stored, or
echoed back. Monthly imports continue to run against the persistent server, unchanged.

## Routing contract

`vercel.json` uses legacy `routes`, which removes Vercel's implicit filesystem step.
That is the security property: without it, a built `index.html` sitting in the output
directory would be served statically at `/`, handing the application shell to anyone
and skipping both the page permission check and the access-audit row.

```
/assets/(.*)  ->  /assets/$1     Vite hashed, immutable, already public
/(.*)         ->  /api           everything else, authenticated
```

SPA deep links (`/overview`, `/billing`, `/audits/call`, `/call-audit/settings`, …)
therefore reach `index.html` only through the authenticated handler. `rewrites` and
`redirects` are deliberately absent — they cannot be combined with `routes` and would
reintroduce the filesystem step ahead of the catch-all.

The function receives the original request path and query and passes them to the
existing router untouched. **Confirm this on the preview deployment** (first smoke gate
below) before promoting: it is a property of the platform's router, not of this
repository, so it is verified rather than assumed.

## Node version

Node 24 is selected through the repository's existing engine contract,
`engines.node` in `package.json`. The project is not downgraded to suit the platform.

## Environment variables

Names only. Set values in the Vercel project's environment settings as secrets, per
environment. Never commit a value, and never paste one into a ticket or a log.

**Identity (OIDC — mandatory in production; `local` and `preview` modes are rejected
outside loopback)**

```
KAUDIT_AUTH_MODE
KAUDIT_OIDC_ISSUER
KAUDIT_OIDC_AUDIENCE
KAUDIT_OIDC_JWKS_URI
KAUDIT_OIDC_LOGIN_URL
KAUDIT_OIDC_LOGOUT_URL
KAUDIT_OIDC_TOKEN_COOKIE
KAUDIT_OIDC_ALGORITHMS
```

**MySQL**

```
DB_HOST
DB_PORT
DB_NAME
DB_USER
DB_PASSWORD
```

**MySQL transport — an explicit decision**

```
DB_TLS_MODE        required (default) | disabled
```

`required` is the verified-TLS posture: exactly one CA source, `rejectUnauthorized`
and `verifyIdentity` both on, so the certificate must chain to the configured
authority **and** have been issued for `DB_HOST`.

`disabled` is a plaintext connection, matching the transport the CRM already uses
against the same database instance. It is an accepted downgrade, and it only ever
happens because this variable says so: a missing CA is **never** read as consent to
plaintext, in production or anywhere else. Unset or blank means `required`, and any
other value — `off`, `false`, `0`, `prefer` — is refused at startup and by the
preflight rather than guessed at. In `disabled` mode the runtime hands the driver no
`ssl` option at all, and **either CA variable being set is rejected**: trust material
that would be silently ignored is a configuration that lies about its own connection.

**MySQL TLS — exactly one CA source (`required` mode only)**

```
DB_SSL_CA_PEM      inline CA PEM; use this on Vercel
DB_SSL_CA_FILE     mounted CA path; use this on hosts that mount secret files
```

Vercel mounts no secret file, so the CA arrives inline as `DB_SSL_CA_PEM`. A
single-line value with `\n` separators is accepted. In `required` mode production
requires one of the two and **rejects both being set at once**: after a CA rotation
only one is current, and a runtime that silently prefers the other would keep trusting
a stale authority. The CA content is never logged, returned, hashed, or persisted.

Workers and CLIs continue to read `DB_SSL_CA_FILE`. If a host runs both a worker and a
web deployment, give each its own environment with its own single CA source.

**Runtime and release gates**

```
NODE_ENV
KAUDIT_TRUST_PROXY
KAUDIT_CALIBRATION_COMPLETE
KAUDIT_AUTOMATED_VALIDATION_APPROVED
KAUDIT_REPORTING_APPROVED
KAUDIT_WEB_DIST_ROOT          optional; only if the built web root is not under the function's working directory
```

**Recording references (only if admin call review is used)**

```
KAUDIT_UNPOD_PROXY_BASE
KAUDIT_ALLOWED_RECORDING_HOSTS
```

**Optional admin rule TEST LAB opt-in**

```
KAUDIT_CALL_AUDIT_RULE_TEST_ENABLED
OPENAI_API_KEY
```

Deny-by-default and unchanged by this deployment path. Both are required together:
the flag is the consent, the key is only the means. Anything but the exact word `true`
leaves the endpoint reporting itself unavailable before it reads a body. `OPENAI_API_KEY`
is needed **only** if the rule TEST LAB is deliberately enabled — import analysis, its
other consumer, is not constructed on Vercel at all. Leave both unset otherwise.

**Optional dashboard-triggered audit workers**

```
KAUDIT_GITHUB_WORKER_ENABLED
KAUDIT_GITHUB_WORKER_REPOSITORY
KAUDIT_GITHUB_WORKER_REF
KAUDIT_GITHUB_WORKER_TOKEN
```

This capability is deny-by-default. When enabled, all four variables are required
and the token must be a fine-grained repository credential limited to Actions:
write. The workflow and its separate worker secrets are described in
`docs/runbooks/GITHUB_ACTIONS_AUDIT_WORKER.md`. Provider responses and token values
are never returned or logged.

Do **not** set `KAUDIT_IMPORT_ROOT`, `KAUDIT_SECURE_PORT`, `KAUDIT_DEV_USER_EMAIL`,
`KAUDIT_LOCAL_PASSWORD_HASH`, or `KAUDIT_LOCAL_SESSION_SECRET` on Vercel. The function
binds no port and production rejects local password mode.

## Preflight — run this before any deployment

```
npm run vercel:preflight
```

Run it with the production-candidate variables exported in the shell (or as CI
secrets) — it loads no `.env` file, so what it checks is exactly what it is given.
Exit `0` means the environment contract holds; any other exit is a stop.

Output is one JSON line and nothing else. A pass names the optional features that
are switched on; a failure names bounded error codes and the **variable names**
involved. No value, path, URL, issuer, CA text, key, or thrown-error text is ever
printed, so the output is safe to keep in a CI log.

```
{"preflight":"vercel-release","result":"pass","checks":14,"optionalFeatures":[]}
{"preflight":"vercel-release","result":"fail","checks":14,"errors":[{"code":"DB_CA_SOURCE_AMBIGUOUS","variables":["DB_SSL_CA_FILE","DB_SSL_CA_PEM"]}]}
```

If the command cannot get as far as a verdict — the repository manifest is unreadable
or malformed, or an unexpected failure happens while evaluating — it prints this one
fixed line and exits nonzero. `checks` is `0` because nothing was evaluated, and no
message, path, or stack is printed on stdout or stderr. Treat it as a stop and a
broken checkout, not as an environment finding:

```
{"preflight":"vercel-release","result":"fail","checks":0,"errors":[{"code":"PREFLIGHT_STARTUP_FAILED","variables":[]}]}
```

It checks the Node major against `engines.node`, `NODE_ENV=production`,
`KAUDIT_TRUST_PROXY=true`, the required MySQL settings, that `DB_TLS_MODE` is one of
the two accepted words (`DB_TLS_MODE_INVALID`), and then the CA source *for the mode
being released*: in `required` mode **exactly one** source (and that an inline
`DB_SSL_CA_PEM` actually carries a certificate); in `disabled` mode no source at all,
reporting `DB_TLS_DISABLED_WITH_CA` with the mode and the offending variable if one is
set. A release with `DB_TLS_MODE=disabled` and no CA passes — that is the accepted
plaintext posture — while the same environment *without* the mode still fails with
`DB_CA_SOURCE_MISSING`. It also checks OIDC identity
and its approved signing algorithms, the absence of the local-password and import
variables that do not belong on a function, and that an explicitly enabled optional
feature has its own configuration — `KAUDIT_CALL_AUDIT_RULE_TEST_ENABLED=true`
requires `OPENAI_API_KEY` (presence only; the key is not read while the flag is
off), and `KAUDIT_UNPOD_PROXY_BASE` requires `KAUDIT_ALLOWED_RECORDING_HOSTS`.

**It is validation only.** It opens no connection, no pool, and no listener, reads
no CA file, calls no model, and changes nothing. A pass therefore proves that an
environment is shaped correctly and **nothing more**. It does not prove:

- a Vercel account, project, or link exists;
- a Git remote exists or is connected;
- migrations are applied (`0008_call_audit_foundation.sql` is not);
- the database, its TLS authority, or the identity provider is reachable or correct;
- preview routing sends the original path and query to the function.

Those stay operator checks: the section below for Git and Vercel, and the smoke
gates for everything that needs a running deployment.

## Connecting Git and Vercel — an operator step

**There is currently no Git remote configured in this repository**, and no Vercel
project is linked. Creating the remote, connecting it to a Vercel project, and setting
the environment variables are operator actions to be taken **after** this code is
accepted in review. They are not part of this change.

`.vercel/` is gitignored so a local link never lands in a commit.

## Preview → production smoke gates

Run `npm run vercel:preflight` against the target environment first — a failing
environment contract makes every gate below a waste of a deployment. Then run every
gate on a **preview** deployment, against a non-production database, before any
promotion is discussed.

1. **Build** — the Vercel build runs `npm run web:build` and completes; the function
   builds on Node 24.
2. **`/health/live`** — returns `200 {"status":"ok"}` with no-store headers.
3. **`/health/ready`** — returns `200 {"status":"ready"}`. A 503 here means MySQL, TLS,
   identity, or the audit sink is not reachable; fix that before anything else.
4. **Routing** — a deep link such as `/overview?period=2026-07` renders the application
   (not a 404 and not a raw static file). This confirms the original path and query
   reached the function.
5. **OIDC login/logout** — an unauthenticated `/billing` redirects to `/login`; sign-in
   through the Kairali identity application succeeds; `/logout` redirects to the
   configured logout URL.
6. **Normal user, Call Audit report** — a non-admin user opens the Call Audit report and
   sees aggregate results only. No transcript, prompt, model prose, lead ID, Task ID,
   phone, email, name, URL, invoice, or money appears anywhere in the page or the
   network responses.
7. **Admin settings** — an administrator reaches `/call-audit/settings`; a **non-admin**
   receives a permission error on both the page and `GET /api/v1/call-audit/settings`.
8. **Imports disabled** — as an administrator, `GET /api/v1/imports` returns
   `503 IMPORT_NOT_AVAILABLE`, and a `POST` to each import route returns a bounded 503
   that echoes no filename, no invoice metadata, and no uploaded content.
9. **No raw-content leakage** — spot-check function logs for the session: no transcript,
   prompt, provider prose, SQL, connection string, CA content, or secret. Startup
   failures must appear only as `vercel_runtime_bootstrap_failed` with no detail, and
   the browser must see only `503 RUNTIME_UNAVAILABLE`.
10. **Database connections** — with the preview under light concurrent load, watch
    `SHOW STATUS LIKE 'Threads_connected'` (or the provider's connection metric). Each
    warm instance holds at most 2 connections and releases idle ones after ~30s.
    A count that climbs and does not fall is a stop signal: investigate before
    promoting, because instance count is the multiplier.

Only after all ten pass is a production promotion a conversation worth having.

## What this runbook does not authorize

- No production approval. This is a candidate, not an approved deployment.
- Migration `0008_call_audit_foundation.sql` is **not** applied and is not applied by
  any deployment. See `docs/runbooks/CALL_AUDIT_BATCH.md`.
- No production data is touched by building, previewing, or reviewing this change.
