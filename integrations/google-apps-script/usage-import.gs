const KAUDIT_USAGE_IMPORT = Object.freeze({
  headerRow: 1,
  sourceColumnCount: 10,
  statusColumn: 11,
  batchSize: 500,
  maxBatchesPerRun: 4,
  submittedStatus: 'Submitted',
  endpointPath: '/api/v1/imports/usage',
  triggerMinutes: 5,
});

const KAUDIT_USAGE_HEADERS = Object.freeze([
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
]);

/** Run from a time-driven trigger. Failed batches remain blank in column K. */
function submitPendingKauditUsage() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) {
    console.log(JSON.stringify({ event: 'kaudit_usage_skipped', reason: 'locked' }));
    return;
  }
  try {
    const config = readKauditUsageConfig_();
    const sheet = config.sheetName
      ? SpreadsheetApp.getActive().getSheetByName(config.sheetName)
      : SpreadsheetApp.getActiveSheet();
    if (!sheet) throw new Error('Configured sheet is unavailable');

    ensureKauditUsageHeader_(sheet);
    const rowCount = Math.max(0, sheet.getLastRow() - KAUDIT_USAGE_IMPORT.headerRow);
    if (rowCount === 0) {
      printKauditUsageStatus_('complete', 0, 0);
      return;
    }

    const sourceRange = sheet.getRange(
      KAUDIT_USAGE_IMPORT.headerRow + 1,
      1,
      rowCount,
      KAUDIT_USAGE_IMPORT.statusColumn,
    );
    const data = sourceRange.getDisplayValues();
    const rawData = sourceRange.getValues();
    const spreadsheetTimeZone = SpreadsheetApp.getActive().getSpreadsheetTimeZone();
    let submitted = 0;
    let batches = 0;
    let statusesChanged = false;
    let retryPending = false;

    while (batches < KAUDIT_USAGE_IMPORT.maxBatchesPerRun) {
      const indexes = pendingKauditUsageIndexes_(data);
      if (indexes.length === 0) break;
      const csv = kauditUsageCsv_(indexes.map(function(index) {
        return canonicalKauditUsageRow_(
          rawData[index],
          data[index],
          spreadsheetTimeZone,
        );
      }));
      const receipt = sendKauditUsageBatch_(config, csv);
      if (!receipt.ok || receipt.received !== indexes.length) {
        retryPending = true;
        break;
      }
      indexes.forEach(function(index) {
        data[index][KAUDIT_USAGE_IMPORT.statusColumn - 1] =
          KAUDIT_USAGE_IMPORT.submittedStatus;
      });
      submitted += indexes.length;
      batches += 1;
      statusesChanged = true;
    }

    if (statusesChanged) {
      sheet.getRange(
        KAUDIT_USAGE_IMPORT.headerRow + 1,
        KAUDIT_USAGE_IMPORT.statusColumn,
        rowCount,
        1,
      ).setValues(data.map(function(row) {
        return [row[KAUDIT_USAGE_IMPORT.statusColumn - 1]];
      }));
      SpreadsheetApp.flush();
    }
    printKauditUsageStatus_(
      retryPending ? 'retry_pending' : 'finished',
      submitted,
      countPendingKauditUsage_(data),
    );
  } finally {
    lock.releaseLock();
  }
}

function sendKauditUsageBatch_(config, csv) {
  const bodySha256 = sha256Hex_(csv);
  const timestamp = String(Date.now());
  const filename = 'usage-' + config.periodStart + '-' + bodySha256.slice(0, 12) + '.csv';
  const signingPayload = [
    'POST',
    KAUDIT_USAGE_IMPORT.endpointPath,
    timestamp,
    bodySha256,
    filename,
    config.periodStart,
    config.periodEnd,
  ].join('\n');
  const signature = bytesToHex_(Utilities.computeHmacSha256Signature(
    signingPayload,
    config.secret,
    Utilities.Charset.UTF_8,
  ));
  let response;
  try {
    response = UrlFetchApp.fetch(config.endpoint, {
      method: 'post',
      contentType: 'text/csv; charset=utf-8',
      payload: csv,
      muteHttpExceptions: true,
      followRedirects: false,
      headers: {
        'X-Kaudit-Filename': filename,
        'X-Kaudit-Period-Start': config.periodStart,
        'X-Kaudit-Period-End': config.periodEnd,
        'X-Kaudit-Content-Sha256': bodySha256,
        'X-Kaudit-Import-Timestamp': timestamp,
        'X-Kaudit-Import-Signature': signature,
      },
    });
  } catch (error) {
    console.log(JSON.stringify({
      event: 'kaudit_usage_batch_failed',
      httpStatus: 0,
    }));
    return { ok: false, received: 0 };
  }
  if (response.getResponseCode() !== 200) {
    console.log(JSON.stringify({
      event: 'kaudit_usage_batch_failed',
      httpStatus: response.getResponseCode(),
      errorCode: kauditProblemCode_(response),
    }));
    return { ok: false, received: 0 };
  }
  let receipt;
  try {
    receipt = JSON.parse(response.getContentText());
  } catch (error) {
    return { ok: false, received: 0 };
  }
  const received = Number(receipt.received);
  const accounted = Number(receipt.accepted) + Number(receipt.duplicates);
  return {
    ok: (receipt.outcome === 'imported' || receipt.outcome === 'duplicate') &&
      Number.isSafeInteger(received) &&
      accounted === received,
    received: received,
  };
}

function canonicalKauditUsageRow_(rawRow, displayRow, timeZone) {
  return [
    String(displayRow[0] || '').trim(),
    String(displayRow[1] || '').trim(),
    canonicalKauditDateTime_(rawRow[2], displayRow[2], timeZone),
    canonicalKauditDateTime_(rawRow[3], displayRow[3], timeZone),
    canonicalKauditDateTime_(rawRow[4], displayRow[4], timeZone),
    canonicalKauditNumber_(rawRow[5], displayRow[5], 12),
    canonicalKauditNumber_(rawRow[6], displayRow[6], 12),
    canonicalKauditNumber_(rawRow[7], displayRow[7], 12),
    canonicalKauditNumber_(rawRow[8], displayRow[8], 8),
    String(displayRow[9] || '').trim(),
  ];
}

function canonicalKauditDateTime_(rawValue, displayValue, timeZone) {
  if (Object.prototype.toString.call(rawValue) === '[object Date]' &&
      !isNaN(rawValue.getTime())) {
    return Utilities.formatDate(rawValue, timeZone, 'yyyy-MM-dd HH:mm:ss');
  }
  return String(displayValue || '').trim();
}

function canonicalKauditNumber_(rawValue, displayValue, decimalPlaces) {
  if (typeof rawValue === 'number' && isFinite(rawValue) && rawValue >= 0) {
    return rawValue.toFixed(decimalPlaces).replace(/\.?0+$/, '');
  }
  return String(displayValue == null ? '' : displayValue).trim();
}

function kauditProblemCode_(response) {
  try {
    const problem = JSON.parse(response.getContentText());
    const code = String(problem.code || '');
    return /^[A-Z][A-Z0-9_]{1,79}$/.test(code) ? code : 'UNAVAILABLE';
  } catch (error) {
    return 'UNAVAILABLE';
  }
}

function readKauditUsageConfig_() {
  const properties = PropertiesService.getScriptProperties();
  const endpoint = (properties.getProperty('KAUDIT_IMPORT_ENDPOINT') || '').trim();
  const secret = (properties.getProperty('KAUDIT_GAS_IMPORT_SECRET') || '').trim();
  const periodStart = (properties.getProperty('KAUDIT_PERIOD_START') || '').trim();
  const periodEnd = (properties.getProperty('KAUDIT_PERIOD_END') || '').trim();
  const sheetName = (properties.getProperty('KAUDIT_SHEET_NAME') || '').trim();
  if (!/^https:\/\/[^/?#]+\/api\/v1\/imports\/usage$/.test(endpoint)) {
    throw new Error('KAUDIT_IMPORT_ENDPOINT is invalid');
  }
  if (!/^[A-Za-z0-9._~-]{32,256}$/.test(secret)) {
    throw new Error('KAUDIT_GAS_IMPORT_SECRET is invalid');
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(periodStart)) {
    throw new Error('KAUDIT_PERIOD_START is invalid');
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(periodEnd)) {
    throw new Error('KAUDIT_PERIOD_END is invalid');
  }
  return { endpoint: endpoint, secret: secret, periodStart: periodStart,
    periodEnd: periodEnd, sheetName: sheetName };
}

function pendingKauditUsageIndexes_(data) {
  const indexes = [];
  for (let index = 0; index < data.length; index += 1) {
    const hasTaskId = String(data[index][0] || '').trim() !== '';
    const status = String(
      data[index][KAUDIT_USAGE_IMPORT.statusColumn - 1] || '',
    ).trim();
    if (hasTaskId && status === '') indexes.push(index);
    if (indexes.length === KAUDIT_USAGE_IMPORT.batchSize) break;
  }
  return indexes;
}

function countPendingKauditUsage_(data) {
  return data.reduce(function(count, row) {
    return count + (
      String(row[0] || '').trim() !== '' &&
      String(row[KAUDIT_USAGE_IMPORT.statusColumn - 1] || '').trim() === ''
        ? 1 : 0
    );
  }, 0);
}

function kauditUsageCsv_(rows) {
  return [KAUDIT_USAGE_HEADERS].concat(rows).map(function(row) {
    return row.map(csvCell_).join(',');
  }).join('\n');
}

function csvCell_(value) {
  const text = String(value == null ? '' : value);
  return /[",\r\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
}

function sha256Hex_(value) {
  return bytesToHex_(Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    value,
    Utilities.Charset.UTF_8,
  ));
}

function bytesToHex_(bytes) {
  return bytes.map(function(value) {
    const unsigned = value < 0 ? value + 256 : value;
    return ('0' + unsigned.toString(16)).slice(-2);
  }).join('');
}

function ensureKauditUsageHeader_(sheet) {
  const sourceHeaders = sheet.getRange(
    KAUDIT_USAGE_IMPORT.headerRow,
    1,
    1,
    KAUDIT_USAGE_IMPORT.sourceColumnCount,
  ).getDisplayValues()[0];
  const valid = KAUDIT_USAGE_HEADERS.every(function(expected, index) {
    return String(sourceHeaders[index] || '').trim() === expected;
  });
  if (!valid) throw new Error('Usage sheet headers do not match the locked contract');
  const cell = sheet.getRange(
    KAUDIT_USAGE_IMPORT.headerRow,
    KAUDIT_USAGE_IMPORT.statusColumn,
  );
  if (!String(cell.getDisplayValue() || '').trim()) cell.setValue('Import Status');
}

function printKauditUsageStatus_(state, submitted, pending) {
  console.log(JSON.stringify({
    event: 'kaudit_usage_status',
    state: state,
    submittedThisRun: submitted,
    pendingRows: pending,
  }));
}

/** Run once to install one five-minute retry trigger. */
function installKauditUsageTrigger() {
  const handler = 'submitPendingKauditUsage';
  const exists = ScriptApp.getProjectTriggers().some(function(trigger) {
    return trigger.getHandlerFunction() === handler;
  });
  if (!exists) {
    ScriptApp.newTrigger(handler)
      .timeBased()
      .everyMinutes(KAUDIT_USAGE_IMPORT.triggerMinutes)
      .create();
  }
}
