# W1 — Identity & Access (single-company, simplified)

> Superseded operational note (2026-07-27): the application remains
> role-protected and aggregate-only, but sensitivity tiers no longer control
> audit, billing, or report activation. The existing database column and the
> design below are retained as migration history, not as an active pipeline
> barrier.

**Confirmed scope:** this platform is for **Kairali only** — not a multi-tenant product.
The tenant concept is dropped entirely. No `kaudit_tenant`, no `kaudit_membership`, and
**no `tenant_id` on any table** (the ~60-table `tenant_id` backfill phase, old 0004/0005,
is removed). W1 is now just: a user directory + an access model, within one company.

This is the design + migration plan for **review before anything runs**.

## What W1 delivers

1. **`kaudit_user`** — the people who use the system (auditors, admins, finance, clinical
   reviewers, …), keyed by `email` (same `resolveIdentity` logic already built). Service
   actors (`w3-backfill`, …) are `kind='system'`.
2. **Access model — two roles + one content gate, all deny-by-default:**
   - **Two roles** (`kaudit_user_role`, code in `src/identity/access.ts`):
     - **`admin`** → everything: user management, config/connections, financial approvals,
       and granting/changing a user's health-content ceiling.
     - **`user`** → day-to-day operational (`call:read/review`, `finding:confirm`,
       `invoice:reconcile`, `cluster:confirm`, `action:route`, `metrics:read`,
       `snapshot:read`) — **not** admin actions.
     - **`unassigned`** (seed default) / unknown → nothing.
     - *(Judgment call to confirm: money-approval + `reconciliation:close` are admin-only,
       keeping a do-vs-approve split. Move to `user` if operational staff should close.)*
   - **Health-content access** — **`kaudit_user.max_sensitivity_tier`** decides who may open
     **K2/K3 call content** (audio/transcript). Default **`K1`** (deny health); **K4 never
     viewable by anyone**. Independent of roles — a `user` with operational permissions still
     cannot open health audio. **Only an admin may change a ceiling** (`sensitivity:grant`),
     and the change is written to the audit log.

## Pure core (built & synthetic-tested — `npm run test:w1`)

- `resolveIdentity` / `buildUserSet` — unchanged; resolve + dedupe the scattered
  authorship/actor strings into a clean user + system-actor set (for seeding the directory).
- `access.ts` — `can(roles, permission)` and `canViewCallContent(maxTier, callTier)`, the
  two enforcement primitives, fully deny-by-default. Tests assert: role permissions union,
  unknown role/permission denied, K1 default cannot open K2/K3, K4 never viewable, unknown
  tiers deny, and that a functional role does **not** by itself grant health access.

## Migration & backfill plan

**Step A — `0003` (revised, on this branch): create `kaudit_user` + `kaudit_user_role`.**
Additive; `kaudit_user.max_sensitivity_tier` defaults to `K1`. No existing table touched,
**no `tenant_id` anywhere.**

**Step B — seed identity (dry-run → EXECUTE).** `w1:identity` collects every identity
string, `buildUserSet` resolves them, then EXECUTE upserts the users and assigns each a
**safe default role** (`unassigned` — non-authorizing). It deliberately does **not** set
anyone's `max_sensitivity_tier` above the default — elevating a user to K2/K3 is a
separate, audited clinical/privacy action, never a bulk backfill. Dry-run first prints the
full user/actor/invalid breakdown.

That's the whole plan. There is no Step C/D/E — the `tenant_id` column + backfill +
contract phases are gone. This is dramatically smaller and lower-risk than the multi-tenant
version (no 127k-row backfill, no unique-key surgery).

## Locked model (confirmed)

1. **Two roles only: `admin` and `user`** (+ `unassigned` = nothing). Admin = everything;
   user = day-to-day operational, excluding admin actions.
2. **Health access via `max_sensitivity_tier` on the user**, changeable **only by an admin**
   (`sensitivity:grant`) as an audited action — not tied to a separate clinical-reviewer role.
3. **Default seed role = `unassigned`** (non-authorizing).

## Scope boundaries (unchanged)

- Historical `created_by`/`approved_by`/`*_email` strings stay as-is; converting them to
  `user_id` FKs is a later phase. W1 seeds the directory + defines the access primitives.
- OIDC/SSO login, the API permission guard, and wiring `canViewCallContent` into the
  content/playback endpoints are Phase-1 application work — W1 provides the model they use.

## Status

Design + `0003` migration + pure access core are on the `w1-tenancy-backfill` branch,
synthetic-tested. **Nothing has been run against the database.** Confirm the three
proposals above and I'll treat the W1 model as locked; then the only execution is apply
`0003` → dry-run `w1:identity` → EXECUTE seed.
