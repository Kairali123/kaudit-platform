-- ============================================================================
-- Migration 0010 — create kaudit_login_guard (persistent login throttling)
-- ============================================================================
-- EXPAND ONLY. This migration creates ONE new table. It does not alter,
-- backfill, rewrite, or delete any existing table, row, or index, it contains
-- no INSERT/UPDATE/DELETE of any kind, and it adds NO foreign key: the table is
-- deliberately standalone so a throttle write on a failed login never touches,
-- locks, or depends on `kaudit_user` or `kaudit_user_credential`. Migration
-- 0009 is unchanged and is not required for this table to be created.
--
-- Purpose:
--   Make brute-force resistance survive a restart, a second process, and a
--   serverless invocation. An in-memory counter protects nothing when the
--   attacker's next request lands on a different instance, so the counters live
--   in the database, keyed by a digest rather than by the thing they count.
--
-- What it holds, and what it must never hold:
--   * `guard_digest` — a keyed HMAC-SHA256 digest, hex. The application derives
--     it from a login-guard secret (itself derived from the session signing
--     secret through a distinct HMAC context) and NEVER stores, logs, or binds
--     the value it was derived from. Without the secret the column is not
--     reversible and not enumerable, so a copy of this table discloses neither
--     who tried to sign in nor from where.
--   * `guard_scope` — which independent guard the row is: `login` counts
--     failures against one normalized login identifier, `source` counts them
--     against one client network source. Two scopes, so a single attacker
--     cannot be hidden behind rotating usernames, and one shared corporate
--     egress cannot lock out an account by itself.
--   * fixed counters, windows, and timestamps. Nothing else.
--   * NEVER a raw username, email, login identifier, IP address, forwarded
--     header, session token, password, or password hash — not in a column, not
--     in a comment, and not as a bound parameter of any statement that reads or
--     writes this table.
--
-- Retention:
--   `expires_at` bounds how long a row may survive its usefulness, so a later
--   cleanup job can delete by one indexed predicate and this table can never
--   become a long-lived record of who signed in and from where. The cleanup
--   itself is NOT part of this migration:
--     DELETE FROM `kaudit_login_guard` WHERE `expires_at` <= ? LIMIT 1000;
--
-- Safety:
--   * schema only; run on a disposable database first;
--   * do not apply to production until Data CODEOWNERS approve it.
-- ============================================================================

CREATE TABLE `kaudit_login_guard` (
  `guard_scope` varchar(16)
    CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL
    COMMENT 'login = one normalized login identifier; source = one client network source. Fixed vocabulary, never a caller value',
  `guard_digest` char(64)
    CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL
    COMMENT 'Keyed HMAC-SHA256 digest, lowercase hex. NEVER the identifier, email, IP, or header it was derived from',
  `failure_count` int unsigned NOT NULL DEFAULT 0
    COMMENT 'Failures inside the current window. Bounded by ck_login_guard_failure_count so it cannot grow without limit',
  `window_started_at` datetime(6) NOT NULL
    COMMENT 'Start of the current rolling window. The counter resets when the window is older than the application window',
  `last_failure_at` datetime(6) NOT NULL,
  `blocked_until` datetime(6) DEFAULT NULL
    COMMENT 'Set when the counter crosses the threshold. A temporary block, never a permanent lockout',
  `expires_at` datetime(6) NOT NULL
    COMMENT 'Retention bound for a later cleanup job. A row past this instant carries no decision and may be deleted',
  `created_at` datetime(6) NOT NULL DEFAULT current_timestamp(6),
  `updated_at` datetime(6) DEFAULT NULL ON UPDATE current_timestamp(6),
  -- The composite key is what makes the failure path a single atomic upsert:
  -- concurrent failures for the same guard serialize on this row instead of
  -- read-modify-writing a counter and losing increments.
  PRIMARY KEY (`guard_scope`, `guard_digest`),
  -- Cleanup reads this and nothing else, so retention never scans the table.
  KEY `idx_login_guard_expiry` (`expires_at`),
  CONSTRAINT `ck_login_guard_scope`
    CHECK (`guard_scope` IN ('login', 'source')),
  -- Exactly a hex SHA-256, so a raw identifier, an email, or an IP address is
  -- structurally incapable of being stored in this column: every one of them
  -- either contains a character outside [0-9a-f] or is not 64 characters long.
  -- The column is utf8mb4_bin, so the match is case sensitive rather than
  -- vacuous, and an uppercase digest is rejected instead of creating a second
  -- row for the same guard.
  CONSTRAINT `ck_login_guard_digest`
    CHECK (
      CHAR_LENGTH(`guard_digest`) = 64
      AND `guard_digest` REGEXP '^[0-9a-f]{64}$'
    ),
  -- A counter is a counter: the application clamps it, and the database
  -- refuses anything that would make it a payload.
  CONSTRAINT `ck_login_guard_failure_count`
    CHECK (`failure_count` BETWEEN 0 AND 1000000),
  -- A row must always be deletable in bounded time.
  CONSTRAINT `ck_login_guard_expires_at`
    CHECK (`expires_at` > `window_started_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
  COMMENT='Persistent brute-force guard for database login. Keyed digests and counters only; never an identifier, address, or credential';

-- ---------------------------------------------------------------------------
-- VERIFY (read-only):
--   SHOW CREATE TABLE kaudit_login_guard;
--
--   -- expect 1
--   SELECT COUNT(*) FROM information_schema.TABLES
--   WHERE TABLE_SCHEMA = DATABASE()
--     AND TABLE_NAME = 'kaudit_login_guard';
--
--   -- expect 0 rows: this table references nothing, inside or outside kaudit_*
--   SELECT REFERENCED_TABLE_NAME
--   FROM information_schema.REFERENTIAL_CONSTRAINTS
--   WHERE CONSTRAINT_SCHEMA = DATABASE()
--     AND TABLE_NAME = 'kaudit_login_guard';
--
-- DOWN (rollback):
--   DROP TABLE IF EXISTS `kaudit_login_guard`;
--   Safe at any time: the table holds no evidence and no identity. Dropping it
--   only removes throttling, so recreate it before login is served again.
--
-- Forward-fix policy:
--   Never add a column that holds the pre-image of `guard_digest` — no
--   username, email, login, IP address, forwarded header, user agent, or
--   "for debugging" copy of any of them. Never add a foreign key from here to
--   `kaudit_user` or to any table outside the `kaudit_*` schema: this table is
--   written on unauthenticated requests, and a reference would let one lock the
--   other. Never remove `expires_at` or its index.
-- ============================================================================
