import PDFDocument from 'pdfkit'
import { strToU8, zipSync } from 'fflate'
import type { MonthlyEmailReport } from './monthlyEmailReport.ts'
import { formatMoney } from '../ui/decimal.ts'

function xml(value: unknown): string {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}

function columnName(index: number): string {
  let value = index + 1
  let result = ''
  while (value > 0) {
    const remainder = (value - 1) % 26
    result =
      String.fromCharCode(65 + remainder) + result
    value = Math.floor((value - 1) / 26)
  }
  return result
}

/**
 * The settlement lines every artifact repeats, in one place so the workbook,
 * the PDF, and the email can never state three different figures.
 *
 * An unavailable amount is printed as an explicit phrase, never as a blank cell
 * or a zero: a reader must be able to tell "nothing was recorded for this
 * month" from "we paid nothing".
 */
const NOT_RECORDED = 'Not recorded for this period'
const NOT_AVAILABLE = 'Unavailable — no settlement recorded'
/**
 * A read that FAILED, which is a different statement from "nothing was
 * recorded": one describes the month, the other describes this run. Fixed
 * prose, identical for every failure, so no driver message, table name, value
 * or identity can reach a workbook, a PDF, or a mailbox.
 */
const TEMPORARILY_UNAVAILABLE = 'Settlement temporarily unavailable'

function settlementLines(
  report: MonthlyEmailReport,
): Array<[string, string]> {
  const settlement = report.settlement
  if (settlement?.status === 'unavailable') {
    return [
      ['Finally paid to KServe', TEMPORARILY_UNAVAILABLE],
      ['KServe billed for the month', TEMPORARILY_UNAVAILABLE],
      ['Savings vs KServe billed', TEMPORARILY_UNAVAILABLE],
    ]
  }
  if (!settlement || settlement.status !== 'recorded') {
    return [
      ['Finally paid to KServe', NOT_RECORDED],
      ['Savings vs KServe billed', NOT_AVAILABLE],
    ]
  }
  const currency = settlement.currency
  return [
    [
      'Finally paid to KServe',
      `${formatMoney(settlement.finallyPaidAmount, currency)} ` +
        `(version ${settlement.finallyPaidVersion ?? '—'})`,
    ],
    [
      'KServe billed for the month',
      settlement.vendorBilledChargeAmount == null
        ? 'Unavailable — no vendor billed evidence'
        : formatMoney(settlement.vendorBilledChargeAmount, currency),
    ],
    [
      'Savings vs KServe billed',
      settlement.savingsAvailable
        ? `${formatMoney(settlement.savingsAmount, currency)} ` +
          `(${settlement.savingsDirection})`
        : NOT_AVAILABLE,
    ],
  ]
}

function worksheetXml(report: MonthlyEmailReport): string {
  const settlement = settlementLines(report)
  const heading: Array<Array<string | number>> = [
    ['Kairali AI Call Audit — monthly revenue report'],
    ['Period', report.period.label],
    ['Authority', report.authority],
    ['Source manifest SHA-256', report.sourceManifestSha256],
    ...settlement,
    [],
  ]
  /**
   * Spreadsheet rows are 1-based and the filter must start on the header row.
   * It is derived from the heading block rather than hard-coded, so adding a
   * settlement line can never silently point the filter at a data row.
   */
  const headerRow = heading.length + 1
  const values: Array<Array<string | number>> = [
    ...heading,
    [
      'Task / call reference',
      'Category',
      'Confidence',
      'Resolution',
      'KServe billed minutes',
      'KServe derived amount',
      'Verified billable minutes',
      'Verified amount',
      'Variance',
      'Currency',
    ],
    ...report.rows.map((row) => [
      row.callReference,
      row.category,
      row.confidence ?? '',
      row.resolution,
      row.vendorBilledMinutes,
      row.vendorAmount,
      row.verifiedBillableMinutes,
      row.verifiedAmount,
      row.variance,
      row.currency,
    ]),
  ]
  const rows = values
    .map((row, rowIndex) => {
      const cells = row
        .map(
          (value, columnIndex) =>
            `<c r="${columnName(columnIndex)}${rowIndex + 1}" t="inlineStr"><is><t xml:space="preserve">${xml(value)}</t></is></c>`,
        )
        .join('')
      return `<row r="${rowIndex + 1}">${cells}</row>`
    })
    .join('')
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetViews><sheetView workbookViewId="0"/></sheetViews>
  <cols>
    <col min="1" max="1" width="34" customWidth="1"/>
    <col min="2" max="4" width="28" customWidth="1"/>
    <col min="5" max="10" width="22" customWidth="1"/>
  </cols>
  <sheetData>${rows}</sheetData>
  <autoFilter ref="A${headerRow}:J${Math.max(headerRow, values.length)}"/>
</worksheet>`
}

export function buildReportXlsx(
  report: MonthlyEmailReport,
): Buffer {
  const files = {
    '[Content_Types].xml': strToU8(`<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
</Types>`),
    '_rels/.rels': strToU8(`<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`),
    'xl/workbook.xml': strToU8(`<?xml version="1.0" encoding="UTF-8"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets><sheet name="Call variance" sheetId="1" r:id="rId1"/></sheets>
</workbook>`),
    'xl/_rels/workbook.xml.rels': strToU8(`<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
</Relationships>`),
    'xl/worksheets/sheet1.xml': strToU8(
      worksheetXml(report),
    ),
  }
  return Buffer.from(zipSync(files, { level: 6 }))
}

export function buildReportPdf(
  report: MonthlyEmailReport,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const document = new PDFDocument({
      size: 'A4',
      margin: 48,
      info: {
        Title: `Kairali ${report.period.label} AI Call Audit`,
        Author: 'Kairali AI Call Audit Platform',
      },
    })
    const chunks: Buffer[] = []
    document.on('data', (chunk) =>
      chunks.push(Buffer.from(chunk)),
    )
    document.on('error', reject)
    document.on('end', () => resolve(Buffer.concat(chunks)))

    document
      .fontSize(18)
      .text('Kairali AI Call Audit')
      .fontSize(12)
      .fillColor('#475569')
      .text(`${report.period.label} revenue variance report`)
      .moveDown()
      .fillColor('#0f172a')
      .fontSize(10)
      .text('Authority: authoritative automated cycle output')
      .text(`Generated: ${report.generatedAt}`)
      .text(
        `Source manifest SHA-256: ${report.sourceManifestSha256}`,
      )
      .moveDown()
      .fontSize(13)
      .text('Management summary')
      .fontSize(11)
      .text(
        `Verified billable revenue: ${formatMoney(
          report.summary.verifiedBillableRevenue,
          report.summary.currency,
        )}`,
      )
      .text(
        `Vendor invoice claim: ${formatMoney(
          report.summary.invoiceClaimedAmount,
          report.summary.currency,
        )}`,
      )
      .text(
        `Variance vs invoice: ${formatMoney(
          report.summary.revenueVarianceVsInvoice,
          report.summary.currency,
        )}`,
      )
      .moveDown()
      .fontSize(13)
      .text('How the month resolved')
      .fontSize(9)
      .fillColor('#475569')
      .text(
        'Every call, grouped by how its amount was established. Variance is the vendor amount less the audited amount for the same calls.',
      )
      .fillColor('#000000')
      .fontSize(10)
    for (const group of report.resolutionBreakdown) {
      document
        .fontSize(10)
        .text(
          `${group.label} — ${group.calls.toLocaleString('en-IN')} calls`,
        )
        .fontSize(9)
        .fillColor('#475569')
        .text(
          `vendor ${formatMoney(group.vendorAmount, report.summary.currency)}` +
            ` · audited ${formatMoney(group.verifiedAmount, report.summary.currency)}` +
            ` · variance ${formatMoney(group.variance, report.summary.currency)}`,
        )
        .text(group.explanation)
        .fillColor('#000000')
        .moveDown(0.4)
    }
    document
      .moveDown()
      .fontSize(13)
      .text('Settlement with KServe')
      .fontSize(11)
    for (const [label, value] of settlementLines(report)) {
      document.text(`${label}: ${value}`)
    }
    document
      .moveDown()
      .fontSize(10)
      .text(
        `${report.summary.totalCalls.toLocaleString('en-IN')} calls: ` +
          `${report.summary.independentlyAuditedCalls.toLocaleString('en-IN')} independently audited; ` +
          `${report.summary.acceptedAsBilledCalls.toLocaleString('en-IN')} accepted as billed because independent evidence was unavailable.`,
      )
      .moveDown()
      .fillColor('#475569')
      .text(
        'The attached workbook and CSV contain call-level backup, one row per call with the reason it resolved as it did. Positive variance means the vendor claim exceeds Kairali’s independently verified amount. Calls shown as accepted or as having no recording were NOT independently verified, and are labelled as such rather than counted as audited. This report does not itself send a vendor dispute or make payment.',
      )
    document.end()
  })
}

function html(value: unknown): string {
  return xml(value)
}

export function buildReportEmailHtml(
  report: MonthlyEmailReport,
): string {
  return `<!doctype html>
<html><body style="font-family:Arial,sans-serif;color:#0f172a;line-height:1.5">
  <h1 style="font-size:20px">Kairali AI Call Audit — ${html(report.period.label)}</h1>
  <p>The automated billing cycle is complete and the authoritative internal report is attached.</p>
  <table role="presentation" style="border-collapse:collapse">
    <tr><td style="padding:8px;border:1px solid #cbd5e1">Verified billable revenue</td><td style="padding:8px;border:1px solid #cbd5e1"><strong>${html(formatMoney(report.summary.verifiedBillableRevenue, report.summary.currency))}</strong></td></tr>
    <tr><td style="padding:8px;border:1px solid #cbd5e1">Vendor invoice claim</td><td style="padding:8px;border:1px solid #cbd5e1"><strong>${html(formatMoney(report.summary.invoiceClaimedAmount, report.summary.currency))}</strong></td></tr>
    <tr><td style="padding:8px;border:1px solid #cbd5e1">Variance identified</td><td style="padding:8px;border:1px solid #cbd5e1"><strong>${html(formatMoney(report.summary.revenueVarianceVsInvoice, report.summary.currency))}</strong></td></tr>
${settlementLines(report)
  .map(
    ([label, value]) =>
      `    <tr><td style="padding:8px;border:1px solid #cbd5e1">${html(label)}</td><td style="padding:8px;border:1px solid #cbd5e1"><strong>${html(value)}</strong></td></tr>`,
  )
  .join('\n')}
  </table>
  <p>${report.summary.totalCalls.toLocaleString('en-IN')} calls are included. The PDF is the concise management summary; the Excel workbook is the call-level backup.</p>
  <p style="color:#475569;font-size:12px">Manifest: ${html(report.sourceManifestSha256)}. This automated email does not submit a dispute or authorize payment.</p>
</body></html>`
}

