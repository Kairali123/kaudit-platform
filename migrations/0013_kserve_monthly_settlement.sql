-- ============================================================================
-- Migration 0013 — kaudit_kserve_monthly_settlement (append-only record of the
--                  amount Kairali ACTUALLY PAID KServe for a bill month)
-- ============================================================================
-- EXPAND ONLY. This migration creates ONE new table and adds ONE self-
-- referencing foreign key from that table to itself. It does not alter,
-- backfill, rewrite, or delete any existing table, row, index, or constraint,
-- and it contains no INSERT/UPDATE/DELETE of any kind.
--
-- Purpose:
--   Exactly one business fact per bill month that no calculation can produce:
--   the rupee amount an administrator confirms was PAID to KServe after
--   negotiation. Everything else about that month — vendor-asserted billed
--   minutes, the locked KServe rate, the deterministic auditor calculation —
--   is already derived from evidence. What was finally handed over is not.
--
--   "Savings" for the month is then deterministic subtraction and nothing
--   else: the final vendor/KServe billed charge for the WHOLE month MINUS the
--   current amount recorded here. It is never derived from AI duration, model
--   output, projected auditor money, or a browser calculation, and a negative
--   result (paid MORE than billed) is preserved rather than clamped.
--
-- APPEND-ONLY, and structurally so:
--   A correction is a NEW ROW that supersedes the previous one. There is no
--   UPDATE path and no DELETE path for these rows, and — unlike a lifecycle
--   flag such as `is_current` — nothing in this schema ever has to be written
--   back onto an older version. Every row is final the instant it commits.
--
--   The current version is therefore derived, not stored: it is the row with
--   the HIGHEST `version_no` for the month. Three constraints make that
--   derivation total and race-free without touching prior history:
--
--     * uq_kserve_settlement_month_version — at most one row per
--       (bill_month, version_no). Two administrators correcting the same month
--       concurrently both compute the same next version; one INSERT commits and
--       the other loses on this key. Neither can overwrite the other.
--     * uq_kserve_settlement_supersedes — a version may be superseded AT MOST
--       ONCE, so the chain for a month is strictly linear and can never fork
--       into two competing "current" tails. Multiple NULLs are permitted by
--       MySQL's unique-index semantics, which is exactly what the roots need.
--     * chk_kserve_settlement_chain — version 1 is the root and supersedes
--       nothing; every later version must name the row it supersedes. Combined
--       with the unique key above, a month has exactly one root.
--
-- Idempotency:
--   `idempotency_key` is unique WITHIN a bill month, and `request_digest`
--   covers the submitted payload. A retried save — a double-clicked button, a
--   retried fetch, a re-delivered request — carries the same key, matches the
--   stored digest, and REPLAYS the existing version. The same key carrying a
--   DIFFERENT amount is a conflict, never a silent second version: duplicate
--   financial history is not something a retry may create.
--
-- Fixed-precision money, one currency:
--   `final_paid_amount` is DECIMAL(20,8) — the platform's money type — and is
--   never a float anywhere in its path. `currency` is pinned to INR by a check
--   constraint because the locked KServe ruleset is INR-only; a second currency
--   is a ruleset decision, not a column value.
--
-- What it holds, and what it must never hold:
--   * `bill_month` plus its inclusive `period_start`/`period_end` — the monthly
--     period identity, stated once so a reader never has to re-derive it.
--   * `final_paid_amount`, `currency` — the single business value.
--   * `version_no`, `supersedes_settlement_id` — the supersession chain.
--   * `idempotency_key`, `request_digest` — retry safety.
--   * `recorded_by_user_id`, `correlation_id`, `recorded_at`, `created_at` —
--     provenance. `recorded_by_user_id` is a kaudit_user.id and NEVER a name,
--     email, or display string; no API response returns it.
--   * NEVER a call id, lead id, task id, phone, email, recording URL,
--     transcript, transcript excerpt, prompt, provider response, provider
--     prose, evidence hash, or model/token figure. This row is an
--     administrator's payment fact, not audit evidence.
--
-- Source-table safety:
--   `ai_voice_leads_received` is an EXTERNAL, READ-ONLY table owned by another
--   system. This migration never creates, alters, writes, locks, or foreign-
--   keys to it, and neither does any statement that reads or writes this table.
--
-- Call Audit boundary:
--   This table belongs to Billing Audit alone. Call Audit never reads it, never
--   joins to it, and never reports a figure derived from it. Money is Billing
--   Audit's concern and never Call Audit's.
-- ---------------------------------------------------------------------------

CREATE TABLE `kaudit_kserve_monthly_settlement` (
  `id` varchar(40) NOT NULL
    COMMENT 'Deterministic kms_ id derived from (bill_month, idempotency_key); never a call, lead, or task identifier',
  `bill_month` char(7) NOT NULL
    COMMENT 'Monthly period identity as YYYY-MM; one settlement chain per month',
  `period_start` date NOT NULL
    COMMENT 'Inclusive first day of bill_month, stored so the covered period is explicit',
  `period_end` date NOT NULL
    COMMENT 'Inclusive last day of bill_month; the settlement covers the COMPLETE month',
  `currency` char(3) NOT NULL DEFAULT 'INR'
    COMMENT 'Pinned to INR by chk_kserve_settlement_currency; the locked KServe ruleset is INR-only',
  `final_paid_amount` decimal(20,8) NOT NULL
    COMMENT 'Amount actually paid to KServe after negotiation, fixed precision, never negative and never a float',
  `version_no` int unsigned NOT NULL
    COMMENT 'Version within the month, starting at 1. The HIGHEST version is the current one; prior versions stay readable forever',
  `supersedes_settlement_id` varchar(40) DEFAULT NULL
    COMMENT 'The version this row replaces. NULL only on version 1. Set once, at insert, and never written back onto the superseded row',
  `idempotency_key` varchar(80) NOT NULL
    COMMENT 'Caller-supplied retry key, unique within the month',
  `request_digest` char(64) NOT NULL
    COMMENT 'SHA-256 over the submitted payload, so a retry can be proven identical before it is replayed',
  `recorded_by_user_id` varchar(40) DEFAULT NULL
    COMMENT 'kaudit_user.id of the administrator; no FK, this financial history outlives user accounts. Never returned by any API',
  `correlation_id` varchar(120) DEFAULT NULL
    COMMENT 'Request correlation id for the access log; never returned by any API',
  `recorded_at` datetime(6) NOT NULL
    COMMENT 'Application-supplied UTC-naive instant the administrator recorded the payment',
  `created_at` datetime(6) NOT NULL DEFAULT current_timestamp(6)
    COMMENT 'Database insert instant. There is deliberately no updated_at: nothing here is ever updated',
  PRIMARY KEY (`id`),
  -- At most one row per (month, version). THE guarantee against two concurrent
  -- corrections both becoming version N+1. Never widen it.
  --
  -- It is also the ONLY index the two reads need: "the current version" is
  -- ORDER BY version_no DESC LIMIT 1 within a month, which InnoDB answers by
  -- scanning this key backwards from the month's last entry, and "the newest N
  -- versions" is the same scan continued. A separate descending index would be
  -- redundant, so there deliberately is not one.
  UNIQUE KEY `uq_kserve_settlement_month_version` (`bill_month`, `version_no`),
  -- A retry lands on the existing row instead of minting a second one.
  UNIQUE KEY `uq_kserve_settlement_month_key` (`bill_month`, `idempotency_key`),
  -- A version may be superseded at most once, so the chain cannot fork.
  UNIQUE KEY `uq_kserve_settlement_supersedes` (`supersedes_settlement_id`),
  CONSTRAINT `chk_kserve_settlement_currency`
    CHECK (`currency` = 'INR'),
  -- A paid amount is never negative. A refund or credit note is a different
  -- business fact and would need its own approved design, not a negative here.
  CONSTRAINT `chk_kserve_settlement_amount_non_negative`
    CHECK (`final_paid_amount` >= 0),
  CONSTRAINT `chk_kserve_settlement_version_positive`
    CHECK (`version_no` >= 1),
  -- Version 1 is the root; every later version names its predecessor.
  CONSTRAINT `chk_kserve_settlement_chain`
    CHECK (
      (`version_no` = 1 AND `supersedes_settlement_id` IS NULL)
      OR
      (`version_no` > 1 AND `supersedes_settlement_id` IS NOT NULL)
    ),
  CONSTRAINT `chk_kserve_settlement_period_order`
    CHECK (`period_start` <= `period_end`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
  COMMENT='APPEND-ONLY monthly record of the amount actually paid to KServe. A row is never updated or deleted; a correction is a new superseding version';

-- ---------------------------------------------------------------------------
-- Foreign key — to this table only.
-- ---------------------------------------------------------------------------
-- The supersession chain is enforced in the schema so a version cannot claim to
-- replace a settlement that does not exist. RESTRICT is implicit and deliberate:
-- there is no delete path for financial history, so nothing may cascade.
ALTER TABLE `kaudit_kserve_monthly_settlement`
  ADD CONSTRAINT `fk_kserve_settlement_supersedes`
    FOREIGN KEY (`supersedes_settlement_id`)
    REFERENCES `kaudit_kserve_monthly_settlement` (`id`);

-- VERIFY (read-only):
--   SHOW CREATE TABLE kaudit_kserve_monthly_settlement;
--
--   -- expect 1
--   SELECT COUNT(*) FROM information_schema.TABLES
--   WHERE TABLE_SCHEMA = DATABASE()
--     AND TABLE_NAME = 'kaudit_kserve_monthly_settlement';
--
--   -- expect exactly: kaudit_kserve_monthly_settlement (itself, and nothing else)
--   SELECT DISTINCT REFERENCED_TABLE_NAME
--   FROM information_schema.REFERENTIAL_CONSTRAINTS
--   WHERE CONSTRAINT_SCHEMA = DATABASE()
--     AND TABLE_NAME = 'kaudit_kserve_monthly_settlement';
--
--   -- expect 0 rows: every month has exactly one current version
--   SELECT bill_month, COUNT(*)
--   FROM kaudit_kserve_monthly_settlement s
--   WHERE NOT EXISTS (
--     SELECT 1 FROM kaudit_kserve_monthly_settlement newer
--     WHERE newer.supersedes_settlement_id = s.id
--   )
--   GROUP BY bill_month
--   HAVING COUNT(*) <> 1;
--
-- DOWN (rollback):
--   DROP TABLE IF EXISTS `kaudit_kserve_monthly_settlement`;
--   Safe for the schema — nothing outside this table references it — but it
--   DESTROYS financial history that exists nowhere else. Export the rows first.
--
-- Forward-fix policy:
--   Never add an UPDATE or DELETE path for these rows. Never add an `is_current`
--   flag, a `void` flag, an amendment-in-place column, or a TTL: each would let
--   a prior version be rewritten, which is the one thing this table exists to
--   prevent. Never add a foreign key to `ai_voice_leads_received` or to any
--   Call Audit table. Never store a duration, transcript, evidence hash, or
--   model figure here, and never let a settlement amount be written by anything
--   other than an authenticated administrator action.
-- ============================================================================
