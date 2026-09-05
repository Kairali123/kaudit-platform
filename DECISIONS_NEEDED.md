# Decisions needed

Only unresolved decisions that affect the new standalone platform are listed here.

| ID | Decision | Owner | Release effect |
|---|---|---|---|
| D-03-B | Decide whether the vendor connected duration may cap the conversation-end projection, and on what time-origin normalization | Finance/Ops | Blocks any change to the locked duration ceiling |
| D-07 | Name delegation adapter/system and approve its sandbox/security contract | Operations + Security | Blocks corrective-action delivery |
| D-10 | Approve retention, redaction, legal-hold, unredacted-access, and recording-notice policy | Privacy/Legal + Security | Blocks production evidence/content processing, and gates `KAUDIT_RESTRICTED_EXPORT_ENABLED` |
| D-12-A | Confirm fiscal/weekly boundaries, claim-source precedence, and trend dead-band | Finance/Ops | Blocks authoritative management snapshots |
| D-14 | Confirm OIDC provider/application, MFA policy, group owners, and identity-aware proxy pattern | Identity/Security | Blocks production login |
| D-15 | Approve India-region runtime, secret manager, MySQL TLS/backup, WAF, queue/DLQ, and security-log archive | Engineering/Security | Blocks deployment |
| D-16 | Confirm private GitHub organisation, CODEOWNERS identities, branch rules, and recovery owners | Technical owner + GitHub organisation owners | Blocks governed merge/release |

Resolved decisions remain recorded in the architecture package: keep the existing dataset,
OpenAI data flow accepted, vendor-hosted KServe URLs with hash verification, Kairali-only
single-company scope, and zero-human automation. The former K2/K3-specific activation
gate was retired by leadership on 2026-07-27; calibration still applies to every language
and finding type.

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

## Open duration-ceiling question (D-03-B)

The Audit Monitor shows each audited call's vendor connected duration
(`duration_without_ringing_sec`) next to the grace-adjusted duration derived from the
model's conversation-end timestamp. The two can disagree, and not only because of the
wrap-up grace: they may not share a time origin. The vendor duration excludes ringing,
while the conversation-end timestamp is measured from the start of the decoded
recording, which can include ringing and pre-connect audio.

Finance must decide whether the connected duration may cap the conversation-end
projection, and only after an explicit, verified time-origin normalization rule is
approved. Until then the difference stays visible as non-monetary review metadata, no
ceiling is applied to it, and the locked 2026-07-27 interpretation is unchanged.

## D-10 and the restricted export

The platform can produce a per-call export containing call transcripts and
recording locations. The capability exists in code but is **deny-by-default**:
it is absent unless `KAUDIT_RESTRICTED_EXPORT_ENABLED` is set to exactly
`true`, and the route refuses before reading anything when it is not.

Setting that variable IS the D-10 decision being exercised, so it should not be
set until D-10 is resolved and the approver and date are recorded here. When it
is enabled the export remains bounded: administrator-only, a single bill month,
a row cap ordered by largest duration variance, filtered per call by the
downloader's own sensitivity ceiling using the same rule the per-call review
screen applies, and every download written to the access audit.

The separate vendor review pack (`monthly.pdf` / `monthly.csv`) carries no
transcript, no recording location and no customer text, and is unaffected by
this decision.
