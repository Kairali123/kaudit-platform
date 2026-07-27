# Full-call re-audit runbook

## Verified production state

Read-only preflight on 2026-07-27:

- calls: 43,245;
- recording URLs: 16,371;
- no recording URL: 26,874;
- completed classifications: 224;
- rows with a conversation-end timestamp: 96;
- recording rows with a baseline SHA-256: 0;
- legacy billing rows: 43,245 totalling INR 212,244.25;
- rate card: draft, with no approver or approval time;
- migration 0006: not applied;
- legacy sensitivity values exist but no longer control automation authority.

The 26,874 calls without recordings cannot be described as independently
AI-audited. At cycle close, the locked business fallback is accepted-as-billed
and explicitly unverified; it must not be merged into the independently verified
population.

## Safe sample

`reaudit:sample` is a read-only shadow runner. It fetches recording bytes through
the configured proxy, hashes them, transcribes with `whisper-1`, classifies with
the pinned `gpt-4o-mini-2024-07-18` snapshot, applies the deterministic 60-second
wrap-up grace and billing rounding, and prints aggregate results only.

It writes no recording, transcript, finding, decision, or bill to MySQL.

```bash
KAUDIT_REAUDIT_LIMIT=5 npm run reaudit:sample
```

The initial real sample completed 5/5 with no processing errors. Its output is
not a calibration result and is not authoritative.

## Persistent audit worker

This worker belongs entirely to `kaudit-platform`. It reads only shared MySQL
`kaudit_*` rows and `kaudit_call_artifact.source_url`; it never reads the KCRM
folder.

Run a bounded first batch:

```bash
KAUDIT_AUDIT_MODE=EXECUTE KAUDIT_AUDIT_BATCH=10 \
  KAUDIT_AUDIT_WATCH=false npm run audit:worker
```

After inspecting `/audits`, keep it running for new/due calls:

```bash
KAUDIT_AUDIT_MODE=EXECUTE KAUDIT_AUDIT_BATCH=10 \
  KAUDIT_AUDIT_WATCH=true npm run audit:worker
```

The candidate query excludes every already-audited call, including the 224
legacy results. Success persists the evidence hash, Whisper and classifier
model/version, classifier ruleset hash/version, confidence, timestamp,
transcript segments, media metrics, finding, and completed audit run. Failures
receive bounded exponential retries; altered evidence and unsafe URLs are
terminal visible findings. A MySQL advisory lock prevents two full workers from
running concurrently.

## Full-run gates

Do not launch a full paid run until all of the following are true:

1. Audit persistence requires migrations 0002 and 0005. Migration 0006 remains
   required before authoritative verified-billing decisions are written.
2. The resumable audit writer is implemented; verify it in staging before the
   full paid run.
3. A named finance approver publishes a new immutable rate-card version. Never
   convert the legacy draft card in place.
4. Per-language/per-finding calibration has produced approved thresholds.
5. The OpenAI spend and concurrency envelope is approved. The current URL-backed
   population has roughly 13,160 vendor-connected audio minutes; Whisper alone is
   approximately USD 79 at USD 0.006/minute, before classifier usage and before
   any recording-duration overage.

Until these gates clear, only a **provisional shadow projection** is permitted.
It must not supersede the 43,245 legacy calculations or be called an authoritative
invoice.
