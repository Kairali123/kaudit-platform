# Enterprise app

The current UI is a routed React application backed by authenticated, page-scoped,
aggregate-only APIs. It is intentionally private and renders no call-level rows, phone
numbers, evidence URLs, audio, transcripts, customer identifiers, or health content.

## Pages

| Route | Purpose | Live source |
|---|---|---|
| `/login` | Public sign-in entry point; Kairali SSO or explicit local preview | public auth configuration only |
| `/` | Home/Profile: identity, role, permissions, sensitivity ceiling | `kaudit_user`, `kaudit_user_role` |
| `/overview` | Headline coverage and release gates only | call/evidence aggregates and configured gates |
| `/evidence` | Ingestion, references, hash baselines, integrity events | call/evidence/audit aggregates |
| `/findings` | Finding totals, confidence, catalog, origins, decisions | audit-run/finding aggregates |
| `/billing` | Calculation, claim, variance, rate card, reconciliation | billing/rate-card/reconciliation aggregates |
| `/reports` | D-12 weekly/monthly/quarterly/yearly summaries | live period aggregates |
| `/operations` | Outbox, inbox, jobs, idempotency, access-audit health | reliability/security aggregates |

Each endpoint returns only the data used by its page. `/overview` does not return
findings, billing, or snapshot payloads.

## Login behavior

- The app does not implement password authentication and never collects a password.
- `/login` and `/api/v1/auth/config` are public; they expose no business data.
- In OIDC mode, the button uses the validated HTTPS `KAUDIT_OIDC_LOGIN_URL` owned by
  Kairali's identity provider or approved identity-aware proxy.
- The top-bar logout button calls `/logout`. OIDC mode delegates session termination
  to the validated HTTPS `KAUDIT_OIDC_LOGOUT_URL`; local/preview mode returns to
  `/login`.
- In local mode, the button continues with the configured, already-provisioned user.
- In preview mode, the page is visibly labeled unauthenticated and offers only the
  loopback preview entry.
- Unauthenticated browser navigation to protected app routes redirects to `/login`.
  Protected API requests continue to return `401` JSON rather than an HTML redirect.
- Static frontend assets are public because they contain code only; all aggregate
  business APIs remain server-authorized.

## Run the local preview with real aggregate data

The preview requires only the existing database variables in the gitignored `.env`:

```bash
npm run app:dev
```

Open `http://127.0.0.1:4173`. Vite serves the UI and proxies `/api` to the secure
server at `127.0.0.1:4175`. This command explicitly uses `preview` mode:

- it is accepted only on a loopback host outside production;
- it uses a synthetic K0 identity with the standard read permissions;
- it reads real aggregate business data;
- it does not write access-audit events;
- the UI visibly labels access control as unenforced.

To preview the built bundle instead of Vite:

```bash
npm run app:preview
```

Open `http://127.0.0.1:4176`. The built preview uses a separate port so it can
run alongside `app:dev`, whose API uses `4175`.

## Run the authenticated application

Prerequisites:

1. review and apply migrations `0003` and `0004` in the approved staged process;
2. provision an active `kaudit_user` with an `admin` or `user` role;
3. configure local auth or the approved OIDC integration in `.env`;
4. keep release gates false unless their named approval and evidence exist.

Secure development:

```bash
npm run app:dev:secure
```

Production-shaped authenticated build:

```bash
npm run app:start
```

For OIDC browser login, configure:

```text
KAUDIT_OIDC_LOGIN_URL=https://<approved-kairali-identity-entry>
KAUDIT_OIDC_LOGOUT_URL=https://<approved-kairali-session-endpoint>
```

The identity provider/proxy must return a validated bearer token or secure HttpOnly
cookie according to the existing OIDC server configuration. D-14 remains open until
that provider, client, MFA policy, callback/proxy behavior, and logout path are approved.

Open `http://127.0.0.1:4175`. Static assets are served from the authenticated
server with a same-origin CSP.

Business data queries are read-only and aggregate-only. Successful and denied app/API
access is written to the hash-chained audit log in authenticated modes.

## Authority labels

- Billing becomes `authoritative` only when the newest rate card is `published` with
  `approved_by`/`approved_at`, every current calculation is final with an approved
  calculation basis, input/ruleset/decision-trace hashes are present, and no current
  automated billing decision is unresolved.
- Findings remain `uncalibrated` unless `KAUDIT_CALIBRATION_COMPLETE=true` is set
  after the approved calibration protocol is complete.
- Legacy K2/K3 metadata does not control automation authority. Calibration and
  evidence/rate-card gates apply uniformly to every call.
- Reports remain `provisional` until billing calculations are authoritative and
  `KAUDIT_REPORTING_APPROVED=true`.

These flags change labels and release posture. They do not retroactively validate,
recalculate, or finalize existing data.

## Production boundary

This app is production-shaped, not production-approved. D-03 publication/recalculation,
calibration, privacy/retention, OIDC, infrastructure, and shadow-run
acceptance remain release blockers. Do not expose the Vite server or use local
authentication outside loopback development.
