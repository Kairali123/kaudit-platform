const KAUDIT_USAGE_IMPORT = Object.freeze({
  headerRow: 1,
  sourceColumnCount: 10,
  statusColumn: 11,
  batchSize: 500,
  maxBatchesPerRun: 8,
  submittedStatus: 'Submitted',
  needsReviewStatus: 'Needs review',
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

/**
 * Run from a time-driven trigger.
 *
 * Reliability contract:
 *   - Pending rows are prevalidated locally against the same canonical input
 *     contract the API enforces. A permanently invalid row is marked
 *     "Needs review" and NEVER blocks valid rows or retries forever.
 *   - "Submitted" is written only for rows durably accepted by Kaudit.
 *   - Blank rows stay blank after a transient failure so the next run retries
 *     them.
 *   - Rows already "Submitted" or "Needs review" are skipped on later runs.
 */
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
      printKauditUsageStatus_('complete', 0, 0, 0);
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
    let needsReview = 0;
    let batches = 0;
    let statusesChanged = false;
    let retryPending = false;

    // One bounded local prevalidation pass before any network call. Invalid
    // rows are taken out of the pending set permanently; only their row
    // numbers, field names, and allowlisted codes are logged — never values.
    const seenTaskIds = {};
    data.forEach(function(row, index) {
      if (!isPendingKauditRow_(row)) return;
      const canonical = canonicalKauditUsageRow_(
        rawData[index],
        row,
        spreadsheetTimeZone,
      );
      let failure = validateKauditUsageCanonicalRow_(canonical);
      const taskId = String(canonical[0] || '').trim();
      if (!failure && taskId !== '' &&
          Object.prototype.hasOwnProperty.call(seenTaskIds, taskId)) {
        failure = { field: 'taskId', code: 'TASK_ID_DUPLICATE' };
      }
      if (taskId !== '') seenTaskIds[taskId] = true;
      if (failure) {
        data[index][KAUDIT_USAGE_IMPORT.statusColumn - 1] =
          KAUDIT_USAGE_IMPORT.needsReviewStatus;
        needsReview += 1;
        statusesChanged = true;
        console.log(JSON.stringify({
          event: 'kaudit_usage_row_invalid',
          spreadsheetRow: KAUDIT_USAGE_IMPORT.headerRow + 1 + index,
          field: failure.field,
          code: failure.code,
        }));
      }
    });

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
      if (receipt.issues && receipt.issues.length > 0) {
        // Server-side contract check found rows the local pass cannot see
        // (for example a recording host outside the deployment allowlist).
        // Mark exactly those rows "Needs review" and shrink the batch; the
        // remaining rows are resubmitted without them.
        let issuesApplied = 0;
        receipt.issues.forEach(function(issue) {
          const batchIndex = Number(issue.rowIndex);
          const field = String(issue.field || '');
          const code = String(issue.code || '');
          if (!Number.isInteger(batchIndex) ||
              batchIndex < 0 || batchIndex >= indexes.length ||
              !/^[a-z][a-zA-Z]{0,63}$/.test(field) ||
              !/^[A-Z][A-Z0-9_]{2,63}$/.test(code)) {
            return;
          }
          const sheetIndex = indexes[batchIndex];
          if (String(data[sheetIndex][KAUDIT_USAGE_IMPORT.statusColumn - 1] || '').trim() !== '') {
            return;
          }
          data[sheetIndex][KAUDIT_USAGE_IMPORT.statusColumn - 1] =
            KAUDIT_USAGE_IMPORT.needsReviewStatus;
          needsReview += 1;
          issuesApplied += 1;
          statusesChanged = true;
          console.log(JSON.stringify({
            event: 'kaudit_usage_row_invalid',
            spreadsheetRow: KAUDIT_USAGE_IMPORT.headerRow + 1 + sheetIndex,
            field: field,
            code: code,
          }));
        });
        if (issuesApplied === 0) {
          // The refusal named no row this run can act on. Resubmitting the
          // identical batch would only repeat it, so stop this run and leave
          // the batch blank for operator attention.
          console.log(JSON.stringify({
            event: 'kaudit_usage_batch_rejected',
            httpStatus: 400,
          }));
          break;
        }
        batches += 1;
        continue;
      }
      if (!receipt.ok || receipt.received !== indexes.length) {
        // Transient failure: every row in this batch stays blank so the next
        // run retries the identical batch.
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
      needsReview,
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
    return { ok: false, received: 0, issues: null };
  }
  const status = response.getResponseCode();
  if (status !== 200) {
    const problemCode = kauditProblemCode_(response);
    console.log(JSON.stringify({
      event: 'kaudit_usage_batch_failed',
      httpStatus: status,
      errorCode: problemCode,
    }));
    if (status === 400 && problemCode === 'INVALID_IMPORT_ROWS') {
      return { ok: false, received: 0, issues: kauditProblemIssues_(response) };
    }
    return { ok: false, received: 0, issues: null };
  }
  let receipt;
  try {
    receipt = JSON.parse(response.getContentText());
  } catch (error) {
    return { ok: false, received: 0, issues: null };
  }
  const received = Number(receipt.received);
  const accounted = Number(receipt.accepted) + Number(receipt.duplicates);
  return {
    ok: (receipt.outcome === 'imported' || receipt.outcome === 'duplicate') &&
      Number.isSafeInteger(received) &&
      accounted === received,
    received: received,
    issues: null,
  };
}

/**
 * Mirrors the canonical API input contract for one already-canonicalized row.
 * Returns a bounded descriptor ({field, code}) or null. Never returns the
 * offending value.
 */
function validateKauditUsageCanonicalRow_(canonicalRow) {
  if (String(canonicalRow[0] || '').trim() === '') {
    return { field: 'taskId', code: 'TASK_ID_REQUIRED' };
  }
  const durations = [
    [5, 'durationWithRingingSec'],
    [6, 'durationWithoutRingingSec'],
    [7, 'durationMinutes'],
  ];
  for (var i = 0; i < durations.length; i += 1) {
    if (!/^\d+(\.\d+)?$/.test(String(canonicalRow[durations[i][0]] || '').trim())) {
      return { field: durations[i][1], code: 'DURATION_INVALID' };
    }
  }
  const amount = String(canonicalRow[8] || '').trim();
  if (amount !== '' && !/^\d+(\.\d{1,8})?$/.test(amount)) {
    return { field: 'billedAmount', code: 'AMOUNT_INVALID' };
  }
  const times = [
    [2, 'callStartTime'],
    [3, 'callConnectedTime'],
    [4, 'callEndTime'],
  ];
  for (var j = 0; j < times.length; j += 1) {
    const value = String(canonicalRow[times[j][0]] || '').trim();
    if (value === '') continue;
    if (!isRealKauditDateTime_(value)) {
      return { field: times[j][1], code: 'DATETIME_INVALID' };
    }
  }
  const recordingUrl = String(canonicalRow[9] || '').trim();
  if (recordingUrl !== '' && !/^https:\/\/[^\s/?#]+\/?[^\s]*$/i.test(recordingUrl)) {
    return { field: 'recordingUrl', code: 'RECORDING_URL_INVALID' };
  }
  return null;
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

function isRealKauditDateTime_(value) {
  let match = value.match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (match) {
    return isRealKauditDateParts_(
      Number(match[1]), Number(match[2]), Number(match[3]),
      Number(match[4]), Number(match[5]), Number(match[6] || '0'),
    );
  }
  match = value.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4}) (\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!match) return false;
  return isRealKauditDateParts_(
    Number(match[3]), Number(match[2]), Number(match[1]),
    Number(match[4]), Number(match[5]), Number(match[6] || '0'),
  );
}

function isRealKauditDateParts_(year, month, day, hour, minute, second) {
  if (year < 1000 || year > 9999 || month < 1 || month > 12 ||
      hour < 0 || hour > 23 ||
      minute < 0 || minute > 59 || second < 0 || second > 59) return false;
  const maxDay = [31, isKauditLeapYear_(year) ? 29 : 28, 31, 30, 31, 30,
    31, 31, 30, 31, 30, 31][month - 1];
  return day >= 1 && day <= maxDay;
}

function isKauditLeapYear_(year) {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
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

/** Bounded per-row descriptors only: rowIndex, field, code. Never values. */
function kauditProblemIssues_(response) {
  try {
    const problem = JSON.parse(response.getContentText());
    if (!Array.isArray(problem.issues)) return [];
    return problem.issues.map(function(issue) {
      return {
        rowIndex: Number(issue.rowIndex),
        field: String(issue.field || ''),
        code: String(issue.code || ''),
      };
    });
  } catch (error) {
    return [];
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

function isPendingKauditRow_(row) {
  const status = String(
    row[KAUDIT_USAGE_IMPORT.statusColumn - 1] || '',
  ).trim();
  if (status !== '') return false;
  for (var index = 0; index < KAUDIT_USAGE_IMPORT.sourceColumnCount; index += 1) {
    if (String(row[index] || '').trim() !== '') return true;
  }
  return false;
}

function pendingKauditUsageIndexes_(data) {
  const indexes = [];
  for (let index = 0; index < data.length; index += 1) {
    if (isPendingKauditRow_(data[index])) indexes.push(index);
    if (indexes.length === KAUDIT_USAGE_IMPORT.batchSize) break;
  }
  return indexes;
}

function countPendingKauditUsage_(data) {
  return data.reduce(function(count, row) {
    return count + (isPendingKauditRow_(row) ? 1 : 0);
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

function printKauditUsageStatus_(state, submitted, pending, needsReview) {
  console.log(JSON.stringify({
    event: 'kaudit_usage_status',
    state: state,
    submittedThisRun: submitted,
    pendingRows: pending,
    needsReviewTotal: needsReview,
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
