-- ============================================================================
-- Migration 0008 — Kserve Call Audit Report persistence foundation
-- ============================================================================
-- EXPAND ONLY. This migration creates six new tables and nothing else. It does
-- not alter, backfill, rewrite, or delete any existing table, row, or index, and
-- it contains no INSERT/UPDATE/DELETE of any kind.
--
-- Purpose:
--   1. version the editable business prompt + model + scoring config that a
--      transcript-based call audit was produced under (draft/active/retired);
--   2. record each audit run over an exact half-open period in Asia/Kolkata;
--   3. reference the rows to audit WITHOUT copying customer or raw content,
--      append-only and revision-aware so reconciliation and re-audits see every
--      source revision;
--   4. store per-call results and per-metric scores as append-only history; and
--   5. record EVERY model request attempt — including retries, refusals, and
--      failures — so cost and reliability reporting cannot silently count only
--      the attempts that happened to succeed.
--
-- Source-table read-only behavior:
--   `ai_voice_leads_received` is an EXTERNAL, READ-ONLY source table owned by
--   another system. This migration never creates, alters, writes, locks, or
--   foreign-keys to it. `kaudit_call_audit_source_ref` identifies a source row
--   by (`source_table`, `source_row_id`) only — a logical reference, so the
--   audit schema stays decoupled and the source stays unmodified.
--
-- Privacy boundary (matches the approved anonymous design, src/callaudit):
--   `kaudit_call_audit_source_ref` stores ONLY the approved extracted Task ID,
--   hashes, and categorical/operational snapshot fields. The full `lead_id`,
--   client name, mobile, email, transcription view URL, raw transcript,
--   customer context, notes, and summary text are NEVER persisted here.
--   Source FREE TEXT is equally forbidden: ai_call_summary, customer_intent,
--   next_action_required, subject, additional_notes, and response must never
--   be added to it.
--
--   Across every other table here: NO per-call prompt, NO transcript, NO raw
--   model response, NO error payload, and NO prompt containing customer data is
--   ever stored. The administrator-owned `business_prompt` on a rule version IS
--   stored deliberately — it is business-authored evaluation guidance, reviewed
--   before activation, and contains no call content. The only other free text
--   persisted is the SANITIZED, bounded management/KServe/improvement feedback
--   on a result, which the application validator strips of names, numbers,
--   emails, URLs, and quoted transcript text.
--
-- Safety:
--   * schema only; run on a disposable database first;
--   * do not apply to production until Data CODEOWNERS approve it.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Rule versions — the audit contract a result was produced under.
-- ---------------------------------------------------------------------------
CREATE TABLE `kaudit_call_audit_rule_version` (
  `id` varchar(40) NOT NULL,
  `version_label` varchar(80) NOT NULL
    COMMENT 'Human-approved version identity, e.g. call-audit/2026.08.1',
  `status` varchar(20) NOT NULL DEFAULT 'draft'
    COMMENT 'draft, active, or retired',
  `business_prompt` longtext NOT NULL
    COMMENT 'Editable business prompt text; business-owned, no customer data',
  `prompt_sha256` char(64) NOT NULL
    COMMENT 'SHA-256 of business_prompt as activated',
  `model_provider` varchar(80) NOT NULL,
  `model_name` varchar(100) NOT NULL,
  `model_version` varchar(100) NOT NULL,
  `temperature` decimal(4,3) NOT NULL DEFAULT 0.000
    COMMENT 'Fixed-precision sampling temperature; never a float',
  `rule_contract_version` varchar(40) NOT NULL
    COMMENT 'Identity of the locked application contract (prompt frame, schema, taxonomy, rubric). Persisted explicitly, not only inside scoring_config_json, so a query can filter by contract without parsing JSON',
  `output_schema_version` varchar(40) NOT NULL,
  `taxonomy_version` varchar(40) NOT NULL,
  `scoring_config_version` varchar(40) NOT NULL,
  `scoring_config_json` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin
    DEFAULT NULL
    COMMENT 'Canonical locked configuration: output schema, taxonomy, rubric metric codes AND weights, NA policy, and contract versions. Hashed into config_sha256; never contains the editable prompt',
  `config_sha256` char(64) NOT NULL
    COMMENT 'SHA-256 of the canonical config (schema + taxonomy + scoring)',
  `change_reason` varchar(500) DEFAULT NULL,
  `created_by` varchar(40) DEFAULT NULL
    COMMENT 'kaudit_user.id of the creator; no FK, this table outlives users',
  `created_at` datetime(6) NOT NULL DEFAULT current_timestamp(6),
  `activated_by` varchar(40) DEFAULT NULL,
  `activated_at` datetime(6) DEFAULT NULL,
  `retired_by` varchar(40) DEFAULT NULL,
  `retired_at` datetime(6) DEFAULT NULL,
  `updated_at` datetime(6) DEFAULT NULL ON UPDATE current_timestamp(6),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_call_audit_rule_version_label` (`version_label`),
  UNIQUE KEY `uq_call_audit_rule_version_hashes`
    (`version_label`, `prompt_sha256`, `config_sha256`),
  KEY `idx_call_audit_rule_version_status` (`status`, `activated_at`),
  CONSTRAINT `chk_call_audit_rule_version_status`
    CHECK (`status` IN ('draft', 'active', 'retired')),
  CONSTRAINT `chk_call_audit_rule_version_config_json`
    CHECK (`scoring_config_json` IS NULL OR json_valid(`scoring_config_json`))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
  COMMENT='Immutable once activated; corrections are a new version, never an edit';

-- ---------------------------------------------------------------------------
-- 2. Runs — one audit pass over an exact half-open period.
-- ---------------------------------------------------------------------------
CREATE TABLE `kaudit_call_audit_run` (
  `id` varchar(40) NOT NULL,
  `rule_version_id` varchar(40) NOT NULL,
  `run_type` varchar(20) NOT NULL
    COMMENT 'daily, monthly, quarterly, yearly, manual, test, or backfill',
  `period_start` datetime(6) NOT NULL
    COMMENT 'Inclusive period start, in period_timezone',
  `period_end_exclusive` datetime(6) NOT NULL
    COMMENT 'EXCLUSIVE period end; a call at exactly this instant is NOT in scope',
  `period_timezone` varchar(64) NOT NULL DEFAULT 'Asia/Kolkata'
    COMMENT 'IANA zone of the CALENDAR period above. Source rows are UTC-naive, so scheduling converts this calendar period into UTC-naive source boundaries before reading; an IST literal is never queried against the source directly',
  `status` varchar(30) NOT NULL DEFAULT 'pending'
    COMMENT 'pending, running, completed, failed, or cancelled',
  `total_candidates` int NOT NULL DEFAULT 0,
  `processed_count` int NOT NULL DEFAULT 0,
  `succeeded_count` int NOT NULL DEFAULT 0,
  `failed_count` int NOT NULL DEFAULT 0,
  `skipped_count` int NOT NULL DEFAULT 0,
  `content_auditable_count` int NOT NULL DEFAULT 0,
  `operational_only_count` int NOT NULL DEFAULT 0,
  `correlation_id` varchar(120) DEFAULT NULL,
  `idempotency_key` varchar(191) NOT NULL
    COMMENT 'Makes scheduler/worker retries safe; one run per key, forever',
  `triggered_by` varchar(40) DEFAULT NULL
    COMMENT 'kaudit_user.id for manual runs; NULL for scheduled runs',
  `error_code` varchar(80) DEFAULT NULL,
  `scheduled_at` datetime(6) DEFAULT NULL,
  `started_at` datetime(6) DEFAULT NULL,
  `finished_at` datetime(6) DEFAULT NULL,
  `created_at` datetime(6) NOT NULL DEFAULT current_timestamp(6),
  `updated_at` datetime(6) DEFAULT NULL ON UPDATE current_timestamp(6),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_call_audit_run_idempotency` (`idempotency_key`),
  -- Parent key for the composite result FK. Redundant for uniqueness (id is
  -- already the primary key) but required so a result can reference the run
  -- AND its rule version as one unit, making a result that names a different
  -- rule than its own run impossible rather than merely discouraged.
  UNIQUE KEY `uq_call_audit_run_provenance` (`id`, `rule_version_id`),
  KEY `idx_call_audit_run_period`
    (`run_type`, `period_start`, `period_end_exclusive`),
  KEY `idx_call_audit_run_status` (`status`, `scheduled_at`),
  KEY `idx_call_audit_run_finished` (`finished_at`),
  KEY `fk_call_audit_run_rule_version` (`rule_version_id`),
  CONSTRAINT `chk_call_audit_run_type`
    CHECK (`run_type` IN (
      'daily', 'monthly', 'quarterly', 'yearly', 'manual', 'test', 'backfill'
    )),
  CONSTRAINT `chk_call_audit_run_status`
    CHECK (`status` IN (
      'pending', 'running', 'completed', 'failed', 'cancelled'
    )),
  CONSTRAINT `chk_call_audit_run_period_order`
    CHECK (`period_end_exclusive` > `period_start`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- ---------------------------------------------------------------------------
-- 3. Source references — append-only, revision-aware, privacy-safe pointers to
--    the read-only external source table. No foreign key to
--    `ai_voice_leads_received`.
--
--    Revision semantics (required by the approved three-day reconciliation and
--    by future re-audits):
--      * `source_revision_sha256` is the SHA-256 of the canonical privacy-safe
--        snapshot of the source row — the categorical and operational fields
--        below plus the effective call time, transcript hash, and presence flag.
--      * An UNCHANGED revision is REUSED: the writer finds the existing row for
--        (source_table, source_row_id, source_revision_sha256) and audits
--        against it. No new row, no edit.
--      * A CHANGED source revision INSERTS A NEW ROW. A call first seen with no
--        transcript therefore gains a second, independent source reference once
--        a transcript arrives, and both revisions stay auditable forever.
--      * Rows are immutable after insertion. This table deliberately has no
--        `updated_at`: nothing here is ever edited in place.
-- ---------------------------------------------------------------------------
CREATE TABLE `kaudit_call_audit_source_ref` (
  `id` varchar(40) NOT NULL,
  `source_table` varchar(64) NOT NULL DEFAULT 'ai_voice_leads_received'
    COMMENT 'External READ-ONLY source; never written, altered, or FK-referenced',
  `source_row_id` bigint NOT NULL
    COMMENT 'Primary key of the source row; logical reference only, no FK',
  `source_revision_sha256` char(64) NOT NULL
    COMMENT 'SHA-256 of the canonical privacy-safe snapshot; new revision = new row',
  `task_id` varchar(191) DEFAULT NULL
    COMMENT 'Approved extracted Task ID (final hyphen segment); NULL when none can be derived',
  `lead_id_sha256` char(64) DEFAULT NULL
    COMMENT 'SHA-256 of the full source lead ID; NULL when absent or blank. The lead ID itself is never stored',
  `transcript_sha256` char(64) DEFAULT NULL
    COMMENT 'SHA-256 of the raw transcript when one exists; NULL when absent',
  `has_transcript` tinyint(1) NOT NULL DEFAULT 0
    COMMENT 'Presence signal only; drives content_auditable vs operational_only',
  `effective_call_at` datetime(6) NOT NULL
    COMMENT 'Deterministic source event time: COALESCE(call_start_time, date_time, timestamp), UTC-naive. Required, and the leading column of every period and report index, because call_start_time is null for many real calls',
  `source_updated_at` datetime(6) DEFAULT NULL
    COMMENT 'Source row last-modified stamp as reported by the source',
  `call_started_at` datetime(6) DEFAULT NULL
    COMMENT 'Source call_start_time; nullable, so never the basis for period selection',
  `call_ended_at` datetime(6) DEFAULT NULL,
  `call_duration_seconds` int DEFAULT NULL,
  -- Source-aligned categorical snapshot. Widths match ai_voice_leads_received
  -- so a valid KServe value is never truncated. Categorical and operational
  -- values only — never source free text.
  `company_by_kserve` varchar(255) DEFAULT NULL,
  `company` varchar(255) DEFAULT NULL,
  `data_source` varchar(350) DEFAULT NULL,
  `verified_source` varchar(300) DEFAULT NULL,
  `service_category` varchar(300) DEFAULT NULL,
  `call_type` varchar(200) DEFAULT NULL,
  `call_status` varchar(200) DEFAULT NULL,
  `call_end_reason` varchar(255) DEFAULT NULL,
  `final_call_status` varchar(300) DEFAULT NULL,
  `ai_call_category` varchar(1000) DEFAULT NULL
    COMMENT 'Categorical AI classification label; never a summary or narrative',
  `customer_engagement_level` varchar(300) DEFAULT NULL,
  `interest_level` varchar(200) DEFAULT NULL,
  `call_outcome` varchar(255) DEFAULT NULL,
  `lead_status` varchar(300) DEFAULT NULL,
  `final_lead_outcome` varchar(300) DEFAULT NULL,
  `calculated_qualification_status` varchar(300) DEFAULT NULL,
  `followup_required` varchar(300) DEFAULT NULL,
  `source_ref_idempotency_key` varchar(191) NOT NULL
    COMMENT 'Immutable once written; one reference per source row revision, forever',
  `created_at` datetime(6) NOT NULL DEFAULT current_timestamp(6),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_call_audit_source_ref_idempotency`
    (`source_ref_idempotency_key`),
  UNIQUE KEY `uq_call_audit_source_ref_revision`
    (`source_table`, `source_row_id`, `source_revision_sha256`),
  KEY `idx_call_audit_source_ref_row`
    (`source_table`, `source_row_id`, `created_at`),
  KEY `idx_call_audit_source_ref_task` (`task_id`),
  KEY `idx_call_audit_source_ref_lead_hash` (`lead_id_sha256`),
  -- Period and report indexes lead with effective_call_at, never with the
  -- nullable call_started_at, so a call whose call_start_time is null is still
  -- selectable and reportable. Prefix lengths keep composite keys far below the
  -- 3072-byte InnoDB limit even at utf8mb4's 4 bytes per character.
  KEY `idx_call_audit_source_ref_period` (`effective_call_at`),
  KEY `idx_call_audit_source_ref_report`
    (`effective_call_at`, `company`(64), `service_category`(64)),
  KEY `idx_call_audit_source_ref_status`
    (`final_call_status`(64), `effective_call_at`),
  KEY `idx_call_audit_source_ref_outcome`
    (`final_lead_outcome`(64), `effective_call_at`),
  KEY `idx_call_audit_source_ref_eligibility`
    (`has_transcript`, `effective_call_at`),
  CONSTRAINT `chk_call_audit_source_ref_has_transcript`
    CHECK (`has_transcript` IN (0, 1))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
  COMMENT='Append-only revision-aware pointer to ai_voice_leads_received; no lead_id, PII, or raw content';

-- ---------------------------------------------------------------------------
-- 4. Results — append-only per-call audit history.
-- ---------------------------------------------------------------------------
CREATE TABLE `kaudit_call_audit_result` (
  `id` varchar(40) NOT NULL,
  `run_id` varchar(40) NOT NULL,
  `source_ref_id` varchar(40) NOT NULL,
  `rule_version_id` varchar(40) NOT NULL
    COMMENT 'Contract this result was produced under; pinned, never re-pointed',
  `processing_status` varchar(30) NOT NULL DEFAULT 'pending'
    COMMENT 'pending, succeeded, failed, or skipped',
  `eligibility` varchar(30) NOT NULL
    COMMENT 'content_auditable or operational_only',
  `ineligibility_reason` varchar(60) DEFAULT NULL
    COMMENT 'missing_transcript when operational_only; NULL otherwise',
  -- The three reportable call-state facts. NULLABLE on purpose: an
  -- operational-only or failed result has no model answer, and inventing false
  -- would report "the call did not connect" as though it were observed.
  `call_connected` tinyint(1) DEFAULT NULL
    COMMENT 'Model-reported: did the call connect. NULL when not determined',
  `customer_spoke` tinyint(1) DEFAULT NULL
    COMMENT 'Model-reported: did the customer speak. Application forbids 1 when call_connected = 0',
  `meaningful_conversation` tinyint(1) DEFAULT NULL
    COMMENT 'Model-reported: was there a real exchange. Application forbids 1 when customer_spoke = 0',
  `intent` varchar(10) DEFAULT NULL
    COMMENT 'Explicit HIGH, WARM, LOW, or NONE. NULL means not determined and is NEVER read as WARM',
  `intent_confidence` decimal(9,8) DEFAULT NULL,
  `detailed_outcome` varchar(80) DEFAULT NULL
    COMMENT 'One approved label, persisted verbatim from the validated model result',
  `grouped_outcome` varchar(80) DEFAULT NULL
    COMMENT 'Management group DERIVED by the application from detailed_outcome; the model never supplies it. Application validation owns the mapping',
  `qualification_label` varchar(80) DEFAULT NULL
    COMMENT 'QUALIFIED, NON_QUALIFIED, UNCERTAIN, or NOT_APPLICABLE; NULL when not determined',
  `next_action_code` varchar(80) DEFAULT NULL
    COMMENT 'Safe coded next action from the approved taxonomy; never free text',
  -- Deterministic weighted percentage, CALCULATED BY THE APPLICATION, never by
  -- SQL and never by the model: sum(score * weight) * 20 / sum(applicable
  -- weights), half-up to three decimals, with NA weights redistributed. The
  -- range check below guards the stored value; it does not reproduce the rule.
  `overall_score` decimal(6,3) DEFAULT NULL
    COMMENT 'Weighted percentage 0.000-100.000. NULL when every metric is NA, or the result is operational-only or failed. NULL is never 0.000',
  `overall_score_method` varchar(60) DEFAULT NULL
    COMMENT 'Stable identity of the scoring method that produced overall_score, e.g. call-audit-scoring/1.0.0',
  `kserve_reported_outcome` varchar(120) DEFAULT NULL
    COMMENT 'Label KServe reported for the same call, for comparison',
  `kserve_comparison_label` varchar(60) DEFAULT NULL
    COMMENT 'match, mismatch, or not_comparable',
  `mismatch_severity` varchar(30) DEFAULT NULL
    COMMENT 'none, low, medium, or high',
  `management_feedback` varchar(2000) DEFAULT NULL
    COMMENT 'Sanitized management-facing note; no PII, URL, or transcript text',
  `kserve_feedback` varchar(2000) DEFAULT NULL
    COMMENT 'Sanitized vendor-facing note; no PII, URL, or transcript text',
  `improvement_feedback` varchar(2000) DEFAULT NULL
    COMMENT 'Sanitized coaching note; same no-PII, no-URL, no-transcript contract as the other two feedback columns',
  `issue_flags_json` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin
    DEFAULT NULL
    COMMENT 'JSON array of APPROVED CODED issue flags only, never prose. NULL for operational-only or failed results',
  `result_json` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin
    DEFAULT NULL
    COMMENT 'Structured result; coded fields and hashes only, no raw transcript',
  `result_sha256` char(64) DEFAULT NULL
    COMMENT 'SHA-256 of the canonical result_json',
  `error_code` varchar(80) DEFAULT NULL,
  `error_detail` varchar(500) DEFAULT NULL
    COMMENT 'Sanitized failure detail; never echoes source content',
  `idempotency_key` varchar(191) NOT NULL
    COMMENT 'One result per run + source ref + contract; makes retries safe',
  `audited_at` datetime(6) DEFAULT NULL,
  `created_at` datetime(6) NOT NULL DEFAULT current_timestamp(6),
  `updated_at` datetime(6) DEFAULT NULL ON UPDATE current_timestamp(6),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_call_audit_result_idempotency` (`idempotency_key`),
  -- Parent key for the composite usage FK. A usage event references the whole
  -- (result, run, rule) triple at once, so a denormalized run_id or
  -- rule_version_id that disagrees with the result cannot be inserted.
  UNIQUE KEY `uq_call_audit_result_provenance`
    (`id`, `run_id`, `rule_version_id`),
  KEY `idx_call_audit_result_run` (`run_id`, `processing_status`),
  KEY `idx_call_audit_result_report`
    (`run_id`, `eligibility`, `intent`, `grouped_outcome`),
  KEY `idx_call_audit_result_mismatch`
    (`run_id`, `kserve_comparison_label`, `mismatch_severity`),
  KEY `idx_call_audit_result_history` (`source_ref_id`, `created_at`),
  -- Supporting index for the composite FK to the run's exact rule version.
  KEY `fk_call_audit_result_run_rule` (`run_id`, `rule_version_id`),
  -- Kept for "every result under rule X" reporting, which the composite key
  -- cannot serve because rule_version_id is not its leading column.
  KEY `idx_call_audit_result_rule_version` (`rule_version_id`),
  CONSTRAINT `chk_call_audit_result_status`
    CHECK (`processing_status` IN (
      'pending', 'succeeded', 'failed', 'skipped'
    )),
  CONSTRAINT `chk_call_audit_result_eligibility`
    CHECK (`eligibility` IN ('content_auditable', 'operational_only')),
  CONSTRAINT `chk_call_audit_result_intent`
    CHECK (`intent` IS NULL OR `intent` IN ('HIGH', 'WARM', 'LOW', 'NONE')),
  CONSTRAINT `chk_call_audit_result_call_connected`
    CHECK (`call_connected` IS NULL OR `call_connected` IN (0, 1)),
  CONSTRAINT `chk_call_audit_result_customer_spoke`
    CHECK (`customer_spoke` IS NULL OR `customer_spoke` IN (0, 1)),
  CONSTRAINT `chk_call_audit_result_meaningful`
    CHECK (
      `meaningful_conversation` IS NULL
      OR `meaningful_conversation` IN (0, 1)
    ),
  CONSTRAINT `chk_call_audit_result_qualification`
    CHECK (
      `qualification_label` IS NULL
      OR `qualification_label` IN (
        'QUALIFIED', 'NON_QUALIFIED', 'UNCERTAIN', 'NOT_APPLICABLE'
      )
    ),
  CONSTRAINT `chk_call_audit_result_next_action`
    CHECK (
      `next_action_code` IS NULL
      OR `next_action_code` IN (
        'NONE', 'CALLBACK', 'SEND_DETAILS_EMAIL', 'ASSIGN_TO_MR',
        'EXPERT_FOLLOWUP', 'DOCTOR_CONSULTATION', 'SCHEDULE_BOOKING',
        'DO_NOT_CALL', 'REVERIFY', 'TECHNICAL_RETRY', 'LANGUAGE_CALLBACK',
        'OTHER'
      )
    ),
  CONSTRAINT `chk_call_audit_result_comparison`
    CHECK (
      `kserve_comparison_label` IS NULL
      OR `kserve_comparison_label` IN ('match', 'mismatch', 'not_comparable')
    ),
  CONSTRAINT `chk_call_audit_result_mismatch_severity`
    CHECK (
      `mismatch_severity` IS NULL
      OR `mismatch_severity` IN ('none', 'low', 'medium', 'high')
    ),
  CONSTRAINT `chk_call_audit_result_overall_score_range`
    CHECK (
      `overall_score` IS NULL
      OR (`overall_score` >= 0.000 AND `overall_score` <= 100.000)
    ),
  -- Intra-row integrity. These pin only facts that are safe at every point in
  -- the pending -> terminal lifecycle: a pending or failed row simply leaves
  -- the optional values NULL and satisfies all of them.
  --
  -- A score with no method identity is unreproducible, and a method with no
  -- score is a claim about nothing.
  CONSTRAINT `chk_call_audit_result_score_pairing`
    CHECK (
      (`overall_score` IS NULL AND `overall_score_method` IS NULL)
      OR (`overall_score` IS NOT NULL AND `overall_score_method` IS NOT NULL)
    ),
  -- A structured result with no hash cannot be verified, and a hash with no
  -- payload verifies nothing.
  CONSTRAINT `chk_call_audit_result_json_pairing`
    CHECK (
      (`result_json` IS NULL AND `result_sha256` IS NULL)
      OR (`result_json` IS NOT NULL AND `result_sha256` IS NOT NULL)
    ),
  -- A call that never connected cannot have carried customer speech. NULL on
  -- either side leaves the comparison unknown, so the check passes and an
  -- undetermined fact is never forced.
  CONSTRAINT `chk_call_audit_result_speech_requires_connection`
    CHECK (NOT (`call_connected` = 0 AND `customer_spoke` = 1)),
  -- No speech means no exchange to call meaningful.
  CONSTRAINT `chk_call_audit_result_conversation_requires_speech`
    CHECK (NOT (`customer_spoke` = 0 AND `meaningful_conversation` = 1)),
  -- An operational-only call has no transcript to assess, so it is never
  -- scored. Absent is not zero.
  CONSTRAINT `chk_call_audit_result_operational_unscored`
    CHECK (
      NOT (
        `eligibility` = 'operational_only'
        AND (
          `overall_score` IS NOT NULL
          OR `overall_score_method` IS NOT NULL
        )
      )
    ),
  CONSTRAINT `chk_call_audit_result_ineligibility_reason`
    CHECK (
      `ineligibility_reason` IS NULL
      OR `ineligibility_reason` = 'missing_transcript'
    ),
  CONSTRAINT `chk_call_audit_result_issue_flags_json`
    CHECK (`issue_flags_json` IS NULL OR json_valid(`issue_flags_json`)),
  CONSTRAINT `chk_call_audit_result_json`
    CHECK (`result_json` IS NULL OR json_valid(`result_json`))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
  COMMENT='APPEND-ONLY history. A row may move pending -> exactly one terminal state (succeeded, failed, or skipped) within its run, and is IMMUTABLE once terminal. A correction or re-audit is a NEW run and a NEW row, never a rewrite';

-- ---------------------------------------------------------------------------
-- 5. Metric scores — one row per result + metric.
-- ---------------------------------------------------------------------------
CREATE TABLE `kaudit_call_audit_metric_score` (
  `id` varchar(40) NOT NULL,
  `result_id` varchar(40) NOT NULL,
  `metric_code` varchar(60) NOT NULL
    COMMENT 'Metric identity from the rule version taxonomy',
  `score_value` tinyint unsigned DEFAULT NULL
    COMMENT 'Integer 1-5. NULL ONLY when is_not_applicable = 1; 0 is never valid',
  `is_not_applicable` tinyint(1) NOT NULL DEFAULT 0
    COMMENT 'Explicit NA. NA is a distinct state and is never stored as score 0',
  -- Deliberately no per-metric rationale or confidence column. The approved
  -- output contract produces neither, so a nullable prose column here would be
  -- a permanently empty field that invites an unsanitized transcript quote. A
  -- future versioned schema that genuinely produces them can add them then.
  `created_at` datetime(6) NOT NULL DEFAULT current_timestamp(6),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_call_audit_metric_score_result_metric`
    (`result_id`, `metric_code`),
  KEY `idx_call_audit_metric_score_code` (`metric_code`, `score_value`),
  CONSTRAINT `chk_call_audit_metric_score_na`
    CHECK (
      (`is_not_applicable` = 1 AND `score_value` IS NULL)
      OR (`is_not_applicable` = 0 AND `score_value` BETWEEN 1 AND 5)
    )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
  COMMENT='Append-only alongside its result; one row per result and metric code';

-- ---------------------------------------------------------------------------
-- 6. AI usage events — append-only ledger of EVERY model request attempt.
-- ---------------------------------------------------------------------------
-- One row per attempt, including retries, refusals, and failures. A ledger that
-- recorded only successful audits would under-report spend and hide reliability
-- problems, so the unit here is the ATTEMPT, not the audit.
--
-- Privacy: token counts, timings, and identifiers only. No prompt, transcript,
-- raw response, refusal text, error payload, or customer content — an error is
-- a safe code, never a message body.
--
-- Money: this table stores NO cost. Spend is derived later by multiplying these
-- counts against a deterministic application price table.
-- An LLM never decides money, and neither does this schema.
CREATE TABLE `kaudit_call_audit_usage_event` (
  `id` varchar(40) NOT NULL,
  `result_id` varchar(40) NOT NULL,
  `run_id` varchar(40) NOT NULL
    COMMENT 'Denormalized for run-level cost reporting without joining results',
  `rule_version_id` varchar(40) NOT NULL
    COMMENT 'Contract the attempt was made under; pins model/prompt provenance',
  `attempt_number` int NOT NULL
    COMMENT 'Attempt ordinal within the result, starting at 1; retries increment it',
  `attempt_outcome` varchar(20) NOT NULL
    COMMENT 'succeeded, refused, or failed. A refusal and a failure still cost money and are still recorded',
  `provider_name` varchar(80) NOT NULL,
  `model_name` varchar(100) NOT NULL,
  `model_version` varchar(100) NOT NULL,
  `input_tokens` bigint DEFAULT NULL,
  `output_tokens` bigint DEFAULT NULL,
  `total_tokens` bigint DEFAULT NULL
    COMMENT 'As reported by the provider; never recomputed or estimated when absent',
  `request_id` varchar(120) DEFAULT NULL
    COMMENT 'Provider request identifier for support escalation; opaque, no content',
  `latency_ms` bigint DEFAULT NULL,
  `error_code` varchar(80) DEFAULT NULL
    COMMENT 'Safe coded reason for a refusal or failure; never an error message, payload, or model output',
  `recorded_at` datetime(6) NOT NULL
    COMMENT 'When the attempt completed, as observed by the worker',
  `created_at` datetime(6) NOT NULL DEFAULT current_timestamp(6),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_call_audit_usage_attempt` (`result_id`, `attempt_number`),
  KEY `idx_call_audit_usage_run_time` (`run_id`, `recorded_at`),
  KEY `idx_call_audit_usage_model_time`
    (`provider_name`, `model_name`, `recorded_at`),
  KEY `idx_call_audit_usage_outcome` (`attempt_outcome`, `recorded_at`),
  -- Supporting index for the composite FK onto the result's exact provenance.
  KEY `fk_call_audit_usage_provenance`
    (`result_id`, `run_id`, `rule_version_id`),
  -- Kept for "spend under rule X" reporting; rule_version_id does not lead the
  -- composite key.
  KEY `idx_call_audit_usage_rule_version` (`rule_version_id`, `recorded_at`),
  CONSTRAINT `chk_call_audit_usage_attempt_number`
    CHECK (`attempt_number` >= 1),
  CONSTRAINT `chk_call_audit_usage_outcome`
    CHECK (`attempt_outcome` IN ('succeeded', 'refused', 'failed')),
  CONSTRAINT `chk_call_audit_usage_input_tokens`
    CHECK (`input_tokens` IS NULL OR `input_tokens` >= 0),
  CONSTRAINT `chk_call_audit_usage_output_tokens`
    CHECK (`output_tokens` IS NULL OR `output_tokens` >= 0),
  CONSTRAINT `chk_call_audit_usage_total_tokens`
    CHECK (`total_tokens` IS NULL OR `total_tokens` >= 0),
  CONSTRAINT `chk_call_audit_usage_latency`
    CHECK (`latency_ms` IS NULL OR `latency_ms` >= 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
  COMMENT='APPEND-ONLY attempt ledger covering every model request, including retries, refusals, and failures. No prompt, response, or cost is stored here';

-- ---------------------------------------------------------------------------
-- Collation alignment.
-- ---------------------------------------------------------------------------
-- Existing installations differ between utf8mb4_general_ci and
-- utf8mb4_0900_ai_ci. These six tables have no foreign key to any pre-existing
-- table, but reports join them against `kaudit_*` rows, so inherit the
-- installation collation instead of assuming one.
SET @kaudit_parent_collation = (
  SELECT `COLLATION_NAME`
  FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'kaudit_call'
    AND COLUMN_NAME = 'id'
);
SET @kaudit_convert_rule_version_sql = CONCAT(
  'ALTER TABLE `kaudit_call_audit_rule_version` ',
  'CONVERT TO CHARACTER SET utf8mb4 COLLATE ', @kaudit_parent_collation
);
PREPARE kaudit_convert_rule_version FROM @kaudit_convert_rule_version_sql;
EXECUTE kaudit_convert_rule_version;
DEALLOCATE PREPARE kaudit_convert_rule_version;

SET @kaudit_convert_run_sql = CONCAT(
  'ALTER TABLE `kaudit_call_audit_run` ',
  'CONVERT TO CHARACTER SET utf8mb4 COLLATE ', @kaudit_parent_collation
);
PREPARE kaudit_convert_run FROM @kaudit_convert_run_sql;
EXECUTE kaudit_convert_run;
DEALLOCATE PREPARE kaudit_convert_run;

SET @kaudit_convert_source_ref_sql = CONCAT(
  'ALTER TABLE `kaudit_call_audit_source_ref` ',
  'CONVERT TO CHARACTER SET utf8mb4 COLLATE ', @kaudit_parent_collation
);
PREPARE kaudit_convert_source_ref FROM @kaudit_convert_source_ref_sql;
EXECUTE kaudit_convert_source_ref;
DEALLOCATE PREPARE kaudit_convert_source_ref;

SET @kaudit_convert_result_sql = CONCAT(
  'ALTER TABLE `kaudit_call_audit_result` ',
  'CONVERT TO CHARACTER SET utf8mb4 COLLATE ', @kaudit_parent_collation
);
PREPARE kaudit_convert_result FROM @kaudit_convert_result_sql;
EXECUTE kaudit_convert_result;
DEALLOCATE PREPARE kaudit_convert_result;

SET @kaudit_convert_metric_score_sql = CONCAT(
  'ALTER TABLE `kaudit_call_audit_metric_score` ',
  'CONVERT TO CHARACTER SET utf8mb4 COLLATE ', @kaudit_parent_collation
);
PREPARE kaudit_convert_metric_score FROM @kaudit_convert_metric_score_sql;
EXECUTE kaudit_convert_metric_score;
DEALLOCATE PREPARE kaudit_convert_metric_score;

SET @kaudit_convert_usage_event_sql = CONCAT(
  'ALTER TABLE `kaudit_call_audit_usage_event` ',
  'CONVERT TO CHARACTER SET utf8mb4 COLLATE ', @kaudit_parent_collation
);
PREPARE kaudit_convert_usage_event FROM @kaudit_convert_usage_event_sql;
EXECUTE kaudit_convert_usage_event;
DEALLOCATE PREPARE kaudit_convert_usage_event;

-- CONVERT TO CHARACTER SET rewrites every string column, so restore the
-- byte-exact collation the canonical JSON columns require.
ALTER TABLE `kaudit_call_audit_rule_version`
  MODIFY COLUMN `scoring_config_json` longtext
    CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL
    COMMENT 'Canonical locked configuration: schema, taxonomy, rubric weights, NA policy, and contract versions. Hashed into config_sha256; never contains the editable prompt';

ALTER TABLE `kaudit_call_audit_result`
  MODIFY COLUMN `result_json` longtext
    CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL
    COMMENT 'Structured result; coded fields and hashes only, no raw transcript',
  MODIFY COLUMN `issue_flags_json` longtext
    CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL
    COMMENT 'JSON array of APPROVED CODED issue flags only, never prose. NULL for operational-only or failed results';

-- ---------------------------------------------------------------------------
-- Foreign keys — among these six tables only.
-- ---------------------------------------------------------------------------
-- Provenance is enforced COMPOSITELY, not column by column. Separate single
-- column keys would prove only that each id exists somewhere, allowing a
-- result to name run A while claiming rule B, or a usage event to name result A
-- while denormalizing run B and rule C. Every foreign key below therefore
-- references a whole tuple, and the redundant single-column parents are
-- deliberately omitted because the composite chain already implies them:
--
--   usage(result_id, run_id, rule_version_id)
--     -> result(id, run_id, rule_version_id)
--        -> run(id, rule_version_id)
--           -> rule_version(id)
--
-- so a usage row's run and rule are, transitively, exactly its result's.
ALTER TABLE `kaudit_call_audit_run`
  ADD CONSTRAINT `fk_call_audit_run_rule_version`
    FOREIGN KEY (`rule_version_id`)
    REFERENCES `kaudit_call_audit_rule_version` (`id`);

-- A result is pinned to its run AND that run's exact rule version in one
-- constraint. There is deliberately NO separate result -> run or
-- result -> rule_version foreign key: either alone would re-admit the
-- mismatch this composite key exists to forbid.
ALTER TABLE `kaudit_call_audit_result`
  ADD CONSTRAINT `fk_call_audit_result_run_rule`
    FOREIGN KEY (`run_id`, `rule_version_id`)
    REFERENCES `kaudit_call_audit_run` (`id`, `rule_version_id`),
  ADD CONSTRAINT `fk_call_audit_result_source_ref`
    FOREIGN KEY (`source_ref_id`)
    REFERENCES `kaudit_call_audit_source_ref` (`id`);

ALTER TABLE `kaudit_call_audit_metric_score`
  ADD CONSTRAINT `fk_call_audit_metric_score_result`
    FOREIGN KEY (`result_id`) REFERENCES `kaudit_call_audit_result` (`id`);

-- A usage event is pinned to the whole (result, run, rule) triple, so its
-- denormalized run_id and rule_version_id can only ever equal the result's.
-- Again, no separate usage -> result, usage -> run, or usage -> rule_version
-- key: each would be satisfied by a mismatched triple.
ALTER TABLE `kaudit_call_audit_usage_event`
  ADD CONSTRAINT `fk_call_audit_usage_provenance`
    FOREIGN KEY (`result_id`, `run_id`, `rule_version_id`)
    REFERENCES `kaudit_call_audit_result` (`id`, `run_id`, `rule_version_id`);

-- VERIFY (read-only):
--   SHOW CREATE TABLE kaudit_call_audit_rule_version;
--   SHOW CREATE TABLE kaudit_call_audit_run;
--   SHOW CREATE TABLE kaudit_call_audit_source_ref;
--   SHOW CREATE TABLE kaudit_call_audit_result;
--   SHOW CREATE TABLE kaudit_call_audit_metric_score;
--   SHOW CREATE TABLE kaudit_call_audit_usage_event;
--
--   -- expect 6
--   SELECT COUNT(*) FROM information_schema.TABLES
--   WHERE TABLE_SCHEMA = DATABASE()
--     AND TABLE_NAME LIKE 'kaudit\\_call\\_audit\\_%';
--
--   -- expect 0 rows: nothing here references the external source table
--   SELECT CONSTRAINT_NAME
--   FROM information_schema.REFERENTIAL_CONSTRAINTS
--   WHERE CONSTRAINT_SCHEMA = DATABASE()
--     AND REFERENCED_TABLE_NAME = 'ai_voice_leads_received';
--
--   -- expect the composite provenance keys, 2 and 3 columns respectively
--   SELECT CONSTRAINT_NAME, COUNT(*) AS column_count
--   FROM information_schema.KEY_COLUMN_USAGE
--   WHERE CONSTRAINT_SCHEMA = DATABASE()
--     AND CONSTRAINT_NAME IN (
--       'fk_call_audit_result_run_rule', 'fk_call_audit_usage_provenance'
--     )
--   GROUP BY CONSTRAINT_NAME;
--
-- Forward-fix policy:
--   Once audit rows exist, do not drop these tables or columns and do not
--   rewrite result, usage, or source-reference history. A correction is a new
--   rule version and a new run; a changed source row is a new source revision;
--   a retried model call is a new usage-event attempt, never an edited one.
--   Never delete usage events to make a cost report look better.
--   Never UPDATE a source reference in place — that is why it has no
--   updated_at. Never add lead_id, client name, mobile, email, transcription
--   URL, transcript, customer context, notes, summary, or any other source
--   free-text column to kaudit_call_audit_source_ref; the anonymous design
--   forbids them.
-- ============================================================================
