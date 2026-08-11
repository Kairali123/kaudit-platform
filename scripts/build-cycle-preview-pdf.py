#!/usr/bin/env python3
import json
import sys
from pathlib import Path

from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER, TA_LEFT, TA_RIGHT
from reportlab.lib.pagesizes import A4, landscape
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfbase import pdfmetrics
from reportlab.platypus import (
    KeepTogether,
    PageBreak,
    Paragraph,
    SimpleDocTemplate,
    Spacer,
    Table,
    TableStyle,
)


def money(value: str) -> str:
    return f"INR {float(value):,.2f}"


def minutes(value: str) -> str:
    return f"{float(value):,.1f}"


def seconds(value) -> str:
    return "-" if value is None else f"{float(value) / 1000:.1f}s"


def build(input_path: Path, output_path: Path) -> None:
    payload = json.loads(input_path.read_text(encoding="utf-8"))
    output_path.parent.mkdir(parents=True, exist_ok=True)
    styles = getSampleStyleSheet()
    navy = colors.HexColor("#0B1F2A")
    teal = colors.HexColor("#137C72")
    amber = colors.HexColor("#9B6112")
    pale_amber = colors.HexColor("#FFF4DF")
    line = colors.HexColor("#DCE3E0")
    muted = colors.HexColor("#65747C")
    paper = colors.white

    title = ParagraphStyle(
        "Title",
        parent=styles["Title"],
        fontName="Helvetica-Bold",
        fontSize=22,
        leading=25,
        textColor=navy,
        alignment=TA_LEFT,
        spaceAfter=5,
    )
    subtitle = ParagraphStyle(
        "Subtitle",
        parent=styles["Normal"],
        fontName="Helvetica",
        fontSize=9,
        leading=13,
        textColor=muted,
    )
    section = ParagraphStyle(
        "Section",
        parent=styles["Heading2"],
        fontName="Helvetica-Bold",
        fontSize=11,
        leading=14,
        textColor=navy,
        spaceBefore=8,
        spaceAfter=7,
    )
    warning = ParagraphStyle(
        "Warning",
        parent=styles["Normal"],
        fontName="Helvetica-Bold",
        fontSize=8.5,
        leading=12,
        textColor=amber,
    )
    small = ParagraphStyle(
        "Small",
        parent=styles["Normal"],
        fontName="Helvetica",
        fontSize=7.2,
        leading=9,
        textColor=navy,
    )
    small_center = ParagraphStyle(
        "SmallCenter", parent=small, alignment=TA_CENTER
    )
    small_right = ParagraphStyle(
        "SmallRight", parent=small, alignment=TA_RIGHT
    )
    mono = ParagraphStyle(
        "Mono",
        parent=small,
        fontName="Courier",
        fontSize=5.7,
        leading=7,
    )
    table_header = ParagraphStyle(
        "TableHeader",
        parent=small,
        fontName="Helvetica-Bold",
        fontSize=6.4,
        leading=7.5,
        textColor=colors.white,
        alignment=TA_CENTER,
    )

    def footer(canvas, document):
        canvas.saveState()
        canvas.setFillColor(colors.HexColor("#A14343"))
        canvas.setFont("Helvetica-Bold", 7)
        canvas.drawString(
            16 * mm,
            10 * mm,
            "PROVISIONAL - UNCALIBRATED TEST ONLY - NOT FOR VENDOR DISPUTE",
        )
        canvas.setFillColor(muted)
        canvas.setFont("Helvetica", 7)
        canvas.drawRightString(
            landscape(A4)[0] - 16 * mm,
            10 * mm,
            f"Page {document.page}",
        )
        canvas.restoreState()

    doc = SimpleDocTemplate(
        str(output_path),
        pagesize=landscape(A4),
        leftMargin=16 * mm,
        rightMargin=16 * mm,
        topMargin=14 * mm,
        bottomMargin=16 * mm,
        title="Kairali April 2026 Variance Preview",
        author="Kairali Audit Platform",
    )
    story = [
        Paragraph("Kairali AI Call Audit - Variance Preview", title),
        Paragraph(
            f"Billing period: {payload['period']['label']} | "
            f"Invoice: {payload['invoice']['invoice_number']} | "
            f"Generated: {payload['generatedAt'][:19].replace('T', ' ')} UTC",
            subtitle,
        ),
        Spacer(1, 7 * mm),
        Table(
            [
                [
                    Paragraph("KServe invoice subtotal", small),
                    Paragraph("Provisional verified amount", small),
                    Paragraph("Variance identified", small),
                    Paragraph("Audit coverage", small),
                ],
                [
                    Paragraph(money(payload["totals"]["vendorAmount"]), section),
                    Paragraph(money(payload["totals"]["verifiedAmount"]), section),
                    Paragraph(money(payload["totals"]["variance"]), section),
                    Paragraph(
                        f"{payload['counts']['independentlyAudited']} AI-audited + "
                        f"{payload['counts']['acceptedAsBilledUnverified']} "
                        "accepted-as-billed",
                        section,
                    ),
                ],
            ],
            colWidths=[62 * mm, 62 * mm, 62 * mm, 72 * mm],
            rowHeights=[10 * mm, 19 * mm],
            style=TableStyle(
                [
                    ("BACKGROUND", (0, 0), (-1, -1), paper),
                    ("BOX", (0, 0), (-1, -1), 0.7, line),
                    ("INNERGRID", (0, 0), (-1, -1), 0.4, line),
                    ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#F4F6F5")),
                    ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
                    ("LEFTPADDING", (0, 0), (-1, -1), 8),
                    ("RIGHTPADDING", (0, 0), (-1, -1), 8),
                ]
            ),
        ),
        Spacer(1, 5 * mm),
        Table(
            [[Paragraph(payload["warning"], warning)]],
            colWidths=[258 * mm],
            style=TableStyle(
                [
                    ("BACKGROUND", (0, 0), (-1, -1), pale_amber),
                    ("BOX", (0, 0), (-1, -1), 0.7, colors.HexColor("#EACB97")),
                    ("LEFTPADDING", (0, 0), (-1, -1), 9),
                    ("RIGHTPADDING", (0, 0), (-1, -1), 9),
                    ("TOPPADDING", (0, 0), (-1, -1), 8),
                    ("BOTTOMPADDING", (0, 0), (-1, -1), 8),
                ]
            ),
        ),
        Spacer(1, 5 * mm),
        Paragraph("Interpretation", section),
        Table(
            [
                [
                    Paragraph("What KServe claimed", small),
                    Paragraph(
                        f"{minutes(payload['totals']['vendorMinutes'])} minutes / "
                        f"{money(payload['totals']['vendorAmount'])}",
                        small_right,
                    ),
                ],
                [
                    Paragraph("What the current test verifier calculated", small),
                    Paragraph(
                        f"{minutes(payload['totals']['verifiedMinutes'])} minutes / "
                        f"{money(payload['totals']['verifiedAmount'])}",
                        small_right,
                    ),
                ],
                [
                    Paragraph("Current variance", small),
                    Paragraph(
                        f"{money(payload['totals']['variance'])} potential overbilling",
                        small_right,
                    ),
                ],
                [
                    Paragraph("Release status", small),
                    Paragraph(
                        "Withheld: AI calibration has not been completed.",
                        small_right,
                    ),
                ],
            ],
            colWidths=[130 * mm, 128 * mm],
            style=TableStyle(
                [
                    ("LINEBELOW", (0, 0), (-1, -2), 0.4, line),
                    ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
                    ("TOPPADDING", (0, 0), (-1, -1), 6),
                    ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
                ]
            ),
        ),
        PageBreak(),
        Paragraph("Call-level calculation backup", title),
        Paragraph(
            "No phone numbers, recording URLs, transcript text, or health content "
            "are included. Evidence is represented only by a truncated SHA-256.",
            subtitle,
        ),
        Spacer(1, 5 * mm),
    ]
    header = [
        Paragraph("Task reference", table_header),
        Paragraph("Resolution / category", table_header),
        Paragraph("Confidence", table_header),
        Paragraph("Vendor min", table_header),
        Paragraph("Verified min", table_header),
        Paragraph("Vendor INR", table_header),
        Paragraph("Verified INR", table_header),
        Paragraph("Variance", table_header),
        Paragraph("Customer end", table_header),
        Paragraph("Grace-adjusted", table_header),
        Paragraph("Evidence hash", table_header),
    ]
    rows = [header]
    for row in payload["rows"]:
        resolution = (
            "AI preview (uncalibrated)"
            if row["auditResolution"] == "provisional_ai_uncalibrated"
            else "Accepted as billed (no recording)"
        )
        rows.append(
            [
                Paragraph(row["callReference"], mono),
                Paragraph(f"{resolution}<br/>{row['category']}", small),
                Paragraph(
                    "-"
                    if row["confidence"] is None
                    else f"{float(row['confidence']) * 100:.0f}%",
                    small_center,
                ),
                Paragraph(minutes(row["vendorBilledMinutes"]), small_right),
                Paragraph(minutes(row["verifiedBillableMinutes"]), small_right),
                Paragraph(money(row["vendorAmount"]), small_right),
                Paragraph(money(row["verifiedAmount"]), small_right),
                Paragraph(money(row["variance"]), small_right),
                Paragraph(seconds(row["conversationEndMs"]), small_right),
                Paragraph(
                    seconds(row["graceAdjustedDurationMs"]), small_right
                ),
                Paragraph(row["evidenceSha256"][:12] + "...", mono),
            ]
        )
    table = Table(
        rows,
        repeatRows=1,
        colWidths=[
            37 * mm,
            42 * mm,
            16 * mm,
            18 * mm,
            19 * mm,
            20 * mm,
            20 * mm,
            20 * mm,
            18 * mm,
            21 * mm,
            26 * mm,
        ],
    )
    table.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (-1, 0), navy),
                ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
                ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
                ("ROWBACKGROUNDS", (0, 1), (-1, -1), [paper, colors.HexColor("#F7F9F8")]),
                ("LINEBELOW", (0, 1), (-1, -1), 0.3, line),
                ("INNERGRID", (0, 0), (-1, 0), 0.35, colors.HexColor("#36505B")),
                ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
                ("TOPPADDING", (0, 0), (-1, -1), 5),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
                ("LEFTPADDING", (0, 0), (-1, -1), 4),
                ("RIGHTPADDING", (0, 0), (-1, -1), 4),
            ]
        )
    )
    story.extend([table, Spacer(1, 5 * mm)])
    story.append(
        Paragraph(
            "Calculation rule: final meaningful customer exchange + up to 60 "
            "seconds of AI wrap-up, capped by recording duration; 0 seconds = "
            "0 minutes, under 30 seconds = 0.5 minutes, otherwise round up to "
            "the next full minute. Rate: INR 9.50/minute.",
            subtitle,
        )
    )
    doc.build(story, onFirstPage=footer, onLaterPages=footer)


if __name__ == "__main__":
    if len(sys.argv) != 3:
        raise SystemExit("usage: build-cycle-preview-pdf.py INPUT_JSON OUTPUT_PDF")
    build(Path(sys.argv[1]), Path(sys.argv[2]))
