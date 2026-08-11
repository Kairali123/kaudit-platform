# Administrator access

> Compatibility note (2026-07-27): `max_sensitivity_tier` remains in the
> existing schema and older grant workflow, but it is no longer used to decide
> whether calls may be audited, billed, or reported. Admin authorization is
> role-based.

The application has two operational roles: `admin` and `user`. `admin` is the
full-access role. Health-sensitive content is controlled separately by
`kaudit_user.max_sensitivity_tier`; the highest viewable tier is `K3`. `K4`
payment/authentication content is never viewable.

The application does not store plaintext passwords. Production authentication must be
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

## Bind an administrator to their OIDC identity

Production login matches the token's `iss` and `sub` against `kaudit_user`. Until
that pair is bound, a validated token resolves to nobody and the request is
refused as `USER_NOT_PROVISIONED`. Nothing binds an identity automatically: the
application never matches an email at sign-in, because an address is not proof of
account ownership.

`npm run w1:bind-oidc` is the explicit, audited, one-shot way to set that pair on
a user that already exists. It is authorization plumbing only. It does not create
a user, activate or disable one, grant or revoke a role, change the sensitivity
ceiling, or touch the display name or email. Run the grant command above first;
this command refuses a missing user rather than provisioning one.

### Obtaining the subject — never guess it

`sub` is an opaque provider-assigned identifier. For Google Workspace it is a
numeric string that is **not** derived from the email address, and it must never
be guessed, invented, or reconstructed from one: a wrong value either matches no
one or permanently binds the account to whichever identity really owns that
subject. Get it from one of:

- the `sub` claim of a **validated** Google ID token for that person — validate
  it (signature, issuer, audience, expiry) and read the claim in the identity
  workflow; or
- Google Workspace identity administration, which lists the account's unique ID.

Handle the token as a credential. Do not paste one into a shell command, a
terminal, a log, a ticket, a chat, or any file in this repository, and do not
echo it to capture the claim. Only the resulting `sub` value is configuration.

### Running it

Idempotent, and dry-run by default.

The email, issuer, and subject identify a person. Do not put them on the command
line: a shell records every command in its history file, and arguments and the
environment of a running command are readable from the process table, so an
inline value outlives the run in at least two places nobody audits. Put all three
in this repository's ignored `.env.local` (or `.env`) instead — both are listed
in `.gitignore`, both must stay mode `0600`, and neither is ever committed:

```dotenv
KAUDIT_OIDC_BIND_EMAIL=
KAUDIT_OIDC_BIND_ISSUER=
KAUDIT_OIDC_BIND_SUBJECT=
```

Fill in the three values in an editor. The script loads only those two files
from this repository — nothing from a home directory or another checkout — so
what you put there is what the command sees. Then run the dry-run with no
identity value on the command line at all:

```bash
npm run w1:bind-oidc
```

Review the printed decision, then arm the write with the exact word `EXECUTE`.
The gate is a consent flag, not an identity, so it is fine inline — or set it in
the same ignored file and delete the line immediately afterwards:

```bash
KAUDIT_OIDC_BIND_MODE=EXECUTE npm run w1:bind-oidc
```

Remove the three identity values from the file once the binding is confirmed;
they are needed for the run, not afterwards.

The issuer is stored exactly as supplied, because login compares it byte for
byte — copy it from the `iss` claim, including or excluding a trailing slash
exactly as the provider sends it. For the same reason it must equal this
deployment's configured `KAUDIT_OIDC_ISSUER` exactly: the command stops with
`OIDC_BIND_ISSUER_MISMATCH`, before it connects to anything, if the two differ or
if this run is not configured for OIDC authentication. It is never filled in
from configuration — stating it is how the mismatch becomes visible here rather
than at somebody's sign-in.

Both modes take the same row locks in one transaction; the dry-run rolls back.
Output is a single JSON line of enums, booleans, and bounded codes: it carries no
email, issuer, subject, user id, or database message, so it is safe to paste into
a ticket. Exit status is `0` for a binding or an already-bound no-op and `1` for
a refusal or a fault.

### What it refuses

| Reported code | Meaning |
| --- | --- |
| `OIDC_BIND_USER_NOT_FOUND` | No `kaudit_user` has that email. Provision first. |
| `OIDC_BIND_USER_NOT_BINDABLE` | The row is a system actor, not a person. |
| `OIDC_BIND_USER_ALREADY_BOUND` | The user already carries a different binding, including a half-set pair. Rebinding is a separate reviewed operation. |
| `OIDC_BIND_IDENTITY_TAKEN` | That issuer+subject already belongs to another user. |
| `OIDC_BIND_UPDATE_GUARD_FAILED` | State changed under the lock; nothing was written. Re-run and re-read. |
| `OIDC_BIND_SUBJECT_LOOKS_DERIVED` | The subject looks like the email address. Read the real `sub` from a validated token. |

Re-running the identical binding reports `no-op` and writes nothing.

On execution the binding and an `identity_provisioning` audit event are written
in the same transaction, so a binding that cannot be audited is not made. The
event records the bound user as the resource and a hash of the issuer+subject
pair — never the raw email, issuer, or subject. Its actor columns are null on
purpose: the bound user has not signed in and is not necessarily the operator, so
the row names the command that made the change rather than claiming an author it
cannot know. When migration 0004 is present it joins the hash chain; before 0004
it uses the legacy audit columns.

Binding alone grants nothing. The summary reports whether the account is active
and whether it holds any role, because a bound account that is disabled or
role-less still cannot do anything — fix that with the grant command above.

## Local loopback access

Local mode is for development on this computer only:

```dotenv
KAUDIT_AUTH_MODE=local
KAUDIT_DEV_USER_EMAIL=person@kairali.com
KAUDIT_LOCAL_PASSWORD_HASH=scrypt$<salt>$<digest>
KAUDIT_LOCAL_SESSION_SECRET=<at-least-32-random-characters>
KAUDIT_LOCAL_SESSION_COOKIE=kaudit_local_session
KAUDIT_LOCAL_SESSION_TTL_SEC=28800
```

The ignored `.env.local` holds the local identity, one-way password hash, and
random session secret while database credentials remain in `.env`. It must stay
mode `0600` and must never be committed. Run `npm run app:start`. Local mode is
rejected on non-loopback hosts and in production. Do not expose it over a
network; production requires OIDC with MFA.
