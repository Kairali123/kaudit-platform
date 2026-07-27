# Decisions needed

Only unresolved decisions that affect the new standalone platform are listed here.

| ID | Decision | Owner | Release effect |
|---|---|---|---|
| D-07 | Name delegation adapter/system and approve its sandbox/security contract | Operations + Security | Blocks corrective-action delivery |
| D-10 | Approve retention, redaction, legal-hold, unredacted-access, and recording-notice policy | Privacy/Legal + Security | Blocks production evidence/content processing |
| D-11-K23 | Name the clinical/safety owner and sign the K2/K3 automation policy | Clinical/Safety leadership | Keeps K2/K3 automation inactive |
| D-12-A | Confirm fiscal/weekly boundaries, claim-source precedence, and trend dead-band | Finance/Ops | Blocks authoritative management snapshots |
| D-14 | Confirm OIDC provider/application, MFA policy, group owners, and identity-aware proxy pattern | Identity/Security | Blocks production login |
| D-15 | Approve India-region runtime, secret manager, MySQL TLS/backup, WAF, queue/DLQ, and security-log archive | Engineering/Security | Blocks deployment |
| D-16 | Confirm private GitHub organisation, CODEOWNERS identities, branch rules, and recovery owners | Technical owner + GitHub organisation owners | Blocks governed merge/release |

Resolved decisions remain recorded in the architecture package: keep the existing dataset,
OpenAI data flow accepted, vendor-hosted KServe URLs with hash verification, Kairali-only
single-company scope, and zero-human automation direction subject to calibration/K2-K3 gate.

## Resolved financial interpretation

D-03's business interpretation was locked on 2026-07-27:

- INR 4.75 flat for verified duration below 30 seconds;
- INR 9.50 per minute from exactly 30 seconds;
- whole-minute ceiling thereafter;
- 60 seconds of AI wrap-up grace after the final meaningful customer exchange; and
- one-way-tail alert only when the remaining tail is strictly greater than 60 seconds.

The existing draft database card has **not** been published or edited. A new immutable
version must be created with the locked ruleset hash, named finance approver, approval
timestamp, and reviewed effective period before any real calculation can finalize.
This is an approved implementation operation still awaiting supervised execution, not
an open contract-interpretation decision.
