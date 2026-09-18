import fs from "node:fs/promises";
import { SpreadsheetFile, Workbook } from "@oai/artifact-tool";

const outputDir = "/Users/kritikakairali/Documents/ChatGPT/Kairali Auditor/outputs/bill-audit-workspace";
const outputPath = `${outputDir}/Kairali Bill Audit Workspace.xlsx`;

const COLORS = {
  navy: "#123044",
  teal: "#0F766E",
  tealLight: "#DFF3EF",
  blueLight: "#E8F1F8",
  goldLight: "#FFF3D6",
  redLight: "#FDE8E7",
  gray: "#64748B",
  grayLight: "#F4F6F8",
  border: "#D7DEE5",
  white: "#FFFFFF",
};

const POLICY = Object.freeze({
  classifierVersion: "kairali-12cat/2.9.0",
  billingRulesetVersion: "2026-07-27.1",
  categoryPolicyVersion: "management-category-charge/2026-09-16.1",
  validationVersion: "leadership-approved-auto-consensus/1.1.0",
  validationThreshold: 0.8,
  rate: 9.5,
});

const workbook = Workbook.create();
workbook.comments.setSelf({ displayName: "Satyam Kumar Kairali" });

const sheetNames = [
  "Start",
  "Settings",
  "Monthly Input",
  "Invoice Register",
  "AI Queue",
  "AI Results",
  "Billing Calculation",
  "Rules",
  "Prompts",
  "Knowledge Base",
  "Evidence Index",
  "Run Log",
  "Summary",
  "Automation",
];

const sheets = Object.fromEntries(sheetNames.map((name) => [name, workbook.worksheets.add(name)]));

function title(sheet, name, subtitle, endCol = "H") {
  sheet.showGridLines = false;
  sheet.getRange(`A1:${endCol}1`).merge();
  sheet.getRange("A1").values = [[name]];
  sheet.getRange(`A1:${endCol}1`).format = {
    fill: COLORS.navy,
    font: { name: "Arial", size: 16, bold: true, color: COLORS.white },
    verticalAlignment: "center",
  };
  sheet.getRange(`A2:${endCol}2`).merge();
  sheet.getRange("A2").values = [[subtitle]];
  sheet.getRange(`A2:${endCol}2`).format = {
    fill: COLORS.blueLight,
    font: { name: "Arial", size: 10, color: COLORS.navy },
    wrapText: true,
    verticalAlignment: "center",
  };
  sheet.getRange("1:1").format.rowHeight = 30;
  sheet.getRange("2:2").format.rowHeight = 38;
}

function header(sheet, range) {
  sheet.getRange(range).format = {
    fill: COLORS.teal,
    font: { name: "Arial", size: 10, bold: true, color: COLORS.white },
    wrapText: true,
    verticalAlignment: "center",
    borders: { preset: "all", style: "thin", color: COLORS.border },
  };
}

function body(sheet, range) {
  sheet.getRange(range).format = {
    font: { name: "Arial", size: 10, color: "#1F2937" },
    verticalAlignment: "top",
    borders: { preset: "all", style: "thin", color: COLORS.border },
  };
}

function setWidths(sheet, widths) {
  for (const [col, width] of Object.entries(widths)) {
    sheet.getRange(`${col}:${col}`).format.columnWidth = width;
  }
}

// Start
{
  const s = sheets.Start;
  title(s, "Kairali Bill Audit Workspace", "Monthly KServe import, AI call audit, invoice reconciliation, evidence tracking and SQL synchronisation.", "H");
  s.getRange("A4:B4").values = [["Workspace area", "Location"]];
  header(s, "A4:B4");
  const links = [
    ["Root folder", "https://drive.google.com/drive/folders/18EvP8T_mqoORxJG5R6BTJz9TOS-nPyrI"],
    ["August KServe source snapshot", "https://docs.google.com/spreadsheets/d/1mRURF6p4gyxJ0MwbVdjq5gvzXP_Dmfem6WUZM669fvc/edit?gid=1806749875#gid=1806749875"],
    ["Monthly inputs", "https://drive.google.com/drive/folders/18_BYOSudlQ09BBNPRJGaYD_ci1fnAQwH"],
    ["Invoices", "https://drive.google.com/drive/folders/1pFsmLZDyK2ytFz8nUZHQUd7iitbLCcoq"],
    ["AI workspace", "https://drive.google.com/drive/folders/1O7Pe0-FYuP_bsM6iyMWfO4ZC_2RZiuET"],
    ["Evidence", "https://drive.google.com/drive/folders/1iqY0kXz0A6Cl_W1NQpzeQ124d3stSCIB"],
    ["Exports", "https://drive.google.com/drive/folders/1BZT8lbPFzp5Af4NXR9-Ek8vPmRdBgot4"],
    ["Backups", "https://drive.google.com/drive/folders/1tCkzPC0c3Oe5fv30CaVL3C3AdpswR7T9"],
  ];
  s.getRange("A5:B12").values = links;
  body(s, "A5:B12");
  s.getRange("A14:B14").values = [["Monthly workflow", "Action"]];
  header(s, "A14:B14");
  s.getRange("A15:B21").values = [
    [1, "Copy the KServe month into Monthly Input or select its source Sheet in Settings."],
    [2, "Place the invoice PDF in the matching month folder and register it in Invoice Register."],
    [3, "Use Bill Audit > Import KServe month, then Build audit queue."],
    [4, "Start the Apps Script audit runner. It checkpoints before the execution limit."],
    [5, "Let the independent second review and conditional third review finish; unresolved terminal calls use the approved cycle-close fallback."],
    [6, "Synchronise final traced results to SQL when the signed endpoint is enabled."],
    [7, "Approve the invoice and reconcile the month; final totals remain withheld until the cycle is READY."],
  ];
  body(s, "A15:B21");
  s.getRange("A23:B25").values = [
    ["Security", "The OpenAI API key is stored in Apps Script Properties. It is never written in a visible cell."],
    ["Evidence", "Store recording/transcript evidence in the restricted Evidence folder. Keep only references and SHA-256 hashes in this workbook."],
    ["Billing", "AI records category, evidence and timing. Fixed rules calculate money."],
  ];
  s.getRange("A23:A25").format = { fill: COLORS.goldLight, font: { name: "Arial", bold: true, color: COLORS.navy }, wrapText: true };
  body(s, "A23:B25");
  setWidths(s, { A: 24, B: 95 });
  s.freezePanes.freezeRows(2);
  s.tabColor = COLORS.navy;
}

// Settings
{
  const s = sheets.Settings;
  title(s, "Settings", "Editable monthly and AI configuration. Secret values are referenced, not displayed.", "E");
  s.getRange("A4:E4").values = [["Setting", "Value", "Editable", "Description", "Secret handling"]];
  header(s, "A4:E4");
  const rows = [
    ["ACTIVE_BILL_MONTH", "2026-08", "Yes", "Month currently being processed", "Visible"],
    ["SOURCE_SPREADSHEET_ID", "1mRURF6p4gyxJ0MwbVdjq5gvzXP_Dmfem6WUZM669fvc", "Yes", "KServe source snapshot stored in the monthly-input folder", "Visible"],
    ["SOURCE_TAB_NAME", "August Data", "Yes", "KServe source tab", "Visible"],
    ["SOURCE_HEADER_ROW", 1, "Yes", "Header row in the KServe source", "Visible"],
    ["SOURCE_START_ROW", 2, "Yes", "First data row", "Visible"],
    ["AUDIT_MODEL", "gpt-4o-mini-2024-07-18", "No", "Canonical KAudit classification model", "Code-owned"],
    ["TRANSCRIPTION_MODEL", "whisper-1", "No", "Canonical timestamped KAudit transcription model", "Code-owned"],
    ["OPENAI_API_KEY", "Configured through Bill Audit menu", "No", "Dedicated OpenAI project key", "Apps Script Properties"],
    ["API_BASE_URL", "https://kaudit-platform.vercel.app", "Yes", "Approved server API base URL", "Visible"],
    ["BATCH_SIZE", 5, "Yes", "Maximum recordings claimed per audit batch", "Visible"],
    ["SAFE_RUNTIME_MINUTES", 25, "Yes", "Checkpoint before the organisation execution limit", "Visible"],
    ["TRIGGER_INTERVAL_MINUTES", 5, "Yes", "Continuation trigger interval", "Visible"],
    ["MIN_CLASSIFICATION_CONFIDENCE", POLICY.validationThreshold, "No", "Locked automated-consensus confidence floor", "Code-owned"],
    ["SECOND_REVIEW_ENABLED", true, "Yes", "Run an independent second review", "Visible"],
    ["THIRD_REVIEW_ON_DISAGREEMENT", true, "Yes", "Adjudicate only when reviewers disagree", "Visible"],
    ["RULESET_VERSION", POLICY.classifierVersion, "No", "Canonical KAudit classifier ruleset", "Code-owned"],
    ["PROMPT_VERSION", "2026-08-v1", "Yes", "Version written with every audit", "Visible"],
    ["RATE_PER_MINUTE_INR", POLICY.rate, "No", "Locked finance-approved billing rate", "Code-owned"],
    ["BILLING_RULESET_VERSION", POLICY.billingRulesetVersion, "No", "Locked KServe rate and rounding ruleset", "Code-owned"],
    ["CATEGORY_POLICY_VERSION", POLICY.categoryPolicyVersion, "No", "Locked category endpoint and grace policy", "Code-owned"],
    ["CURRENCY", "INR", "Yes", "Billing currency", "Visible"],
    ["EVIDENCE_FOLDER_ID", "1VwYPrzhfxfaLXP47i9CJoIs1ovhWqPje", "Yes", "August evidence folder", "Visible"],
    ["INVOICE_FOLDER_ID", "1YDc8_l0AhYbg-Rf4_4FoFSYydIM8AapN", "Yes", "August invoice folder", "Visible"],
    ["EXPORT_FOLDER_ID", "1CkiTbBgqAlzIaidDFUpuZhUnXRgOg6my", "Yes", "August export folder", "Visible"],
    ["SQL_SYNC_ENABLED", false, "Yes", "Enable only after server endpoint validation", "Visible"],
  ];
  s.getRange(`A5:E${4 + rows.length}`).values = rows;
  body(s, `A5:E${4 + rows.length}`);
  s.getRange(`B5:B${4 + rows.length}`).format.fill = COLORS.goldLight;
  s.getRange("B17").format.numberFormat = "0.0%";
  s.getRange("B22").format.numberFormat = "₹#,##0.00";
  setWidths(s, { A: 36, B: 55, C: 12, D: 62, E: 28 });
  s.getRange(`D5:E${4 + rows.length}`).format.wrapText = true;
  s.freezePanes.freezeRows(4);
  s.tabColor = COLORS.goldLight;
}

// Monthly Input
{
  const s = sheets["Monthly Input"];
  title(s, "Monthly Input", "Paste or import the KServe month below. Columns A:K exactly match the August source; L:U are internal controls.", "U");
  const headers = ["Task ID","Destination Number","Call Start Time","Call Connected Time","Call End Time","Duration (Seconds) With Ringing","Duration (Seconds) Without Ringing","Duration (Minutes) - Actual Billing Mins","Actual Billing Amount","Recording URL","Sent Status","Bill Month","Source Row","Source File Hash","Imported At","Row Status","Audit State","SQL Sync Status","Error Code","Run ID","Evidence SHA-256"];
  s.getRange("A4:U4").values = [headers];
  header(s, "A4:U4");
  body(s, "A5:U1000");
  s.getRange("A5:A2000").format.numberFormat = "@";
  s.getRange("B5:B2000").format.numberFormat = "@";
  s.getRange("F5:I2000").format.numberFormat = "0.00";
  s.getRange("C5:E2000").format.numberFormat = "yyyy-mm-dd hh:mm:ss";
  s.getRange("O5:O2000").format.numberFormat = "yyyy-mm-dd hh:mm:ss";
  s.getRange("Q5:Q2000").dataValidation = { rule: { type: "list", values: ["", "PENDING", "NO_RECORDING", "QUEUED", "COMPLETED", "MANUAL_REVIEW", "FAILED"] } };
  setWidths(s, { A: 36, B: 20, C: 24, D: 24, E: 24, F: 18, G: 18, H: 18, I: 18, J: 55, K: 16, L: 14, M: 12, N: 32, O: 21, P: 16, Q: 18, R: 18, S: 20, T: 28, U: 48 });
  s.freezePanes.freezeRows(4);
  s.freezePanes.freezeColumns(1);
  s.tabColor = "#2563EB";
}

// Invoice Register
{
  const s = sheets["Invoice Register"];
  title(s, "Invoice Register", "Register the invoice PDF and extracted values for each bill month. Final approval remains manual.", "N");
  const headers = ["Bill Month","Invoice File URL","Invoice Number","Period Start","Period End","Subtotal INR","Tax INR","Total INR","KServe Minutes","KServe Amount INR","Verified Amount INR","Variance INR","Extraction Status","Approval Status"];
  s.getRange("A4:N4").values = [headers];
  header(s, "A4:N4");
  body(s, "A5:N200");
  s.getRange("D5:E200").format.numberFormat = "yyyy-mm-dd";
  s.getRange("F5:L200").format.numberFormat = "₹#,##0.00";
  s.getRange("M5:M200").dataValidation = { rule: { type: "list", values: ["PENDING", "EXTRACTED", "VERIFIED", "FAILED"] } };
  s.getRange("N5:N200").dataValidation = { rule: { type: "list", values: ["NOT_REVIEWED", "APPROVED", "REJECTED"] } };
  setWidths(s, { A: 15, B: 55, C: 22, D: 16, E: 16, F: 17, G: 15, H: 17, I: 17, J: 19, K: 19, L: 16, M: 20, N: 20 });
  s.freezePanes.freezeRows(4);
  s.tabColor = "#B7791F";
}

// AI Queue
{
  const s = sheets["AI Queue"];
  title(s, "AI Queue", "Resumable audit queue. Apps Script claims a small batch, saves progress, and resumes safely.", "M");
  const headers = ["Task ID","Bill Month","Source Row","Queue State","Attempt Count","Lease Until","Next Retry At","Run ID","Recording URL","Last Completed Stage","Error Code","Error Detail","Updated At"];
  s.getRange("A4:M4").values = [headers];
  header(s, "A4:M4");
  body(s, "A5:M1000");
  s.getRange("D5:D2000").dataValidation = { rule: { type: "list", values: ["PENDING","RUNNING","TRANSCRIBED","CLASSIFIED","COMPLETED","RETRY_WAITING","UNRESOLVED","MANUAL_REVIEW","FAILED_PERMANENT","NO_RECORDING","INVALID_RECORDING","AUDIO_TOO_LARGE"] } };
  s.getRange("F5:G2000").format.numberFormat = "yyyy-mm-dd hh:mm:ss";
  s.getRange("M5:M2000").format.numberFormat = "yyyy-mm-dd hh:mm:ss";
  setWidths(s, { A: 36, B: 15, C: 12, D: 22, E: 14, F: 21, G: 21, H: 28, I: 55, J: 25, K: 24, L: 55, M: 21 });
  s.freezePanes.freezeRows(4);
  s.tabColor = "#7C3AED";
}

// AI Results
{
  const s = sheets["AI Results"];
  title(s, "AI Results", "AI evidence, engine-validated endpoints and consensus metadata. The AI never calculates or approves money.", "AQ");
  const headers = ["Task ID","Bill Month","Evidence SHA-256","Language","Primary Category","Primary Confidence","Customer Participated","Introduction Completed","Failure Stage","Conversation End Seconds","Failure At Seconds","Speech Seconds","Agent Speech Seconds","Customer Speech Seconds","Evidence Reference","Transcript Evidence URL","Model","Prompt Version","Ruleset Version","Second Review Category","Second Review Confidence","Adjudication Status","Audited At","Final Category","Final Confidence","Third Review Category","Third Review Confidence","Consensus Status","Consensus Reasons","Customer Block Numbers","Agent Block Numbers","Voicemail Block Numbers","Business Block Numbers","Last Customer Exchange Seconds","Last Agent Exchange Seconds","Last Voicemail Exchange Seconds","Last Business Exchange Seconds","Last Verified Interaction Seconds","Agent Failure Mode","Failure Start Seconds","Meaningful Service Before Failure","Category Policy Code","Recorded Duration Seconds"];
  s.getRange("A4:AQ4").values = [headers];
  header(s, "A4:AQ4");
  body(s, "A5:AQ1000");
  s.getRange("F5:F2000").format.numberFormat = "0.0%";
  s.getRange("U5:U2000").format.numberFormat = "0.0%";
  s.getRange("Y5:Y2000").format.numberFormat = "0.0%";
  s.getRange("G5:H2000").dataValidation = { rule: { type: "list", values: [true, false] } };
  s.getRange("W5:W2000").format.numberFormat = "yyyy-mm-dd hh:mm:ss";
  setWidths(s, { A: 36, B: 14, C: 48, D: 14, E: 32, F: 16, G: 20, H: 20, I: 24, J: 20, K: 18, L: 16, M: 18, N: 20, O: 30, P: 55, Q: 28, R: 20, S: 24, T: 32, U: 18, V: 24, W: 22, X: 32, Y: 18, Z: 28, AA: 18, AB: 18, AC: 42, AD: 34, AE: 34, AF: 34, AG: 34, AH: 20, AI: 20, AJ: 20, AK: 20, AL: 20, AM: 22, AN: 20, AO: 22, AP: 42, AQ: 22 });
  s.getRange("O5:P1000").format.wrapText = true;
  s.freezePanes.freezeRows(4);
  s.tabColor = "#7C3AED";
}

// Billing Calculation
{
  const s = sheets["Billing Calculation"];
  title(s, "Billing Calculation", "Code-owned KAudit calculation. AI supplies structured evidence; deterministic rules select endpoints, grace, rounding and money.", "X");
  const headers = ["Task ID","Final Category","Connected Seconds","Service End Seconds","Failure Mode","Grace Seconds","Adjusted Chargeable Seconds","Billable Minutes","Rate INR/Minute","Verified Amount INR","KServe Amount INR","Variance INR","Rounding Rule Code","Billing Ruleset Version","Approval Status","Recorded Duration Seconds","Policy Service End Seconds","Category Policy Code","Calculation Basis","Consensus Status","Effective Confidence","Evidence SHA-256","Decision Trace SHA-256","SQL Sync Status"];
  s.getRange("A4:X4").values = [headers];
  header(s, "A4:X4");
  body(s, "A5:X1000");
  s.getRange("F5:G2000").format.numberFormat = "0";
  s.getRange("H5:H2000").format.numberFormat = "0.0000";
  s.getRange("I5:L2000").format.numberFormat = "₹#,##0.00";
  s.getRange("O5:O2000").dataValidation = { rule: { type: "list", values: ["NOT_REVIEWED", "APPROVED", "REJECTED", "BLOCKED", "SUPERSEDED_REAUDIT_REQUIRED"] } };
  s.getRange("X5:X2000").dataValidation = { rule: { type: "list", values: ["PENDING", "SYNCED", "FAILED", "BLOCKED"] } };
  setWidths(s, { A: 36, B: 32, C: 18, D: 22, E: 24, F: 16, G: 24, H: 18, I: 18, J: 20, K: 20, L: 17, M: 28, N: 25, O: 26, P: 22, Q: 24, R: 45, S: 36, T: 20, U: 20, V: 48, W: 48, X: 20 });
  s.freezePanes.freezeRows(4);
  s.tabColor = "#0F766E";
}

// Rules
{
  const s = sheets.Rules;
  title(s, "Rules", "Versioned and editable classification and billing rules. Change the version whenever a rule changes.", "K");
  const headers = ["Rule ID","Category Code","Priority","Enabled","Classification Criteria","Exclusions","Billing Policy","Grace Seconds","Second Review","Manual Review Below","Ruleset Version"];
  s.getRange("A4:K4").values = [headers];
  header(s, "A4:K4");
  const rows = [
    ["R-001","TIME_DURATION",10,true,"Call ends too early or continues without customer value.","Do not infer from a missing or short displayed duration.","Last meaningful customer exchange plus 60 seconds, capped by recording.",60,true,POLICY.validationThreshold,POLICY.classifierVersion],
    ["R-002","AGENT_FAILURE",20,true,"Saanvi fails, mishandles, repeats, ignores, or continues against stop intent.","Customer refusal, voicemail, silence, and normal close are not agent failure.","Zero unless the engine validates meaningful two-way service before an in-recording failure boundary; then boundary plus exactly 30 seconds.",30,true,POLICY.validationThreshold,POLICY.classifierVersion],
    ["R-003","CONNECT_NOT_FRUITFUL",30,true,"Human answers but no successful outcome: busy, callback, decline, wrong number, early hang-up.","Do not use when Saanvi failed or a successful outcome completed.","Last meaningful customer exchange plus 60 seconds, capped by recording.",60,true,POLICY.validationThreshold,POLICY.classifierVersion],
    ["R-004","INACTIVE_CALL",40,true,"No meaningful customer speech and no positively identified Saanvi speech.","Saanvi introduction with no reply is USER_SILENCE.","Always zero.",0,true,POLICY.validationThreshold,POLICY.classifierVersion],
    ["R-005","INCORRECT_CALL_DURATION",50,true,"Provider duration materially differs from decoded recording duration.","Conversation length alone is not a mismatch.","Last independently verified interaction plus 60 seconds; zero when no verified interaction.",60,true,POLICY.validationThreshold,POLICY.classifierVersion],
    ["R-006","AI_CONVERSATION_HANDLING",60,true,"System interrupts, ignores answers, duplicates questions, or changes topic unnaturally.","A normal unsuccessful conversation is CONNECT_NOT_FRUITFUL.","Always zero.",0,true,POLICY.validationThreshold,POLICY.classifierVersion],
    ["R-007","VOICEMAIL",70,true,"Affirmative fixed mailbox greeting, leave-message request, mailbox/recording notice, or beep.","Silence and Saanvi introduction are never voicemail evidence.","Later of last Saanvi or voicemail exchange plus 30 seconds; zero without a verified exchange.",30,true,POLICY.validationThreshold,POLICY.classifierVersion],
    ["R-008","AI_TO_AI",80,true,"Interactive IVR, screening assistant, or automated system exchanges prompts with Saanvi.","One-way voicemail and a human language choice are not AI-to-AI.","60 seconds grace only, capped by recording.",60,true,POLICY.validationThreshold,POLICY.classifierVersion],
    ["R-009","NETWORK_FAILURE_TELECOM",90,true,"Explicit distortion, one-way audio, inability to hear, network drop, or telecom failure.","Agent silence alone is not network evidence.","Always zero.",0,true,POLICY.validationThreshold,POLICY.classifierVersion],
    ["R-010","USER_SILENCE",100,true,"At least one valid Saanvi block and no meaningful customer block.","Any human reply disallows USER_SILENCE.","Last meaningful Saanvi exchange plus 60 seconds, capped by recording.",60,true,POLICY.validationThreshold,POLICY.classifierVersion],
    ["R-011","JUNK_CALL",110,true,"Explicit test, spam/scam, prank, or illegitimate-purpose evidence.","Wrong number, unclear audio, silence, or short duration are not junk.","Last business-relevant customer exchange plus 60 seconds; zero when none.",60,true,POLICY.validationThreshold,POLICY.classifierVersion],
    ["R-012","OK",120,true,"Normal legitimate two-way conversation with qualification, resolution, or handoff completed.","Do not invent a defect after a successful outcome.","Last meaningful customer exchange plus 60 seconds, capped by recording.",60,true,POLICY.validationThreshold,POLICY.classifierVersion],
  ];
  s.getRange(`A5:K${4 + rows.length}`).values = rows;
  body(s, `A5:K${4 + rows.length}`);
  s.getRange(`D5:D${4 + rows.length}`).dataValidation = { rule: { type: "list", values: [true, false] } };
  s.getRange(`I5:I${4 + rows.length}`).dataValidation = { rule: { type: "list", values: [true, false] } };
  s.getRange(`J5:J${4 + rows.length}`).format.numberFormat = "0.0%";
  s.getRange(`E5:G${4 + rows.length}`).format.wrapText = true;
  setWidths(s, { A: 14, B: 42, C: 10, D: 12, E: 72, F: 62, G: 72, H: 16, I: 18, J: 20, K: 20 });
  s.freezePanes.freezeRows(4);
  s.tabColor = "#B7791F";
}

// Prompts
{
  const s = sheets.Prompts;
  title(s, "Prompts", "All AI instructions are editable and versioned here. Apps Script loads only rows marked Enabled.", "F");
  const headers = ["Prompt Key","Version","Enabled","Purpose","Prompt Text","Last Updated By"];
  s.getRange("A4:F4").values = [headers];
  header(s, "A4:F4");
  const classifierPrompt = "You are the automated call-quality auditor for Kairali Group. The female Kairali AI agent is Saanvi. Use only numbered transcript blocks, metadata, enabled Rules and Knowledge Base. Attribute customer, agent and unclear blocks without overlap. Apply specific evidence precedence: affirmative mailbox evidence is VOICEMAIL; interactive automation is AI_TO_AI; Saanvi speech with no customer reply is USER_SILENCE; no Saanvi and no customer speech is INACTIVE_CALL; human speech with no useful Saanvi response is AGENT_FAILURE; stop intent followed by sales continuation is AGENT_FAILURE; administrative-only extension is TIME_DURATION; appropriate unsuccessful close is CONNECT_NOT_FRUITFUL; completed qualification, resolution or handoff is OK. JUNK_CALL requires explicit junk evidence. INCORRECT_CALL_DURATION requires duration_mismatch=true. NETWORK_FAILURE_TELECOM requires explicit telecom evidence. Mid-conversation AGENT_FAILURE requires a named first failing block after genuine two-way service. Never calculate money, grace, rates, rounding or a bill. Return strict JSON matching the supplied schema and keep remarks free of PII and transcript quotations.";
  const rows = [
    ["SYSTEM_CLASSIFIER",POLICY.classifierVersion,true,"Primary canonical audit classification",classifierPrompt,"KAudit policy"],
    ["SECOND_REVIEWER",POLICY.classifierVersion,true,"Independent canonical verification",classifierPrompt + " Review independently and do not assume the primary result.","KAudit policy"],
    ["ADJUDICATOR",POLICY.classifierVersion,true,"Independent third classification",classifierPrompt + " Act as an independent third classifier; do not vote on prior reasoning.","KAudit policy"],
    ["TRANSCRIPTION_GUIDANCE",POLICY.classifierVersion,true,"Transcription instructions","Transcribe Hindi, Hinglish, English, Malayalam and other detected languages accurately. Preserve timestamps and speaker turns where available. Do not translate. Do not invent a customer response.","KAudit policy"],
    ["INVOICE_EXTRACTION","2026-08-v1",true,"Invoice field extraction","Extract invoice number, invoice date, period start, period end, subtotal, tax, total, currency and supplier. Return strict JSON. Do not approve the invoice or infer missing amounts.","Satyam Kumar Kairali"],
  ];
  s.getRange(`A5:F${4 + rows.length}`).values = rows;
  body(s, `A5:F${4 + rows.length}`);
  s.getRange(`C5:C${4 + rows.length}`).dataValidation = { rule: { type: "list", values: [true, false] } };
  s.getRange(`D5:E${4 + rows.length}`).format.wrapText = true;
  s.getRange(`5:${4 + rows.length}`).format.rowHeight = 105;
  setWidths(s, { A: 30, B: 18, C: 12, D: 34, E: 120, F: 28 });
  s.freezePanes.freezeRows(4);
  s.tabColor = "#7C3AED";
}

// Knowledge Base
{
  const s = sheets["Knowledge Base"];
  title(s, "Knowledge Base", "Approved business context supplied to the AI. Add only reviewed facts and keep each item versioned.", "H");
  const headers = ["Knowledge ID","Version","Enabled","Topic","Approved Content","Source URL","Updated By","Updated At"];
  s.getRange("A4:H4").values = [headers];
  header(s, "A4:H4");
  const rows = [
    ["KB-001","2026-08-v1",true,"Organisation","The calling organisation is Kairali Ayurvedic Group.","","Satyam Kumar Kairali",new Date("2026-09-18T00:00:00Z")],
    ["KB-002","2026-08-v1",true,"AI agent","Saanvi is an AI calling agent used by Kairali Ayurvedic Group.","","Satyam Kumar Kairali",new Date("2026-09-18T00:00:00Z")],
    ["KB-003","2026-08-v1",true,"Languages","Calls may contain Hindi, Hinglish or English.","","Satyam Kumar Kairali",new Date("2026-09-18T00:00:00Z")],
    ["KB-004","2026-08-v1",false,"Products and services","Add approved product, treatment, resort and service information here before enabling.","","Satyam Kumar Kairali",new Date("2026-09-18T00:00:00Z")],
  ];
  s.getRange(`A5:H${4 + rows.length}`).values = rows;
  body(s, `A5:H${4 + rows.length}`);
  s.getRange(`C5:C${4 + rows.length}`).dataValidation = { rule: { type: "list", values: [true, false] } };
  s.getRange(`E5:F${4 + rows.length}`).format.wrapText = true;
  s.getRange(`H5:H${4 + rows.length}`).format.numberFormat = "yyyy-mm-dd hh:mm:ss";
  setWidths(s, { A: 18, B: 18, C: 12, D: 28, E: 90, F: 55, G: 28, H: 22 });
  s.freezePanes.freezeRows(4);
  s.tabColor = "#7C3AED";
}

// Evidence Index
{
  const s = sheets["Evidence Index"];
  title(s, "Evidence Index", "References to restricted recordings, transcripts and hashes. Do not paste full transcripts into this workbook.", "K");
  const headers = ["Task ID","Bill Month","Recording Source URL","Evidence Drive URL","Transcript Drive URL","Evidence SHA-256","Transcript SHA-256","Audio Bytes","Captured At","Retention Status","Access Status"];
  s.getRange("A4:K4").values = [headers];
  header(s, "A4:K4");
  body(s, "A5:K1000");
  s.getRange("I5:I2000").format.numberFormat = "yyyy-mm-dd hh:mm:ss";
  s.getRange("J5:J2000").dataValidation = { rule: { type: "list", values: ["ACTIVE", "ARCHIVED", "EXPIRED", "DELETE_APPROVED"] } };
  s.getRange("K5:K2000").dataValidation = { rule: { type: "list", values: ["RESTRICTED", "MISSING", "UNVERIFIED"] } };
  setWidths(s, { A: 36, B: 14, C: 58, D: 55, E: 55, F: 48, G: 48, H: 16, I: 22, J: 20, K: 18 });
  s.freezePanes.freezeRows(4);
  s.tabColor = "#DC2626";
}

// Run Log
{
  const s = sheets["Run Log"];
  title(s, "Run Log", "Append-only execution history. Do not record signed URLs, transcripts, phone numbers or API keys.", "N");
  const headers = ["Run ID","Started At","Ended At","Function","Bill Month","Claimed","Completed","Retrying","Manual Review","Failed","Model","Ruleset Version","Prompt Version","Safe Message"];
  s.getRange("A4:N4").values = [headers];
  header(s, "A4:N4");
  body(s, "A5:N1000");
  s.getRange("B5:C2000").format.numberFormat = "yyyy-mm-dd hh:mm:ss";
  setWidths(s, { A: 30, B: 22, C: 22, D: 30, E: 14, F: 12, G: 12, H: 12, I: 16, J: 12, K: 26, L: 20, M: 20, N: 65 });
  s.freezePanes.freezeRows(4);
  s.tabColor = "#64748B";
}

// Summary
{
  const s = sheets.Summary;
  title(s, "Monthly Summary", "Live operational counts and reconciliation for the active bill month.", "H");
  s.getRange("A4:B4").values = [["Metric", "Value"]];
  header(s, "A4:B4");
  const labels = ["KServe rows","Rows with recording","No recording","Queue pending","Queue running","Audit completed","Unresolved terminal","Permanent failures","KServe amount INR","Verified amount INR","Variance INR"];
  s.getRange("A5:A15").values = labels.map((x) => [x]);
  const formulas = [
    "=COUNTA('Monthly Input'!A5:A50000)",
    "=COUNTIF('Monthly Input'!J5:J50000,\"<>\")",
    "=COUNTIF('Monthly Input'!Q5:Q50000,\"NO_RECORDING\")",
    "=COUNTIF('AI Queue'!D5:D50000,\"PENDING\")+COUNTIF('AI Queue'!D5:D50000,\"RETRY_WAITING\")",
    "=COUNTIF('AI Queue'!D5:D50000,\"RUNNING\")",
    "=COUNTIF('AI Queue'!D5:D50000,\"COMPLETED\")",
    "=COUNTIF('AI Queue'!D5:D50000,\"UNRESOLVED\")",
    "=COUNTIF('AI Queue'!D5:D50000,\"FAILED_PERMANENT\")+COUNTIF('AI Queue'!D5:D50000,\"INVALID_RECORDING\")+COUNTIF('AI Queue'!D5:D50000,\"AUDIO_TOO_LARGE\")",
    "=SUM('Monthly Input'!I5:I50000)",
    "=IF(E10=\"READY\",SUM('Billing Calculation'!J5:J50000),\"\")",
    "=IF(E10=\"READY\",B13-B14,\"\")",
  ];
  s.getRange("B5:B15").formulas = formulas.map((x) => [x]);
  body(s, "A5:B15");
  s.getRange("B5:B12").format.numberFormat = "#,##0";
  s.getRange("B13:B15").format.numberFormat = "₹#,##0.00";
  s.getRange("D4:E4").values = [["Control", "Status"]];
  header(s, "D4:E4");
  s.getRange("D5:D10").values = [["Active month"],["SQL sync"],["Pending or running work"],["Unresolved terminal"],["Invoice approval"],["Cycle release"]];
  s.getRange("E5:E9").formulas = [
    ["=INDEX(Settings!B:B,MATCH(\"ACTIVE_BILL_MONTH\",Settings!A:A,0))"],
    ["=INDEX(Settings!B:B,MATCH(\"SQL_SYNC_ENABLED\",Settings!A:A,0))"],
    ["=B8+B9"],
    ["=B11"],
    ["=IFERROR(INDEX('Invoice Register'!N5:N200,MATCH(E5,'Invoice Register'!A5:A200,0)),\"NOT_REGISTERED\")"],
  ];
  s.getRange("E10").values = [["AUDIT_PENDING"]];
  body(s, "D5:E10");
  s.getRange("A18:H18").merge();
  s.getRange("A18").values = [["Finalisation is allowed only after every call has an explicit resolution, no audit work remains active, SQL counts reconcile when sync is enabled, and the invoice is approved."]];
  s.getRange("A18:H18").format = { fill: COLORS.goldLight, font: { name: "Arial", bold: true, color: COLORS.navy }, wrapText: true, verticalAlignment: "center" };
  setWidths(s, { A: 34, B: 22, C: 4, D: 34, E: 24, F: 16, G: 16, H: 16 });
  s.freezePanes.freezeRows(4);
  s.tabColor = COLORS.teal;
}

// Automation
{
  const s = sheets.Automation;
  title(s, "Automation", "Apps Script functions and expected behaviour. Use the Bill Audit menu after the script is attached and authorised.", "F");
  const headers = ["Function","Menu Action","Purpose","Writes To","Safe To Retry","State"];
  s.getRange("A4:F4").values = [headers];
  header(s, "A4:F4");
  const rows = [
    ["setupWorkspace","Set up workspace","Validate required tabs, settings and Script Properties.","Settings, Run Log",true,"NOT_INSTALLED"],
    ["setOpenAiApiKey","Set OpenAI key","Prompt the owner and save the key in Apps Script Properties.","Script Properties",true,"NOT_INSTALLED"],
    ["importKServeMonth","Import KServe month","Read the configured source Sheet and append immutable monthly rows.","Monthly Input",true,"NOT_INSTALLED"],
    ["registerInvoice","Register invoice","Register the selected invoice PDF and extract fields.","Invoice Register",true,"NOT_INSTALLED"],
    ["buildAuditQueue","Build audit queue","Queue recording-backed rows that do not already have a matching accepted evidence hash.","AI Queue",true,"NOT_INSTALLED"],
    ["runAuditBatch","Start or resume audit","Claim a small batch and run transcription, classification and review.","AI Queue, AI Results, Evidence Index, Run Log",true,"NOT_INSTALLED"],
    ["syncPendingResults","Sync pending results","Send signed, idempotent raw and audit results to the approved server API.","Monthly Input, AI Queue, Run Log",true,"NOT_INSTALLED"],
    ["reconcileMonth","Reconcile month","Compare KServe rows, audit results, SQL receipts and invoice totals.","Summary, Run Log",true,"NOT_INSTALLED"],
    ["retrySelectedRows","Retry selected rows","Reset only selected recoverable failures.","AI Queue, Run Log",true,"NOT_INSTALLED"],
    ["stopAudit","Stop audit","Disable continuation triggers without deleting results.","Script Properties, Run Log",true,"NOT_INSTALLED"],
  ];
  s.getRange(`A5:F${4 + rows.length}`).values = rows;
  body(s, `A5:F${4 + rows.length}`);
  s.getRange(`C5:D${4 + rows.length}`).format.wrapText = true;
  setWidths(s, { A: 30, B: 30, C: 72, D: 55, E: 16, F: 20 });
  s.freezePanes.freezeRows(4);
  s.tabColor = "#64748B";
}

// Global workbook polish
for (const sheet of Object.values(sheets)) {
  const used = sheet.getUsedRange();
  if (used) used.format.font = { name: "Arial", size: 10 };
}

await fs.mkdir(outputDir, { recursive: true });

const summaryCheck = await workbook.inspect({
  kind: "table",
  range: "Summary!A1:H18",
  include: "values,formulas",
  tableMaxRows: 20,
  tableMaxCols: 10,
});
console.log(summaryCheck.ndjson);

const settingsCheck = await workbook.inspect({
  kind: "table",
  range: "Settings!A1:E29",
  include: "values,formulas",
  tableMaxRows: 30,
  tableMaxCols: 8,
});
console.log(settingsCheck.ndjson);

const errors = await workbook.inspect({
  kind: "match",
  searchTerm: "#REF!|#DIV/0!|#VALUE!|#NAME\\?|#N/A|#NUM!|#NULL!|#SPILL!|#CALC!",
  options: { useRegex: true, maxResults: 300 },
  summary: "final formula error scan",
});
console.log(errors.ndjson);

const previewRanges = {
  "Start": "A1:H25",
  "Settings": "A1:E29",
  "Monthly Input": "A1:U16",
  "Invoice Register": "A1:N16",
  "AI Queue": "A1:M16",
  "AI Results": "A1:AQ14",
  "Billing Calculation": "A1:X18",
  "Rules": "A1:K16",
  "Prompts": "A1:F9",
  "Knowledge Base": "A1:H8",
  "Evidence Index": "A1:K16",
  "Run Log": "A1:N16",
  "Summary": "A1:H18",
  "Automation": "A1:F14",
};
for (const name of sheetNames) {
  const preview = await workbook.render({ sheetName: name, range: previewRanges[name], scale: 1, format: "png" });
  const safe = name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  await fs.writeFile(`${outputDir}/${safe}.png`, new Uint8Array(await preview.arrayBuffer()));
}

const output = await SpreadsheetFile.exportXlsx(workbook);
await output.save(outputPath);
console.log(outputPath);
