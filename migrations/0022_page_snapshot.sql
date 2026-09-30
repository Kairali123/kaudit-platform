-- Stored snapshots of heavy page aggregates (first user: Audit Monitor summaries).
--
-- The Audit Monitor recomputed three month-wide aggregates (8-13 s statements
-- over ~39k calls) on every page view inside the 30 s web function. They timed
-- out, and while running they saturated the database so unrelated reads (even
-- the session lookup) stalled. Pages now read the last stored result and a
-- dedicated long-running function recomputes it on demand.
--
-- APPLY ONLY as an approved, supervised schema operation. Additive: one new
-- table, no change to any existing table or row. It is a CACHE -- recomputable,
-- never evidence -- and safe to truncate.

CREATE TABLE `kaudit_page_snapshot` (
  `snapshot_key` varchar(160) NOT NULL
    COMMENT 'Page, section and scope, e.g. audit-monitor:summary-core:2026-06',
  `payload_json` longtext NULL
    COMMENT 'The computed response as JSON; NULL until the first refresh completes',
  `payload_sha256` char(64) NULL
    COMMENT 'SHA-256 over payload_json; a row that does not match is ignored',
  `definition` varchar(80) NULL
    COMMENT 'Definition of the aggregates that produced payload_json; other definitions are ignored',
  `computed_at` datetime(6) NULL
    COMMENT 'UTC instant payload_json was computed',
  `refresh_started_at` datetime(6) NULL
    COMMENT 'UTC instant a refresh claimed this row; NULL when none is running. A stale claim expires',
  `updated_at` datetime(6) NOT NULL DEFAULT current_timestamp(6)
    ON UPDATE current_timestamp(6),
  PRIMARY KEY (`snapshot_key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
  COMMENT='CACHE of heavy page aggregates. Recomputable, never evidence, safe to truncate';

-- Read-only verification after an approved application:
--   SHOW CREATE TABLE kaudit_page_snapshot;
