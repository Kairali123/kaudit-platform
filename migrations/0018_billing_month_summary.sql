-- ============================================================================
-- Migration 0018 — kaudit_billing_month_summary (a CACHE of one month's
--                  billing aggregates; never a source of any fact)
-- ============================================================================
-- EXPAND ONLY. This migration creates ONE new table. It does not alter,
-- backfill, rewrite, or delete any existing table, row, index, or constraint,
-- and it contains no INSERT/UPDATE/DELETE of any kind.
--
-- Purpose:
--   A closed bill month never changes, and the billing page was recomputing it
--   on every load: five aggregates, each walking every call in the month. At
--   June's 39,094 calls that ran 15-30s against a 30s request limit and the
--   page timed out. The cost grew with the size of the month rather than with
--   anything the reader asked for.
--
-- What this table IS:
--   A recomputable projection. Every column is derivable from the billing
--   calculations, automated decisions, and calls that already exist. Deleting
--   every row here loses NOTHING: the next read recomputes it.
--
-- What this table IS NOT:
--   Evidence. It is never an input to a calculation, a settlement, a
--   reconciliation, or any money write. Nothing reads it to decide an amount;
--   it exists only so a page can show an amount that was already decided.
--   That is why it is the one table here that may be updated in place -- there
--   is no history to preserve, because there is no fact to preserve.
--
-- Staleness:
--   Rows are written after a live computation and DELETED by every writer that
--   can change a month's billing facts. A month that is still receiving calls
--   is never served from here at all; only a month whose period has ended.
--   A missing row is always safe -- it means "compute it" -- so the failure
--   mode of every bug in this cache is slowness, never a wrong number.
--
-- Rollback:
--   DROP TABLE `kaudit_billing_month_summary`;
--   Nothing else references it and no other table points at it.
-- ============================================================================

CREATE TABLE `kaudit_billing_month_summary` (
  `bill_month` char(7) NOT NULL
    COMMENT 'Monthly period identity as YYYY-MM; one cached summary per month',
  `period_start` date NOT NULL
    COMMENT 'Inclusive first day of bill_month, stored so a row states the period it summarises',
  `period_end` date NOT NULL
    COMMENT 'Inclusive last day of bill_month',
  `payload_json` longtext NOT NULL
    COMMENT 'The computed aggregates as JSON. Amounts are decimal TEXT exactly as read, never numbers, so no value passes through a float',
  `payload_sha256` char(64) NOT NULL
    COMMENT 'SHA-256 over payload_json, so a cached summary can be compared with a freshly computed one without parsing either',
  `source_engine_version` varchar(80) NOT NULL
    COMMENT 'Build that computed this row. A summary computed by an older definition of the aggregates can be found and discarded',
  `computed_at` datetime(6) NOT NULL
    COMMENT 'Application-supplied UTC-naive instant the aggregates were computed',
  `created_at` datetime(6) NOT NULL DEFAULT current_timestamp(6)
    COMMENT 'Database insert instant',
  `updated_at` datetime(6) NOT NULL DEFAULT current_timestamp(6)
    ON UPDATE current_timestamp(6)
    COMMENT 'Database update instant. Updating in place is correct here and only here: a cache has no history worth keeping',
  PRIMARY KEY (`bill_month`),
  CONSTRAINT `chk_billing_month_summary_period_order`
    CHECK (`period_start` <= `period_end`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
  COMMENT='CACHE of per-month billing aggregates. Recomputable, never evidence, safe to truncate';

-- VERIFY (read-only):
--   SHOW CREATE TABLE kaudit_billing_month_summary;
--
--   -- expect 1
--   SELECT COUNT(*) FROM information_schema.TABLES
--   WHERE TABLE_SCHEMA = DATABASE()
--     AND TABLE_NAME = 'kaudit_billing_month_summary';
--
--   -- expect 0 rows: nothing in the schema may reference a cache
--   SELECT TABLE_NAME FROM information_schema.REFERENTIAL_CONSTRAINTS
--   WHERE CONSTRAINT_SCHEMA = DATABASE()
--     AND REFERENCED_TABLE_NAME = 'kaudit_billing_month_summary';
