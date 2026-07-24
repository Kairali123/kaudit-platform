# Decisions needed

Only unresolved decisions that affect the new standalone platform are listed here.

| ID | Decision | Owner | Release effect |
|---|---|---|---|
| D-03 | Approve and publish the validated rate card; existing calculations remain provisional | Finance/Procurement + independent approver | Blocks authoritative billing/revenue |
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
