# W1 — Tenancy & Identity (design + migration plan)

Addresses **D1**: no `tenant`/`user`/`membership` tables, no `tenant_id` on any table,
identity stored as bare email strings. This document is the design + plan for review
**before** any real-data change. Pure core is built and synthetic-tested; execution
against production waits for your approval.

## Target model

- **`kaudit_tenant`** — one row today (Kairali), multi-tenant-ready.
- **`kaudit_user`** — the identity directory. Real users keyed by `email`; automation/
  service actors (`w3-backfill`, `w3-url-verify`, …) stored as `kind='system'` with
  `(oidc_issuer='system', oidc_subject=<name>)`. `oidc_issuer/subject` fill in on first
  real OIDC login (matched by email).
- **`kaudit_membership`** — `(tenant_id, user_id, role_code)` unique; FKs to tenant + user.
- **`tenant_id`** on every tenant-scoped business table, tenant-aware unique keys.

## Identity resolution (pure core — built & tested)

- `resolveIdentity(raw)` → `user | system | empty | invalid`, normalizes emails to
  lowercase, treats no-`@` strings as system actors, flags malformed `@`-strings as
  `invalid` (surfaced for review, never minted as a user).
- `buildUserSet(refs)` → deduped users + system actors, per-source and per-kind counts,
  and up to 20 `invalidSamples`. No DB; fully synthetic-tested (`npm run test:w1`).
- Identity strings are collected from ~24 authorship/actor columns
  (`mysqlIdentitySource`); external-party columns are excluded.

## Migration & backfill plan (phased, expand → backfill → contract)

**Step A — `0003` (this branch): create `tenant` / `user` / `membership`.** Additive; no
impact on existing rows.

**Step B — seed identity (dry-run → EXECUTE).** `w1:identity` collects every identity
string, `buildUserSet` resolves them, then EXECUTE upserts the single tenant + users +
memberships (idempotent). Dry-run first prints the full user/actor/invalid breakdown for
your review — expect a *small* set (the data is sparsely authored). No existing table
is touched.

**Step C — `0004`: add nullable `tenant_id` to every business table (expand).** One
`ADD COLUMN tenant_id varchar(40) NULL` per table + index, `ALGORITHM=INSTANT`. ~60
tables; mechanical. *Not written yet — pending approval of this plan.*

**Step D — backfill `tenant_id` (data, batched).** Single tenant → `UPDATE … SET
tenant_id = <kairali>` on every table, batched for the large ones (`call` 43k,
`provider_cost` 127k, `billing_calculation`/`call_leg`/`call_artifact` 43k each).
Resumable (`WHERE tenant_id IS NULL`).

**Step E — `0005`: contract.** `tenant_id NOT NULL`, and make unique keys tenant-aware
(e.g. `call` `uq(vendor_account_id, logical_call_key)` → `uq(tenant_id, vendor_account_id,
logical_call_key)`; same for `source_envelope`, `call_external_reference`,
`call_leg`, `evidence_object` dedup, `invoice`, `rate_card_version`, `mapping_profile`,
`membership`, …). Done in a low-traffic window; with one tenant there are no cross-tenant
key collisions to worry about.

### Ordering & FK notes

- 0003 (tables) → seed identity → 0004 (columns) → backfill → 0005 (contract).
- `tenant_id` is an indexed column; a hard FK to `kaudit_tenant` on ~60 tables is heavy
  and the architecture warns against casual FKs — **recommend indexed column +
  app-enforced tenant scoping**, not 60 FKs (revisit per-table if desired).
- A few tables are arguably **tenant-global** (e.g. `provider_incident`, and the vendor/
  contract reference tables). Flagged for a decision: give them `tenant_id` too for
  uniformity, or treat as shared. Default recommendation: give them `tenant_id` for a
  uniform "every business row is tenant-scoped" invariant.

## Scope boundaries (important)

- **Authorship columns stay as email strings for now.** Converting historical
  `created_by`/`approved_by`/`*_email` to `user_id` FKs is a *later* phase; this W1 seeds
  the directory and adds tenant scoping. New writes should use `user_id` going forward;
  the `mapping` from `buildUserSet` is what a later pass would use to convert history.
- **OIDC/SSO login, RBAC enforcement, and the API tenant-context guard** are Phase-1
  application work, not this migration. W1 lays the data foundation they require.

## Risks

- Large-table `tenant_id` backfill (127k+ rows) — mitigate with batched, online updates.
- Unique-key changes in Step E — drop-and-add during low traffic; trivial with one tenant.
- `invalid` identity strings — do not silently mint users; review the `invalidSamples`.

## What needs your approval before EXECUTE

1. This model + phased plan.
2. The **default membership role** to assign seeded users (currently `unassigned` — real
   roles are a business decision; seeding as `unassigned` is safe and non-authorizing).
3. Whether tenant-global tables get `tenant_id` (recommended: yes).
4. Then I generate `0004`/`0005` (the column + contract migrations) for review, same as
   0001–0003.

Nothing here has been run against the database.
