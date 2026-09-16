-- ============================================================================
-- Migration 0020 — recurring late-recording correction workflow
-- ============================================================================
-- EXPAND ONLY. This migration creates THREE new Kaudit-owned control tables.
-- It does not alter, backfill, rewrite, or delete any existing table, row,
-- index, or constraint, and it contains no INSERT/UPDATE/DELETE of any kind.
--
-- APPLY ONLY as an approved, supervised schema operation. It does not touch
-- evidence, transcripts, billing calculations, settlements, Call Audit, or any
-- external source table, and it performs no model work.
--
-- Purpose:
--   KServe supplies some calls with a Task ID and no recording. Those settle at
--   INR 0 on the standing `no_recording_zero` rule, because there is no
--   evidence to support a charge. When the recording turns up later — often a
--   month after the fact — an administrator uploads it against the bill month
--   it belongs to, and ONLY those exact tasks are audited and re-priced.
--
--   These tables are the durable provenance of that correction: which month,
--   which file, which administrator, which tasks, what happened to each, and
--   what the month total moved by. They are the append-only record that makes a
--   changed bill explainable a year later.
--
-- What these tables deliberately DO NOT store:
--   A RECORDING URL, in any form. Not the submitted one, not the signed one,
--   not the canonical one. The canonical URL has exactly ONE home in this
--   schema — `kaudit_call_artifact.source_url`, which is server-only and never
--   exported — and everything here identifies it by SHA-256 instead. A hash
--   cannot be rendered as a playable link by a page, a log, or an export,
--   which is the whole reason it is what these tables hold.
--
--   Also never stored here: transcripts, prompts, provider prose or raw
--   responses, phone numbers, credentials, or PII. Only internal ids, the
--   displayed Task ID an administrator actually typed, lifecycle, provenance,
--   hashes, counts, fixed-precision money, and bounded application codes.
--
-- The one-way evidence transition:
--   An existing recording artifact with `source_url IS NULL` has NO evidence
--   behind it — nothing was ever fetched, hashed, or listened to. Filling it in
--   is therefore not a mutation of evidence; it is the first attachment of
--   evidence, and it is permitted exactly once. `kaudit_late_recording_item`
--   records that transition. Once `source_url` is non-null, or once `sha256`
--   has been recorded, the artifact is immutable and a differing URL is a
--   CONFLICT that this workflow refuses rather than overwrites.
--
-- Relationship to `kaudit_kserve_monthly_settlement`:
--   None, structurally and deliberately. That table is the factual amount
--   Finance actually PAID, and this workflow never writes it. The month
--   correction row below records a PROPOSED adjustment — previous verified
--   total, revised verified total, and the delta — and accepting it remains an
--   explicit append-only Finance action against that separate table.
-- ---------------------------------------------------------------------------

CREATE TABLE `kaudit_late_recording_batch` (
  `id` varchar(40) NOT NULL
    COMMENT 'Internal batch handle (lrb_); never a call, artifact, or audit-run id. This is the ONLY identifier a dispatch or a workflow input may carry',
  `bill_month` char(7) NOT NULL
    COMMENT 'The single monthly period this upload corrects, as YYYY-MM',
  `period_start` date NOT NULL
    COMMENT 'Inclusive first day of bill_month, stored so the row states its own period',
  `period_end` date NOT NULL
    COMMENT 'Inclusive last day of bill_month',
  `source_file_sha256` char(64) NOT NULL
    COMMENT 'SHA-256 of the uploaded CSV exactly as received; the file itself is never stored',
  `request_digest` char(64) NOT NULL
    COMMENT 'SHA-256 over the month plus the sorted (task id, canonical URL hash) pairs, so a retry can be proven identical before it is replayed. Contains no URL',
  `idempotency_key` varchar(80) NOT NULL
    COMMENT 'Bounded caller retry key; a repeat of it replays this row',
  `requested_by_user_id` varchar(40) DEFAULT NULL
    COMMENT 'kaudit_user.id of the authenticated administrator; provenance only, never returned by any API',
  `correlation_id` varchar(120) DEFAULT NULL
    COMMENT 'Request correlation id for the access log; never returned by any API',
  `ruleset_version` varchar(80) NOT NULL
    COMMENT 'Classifier ruleset deployed when the batch was accepted',
  `rate_card_version_id` varchar(64) NOT NULL
    COMMENT 'The ONE published rate card covering the whole bill month under the locked ruleset, bound at acceptance. Every later run and recovery prices with exactly this card',
  `baseline_verified_total` decimal(20,8) DEFAULT NULL
    COMMENT 'Month verified total captured ONCE, before this batch first changed money, and reused by every retry and restart',
  `baseline_captured_at` datetime(6) DEFAULT NULL,
  `status` varchar(32) NOT NULL DEFAULT 'accepted'
    COMMENT 'Terminal (completed*) ONLY in the same transaction that writes the month correction row',
  `submitted_count` int unsigned NOT NULL
    COMMENT 'Rows in the uploaded file, including the ones rejected',
  `accepted_count` int unsigned NOT NULL
    COMMENT 'Rows that passed every validation and became items',
  `rejected_count` int unsigned NOT NULL DEFAULT 0,
  `corrected_count` int unsigned NOT NULL DEFAULT 0,
  `failed_count` int unsigned NOT NULL DEFAULT 0,
  `requested_at` datetime(6) NOT NULL
    COMMENT 'Application-supplied UTC-naive instant the administrator committed the upload',
  `started_at` datetime(6) DEFAULT NULL,
  `completed_at` datetime(6) DEFAULT NULL,
  `created_at` datetime(6) NOT NULL DEFAULT current_timestamp(6),
  `updated_at` datetime(6) NOT NULL DEFAULT current_timestamp(6)
    ON UPDATE current_timestamp(6),
  PRIMARY KEY (`id`),
  -- A retried POST lands on the existing batch instead of minting a second one.
  UNIQUE KEY `uq_late_recording_batch_key` (`idempotency_key`),
  KEY `idx_late_recording_batch_month` (`bill_month`, `requested_at`),
  KEY `idx_late_recording_batch_status` (`status`, `requested_at`),
  CONSTRAINT `chk_late_recording_batch_status`
    CHECK (`status` IN
      ('accepted','running','completed','completed_with_failures')),
  -- The API's own ceiling, restated where a caller cannot bypass it.
  CONSTRAINT `chk_late_recording_batch_count`
    CHECK (`submitted_count` BETWEEN 1 AND 100
           AND `accepted_count` <= `submitted_count`),
  CONSTRAINT `chk_late_recording_batch_progress`
    CHECK (`corrected_count` + `failed_count` <= `accepted_count`),
  CONSTRAINT `chk_late_recording_batch_period_order`
    CHECK (`period_start` <= `period_end`),
  CONSTRAINT `chk_late_recording_batch_baseline`
    CHECK ((`baseline_verified_total` IS NULL) = (`baseline_captured_at` IS NULL)
           AND (`baseline_verified_total` IS NULL OR `baseline_verified_total` >= 0))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
  COMMENT='Kaudit-owned late-recording correction batch; control metadata and hashes only, never a URL';

CREATE TABLE `kaudit_late_recording_item` (
  `id` varchar(40) NOT NULL
    COMMENT 'Internal item handle (lri_)',
  `batch_id` varchar(40) NOT NULL,
  `call_id` varchar(36) NOT NULL
    COMMENT 'Internal call id, resolved server-side from the uploaded Task ID',
  `call_artifact_id` varchar(36) NOT NULL
    COMMENT 'The existing recording artifact whose source_url was NULL when this item was accepted',
  `task_reference` varchar(191) NOT NULL
    COMMENT 'The Task ID the administrator uploaded, kept so a rejected or failed row can be shown back to them. Never a URL',
  `row_number` smallint unsigned NOT NULL
    COMMENT '1-based row in the uploaded file, so a refusal points at a spreadsheet line',
  `canonical_url_sha256` char(64) NOT NULL
    COMMENT 'SHA-256 of the CANONICAL S3 object URL after the signing query was stripped. The URL itself lives only in kaudit_call_artifact.source_url',
  `state` varchar(24) NOT NULL DEFAULT 'accepted',
  -- One ACTIVE item per internal call, enforced by the unique key below: the
  -- column holds the call id while the item is live and NULL once it settles,
  -- and MySQL does not apply a unique key to NULL. This is what makes a second
  -- upload, a second administrator, and a retried POST unable to double-spend.
  `active_call_id` varchar(36)
    GENERATED ALWAYS AS
      (CASE WHEN `state` IN ('accepted','auditing')
            THEN `call_id` ELSE NULL END)
    STORED,
  `attempt_count` tinyint unsigned NOT NULL DEFAULT 0
    COMMENT 'Item claims made; the artifact audit retry state controls bounded resume without incrementing this value',
  `previous_amount` decimal(20,8) DEFAULT NULL
    COMMENT 'The call amount on the superseded calculation, fixed precision, captured when the correction is written',
  `revised_amount` decimal(20,8) DEFAULT NULL
    COMMENT 'The call amount on the new final calculation, fixed precision. May be zero: evidence decides',
  `superseded_calculation_id` varchar(40) DEFAULT NULL
    COMMENT 'The no_recording_zero calculation this correction superseded. The old row itself is never modified',
  `last_error_code` varchar(80) DEFAULT NULL
    COMMENT 'Bounded application code only; never provider or thrown prose',
  `created_at` datetime(6) NOT NULL DEFAULT current_timestamp(6),
  `started_at` datetime(6) DEFAULT NULL,
  `completed_at` datetime(6) DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_late_recording_batch_call` (`batch_id`, `call_id`),
  UNIQUE KEY `uq_late_recording_active_call` (`active_call_id`),
  KEY `idx_late_recording_item_queue` (`batch_id`, `state`, `created_at`),
  KEY `idx_late_recording_item_call` (`call_id`, `state`),
  CONSTRAINT `fk_late_recording_item_batch`
    FOREIGN KEY (`batch_id`)
    REFERENCES `kaudit_late_recording_batch` (`id`),
  CONSTRAINT `fk_late_recording_item_call`
    FOREIGN KEY (`call_id`) REFERENCES `kaudit_call` (`id`),
  CONSTRAINT `chk_late_recording_item_state`
    CHECK (`state` IN ('accepted','auditing','corrected','failed')),
  CONSTRAINT `chk_late_recording_item_attempts`
    CHECK (`attempt_count` <= 1),
  CONSTRAINT `chk_late_recording_item_amounts`
    CHECK (`previous_amount` IS NULL OR `previous_amount` >= 0),
  CONSTRAINT `chk_late_recording_item_revised`
    CHECK (`revised_amount` IS NULL OR `revised_amount` >= 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
  COMMENT='Exact tasks accepted into one late-recording batch, with the one-way NULL -> canonical URL evidence transition recorded as a hash';

-- ---------------------------------------------------------------------------
-- The month correction result. APPEND-ONLY, and structurally so.
-- ---------------------------------------------------------------------------
-- One row per completed batch. There is no UPDATE path and no DELETE path: a
-- second correction of the same month is a second batch and therefore a second
-- row, and the month's full history is the rows in order.
--
-- `previous_verified_total` and `revised_verified_total` are the AUDITOR's
-- payable totals for the whole month, before and after this batch. The delta is
-- their difference and is stored rather than derived, so a reader never has to
-- trust that two columns were subtracted the way the run subtracted them.
--
-- `actual_paid_amount` is a SNAPSHOT of what Finance had recorded as paid at
-- the moment the batch completed, copied for context. It is never written back
-- to `kaudit_kserve_monthly_settlement`: that table is Finance's own fact, and
-- correcting it stays an explicit Finance action.
CREATE TABLE `kaudit_late_recording_month_correction` (
  `id` varchar(40) NOT NULL,
  `batch_id` varchar(40) NOT NULL,
  `bill_month` char(7) NOT NULL,
  `currency` char(3) NOT NULL DEFAULT 'INR'
    COMMENT 'Pinned to INR; the locked KServe ruleset is INR-only',
  `previous_verified_total` decimal(20,8) NOT NULL
    COMMENT 'Auditor-verified payable total for the month BEFORE this batch, fixed precision',
  `revised_verified_total` decimal(20,8) NOT NULL
    COMMENT 'Auditor-verified payable total for the month AFTER this batch, fixed precision',
  `delta_amount` decimal(20,8) NOT NULL
    COMMENT 'revised minus previous. A negative value is preserved, never clamped',
  `actual_paid_amount` decimal(20,8) DEFAULT NULL
    COMMENT 'Snapshot of the current recorded settlement for context. NULL when Finance has recorded none',
  `revised_variance` decimal(20,8) DEFAULT NULL
    COMMENT 'actual_paid_amount minus revised_verified_total, the proposed Finance adjustment. NULL when nothing is recorded as paid',
  `corrected_count` int unsigned NOT NULL,
  `failed_count` int unsigned NOT NULL DEFAULT 0,
  `completed_at` datetime(6) NOT NULL
    COMMENT 'The latest item completion instant, derived from durable item rows so a replayed finalize writes identical bytes',
  `created_at` datetime(6) NOT NULL DEFAULT current_timestamp(6)
    COMMENT 'Database insert instant. There is deliberately no updated_at: nothing here is ever updated',
  PRIMARY KEY (`id`),
  -- One correction result per batch. A retried finalize replays this row.
  UNIQUE KEY `uq_late_recording_correction_batch` (`batch_id`),
  KEY `idx_late_recording_correction_month` (`bill_month`, `completed_at`),
  CONSTRAINT `fk_late_recording_correction_batch`
    FOREIGN KEY (`batch_id`)
    REFERENCES `kaudit_late_recording_batch` (`id`),
  CONSTRAINT `chk_late_recording_correction_currency`
    CHECK (`currency` = 'INR'),
  CONSTRAINT `chk_late_recording_correction_totals`
    CHECK (`previous_verified_total` >= 0 AND `revised_verified_total` >= 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
  COMMENT='APPEND-ONLY per-batch month correction result. Never updated, never deleted, and never a write path into kaudit_kserve_monthly_settlement';

-- APPLY with scripts/apply-expand-migration.mjs. For a migration made only of
-- CREATE TABLE statements the runner checks and creates EACH table on its own,
-- so a partially applied first run is completed by simply running it again.
--
-- VERIFY (read-only):
--   SHOW CREATE TABLE kaudit_late_recording_batch;
--   SHOW CREATE TABLE kaudit_late_recording_item;
--   SHOW CREATE TABLE kaudit_late_recording_month_correction;
--
--   -- expect 3
--   SELECT COUNT(*) FROM information_schema.TABLES
--   WHERE TABLE_SCHEMA = DATABASE()
--     AND TABLE_NAME IN ('kaudit_late_recording_batch',
--                        'kaudit_late_recording_item',
--                        'kaudit_late_recording_month_correction');
--
--   -- expect 0 rows: nothing here may reference the settlement table
--   SELECT TABLE_NAME FROM information_schema.REFERENTIAL_CONSTRAINTS
--   WHERE CONSTRAINT_SCHEMA = DATABASE()
--     AND REFERENCED_TABLE_NAME = 'kaudit_kserve_monthly_settlement'
--     AND TABLE_NAME LIKE 'kaudit_late_recording%';
--
--   -- expect 0 rows: at most one live item per call
--   SELECT call_id, COUNT(*) FROM kaudit_late_recording_item
--   WHERE active_call_id IS NOT NULL GROUP BY call_id HAVING COUNT(*) > 1;
--
-- Rollback BEFORE USE only:
--   DROP TABLE kaudit_late_recording_month_correction;
--   DROP TABLE kaudit_late_recording_item;
--   DROP TABLE kaudit_late_recording_batch;
-- Once batches exist, retain them as operational and financial audit history
-- and forward-fix. Dropping them destroys the only record of WHY a closed
-- month's verified total changed.
--
-- Forward-fix policy:
--   Never add a URL column to any of these tables. Never add an UPDATE or
--   DELETE path for `kaudit_late_recording_month_correction`. Never add a
--   foreign key or a write path from here to
--   `kaudit_kserve_monthly_settlement`, to `ai_voice_leads_received`, or to any
--   Call Audit table.
-- ============================================================================
