# Secure dashboard runbook

## Safe staging sequence

1. Review migrations `0003_create_user_and_roles.sql` and
   `0004_hash_chained_security_audit.sql`.
2. Back up and restore-test the staging database.
3. Apply 0003, run `w1:identity` in dry-run, inspect identities, then execute only after
   approval. Every seed remains `unassigned`.
4. Apply 0004. Verify the `primary` audit-chain head is the all-zero genesis value.
5. Bind one staging test identity to the approved OIDC issuer/subject and grant `user`.
6. Mount the MySQL CA and inject credentials/OIDC values through the secret manager.
7. Run `npm run ui:secure`; check `/health/live`, then `/health/ready`.
8. Verify anonymous, malformed-token, unassigned, disabled, and wrong-role requests fail.
9. Verify an assigned user can load the dashboard and that one chained
   `dashboard.read` event is created.
10. Validate that no response/browser/network log contains a token, source URL, call
    content, transcript, phone number, customer identity, health detail, or SQL error.

## Stop conditions

- Do not use `local` mode outside loopback or in production.
- Do not auto-bind a login by email or auto-grant a role.
- Do not apply either migration to the real database without a reviewed backup,
  maintenance/rollback plan, named data owner, and supervised approval.
- A failed audit sink makes protected dashboard requests fail closed; investigate the
  database/migration rather than bypassing logging.
