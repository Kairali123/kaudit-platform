# Administrator access

> Compatibility note (2026-07-27): `max_sensitivity_tier` remains in the
> existing schema and older grant workflow, but it is no longer used to decide
> whether calls may be audited, billed, or reported. Admin authorization is
> role-based.

The application has two operational roles: `admin` and `user`. `admin` is the
full-access role. Health-sensitive content is controlled separately by
`kaudit_user.max_sensitivity_tier`; the highest viewable tier is `K3`. `K4`
payment/authentication content is never viewable.

The application does not store passwords. Production authentication must be
provided by the approved Kairali OIDC identity provider with MFA. The
administrator's OIDC issuer and subject must be bound to the pre-provisioned
`kaudit_user` before production login.

## Provision or repair an administrator

The command is idempotent and defaults to dry-run:

```bash
KAUDIT_ADMIN_EMAIL=person@kairali.com npm run w1:grant-admin
```

Review the plan, then explicitly execute:

```bash
KAUDIT_ADMIN_MODE=EXECUTE \
KAUDIT_ADMIN_EMAIL=person@kairali.com \
npm run w1:grant-admin
```

Execution creates or activates the user, grants `admin`, sets the sensitivity
ceiling to `K3`, and records before/after access-state hashes in
`kaudit_audit_log`. When migration 0004 is present, the event is also included
in the hash chain; before 0004, it is written using the legacy audit columns.

## Local loopback access

Local mode is for development on this computer only:

```dotenv
KAUDIT_AUTH_MODE=local
KAUDIT_DEV_USER_EMAIL=person@kairali.com
```

The ignored `.env.local` may hold these non-secret local identity settings while
database credentials remain in `.env`. Run `npm run app:start`. Local mode never
accepts a password and is rejected on non-loopback hosts or in production. Do
not expose it over a network.
