# Grant 3 — April 2026 test-cycle preview

## Purpose and authority

Grant 3 validates the monthly cycle with ten April 2026 test calls without
running the full May dataset.

The ten calls resolve as:

- five recording-backed calls with completed AI audits and
  leadership-approved automated consensus;
- five calls with no recording supplied by KServe. At cycle close they are
  explicitly recorded as `accepted_as_billed_unverified`, using KServe's source
  minutes without implying that AI listened to them.

The separate April-only test rate card is published for this bounded test. It
does not approve or alter the production draft rate card.

All five recording-backed calls passed the automated ensemble. Their findings
were system-confirmed with audit-log entries, and their final traced
calculations total ₹19.00. The April dashboard therefore shows the billing
cycle as `Ready`.

## Safety controls

- `KAUDIT_CYCLE_CLOSE_MODE` defaults to `DRY-RUN`.
- A cycle-close execute run requires a specific month and published rate-card
  ID.
- Every fallback calculation stores an input hash, ruleset hash, decision-trace
  hash, timestamp, and deterministic non-AI decision identity.
- `KAUDIT_REPORT_PERSIST_PREVIEW` defaults to `false`.
- Preview outputs are labeled
  `PROVISIONAL_UNCALIBRATED_TEST_ONLY`.
- The PDF is watermarked `NOT FOR VENDOR DISPUTE`.
- No destination number, recording URL, transcript, audio, or health content is
  included in the preview report.

The previously generated PDF/JSON files remain historical provisional preview
artifacts. They are not silently relabeled after the authority policy changes.

## Commands

Dry-run the no-recording fallback:

```bash
KAUDIT_CYCLE_CLOSE_MODE=DRY-RUN \
  KAUDIT_CYCLE_CLOSE_MONTH=2026-04 \
  KAUDIT_CYCLE_CLOSE_RATE_CARD_ID=rcv-apr26-test-v1 \
  npm run billing:cycle-close
```

Execute only after reviewing the dry-run:

```bash
KAUDIT_CYCLE_CLOSE_MODE=EXECUTE \
  KAUDIT_CYCLE_CLOSE_MONTH=2026-04 \
  KAUDIT_CYCLE_CLOSE_RATE_CARD_ID=rcv-apr26-test-v1 \
  npm run billing:cycle-close
```

Generate the provisional JSON calculation package:

```bash
KAUDIT_REPORT_MONTH=2026-04 \
  KAUDIT_REPORT_OUTPUT="$HOME/.kcrm-audit/test-runs/april-2026-10-call" \
  npm run report:preview
```

Persisting the provisional reconciliation is a separate, explicit option:

```bash
KAUDIT_REPORT_MONTH=2026-04 \
  KAUDIT_REPORT_PERSIST_PREVIEW=true \
  KAUDIT_REPORT_RATE_CARD_ID=rcv-apr26-test-v1 \
  KAUDIT_REPORT_CREATED_BY=dme@kairali.com \
  npm run report:preview
```

## Current April result

The current bounded run contains ten calls:

- independently AI-audited: 5;
- accepted as billed without recording: 5;
- vendor subtotal: ₹52.25;
- automated-consensus verified subtotal: ₹19.00;
- identified potential overbilling variance: ₹33.25.

The live dashboard treats the bounded April billing calculation as ready under
the explicitly approved automated-validation policy. The persisted
reconciliation remains `test_preview`, so the ₹33.25 is identified variance,
not recovered savings or a closed dispute.
