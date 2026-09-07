-- ============================================================================
-- Migration 0019 — kaudit_transcription_cache (a short-lived cache of audio
--                  already transcribed, so a retry never re-pays for it)
-- ============================================================================
-- EXPAND ONLY. This migration creates ONE new table. It does not alter,
-- backfill, rewrite, or delete any existing table, row, index, or constraint,
-- and it contains no INSERT/UPDATE/DELETE of any kind.
--
-- Purpose:
--   Transcription is 93% of what an audit costs -- Whisper is billed per
--   minute of audio, the analysis model costs almost nothing beside it. When
--   an audit's classification step failed, NOTHING was persisted: the failure
--   path writes only a failed audit run. So every retry fetched the same audio
--   and paid to transcribe it again, and the classification failures number in
--   the thousands.
--
--   This table holds the transcript between an attempt and its retry, keyed on
--   a hash of the exact audio bytes. Identical audio is transcribed once.
--
-- Why not reuse kaudit_transcript:
--   That table is EVIDENCE. It records what an audit concluded, is written
--   only when an audit succeeds, and carries no audio duration -- which is a
--   billing input and cannot be re-derived from segments without losing
--   trailing silence. Storing failed attempts there would put non-evidence in
--   an evidence table and risk two transcript rows for one artifact.
--
-- Content and retention:
--   Rows hold transcript text, which is customer speech. That is why they
--   EXPIRE. The window covers the retry schedule and nothing more; expired
--   rows are deleted by the worker on every run. This is a payment
--   optimisation with a deadline, not a second transcript store, and it must
--   not become one.
--
-- Safety:
--   A miss simply transcribes, exactly as today. Nothing reads this table to
--   decide an amount: it only avoids paying twice for the same bytes. The
--   cached payload deliberately carries NO usage record, so a reused
--   transcript reports no new spend and the cost figures stay honest.
--
-- Rollback:
--   DROP TABLE `kaudit_transcription_cache`;
--   Nothing else references it and no other table points at it.
-- ============================================================================

CREATE TABLE `kaudit_transcription_cache` (
  `input_sha256` char(64) NOT NULL
    COMMENT 'SHA-256 of the exact audio bytes transcribed. The key: only byte-identical audio may reuse a transcript',
  `call_artifact_id` varchar(40) NOT NULL
    COMMENT 'Artifact the audio came from, for tracing and targeted eviction. Not part of the identity: the same bytes transcribe the same way',
  `provider_name` varchar(40) NOT NULL
    COMMENT 'Transcription provider that produced this payload',
  `model_name` varchar(80) NOT NULL
    COMMENT 'Transcription model. A payload from a different model is not reused, so changing models cannot silently serve old output',
  `model_version` varchar(80) NOT NULL
    COMMENT 'Transcription model version, compared the same way',
  `payload_json` longtext NOT NULL
    COMMENT 'The transcription result as JSON: language, durations, text and segments. Carries no usage record, so reuse reports no new spend',
  `payload_sha256` char(64) NOT NULL
    COMMENT 'SHA-256 over payload_json, so a row altered outside this path is discarded rather than replayed into an audit',
  `expires_at` datetime(6) NOT NULL
    COMMENT 'When this row stops being usable and becomes deletable. Customer speech does not live here indefinitely',
  `created_at` datetime(6) NOT NULL DEFAULT current_timestamp(6)
    COMMENT 'Database insert instant',
  PRIMARY KEY (`input_sha256`),
  KEY `idx_transcription_cache_expiry` (`expires_at`),
  KEY `idx_transcription_cache_artifact` (`call_artifact_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
  COMMENT='EXPIRING cache of transcribed audio so a retry never re-pays. Recomputable, never evidence, safe to truncate';

-- VERIFY (read-only):
--   SHOW CREATE TABLE kaudit_transcription_cache;
--
--   -- expect 1
--   SELECT COUNT(*) FROM information_schema.TABLES
--   WHERE TABLE_SCHEMA = DATABASE()
--     AND TABLE_NAME = 'kaudit_transcription_cache';
--
--   -- expect 0 rows: nothing in the schema may reference a cache
--   SELECT TABLE_NAME FROM information_schema.REFERENTIAL_CONSTRAINTS
--   WHERE CONSTRAINT_SCHEMA = DATABASE()
--     AND REFERENCED_TABLE_NAME = 'kaudit_transcription_cache';
--
--   -- expect 0 rows: nothing may outlive its window
--   SELECT COUNT(*) FROM kaudit_transcription_cache
--   WHERE expires_at < UTC_TIMESTAMP(6);
