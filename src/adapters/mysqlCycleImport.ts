import { randomUUID } from 'node:crypto'
import type {
  Pool,
  PoolConnection,
  RowDataPacket,
} from 'mysql2/promise'
import { normalizeRecordingUrl } from '../backfill/normalizeRecordingUrl.ts'
import { parseUsageCsv } from '../imports/csv.ts'
import type { UsageRow } from '../imports/csv.ts'
import { sha256Hex } from '../lib/hash.ts'
import type {
  CycleImportService,
  ImportResult,
  InvoiceImportRequest,
  UsageImportRequest,
} from '../imports/types.ts'
import type { ImportObjectStore } from '../imports/objectStore.ts'
import { safeImportFilename } from '../imports/objectStore.ts'
import { canonicalJson } from '../messaging/canonicalJson.ts'

interface SourceRow extends RowDataPacket {
  id: string
  vendor_account_id: string
}

interface DuplicateRow extends RowDataPacket {
  resource_id: string
}

interface ExternalReferenceRow extends RowDataPacket {
  external_id: string
}

interface BatchRow extends RowDataPacket {
  id: string
  batch_type: string
  source_period_start: string | null
  source_period_end: string | null
  status: string
  received_count: number
  accepted_count: number
  rejected_count: number
  duplicate_count: number
  started_at: Date | string
}

interface InvoiceRow extends RowDataPacket {
  id: string
  invoice_number: string
  period_start: string
  period_end: string
  total_amount: string
  status: string
}

export interface CycleImportConfig {
  objectStore: ImportObjectStore
  sourceConnectionId: string | null
  allowedRecordingHosts: string[]
}

export const USAGE_IMPORT_WRITE_BATCH_SIZE = 500

class ImportInputError extends Error {
  readonly code = 'INVALID_IMPORT'
  readonly status = 400
}

export function usageProviderCostClaims(row: UsageRow) {
  return [
    {
      providerSku: 'duration_with_ringing_sec',
      quantity: row.durationWithRingingSec,
      quantityUnit: 'second',
      minutes: null,
    },
    {
      providerSku: 'duration_without_ringing_sec',
      quantity: row.durationWithoutRingingSec,
      quantityUnit: 'second',
      minutes: null,
    },
    {
      providerSku: 'vendor_asserted_billed_minutes',
      quantity: row.durationMinutes,
      quantityUnit: 'minute',
      minutes: row.durationMinutes,
    },
    ...(row.billedAmount == null
      ? []
      : [{
          providerSku: 'vendor_asserted_billed_amount',
          quantity: row.billedAmount,
          quantityUnit: 'currency',
          minutes: null,
        }] as const),
  ] as const
}

function dateOnly(value: string, name: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new ImportInputError(`${name} must use YYYY-MM-DD`)
  }
  return value
}

function money(value: string, name: string): string {
  if (!/^\d+(?:\.\d{1,8})?$/.test(value)) {
    throw new ImportInputError(`${name} must be a non-negative decimal`)
  }
  return Number(value).toFixed(8)
}

function sqlDateTime(value: string, name: string): string | null {
  const trimmed = value.trim()
  if (!trimmed) return null
  const iso = trimmed.match(
    /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/,
  )
  if (iso) {
    return `${iso[1]}-${iso[2]}-${iso[3]} ${iso[4]}:${iso[5]}:${iso[6] ?? '00'}`
  }
  const indian = trimmed.match(
    /^(\d{1,2})\/(\d{1,2})\/(\d{4})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?/,
  )
  if (indian) {
    return `${indian[3]}-${indian[2].padStart(2, '0')}-${indian[1].padStart(2, '0')} ${indian[4].padStart(2, '0')}:${indian[5]}:${indian[6] ?? '00'}`
  }
  throw new ImportInputError(
    `${name} must be YYYY-MM-DD HH:mm:ss or DD/MM/YYYY HH:mm:ss`,
  )
}

function chunks<T>(values: readonly T[], size: number): T[][] {
  const result: T[][] = []
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size))
  }
  return result
}

async function bulkInsert(
  connection: PoolConnection,
  sql: string,
  rows: ReadonlyArray<ReadonlyArray<string | number | null>>,
): Promise<void> {
  if (rows.length === 0) return
  const tuple = `(${rows[0]?.map(() => '?').join(', ')})`
  await connection.execute(
    `${sql} VALUES ${rows.map(() => tuple).join(', ')}`,
    rows.flat(),
  )
}

interface PreparedUsageRow {
  row: UsageRow
  callId: string
  legId: string
  artifactId: string
  startedAt: string | null
  connectedAt: string | null
  endedAt: string | null
  sourceUrl: string | null
}

async function resolveSource(
  pool: Pool,
  configuredId: string | null,
): Promise<SourceRow> {
  if (configuredId) {
    const [rows] = await pool.execute<SourceRow[]>(
      `SELECT id, vendor_account_id
       FROM kaudit_source_connection
       WHERE id = ? AND status = 'active'`,
      [configuredId],
    )
    if (rows[0]) return rows[0]
    throw new Error('Configured KServe source connection is not active')
  }
  const [rows] = await pool.query<SourceRow[]>(
    `SELECT id, vendor_account_id
     FROM kaudit_source_connection
     WHERE status = 'active'
     ORDER BY
       CASE
         WHEN LOWER(adapter_code) LIKE '%kserve%'
           OR LOWER(source_type) LIKE '%kserve%'
           OR LOWER(adapter_code) LIKE '%gas%'
         THEN 0 ELSE 1
       END,
       created_at, id
     LIMIT 2`,
  )
  if (rows.length === 1) return rows[0] as SourceRow
  throw new Error(
    'Set KAUDIT_KSERVE_SOURCE_CONNECTION_ID because the active source connection is ambiguous',
  )
}

async function findDuplicate(
  connection: PoolConnection,
  sourceConnectionId: string,
  idempotencyKey: string,
): Promise<string | null> {
  const [rows] = await connection.execute<DuplicateRow[]>(
    `SELECT evidence_object_id AS resource_id
     FROM kaudit_source_envelope
     WHERE source_connection_id = ? AND idempotency_key = ?
     FOR UPDATE`,
    [sourceConnectionId, idempotencyKey],
  )
  return rows[0]?.resource_id ?? null
}

export function createMysqlCycleImportService(
  pool: Pool,
  config: CycleImportConfig,
): CycleImportService {
  return {
    async status() {
      let enabled = true
      try {
        await resolveSource(pool, config.sourceConnectionId)
      } catch {
        enabled = false
      }
      const [batchRows, invoiceRows] = await Promise.all([
        pool.query<BatchRow[]>(
          `SELECT id, batch_type, source_period_start, source_period_end,
                  status, received_count, accepted_count, rejected_count,
                  duplicate_count, started_at
           FROM kaudit_ingestion_batch
           ORDER BY started_at DESC, id DESC LIMIT 10`,
        ),
        pool.query<InvoiceRow[]>(
          `SELECT id, invoice_number, period_start, period_end,
                  CAST(total_amount AS CHAR) AS total_amount, status
           FROM kaudit_invoice
           ORDER BY invoice_date DESC, id DESC LIMIT 10`,
        ),
      ])
      return {
        enabled,
        storageBoundary: config.objectStore.storageBoundary,
        recentBatches: batchRows[0].map((row) => ({
          id: row.id,
          type: row.batch_type,
          periodStart: row.source_period_start,
          periodEnd: row.source_period_end,
          status: row.status,
          received: Number(row.received_count),
          accepted: Number(row.accepted_count),
          rejected: Number(row.rejected_count),
          duplicates: Number(row.duplicate_count),
          startedAt:
            row.started_at instanceof Date
              ? row.started_at.toISOString()
              : String(row.started_at),
        })),
        recentInvoices: invoiceRows[0].map((row) => ({
          id: row.id,
          invoiceNumber: row.invoice_number,
          periodStart: row.period_start,
          periodEnd: row.period_end,
          totalAmount: row.total_amount,
          status: row.status,
        })),
      }
    },

    async importUsage(request): Promise<ImportResult> {
      const periodStart = dateOnly(request.periodStart, 'periodStart')
      const periodEnd = dateOnly(request.periodEnd, 'periodEnd')
      const rows = parseUsageCsv(request.bytes)
      const preparedRows: PreparedUsageRow[] = rows.map((row) => {
        let sourceUrl: string | null = null
        if (row.recordingUrl) {
          const normalized = normalizeRecordingUrl(
            row.recordingUrl,
            config.allowedRecordingHosts,
          )
          if (!normalized.ok || !normalized.s3Url) {
            throw new ImportInputError(
              `Task ${row.taskId}: recording URL is not an approved canonical source`,
            )
          }
          sourceUrl = normalized.s3Url
        }
        return {
          row,
          callId: randomUUID(),
          legId: randomUUID(),
          artifactId: randomUUID(),
          startedAt: sqlDateTime(row.callStartTime, 'Call Start Time'),
          connectedAt: sqlDateTime(
            row.callConnectedTime,
            'Call Connected Time',
          ),
          endedAt: sqlDateTime(row.callEndTime, 'Call End Time'),
          sourceUrl,
        }
      })
      const preserved = await config.objectStore.preserve({
        bytes: request.bytes,
        filename: request.filename,
        mediaType: 'text/csv',
      })
      const source = await resolveSource(pool, config.sourceConnectionId)
      const idempotencyKey = `usage-file:${preserved.sha256}`
      const connection = await pool.getConnection()
      try {
        await connection.beginTransaction()
        const duplicate = await findDuplicate(
          connection,
          source.id,
          idempotencyKey,
        )
        if (duplicate) {
          await connection.commit()
          return {
            outcome: 'duplicate',
            referenceId: duplicate,
            received: rows.length,
            accepted: 0,
            duplicates: rows.length,
            auditJobsQueued: 0,
            missingRecordingUrls: 0,
          }
        }
        const batchId = randomUUID()
        const evidenceId = randomUUID()
        const envelopeId = randomUUID()
        await connection.execute(
          `INSERT INTO kaudit_ingestion_batch
             (id, source_connection_id, batch_type, source_period_start,
              source_period_end, status, received_count)
           VALUES (?, ?, 'call_export', ?, ?, 'running', ?)`,
          [batchId, source.id, periodStart, periodEnd, rows.length],
        )
        await connection.execute(
          `INSERT INTO kaudit_evidence_object
             (id, ingestion_batch_id, source_connection_id, evidence_type,
              object_bucket, object_key, sha256, size_bytes,
              declared_media_type, detected_media_type, source_uri_redacted,
              source_event_id, malware_status, retention_class, status)
           VALUES (?, ?, ?, 'call_export', ?, ?, ?, ?,
                   'text/csv', 'text/csv', ?, ?, 'not_scanned',
                   'vendor_billing_evidence', 'active')`,
          [
            evidenceId,
            batchId,
            source.id,
            preserved.objectBucket,
            preserved.objectKey,
            preserved.sha256,
            request.bytes.byteLength,
            safeImportFilename(request.filename),
            preserved.sha256,
          ],
        )
        await connection.execute(
          `INSERT INTO kaudit_source_envelope
             (id, evidence_object_id, source_connection_id, external_event_id,
              event_type, idempotency_key, schema_version, signature_status,
              normalization_status)
           VALUES (?, ?, ?, ?, 'monthly_usage_export', ?, '1',
                   'not_applicable', 'processing')`,
          [
            envelopeId,
            evidenceId,
            source.id,
            preserved.sha256,
            idempotencyKey,
          ],
        )
        let accepted = 0
        let duplicates = 0
        let queued = 0
        let missingRecordingUrls = 0
        for (const batch of chunks(preparedRows, USAGE_IMPORT_WRITE_BATCH_SIZE)) {
          const taskIds = batch.map(({ row }) => row.taskId)
          const [existing] =
            await connection.execute<ExternalReferenceRow[]>(
              `SELECT external_id
               FROM kaudit_call_external_reference
               WHERE provider_name = 'kserve'
                 AND reference_type = 'task_id'
                 AND external_id IN (${taskIds.map(() => '?').join(', ')})
               FOR UPDATE`,
              taskIds,
            )
          const existingIds = new Set(existing.map((item) => item.external_id))
          const pending = batch.filter(({ row }) => !existingIds.has(row.taskId))
          duplicates += batch.length - pending.length
          if (pending.length === 0) continue

          await bulkInsert(
            connection,
            `INSERT INTO kaudit_call
               (id, vendor_account_id, logical_call_key, direction,
                sensitivity_tier, subject_jurisdiction_code,
                source_started_at, source_ended_at, billing_period_date,
                processing_status)`,
            pending.map((item) => [
              item.callId,
              source.vendor_account_id,
              `kserve-task:${item.row.taskId}`,
              'outbound',
              'K1',
              'IN',
              item.startedAt,
              item.endedAt,
              periodStart,
              'ingested',
            ]),
          )
          await bulkInsert(
            connection,
            `INSERT INTO kaudit_call_external_reference
               (id, call_id, provider_type, provider_name, reference_type,
                external_id, source_evidence_object_id)`,
            pending.map((item) => [
              randomUUID(),
              item.callId,
              'voice_vendor',
              'kserve',
              'task_id',
              item.row.taskId,
              evidenceId,
            ]),
          )
          await bulkInsert(
            connection,
            `INSERT INTO kaudit_call_leg
               (id, call_id, leg_type, provider_name, external_leg_id,
                direction, from_party_type, to_party_type, initiated_at,
                answered_at, ended_at, sequence_no)`,
            pending.map((item) => [
              item.legId,
              item.callId,
              'primary',
              'kserve',
              item.row.taskId,
              'outbound',
              'agent',
              'customer',
              item.startedAt,
              item.connectedAt,
              item.endedAt,
              1,
            ]),
          )
          await bulkInsert(
            connection,
            `INSERT INTO kaudit_provider_cost
               (id, call_id, call_leg_id, source_evidence_object_id,
                provider_name, component_type, provider_sku,
                quantity_decimal, quantity_unit, minutes_decimal, currency,
                cost_occurred_at, is_final, source_cost_id, raw_json)`,
            pending.flatMap((item) =>
              usageProviderCostClaims(item.row).map((cost) => [
                randomUUID(),
                item.callId,
                item.legId,
                evidenceId,
                'kserve',
                'platform',
                cost.providerSku,
                cost.quantity,
                cost.quantityUnit,
                cost.minutes,
                'INR',
                item.startedAt,
                1,
                `${item.row.taskId}:${cost.providerSku}`,
                canonicalJson({
                  source: 'monthly_usage_csv',
                  taskId: item.row.taskId,
                  providerSku: cost.providerSku,
                }),
              ]),
            ),
          )
          await bulkInsert(
            connection,
            `INSERT INTO kaudit_call_artifact
               (id, call_id, call_leg_id, artifact_type,
                provider_artifact_id, provider_status, fetch_status,
                audio_processing_status, is_final, source_url)`,
            pending.map((item) => [
              item.artifactId,
              item.callId,
              item.legId,
              'recording',
              item.row.taskId,
              item.sourceUrl ? 'available' : 'not_provided',
              item.sourceUrl ? 'pending' : 'unavailable',
              'pending',
              1,
              item.sourceUrl,
            ]),
          )
          const auditable = pending.filter((item) => item.sourceUrl)
          await bulkInsert(
            connection,
            `INSERT INTO kaudit_outbox_message
               (id, message_id, aggregate_type, aggregate_id, event_type,
                payload_json, payload_sha256, correlation_id, attempts, status)`,
            auditable.map((item) => {
              const payloadJson = canonicalJson({
                callId: item.callId,
                artifactId: item.artifactId,
                sourceEnvelopeId: envelopeId,
                sourceEvidenceSha256: preserved.sha256,
              })
              return [
                randomUUID(),
                `audit-requested:${item.callId}:${preserved.sha256}`,
                'call',
                item.callId,
                'call.audit_requested',
                payloadJson,
                sha256Hex(payloadJson),
                request.correlationId,
                0,
                'pending',
              ]
            }),
          )
          accepted += pending.length
          queued += auditable.length
          missingRecordingUrls += pending.length - auditable.length
        }
        await connection.execute(
          `UPDATE kaudit_source_envelope
           SET normalized_at = current_timestamp(6),
               normalization_status = 'completed'
           WHERE id = ?`,
          [envelopeId],
        )
        await connection.execute(
          `UPDATE kaudit_ingestion_batch
           SET status = 'completed', accepted_count = ?,
               duplicate_count = ?, completed_at = current_timestamp(6)
           WHERE id = ?`,
          [accepted, duplicates, batchId],
        )
        await connection.commit()
        return {
          outcome: 'imported',
          referenceId: batchId,
          received: rows.length,
          accepted,
          duplicates,
          auditJobsQueued: queued,
          missingRecordingUrls,
        }
      } catch (error) {
        await connection.rollback()
        throw error
      } finally {
        connection.release()
      }
    },

    async importInvoice(request: InvoiceImportRequest): Promise<ImportResult> {
      if (!request.filename.toLowerCase().endsWith('.pdf')) {
        throw new ImportInputError('Invoice must be a PDF')
      }
      if (!request.bytes.subarray(0, 5).equals(Buffer.from('%PDF-'))) {
        throw new ImportInputError('Invoice bytes are not a PDF')
      }
      const invoiceDate = dateOnly(request.invoiceDate, 'invoiceDate')
      const periodStart = dateOnly(request.periodStart, 'periodStart')
      const periodEnd = dateOnly(request.periodEnd, 'periodEnd')
      const subtotal = money(request.subtotalAmount, 'subtotalAmount')
      const tax = money(request.taxAmount, 'taxAmount')
      const total = money(request.totalAmount, 'totalAmount')
      const preserved = await config.objectStore.preserve({
        bytes: request.bytes,
        filename: request.filename,
        mediaType: 'application/pdf',
      })
      const source = await resolveSource(pool, config.sourceConnectionId)
      const idempotencyKey = `invoice-file:${preserved.sha256}`
      const connection = await pool.getConnection()
      try {
        await connection.beginTransaction()
        const duplicate = await findDuplicate(
          connection,
          source.id,
          idempotencyKey,
        )
        if (duplicate) {
          await connection.commit()
          return {
            outcome: 'duplicate',
            referenceId: duplicate,
            received: 1,
            accepted: 0,
            duplicates: 1,
            auditJobsQueued: 0,
            missingRecordingUrls: 0,
          }
        }
        const evidenceId = randomUUID()
        const invoiceId = randomUUID()
        await connection.execute(
          `INSERT INTO kaudit_evidence_object
             (id, source_connection_id, evidence_type, object_bucket,
              object_key, sha256, size_bytes, declared_media_type,
              detected_media_type, source_uri_redacted, source_event_id,
              malware_status, retention_class, status)
           VALUES (?, ?, 'invoice', ?, ?, ?, ?,
                   'application/pdf', 'application/pdf', ?, ?,
                   'not_scanned', 'finance_record', 'active')`,
          [
            evidenceId,
            source.id,
            preserved.objectBucket,
            preserved.objectKey,
            preserved.sha256,
            request.bytes.byteLength,
            safeImportFilename(request.filename),
            request.invoiceNumber,
          ],
        )
        await connection.execute(
          `INSERT INTO kaudit_source_envelope
             (id, evidence_object_id, source_connection_id, external_event_id,
              event_type, idempotency_key, schema_version, signature_status,
              normalized_at, normalization_status)
           VALUES (?, ?, ?, ?, 'monthly_invoice', ?, '1',
                   'not_applicable', current_timestamp(6), 'completed')`,
          [
            randomUUID(),
            evidenceId,
            source.id,
            request.invoiceNumber,
            idempotencyKey,
          ],
        )
        await connection.execute(
          `INSERT INTO kaudit_invoice
             (id, vendor_account_id, invoice_number, invoice_date,
              period_start, period_end, currency, subtotal_amount,
              tax_amount, total_amount, status, original_evidence_object_id,
              revision_no)
           VALUES (?, ?, ?, ?, ?, ?, 'INR', ?, ?, ?, 'received', ?, 1)`,
          [
            invoiceId,
            source.vendor_account_id,
            request.invoiceNumber,
            invoiceDate,
            periodStart,
            periodEnd,
            subtotal,
            tax,
            total,
            evidenceId,
          ],
        )
        await connection.commit()
        return {
          outcome: 'imported',
          referenceId: invoiceId,
          received: 1,
          accepted: 1,
          duplicates: 0,
          auditJobsQueued: 0,
          missingRecordingUrls: 0,
        }
      } catch (error) {
        await connection.rollback()
        throw error
      } finally {
        connection.release()
      }
    },
  }
}
