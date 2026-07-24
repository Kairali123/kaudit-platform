import type { Pool } from 'mysql2/promise'
import type { IdentitySource } from '../identity/ports.ts'
import type { IdentityRef } from '../identity/buildUserSet.ts'

// The authorship / actor columns that hold identity strings today. Column names are
// code constants (no injection surface). Empty tables simply contribute nothing.
// Confirm this list against the live schema before EXECUTE (some tables may be absent
// or renamed). External-party columns (e.g. action_status_event.actor_external_id) are
// intentionally excluded — they are not Kairali users.
const SOURCES: { table: string; column: string }[] = [
  { table: 'kaudit_audit_log', column: 'actor_email' },
  { table: 'kaudit_review', column: 'reviewer_email' },
  { table: 'kaudit_review_event', column: 'actor_email' },
  { table: 'kaudit_campaign', column: 'owner_email' },
  { table: 'kaudit_rate_card_version', column: 'created_by' },
  { table: 'kaudit_rate_card_version', column: 'approved_by' },
  { table: 'kaudit_call_purpose_policy', column: 'approved_by' },
  { table: 'kaudit_review_policy_version', column: 'approved_by' },
  { table: 'kaudit_quality_flag_catalog_version', column: 'approved_by' },
  { table: 'kaudit_quality_flag_parameter', column: 'approved_by' },
  { table: 'kaudit_routing_policy_version', column: 'approved_by' },
  { table: 'kaudit_corrective_action', column: 'created_by' },
  { table: 'kaudit_corrective_action', column: 'approved_by' },
  { table: 'kaudit_adjustment', column: 'requested_by' },
  { table: 'kaudit_adjustment', column: 'approved_by' },
  { table: 'kaudit_reconciliation', column: 'created_by' },
  { table: 'kaudit_reconciliation', column: 'approved_by' },
  { table: 'kaudit_line_match', column: 'reviewed_by' },
  { table: 'kaudit_management_snapshot', column: 'prepared_by' },
  { table: 'kaudit_management_snapshot', column: 'approved_by' },
  { table: 'kaudit_action_verification', column: 'verified_by' },
  { table: 'kaudit_legal_hold', column: 'release_approved_by' },
  { table: 'kaudit_access_grant', column: 'grantee_email' },
  { table: 'kaudit_access_grant', column: 'approver_email' },
]

export function createMysqlIdentitySource(pool: Pool): IdentitySource {
  return {
    async collect(): Promise<IdentityRef[]> {
      const parts = SOURCES.map(
        (s) =>
          `SELECT '${s.table}.${s.column}' AS source, \`${s.column}\` AS raw
             FROM \`${s.table}\` WHERE \`${s.column}\` IS NOT NULL`,
      )
      const sql = parts.join('\nUNION ALL\n')
      const [rows] = await pool.query(sql)
      return (rows as any[]).map((r) => ({ source: r.source, raw: r.raw }))
    },
  }
}
