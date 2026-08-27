import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

/**
 * Runs the real Google Apps Script source inside a sandbox with synthetic
 * spreadsheet and network fixtures. No external calls, no real sheet, no PII.
 */
async function loadGasSource(): Promise<string> {
  return readFile(
    path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '../../integrations/google-apps-script/usage-import.gs',
    ),
    'utf8',
  )
}

interface SheetCellSpec {
  display: string
}

function makeSandbox(options: {
  rows: string[][]
  rawRows?: unknown[][]
  fetch: (url: string, params: {
    payload: string
    headers: Record<string, string>
  }) => { status: number; body: string }
  logs?: { event: string;[key: string]: unknown }[]
}) {
  const logs = options.logs ?? []
  const rowCount = options.rows.length
  let storedStatuses: string[][] | null = null

  const dataRange = {
    getDisplayValues: () => options.rows.map((row) => [...row, '']),
    getValues: () => options.rawRows ?? options.rows.map((row) => [...row, '']),
    setValues: (values: string[][]) => {
      storedStatuses = values
      return values
    },
  }

  const headerCell: SheetCellSpec = { display: '' }
  const sheet = {
    getLastRow: () => rowCount + 1,
    getRange: (...args: number[]) => {
      if (
        args.length === 4 && args[0] === 2 && args[2] === rowCount &&
        ((args[1] === 1 && args[3] === 11) ||
         (args[1] === 11 && args[3] === 1))
      ) {
        return dataRange
      }
      if (args.length === 4 && args[2] === 1) {
        return {
          getDisplayValues: () => [
            [
              'Task ID', 'Destination Number', 'Call Start Time',
              'Call Connected Time', 'Call End Time',
              'Duration (Seconds) With Ringing',
              'Duration (Seconds) Without Ringing',
              'Duration (Minutes) - Actual Billing Mins',
              'Actual Billing Amount', 'Recording URL',
            ],
          ],
        }
      }
      if (args.length === 2 && args[0] === 1 && args[1] === 11) {
        return {
          getDisplayValue: () => headerCell.display,
          setValue: (value: string) => {
            headerCell.display = value
            return value
          },
        }
      }
      throw new Error(`unexpected getRange(${args.join(',')})`)
    },
  }

  const context = {
    console: {
      log: (line: string) => {
        try {
          logs.push(JSON.parse(line))
        } catch {
          logs.push({ event: line })
        }
      },
    },
    LockService: {
      getScriptLock: () => ({
        tryLock: () => true,
        releaseLock: () => undefined,
      }),
    },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (name: string) =>
          ({
            KAUDIT_IMPORT_ENDPOINT: 'https://kaudit.example.test/api/v1/imports/usage',
            KAUDIT_GAS_IMPORT_SECRET: 'a'.repeat(40),
            KAUDIT_PERIOD_START: '2026-06-01',
            KAUDIT_PERIOD_END: '2026-06-30',
            KAUDIT_SHEET_NAME: '',
          })[name] ?? null,
      }),
    },
    SpreadsheetApp: {
      getActive: () => ({
        getSheetByName: () => sheet,
        getActiveSheet: () => sheet,
        getSpreadsheetTimeZone: () => 'Asia/Kolkata',
      }),
      getActiveSheet: () => sheet,
      flush: () => undefined,
    },
    Utilities: {
      Charset: { UTF_8: 'UTF_8' },
      DigestAlgorithm: { SHA_256: 'SHA_256' },
      computeDigest: () => [],
      computeHmacSha256Signature: () => [],
      formatDate: () => '2026-06-01 10:00:00',
    },
    UrlFetchApp: {
      fetch: (url: string, params: never) => {
        const response = options.fetch(
          url,
          params as { payload: string; headers: Record<string, string> },
        )
        return {
          getResponseCode: () => response.status,
          getContentText: () => response.body,
        }
      },
    },
    ScriptApp: { getProjectTriggers: () => [] },
  }
  return {
    context,
    logs,
    writtenStatuses: () => storedStatuses,
    sentBodies: [] as string[],
  }
}

async function runImport(sandbox: ReturnType<typeof makeSandbox>) {
  const source = await loadGasSource()
  const script = new vm.Script(source, { filename: 'usage-import.gs' })
  const context = vm.createContext(sandbox.context)
  script.runInContext(context)
  ;(
    sandbox.context as unknown as {
      submitPendingKauditUsage: () => void
    }
  ).submitPendingKauditUsage()
}

const validRow = (taskId: string): string[] => [
  taskId,
  '+910000000000',
  '2026-06-01 10:00:00',
  '2026-06-01 10:00:04',
  '2026-06-01 10:00:34',
  '34',
  '30',
  '0.5',
  '4.75',
  'https://recordings.example.test/a.ogg',
]

const importedReceipt = (received: number): string =>
  JSON.stringify({
    outcome: 'imported',
    referenceId: 'synthetic-batch',
    received,
    accepted: received,
    duplicates: 0,
    auditJobsQueued: 0,
    missingRecordingUrls: 0,
  })

test('malformed rows inside a full 500-row batch do not block the valid rows', async () => {
  const sentBodies: string[] = []
  // Build one full batch of 500 pending rows with three permanently invalid
  // ones mixed in (synthetic row numbers 100, 200, 300).
  const rows: string[][] = []
  for (let i = 0; i < 500; i += 1) {
    if (i === 99 || i === 199 || i === 299) {
      rows.push([...validRow(`task-${i}`).slice(0, 5), 'not-a-number', '30', '0.5', '', ''])
    } else {
      rows.push(validRow(`task-${i}`))
    }
  }
  const sandbox = makeSandbox({
    rows,
    fetch: (_url, params) => {
      sentBodies.push(params.payload)
      const dataRows = params.payload.split('\n').length - 1
      return { status: 200, body: importedReceipt(dataRows) }
    },
  })
  await runImport(sandbox)

  // Exactly 497 valid rows went to the API, in one batch.
  assert.equal(sentBodies.length, 1)
  assert.equal(sentBodies[0].split('\n').length - 1, 497)
  // Invalid rows were marked for review, valid ones submitted.
  const written = sandbox.writtenStatuses() as string[][]
  assert.equal(written[99][0], 'Needs review')
  assert.equal(written[199][0], 'Needs review')
  assert.equal(written[299][0], 'Needs review')
  assert.equal(written[0][0], 'Submitted')
  assert.equal(written[499][0], 'Submitted')
  // Bounded logging: row numbers, field, code — never a value.
  const invalidEvents = sandbox.logs.filter(
    (log) => log.event === 'kaudit_usage_row_invalid',
  )
  assert.deepEqual(
    invalidEvents.map((log) => log.spreadsheetRow),
    [101, 201, 301],
  )
  for (const log of invalidEvents) {
    assert.equal(log.code, 'DURATION_INVALID')
    assert.equal(typeof log.field, 'string')
    assert.ok(!JSON.stringify(log).includes('not-a-number'))
  }
})

test('server-side validation issues mark exactly those rows and the remainder is retried', async () => {
  const sentBodies: string[] = []
  const rows = [
    validRow('task-host-bad'), // https host the deployment does not allow
    validRow('task-good'),
    validRow('task-host-bad-two'),
    validRow('task-good-two'),
  ]
  const sandbox = makeSandbox({
    rows,
    fetch: (_url, params) => {
      sentBodies.push(params.payload)
      if (sentBodies.length === 1) {
        return {
          status: 400,
          body: JSON.stringify({
            code: 'INVALID_IMPORT_ROWS',
            issues: [
              { rowIndex: 0, field: 'recordingUrl', code: 'RECORDING_URL_INVALID' },
              { rowIndex: 2, field: 'recordingUrl', code: 'RECORDING_URL_INVALID' },
            ],
          }),
        }
      }
      const dataRows = params.payload.split('\n').length - 1
      return { status: 200, body: importedReceipt(dataRows) }
    },
  })
  await runImport(sandbox)

  // First call carried all four rows; the retry carried only the two valid ones.
  assert.equal(sentBodies.length, 2)
  assert.equal(sentBodies[0].split('\n').length - 1, 4)
  assert.equal(sentBodies[1].split('\n').length - 1, 2)
  assert.ok(sentBodies[1].includes('task-good'))
  assert.ok(!sentBodies[1].includes('task-host-bad'))
  const written = sandbox.writtenStatuses() as string[][]
  assert.equal(written[0][0], 'Needs review')
  assert.equal(written[2][0], 'Needs review')
  assert.equal(written[1][0], 'Submitted')
  assert.equal(written[3][0], 'Submitted')
})

test('multiple malformed rows in later batches keep earlier batches submitted', async () => {
  const sentBodies: string[] = []
  // The first full batch is clean; a LATER batch carries a row whose defect
  // only the server can see (recording host outside the allowlist).
  const badHostRow = [
    ...validRow('batch-two-bad').slice(0, 9),
    'https://blocked-host.example.test/x.ogg',
  ]
  const rows = [
    ...Array.from({ length: 500 }, (_, i) => validRow(`batch-one-${i}`)),
    validRow('batch-two-ok'),
    badHostRow,
  ]
  const sandbox = makeSandbox({
    rows,
    fetch: (_url, params) => {
      sentBodies.push(params.payload)
      if (sentBodies.length !== 2) {
        const dataRows = params.payload.split('\n').length - 1
        return { status: 200, body: importedReceipt(dataRows) }
      }
      return {
        status: 400,
        body: JSON.stringify({
          code: 'INVALID_IMPORT_ROWS',
          issues: [
            { rowIndex: 1, field: 'recordingUrl', code: 'RECORDING_URL_INVALID' },
          ],
        }),
      }
    },
  })
  await runImport(sandbox)

  // Batch one (500), then the two-row batch, then the shrunken retry.
  assert.equal(sentBodies.length, 3)
  assert.equal(sentBodies[0].split('\n').length - 1, 500)
  assert.equal(sentBodies[1].split('\n').length - 1, 2)
  assert.equal(sentBodies[2].split('\n').length - 1, 1)
  const written = sandbox.writtenStatuses() as string[][]
  // First batch fully submitted before the later failure.
  assert.equal(written[0][0], 'Submitted')
  assert.equal(written[499][0], 'Submitted')
  // Later batch: valid row in, malformed row out.
  assert.equal(written[500][0], 'Submitted')
  assert.equal(written[501][0], 'Needs review')
})

test('a transient network failure leaves every row blank for the next run', async () => {
  const rows = [validRow('task-one'), validRow('task-two')]
  const sandbox = makeSandbox({
    rows,
    fetch: () => {
      throw new Error('simulated transport outage')
    },
  })
  await runImport(sandbox)

  const written = sandbox.writtenStatuses()
  assert.equal(written, null, 'no status write-back happens without any accepted row')
  assert.equal(
    sandbox.logs.at(-1)?.state,
    'retry_pending',
  )
})

test('"Needs review" and "Submitted" rows are skipped by later runs (replay safety)', async () => {
  const sentBodies: string[] = []
  const rows = [
    [...validRow('task-done'), 'Submitted'],
    [...validRow('task-review'), 'Needs review'],
    [...validRow('task-pending'), ''],
  ]
  const sandbox = makeSandbox({
    rows,
    fetch: (_url, params) => {
      sentBodies.push(params.payload)
      const dataRows = params.payload.split('\n').length - 1
      return { status: 200, body: importedReceipt(dataRows) }
    },
  })
  await runImport(sandbox)

  assert.equal(sentBodies.length, 1)
  assert.ok(sentBodies[0].includes('task-pending'))
  assert.ok(!sentBodies[0].includes('task-done'))
  assert.ok(!sentBodies[0].includes('task-review'))
})

test('a duplicate Task ID inside one batch goes to review while the first occurrence imports', async () => {
  const sentBodies: string[] = []
  const rows = [
    validRow('task-dup'),
    validRow('task-other'),
    validRow('task-dup'),
  ]
  const sandbox = makeSandbox({
    rows,
    fetch: (_url, params) => {
      sentBodies.push(params.payload)
      const dataRows = params.payload.split('\n').length - 1
      return { status: 200, body: importedReceipt(dataRows) }
    },
  })
  await runImport(sandbox)

  assert.equal(sentBodies.length, 1)
  const dataRows = sentBodies[0].split('\n').slice(1)
  assert.equal(
    dataRows.filter((row) => row.startsWith('task-dup')).length,
    1,
    'exactly one occurrence of the duplicated Task ID is submitted',
  )
  assert.ok(sentBodies[0].includes('task-other'))
  const written = sandbox.writtenStatuses() as string[][]
  assert.equal(written[0][0], 'Submitted')
  assert.equal(written[2][0], 'Needs review')
})

test('a row with blank Task ID but other data is marked Needs review', async () => {
  const sentBodies: string[] = []
  const rows = [
    validRow('task-ok'),
    ['', ...validRow('task-blank').slice(1)],
  ]
  const sandbox = makeSandbox({
    rows,
    fetch: (_url, params) => {
      sentBodies.push(params.payload)
      const dataRows = params.payload.split('\n').length - 1
      return { status: 200, body: importedReceipt(dataRows) }
    },
  })
  await runImport(sandbox)

  assert.equal(sentBodies.length, 1)
  assert.equal(sentBodies[0].split('\n').length - 1, 1)
  const written = sandbox.writtenStatuses() as string[][]
  assert.equal(written[0][0], 'Submitted')
  assert.equal(written[1][0], 'Needs review')
})

test('an impossible calendar datetime is marked Needs review before send', async () => {
  const sentBodies: string[] = []
  const rows = [
    validRow('task-bad-date').map((value, index) =>
      index === 2 ? '2026-02-31 10:00:00' : value,
    ),
  ]
  const sandbox = makeSandbox({
    rows,
    fetch: (_url, params) => {
      sentBodies.push(params.payload)
      return { status: 200, body: importedReceipt(1) }
    },
  })
  await runImport(sandbox)

  assert.equal(sentBodies.length, 0)
  const written = sandbox.writtenStatuses() as string[][]
  assert.equal(written[0][0], 'Needs review')
  assert.equal(
    sandbox.logs.find((log) => log.event === 'kaudit_usage_row_invalid')?.code,
    'DATETIME_INVALID',
  )
})
