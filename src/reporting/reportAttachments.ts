import PDFDocument from 'pdfkit'
import { strToU8, zipSync } from 'fflate'
import type { MonthlyEmailReport } from './monthlyEmailReport.ts'
import { formatMoney, toScaled } from '../ui/decimal.ts'

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

type PdfDocument = InstanceType<typeof PDFDocument>

const PDF_COLORS = Object.freeze({
  ink: '#102A32',
  muted: '#60747A',
  line: '#D9E2E4',
  paper: '#F5F8F7',
  white: '#FFFFFF',
  teal: '#087F76',
  tealSoft: '#DDF3EF',
  green: '#1D7A4C',
  greenSoft: '#E5F4EA',
  gold: '#B7791F',
  goldSoft: '#FFF3D6',
})

function pdfMoney(
  value: string | null,
  currency: string,
): string {
  return value == null ? 'Unavailable' : formatMoney(value, currency)
}

function pdfText(value: string): string {
  return value.replace(/[\u2011\u2013\u2014]/g, '-')
}

function ratio(value: string, total: string): number {
  const scaledValue = toScaled(value)
  const scaledTotal = toScaled(total)
  if (scaledValue == null || scaledTotal == null || scaledTotal <= 0n) {
    return 0
  }
  const basisPoints = (scaledValue * 10_000n) / scaledTotal
  return Math.max(0, Math.min(1, Number(basisPoints) / 10_000))
}

function roundedPanel(
  document: PdfDocument,
  x: number,
  y: number,
  width: number,
  height: number,
  fill: string,
  stroke = fill,
): void {
  document
    .roundedRect(x, y, width, height, 6)
    .fillAndStroke(fill, stroke)
}

function sectionTitle(
  document: PdfDocument,
  eyebrow: string,
  title: string,
  y: number,
): number {
  document
    .font('Helvetica-Bold')
    .fontSize(7)
    .fillColor(PDF_COLORS.teal)
    .text(eyebrow.toUpperCase(), 42, y, { characterSpacing: 1.2 })
    .fontSize(17)
    .fillColor(PDF_COLORS.ink)
    .text(title, 42, y + 14)
  return y + 43
}

function metricCard(
  document: PdfDocument,
  options: {
    x: number
    y: number
    width: number
    label: string
    value: string
    note: string
    accent: string
    fill: string
  },
): void {
  roundedPanel(
    document,
    options.x,
    options.y,
    options.width,
    90,
    options.fill,
  )
  document.rect(options.x, options.y, 4, 90).fill(options.accent)
  document
    .font('Helvetica-Bold')
    .fontSize(7.5)
    .fillColor(PDF_COLORS.muted)
    .text(options.label.toUpperCase(), options.x + 14, options.y + 14, {
      width: options.width - 28,
      characterSpacing: 0.7,
    })
    .fontSize(16)
    .fillColor(PDF_COLORS.ink)
    .text(options.value, options.x + 14, options.y + 34, {
      width: options.width - 28,
    })
    .font('Helvetica')
    .fontSize(7.5)
    .fillColor(PDF_COLORS.muted)
    .text(options.note, options.x + 14, options.y + 63, {
      width: options.width - 28,
      lineGap: 1,
    })
}

function drawPageHeader(
  document: PdfDocument,
  report: MonthlyEmailReport,
  pageLabel: string,
): void {
  document.rect(0, 0, document.page.width, document.page.height)
    .fill(PDF_COLORS.white)
  document.rect(0, 0, document.page.width, 76).fill(PDF_COLORS.ink)
  document.circle(58, 38, 18).fill(PDF_COLORS.teal)
  document
    .font('Helvetica-Bold')
    .fontSize(17)
    .fillColor(PDF_COLORS.white)
    .text('K', 52.5, 27.5)
    .fontSize(11)
    .text('KAIRALI BILLING AUDIT', 86, 24)
    .font('Helvetica')
    .fontSize(8)
    .fillColor('#B7C8CB')
    .text(`${report.period.label}  |  ${pageLabel}`, 86, 43)
  document
    .font('Helvetica-Bold')
    .fontSize(7)
    .fillColor(PDF_COLORS.tealSoft)
    .text('AUTHORITATIVE', 456, 31, { width: 96, align: 'right' })
}

function addFooter(
  document: PdfDocument,
  report: MonthlyEmailReport,
  pageNumber: number,
  totalPages: number,
): void {
  const y = document.page.height - 65
  document
    .moveTo(42, y - 8)
    .lineTo(document.page.width - 42, y - 8)
    .strokeColor(PDF_COLORS.line)
    .lineWidth(0.5)
    .stroke()
    .font('Helvetica')
    .fontSize(7)
    .fillColor(PDF_COLORS.muted)
    .text(
      `Restricted internal billing report  |  Manifest ${report.sourceManifestSha256.slice(0, 12)}...`,
      42,
      y,
      { width: 410, lineBreak: false },
    )
    .text(`Page ${pageNumber} of ${totalPages}`, 450, y, {
      width: 103,
      align: 'right',
      lineBreak: false,
    })
}

export function buildReportPdf(
  report: MonthlyEmailReport,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const document = new PDFDocument({
      size: 'A4',
      margin: 42,
      bufferPages: true,
      info: {
        Title: `Kairali ${report.period.label} Billing Audit`,
        Author: 'Kairali Billing Audit Platform',
      },
    })
    const chunks: Buffer[] = []
    document.on('data', (chunk) =>
      chunks.push(Buffer.from(chunk)),
    )
    document.on('error', reject)
    document.on('end', () => resolve(Buffer.concat(chunks)))

    const currency = report.summary.currency
    const vendorClaim = report.summary.invoiceClaimedAmount ??
      report.summary.vendorUsageAmount
    const variance = report.summary.revenueVarianceVsInvoice ??
      report.summary.revenueVarianceVsUsage

    drawPageHeader(document, report, 'Executive summary')
    document
      .font('Helvetica-Bold')
      .fontSize(8)
      .fillColor(PDF_COLORS.teal)
      .text('MONTHLY RECONCILIATION', 42, 106, {
        characterSpacing: 1.3,
      })
      .fontSize(28)
      .fillColor(PDF_COLORS.ink)
      .text(`${report.period.label} billing audit`, 42, 125)
      .font('Helvetica')
      .fontSize(10)
      .fillColor(PDF_COLORS.muted)
      .text(
        'A concise reconciliation of KServe billing against the final evidence-backed amount.',
        42,
        164,
        { width: 475 },
      )

    const cardWidth = 163
    metricCard(document, {
      x: 42,
      y: 203,
      width: cardWidth,
      label: 'KServe claim',
      value: pdfMoney(vendorClaim, currency),
      note: report.summary.invoiceClaimedAmount == null
        ? 'Usage evidence; invoice unavailable'
        : 'Invoice subtotal before tax',
      accent: PDF_COLORS.gold,
      fill: PDF_COLORS.goldSoft,
    })
    metricCard(document, {
      x: 216,
      y: 203,
      width: cardWidth,
      label: 'Verified billable',
      value: pdfMoney(report.summary.verifiedBillableRevenue, currency),
      note: 'Final traced billing output',
      accent: PDF_COLORS.teal,
      fill: PDF_COLORS.tealSoft,
    })
    metricCard(document, {
      x: 390,
      y: 203,
      width: cardWidth,
      label: 'Variance identified',
      value: pdfMoney(variance, currency),
      note: 'Claim less verified amount',
      accent: PDF_COLORS.green,
      fill: PDF_COLORS.greenSoft,
    })

    let y = sectionTitle(
      document,
      'Financial view',
      'Claim to verified reconciliation',
      326,
    )
    roundedPanel(document, 42, y, 511, 126, PDF_COLORS.white, PDF_COLORS.line)
    const barX = 176
    const barWidth = 333
    const vendorRatio = ratio(vendorClaim, vendorClaim)
    const verifiedRatio = ratio(
      report.summary.verifiedBillableRevenue,
      vendorClaim,
    )
    const rows = [
      {
        label: 'KServe claim',
        value: vendorClaim,
        fill: PDF_COLORS.gold,
        width: vendorRatio,
      },
      {
        label: 'Verified billable',
        value: report.summary.verifiedBillableRevenue,
        fill: PDF_COLORS.teal,
        width: verifiedRatio,
      },
    ]
    rows.forEach((row, index) => {
      const rowY = y + 22 + index * 44
      document
        .font('Helvetica-Bold')
        .fontSize(8.5)
        .fillColor(PDF_COLORS.ink)
        .text(row.label, 58, rowY + 3, { width: 108 })
        .font('Helvetica')
        .fontSize(7.5)
        .fillColor(PDF_COLORS.muted)
        .text(pdfMoney(row.value, currency), 58, rowY + 17, {
          width: 108,
        })
      document.roundedRect(barX, rowY + 7, barWidth, 14, 5)
        .fill('#E9EFEE')
      document.roundedRect(
        barX,
        rowY + 7,
        Math.max(4, barWidth * row.width),
        14,
        5,
      ).fill(row.fill)
    })

    y = sectionTitle(document, 'Coverage', 'Audit population', y + 158)
    const coverageWidth = 511
    roundedPanel(document, 42, y, coverageWidth, 112, PDF_COLORS.ink)
    const coverage = [
      ['TOTAL CALLS', report.summary.totalCalls],
      ['INDEPENDENTLY AUDITED', report.summary.independentlyAuditedCalls],
      ['EVIDENCE UNAVAILABLE', report.summary.acceptedAsBilledCalls],
    ] as const
    coverage.forEach(([label, value], index) => {
      const x = 58 + index * 164
      if (index > 0) {
        document.moveTo(x - 14, y + 20).lineTo(x - 14, y + 91)
          .strokeColor('#365159').lineWidth(0.5).stroke()
      }
      document
        .font('Helvetica-Bold')
        .fontSize(20)
        .fillColor(PDF_COLORS.white)
        .text(value.toLocaleString('en-IN'), x, y + 28, { width: 144 })
        .fontSize(7)
        .fillColor('#B7C8CB')
        .text(label, x, y + 60, {
          width: 144,
          characterSpacing: 0.6,
        })
    })
    document
      .font('Helvetica')
      .fontSize(7.5)
      .fillColor(PDF_COLORS.muted)
      .text(
        `Generated ${report.generatedAt}  |  Source manifest SHA-256: ${report.sourceManifestSha256}`,
        42,
        y + 127,
        { width: 511 },
      )

    document.addPage()
    drawPageHeader(document, report, 'Resolution and controls')
    y = sectionTitle(
      document,
      'Resolution analysis',
      'How the month resolved',
      104,
    )
    document
      .font('Helvetica')
      .fontSize(8.5)
      .fillColor(PDF_COLORS.muted)
      .text(
        'Every call is grouped by how its final amount was established. Variance is the vendor amount less the audited amount for the same calls.',
        42,
        y,
        { width: 511, lineGap: 2 },
      )
    y += 39

    for (const group of report.resolutionBreakdown) {
      const explanationHeight = document.heightOfString(group.explanation, {
        width: 479,
        lineGap: 1,
      })
      const panelHeight = Math.max(84, 63 + explanationHeight)
      if (y + panelHeight > 750) {
        document.addPage()
        drawPageHeader(document, report, 'Resolution analysis continued')
        y = sectionTitle(
          document,
          'Resolution analysis',
          'How the month resolved',
          104,
        )
      }
      roundedPanel(document, 42, y, 511, panelHeight, PDF_COLORS.white, PDF_COLORS.line)
      document.circle(61, y + 23, 9).fill(
        group.independentlyMeasured ? PDF_COLORS.teal : PDF_COLORS.gold,
      )
      document
        .font('Helvetica-Bold')
        .fontSize(10)
        .fillColor(PDF_COLORS.ink)
        .text(pdfText(group.label), 78, y + 15, { width: 290 })
        .fontSize(8)
        .fillColor(PDF_COLORS.muted)
        .text(
          `${group.calls.toLocaleString('en-IN')} calls  |  ${group.independentlyMeasured ? 'Evidence measured' : 'Evidence unavailable'}`,
          78,
          y + 31,
          { width: 290 },
        )
        .fontSize(8.5)
        .fillColor(PDF_COLORS.ink)
        .text(
          `Vendor ${formatMoney(group.vendorAmount, currency)}` +
            `  |  Audited ${formatMoney(group.verifiedAmount, currency)}` +
            `  |  Variance ${formatMoney(group.variance, currency)}`,
          344,
          y + 17,
          { width: 191, align: 'right' },
        )
        .font('Helvetica')
        .fontSize(8)
        .fillColor(PDF_COLORS.muted)
        .text(pdfText(group.explanation), 58, y + 55, {
          width: 479,
          lineGap: 1,
        })
      y += panelHeight + 10
    }

    let settlementStandalone = false
    if (y + 180 > 750) {
      document.addPage()
      drawPageHeader(document, report, 'Settlement and controls')
      y = 104
      settlementStandalone = true
    }
    y = sectionTitle(document, 'Settlement', 'Settlement with KServe', y + 14)
    const lines = settlementLines(report)
    roundedPanel(
      document,
      42,
      y,
      511,
      24 + lines.length * 34,
      PDF_COLORS.paper,
      PDF_COLORS.line,
    )
    lines.forEach(([label, value], index) => {
      const rowY = y + 12 + index * 34
      document
        .font('Helvetica')
        .fontSize(8)
        .fillColor(PDF_COLORS.muted)
        .text(label, 58, rowY, { width: 210 })
        .font('Helvetica-Bold')
        .fontSize(8.5)
        .fillColor(PDF_COLORS.ink)
        .text(pdfText(value), 275, rowY, { width: 260, align: 'right' })
      if (index < lines.length - 1) {
        document.moveTo(58, rowY + 22).lineTo(537, rowY + 22)
          .strokeColor(PDF_COLORS.line).lineWidth(0.5).stroke()
      }
    })
    y += 42 + lines.length * 34
    document
      .font('Helvetica-Bold')
      .fontSize(8)
      .fillColor(PDF_COLORS.ink)
      .text('READING THIS REPORT', 42, y)
      .font('Helvetica')
      .fontSize(7.5)
      .fillColor(PDF_COLORS.muted)
      .text(
        'The workbook and CSV contain call-level backup. Positive variance means the vendor claim exceeds Kairali\'s final audited amount. Calls with no recording are bill-audited at zero because no recording evidence was supplied; no listening or transcription result is claimed. This report does not submit a vendor dispute or authorize payment.',
        42,
        y + 17,
        { width: 511, lineGap: 2 },
      )

    if (settlementStandalone) {
      const controlsY = y + 92
      document
        .font('Helvetica-Bold')
        .fontSize(7)
        .fillColor(PDF_COLORS.teal)
        .text('CONTROLS APPLIED', 42, controlsY, {
          characterSpacing: 1.2,
        })
        .fontSize(17)
        .fillColor(PDF_COLORS.ink)
        .text('What makes this report authoritative', 42, controlsY + 14)
      const controls = [
        ['01', 'Fixed-precision money', 'Amounts retain exact decimal billing precision.'],
        ['02', 'Evidence-bound decisions', 'Final outputs remain tied to immutable evidence hashes.'],
        ['03', 'Explicit missing evidence', 'No recording is audited at zero, never presented as AI-reviewed.'],
      ] as const
      controls.forEach(([number, title, note], index) => {
        const x = 42 + index * 174
        roundedPanel(
          document,
          x,
          controlsY + 48,
          163,
          100,
          PDF_COLORS.paper,
          PDF_COLORS.line,
        )
        document
          .font('Helvetica-Bold')
          .fontSize(8)
          .fillColor(PDF_COLORS.teal)
          .text(number, x + 14, controlsY + 62)
          .fontSize(9)
          .fillColor(PDF_COLORS.ink)
          .text(title, x + 14, controlsY + 82, { width: 135 })
          .font('Helvetica')
          .fontSize(7.5)
          .fillColor(PDF_COLORS.muted)
          .text(note, x + 14, controlsY + 101, {
            width: 135,
            lineGap: 2,
          })
      })
      roundedPanel(
        document,
        42,
        controlsY + 171,
        511,
        70,
        PDF_COLORS.tealSoft,
      )
      document
        .font('Helvetica-Bold')
        .fontSize(8)
        .fillColor(PDF_COLORS.teal)
        .text('DECISION BOUNDARY', 58, controlsY + 187)
        .font('Helvetica')
        .fontSize(8.5)
        .fillColor(PDF_COLORS.ink)
        .text(
          'This document records the billing audit result. It does not itself approve payment, alter source evidence, or send a vendor dispute.',
          58,
          controlsY + 205,
          { width: 466, lineGap: 2 },
        )
    }

    const pages = document.bufferedPageRange()
    for (let index = 0; index < pages.count; index += 1) {
      document.switchToPage(index)
      addFooter(document, report, index + 1, pages.count)
    }
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
