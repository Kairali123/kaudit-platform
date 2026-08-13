-- ============================================================================
-- Migration 0011 — kaudit_call_audit_spend_claim (cross-run duplicate-spend
--                  protection for Call Audit)
-- ============================================================================
-- EXPAND ONLY. This migration creates ONE new table and adds two foreign keys
-- FROM that new table. It does not alter, backfill, rewrite, or delete any
-- existing table, row, index, or constraint, and it contains no INSERT/UPDATE/
-- DELETE of any kind.
--
-- Purpose:
--   Make "we already paid a model to audit this exact evidence" a fact the
--   database enforces, instead of a fact each run has to remember.
--
--   A Call Audit result is identified by (run_id, source_ref_id,
--   rule_version_id), so a NEW run over an overlapping period produces a NEW
--   result identity for a source revision that was already audited — and would
--   therefore call the paid content model a second time for the same immutable
--   evidence. Checking "has this revision a prior result?" alone cannot stop
--   two runs that overlap in TIME: both would read "no prior result" before
--   either had written one, and both would spend.
--
--   This table is the claim primitive that closes that window. Exactly one row
--   may ever exist per `source_ref_id`, so the first run to INSERT it wins the
--   right to spend on that revision, and every later or concurrent run loses
--   the insert on the primary key and must not call the model.
--
-- The claim key IS the evidence identity:
--   `kaudit_call_audit_source_ref.id` is derived deterministically from
--   (`source_table`, `source_row_id`, `source_revision_sha256`) — the exact
--   immutable source revision and nothing else. A CHANGED source revision
--   hashes to a different `source_ref_id` and is therefore a different, freely
--   claimable row: new evidence is always eligible for a first audit, which is
--   the whole point of keeping the source reference table append-only and
--   revision-aware.
--
-- Default deny, permanently:
--   A claim is written BEFORE the model call and is never deleted, expired, or
--   released — not on failure, not on a crash, not on a refusal. A run that
--   claimed a revision and then failed still consumed, or may have consumed,
--   provider tokens for it, and a claim that released itself on failure would
--   re-open exactly the duplicate-spend window this table exists to close.
--
--   The deliberate consequence: once a revision has been claimed, no later run
--   may spend on it again, for any reason. There is intentionally NO force
--   flag, override column, re-audit marker, TTL, or "allow_respend" switch
--   here, and none may be added by a later migration. A deliberate historical
--   re-audit is an administrator decision that needs its own approved,
--   audited approval path; it is NOT a column on this table.
--
-- What it holds, and what it must never hold:
--   * `source_ref_id` — the already-privacy-safe id of the source reference
--     row. It is a hash-derived `cas_` identifier, never a lead ID, Task ID,
--     phone, email, name, URL, or source row value.
--   * `run_id` / `rule_version_id` — which run under which contract took the
--     claim, so the claim is accountable and joins to the run that spent.
--   * `claimed_at` — when the claim was taken.
--   * NEVER a transcript, transcript text or excerpt, prompt, provider
--     response, provider prose, token count, latency, error message,
--     credential, or ANY money value. Money is Billing Audit's concern and
--     never Call Audit's; this table is about permission to call a model, not
--     about what that call cost.
--
-- Source-table read-only behavior:
--   `ai_voice_leads_received` is an EXTERNAL, READ-ONLY table owned by another
--   system. This migration never creates, alters, writes, locks, or foreign-
--   keys to it, and neither does any statement that reads or writes this
--   table. The claim reaches the external source only indirectly, through the
--   logical (`source_table`, `source_row_id`) reference already held by
--   `kaudit_call_audit_source_ref`.
--
-- Billing boundary:
--   This table belongs to Call Audit alone. It does not reference, join to, or
--   share a key with any billing table, and no billing figure is derivable
--   from it.
-- ---------------------------------------------------------------------------

CREATE TABLE `kaudit_call_audit_spend_claim` (
  `source_ref_id` varchar(40) NOT NULL
    COMMENT 'The exact immutable source revision this claim covers; equals kaudit_call_audit_source_ref.id, which is derived only from (source_table, source_row_id, source_revision_sha256)',
  `run_id` varchar(40) NOT NULL
    COMMENT 'The run that won the right to spend on this revision. Never re-pointed',
  `rule_version_id` varchar(40) NOT NULL
    COMMENT 'The contract that run was executing; part of the composite provenance below',
  `claimed_at` datetime(6) NOT NULL
    COMMENT 'Application-supplied UTC-naive instant the claim was taken, BEFORE any model call',
  `created_at` datetime(6) NOT NULL DEFAULT current_timestamp(6),
  -- THE guarantee. `source_ref_id` alone is the primary key, so InnoDB admits
  -- exactly one claim per source revision for all time. Two overlapping runs
  -- racing on the same revision both attempt this INSERT; one commits and one
  -- receives a duplicate-key error, so at most one of them can go on to call
  -- the model. Adding `run_id` to this key would give every run its own claim
  -- and silently restore duplicate spend, so it must never be widened.
  PRIMARY KEY (`source_ref_id`),
  -- "Which revisions did this run pay to audit", answerable without scanning.
  KEY `idx_call_audit_spend_claim_run` (`run_id`, `claimed_at`),
  -- Supporting index for the composite provenance foreign key below.
  KEY `fk_call_audit_spend_claim_run_rule` (`run_id`, `rule_version_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
  COMMENT='APPEND-ONLY, one row per immutable source revision, FOREVER. A row is never updated, released, expired, or deleted: it records that a Call Audit run was permitted to call the paid content model for this exact evidence, and that permission is granted exactly once';

-- ---------------------------------------------------------------------------
-- Foreign keys — to Call Audit tables only, in the established composite style.
-- ---------------------------------------------------------------------------
-- Provenance is enforced compositely, exactly as migration 0008 does for
-- results and usage events: the run and the rule version are referenced as one
-- tuple, so a claim cannot name run A while claiming contract B. There is
-- deliberately no separate claim -> run or claim -> rule_version key, because
-- either alone would re-admit the mismatch the composite key forbids.
ALTER TABLE `kaudit_call_audit_spend_claim`
  ADD CONSTRAINT `fk_call_audit_spend_claim_source_ref`
    FOREIGN KEY (`source_ref_id`)
    REFERENCES `kaudit_call_audit_source_ref` (`id`),
  ADD CONSTRAINT `fk_call_audit_spend_claim_run_rule`
    FOREIGN KEY (`run_id`, `rule_version_id`)
    REFERENCES `kaudit_call_audit_run` (`id`, `rule_version_id`);

-- VERIFY (read-only):
--   SHOW CREATE TABLE kaudit_call_audit_spend_claim;
--
--   -- expect 1
--   SELECT COUNT(*) FROM information_schema.TABLES
--   WHERE TABLE_SCHEMA = DATABASE()
--     AND TABLE_NAME = 'kaudit_call_audit_spend_claim';
--
--   -- expect exactly: kaudit_call_audit_run, kaudit_call_audit_source_ref
--   SELECT DISTINCT REFERENCED_TABLE_NAME
--   FROM information_schema.REFERENTIAL_CONSTRAINTS
--   WHERE CONSTRAINT_SCHEMA = DATABASE()
--     AND TABLE_NAME = 'kaudit_call_audit_spend_claim';
--
--   -- expect 0 rows: nothing references this table, so dropping it is local
--   SELECT TABLE_NAME
--   FROM information_schema.REFERENTIAL_CONSTRAINTS
--   WHERE CONSTRAINT_SCHEMA = DATABASE()
--     AND REFERENCED_TABLE_NAME = 'kaudit_call_audit_spend_claim';
--
-- DOWN (rollback):
--   DROP TABLE IF EXISTS `kaudit_call_audit_spend_claim`;
--   Safe for the schema — nothing references this table — but NOT safe
--   operationally: dropping it removes the only race-free guarantee that two
--   overlapping runs cannot both pay to audit the same evidence. Restore it
--   before any Call Audit batch is run again.
--
-- Forward-fix policy:
--   Never widen the primary key. Never add a force, override, re-audit, TTL,
--   expiry, or release column, and never add a DELETE or UPDATE path for these
--   rows: each would reintroduce duplicate spend by design. Never add a
--   foreign key to `ai_voice_leads_received` or to any table outside the
--   Call Audit `kaudit_call_audit_*` group. Never add a money column.
-- ============================================================================
