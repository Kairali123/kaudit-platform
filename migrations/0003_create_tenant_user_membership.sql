-- ============================================================================
-- Migration 0003 — create kaudit_tenant / kaudit_user / kaudit_membership
-- ============================================================================
-- Purpose : establish the identity + multi-tenancy foundation that is entirely
--           missing today (W1 / D1). New tables only — nothing on existing tables
--           changes here. `tenant_id` columns on business tables come in a later,
--           separately-reviewed migration (0004/0005), after this + the identity
--           backfill are approved.
-- Type    : additive (CREATE TABLE). Safe; no impact on existing rows.
-- Seed    : after applying, seed ONE Kairali tenant and (via the identity backfill)
--           the user/membership rows resolved from existing authorship columns.
-- ============================================================================

CREATE TABLE IF NOT EXISTS `kaudit_tenant` (
  `id`               varchar(40)  NOT NULL,
  `name`             varchar(255) NOT NULL,
  `status`           varchar(20)  NOT NULL DEFAULT 'active',
  `default_timezone` varchar(60)  NOT NULL DEFAULT 'Asia/Kolkata',
  `default_currency` char(3)      NOT NULL DEFAULT 'INR',
  `data_region`      varchar(60)  NOT NULL DEFAULT 'ap-south-1',
  `created_at`       datetime(6)  NOT NULL DEFAULT current_timestamp(6),
  `updated_at`       datetime(6)  DEFAULT NULL ON UPDATE current_timestamp(6),
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS `kaudit_user` (
  `id`            varchar(40)  NOT NULL,
  `kind`          varchar(20)  NOT NULL DEFAULT 'user',      -- 'user' | 'system'
  `email`         varchar(255) DEFAULT NULL,                  -- real users (unique when set)
  `oidc_issuer`   varchar(255) DEFAULT NULL,                  -- set on first OIDC login;
  `oidc_subject`  varchar(255) DEFAULT NULL,                  -- system actors use ('system', name)
  `display_name`  varchar(255) DEFAULT NULL,
  `status`        varchar(20)  NOT NULL DEFAULT 'active',
  `last_login_at` datetime(6)  DEFAULT NULL,
  `created_at`    datetime(6)  NOT NULL DEFAULT current_timestamp(6),
  `updated_at`    datetime(6)  DEFAULT NULL ON UPDATE current_timestamp(6),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_user_email` (`email`),                       -- MySQL allows many NULLs
  UNIQUE KEY `uq_user_oidc` (`oidc_issuer`, `oidc_subject`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS `kaudit_membership` (
  `id`         varchar(40) NOT NULL,
  `tenant_id`  varchar(40) NOT NULL,
  `user_id`    varchar(40) NOT NULL,
  `role_code`  varchar(40) NOT NULL,
  `scope_json` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL CHECK (json_valid(`scope_json`)),
  `status`     varchar(20) NOT NULL DEFAULT 'active',
  `created_at` datetime(6) NOT NULL DEFAULT current_timestamp(6),
  `updated_at` datetime(6) DEFAULT NULL ON UPDATE current_timestamp(6),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_membership` (`tenant_id`, `user_id`, `role_code`),
  KEY `fk_membership_user` (`user_id`),
  CONSTRAINT `fk_membership_tenant` FOREIGN KEY (`tenant_id`) REFERENCES `kaudit_tenant` (`id`),
  CONSTRAINT `fk_membership_user`   FOREIGN KEY (`user_id`)   REFERENCES `kaudit_user` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- ---------------------------------------------------------------------------
-- DOWN (rollback) — drop in FK-safe order.
--   DROP TABLE IF EXISTS `kaudit_membership`;
--   DROP TABLE IF EXISTS `kaudit_user`;
--   DROP TABLE IF EXISTS `kaudit_tenant`;
-- ============================================================================
