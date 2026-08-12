-- ============================================================================
-- Migration 0009 — create kaudit_user_credential (database-backed login)
-- ============================================================================
-- EXPAND ONLY. This migration creates ONE new table and adds ONE foreign key to
-- it. It does not alter, backfill, rewrite, or delete any existing table, row,
-- or index, and it contains no INSERT/UPDATE/DELETE of any kind. Migration 0003
-- (`kaudit_user`, `kaudit_user_role`) is unchanged and must already be applied.
--
-- Purpose:
--   Give a real Kaudit user (kind='user') ONE set of login credentials so a
--   future multi-user sign-in can authenticate against the database instead of
--   a single environment-configured operator. This migration is schema only —
--   no HTTP route, no user-management command, and no seeded account.
--
-- What it holds, and what it must never hold:
--   * `username_normalized` — the case-normalized login handle. Stored already
--     lowercased, in utf8mb4_bin so uniqueness is exact and a CHECK can prove
--     the normalization. A CHECK also pins the full application pattern —
--     lowercase ASCII a-z/0-9 with dot, underscore and hyphen inside, an
--     alphanumeric at each end, 3 to 64 characters — so the database admits
--     exactly the handles `normalizeUsername` can produce. It may never contain
--     '@', so a username can never collide with a `kaudit_user.email`, and a
--     single login box can resolve either without ambiguity.
--   * `password_hash` — a ONE-WAY salted scrypt hash in a self-describing
--     encoding that carries its own algorithm and parameters. A plaintext or
--     reversibly-encrypted password must NEVER be written to this column, this
--     table, or any other table.
--   * `session_version` — the session generation counter. Every issued session
--     carries the value it was minted under; each request compares it against
--     this row. Incrementing it invalidates every outstanding session for that
--     user in one write, with no session store to sweep.
--   * NOTHING else about the person: no email, no display name, no roles, no
--     tier. Those stay on `kaudit_user` / `kaudit_user_role`, which remain the
--     single source of identity and authorization.
--
-- Deletion policy — DISABLE / TOMBSTONE, NEVER PHYSICAL DELETE:
--   Audit rows across this schema record `created_by`, `activated_by`,
--   `granted_by`, and similar actor ids. Physically deleting a user would strand
--   that history, so a "delete" is modelled here as a state change:
--     * disable  → `status` = 'disabled',  `disabled_at` set, `session_version`
--                  incremented. The account is recoverable.
--     * tombstone→ `status` = 'tombstoned', `disabled_at` set, `session_version`
--                  incremented, and `password_hash` OVERWRITTEN with a random,
--                  deliberately unparseable sentinel (e.g. 'revoked$' + random)
--                  so no stored hash survives a permanent close-out.
--   A tombstoned `username_normalized` is RETIRED, never reissued: the unique
--   key keeps it occupied so historical actor ids can never be re-pointed at a
--   different person. The foreign key below is deliberately declared WITHOUT
--   ON DELETE CASCADE, so the database itself refuses to let a `kaudit_user`
--   row with credentials be physically removed.
--
-- Safety:
--   * schema only; run on a disposable database first;
--   * do not apply to production until Data CODEOWNERS approve it.
-- ============================================================================

CREATE TABLE `kaudit_user_credential` (
  `user_id` varchar(40) NOT NULL
    COMMENT 'Owning kaudit_user.id. PRIMARY KEY, so exactly one credential row per user',
  `username_normalized` varchar(64)
    CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL
    COMMENT 'Lowercased ASCII login handle: a-z 0-9 . _ -, alphanumeric at both ends, 3-64 chars, never contains @ or a space',
  `password_hash` varchar(255)
    CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL
    COMMENT 'One-way salted scrypt hash, self-describing: scrypt$N=..,r=..,p=..$salt$digest (base64url). NEVER a plaintext or reversible password',
  `session_version` int unsigned NOT NULL DEFAULT 1
    COMMENT 'Session generation. Incremented on password change, disable, or tombstone to revoke every outstanding session at once',
  `status` varchar(20) NOT NULL DEFAULT 'active'
    COMMENT 'active, disabled, or tombstoned. A user is NEVER physically deleted',
  `password_changed_at` datetime(6) NOT NULL DEFAULT current_timestamp(6),
  `disabled_at` datetime(6) DEFAULT NULL
    COMMENT 'Set when status leaves active; cleared only by a re-enable back to active',
  `created_at` datetime(6) NOT NULL DEFAULT current_timestamp(6),
  `updated_at` datetime(6) DEFAULT NULL ON UPDATE current_timestamp(6),
  PRIMARY KEY (`user_id`),
  UNIQUE KEY `uq_user_credential_username` (`username_normalized`),
  -- The stored handle must already BE the normalized form; utf8mb4_bin makes
  -- this comparison case sensitive, so a mixed-case insert is rejected rather
  -- than silently creating a second login for the same person.
  CONSTRAINT `ck_user_credential_username_normalized`
    CHECK (`username_normalized` = LOWER(`username_normalized`)),
  -- The exact pattern the application normalizes to (`normalizeUsername` in
  -- src/auth/credentialIdentity.ts): lowercase ASCII a-z and 0-9 plus dot,
  -- underscore and hyphen, alphanumeric at BOTH ends, 3 to 64 characters. The
  -- '@' and space exclusions are kept explicit because the login box relies on
  -- them to tell a username from an email; the pattern subsumes both. Without
  -- the pattern this CHECK would admit handles the application can never
  -- produce or look up — '.admin', 'admin-', 'ädmin', 'ad$min' — leaving rows
  -- that are unreachable by login but still occupy the unique key.
  -- REGEXP is deterministic and permitted in a MariaDB 10.11 CHECK; the column
  -- is utf8mb4_bin, so the match is case sensitive rather than vacuous.
  CONSTRAINT `ck_user_credential_username_shape`
    CHECK (
      CHAR_LENGTH(`username_normalized`) BETWEEN 3 AND 64
      AND `username_normalized` NOT LIKE '%@%'
      AND `username_normalized` NOT LIKE '% %'
      AND `username_normalized` REGEXP '^[a-z0-9][a-z0-9._-]{1,62}[a-z0-9]$'
    ),
  -- Length floor only: the encoding carries its own algorithm and parameters,
  -- so a future rotation needs no schema change. The application validates the
  -- full shape and fails closed on anything it cannot parse.
  CONSTRAINT `ck_user_credential_password_hash`
    CHECK (CHAR_LENGTH(`password_hash`) >= 40),
  CONSTRAINT `ck_user_credential_session_version`
    CHECK (`session_version` >= 1),
  CONSTRAINT `ck_user_credential_status`
    CHECK (`status` IN ('active', 'disabled', 'tombstoned')),
  -- A non-active credential must say when it stopped being usable.
  CONSTRAINT `ck_user_credential_disabled_at`
    CHECK (
      (`status` = 'active' AND `disabled_at` IS NULL)
      OR (`status` <> 'active' AND `disabled_at` IS NOT NULL)
    )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
  COMMENT='Login credentials for a kaudit_user. One row per user; disable or tombstone, never delete';

-- ---------------------------------------------------------------------------
-- Collation alignment (before the foreign key).
-- ---------------------------------------------------------------------------
-- Installations differ between utf8mb4_general_ci and utf8mb4_0900_ai_ci, and a
-- foreign key requires the child and parent columns to share a collation. Align
-- ONLY `user_id` to whatever `kaudit_user`.`id` actually uses; the checked
-- columns above keep their declared utf8mb4_bin. If migration 0003 has not been
-- applied, the lookup yields NULL and PREPARE fails loudly instead of creating
-- an unreferenced table.
SET @kaudit_user_id_collation = (
  SELECT `COLLATION_NAME`
  FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'kaudit_user'
    AND COLUMN_NAME = 'id'
);
SET @kaudit_align_credential_sql = CONCAT(
  'ALTER TABLE `kaudit_user_credential` ',
  'MODIFY COLUMN `user_id` varchar(40) ',
  'CHARACTER SET utf8mb4 COLLATE ', @kaudit_user_id_collation, ' NOT NULL'
);
PREPARE kaudit_align_credential FROM @kaudit_align_credential_sql;
EXECUTE kaudit_align_credential;
DEALLOCATE PREPARE kaudit_align_credential;

-- ---------------------------------------------------------------------------
-- The only foreign key: credential -> user. No ON DELETE CASCADE, on purpose.
-- ---------------------------------------------------------------------------
ALTER TABLE `kaudit_user_credential`
  ADD CONSTRAINT `fk_user_credential_user`
    FOREIGN KEY (`user_id`) REFERENCES `kaudit_user` (`id`);

-- ---------------------------------------------------------------------------
-- VERIFY (read-only):
--   SHOW CREATE TABLE kaudit_user_credential;
--
--   -- expect 1
--   SELECT COUNT(*) FROM information_schema.TABLES
--   WHERE TABLE_SCHEMA = DATABASE()
--     AND TABLE_NAME = 'kaudit_user_credential';
--
--   -- expect exactly one row: kaudit_user
--   SELECT REFERENCED_TABLE_NAME
--   FROM information_schema.REFERENTIAL_CONSTRAINTS
--   WHERE CONSTRAINT_SCHEMA = DATABASE()
--     AND TABLE_NAME = 'kaudit_user_credential';
--
--   -- expect NO ACTION / RESTRICT, never CASCADE
--   SELECT DELETE_RULE FROM information_schema.REFERENTIAL_CONSTRAINTS
--   WHERE CONSTRAINT_SCHEMA = DATABASE()
--     AND CONSTRAINT_NAME = 'fk_user_credential_user';
--
-- DOWN (rollback, only while the table is empty):
--   DROP TABLE IF EXISTS `kaudit_user_credential`;
--
-- Forward-fix policy:
--   Once credentials exist, do not drop this table or its unique key, and never
--   physically delete a user or reissue a retired username. Never add a
--   plaintext, recoverable, or hint column for the password. Never widen this
--   table with identity attributes that belong on `kaudit_user`, and never add
--   a foreign key from here to any table outside the `kaudit_*` schema.
-- ============================================================================
