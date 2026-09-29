/**
 * Sheet-to-KAudit audit dispatcher.
 *
 * Install this file beside usage-import.gs and run setupKauditAuditTabs()
 * once. Three tabs (New Month, Late Recording, Re-audit) are served by one
 * trigger; each run takes turns between the tabs so they progress together.
 * Provider credentials stay in Vercel. The Sheet keeps only bounded lifecycle
 * state and signs each exact 1–3 item request with the audit-sync secret.
 */
const KAUDIT_SERVER_AUDIT = Object.freeze({
  endpointPath: '/api/v1/reconciliation/batch',
  batchSize: 3,
  defaultParallelBatches: 4,
  maxParallelBatches: 8,
  triggerMinutes: 1,
  // Tab name picks the mode (see kauditAuditMode_), so rows need no mode cell.
  tabs: Object.freeze({
    newMonth: 'New Month',
    lateRecording: 'Late Recording',
    reaudit: 'Re-audit',
  }),
  modes: Object.freeze(['new_month', 'late_recording', 'transcript_reaudit']),
  headers: Object.freeze({
    taskId: 'Task ID',
    recordingUrl: 'Recording URL',
    importStatus: 'Import Status',
    mode: 'Kaudit Audit Mode',
    billMonth: 'Kaudit Bill Month',
    status: 'Kaudit Audit Status',
    stage: 'Kaudit Audit Stage',
    error: 'Kaudit Audit Error',
    batchId: 'Kaudit Audit Batch ID',
    attempt: 'Kaudit Audit Attempt',
    updatedAt: 'Kaudit Audit Updated At',
    amount: 'Kaudit Revised Amount',
  }),
});

/**
 * Processes a bounded set of Sheet rows. First attempts always drain before
 * final retries, so failures are re-hit only after the remaining base rows.
 */
function runKauditServerAuditBatches() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) {
    console.log(JSON.stringify({ event: 'kaudit_server_audit_skipped', reason: 'locked' }));
    return;
  }
  try {
    const config = kauditAuditConfig_();
    const contexts = kauditAuditContexts_(config);
    if (!contexts.length) return;

    let batches = kauditAuditInitialBatches_(contexts, config.parallelBatches);
    let pass = 'initial';
    if (!batches.length) {
      batches = kauditAuditRetryBatches_(contexts, config.parallelBatches);
      pass = 'final_retry';
    }
    if (!batches.length) {
      kauditAuditFlush_(contexts);
      console.log(JSON.stringify({ event: 'kaudit_server_audit_complete' }));
      return;
    }

    batches.forEach(function(batch) {
      const batchId = batch.batchId || kauditAuditBatchId_();
      batch.batchId = batchId;
      batch.rows.forEach(function(ref) {
        kauditAuditSet_(ref, 'batchId', batchId);
        kauditAuditSet_(ref, 'attempt', Number(kauditAuditGet_(ref, 'attempt') || 0) + 1);
        kauditAuditSet_(ref, 'status', 'RUNNING');
        kauditAuditSet_(ref, 'stage', 'upload');
        kauditAuditSet_(ref, 'error', '');
        kauditAuditSet_(ref, 'updatedAt', new Date().toISOString());
      });
      batch.request = kauditAuditSignedRequest_(config, batch);
    });
    kauditAuditFlush_(contexts);
    SpreadsheetApp.flush();

    let responses;
    try {
      responses = UrlFetchApp.fetchAll(batches.map(function(batch) {
        return batch.request;
      }));
    } catch (error) {
      batches.forEach(function(batch) {
        kauditAuditMarkTransportFailure_(batch, 'NETWORK_REQUEST_FAILED');
      });
      kauditAuditFlush_(contexts);
      console.log(JSON.stringify({
        event: 'kaudit_server_audit_run', pass: pass,
        batches: batches.length, state: 'retry_pending',
      }));
      return;
    }

    responses.forEach(function(response, index) {
      kauditAuditApplyResponse_(batches[index], response);
    });
    kauditAuditFlush_(contexts);
    console.log(JSON.stringify({
      event: 'kaudit_server_audit_run', pass: pass,
      batches: batches.length,
      rows: batches.reduce(function(total, batch) { return total + batch.rows.length; }, 0),
    }));
  } finally {
    lock.releaseLock();
  }
}

/** Make selected failed rows eligible for one supervised retry. */
function retrySelectedKauditServerAudits() {
  const sheet = SpreadsheetApp.getActiveSheet();
  const range = sheet.getActiveRange();
  if (!range) throw new Error('Select one or more failed audit rows first');
  const context = kauditAuditContext_(sheet, kauditAuditConfig_());
  const first = Math.max(range.getRow(), context.headerRow + 1);
  const last = Math.min(range.getLastRow(), sheet.getLastRow());
  if (last < first) throw new Error('Select one or more data rows first');
  for (let sheetRow = first; sheetRow <= last; sheetRow += 1) {
    const ref = { context: context, index: sheetRow - context.headerRow - 1 };
    const status = String(kauditAuditGet_(ref, 'status') || '').toUpperCase();
    if (status !== 'FAILED' && status !== 'RETRYABLE') continue;
    const hasBatch = String(kauditAuditGet_(ref, 'batchId') || '').trim() !== '';
    kauditAuditSet_(ref, 'status', hasBatch ? 'RETRYABLE' : 'PENDING');
    kauditAuditSet_(ref, 'attempt', hasBatch ? 1 : 0);
    kauditAuditSet_(ref, 'error', '');
  }
  kauditAuditFlush_([context]);
  runKauditServerAuditBatches();
}

/**
 * Creates or repairs the three audit tabs: headers, text month column, frozen
 * header and status colours. Never clears or queues rows; a conflicting
 * existing header stops it before that tab is written.
 */
function setupKauditAuditTabs() {
  if (typeof KAUDIT_USAGE_HEADERS === 'undefined') {
    throw new Error('Add usage-import.gs to this Apps Script project first');
  }
  const h = KAUDIT_SERVER_AUDIT.headers;
  const lifecycle = [h.status, h.stage, h.error, h.batchId, h.attempt, h.updatedAt, h.amount];
  const tabs = KAUDIT_SERVER_AUDIT.tabs;
  const layouts = {};
  // New Month keeps the importer's locked A:J + K layout.
  layouts[tabs.newMonth] = KAUDIT_USAGE_HEADERS.concat([h.importStatus, h.billMonth], lifecycle);
  layouts[tabs.lateRecording] = [h.taskId, h.recordingUrl, h.billMonth].concat(lifecycle);
  layouts[tabs.reaudit] = [h.taskId, h.billMonth].concat(lifecycle);
  const spreadsheet = SpreadsheetApp.getActive();
  Object.keys(layouts).forEach(function(name) {
    kauditAuditSetupTab_(spreadsheet, name, layouts[name]);
  });
}

function kauditAuditSetupTab_(spreadsheet, name, expected) {
  const h = KAUDIT_SERVER_AUDIT.headers;
  const sheet = spreadsheet.getSheetByName(name) || spreadsheet.insertSheet(name);
  if (sheet.getMaxColumns() < expected.length) {
    sheet.insertColumnsAfter(sheet.getMaxColumns(), expected.length - sheet.getMaxColumns());
  }
  if (sheet.getMaxRows() < 2) sheet.insertRowsAfter(1, 999);
  const headerRange = sheet.getRange(1, 1, 1, expected.length);
  headerRange.getDisplayValues()[0].forEach(function(value, index) {
    const current = String(value || '').trim();
    if (current && current.toLowerCase() !== expected[index].toLowerCase()) {
      throw new Error(name + ' column ' + (index + 1) + ' header is "' + current +
        '" but should be "' + expected[index] + '". Nothing was changed on that tab.');
    }
  });
  headerRange.setValues([expected]).setFontWeight('bold');
  sheet.setFrozenRows(1);

  const dataRows = sheet.getMaxRows() - 1;
  // Plain text stops Sheets turning 2026-07 into a date.
  sheet.getRange(2, expected.indexOf(h.billMonth) + 1, dataRows, 1).setNumberFormat('@');

  const statusColumn = expected.indexOf(h.status) + 1;
  const statusRange = sheet.getRange(2, statusColumn, dataRows, 1);
  const colours = { COMPLETED: '#d9ead3', FAILED: '#f4cccc', RETRYABLE: '#fff2cc', RUNNING: '#cfe2f3' };
  const rules = sheet.getConditionalFormatRules().filter(function(rule) {
    return !rule.getRanges().some(function(range) { return range.getColumn() === statusColumn; });
  });
  Object.keys(colours).forEach(function(status) {
    rules.push(SpreadsheetApp.newConditionalFormatRule()
      .whenTextEqualTo(status)
      .setBackground(colours[status])
      .setRanges([statusRange])
      .build());
  });
  sheet.setConditionalFormatRules(rules);
}

/** Run once. The trigger is intentionally harmless when no rows are pending. */
function installKauditServerAuditTrigger() {
  const handler = 'runKauditServerAuditBatches';
  const exists = ScriptApp.getProjectTriggers().some(function(trigger) {
    return trigger.getHandlerFunction() === handler;
  });
  if (!exists) {
    ScriptApp.newTrigger(handler)
      .timeBased()
      .everyMinutes(KAUDIT_SERVER_AUDIT.triggerMinutes)
      .create();
  }
}

function removeKauditServerAuditTrigger() {
  ScriptApp.getProjectTriggers().forEach(function(trigger) {
    if (trigger.getHandlerFunction() === 'runKauditServerAuditBatches') {
      ScriptApp.deleteTrigger(trigger);
    }
  });
}

function kauditAuditConfig_() {
  const properties = PropertiesService.getScriptProperties();
  const importEndpoint = String(properties.getProperty('KAUDIT_IMPORT_ENDPOINT') || '').trim();
  let endpoint = String(properties.getProperty('KAUDIT_RECONCILIATION_ENDPOINT') || '').trim();
  if (!endpoint && /\/api\/v1\/imports\/usage$/.test(importEndpoint)) {
    endpoint = importEndpoint.replace(/\/api\/v1\/imports\/usage$/, KAUDIT_SERVER_AUDIT.endpointPath);
  }
  if (!endpoint) {
    const base = kauditAuditWorkspaceSetting_('API_BASE_URL');
    if (base) endpoint = base.replace(/\/$/, '') + KAUDIT_SERVER_AUDIT.endpointPath;
  }
  if (!/^https:\/\/[^/?#]+\/api\/v1\/reconciliation\/batch$/.test(endpoint)) {
    throw new Error('KAUDIT_RECONCILIATION_ENDPOINT is invalid');
  }
  const secret = String(properties.getProperty('KAUDIT_GAS_AUDIT_SYNC_SECRET') || '').trim();
  if (!/^[A-Za-z0-9._~-]{32,256}$/.test(secret)) {
    throw new Error('KAUDIT_GAS_AUDIT_SYNC_SECRET is invalid');
  }
  const configuredNames = String(
    properties.getProperty('KAUDIT_AUDIT_SHEET_NAMES') ||
    properties.getProperty('KAUDIT_SHEET_NAME') || '',
  ).split(',').map(function(value) { return value.trim(); }).filter(Boolean);
  const parallel = Number(properties.getProperty('KAUDIT_AUDIT_PARALLEL_BATCHES') ||
    KAUDIT_SERVER_AUDIT.defaultParallelBatches);
  if (!Number.isInteger(parallel) || parallel < 1 ||
      parallel > KAUDIT_SERVER_AUDIT.maxParallelBatches) {
    throw new Error('KAUDIT_AUDIT_PARALLEL_BATCHES must be from 1 to 8');
  }
  return {
    endpoint: endpoint,
    secret: secret,
    sheetNames: configuredNames,
    parallelBatches: parallel,
    defaultMode: String(properties.getProperty('KAUDIT_AUDIT_MODE') || '').trim(),
    billMonth: String(properties.getProperty('KAUDIT_BILL_MONTH') ||
      properties.getProperty('KAUDIT_PERIOD_START') || '').trim().slice(0, 7),
    auditYear: String(properties.getProperty('KAUDIT_AUDIT_YEAR') || '').trim(),
    allowPreimported: String(
      properties.getProperty('KAUDIT_BASE_DATA_ALREADY_IMPORTED') || '',
    ).toLowerCase() === 'true',
  };
}

function kauditAuditWorkspaceSetting_(key) {
  const sheet = SpreadsheetApp.getActive().getSheetByName('Settings');
  if (!sheet || sheet.getLastRow() < 1) return '';
  const values = sheet.getRange(1, 1, sheet.getLastRow(), Math.min(2, sheet.getLastColumn()))
    .getDisplayValues();
  for (let index = 0; index < values.length; index += 1) {
    if (String(values[index][0] || '').trim() === key) {
      return String(values[index][1] || '').trim();
    }
  }
  return '';
}

function kauditAuditContexts_(config) {
  const spreadsheet = SpreadsheetApp.getActive();
  // Never fall back to the active sheet: a trigger could land on a historical
  // tab and enqueue rows nobody put into the intake.
  const tabs = KAUDIT_SERVER_AUDIT.tabs;
  const names = config.sheetNames.length
    ? config.sheetNames : [tabs.newMonth, tabs.lateRecording, tabs.reaudit];
  const sheets = names.map(function(name) {
    const sheet = spreadsheet.getSheetByName(name);
    if (!sheet) throw new Error('Audit sheet is missing: ' + name);
    return sheet;
  });
  return sheets.map(function(sheet) { return kauditAuditContext_(sheet, config); });
}

function kauditAuditContext_(sheet, config) {
  const headerRow = kauditAuditHeaderRow_(sheet);
  // Mode and Import Status are optional inputs; everything else is added.
  const required = Object.keys(KAUDIT_SERVER_AUDIT.headers).filter(function(key) {
    return key !== 'mode' && key !== 'importStatus';
  }).map(function(key) {
    return KAUDIT_SERVER_AUDIT.headers[key];
  });
  const original = sheet.getRange(headerRow, 1, 1, Math.max(1, sheet.getLastColumn()))
    .getDisplayValues()[0];
  const existing = {};
  original.forEach(function(value, index) {
    existing[String(value || '').trim().toLowerCase()] = index + 1;
  });
  required.forEach(function(name) {
    if (!existing[name.toLowerCase()]) {
      const column = sheet.getLastColumn() + 1;
      sheet.getRange(headerRow, column).setValue(name);
      existing[name.toLowerCase()] = column;
    }
  });
  const headers = sheet.getRange(headerRow, 1, 1, sheet.getLastColumn()).getDisplayValues()[0];
  const columns = {};
  Object.keys(KAUDIT_SERVER_AUDIT.headers).forEach(function(key) {
    const name = KAUDIT_SERVER_AUDIT.headers[key];
    columns[key] = headers.findIndex(function(value) {
      return String(value || '').trim().toLowerCase() === name.toLowerCase();
    });
  });
  const rowCount = Math.max(0, sheet.getLastRow() - headerRow);
  const rows = rowCount
    ? sheet.getRange(headerRow + 1, 1, rowCount, sheet.getLastColumn()).getDisplayValues()
    : [];
  return { sheet: sheet, headerRow: headerRow, rows: rows, columns: columns, config: config };
}

function kauditAuditHeaderRow_(sheet) {
  const height = Math.min(10, Math.max(1, sheet.getLastRow()));
  const width = Math.max(1, sheet.getLastColumn());
  const rows = sheet.getRange(1, 1, height, width).getDisplayValues();
  for (let row = 0; row < rows.length; row += 1) {
    if (rows[row].some(function(value) {
      return String(value || '').trim().toLowerCase() === 'task id';
    })) return row + 1;
  }
  throw new Error('Task ID header was not found in the first 10 rows of ' + sheet.getName());
}

function kauditAuditGet_(ref, key) {
  const column = ref.context.columns[key];
  return column >= 0 ? ref.context.rows[ref.index][column] : '';
}

function kauditAuditSet_(ref, key, value) {
  ref.context.rows[ref.index][ref.context.columns[key]] = value;
}

function kauditAuditFlush_(contexts) {
  const outputKeys = ['status', 'stage', 'error', 'batchId', 'attempt', 'updatedAt', 'amount'];
  contexts.forEach(function(context) {
    if (!context.rows.length) return;
    outputKeys.forEach(function(key) {
      const column = context.columns[key];
      context.sheet.getRange(
        context.headerRow + 1, column + 1, context.rows.length, 1,
      ).setValues(context.rows.map(function(row) { return [row[column]]; }));
    });
  });
}

function kauditAuditMode_(ref) {
  const normalise = function(value) {
    return String(value || '').trim().toLowerCase().replace(/\s+/g, '_');
  };
  const explicit = normalise(kauditAuditGet_(ref, 'mode'));
  if (KAUDIT_SERVER_AUDIT.modes.indexOf(explicit) >= 0) return explicit;
  // The tab name outranks the project-wide default so each tab keeps its flow.
  const name = ref.context.sheet.getName().toLowerCase();
  if (name.indexOf('late') >= 0) return 'late_recording';
  if (name.indexOf('reaudit') >= 0 || name.indexOf('re-audit') >= 0) {
    return 'transcript_reaudit';
  }
  if (name.indexOf('new month') >= 0) return 'new_month';
  const fallback = normalise(ref.context.config.defaultMode);
  return KAUDIT_SERVER_AUDIT.modes.indexOf(fallback) >= 0 ? fallback : 'new_month';
}

function kauditAuditMonth_(ref) {
  const explicit = String(kauditAuditGet_(ref, 'billMonth') || '').trim();
  if (/^\d{4}-\d{2}$/.test(explicit)) return explicit;
  if (/^\d{4}-\d{2}$/.test(ref.context.config.billMonth)) return ref.context.config.billMonth;
  const name = ref.context.sheet.getName();
  const numeric = name.match(/\b(20\d{2})[-_ ](0[1-9]|1[0-2])\b/);
  if (numeric) return numeric[1] + '-' + numeric[2];
  const monthNames = ['january','february','march','april','may','june',
    'july','august','september','october','november','december'];
  const lower = name.toLowerCase();
  const monthIndex = monthNames.findIndex(function(month) { return lower.indexOf(month) >= 0; });
  const yearMatch = name.match(/\b(20\d{2})\b/);
  const year = yearMatch ? yearMatch[1] : ref.context.config.auditYear;
  if (monthIndex >= 0 && /^20\d{2}$/.test(year)) {
    return year + '-' + ('0' + (monthIndex + 1)).slice(-2);
  }
  throw new Error('Bill month is missing for sheet ' + ref.context.sheet.getName());
}

function kauditAuditRowReady_(ref) {
  const taskId = String(kauditAuditGet_(ref, 'taskId') || '').trim();
  if (!/^[A-Za-z0-9._:-]{1,191}$/.test(taskId)) return false;
  const mode = kauditAuditMode_(ref);
  if (mode === 'late_recording' && !String(kauditAuditGet_(ref, 'recordingUrl') || '').trim()) {
    return false;
  }
  if (mode === 'new_month' && !ref.context.config.allowPreimported) {
    const importColumn = ref.context.columns.importStatus;
    if (importColumn < 0) return false;
    const imported = String(kauditAuditGet_(ref, 'importStatus') || '').trim().toLowerCase();
    if (imported !== 'submitted' && imported !== 'duplicate') return false;
  }
  return true;
}

function kauditAuditInitialBatches_(contexts, limit) {
  const groups = {};
  contexts.forEach(function(context) {
    context.rows.forEach(function(row, index) {
      const ref = { context: context, index: index };
      if (!kauditAuditRowReady_(ref)) return;
      const status = String(kauditAuditGet_(ref, 'status') || '').trim().toUpperCase();
      const attempt = Number(kauditAuditGet_(ref, 'attempt') || 0);
      if (['', 'PENDING'].indexOf(status) < 0 || attempt !== 0) return;
      const mode = kauditAuditMode_(ref);
      let month;
      try {
        month = kauditAuditMonth_(ref);
      } catch (error) {
        // One row without a month must not stop the other rows.
        kauditAuditSet_(ref, 'status', 'FAILED');
        kauditAuditSet_(ref, 'error', 'BILL_MONTH_MISSING');
        kauditAuditSet_(ref, 'updatedAt', new Date().toISOString());
        return;
      }
      const key = mode + '|' + month;
      if (!groups[key]) groups[key] = { mode: mode, billMonth: month, rows: [] };
      groups[key].rows.push(ref);
    });
  });
  const queues = Object.keys(groups).sort().map(function(key) {
    const group = groups[key];
    const chunks = [];
    for (let index = 0; index < group.rows.length; index += KAUDIT_SERVER_AUDIT.batchSize) {
      chunks.push({
        mode: group.mode,
        billMonth: group.billMonth,
        rows: group.rows.slice(index, index + KAUDIT_SERVER_AUDIT.batchSize),
        batchId: '',
      });
    }
    return chunks;
  });
  // Take turns between mode/month groups so no tab starves the others.
  const batches = [];
  for (let round = 0; batches.length < limit; round += 1) {
    let added = false;
    queues.forEach(function(chunks) {
      if (batches.length < limit && chunks[round]) {
        batches.push(chunks[round]);
        added = true;
      }
    });
    if (!added) break;
  }
  return batches;
}

function kauditAuditRetryBatches_(contexts, limit) {
  const groups = {};
  contexts.forEach(function(context) {
    context.rows.forEach(function(row, index) {
      const ref = { context: context, index: index };
      const batchId = String(kauditAuditGet_(ref, 'batchId') || '').trim();
      if (!batchId) return;
      const key = context.sheet.getSheetId() + '|' + batchId;
      if (!groups[key]) groups[key] = [];
      groups[key].push(ref);
    });
  });
  const batches = [];
  Object.keys(groups).sort().some(function(key) {
    const rows = groups[key];
    const retry = rows.some(function(ref) {
      const status = String(kauditAuditGet_(ref, 'status') || '').trim().toUpperCase();
      const attempt = Number(kauditAuditGet_(ref, 'attempt') || 0);
      return ['RETRYABLE', 'RUNNING', 'FAILED'].indexOf(status) >= 0 && attempt < 2;
    });
    if (!retry) return false;
    batches.push({
      mode: kauditAuditMode_(rows[0]),
      billMonth: kauditAuditMonth_(rows[0]),
      rows: rows,
      batchId: String(kauditAuditGet_(rows[0], 'batchId') || ''),
    });
    return batches.length >= limit;
  });
  return batches;
}

function kauditAuditBatchId_() {
  return 'gas-' + Utilities.getUuid();
}

function kauditAuditSignedRequest_(config, batch) {
  const body = JSON.stringify({
    schema_version: '1',
    batch_id: batch.batchId,
    bill_month: batch.billMonth,
    mode: batch.mode,
    items: batch.rows.map(function(ref) {
      const item = { task_id: String(kauditAuditGet_(ref, 'taskId') || '').trim() };
      if (batch.mode === 'late_recording') {
        item.recording_url = String(kauditAuditGet_(ref, 'recordingUrl') || '').trim();
      }
      return item;
    }),
  });
  const timestamp = String(Date.now());
  const bodyHash = kauditAuditSha256Hex_(body);
  const payload = ['POST', KAUDIT_SERVER_AUDIT.endpointPath, timestamp,
    bodyHash, batch.billMonth, batch.batchId].join('\n');
  const signature = kauditAuditBytesToHex_(Utilities.computeHmacSha256Signature(
    payload, config.secret, Utilities.Charset.UTF_8,
  ));
  return {
    url: config.endpoint,
    method: 'post',
    contentType: 'application/json; charset=utf-8',
    payload: body,
    muteHttpExceptions: true,
    followRedirects: false,
    headers: {
      'X-Kaudit-Audit-Sync-Timestamp': timestamp,
      'X-Kaudit-Content-Sha256': bodyHash,
      'X-Kaudit-Audit-Sync-Signature': signature,
      'X-Kaudit-Bill-Month': batch.billMonth,
      'X-Kaudit-Batch-Id': batch.batchId,
    },
  };
}

function kauditAuditApplyResponse_(batch, response) {
  const statusCode = response.getResponseCode();
  let body = {};
  try { body = JSON.parse(response.getContentText() || '{}'); } catch (error) {}
  if (statusCode !== 200 || !Array.isArray(body.items)) {
    const code = String(body.code || (body.error && body.error.code) || ('HTTP_' + statusCode));
    // A *_BUSY refusal happens before the server writes anything, so it is
    // not an attempt: hand the rows back to the queue for the next run.
    if (statusCode === 409 && /_BUSY$/.test(code)) {
      batch.rows.forEach(function(ref) {
        const attempt = Math.max(0, Number(kauditAuditGet_(ref, 'attempt') || 0) - 1);
        kauditAuditSet_(ref, 'attempt', attempt);
        kauditAuditSet_(ref, 'status', attempt > 0 ? 'RETRYABLE' : 'PENDING');
        kauditAuditSet_(ref, 'error', code);
        kauditAuditSet_(ref, 'updatedAt', new Date().toISOString());
      });
      return;
    }
    const retryable = statusCode === 0 || statusCode === 408 || statusCode === 425 ||
      statusCode === 429 || statusCode >= 500;
    batch.rows.forEach(function(ref) {
      kauditAuditSet_(ref, 'status',
        retryable && Number(kauditAuditGet_(ref, 'attempt') || 0) < 2
          ? 'RETRYABLE' : 'FAILED');
      kauditAuditSet_(ref, 'error', /^[A-Z0-9_|-]{2,160}$/.test(code) ? code : 'REQUEST_FAILED');
      kauditAuditSet_(ref, 'updatedAt', new Date().toISOString());
    });
    return;
  }
  const receipts = {};
  body.items.forEach(function(item) {
    receipts[String(item.taskId || '')] = item;
  });
  batch.rows.forEach(function(ref) {
    const taskId = String(kauditAuditGet_(ref, 'taskId') || '').trim();
    const receipt = receipts[taskId];
    if (!receipt) {
      kauditAuditSet_(ref, 'status', 'RETRYABLE');
      kauditAuditSet_(ref, 'error', 'RECEIPT_ITEM_MISSING');
    } else {
      const outcome = String(receipt.status || '').toLowerCase();
      kauditAuditSet_(ref, 'status',
        outcome === 'completed' || outcome === 'duplicate' ? 'COMPLETED' :
        outcome === 'retryable' && Number(kauditAuditGet_(ref, 'attempt') || 0) < 2
          ? 'RETRYABLE' : 'FAILED');
      kauditAuditSet_(ref, 'stage', String(receipt.stage || 'classification'));
      kauditAuditSet_(ref, 'error', String(receipt.code || ''));
      if (receipt.amount !== undefined && receipt.amount !== null) {
        kauditAuditSet_(ref, 'amount', String(receipt.amount));
      }
    }
    kauditAuditSet_(ref, 'updatedAt', new Date().toISOString());
  });
}

function kauditAuditMarkTransportFailure_(batch, code) {
  batch.rows.forEach(function(ref) {
    kauditAuditSet_(ref, 'status',
      Number(kauditAuditGet_(ref, 'attempt') || 0) < 2 ? 'RETRYABLE' : 'FAILED');
    kauditAuditSet_(ref, 'error', code);
    kauditAuditSet_(ref, 'updatedAt', new Date().toISOString());
  });
}

function kauditAuditSha256Hex_(value) {
  return kauditAuditBytesToHex_(Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    String(value),
    Utilities.Charset.UTF_8,
  ));
}

function kauditAuditBytesToHex_(bytes) {
  return bytes.map(function(value) {
    return ('0' + (value & 255).toString(16)).slice(-2);
  }).join('');
}
