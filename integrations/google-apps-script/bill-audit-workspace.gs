const BILL_AUDIT = Object.freeze({
  headerRow: 4,
  firstDataRow: 5,
  maxAudioBytes: 25 * 1024 * 1024,
  capacityGrowthRows: 1000,
  queueStates: Object.freeze({
    pending: 'PENDING',
    running: 'RUNNING',
    completed: 'COMPLETED',
    retry: 'RETRY_WAITING',
    manual: 'MANUAL_REVIEW',
    unresolved: 'UNRESOLVED',
    noRecording: 'NO_RECORDING',
    invalidRecording: 'INVALID_RECORDING',
    audioTooLarge: 'AUDIO_TOO_LARGE',
    failed: 'FAILED_PERMANENT',
  }),
  sourceHeaders: Object.freeze([
    'Task ID',
    'Destination Number',
    'Call Start Time',
    'Call Connected Time',
    'Call End Time',
    'Duration (Seconds) With Ringing',
    'Duration (Seconds) Without Ringing',
    'Duration (Minutes) - Actual Billing Mins',
    'Actual Billing Amount',
    'Recording URL',
    'Sent Status',
  ]),
  sheets: Object.freeze({
    settings: 'Settings',
    monthly: 'Monthly Input',
    invoice: 'Invoice Register',
    queue: 'AI Queue',
    results: 'AI Results',
    billing: 'Billing Calculation',
    rules: 'Rules',
    prompts: 'Prompts',
    knowledge: 'Knowledge Base',
    evidence: 'Evidence Index',
    log: 'Run Log',
    automation: 'Automation',
  }),
});

/**
 * Finance- and management-approved policy copied from the KAudit engine.
 *
 * These values are deliberately code-owned. The Rules and Prompts sheets may
 * guide the model and remain editable, but neither a model response nor a
 * spreadsheet cell is allowed to change money, rounding, grace, or the rate.
 */
const BILLING_POLICY = Object.freeze({
  engineVersion: 'kserve-verified-billing/1.1.0',
  rulesetVersion: '2026-07-27.1',
  rulesetSha256: 'd1c23d599d2905ff8ae63a8e68d75005961fd6bc7a464883c049ca833fab9b0e',
  categoryPolicyVersion: 'management-category-charge/2026-09-16.1',
  categoryPolicySha256: 'c982ec55fea2f4770d7653b4b198f2d066384e37438aad5e5ef8e6e8a2c48bb7',
  classifierVersion: 'kairali-12cat/2.9.0',
  classifierSha256: 'c9dabcf5058b60910d2cd594b64dba27a6f2a18a6a81b8211bf0edfc8e08d807',
  validationVersion: 'leadership-approved-auto-consensus/1.1.0',
  validationThreshold: 0.8,
  ratePaisePerMinute: 950,
  standardGraceMs: 60000,
  voicemailGraceMs: 30000,
  agentFailureGraceMs: 30000,
  shortCallCutoffMs: 30000,
  minuteMs: 60000,
  categories: Object.freeze([
    'TIME_DURATION',
    'AGENT_FAILURE',
    'CONNECT_NOT_FRUITFUL',
    'INACTIVE_CALL',
    'INCORRECT_CALL_DURATION',
    'AI_CONVERSATION_HANDLING',
    'VOICEMAIL',
    'AI_TO_AI',
    'NETWORK_FAILURE_TELECOM',
    'USER_SILENCE',
    'JUNK_CALL',
    'OK',
  ]),
});

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Bill Audit')
    .addItem('Set up workspace', 'setupWorkspace')
    .addItem('Upgrade to KAudit billing rules', 'upgradeWorkspace')
    .addItem('Set OpenAI key', 'setOpenAiApiKey')
    .addItem('Set SQL sync secret', 'setSqlSyncSecret')
    .addSeparator()
    .addItem('Import KServe month', 'importKServeMonth')
    .addItem('Build audit queue', 'buildAuditQueue')
    .addItem('Start or resume audit', 'runAuditBatch')
    .addItem('Retry selected rows', 'retrySelectedRows')
    .addItem('Stop audit', 'stopAudit')
    .addSeparator()
    .addItem('Reconcile month', 'reconcileMonth')
    .addItem('Sync pending results', 'syncPendingResults')
    .addToUi();
}

function setupWorkspace() {
  const required = Object.keys(BILL_AUDIT.sheets).map(function(key) {
    return BILL_AUDIT.sheets[key];
  });
  const ss = SpreadsheetApp.getActive();
  const missing = required.filter(function(name) { return !ss.getSheetByName(name); });
  if (missing.length) throw new Error('Missing required sheets: ' + missing.join(', '));
  const settings = readSettings_();
  if (!/^\d{4}-\d{2}$/.test(String(settings.ACTIVE_BILL_MONTH || ''))) {
    throw new Error('ACTIVE_BILL_MONTH must use YYYY-MM');
  }
  updateAutomationState_('INSTALLED');
  appendRunLog_('setupWorkspace', 0, 0, 0, 0, 'Workspace structure validated');
  SpreadsheetApp.getUi().alert('Bill Audit workspace is ready. Set the OpenAI key and model names before starting an audit.');
}

function upgradeWorkspace() {
  withScriptLock_(function() {
    PropertiesService.getScriptProperties().setProperty('BILL_AUDIT_STOPPED', 'true');
    deleteContinuationTriggers_();
    const settingsSheet = sheet_(BILL_AUDIT.sheets.settings);
    upsertSetting_('MIN_CLASSIFICATION_CONFIDENCE', BILLING_POLICY.validationThreshold, 'No', 'Locked automated-consensus confidence floor', 'Code-owned');
    upsertSetting_('AUDIT_MODEL', 'gpt-4o-mini-2024-07-18', 'No', 'Canonical KAudit classification model', 'Code-owned');
    upsertSetting_('TRANSCRIPTION_MODEL', 'whisper-1', 'No', 'Canonical timestamped KAudit transcription model', 'Code-owned');
    upsertSetting_('RULESET_VERSION', BILLING_POLICY.classifierVersion, 'No', 'Canonical KAudit classifier ruleset', 'Code-owned');
    upsertSetting_('BILLING_RULESET_VERSION', BILLING_POLICY.rulesetVersion, 'No', 'Locked KServe rate and rounding ruleset', 'Code-owned');
    upsertSetting_('CATEGORY_POLICY_VERSION', BILLING_POLICY.categoryPolicyVersion, 'No', 'Locked category service-end and grace policy', 'Code-owned');
    upsertSetting_('RATE_PER_MINUTE_INR', BILLING_POLICY.ratePaisePerMinute / 100, 'No', 'Locked finance-approved rate', 'Code-owned');

    const rules = sheet_(BILL_AUDIT.sheets.rules);
    const ruleRows = canonicalRuleRows_();
    rules.getRange('A4:K4').setValues([['Rule ID','Category Code','Priority','Enabled','Classification Criteria','Exclusions','Billing Policy','Grace Seconds','Second Review','Manual Review Below','Ruleset Version']]);
    const oldRuleCount = dataRowCount_(rules);
    rules.getRange(BILL_AUDIT.firstDataRow, 1, ruleRows.length, 11).setValues(ruleRows);
    if (oldRuleCount > ruleRows.length) {
      // Preserve unmatched legacy rows for revision history, but keep them out
      // of the active classifier contract.
      rules.getRange(
        BILL_AUDIT.firstDataRow + ruleRows.length,
        4,
        oldRuleCount - ruleRows.length,
        1,
      ).setValue(false);
    }

    const prompts = sheet_(BILL_AUDIT.sheets.prompts);
    const promptRows = canonicalPromptRows_();
    const oldPromptCount = dataRowCount_(prompts);
    prompts.getRange(BILL_AUDIT.firstDataRow, 1, promptRows.length, 6).setValues(promptRows);
    if (oldPromptCount > promptRows.length) {
      prompts.getRange(
        BILL_AUDIT.firstDataRow + promptRows.length,
        3,
        oldPromptCount - promptRows.length,
        1,
      ).setValue(false);
    }

    const results = sheet_(BILL_AUDIT.sheets.results);
    ensureSheetCapacity_(results, results.getMaxRows(), 43);
    results.getRange(4, 1, 1, 43).setValues([auditResultHeaders_()]);
    const resultCapacity = Math.max(1, results.getMaxRows() - BILL_AUDIT.headerRow);
    results.getRange(BILL_AUDIT.firstDataRow, 6, resultCapacity, 1).setNumberFormat('0.0%');
    results.getRange(BILL_AUDIT.firstDataRow, 21, resultCapacity, 1).setNumberFormat('0.0%');
    results.getRange(BILL_AUDIT.firstDataRow, 25, resultCapacity, 1).setNumberFormat('0.0%');
    results.getRange(BILL_AUDIT.firstDataRow, 27, resultCapacity, 1).setNumberFormat('0.0%');
    const billing = sheet_(BILL_AUDIT.sheets.billing);
    ensureSheetCapacity_(billing, billing.getMaxRows(), 24);
    billing.getRange(4, 1, 1, 24).setValues([billingHeaders_()]);
    const billingCapacity = Math.max(1, billing.getMaxRows() - BILL_AUDIT.headerRow);
    billing.getRange(BILL_AUDIT.firstDataRow, 8, billingCapacity, 1).setNumberFormat('0.00');
    billing.getRange(BILL_AUDIT.firstDataRow, 9, billingCapacity, 4).setNumberFormat('₹#,##0.00');
    billing.getRange(BILL_AUDIT.firstDataRow, 21, billingCapacity, 1).setNumberFormat('0.0%');
    billing.getRange(BILL_AUDIT.firstDataRow, 15, billingCapacity, 1).setDataValidation(
      SpreadsheetApp.newDataValidation()
        .requireValueInList(['AUTO_APPROVED','REVIEW_REQUIRED','SUPERSEDED_REAUDIT_REQUIRED'], true)
        .setAllowInvalid(false)
        .build(),
    );
    billing.getRange(BILL_AUDIT.firstDataRow, 24, billingCapacity, 1).setDataValidation(
      SpreadsheetApp.newDataValidation()
        .requireValueInList(['PENDING','SYNCED','BLOCKED','NOT_CONFIGURED'], true)
        .setAllowInvalid(false)
        .build(),
    );
    const billingRows = dataRowCount_(billing);
    if (billingRows) {
      const values = billing.getRange(BILL_AUDIT.firstDataRow, 1, billingRows, 24).getValues();
      values.forEach(function(row) {
        if (String(row[13] || '') !== BILLING_POLICY.rulesetVersion || !String(row[18] || '')) {
          row[14] = 'SUPERSEDED_REAUDIT_REQUIRED';
          row[23] = 'BLOCKED';
        }
      });
      billing.getRange(BILL_AUDIT.firstDataRow, 1, billingRows, 24).setValues(values);
    }
    const queue = sheet_(BILL_AUDIT.sheets.queue);
    const queueCapacity = Math.max(1, queue.getMaxRows() - BILL_AUDIT.headerRow);
    queue.getRange(BILL_AUDIT.firstDataRow, 4, queueCapacity, 1).setDataValidation(
      SpreadsheetApp.newDataValidation()
        .requireValueInList(['PENDING','RUNNING','COMPLETED','UNRESOLVED','RETRY_WAITING','FAILED_PERMANENT','SKIPPED_NO_RECORDING'], true)
        .setAllowInvalid(false)
        .build(),
    );
    const queueRows = dataRowCount_(queue);
    if (queueRows) {
      const values = queue.getRange(BILL_AUDIT.firstDataRow, 1, queueRows, 13).getValues();
      values.forEach(function(row) {
        if (String(row[8] || '').trim()) {
          row[3] = BILL_AUDIT.queueStates.pending;
          row[5] = '';
          row[6] = '';
          row[9] = 'REAUDIT_REQUIRED';
          row[10] = '';
          row[11] = '';
          row[12] = new Date();
        }
      });
      queue.getRange(BILL_AUDIT.firstDataRow, 1, queueRows, 13).setValues(values);
    }
    upgradeSummary_();
    appendRunLog_('upgradeWorkspace', queueRows, 0, queueRows, 0, 'KAudit policy installed; prior calculations blocked and recording-backed calls queued for re-audit');
    SpreadsheetApp.getUi().alert('KAudit billing rules are installed. Existing evidence was preserved. Old calculations are blocked; start the audit to rebuild them.');
  });
}

function upsertSetting_(key, value, editable, description, secretHandling) {
  const sheet = sheet_(BILL_AUDIT.sheets.settings);
  const count = dataRowCount_(sheet);
  const values = count ? sheet.getRange(BILL_AUDIT.firstDataRow, 1, count, 5).getValues() : [];
  const index = values.findIndex(function(row) { return String(row[0] || '').trim() === key; });
  const row = [key, value, editable, description, secretHandling];
  if (index >= 0) sheet.getRange(BILL_AUDIT.firstDataRow + index, 1, 1, 5).setValues([row]);
  else sheet.appendRow(row);
}

function canonicalRuleRows_() {
  const v = BILLING_POLICY.classifierVersion;
  const t = BILLING_POLICY.validationThreshold;
  return [
    ['R-001','TIME_DURATION',10,true,'Call ends too early or continues without customer value.','Do not infer from a missing or short displayed duration.','Last meaningful customer exchange plus 60 seconds, capped by recording.',60,true,t,v],
    ['R-002','AGENT_FAILURE',20,true,'Saanvi fails, mishandles, repeats, ignores, or continues against stop intent.','Customer refusal, voicemail, silence, and normal close are not agent failure.','Zero unless engine validates meaningful two-way service before an in-recording failure boundary; then boundary plus exactly 30 seconds.',30,true,t,v],
    ['R-003','CONNECT_NOT_FRUITFUL',30,true,'Human answers but no successful outcome: busy, callback, decline, wrong number, early hang-up.','Do not use when Saanvi failed or a successful outcome completed.','Last meaningful customer exchange plus 60 seconds, capped by recording.',60,true,t,v],
    ['R-004','INACTIVE_CALL',40,true,'No meaningful customer speech and no positively identified Saanvi speech.','Saanvi introduction with no reply is USER_SILENCE.','Always zero.',0,true,t,v],
    ['R-005','INCORRECT_CALL_DURATION',50,true,'Provider duration materially differs from decoded recording duration.','Conversation length alone is not a mismatch.','Last independently verified interaction plus 60 seconds; zero when no verified interaction.',60,true,t,v],
    ['R-006','AI_CONVERSATION_HANDLING',60,true,'System interrupts, ignores answers, duplicates questions, or changes topic unnaturally.','A normal unsuccessful conversation is CONNECT_NOT_FRUITFUL.','Always zero.',0,true,t,v],
    ['R-007','VOICEMAIL',70,true,'Affirmative fixed mailbox greeting, leave-message request, mailbox/recording notice, or beep.','Silence and Saanvi introduction are never voicemail evidence.','Later of last Saanvi or voicemail exchange plus 30 seconds; zero without a verified exchange.',30,true,t,v],
    ['R-008','AI_TO_AI',80,true,'Interactive IVR, screening assistant, or automated system exchanges prompts with Saanvi.','One-way voicemail and a human language choice are not AI-to-AI.','60 seconds grace only, capped by recording.',60,true,t,v],
    ['R-009','NETWORK_FAILURE_TELECOM',90,true,'Explicit distortion, one-way audio, inability to hear, network drop, or telecom failure.','Agent silence alone is not network evidence.','Always zero.',0,true,t,v],
    ['R-010','USER_SILENCE',100,true,'At least one valid Saanvi block and no meaningful customer block.','Any human reply disallows USER_SILENCE.','Last meaningful Saanvi exchange plus 60 seconds, capped by recording.',60,true,t,v],
    ['R-011','JUNK_CALL',110,true,'Explicit test, spam/scam, prank, or illegitimate-purpose evidence.','Wrong number, unclear audio, silence, or short duration are not junk.','Last business-relevant customer exchange plus 60 seconds; zero when none.',60,true,t,v],
    ['R-012','OK',120,true,'Normal legitimate two-way conversation with qualification, resolution, or handoff completed.','Do not invent a defect after a successful outcome.','Last meaningful customer exchange plus 60 seconds, capped by recording.',60,true,t,v],
  ];
}

function classifierPrompt_() {
  return [
    'You are the automated call-quality auditor for Kairali Group. The female Kairali AI agent is Saanvi. Use only the numbered transcript blocks, metadata, enabled Rules and Knowledge Base.',
    'Assign customer_block_numbers and agent_block_numbers from conversational meaning. Ambiguous blocks belong in unclear_block_numbers. Customer, agent and unclear lists must not overlap.',
    'Apply these precedence rules: affirmative voicemail evidence => VOICEMAIL; interactive automation evidence => AI_TO_AI; Saanvi speech with no customer reply => USER_SILENCE; no Saanvi and no customer speech => INACTIVE_CALL; human speech with no useful Saanvi response => AGENT_FAILURE; stop intent followed by continued sales flow => AGENT_FAILURE; stop intent followed only by unnecessary administration => TIME_DURATION; appropriate close with no outcome => CONNECT_NOT_FRUITFUL; completed qualification/resolution/handoff => OK.',
    'JUNK_CALL requires explicit test, spam/scam, prank or illegitimate-purpose evidence. INCORRECT_CALL_DURATION requires the supplied duration_mismatch=true fact. NETWORK_FAILURE_TELECOM requires explicit telecom evidence.',
    'For AGENT_FAILURE, use agent_failure_mode=start unless genuine two-way service completed before a specific first failing block. Use mid_conversation only then and set agent_failure_start_block_number to that block.',
    'The model never calculates money, grace, rates, rounding, or a bill. Return strict JSON matching the supplied schema. Remarks must not quote transcript text or include names, phone numbers, email addresses, URLs, task identifiers, provider prose, money, or calculated durations.',
  ].join('\n\n');
}

function canonicalPromptRows_() {
  const v = BILLING_POLICY.classifierVersion;
  return [
    ['SYSTEM_CLASSIFIER',v,true,'Primary canonical audit classification',classifierPrompt_(),'KAudit policy'],
    ['SECOND_REVIEWER',v,true,'Independent canonical verification',classifierPrompt_() + '\n\nReview independently. Do not use or assume the primary result.','KAudit policy'],
    ['ADJUDICATOR',v,true,'Independent third classification',classifierPrompt_() + '\n\nAct as an independent third classifier. Do not vote on prior reasoning; classify the evidence yourself.','KAudit policy'],
    ['TRANSCRIPTION_GUIDANCE',v,true,'Timestamped transcription','Transcribe Hindi, Hinglish, English, Malayalam and other detected languages accurately. Preserve timestamps and speaker turns where available. Do not translate. Do not invent a customer response.','KAudit policy'],
    ['INVOICE_EXTRACTION',v,true,'Invoice field extraction','Extract invoice number, invoice date, period start, period end, subtotal, tax, total, currency and supplier. Return strict JSON. Do not approve the invoice or infer missing amounts.','KAudit policy'],
  ];
}

function auditResultHeaders_() {
  return ['Task ID','Bill Month','Evidence SHA-256','Language','Primary Category','Primary Confidence','Customer Participated','Introduction Completed','Failure Stage','Conversation End Seconds','Failure At Seconds','Speech Seconds','Agent Speech Seconds','Customer Speech Seconds','Evidence Reference','Transcript Evidence URL','Model','Prompt Version','Ruleset Version','Second Review Category','Second Review Confidence','Adjudication Status','Audited At','Final Category','Final Confidence','Third Review Category','Third Review Confidence','Consensus Status','Consensus Reasons','Customer Block Numbers','Agent Block Numbers','Voicemail Block Numbers','Business Block Numbers','Last Customer Exchange Seconds','Last Agent Exchange Seconds','Last Voicemail Exchange Seconds','Last Business Exchange Seconds','Last Verified Interaction Seconds','Agent Failure Mode','Failure Start Seconds','Meaningful Service Before Failure','Category Policy Code','Recorded Duration Seconds'];
}

function billingHeaders_() {
  return ['Task ID','Final Category','Connected Seconds','Service End Seconds','Failure Mode','Grace Seconds','Adjusted Chargeable Seconds','Billable Minutes','Rate INR/Minute','Verified Amount INR','KServe Amount INR','Variance INR','Rounding Rule Code','Billing Ruleset Version','Approval Status','Recorded Duration Seconds','Policy Service End Seconds','Category Policy Code','Calculation Basis','Consensus Status','Effective Confidence','Evidence SHA-256','Decision Trace SHA-256','SQL Sync Status'];
}

function upgradeSummary_() {
  const summary = sheet_('Summary');
  summary.getRange('A5:A15').setValues([
    ['KServe rows'],['Rows with recording'],['No recording'],['Queue pending'],['Queue running'],
    ['Audit completed'],['Unresolved terminal'],['Permanent failures'],['KServe amount INR'],
    ['Verified amount INR'],['Variance INR'],
  ]);
  summary.getRange('B5:B15').setFormulas([
    ["=COUNTA('Monthly Input'!A5:A50000)"],
    ["=COUNTIF('Monthly Input'!J5:J50000,\"<>\")"],
    ["=COUNTIF('Monthly Input'!Q5:Q50000,\"NO_RECORDING\")"],
    ["=COUNTIF('AI Queue'!D5:D50000,\"PENDING\")+COUNTIF('AI Queue'!D5:D50000,\"RETRY_WAITING\")"],
    ["=COUNTIF('AI Queue'!D5:D50000,\"RUNNING\")"],
    ["=COUNTIF('AI Queue'!D5:D50000,\"COMPLETED\")"],
    ["=COUNTIF('AI Queue'!D5:D50000,\"UNRESOLVED\")"],
    ["=COUNTIF('AI Queue'!D5:D50000,\"FAILED_PERMANENT\")+COUNTIF('AI Queue'!D5:D50000,\"INVALID_RECORDING\")+COUNTIF('AI Queue'!D5:D50000,\"AUDIO_TOO_LARGE\")"],
    ["=SUM('Monthly Input'!I5:I50000)"],
    ["=IF(E10=\"READY\",SUM('Billing Calculation'!J5:J50000),\"\")"],
    ["=IF(E10=\"READY\",B13-B14,\"\")"],
  ]);
  summary.getRange('D5:D10').setValues([['Active month'],['SQL sync'],['Pending or running work'],['Unresolved terminal'],['Invoice approval'],['Cycle release']]);
  summary.getRange('E5:E9').setFormulas([
    ["=INDEX(Settings!B:B,MATCH(\"ACTIVE_BILL_MONTH\",Settings!A:A,0))"],
    ["=INDEX(Settings!B:B,MATCH(\"SQL_SYNC_ENABLED\",Settings!A:A,0))"],
    ['=B8+B9'],['=B11'],
    ["=IFERROR(INDEX('Invoice Register'!N5:N200,MATCH(E5,'Invoice Register'!A5:A200,0)),\"NOT_REGISTERED\")"],
  ]);
  summary.getRange('E10').setValue('AUDIT_PENDING');
}

function setOpenAiApiKey() {
  const html = HtmlService.createHtmlOutput(
    '<div style="font-family:Arial;padding:16px">' +
      '<h3 style="margin-top:0">Set OpenAI API key</h3>' +
      '<p>The key is stored in Apps Script Properties and is not written into the spreadsheet.</p>' +
      '<input id="key" type="password" autocomplete="off" style="width:100%;box-sizing:border-box;padding:8px" />' +
      '<div style="margin-top:14px;text-align:right">' +
        '<button onclick="google.script.host.close()">Cancel</button> ' +
        '<button onclick="save()">Save</button>' +
      '</div>' +
      '<script>' +
        'function save(){var k=document.getElementById("key").value.trim();' +
        'if(!k){alert("Enter a key");return;}' +
        'google.script.run.withSuccessHandler(function(){google.script.host.close();})' +
        '.withFailureHandler(function(e){alert(e.message);}).saveOpenAiApiKey(k);}' +
      '</script>' +
    '</div>',
  ).setWidth(460).setHeight(240);
  SpreadsheetApp.getUi().showModalDialog(html, 'OpenAI configuration');
}

function saveOpenAiApiKey(key) {
  const value = String(key || '').trim();
  if (value.length < 20) throw new Error('The API key is too short');
  PropertiesService.getScriptProperties().setProperty('OPENAI_API_KEY', value);
  appendRunLog_('saveOpenAiApiKey', 0, 0, 0, 0, 'OpenAI key updated');
}

function setSqlSyncSecret() {
  const ui = SpreadsheetApp.getUi();
  const response = ui.prompt('SQL sync secret', 'Enter the dedicated KAudit GAS audit-sync HMAC secret. It is stored only in Apps Script Properties.', ui.ButtonSet.OK_CANCEL);
  if (response.getSelectedButton() !== ui.Button.OK) return;
  const value = String(response.getResponseText() || '').trim();
  if (value.length < 32) throw new Error('The SQL sync secret must be at least 32 characters');
  PropertiesService.getScriptProperties().setProperty('KAUDIT_GAS_AUDIT_SYNC_SECRET', value);
  appendRunLog_('setSqlSyncSecret', 0, 0, 0, 0, 'SQL sync secret updated');
}

function importKServeMonth() {
  withScriptLock_(function() {
    const settings = readSettings_();
    const source = SpreadsheetApp.openById(requiredSetting_(settings, 'SOURCE_SPREADSHEET_ID'));
    const sourceSheet = source.getSheetByName(requiredSetting_(settings, 'SOURCE_TAB_NAME'));
    if (!sourceSheet) throw new Error('Configured KServe source tab was not found');
    const headerRow = positiveInteger_(settings.SOURCE_HEADER_ROW, 'SOURCE_HEADER_ROW');
    const startRow = positiveInteger_(settings.SOURCE_START_ROW, 'SOURCE_START_ROW');
    const headers = sourceSheet.getRange(headerRow, 1, 1, BILL_AUDIT.sourceHeaders.length).getDisplayValues()[0];
    BILL_AUDIT.sourceHeaders.forEach(function(expected, index) {
      if (String(headers[index] || '').trim() !== expected) {
        throw new Error('KServe header mismatch at column ' + (index + 1) + ': expected ' + expected);
      }
    });
    const count = Math.max(0, sourceSheet.getLastRow() - startRow + 1);
    if (!count) return;
    const values = sourceSheet.getRange(startRow, 1, count, BILL_AUDIT.sourceHeaders.length).getValues();
    const display = sourceSheet.getRange(startRow, 1, count, BILL_AUDIT.sourceHeaders.length).getDisplayValues();
    const target = sheet_(BILL_AUDIT.sheets.monthly);
    const existing = existingIds_(target, 1);
    const datasetHash = sha256Hex_(JSON.stringify(display));
    const month = requiredSetting_(settings, 'ACTIVE_BILL_MONTH');
    const importedAt = new Date();
    const output = [];
    values.forEach(function(row, index) {
      const taskId = String(display[index][0] || '').trim();
      if (!taskId || existing[taskId]) return;
      const recordingUrl = String(display[index][9] || '').trim();
      output.push(row.slice(0, 11).concat([
        month,
        startRow + index,
        datasetHash,
        importedAt,
        'IMPORTED',
        recordingUrl ? BILL_AUDIT.queueStates.pending : BILL_AUDIT.queueStates.noRecording,
        'PENDING',
        '',
        '',
        '',
      ]));
      existing[taskId] = true;
    });
    appendRowsInChunks_(target, output, 21, 2000);
    appendRunLog_('importKServeMonth', output.length, output.length, 0, 0, 'KServe rows imported');
  });
}

function buildAuditQueue() {
  withScriptLock_(function() {
    const monthly = sheet_(BILL_AUDIT.sheets.monthly);
    const queue = sheet_(BILL_AUDIT.sheets.queue);
    const existing = existingIds_(queue, 1);
    const rowCount = dataRowCount_(monthly);
    if (!rowCount) return;
    const rows = monthly.getRange(BILL_AUDIT.firstDataRow, 1, rowCount, 21).getValues();
    const output = [];
    rows.forEach(function(row, index) {
      const taskId = String(row[0] || '').trim();
      const recordingUrl = String(row[9] || '').trim();
      if (!taskId) return;
      if (!recordingUrl) {
        writeFallbackBilling_(taskId, row, 'no_recording_zero', 'NO_RECORDING_FOUND');
        return;
      }
      if (existing[taskId]) return;
      output.push([
        taskId,
        row[11],
        Number(row[12]) || BILL_AUDIT.firstDataRow + index,
        BILL_AUDIT.queueStates.pending,
        0,
        '',
        '',
        '',
        recordingUrl,
        'QUEUED',
        '',
        '',
        new Date(),
      ]);
      existing[taskId] = true;
    });
    appendRowsInChunks_(queue, output, 13, 1000);
    appendRunLog_('buildAuditQueue', output.length, output.length, 0, 0, 'Recording-backed rows queued');
  });
}

function runAuditBatch() {
  withScriptLock_(function() {
    const props = PropertiesService.getScriptProperties();
    props.deleteProperty('BILL_AUDIT_STOPPED');
    const settings = readSettings_();
    const apiKey = props.getProperty('OPENAI_API_KEY');
    if (!apiKey) throw new Error('OpenAI key is not configured');
    const auditModel = configuredModel_(settings.AUDIT_MODEL, 'AUDIT_MODEL');
    const transcriptionModel = configuredModel_(settings.TRANSCRIPTION_MODEL, 'TRANSCRIPTION_MODEL');
    const batchSize = Math.min(20, positiveInteger_(settings.BATCH_SIZE, 'BATCH_SIZE'));
    const safeMinutes = Math.min(28, positiveNumber_(settings.SAFE_RUNTIME_MINUTES, 'SAFE_RUNTIME_MINUTES'));
    const deadline = Date.now() + safeMinutes * 60 * 1000;
    const queueSheet = sheet_(BILL_AUDIT.sheets.queue);
    const queueRows = dataRowCount_(queueSheet);
    if (!queueRows) return;
    const queue = queueSheet.getRange(BILL_AUDIT.firstDataRow, 1, queueRows, 13).getValues();
    const indexes = [];
    for (let i = 0; i < queue.length && indexes.length < batchSize; i += 1) {
      const state = String(queue[i][3] || '');
      const retryAt = queue[i][6] instanceof Date ? queue[i][6].getTime() : 0;
      if (state === BILL_AUDIT.queueStates.pending ||
          (state === BILL_AUDIT.queueStates.retry && retryAt <= Date.now())) {
        indexes.push(i);
      }
    }
    if (!indexes.length) {
      deleteContinuationTriggers_();
      appendRunLog_('runAuditBatch', 0, 0, 0, 0, 'No audit rows ready');
      finalizeCycleIfReady_();
      return;
    }
    const runId = Utilities.getUuid();
    indexes.forEach(function(index) {
      queue[index][3] = BILL_AUDIT.queueStates.running;
      queue[index][4] = Number(queue[index][4] || 0) + 1;
      queue[index][5] = new Date(Date.now() + safeMinutes * 60 * 1000);
      queue[index][7] = runId;
      queue[index][12] = new Date();
    });
    writeQueueRows_(queueSheet, queue, indexes);

    let completed = 0;
    let retrying = 0;
    let manual = 0;
    let failed = 0;
    for (let position = 0; position < indexes.length; position += 1) {
      const index = indexes[position];
      if (Date.now() > deadline - 30000) {
        queue[index][3] = BILL_AUDIT.queueStates.pending;
        queue[index][5] = '';
        queue[index][12] = new Date();
        writeQueueRows_(queueSheet, queue, [index]);
        continue;
      }
      try {
        const result = auditQueueItem_(queue[index], settings, apiKey, auditModel, transcriptionModel, runId);
        queue[index][3] = result.manualReview ? BILL_AUDIT.queueStates.unresolved : BILL_AUDIT.queueStates.completed;
        queue[index][9] = result.manualReview ? 'AUTHORITY_UNRESOLVED' : 'BILLING_CALCULATED';
        queue[index][10] = '';
        queue[index][11] = '';
        if (result.manualReview) manual += 1;
        else completed += 1;
      } catch (error) {
        const attempt = Number(queue[index][4] || 1);
        const classified = classifySafeError_(error);
        if (classified.terminal) {
          queue[index][3] = classified.state;
          failed += 1;
        } else if (attempt >= 3) {
          queue[index][3] = BILL_AUDIT.queueStates.unresolved;
          manual += 1;
        } else {
          queue[index][3] = BILL_AUDIT.queueStates.retry;
          queue[index][6] = new Date(Date.now() + Math.pow(2, attempt) * 5 * 60 * 1000);
          retrying += 1;
        }
        queue[index][10] = classified.code;
        queue[index][11] = classified.safeMessage;
      }
      queue[index][5] = '';
      queue[index][12] = new Date();
      writeQueueRows_(queueSheet, queue, [index]);
    }
    appendRunLog_('runAuditBatch', indexes.length, completed, retrying, manual + failed, 'Audit batch completed');
    scheduleContinuation_(settings);
    const remainingStates = queue.map(function(row) { return String(row[3] || ''); });
    if (!remainingStates.some(function(state) {
      return [BILL_AUDIT.queueStates.pending, BILL_AUDIT.queueStates.running, BILL_AUDIT.queueStates.retry].indexOf(state) >= 0;
    })) finalizeCycleIfReady_();
  });
}

function auditQueueItem_(queueRow, settings, apiKey, auditModel, transcriptionModel, runId) {
  const taskId = String(queueRow[0] || '').trim();
  const month = String(queueRow[1] || '').trim();
  const recordingUrl = String(queueRow[8] || '').trim();
  validateRecordingUrl_(recordingUrl);
  const response = UrlFetchApp.fetch(recordingUrl, {
    method: 'get',
    followRedirects: true,
    muteHttpExceptions: true,
  });
  if (response.getResponseCode() !== 200) {
    throw safeError_('RECORDING_FETCH_FAILED', 'Recording could not be downloaded', false);
  }
  const blob = response.getBlob();
  const bytes = blob.getBytes();
  if (bytes.length > BILL_AUDIT.maxAudioBytes) {
    throw safeError_('AUDIO_TOO_LARGE', 'Recording exceeds the transcription upload limit', true, BILL_AUDIT.queueStates.audioTooLarge);
  }
  const evidenceHash = bytesToHex_(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, bytes));
  const ext = audioExtension_(blob.getContentType());
  blob.setName(taskId + '-' + evidenceHash.slice(0, 12) + '.' + ext);
  const evidenceFile = saveEvidenceAudio_(settings, blob, taskId, evidenceHash);
  const transcript = transcribe_(apiKey, transcriptionModel, blob, promptText_('TRANSCRIPTION_GUIDANCE'));
  const monthly = monthlyRowByTaskId_(taskId);
  const connectedDurationMs = Math.max(0, Math.round(Number(monthly[6] || 0) * 1000));
  const recordedDurationMs = recordedDurationMs_(transcript);
  const durationMismatch = Math.abs(connectedDurationMs - recordedDurationMs) > 5000;
  const blocks = numberedBlocks_(transcript);
  const context = buildAuditContext_(taskId, month, queueRow, transcript, blocks, {
    connectedDurationMs: connectedDurationMs,
    recordedDurationMs: recordedDurationMs,
    durationMismatch: durationMismatch,
  });
  const primary = validateClassification_(
    classify_(apiKey, auditModel, promptText_('SYSTEM_CLASSIFIER'), context, 'call_audit_primary'),
    blocks,
    recordedDurationMs,
    durationMismatch,
    auditModel,
  );
  let second = null;
  let third = null;
  let consensus = singlePassConsensus_(primary, recordedDurationMs);
  let finalResult = consensus.selected;
  let adjudicationStatus = 'PRIMARY_ONLY';
  {
    second = validateClassification_(
      classify_(apiKey, auditModel, promptText_('SECOND_REVIEWER'), context, 'call_audit_second'),
      blocks,
      recordedDurationMs,
      durationMismatch,
      auditModel,
    );
    consensus = evaluateConsensus_([primary, second], recordedDurationMs);
    if (consensus.status === 'accepted') {
      adjudicationStatus = 'AGREED';
    } else if (
      consensus.reasons.length === 1 &&
      consensus.reasons[0] === 'CATEGORY_DISAGREEMENT'
    ) {
      third = validateClassification_(
        classify_(apiKey, auditModel, promptText_('ADJUDICATOR'), context, 'call_audit_adjudicator'),
        blocks,
        recordedDurationMs,
        durationMismatch,
        auditModel,
      );
      consensus = evaluateConsensus_([primary, second, third], recordedDurationMs);
      adjudicationStatus = consensus.status === 'accepted' ? 'ADJUDICATED' : 'UNRESOLVED';
    } else {
      adjudicationStatus = 'UNRESOLVED';
    }
    finalResult = consensus.selected;
  }
  const manualReview = consensus.status !== 'accepted' || !finalResult;
  writeAuditResult_(taskId, month, evidenceHash, primary, second, third, finalResult, consensus, adjudicationStatus,
    auditModel, settings, evidenceFile.getUrl(), transcript);
  if (finalResult && consensus.status === 'accepted') {
    writeBilling_(taskId, queueRow, finalResult, consensus, evidenceHash);
  } else {
    writeUnresolvedBilling_(taskId, monthly, consensus, evidenceHash);
  }
  writeEvidenceIndex_(taskId, month, recordingUrl, evidenceFile.getUrl(), evidenceHash, bytes.length);
  writeEvidenceJson_(settings, taskId, evidenceHash, runId, transcript, primary, second, third, finalResult, consensus);
  updateMonthlyAuditState_(taskId, manualReview ? BILL_AUDIT.queueStates.unresolved : BILL_AUDIT.queueStates.completed, runId, evidenceHash);
  return { manualReview: manualReview };
}

function transcribe_(apiKey, model, blob, guidance) {
  const payload = {
    model: model,
    file: blob,
  };
  if (model === 'gpt-4o-transcribe-diarize') {
    payload.response_format = 'diarized_json';
    payload.chunking_strategy = 'auto';
  } else if (model === 'whisper-1') {
    payload.prompt = guidance;
    payload.response_format = 'verbose_json';
    payload['timestamp_granularities[]'] = 'segment';
  } else {
    throw safeError_(
      'TIMESTAMPED_TRANSCRIPTION_REQUIRED',
      'Use gpt-4o-transcribe-diarize or whisper-1 so billing is based on timestamped evidence',
      true,
      BILL_AUDIT.queueStates.manual,
    );
  }
  const response = UrlFetchApp.fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'post',
    headers: { Authorization: 'Bearer ' + apiKey },
    payload: payload,
    muteHttpExceptions: true,
  });
  const parsed = parseApiResponse_(response, 'TRANSCRIPTION_FAILED');
  const text = String(parsed.text || '').trim();
  if (!text) throw safeError_('TRANSCRIPT_EMPTY', 'Transcription returned no text', false);
  const rawSegments = Array.isArray(parsed.segments) ? parsed.segments : [];
  const segments = rawSegments.map(function(segment) {
    return {
      start_seconds: Number(segment.start || 0),
      end_seconds: Number(segment.end || 0),
      speaker: String(segment.speaker || ''),
      text: String(segment.text || '').trim(),
    };
  }).filter(function(segment) {
    return segment.text && segment.end_seconds >= segment.start_seconds;
  });
  if (!segments.length) {
    throw safeError_(
      'TRANSCRIPT_TIMESTAMPS_MISSING',
      'Transcription returned no timestamped segments; manual review is required',
      true,
      BILL_AUDIT.queueStates.manual,
    );
  }
  return {
    text: text,
    language: String(parsed.language || 'unknown').trim().toLowerCase(),
    model: model,
    duration_seconds: Number(parsed.duration || segments[segments.length - 1].end_seconds || 0),
    segments: segments,
    timestamped_text: segments.map(function(segment) {
      const speaker = segment.speaker ? ' ' + segment.speaker : '';
      return '[' + segment.start_seconds + '-' + segment.end_seconds + ']' + speaker + ' ' + segment.text;
    }).join('\n'),
  };
}

function classify_(apiKey, model, instructions, input, schemaName) {
  return responseJson_(apiKey, model, instructions, input, schemaName, {
    type: 'object',
    additionalProperties: false,
    properties: {
      category_code: { type: 'string', enum: BILLING_POLICY.categories },
      confidence: { type: 'number', minimum: 0, maximum: 1 },
      language: { type: 'string' },
      customer_block_numbers: integerArraySchema_(),
      unclear_block_numbers: integerArraySchema_(),
      agent_block_numbers: integerArraySchema_(),
      voicemail_evidence_block_numbers: integerArraySchema_(),
      automation_evidence_block_numbers: integerArraySchema_(),
      junk_evidence_block_numbers: integerArraySchema_(),
      business_relevant_customer_block_numbers: integerArraySchema_(),
      counterparty_type: { type: 'string', enum: ['human','voicemail','interactive_automation','no_response','unclear'] },
      agent_handling: { type: 'string', enum: ['normal','failed','unclear'] },
      conversation_outcome: { type: 'string', enum: ['successful','no_outcome','unclear'] },
      duration_outcome: { type: 'string', enum: ['appropriate','ended_too_early','continued_without_value','unclear'] },
      stop_intent: { type: 'string', enum: ['none','busy_or_bad_time','callback_or_defer','decline_or_end'] },
      post_stop_behavior: { type: 'string', enum: ['not_applicable','appropriate_close','administrative_extension','continued_sales_flow','unclear'] },
      successful_outcome: { type: 'string', enum: ['none','qualified','handoff_or_transfer','resolved'] },
      voicemail_evidence: { type: 'string', enum: ['fixed_greeting','leave_message_request','mailbox_notice','recording_notice','beep','none'] },
      automation_evidence: { type: 'string', enum: ['menu_prompt','virtual_assistant_disclosure','screening_prompt','none'] },
      junk_evidence: { type: 'string', enum: ['test_call','spam_or_scam','prank_or_illegitimate_purpose','none'] },
      agent_failure_mode: { type: 'string', enum: ['none','start','mid_conversation'] },
      meaningful_service_before_failure: { type: 'boolean' },
      agent_failure_start_block_number: { type: 'integer', minimum: 0 },
      reasoning_summary: { type: 'string' },
      dispute_recommended: { type: 'boolean' },
    },
    required: [
      'category_code','confidence','language','customer_block_numbers','unclear_block_numbers',
      'agent_block_numbers','voicemail_evidence_block_numbers','automation_evidence_block_numbers',
      'junk_evidence_block_numbers','business_relevant_customer_block_numbers','counterparty_type',
      'agent_handling','conversation_outcome','duration_outcome','stop_intent','post_stop_behavior',
      'successful_outcome','voicemail_evidence','automation_evidence','junk_evidence',
      'agent_failure_mode','meaningful_service_before_failure','agent_failure_start_block_number',
      'reasoning_summary','dispute_recommended',
    ],
  });
}

function integerArraySchema_() {
  return { type: 'array', items: { type: 'integer', minimum: 1 } };
}

function responseJson_(apiKey, model, instructions, input, schemaName, schema) {
  const response = UrlFetchApp.fetch('https://api.openai.com/v1/responses', {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + apiKey },
    payload: JSON.stringify({
      model: model,
      instructions: instructions,
      input: input,
      store: false,
      text: {
        format: {
          type: 'json_schema',
          name: schemaName,
          strict: true,
          schema: schema,
        },
      },
    }),
    muteHttpExceptions: true,
  });
  const parsed = parseApiResponse_(response, 'OPENAI_RESPONSE_FAILED');
  const outputText = String(parsed.output_text || extractOutputText_(parsed) || '').trim();
  if (!outputText) throw safeError_('OPENAI_OUTPUT_EMPTY', 'AI returned no structured output', false);
  try {
    return JSON.parse(outputText);
  } catch (error) {
    throw safeError_('OPENAI_OUTPUT_INVALID', 'AI returned invalid structured output', false);
  }
}

function buildAuditContext_(taskId, month, queueRow, transcript, blocks, timing) {
  const rules = enabledRows_(BILL_AUDIT.sheets.rules, 11).map(function(row) {
    return { rule_id: row[0], category_code: row[1], priority: row[2], criteria: row[4], exclusions: row[5], billing_policy: row[6], grace_seconds: row[7], version: row[10] };
  });
  const knowledge = enabledRows_(BILL_AUDIT.sheets.knowledge, 8).map(function(row) {
    return { id: row[0], topic: row[3], content: row[4], version: row[1] };
  });
  return JSON.stringify({
    task_id: taskId,
    bill_month: month,
    source_row: queueRow[2],
    recorded_duration_ms: timing.recordedDurationMs,
    connected_duration_ms: timing.connectedDurationMs,
    duration_mismatch: timing.durationMismatch,
    rules: rules,
    knowledge_base: knowledge,
    numbered_transcript_blocks: blocks,
  });
}

function recordedDurationMs_(transcript) {
  const segments = Array.isArray(transcript.segments) ? transcript.segments : [];
  const finalEnd = segments.reduce(function(maximum, segment) {
    return Math.max(maximum, Math.round(Number(segment.end_seconds || 0) * 1000));
  }, 0);
  const declared = Math.round(Number(transcript.duration_seconds || 0) * 1000);
  const duration = Math.max(finalEnd, declared);
  if (!Number.isSafeInteger(duration) || duration <= 0) {
    throw safeError_('RECORDED_DURATION_INVALID', 'Decoded recording duration is unavailable', true, BILL_AUDIT.queueStates.unresolved);
  }
  return duration;
}

function numberedBlocks_(transcript) {
  const result = [];
  let current = null;
  (transcript.segments || []).forEach(function(segment) {
    const startMs = Math.max(0, Math.round(Number(segment.start_seconds || 0) * 1000));
    const endMs = Math.max(0, Math.round(Number(segment.end_seconds || 0) * 1000));
    const text = String(segment.text || '').trim();
    const split = current && (
      startMs - current.end_ms >= 1000 ||
      endMs - current.start_ms > 15000 ||
      current.text.length + text.length + 1 > 250
    );
    if (!current || split) {
      if (current) result.push(Object.assign({ number: result.length + 1 }, current));
      current = { start_ms: startMs, end_ms: endMs, text: text };
    } else {
      current.end_ms = endMs;
      current.text = current.text + (text ? ' ' + text : '');
    }
  });
  if (current) result.push(Object.assign({ number: result.length + 1 }, current));
  return result;
}

function normalizedBlockNumbers_(values, blockCount) {
  const seen = {};
  return (Array.isArray(values) ? values : []).filter(function(value) {
    const valid = Number.isInteger(value) && value >= 1 && value <= blockCount && !seen[value];
    if (valid) seen[value] = true;
    return valid;
  }).sort(function(left, right) { return left - right; });
}

function blockEnd_(blocks, numbers) {
  return blocks.reduce(function(maximum, block) {
    return numbers.indexOf(block.number) >= 0 ? Math.max(maximum, block.end_ms) : maximum;
  }, 0) || null;
}

function blockDuration_(blocks, numbers) {
  return blocks.reduce(function(total, block) {
    return numbers.indexOf(block.number) >= 0 ? total + Math.max(0, block.end_ms - block.start_ms) : total;
  }, 0);
}

function reviewedCategory_(raw, customerCount, agentCount, voicemailCount, automationCount, junkCount, durationMismatch) {
  const proposed = String(raw.category_code || '');
  const counterparty = String(raw.counterparty_type || 'unclear');
  if (counterparty === 'human' && customerCount === 0) {
    throw safeError_('CLASSIFICATION_CONTRADICTORY', 'Human counterparty requires customer speech', false);
  }
  if (['voicemail','interactive_automation','no_response'].indexOf(counterparty) >= 0 && customerCount > 0) {
    throw safeError_('CLASSIFICATION_CONTRADICTORY', 'Non-human counterparty cannot contain customer speech', false);
  }
  if (counterparty === 'voicemail') {
    return raw.voicemail_evidence !== 'none' && voicemailCount > 0 ? 'VOICEMAIL' : 'USER_SILENCE';
  }
  if (counterparty === 'interactive_automation') {
    if (raw.automation_evidence === 'none' || automationCount === 0 || agentCount === 0) {
      throw safeError_('CLASSIFICATION_CONTRADICTORY', 'AI-to-AI requires affirmative automation evidence', false);
    }
    return 'AI_TO_AI';
  }
  if (counterparty === 'no_response') return agentCount > 0 ? 'USER_SILENCE' : 'INACTIVE_CALL';
  if (proposed === 'JUNK_CALL') {
    if (raw.junk_evidence === 'none' || junkCount === 0) {
      throw safeError_('CLASSIFICATION_CONTRADICTORY', 'Junk call requires affirmative junk evidence', false);
    }
    return 'JUNK_CALL';
  }
  if (raw.junk_evidence !== 'none' || junkCount > 0) {
    throw safeError_('CLASSIFICATION_CONTRADICTORY', 'Junk evidence requires JUNK_CALL', false);
  }
  if (counterparty === 'human' && customerCount > 0 && agentCount === 0) return 'AGENT_FAILURE';
  if (customerCount === 0) return agentCount > 0 ? 'USER_SILENCE' : 'INACTIVE_CALL';
  if (raw.successful_outcome !== 'none' && raw.agent_handling === 'normal') return 'OK';
  if (raw.stop_intent !== 'none' && raw.post_stop_behavior === 'continued_sales_flow') return 'AGENT_FAILURE';
  if (raw.stop_intent !== 'none' && raw.post_stop_behavior === 'administrative_extension') return 'TIME_DURATION';
  if (raw.agent_handling === 'failed') return 'AGENT_FAILURE';
  if (counterparty === 'human' && raw.conversation_outcome === 'successful' && raw.agent_handling === 'normal') return 'OK';
  if (counterparty === 'human' && raw.stop_intent !== 'none' && raw.post_stop_behavior === 'appropriate_close' && raw.conversation_outcome === 'no_outcome') return 'CONNECT_NOT_FRUITFUL';
  if (raw.duration_outcome === 'ended_too_early' || raw.duration_outcome === 'continued_without_value') return 'TIME_DURATION';
  if (counterparty === 'human' && raw.conversation_outcome === 'no_outcome' && raw.agent_handling === 'normal') return 'CONNECT_NOT_FRUITFUL';
  if (proposed === 'INCORRECT_CALL_DURATION' && !durationMismatch) {
    throw safeError_('CLASSIFICATION_CONTRADICTORY', 'Duration category requires a verified mismatch', false);
  }
  return proposed;
}

function validateClassification_(raw, blocks, recordedDurationMs, durationMismatch, model) {
  if (BILLING_POLICY.categories.indexOf(String(raw.category_code || '')) < 0) {
    throw safeError_('CATEGORY_UNSUPPORTED', 'AI returned an unsupported category', false);
  }
  const confidence = Number(raw.confidence);
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    throw safeError_('CONFIDENCE_INVALID', 'AI returned an invalid confidence', false);
  }
  const customer = normalizedBlockNumbers_(raw.customer_block_numbers, blocks.length);
  const unclear = normalizedBlockNumbers_(raw.unclear_block_numbers, blocks.length);
  const agent = normalizedBlockNumbers_(raw.agent_block_numbers, blocks.length);
  const voicemail = normalizedBlockNumbers_(raw.voicemail_evidence_block_numbers, blocks.length);
  const automation = normalizedBlockNumbers_(raw.automation_evidence_block_numbers, blocks.length);
  const junk = normalizedBlockNumbers_(raw.junk_evidence_block_numbers, blocks.length);
  const business = normalizedBlockNumbers_(raw.business_relevant_customer_block_numbers, blocks.length)
    .filter(function(number) { return customer.indexOf(number) >= 0; });
  const overlap = customer.some(function(number) { return unclear.indexOf(number) >= 0 || agent.indexOf(number) >= 0; });
  if (overlap) throw safeError_('SPEAKER_ATTRIBUTION_CONTRADICTORY', 'Speaker attribution overlaps', false);
  let category = reviewedCategory_(raw, customer.length, agent.length, voicemail.length, automation.length, junk.length, durationMismatch);
  if (category === 'USER_SILENCE' && (customer.length > 0 || agent.length === 0)) {
    throw safeError_('USER_SILENCE_EVIDENCE_INVALID', 'User silence requires agent speech and no customer speech', false);
  }
  if (category === 'INACTIVE_CALL' && (customer.length > 0 || agent.length > 0)) {
    throw safeError_('INACTIVE_CALL_EVIDENCE_INVALID', 'Inactive call requires no customer or agent speech', false);
  }
  const failureBlockNumber = Number(raw.agent_failure_start_block_number || 0);
  const failureBlock = blocks.find(function(block) { return block.number === failureBlockNumber; });
  let agentFailureMode = category === 'AGENT_FAILURE' ? 'start' : null;
  let failureStartMs = null;
  let meaningfulService = false;
  if (category === 'AGENT_FAILURE' && raw.agent_failure_mode === 'mid_conversation' && failureBlock && failureBlock.start_ms > 0) {
    const customerBefore = blocks.some(function(block) { return customer.indexOf(block.number) >= 0 && block.end_ms <= failureBlock.start_ms; });
    const agentBefore = blocks.some(function(block) { return agent.indexOf(block.number) >= 0 && block.end_ms <= failureBlock.start_ms; });
    if (customerBefore && agentBefore) {
      agentFailureMode = 'mid_conversation';
      failureStartMs = Math.min(recordedDurationMs, failureBlock.start_ms);
      meaningfulService = true;
    }
  }
  const verified = customer.concat(agent, voicemail, automation, junk);
  return Object.assign({}, raw, {
    category_code: category,
    confidence: confidence,
    model: model,
    customer_block_numbers: customer,
    unclear_block_numbers: unclear,
    agent_block_numbers: agent,
    voicemail_evidence_block_numbers: voicemail,
    automation_evidence_block_numbers: automation,
    junk_evidence_block_numbers: junk,
    business_relevant_customer_block_numbers: business,
    customer_spoke: customer.length > 0,
    last_customer_exchange_ms: blockEnd_(blocks, customer),
    last_agent_exchange_ms: blockEnd_(blocks, agent),
    last_voicemail_exchange_ms: blockEnd_(blocks, voicemail),
    last_business_customer_exchange_ms: blockEnd_(blocks, business),
    last_verified_interaction_ms: blockEnd_(blocks, verified),
    customer_speech_ms: blockDuration_(blocks, customer),
    agent_speech_ms: blockDuration_(blocks, agent),
    speech_ms: blocks.reduce(function(total, block) { return total + Math.max(0, block.end_ms - block.start_ms); }, 0),
    recorded_duration_ms: recordedDurationMs,
    duration_mismatch: durationMismatch,
    agent_failure_mode: agentFailureMode,
    failure_start_ms: failureStartMs,
    meaningful_service_before_failure: meaningfulService,
  });
}

function boundedDurationDecision_(recordedDurationMs, policyCode, serviceEndMs, graceMs) {
  const end = serviceEndMs == null ? 0 : Math.min(recordedDurationMs, Math.max(0, Math.round(serviceEndMs)));
  return {
    policyCode: policyCode,
    serviceEndMs: end,
    graceMs: graceMs,
    adjustedChargeableDurationMs: Math.min(recordedDurationMs, end + graceMs),
  };
}

function categoryChargeDecision_(result, recordedDurationMs) {
  const category = result.category_code;
  if (['INACTIVE_CALL','AI_CONVERSATION_HANDLING','NETWORK_FAILURE_TELECOM'].indexOf(category) >= 0) {
    return boundedDurationDecision_(recordedDurationMs, 'MANAGEMENT_ZERO_CATEGORY', null, 0);
  }
  if (category === 'AGENT_FAILURE') {
    const start = result.failure_start_ms;
    const chargeable = result.agent_failure_mode === 'mid_conversation' &&
      result.meaningful_service_before_failure === true &&
      Number.isSafeInteger(start) && start > 0 && start <= recordedDurationMs;
    return chargeable
      ? boundedDurationDecision_(recordedDurationMs, 'AGENT_FAILURE_MID_CONVERSATION_PLUS_30S', start, BILLING_POLICY.agentFailureGraceMs)
      : boundedDurationDecision_(recordedDurationMs, 'MANAGEMENT_ZERO_CATEGORY', null, 0);
  }
  if (category === 'AI_TO_AI') {
    return boundedDurationDecision_(recordedDurationMs, 'AI_TO_AI_GRACE_ONLY', null, BILLING_POLICY.standardGraceMs);
  }
  if (category === 'USER_SILENCE') {
    return result.last_agent_exchange_ms == null
      ? boundedDurationDecision_(recordedDurationMs, 'NO_VERIFIED_CHARGEABLE_INTERACTION', null, 0)
      : boundedDurationDecision_(recordedDurationMs, 'USER_SILENCE_AGENT_PLUS_GRACE', result.last_agent_exchange_ms, BILLING_POLICY.standardGraceMs);
  }
  if (category === 'VOICEMAIL') {
    const serviceEnd = Math.max(result.last_agent_exchange_ms || 0, result.last_voicemail_exchange_ms || 0);
    return serviceEnd > 0
      ? boundedDurationDecision_(recordedDurationMs, 'VOICEMAIL_SERVICE_PLUS_30S', serviceEnd, BILLING_POLICY.voicemailGraceMs)
      : boundedDurationDecision_(recordedDurationMs, 'NO_VERIFIED_CHARGEABLE_INTERACTION', null, 0);
  }
  if (category === 'JUNK_CALL') {
    return result.last_business_customer_exchange_ms == null
      ? boundedDurationDecision_(recordedDurationMs, 'NO_VERIFIED_CHARGEABLE_INTERACTION', null, 0)
      : boundedDurationDecision_(recordedDurationMs, 'JUNK_BUSINESS_INTERACTION_PLUS_GRACE', result.last_business_customer_exchange_ms, BILLING_POLICY.standardGraceMs);
  }
  if (category === 'INCORRECT_CALL_DURATION') {
    return result.last_verified_interaction_ms == null
      ? boundedDurationDecision_(recordedDurationMs, 'NO_VERIFIED_CHARGEABLE_INTERACTION', null, 0)
      : boundedDurationDecision_(recordedDurationMs, 'VERIFIED_INTERACTION_PLUS_GRACE', result.last_verified_interaction_ms, BILLING_POLICY.standardGraceMs);
  }
  return result.last_customer_exchange_ms == null
    ? boundedDurationDecision_(recordedDurationMs, 'NO_VERIFIED_CHARGEABLE_INTERACTION', null, 0)
    : boundedDurationDecision_(recordedDurationMs, 'STANDARD_CUSTOMER_PLUS_GRACE', result.last_customer_exchange_ms, BILLING_POLICY.standardGraceMs);
}

function roundKserveDuration_(durationMs) {
  const adjusted = Math.max(0, Math.round(Number(durationMs || 0)));
  let halfMinutes;
  let ruleCode;
  if (adjusted === 0) {
    halfMinutes = 0;
    ruleCode = 'ZERO_DURATION_NOT_BILLED';
  } else if (adjusted < BILLING_POLICY.shortCallCutoffMs) {
    halfMinutes = 1;
    ruleCode = 'SHORT_CALL_FLAT';
  } else {
    halfMinutes = Math.ceil(adjusted / BILLING_POLICY.minuteMs) * 2;
    ruleCode = 'PER_MINUTE_CEIL';
  }
  return {
    billableDurationMs: halfMinutes * 30000,
    billableMinutes: halfMinutes / 2,
    amountPaise: halfMinutes * BILLING_POLICY.ratePaisePerMinute / 2,
    ruleCode: ruleCode,
  };
}

function projectedClassification_(classification, recordedDurationMs) {
  const decision = categoryChargeDecision_(classification, recordedDurationMs);
  const rounded = roundKserveDuration_(decision.adjustedChargeableDurationMs);
  return { classification: classification, decision: decision, rounded: rounded };
}

function singlePassConsensus_(classification, recordedDurationMs) {
  const projected = projectedClassification_(classification, recordedDurationMs);
  const accepted = classification.confidence >= BILLING_POLICY.validationThreshold;
  return {
    status: accepted ? 'accepted' : 'unresolved',
    reasons: accepted ? [] : ['WINNING_CONSENSUS_CONFIDENCE_BELOW_FLOOR'],
    selected: accepted ? classification : null,
    selectedDecision: accepted ? projected.decision : null,
    effectiveConfidence: classification.confidence,
    billableDurationMs: projected.rounded.billableDurationMs,
    version: BILLING_POLICY.validationVersion,
  };
}

function evaluateConsensus_(classifications, recordedDurationMs) {
  const projected = classifications.map(function(classification) {
    return projectedClassification_(classification, recordedDurationMs);
  });
  const groups = {};
  projected.forEach(function(item) {
    const key = [item.classification.category_code, item.classification.customer_spoke ? 'customer' : 'no-customer', item.rounded.billableDurationMs].join(':');
    if (!groups[key]) groups[key] = [];
    groups[key].push(item);
  });
  const winning = Object.keys(groups).map(function(key) { return groups[key]; })
    .filter(function(group) { return group.length >= 2; })
    .sort(function(left, right) { return right.length - left.length; })[0] || null;
  const reasons = [];
  if (!winning) {
    reasons.push('CATEGORY_DISAGREEMENT');
    if (new Set(projected.map(function(item) { return item.classification.customer_spoke; })).size > 1) reasons.push('CUSTOMER_SPEECH_DISAGREEMENT');
    if (new Set(projected.map(function(item) { return item.rounded.billableDurationMs; })).size > 1) reasons.push('BILLABLE_DURATION_DISAGREEMENT');
  } else if (winning.some(function(item) { return item.classification.confidence < BILLING_POLICY.validationThreshold; })) {
    reasons.push('WINNING_CONSENSUS_CONFIDENCE_BELOW_FLOOR');
  }
  const selectedProjection = reasons.length === 0 && winning ? winning[0] : null;
  const confidenceSource = winning || projected;
  return {
    status: reasons.length === 0 ? 'accepted' : 'unresolved',
    reasons: reasons,
    selected: selectedProjection ? selectedProjection.classification : null,
    selectedDecision: selectedProjection ? selectedProjection.decision : null,
    effectiveConfidence: Math.min.apply(null, confidenceSource.map(function(item) { return item.classification.confidence; })),
    billableDurationMs: selectedProjection ? selectedProjection.rounded.billableDurationMs : null,
    version: BILLING_POLICY.validationVersion,
  };
}

function writeAuditResult_(taskId, month, evidenceHash, primary, second, third, finalResult,
    consensus, adjudicationStatus, model, settings, evidenceUrl, transcript) {
  const selected = finalResult || primary;
  const chargeDecision = categoryChargeDecision_(selected, selected.recorded_duration_ms);
  const row = [
    taskId, month, evidenceHash, primary.language || '', primary.category_code || '',
    Number(primary.confidence || 0), Boolean(primary.customer_spoke),
    primary.agent_block_numbers.length > 0, String(primary.agent_failure_mode || ''),
    millisecondsToSeconds_(primary.last_customer_exchange_ms), millisecondsToSeconds_(primary.failure_start_ms),
    millisecondsToSeconds_(primary.speech_ms), millisecondsToSeconds_(primary.agent_speech_ms),
    millisecondsToSeconds_(primary.customer_speech_ms), 'See restricted evidence JSON', evidenceUrl, model,
    settings.PROMPT_VERSION, BILLING_POLICY.classifierVersion,
    second ? second.category_code : '', second ? Number(second.confidence || 0) : '',
    adjudicationStatus, new Date(), finalResult ? finalResult.category_code : '', finalResult ? Number(finalResult.confidence || 0) : '',
    third ? third.category_code : '', third ? Number(third.confidence || 0) : '',
    consensus.status, consensus.reasons.join('|'),
    JSON.stringify(selected.customer_block_numbers), JSON.stringify(selected.agent_block_numbers),
    JSON.stringify(selected.voicemail_evidence_block_numbers), JSON.stringify(selected.business_relevant_customer_block_numbers),
    millisecondsToSeconds_(selected.last_customer_exchange_ms), millisecondsToSeconds_(selected.last_agent_exchange_ms),
    millisecondsToSeconds_(selected.last_voicemail_exchange_ms), millisecondsToSeconds_(selected.last_business_customer_exchange_ms),
    millisecondsToSeconds_(selected.last_verified_interaction_ms), selected.agent_failure_mode || '',
    millisecondsToSeconds_(selected.failure_start_ms), Boolean(selected.meaningful_service_before_failure),
    chargeDecision.policyCode, millisecondsToSeconds_(selected.recorded_duration_ms),
  ];
  upsertByTaskId_(sheet_(BILL_AUDIT.sheets.results), row, 43);
}

function writeBilling_(taskId, queueRow, result, consensus, evidenceHash) {
  const monthly = monthlyRowByTaskId_(taskId);
  const connectedSeconds = Number(monthly[6] || 0);
  const decision = billingDecision_(result, result.recorded_duration_ms);
  const rounded = decision.rounded;
  const amount = rounded.amountPaise / 100;
  const kserveAmount = Number(monthly[8] || 0);
  const trace = calculationTrace_(taskId, result, decision, consensus, evidenceHash, 'independent_category_service_end');
  upsertByTaskId_(sheet_(BILL_AUDIT.sheets.billing), [
    taskId, result.category_code, connectedSeconds, millisecondsToSeconds_(decision.charge.serviceEndMs),
    result.agent_failure_mode || '', millisecondsToSeconds_(decision.charge.graceMs),
    millisecondsToSeconds_(decision.charge.adjustedChargeableDurationMs), rounded.billableMinutes,
    BILLING_POLICY.ratePaisePerMinute / 100, amount, kserveAmount, roundMoney_(kserveAmount - amount),
    rounded.ruleCode, BILLING_POLICY.rulesetVersion, 'NOT_REVIEWED',
    millisecondsToSeconds_(result.recorded_duration_ms), millisecondsToSeconds_(decision.charge.serviceEndMs),
    decision.charge.policyCode, 'independent_category_service_end', consensus.status,
    consensus.effectiveConfidence, evidenceHash, sha256Hex_(JSON.stringify(trace)), 'PENDING',
  ], 24);
}

function billingDecision_(result, recordedDurationMs) {
  const charge = categoryChargeDecision_(result, recordedDurationMs);
  return { charge: charge, rounded: roundKserveDuration_(charge.adjustedChargeableDurationMs) };
}

function calculationTrace_(taskId, result, decision, consensus, evidenceHash, basis) {
  return {
    schemaVersion: '2',
    taskId: taskId,
    engineVersion: BILLING_POLICY.engineVersion,
    rulesetVersion: BILLING_POLICY.rulesetVersion,
    rulesetSha256: BILLING_POLICY.rulesetSha256,
    categoryPolicyVersion: BILLING_POLICY.categoryPolicyVersion,
    categoryPolicySha256: BILLING_POLICY.categoryPolicySha256,
    classifierVersion: BILLING_POLICY.classifierVersion,
    classifierSha256: BILLING_POLICY.classifierSha256,
    validationVersion: BILLING_POLICY.validationVersion,
    evidenceSha256: evidenceHash,
    category: result.category_code,
    confidence: result.confidence,
    consensusStatus: consensus.status,
    consensusReasons: consensus.reasons,
    recordedDurationMs: result.recorded_duration_ms,
    serviceEndMs: decision.charge.serviceEndMs,
    graceMs: decision.charge.graceMs,
    adjustedChargeableDurationMs: decision.charge.adjustedChargeableDurationMs,
    categoryPolicyCode: decision.charge.policyCode,
    billableDurationMs: decision.rounded.billableDurationMs,
    billableMinutes: decision.rounded.billableMinutes,
    roundingRule: decision.rounded.ruleCode,
    amountPaise: decision.rounded.amountPaise,
    calculationBasis: basis,
  };
}

function writeUnresolvedBilling_(taskId, monthly, consensus, evidenceHash) {
  const vendorAmount = Number(monthly[8] || 0);
  upsertByTaskId_(sheet_(BILL_AUDIT.sheets.billing), [
    taskId, '', Number(monthly[6] || 0), '', '', '', '', '',
    BILLING_POLICY.ratePaisePerMinute / 100, '', vendorAmount, '',
    'AUTHORITY_UNRESOLVED', BILLING_POLICY.rulesetVersion, 'BLOCKED',
    '', '', '', 'unresolved', consensus.status, consensus.effectiveConfidence,
    evidenceHash, '', 'BLOCKED',
  ], 24);
}

function writeFallbackBilling_(taskId, monthly, basis, reason) {
  const noRecording = basis === 'no_recording_zero';
  const vendorMinutes = Number(monthly[7] || 0);
  if (!noRecording && (!Number.isFinite(vendorMinutes) || Math.abs(vendorMinutes * 2 - Math.round(vendorMinutes * 2)) > 1e-9)) {
    throw safeError_('VENDOR_MINUTES_INVALID', 'Vendor billed minutes must use 0.5-minute increments', true, BILL_AUDIT.queueStates.unresolved);
  }
  const hasSuppliedAmount = String(monthly[8] == null ? '' : monthly[8]).trim() !== '';
  const suppliedAmount = Number(monthly[8] || 0);
  const vendorAmount = hasSuppliedAmount && Number.isFinite(suppliedAmount)
    ? suppliedAmount
    : roundMoney_(vendorMinutes * BILLING_POLICY.ratePaisePerMinute / 100);
  const amount = noRecording ? 0 : vendorAmount;
  const trace = {
    schemaVersion: '1', taskId: taskId, calculationBasis: basis, reason: reason,
    vendorBilledMinutes: vendorMinutes, vendorBilledAmount: vendorAmount,
    amount: amount, rulesetVersion: BILLING_POLICY.rulesetVersion,
    rulesetSha256: BILLING_POLICY.rulesetSha256,
  };
  upsertByTaskId_(sheet_(BILL_AUDIT.sheets.billing), [
    taskId, '', Number(monthly[6] || 0), '', '', 0, noRecording ? 0 : '',
    noRecording ? 0 : vendorMinutes, BILLING_POLICY.ratePaisePerMinute / 100,
    amount, vendorAmount, roundMoney_(vendorAmount - amount),
    noRecording ? 'NO_RECORDING_ZERO' : 'ACCEPTED_AS_BILLED_UNVERIFIED',
    BILLING_POLICY.rulesetVersion, 'NOT_REVIEWED', '', '', '', basis,
    'final', 1, String(monthly[20] || ''), sha256Hex_(JSON.stringify(trace)), 'PENDING',
  ], 24);
}

function millisecondsToSeconds_(value) {
  return value == null || value === '' ? '' : Number(value) / 1000;
}

function roundMoney_(value) {
  return Math.round(Number(value || 0) * 100) / 100;
}

function writeEvidenceIndex_(taskId, month, sourceUrl, evidenceUrl, hash, byteCount) {
  upsertByTaskId_(sheet_(BILL_AUDIT.sheets.evidence), [
    taskId, month, sourceUrl, evidenceUrl, '', hash, '', byteCount, new Date(), 'ACTIVE', 'RESTRICTED',
  ], 11);
}

function saveEvidenceAudio_(settings, blob, taskId, evidenceHash) {
  const folder = DriveApp.getFolderById(requiredSetting_(settings, 'EVIDENCE_FOLDER_ID'));
  const name = taskId + '-' + evidenceHash.slice(0, 12) + '.' + audioExtension_(blob.getContentType());
  const existing = folder.getFilesByName(name);
  return existing.hasNext() ? existing.next() : folder.createFile(blob.copyBlob().setName(name));
}

function writeEvidenceJson_(settings, taskId, evidenceHash, runId, transcript, primary, second, third, finalResult, consensus) {
  const folder = DriveApp.getFolderById(requiredSetting_(settings, 'EVIDENCE_FOLDER_ID'));
  const name = taskId + '-' + evidenceHash.slice(0, 12) + '.audit.json';
  if (folder.getFilesByName(name).hasNext()) return;
  folder.createFile(name, JSON.stringify({
    task_id: taskId,
    evidence_sha256: evidenceHash,
    run_id: runId,
    transcript: transcript,
    primary: primary,
    second: second,
    third: third,
    final: finalResult,
    consensus: consensus,
    policy: BILLING_POLICY,
    created_at: new Date().toISOString(),
  }), 'application/json');
}

function retrySelectedRows() {
  const sheet = SpreadsheetApp.getActiveSheet();
  if (sheet.getName() !== BILL_AUDIT.sheets.queue) throw new Error('Select rows in AI Queue first');
  const range = sheet.getActiveRange();
  if (!range || range.getRow() < BILL_AUDIT.firstDataRow) throw new Error('Select one or more queue rows');
  const rowCount = range.getNumRows();
  const stateRange = sheet.getRange(range.getRow(), 4, rowCount, 10);
  const rows = stateRange.getValues();
  rows.forEach(function(row) {
    row[0] = BILL_AUDIT.queueStates.pending;
    row[2] = '';
    row[3] = '';
    row[6] = 'QUEUED';
    row[7] = '';
    row[8] = '';
    row[9] = new Date();
  });
  stateRange.setValues(rows);
  appendRunLog_('retrySelectedRows', rowCount, 0, rowCount, 0, 'Selected queue rows reset');
}

function stopAudit() {
  PropertiesService.getScriptProperties().setProperty('BILL_AUDIT_STOPPED', 'true');
  deleteContinuationTriggers_();
  appendRunLog_('stopAudit', 0, 0, 0, 0, 'Continuation triggers removed');
}

function reconcileMonth() {
  withScriptLock_(function() {
    const result = finalizeCycleIfReady_();
    SpreadsheetApp.flush();
    appendRunLog_('reconcileMonth', result.rows, result.finalized, 0, result.unresolved, result.message);
    SpreadsheetApp.getUi().alert(result.message);
  });
}

function finalizeCycleIfReady_() {
  const monthlySheet = sheet_(BILL_AUDIT.sheets.monthly);
  const monthlyCount = dataRowCount_(monthlySheet);
  const summary = sheet_('Summary');
  if (!monthlyCount) {
    summary.getRange('E10').setValue('NO_DATA');
    return { rows: 0, finalized: 0, unresolved: 0, message: 'No monthly rows are available.' };
  }
  const monthly = monthlySheet.getRange(BILL_AUDIT.firstDataRow, 1, monthlyCount, 21).getValues();
  const queueSheet = sheet_(BILL_AUDIT.sheets.queue);
  const queueCount = dataRowCount_(queueSheet);
  const queueRows = queueCount ? queueSheet.getRange(BILL_AUDIT.firstDataRow, 1, queueCount, 13).getValues() : [];
  const queueByTask = {};
  queueRows.forEach(function(row) { queueByTask[String(row[0] || '').trim()] = row; });
  const active = queueRows.filter(function(row) {
    return [BILL_AUDIT.queueStates.pending, BILL_AUDIT.queueStates.running, BILL_AUDIT.queueStates.retry].indexOf(String(row[3] || '')) >= 0;
  });
  if (active.length) {
    summary.getRange('E10').setValue('AUDIT_PENDING');
    return { rows: monthlyCount, finalized: 0, unresolved: active.length, message: 'Audit is still running or retrying. Final settlement remains withheld.' };
  }
  let finalized = 0;
  let unresolved = 0;
  monthly.forEach(function(row) {
    const taskId = String(row[0] || '').trim();
    if (!taskId) return;
    const recording = String(row[9] || '').trim();
    if (!recording) {
      writeFallbackBilling_(taskId, row, 'no_recording_zero', 'NO_RECORDING_FOUND');
      finalized += 1;
      return;
    }
    const queueRow = queueByTask[taskId];
    const state = queueRow ? String(queueRow[3] || '') : '';
    if (state === BILL_AUDIT.queueStates.completed && hasFinalIndependentBilling_(taskId)) {
      finalized += 1;
      return;
    }
    if ([BILL_AUDIT.queueStates.unresolved, BILL_AUDIT.queueStates.manual, BILL_AUDIT.queueStates.failed,
      BILL_AUDIT.queueStates.invalidRecording, BILL_AUDIT.queueStates.audioTooLarge].indexOf(state) >= 0) {
      const reason = state === BILL_AUDIT.queueStates.unresolved
        ? 'AUTOMATED_VALIDATION_UNRESOLVED'
        : 'INDEPENDENT_AUDIT_EXHAUSTED';
      writeFallbackBilling_(taskId, row, 'accepted_as_billed_unverified', reason);
      finalized += 1;
      return;
    }
    unresolved += 1;
  });
  if (unresolved > 0) {
    summary.getRange('E10').setValue('CALCULATION_PENDING');
    return { rows: monthlyCount, finalized: finalized, unresolved: unresolved, message: 'Some calls still lack an explicit billing resolution. Final settlement remains withheld.' };
  }
  const settings = readSettings_();
  const month = String(settings.ACTIVE_BILL_MONTH || '');
  const invoice = invoiceApproval_(month);
  if (invoice !== 'APPROVED') {
    summary.getRange('E10').setValue('INVOICE_PENDING');
    return { rows: monthlyCount, finalized: finalized, unresolved: 0, message: 'Every call has a resolution, but the invoice is not approved. Final settlement remains withheld.' };
  }
  if (truthy_(settings.SQL_SYNC_ENABLED) && pendingSqlSyncCount_() > 0) {
    summary.getRange('E10').setValue('SQL_PENDING');
    return { rows: monthlyCount, finalized: finalized, unresolved: 0, message: 'Calculations are complete, but SQL synchronization is pending. Final settlement remains withheld.' };
  }
  summary.getRange('E10').setValue('READY');
  return { rows: monthlyCount, finalized: finalized, unresolved: 0, message: 'The month is fully resolved and ready for final settlement review.' };
}

function hasFinalIndependentBilling_(taskId) {
  const billing = sheet_(BILL_AUDIT.sheets.billing);
  const count = dataRowCount_(billing);
  if (!count) return false;
  const match = billing.getRange(BILL_AUDIT.firstDataRow, 1, count, 1).createTextFinder(taskId).matchEntireCell(true).findNext();
  if (!match) return false;
  const row = billing.getRange(match.getRow(), 1, 1, 24).getValues()[0];
  return row[18] === 'independent_category_service_end' && row[19] === 'accepted' && row[13] === BILLING_POLICY.rulesetVersion;
}

function invoiceApproval_(month) {
  const sheet = sheet_(BILL_AUDIT.sheets.invoice);
  const count = dataRowCount_(sheet);
  if (!count) return 'NOT_REGISTERED';
  const rows = sheet.getRange(BILL_AUDIT.firstDataRow, 1, count, 14).getDisplayValues();
  const match = rows.find(function(row) { return String(row[0] || '').trim() === month; });
  return match ? String(match[13] || 'NOT_REVIEWED') : 'NOT_REGISTERED';
}

function pendingSqlSyncCount_() {
  const billing = sheet_(BILL_AUDIT.sheets.billing);
  const count = dataRowCount_(billing);
  if (!count) return 0;
  return billing.getRange(BILL_AUDIT.firstDataRow, 24, count, 1).getDisplayValues().filter(function(row) {
    return String(row[0] || '') !== 'SYNCED';
  }).length;
}

function syncPendingResults() {
  withScriptLock_(function() {
    const settings = readSettings_();
    if (!truthy_(settings.SQL_SYNC_ENABLED)) {
      throw new Error('SQL_SYNC_ENABLED is false. Enable it only after the signed server endpoint is configured.');
    }
    const secret = PropertiesService.getScriptProperties().getProperty('KAUDIT_GAS_AUDIT_SYNC_SECRET');
    if (!secret || secret.length < 32) throw new Error('SQL sync secret is not configured');
    const billing = sheet_(BILL_AUDIT.sheets.billing);
    const count = dataRowCount_(billing);
    if (!count) return;
    const rows = billing.getRange(BILL_AUDIT.firstDataRow, 1, count, 24).getValues();
    const indexes = [];
    const items = [];
    const limit = Math.min(20, positiveInteger_(settings.BATCH_SIZE || 5, 'BATCH_SIZE'));
    for (let index = 0; index < rows.length && items.length < limit; index += 1) {
      const row = rows[index];
      const basis = String(row[18] || '');
      if (String(row[23] || '') === 'SYNCED' || ['independent_category_service_end','accepted_as_billed_unverified','no_recording_zero'].indexOf(basis) < 0) continue;
      const taskId = String(row[0] || '').trim();
      const monthly = monthlyRowByTaskId_(taskId);
      const evidenceHash = String(row[21] || monthly[20] || '');
      const audit = basis === 'independent_category_service_end'
        ? readEvidenceJson_(settings, taskId, evidenceHash)
        : null;
      items.push({
        task_id: taskId,
        bill_month: String(monthly[11] || settings.ACTIVE_BILL_MONTH || ''),
        evidence_sha256: evidenceHash,
        calculation_basis: basis,
        vendor_billed_minutes: String(monthly[7] == null ? '' : monthly[7]),
        vendor_billed_amount: String(monthly[8] == null ? '' : monthly[8]),
        billing: {
          category: row[1], service_end_seconds: row[16], grace_seconds: row[5],
          adjusted_chargeable_seconds: row[6], billable_minutes: row[7],
          amount_inr: row[9], rounding_rule: row[12], category_policy_code: row[17],
          ruleset_version: row[13], consensus_status: row[19], confidence: row[20],
          decision_trace_sha256: row[22],
        },
        audit: audit,
      });
      indexes.push(index);
    }
    if (!items.length) {
      appendRunLog_('syncPendingResults', 0, 0, 0, 0, 'No final results pending SQL sync');
      return;
    }
    const path = '/api/v1/imports/gas-audit-results';
    const body = JSON.stringify({
      schema_version: '1',
      batch_id: Utilities.getUuid(),
      bill_month: String(settings.ACTIVE_BILL_MONTH || ''),
      items: items,
    });
    const timestamp = String(Date.now());
    const bodyHash = sha256Hex_(body);
    const parsedBody = JSON.parse(body);
    const signingPayload = ['POST', path, timestamp, bodyHash, parsedBody.bill_month, parsedBody.batch_id].join('\n');
    const signature = bytesToHex_(Utilities.computeHmacSha256Signature(signingPayload, secret, Utilities.Charset.UTF_8));
    const response = UrlFetchApp.fetch(requiredSetting_(settings, 'API_BASE_URL').replace(/\/$/, '') + path, {
      method: 'post',
      contentType: 'application/json; charset=utf-8',
      payload: body,
      muteHttpExceptions: true,
      followRedirects: false,
      headers: {
        'X-Kaudit-Audit-Sync-Timestamp': timestamp,
        'X-Kaudit-Content-Sha256': bodyHash,
        'X-Kaudit-Audit-Sync-Signature': signature,
        'X-Kaudit-Bill-Month': parsedBody.bill_month,
        'X-Kaudit-Batch-Id': parsedBody.batch_id,
      },
    });
    if (response.getResponseCode() !== 200) {
      throw safeError_('SQL_SYNC_FAILED', 'SQL sync failed with HTTP ' + response.getResponseCode(), false);
    }
    const receipt = JSON.parse(response.getContentText() || '{}');
    if (!Array.isArray(receipt.items) || receipt.items.length !== items.length) {
      throw safeError_('SQL_SYNC_RECEIPT_INVALID', 'SQL sync returned an invalid receipt', false);
    }
    receipt.items.forEach(function(item, position) {
      const status = String(item.status || '');
      rows[indexes[position]][23] = status === 'imported' || status === 'duplicate' ? 'SYNCED' : 'FAILED';
    });
    indexes.forEach(function(index) {
      billing.getRange(BILL_AUDIT.firstDataRow + index, 24).setValue(rows[index][23]);
      updateMonthlySqlState_(String(rows[index][0] || ''), rows[index][23]);
    });
    appendRunLog_('syncPendingResults', items.length, indexes.filter(function(index) { return rows[index][23] === 'SYNCED'; }).length, 0, indexes.filter(function(index) { return rows[index][23] !== 'SYNCED'; }).length, 'Signed final results synchronized');
    finalizeCycleIfReady_();
  });
}

function readEvidenceJson_(settings, taskId, evidenceHash) {
  const folder = DriveApp.getFolderById(requiredSetting_(settings, 'EVIDENCE_FOLDER_ID'));
  const name = taskId + '-' + evidenceHash.slice(0, 12) + '.audit.json';
  const files = folder.getFilesByName(name);
  if (!files.hasNext()) throw safeError_('EVIDENCE_JSON_MISSING', 'Restricted audit evidence package is missing', true, BILL_AUDIT.queueStates.unresolved);
  return JSON.parse(files.next().getBlob().getDataAsString('UTF-8'));
}

function updateMonthlySqlState_(taskId, state) {
  const monthly = sheet_(BILL_AUDIT.sheets.monthly);
  const count = dataRowCount_(monthly);
  if (!count) return;
  const match = monthly.getRange(BILL_AUDIT.firstDataRow, 1, count, 1).createTextFinder(taskId).matchEntireCell(true).findNext();
  if (match) monthly.getRange(match.getRow(), 18).setValue(state);
}

function readSettings_() {
  const sheet = sheet_(BILL_AUDIT.sheets.settings);
  const count = dataRowCount_(sheet);
  const values = count ? sheet.getRange(BILL_AUDIT.firstDataRow, 1, count, 2).getValues() : [];
  return values.reduce(function(result, row) {
    const key = String(row[0] || '').trim();
    if (key) result[key] = row[1];
    return result;
  }, {});
}

function promptText_(key) {
  const rows = sheet_(BILL_AUDIT.sheets.prompts).getDataRange().getValues();
  for (let i = BILL_AUDIT.headerRow; i < rows.length; i += 1) {
    if (String(rows[i][0] || '').trim() === key && truthy_(rows[i][2])) return String(rows[i][4] || '');
  }
  throw new Error('Enabled prompt not found: ' + key);
}

function enabledRows_(sheetName, width) {
  const sheet = sheet_(sheetName);
  const count = dataRowCount_(sheet);
  if (!count) return [];
  return sheet.getRange(BILL_AUDIT.firstDataRow, 1, count, width).getValues().filter(function(row) {
    return truthy_(row[3] !== undefined && sheetName === BILL_AUDIT.sheets.rules ? row[3] : row[2]);
  });
}

function monthlyRowByTaskId_(taskId) {
  const sheet = sheet_(BILL_AUDIT.sheets.monthly);
  const count = dataRowCount_(sheet);
  if (!count) throw new Error('Monthly Input is empty');
  const finder = sheet.getRange(BILL_AUDIT.firstDataRow, 1, count, 1).createTextFinder(taskId).matchEntireCell(true).findNext();
  if (!finder) throw new Error('Task ID is missing from Monthly Input');
  return sheet.getRange(finder.getRow(), 1, 1, 21).getValues()[0];
}

function updateMonthlyAuditState_(taskId, state, runId, evidenceHash) {
  const sheet = sheet_(BILL_AUDIT.sheets.monthly);
  const count = dataRowCount_(sheet);
  const finder = sheet.getRange(BILL_AUDIT.firstDataRow, 1, count, 1).createTextFinder(taskId).matchEntireCell(true).findNext();
  if (!finder) return;
  sheet.getRange(finder.getRow(), 17, 1, 5).setValues([[state, 'PENDING', '', runId, evidenceHash]]);
}

function upsertByTaskId_(sheet, row, width) {
  const count = dataRowCount_(sheet);
  let targetRow = BILL_AUDIT.firstDataRow + count;
  if (count) {
    const match = sheet.getRange(BILL_AUDIT.firstDataRow, 1, count, 1)
      .createTextFinder(String(row[0])).matchEntireCell(true).findNext();
    if (match) targetRow = match.getRow();
  }
  ensureSheetCapacity_(sheet, targetRow, width);
  sheet.getRange(targetRow, 1, 1, width).setValues([row]);
}

function existingIds_(sheet, column) {
  const count = dataRowCount_(sheet);
  if (!count) return {};
  return sheet.getRange(BILL_AUDIT.firstDataRow, column, count, 1).getDisplayValues().reduce(function(result, row) {
    const value = String(row[0] || '').trim();
    if (value) result[value] = true;
    return result;
  }, {});
}

function appendRowsInChunks_(sheet, rows, width, chunkSize) {
  let start = sheet.getLastRow() + 1;
  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize);
    ensureSheetCapacity_(sheet, start + chunk.length - 1, width);
    sheet.getRange(start, 1, chunk.length, width).setValues(chunk);
    start += chunk.length;
  }
}

function ensureSheetCapacity_(sheet, requiredLastRow, requiredLastColumn) {
  const missingRows = Number(requiredLastRow || 0) - sheet.getMaxRows();
  if (missingRows > 0) {
    sheet.insertRowsAfter(
      sheet.getMaxRows(),
      Math.max(BILL_AUDIT.capacityGrowthRows, missingRows),
    );
  }
  const missingColumns = Number(requiredLastColumn || 0) - sheet.getMaxColumns();
  if (missingColumns > 0) {
    sheet.insertColumnsAfter(sheet.getMaxColumns(), missingColumns);
  }
}

function writeQueueRows_(sheet, allRows, indexes) {
  indexes.forEach(function(index) {
    sheet.getRange(BILL_AUDIT.firstDataRow + index, 1, 1, 13).setValues([allRows[index]]);
  });
}

function appendRunLog_(functionName, claimed, completed, retrying, failed, safeMessage) {
  const settings = readSettings_();
  sheet_(BILL_AUDIT.sheets.log).appendRow([
    Utilities.getUuid(), new Date(), new Date(), functionName,
    settings.ACTIVE_BILL_MONTH || '', claimed, completed, retrying, 0, failed,
    settings.AUDIT_MODEL || '', settings.RULESET_VERSION || '', settings.PROMPT_VERSION || '', safeMessage,
  ]);
}

function updateAutomationState_(state) {
  const sheet = sheet_(BILL_AUDIT.sheets.automation);
  const count = dataRowCount_(sheet);
  if (count) sheet.getRange(BILL_AUDIT.firstDataRow, 6, count, 1).setValue(state);
}

function validateRecordingUrl_(url) {
  const value = String(url || '').trim();
  const prefix = 'https://';
  if (value.slice(0, prefix.length).toLowerCase() !== prefix) {
    throw safeError_('RECORDING_URL_INVALID', 'Recording URL is invalid', true, BILL_AUDIT.queueStates.invalidRecording);
  }
  const remainder = value.slice(prefix.length);
  let boundary = remainder.length;
  ['/', '?', '#'].forEach(function(separator) {
    const index = remainder.indexOf(separator);
    if (index >= 0 && index < boundary) boundary = index;
  });
  const authority = remainder.slice(0, boundary).toLowerCase();
  if (!authority || authority.indexOf('@') >= 0 || authority.indexOf(':') >= 0) {
    throw safeError_('RECORDING_HOST_NOT_ALLOWED', 'Recording host is not allowlisted', true, BILL_AUDIT.queueStates.invalidRecording);
  }
  const host = authority.endsWith('.') ? authority.slice(0, -1) : authority;
  if (!(host === 'unpod.ai' || host.endsWith('.unpod.ai'))) {
    throw safeError_('RECORDING_HOST_NOT_ALLOWED', 'Recording host is not allowlisted', true, BILL_AUDIT.queueStates.invalidRecording);
  }
}

function scheduleContinuation_(settings) {
  deleteContinuationTriggers_();
  const queue = sheet_(BILL_AUDIT.sheets.queue);
  const count = dataRowCount_(queue);
  if (!count) return;
  const states = queue.getRange(BILL_AUDIT.firstDataRow, 4, count, 1).getDisplayValues().flat();
  const pending = states.some(function(state) {
    return state === BILL_AUDIT.queueStates.pending || state === BILL_AUDIT.queueStates.retry;
  });
  if (!pending) return;
  const minutes = Math.max(1, Math.min(30, positiveInteger_(settings.TRIGGER_INTERVAL_MINUTES, 'TRIGGER_INTERVAL_MINUTES')));
  ScriptApp.newTrigger('runAuditBatch').timeBased().after(minutes * 60 * 1000).create();
}

function deleteContinuationTriggers_() {
  ScriptApp.getProjectTriggers().forEach(function(trigger) {
    if (trigger.getHandlerFunction() === 'runAuditBatch') ScriptApp.deleteTrigger(trigger);
  });
}

function withScriptLock_(fn) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) throw new Error('Another Bill Audit operation is running');
  try { return fn(); } finally { lock.releaseLock(); }
}

function sheet_(name) {
  const sheet = SpreadsheetApp.getActive().getSheetByName(name);
  if (!sheet) throw new Error('Missing sheet: ' + name);
  return sheet;
}

function dataRowCount_(sheet) {
  const availableRows = sheet.getMaxRows() - BILL_AUDIT.headerRow;
  if (availableRows <= 0) return 0;
  const lastTask = sheet.getRange(BILL_AUDIT.firstDataRow, 1, availableRows, 1)
    .createTextFinder('.+')
    .useRegularExpression(true)
    .findPrevious();
  return lastTask ? lastTask.getRow() - BILL_AUDIT.headerRow : 0;
}

function requiredSetting_(settings, key) {
  const value = String(settings[key] || '').trim();
  if (!value) throw new Error('Missing setting: ' + key);
  return value;
}

function configuredModel_(value, key) {
  const model = String(value || '').trim();
  if (!model || /^set before/i.test(model)) throw new Error(key + ' must be configured in Settings');
  return model;
}

function positiveInteger_(value, key) {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) throw new Error(key + ' must be a positive integer');
  return number;
}

function positiveNumber_(value, key) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) throw new Error(key + ' must be positive');
  return number;
}

function truthy_(value) {
  return value === true || String(value).toLowerCase() === 'true' || String(value) === '1' || String(value).toLowerCase() === 'yes';
}

function sha256Hex_(value) {
  return bytesToHex_(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(value), Utilities.Charset.UTF_8));
}

function bytesToHex_(bytes) {
  return bytes.map(function(value) { return ('0' + (value & 255).toString(16)).slice(-2); }).join('');
}

function audioExtension_(contentType) {
  const type = String(contentType || '').toLowerCase();
  if (type.indexOf('ogg') >= 0) return 'ogg';
  if (type.indexOf('wav') >= 0) return 'wav';
  if (type.indexOf('mp4') >= 0 || type.indexOf('m4a') >= 0) return 'm4a';
  if (type.indexOf('webm') >= 0) return 'webm';
  return 'mp3';
}

function parseApiResponse_(response, code) {
  const status = response.getResponseCode();
  let parsed = {};
  try { parsed = JSON.parse(response.getContentText()); } catch (error) {}
  if (status < 200 || status >= 300) {
    const apiCode = parsed && parsed.error && parsed.error.code ? String(parsed.error.code) : code;
    throw safeError_(apiCode, 'External AI request failed with HTTP ' + status, false);
  }
  return parsed;
}

function extractOutputText_(response) {
  const output = Array.isArray(response.output) ? response.output : [];
  for (let i = 0; i < output.length; i += 1) {
    const content = Array.isArray(output[i].content) ? output[i].content : [];
    for (let j = 0; j < content.length; j += 1) {
      if (content[j].type === 'output_text' && content[j].text) return content[j].text;
    }
  }
  return '';
}

function normaliseAdjudication_(adjudicated, fallback) {
  return Object.assign({}, fallback, {
    category_code: adjudicated.final_category_code || 'MANUAL_REVIEW',
    confidence: Number(adjudicated.confidence || 0),
    reasoning_summary: adjudicated.adjudication_reason || '',
  });
}

function safeError_(code, message, terminal, state) {
  const error = new Error(message);
  error.safeCode = code;
  error.safeMessage = message;
  error.terminal = Boolean(terminal);
  error.state = state || BILL_AUDIT.queueStates.failed;
  return error;
}

function classifySafeError_(error) {
  return {
    code: String(error.safeCode || 'AUDIT_FAILED').slice(0, 64),
    safeMessage: String(error.safeMessage || 'Audit failed and will be retried').slice(0, 300),
    terminal: Boolean(error.terminal),
    state: error.state || BILL_AUDIT.queueStates.failed,
  };
}
