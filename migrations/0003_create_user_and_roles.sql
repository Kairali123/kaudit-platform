-- ============================================================================
-- Migration 0003 — create kaudit_user + kaudit_user_role (single-company model)
-- ============================================================================
-- Purpose : identity + access foundation for a SINGLE company (Kairali). No tenants,
--           no tenant_id anywhere (multi-tenancy dropped). Two controls:
--             • roles (kaudit_user_role) → functional permissions
--             • kaudit_user.max_sensitivity_tier → health-content (K2/K3) access ceiling
-- Type    : additive (CREATE TABLE). No existing table changes; no tenant_id backfill.
-- ============================================================================

CREATE TABLE IF NOT EXISTS `kaudit_user` (
  `id`                   varchar(40)  NOT NULL,
  `kind`                 varchar(20)  NOT NULL DEFAULT 'user',   -- 'user' | 'system'
  `email`                varchar(255) DEFAULT NULL,               -- real users (unique when set)
  `oidc_issuer`          varchar(255) DEFAULT NULL,               -- set on first OIDC login;
  `oidc_subject`         varchar(255) DEFAULT NULL,               -- system actors use ('system', name)
  `display_name`         varchar(255) DEFAULT NULL,
  -- Health-content access ceiling. DENY-BY-DEFAULT: K1 (general PII) — K2/K3 require an
  -- explicit, audited clinical/privacy sign-off. K4 is never viewable by anyone.
  `max_sensitivity_tier` char(2)      NOT NULL DEFAULT 'K1',
  `status`               varchar(20)  NOT NULL DEFAULT 'active',
  `last_login_at`        datetime(6)  DEFAULT NULL,
  `created_at`           datetime(6)  NOT NULL DEFAULT current_timestamp(6),
  `updated_at`           datetime(6)  DEFAULT NULL ON UPDATE current_timestamp(6),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_user_email` (`email`),                           -- MySQL allows many NULLs
  UNIQUE KEY `uq_user_oidc` (`oidc_issuer`, `oidc_subject`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS `kaudit_user_role` (
  `id`         varchar(40) NOT NULL,
  `user_id`    varchar(40) NOT NULL,
  `role_code`  varchar(60) NOT NULL,
  `granted_by` varchar(255) DEFAULT NULL,
  `granted_at` datetime(6) NOT NULL DEFAULT current_timestamp(6),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_user_role` (`user_id`, `role_code`),
  CONSTRAINT `fk_user_role_user` FOREIGN KEY (`user_id`) REFERENCES `kaudit_user` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- ---------------------------------------------------------------------------
-- DOWN (rollback)
--   DROP TABLE IF EXISTS `kaudit_user_role`;
--   DROP TABLE IF EXISTS `kaudit_user`;
-- ============================================================================
