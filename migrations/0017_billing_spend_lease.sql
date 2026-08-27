-- ============================================================================
-- Migration 0017 — kaudit_billing_spend_lease (durable pre-model spend claim
--                  for Billing Audit)
-- ============================================================================
-- EXPAND ONLY. One new table; nothing existing is altered, backfilled, or
-- rewritten. No INSERT/UPDATE/DELETE of any kind.
--
-- Purpose:
--   Close the duplicate-spend window in Billing Audit. A worker claims a
--   call's evidence, pays a model to transcribe + classify it, and only then
--   persists the result. If persistence fails — or the instance dies mid-run —
--   the old flow left the item claimable again, so the next run would pay a
--   model for the SAME question a second time.
--
-- Lifecycle (two-phase):
--   1. CLAIM, committed on its own BEFORE any model call. The claim key IS
--      the work identity: sha256 of (call_id, artifact_id, baseline evidence
--      sha256, ruleset version, engine version [, manual queue item id]). Two
--      overlapping runs race on this primary key; exactly one may proceed to
--      spend.
--   2. STAGE, after the paid model returns and BEFORE result persistence. The
--      lease stores only the Kaudit-owned result document needed to recover the
--      database write; never prompts, URLs, raw provider errors, or secrets.
--   3. SETTLE, after processing: 'completed' once results are durably written,
--      'released' when the worker proves NO model call happened (e.g., the
--      recording could not be fetched), left active only when recovery owns
--      the next step.
--
-- Interruption semantics (bounded leases, exactly one paid attempt):
--   - An active lease whose expiry has passed and has a staged result is
--     recovered by persisting that staged result; it never calls the model.
--   - An active lease with no staged result is ambiguous: the old process may
--     have crossed the paid boundary. Recovery stages a bounded terminal result
--     and persists it; it never calls the model again automatically.
--   - A manual re-audit binds its queue item id into the lease key, so every
--     administrator request is its own freely claimable unit of work while
--     same-question reruns stay deduplicated.
--
-- What it holds, and what it must never hold:
--   Internal identifiers, lifecycle state, counts, instants, and only the
--   normalized fields required by the existing final audit writer. Staging
--   NEVER contains a URL, prompt, raw provider response/error, displayed
--   reference, or money projection. Necessary transcript segments and the
--   bounded finding explanation remain under the same access/retention
--   boundary as their final Kaudit-owned records, and staging is cleared after
--   successful final persistence.
-- ---------------------------------------------------------------------------

CREATE TABLE `kaudit_billing_spend_lease` (
  `id` varchar(64) NOT NULL
    COMMENT 'Work identity: hex(sha256) over (call_id, artifact_id, baseline_sha256, ruleset_version, engine_version[, manual_item_id]). Deterministic, privacy-safe, and unique per question asked of a model',
  `call_id` char(36) NOT NULL
    COMMENT 'Internal call id the lease covers',
  `artifact_id` char(36) NOT NULL
    COMMENT 'Internal recording artifact id the lease covers',
  `manual_item_id` varchar(40) DEFAULT NULL
    COMMENT 'Administrator queue item, when this is a requested re-audit; used only to recover its work state coherently',
  `status` ENUM('active','completed','released','expired') NOT NULL DEFAULT 'active'
    COMMENT 'active = claim/recovery held; completed = results durably written; released = proven no model call; expired = administratively terminal legacy state',
  `attempt_count` int unsigned NOT NULL DEFAULT 1
    COMMENT 'Exactly one possible paid attempt; automatic paid reclaim is forbidden',
  `worker_id` varchar(80) NOT NULL
    COMMENT 'Opaque run identifier that last claimed this lease; no hostname beyond what the operator configures',
  `claimed_at` datetime(6) NOT NULL
    COMMENT 'Application-supplied instant of the current claim',
  `lease_expires_at` datetime(6) NOT NULL
    COMMENT 'When the current claim may be recovered by another run',
  `staged_result_json` json DEFAULT NULL
    COMMENT 'Temporary normalized persistence fields; no URLs, prompts, raw responses/errors, displayed references, or money projections',
  `staged_at` datetime(6) DEFAULT NULL
    COMMENT 'When staged_result_json was written by the owning worker',
  `settled_at` datetime(6) DEFAULT NULL
    COMMENT 'When the lease reached completed/released/expired',
  `created_at` datetime(6) NOT NULL DEFAULT current_timestamp(6),
  -- THE guarantee: one lease per work identity. Concurrent claims race here;
  -- the loser receives a duplicate-key error and must not call the model.
  PRIMARY KEY (`id`),
  KEY `idx_billing_spend_lease_call` (`call_id`, `status`),
  KEY `idx_billing_spend_lease_manual_item` (`manual_item_id`, `status`),
  KEY `idx_billing_spend_lease_expiry` (`status`, `lease_expires_at`),
  CONSTRAINT `chk_billing_spend_lease_attempts` CHECK (`attempt_count` = 1),
  CONSTRAINT `fk_billing_spend_lease_manual_item`
    FOREIGN KEY (`manual_item_id`)
    REFERENCES `kaudit_billing_reaudit_item` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
  COMMENT='Durable pre-model spend claim for Billing Audit: one row per unique audit question; claimed before any model call, settled with or after the result';

-- VERIFY (read-only):
--   SHOW CREATE TABLE kaudit_billing_spend_lease;
--
--   -- expect 1
--   SELECT COUNT(*) FROM information_schema.TABLES
--   WHERE TABLE_SCHEMA = DATABASE()
--     AND TABLE_NAME = 'kaudit_billing_spend_lease';
--
-- DOWN (rollback):
--   DROP TABLE IF EXISTS kaudit_billing_spend_lease;
--   Safe for the schema, NOT safe operationally: dropping it reopens the
--   duplicate-spend window for any interrupted item until the table exists
--   again. Do not drop outside an approved, supervised operation.
-- ============================================================================
