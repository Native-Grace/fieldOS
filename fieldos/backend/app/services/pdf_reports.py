"""Phase 3F ReportLab PDF report renderers.

Renderer choice: ReportLab. It needs no Chromium or system Cairo/Pango packages
(unlike WeasyPrint), runs unchanged in CI and Docker, streams straight into a
FastAPI response, and with invariant=1 produces byte-identical output for the
same frozen snapshot.

Only the built-in Helvetica faces are used — no remote fonts, images or CSS are
fetched at render time.
"""

from __future__ import annotations

from io import BytesIO
from typing import Any, Callable

from reportlab.lib import colors
from reportlab.lib.enums import TA_RIGHT
from reportlab.lib.pagesizes import A4, landscape
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import mm
from reportlab.pdfgen import canvas as pdfcanvas
from reportlab.platypus import (
    KeepTogether,
    PageBreak,
    Paragraph,
    SimpleDocTemplate,
    Spacer,
    Table,
    TableStyle,
)

from app.services.report_math import (
    AUDIENCE_CLIENT,
    REPORT_CLIENT_JOB_REPORT,
    REPORT_COMPLETION_REGISTER,
    REPORT_JOB_SHEET_SUMMARY,
    REPORT_LANDSCAPE_DEFAULT,
    REPORT_PROJECT_ACTIVITY_REPORT,
    REPORT_STAFF_WORK_REPORT,
    TEMPLATE_VERSION,
    labour_row_view,
)

BRAND_NAME = "Native Grace"
FOOTER_SOURCE = "Generated from Native Grace FieldOS"

# Restrained eucalypt green over warm grey — deliberately not purple.
GREEN_DARK = colors.HexColor("#26543C")
GREEN = colors.HexColor("#3A7D5A")
GREEN_TINT = colors.HexColor("#E9F1EC")
INK = colors.HexColor("#1E2622")
GREY = colors.HexColor("#5C665F")
GREY_LINE = colors.HexColor("#C7D0CA")
GREY_TINT = colors.HexColor("#F4F6F5")

FONT = "Helvetica"
FONT_BOLD = "Helvetica-Bold"

PAGE_MARGIN = 18 * mm
TOP_MARGIN = 27 * mm
BOTTOM_MARGIN = 21 * mm

_EMPTY = "\u2014"


def _text(value: Any) -> str:
    if value is None:
        return ""
    return str(value)


def _cell(value: Any) -> str:
    text = _text(value).strip()
    return text if text else _EMPTY


def _num(value: Any, *, places: int = 2) -> str:
    if value in (None, ""):
        return _EMPTY
    try:
        return f"{float(value):.{places}f}"
    except (TypeError, ValueError):
        return _cell(value)


def _yes_no(value: Any) -> str:
    return "Yes" if value in (True, "TRUE", "true", "Yes") else "No"


def _escape(value: Any) -> str:
    return (
        _text(value)
        .replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
    )


def _styles() -> dict[str, ParagraphStyle]:
    base = ParagraphStyle(
        "ngBase",
        fontName=FONT,
        fontSize=9,
        leading=12,
        textColor=INK,
        spaceAfter=0,
    )
    return {
        "base": base,
        "title": ParagraphStyle(
            "ngTitle", parent=base, fontName=FONT_BOLD, fontSize=15, leading=19, textColor=GREEN_DARK
        ),
        "subtitle": ParagraphStyle(
            "ngSubtitle", parent=base, fontSize=9.5, leading=13, textColor=GREY, spaceAfter=2
        ),
        "section": ParagraphStyle(
            "ngSection",
            parent=base,
            fontName=FONT_BOLD,
            fontSize=11,
            leading=14,
            textColor=GREEN_DARK,
            spaceBefore=2,
            spaceAfter=3,
        ),
        "group": ParagraphStyle(
            "ngGroup",
            parent=base,
            fontName=FONT_BOLD,
            fontSize=10.5,
            leading=14,
            textColor=INK,
            spaceBefore=2,
            spaceAfter=2,
        ),
        "body": ParagraphStyle("ngBody", parent=base, fontSize=9.5, leading=13),
        "small": ParagraphStyle("ngSmall", parent=base, fontSize=8, leading=10.5, textColor=GREY),
        "cell": ParagraphStyle("ngCell", parent=base, fontSize=8.5, leading=11),
        "cellHead": ParagraphStyle(
            "ngCellHead", parent=base, fontName=FONT_BOLD, fontSize=8.5, leading=11, textColor=colors.white
        ),
        "cellRight": ParagraphStyle("ngCellRight", parent=base, fontSize=8.5, leading=11, alignment=TA_RIGHT),
        "note": ParagraphStyle("ngNote", parent=base, fontSize=8.5, leading=11.5, textColor=GREY),
    }


def normalise_meta(meta: dict[str, Any] | None, *, report_type: str = "") -> dict[str, Any]:
    meta = dict(meta or {})
    return {
        "report_type": _text(meta.get("report_type") or report_type),
        "report_title": _text(meta.get("report_title") or meta.get("report_type") or report_type),
        "generated_at": _text(meta.get("generated_at")),
        "generated_by": _text(meta.get("generated_by")),
        "internal_ref": _text(meta.get("internal_ref")),
        "template_version": _text(meta.get("template_version") or TEMPLATE_VERSION),
        "audience": _text(meta.get("audience") or "internal").lower(),
        # None means "renderer decides"; an explicit bool always wins.
        "landscape": meta.get("landscape"),
        "subtitle": _text(meta.get("subtitle")),
    }


def _draw_furniture(canv: pdfcanvas.Canvas, meta: dict[str, Any], total_pages: int) -> None:
    width, height = canv._pagesize
    left = PAGE_MARGIN
    right = width - PAGE_MARGIN

    canv.saveState()
    canv.setFillColor(GREEN_DARK)
    canv.setFont(FONT_BOLD, 13)
    canv.drawString(left, height - 15 * mm, BRAND_NAME)

    title = meta.get("report_title") or ""
    if title:
        canv.setFillColor(GREY)
        canv.setFont(FONT_BOLD, 10)
        canv.drawRightString(right, height - 15 * mm, title)

    canv.setStrokeColor(GREEN)
    canv.setLineWidth(0.9)
    canv.line(left, height - 18 * mm, right, height - 18 * mm)

    canv.setStrokeColor(GREY_LINE)
    canv.setLineWidth(0.5)
    canv.line(left, BOTTOM_MARGIN - 5 * mm, right, BOTTOM_MARGIN - 5 * mm)

    canv.setFillColor(GREY)
    canv.setFont(FONT, 7.5)
    first_line_y = BOTTOM_MARGIN - 9 * mm
    second_line_y = BOTTOM_MARGIN - 12.5 * mm

    generated = f"Generated {meta.get('generated_at') or _EMPTY}"
    by = meta.get("generated_by") or _EMPTY
    canv.drawString(left, first_line_y, f"{generated} by {by}")
    canv.drawRightString(right, first_line_y, f"Page {canv.getPageNumber()} of {total_pages}")

    ref = meta.get("internal_ref") or _EMPTY
    canv.drawString(
        left,
        second_line_y,
        f"Internal ref {ref} \u00b7 Template {meta.get('template_version') or TEMPLATE_VERSION}",
    )
    canv.drawRightString(right, second_line_y, FOOTER_SOURCE)
    canv.restoreState()


def _canvas_maker(meta: dict[str, Any]) -> Callable[..., pdfcanvas.Canvas]:
    """Two-pass canvas so the footer can print 'page X of Y'."""

    class _ReportCanvas(pdfcanvas.Canvas):
        def __init__(self, *args: Any, **kwargs: Any) -> None:
            super().__init__(*args, **kwargs)
            self._page_states: list[dict[str, Any]] = []

        def showPage(self) -> None:
            self._page_states.append(dict(self.__dict__))
            self._startPage()

        def save(self) -> None:
            total = len(self._page_states)
            for state in self._page_states:
                self.__dict__.update(state)
                _draw_furniture(self, meta, total)
                super().showPage()
            super().save()

    return _ReportCanvas


def _build(story: list[Any], meta: dict[str, Any]) -> bytes:
    buffer = BytesIO()
    page_size = landscape(A4) if meta.get("landscape") else A4
    doc = SimpleDocTemplate(
        buffer,
        pagesize=page_size,
        leftMargin=PAGE_MARGIN,
        rightMargin=PAGE_MARGIN,
        topMargin=TOP_MARGIN,
        bottomMargin=BOTTOM_MARGIN,
        title=meta.get("report_title") or BRAND_NAME,
        author=BRAND_NAME,
        subject=meta.get("report_type") or "",
        creator="Native Grace FieldOS",
        # Byte-identical output for the same frozen snapshot.
        invariant=1,
    )
    doc.build(story or [Spacer(1, 1)], canvasmaker=_canvas_maker(meta))
    return buffer.getvalue()


def _content_width(meta: dict[str, Any]) -> float:
    page_size = landscape(A4) if meta.get("landscape") else A4
    return page_size[0] - (2 * PAGE_MARGIN)


def _table_style(*, zebra_from: int = 1) -> TableStyle:
    return TableStyle(
        [
            ("BACKGROUND", (0, 0), (-1, 0), GREEN_DARK),
            ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
            ("VALIGN", (0, 0), (-1, -1), "TOP"),
            ("GRID", (0, 0), (-1, -1), 0.4, GREY_LINE),
            ("LEFTPADDING", (0, 0), (-1, -1), 4),
            ("RIGHTPADDING", (0, 0), (-1, -1), 4),
            ("TOPPADDING", (0, 0), (-1, -1), 3),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
            ("ROWBACKGROUNDS", (0, zebra_from), (-1, -1), [colors.white, GREY_TINT]),
        ]
    )


def _data_table(
    headers: list[str],
    rows: list[list[Any]],
    widths: list[float],
    styles: dict[str, ParagraphStyle],
    *,
    right_align: tuple[int, ...] = (),
) -> Table:
    head = [Paragraph(_escape(h), styles["cellHead"]) for h in headers]
    body: list[list[Any]] = [head]
    for row in rows:
        cells = []
        for idx, value in enumerate(row):
            style = styles["cellRight"] if idx in right_align else styles["cell"]
            cells.append(Paragraph(_escape(value), style))
        body.append(cells)
    table = Table(body, colWidths=widths, repeatRows=1, hAlign="LEFT")
    table.setStyle(_table_style())
    return table


def _kv_table(pairs: list[tuple[str, Any]], width: float, styles: dict[str, ParagraphStyle]) -> Table:
    rows = [
        [
            Paragraph(f"<b>{_escape(label)}</b>", styles["cell"]),
            Paragraph(_escape(_cell(value)), styles["cell"]),
        ]
        for label, value in pairs
    ]
    label_width = min(38 * mm, width * 0.28)
    table = Table(rows or [[""]], colWidths=[label_width, width - label_width], hAlign="LEFT")
    table.setStyle(
        TableStyle(
            [
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
                ("BACKGROUND", (0, 0), (0, -1), GREEN_TINT),
                ("GRID", (0, 0), (-1, -1), 0.4, GREY_LINE),
                ("LEFTPADDING", (0, 0), (-1, -1), 4),
                ("RIGHTPADDING", (0, 0), (-1, -1), 4),
                ("TOPPADDING", (0, 0), (-1, -1), 3),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
            ]
        )
    )
    return table


def _pair_grid(
    pairs: list[tuple[str, Any]],
    width: float,
    styles: dict[str, ParagraphStyle],
    *,
    columns: int = 2,
) -> Table:
    """Label/value pairs laid out side by side to keep header blocks short."""
    label_width = 26 * mm
    value_width = (width - (columns * label_width)) / columns
    col_widths: list[float] = []
    for _ in range(columns):
        col_widths.extend([label_width, value_width])

    rows: list[list[Any]] = []
    for start in range(0, len(pairs), columns):
        cells: list[Any] = []
        for label, value in pairs[start : start + columns]:
            cells.append(Paragraph(f"<b>{_escape(label)}</b>", styles["cell"]))
            cells.append(Paragraph(_escape(_cell(value)), styles["cell"]))
        while len(cells) < columns * 2:
            cells.append("")
        rows.append(cells)

    table = Table(rows or [[""] * (columns * 2)], colWidths=col_widths, hAlign="LEFT")
    commands: list[Any] = [
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("GRID", (0, 0), (-1, -1), 0.4, GREY_LINE),
        ("LEFTPADDING", (0, 0), (-1, -1), 4),
        ("RIGHTPADDING", (0, 0), (-1, -1), 4),
        ("TOPPADDING", (0, 0), (-1, -1), 2.5),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 2.5),
    ]
    for index in range(columns):
        col = index * 2
        commands.append(("BACKGROUND", (col, 0), (col, -1), GREEN_TINT))
    table.setStyle(TableStyle(commands))
    return table


def _totals_table(
    totals: dict[str, Any] | None, width: float, styles: dict[str, ParagraphStyle], *, audience: str
) -> Table:
    """Compact horizontal totals strip — hours only, never an amount payable."""
    pairs = _totals_pairs(totals, audience=audience)
    headers = [Paragraph(_escape(label), styles["cellHead"]) for label, _ in pairs]
    values = [Paragraph(_escape(_text(value)), styles["cellRight"]) for _, value in pairs]
    column = width / len(pairs)
    table = Table([headers, values], colWidths=[column] * len(pairs), hAlign="LEFT")
    table.setStyle(_table_style())
    return table


def _section(title: str, flowables: list[Any], styles: dict[str, ParagraphStyle]) -> list[Any]:
    """Keep a heading with the head of its content so sections never orphan."""
    heading = Paragraph(_escape(title), styles["section"])
    if not flowables:
        return [KeepTogether([heading, Paragraph("None recorded.", styles["note"])]), Spacer(1, 4 * mm)]
    return [KeepTogether([heading, flowables[0]])] + list(flowables[1:]) + [Spacer(1, 4 * mm)]


def _cover(meta: dict[str, Any], pairs: list[tuple[str, Any]], styles: dict[str, ParagraphStyle]) -> list[Any]:
    story: list[Any] = [Paragraph(_escape(meta.get("report_title") or BRAND_NAME), styles["title"])]
    if meta.get("subtitle"):
        story.append(Paragraph(_escape(meta["subtitle"]), styles["subtitle"]))
    story.append(Spacer(1, 3 * mm))
    if pairs:
        story.append(_kv_table(pairs, _content_width(meta), styles))
        story.append(Spacer(1, 5 * mm))
    return story


def _filter_pairs(filters: dict[str, Any] | None) -> list[tuple[str, Any]]:
    filters = filters or {}
    labels = [
        ("date_from", "Date from"),
        ("date_to", "Date to"),
        ("customer", "Customer"),
        ("project", "Project"),
        ("staff_id", "Staff"),
        ("assigned_staff_id", "Assigned staff"),
        ("completion_status", "Completion status"),
        ("approval_status", "Approval status"),
        ("q", "Search"),
    ]
    return [(label, filters[key]) for key, label in labels if filters.get(key)]


def _totals_pairs(totals: dict[str, Any] | None, *, audience: str) -> list[tuple[str, Any]]:
    totals = totals or {}
    pairs: list[tuple[str, Any]] = [
        ("Jobs", int(totals.get("job_count") or 0)),
        ("Labour hours", _num(totals.get("labour_hours") or 0)),
        ("Travel hours", _num(totals.get("travel_hours") or 0)),
        ("Machinery hours", _num(totals.get("machinery_hours") or 0)),
    ]
    if audience != AUDIENCE_CLIENT:
        pairs.append(("Billable labour hours", _num(totals.get("billable_labour_hours") or 0)))
    pairs.append(("Material items", int(totals.get("material_items") or 0)))
    return pairs


def _task_lines_table(
    task_lines: list[dict[str, Any]], width: float, styles: dict[str, ParagraphStyle]
) -> list[Any]:
    if not task_lines:
        return []
    rows = [[_cell(line.get("source")), _cell(line.get("text"))] for line in task_lines]
    return [_data_table(["Source", "Task"], rows, [32 * mm, width - 32 * mm], styles)]


def _labour_table(
    rows: list[dict[str, Any]],
    completion: dict[str, Any] | None,
    width: float,
    styles: dict[str, ParagraphStyle],
    *,
    audience: str,
) -> list[Any]:
    if not rows:
        return []
    views = [labour_row_view(row, completion) for row in rows]
    if audience == AUDIENCE_CLIENT:
        headers = ["Date", "Person", "Activity", "Hours"]
        widths = [22 * mm, 42 * mm, width - 92 * mm, 28 * mm]
        body = [
            [
                v["work_date"],
                v["staff_name"] or v["staff_id"],
                v["role_or_activity"],
                _num(v["labour_hours"]),
            ]
            for v in views
        ]
        return [_data_table(headers, body, widths, styles, right_align=(3,))]

    headers = ["Date", "Staff", "Start", "Finish", "Break", "Hours", "Travel", "Billable", "Activity"]
    fixed = [21 * mm, 32 * mm, 14 * mm, 14 * mm, 13 * mm, 14 * mm, 14 * mm, 16 * mm]
    widths = fixed + [width - sum(fixed)]
    body = [
        [
            v["work_date"],
            v["staff_name"] or v["staff_id"],
            v["start_time"],
            v["finish_time"],
            _num(v["break_minutes"], places=0),
            _num(v["labour_hours"]),
            _num(v["travel_hours"]),
            _yes_no(v["billable"]),
            v["role_or_activity"],
        ]
        for v in views
    ]
    return [_data_table(headers, body, widths, styles, right_align=(4, 5, 6))]


def _machinery_table(
    rows: list[dict[str, Any]], width: float, styles: dict[str, ParagraphStyle], *, audience: str
) -> list[Any]:
    if not rows:
        return []
    if audience == AUDIENCE_CLIENT:
        headers = ["Equipment", "Hours"]
        widths = [width - 28 * mm, 28 * mm]
        body = [[_cell(r.get("equipment_name")), _num(r.get("duration_hours"))] for r in rows]
        return [_data_table(headers, body, widths, styles, right_align=(1,))]
    headers = ["Equipment", "Operator", "Hours", "Billable", "Charge code", "Notes"]
    fixed = [40 * mm, 28 * mm, 15 * mm, 16 * mm, 24 * mm]
    widths = fixed + [width - sum(fixed)]
    body = [
        [
            _cell(r.get("equipment_name")),
            _cell(r.get("operator_staff_id")),
            _num(r.get("duration_hours")),
            _yes_no(r.get("billable")),
            _cell(r.get("charge_code")),
            _cell(r.get("notes")),
        ]
        for r in rows
    ]
    return [_data_table(headers, body, widths, styles, right_align=(2,))]


def _materials_table(
    rows: list[dict[str, Any]], width: float, styles: dict[str, ParagraphStyle], *, audience: str
) -> list[Any]:
    if not rows:
        return []
    if audience == AUDIENCE_CLIENT:
        headers = ["Item", "Quantity", "Unit"]
        widths = [width - 50 * mm, 25 * mm, 25 * mm]
        body = [
            [_cell(r.get("item_name")), _num(r.get("quantity")), _cell(r.get("unit"))] for r in rows
        ]
        return [_data_table(headers, body, widths, styles, right_align=(1,))]
    headers = ["Item", "Quantity", "Unit", "Billable", "Notes"]
    fixed = [55 * mm, 20 * mm, 18 * mm, 16 * mm]
    widths = fixed + [width - sum(fixed)]
    body = [
        [
            _cell(r.get("item_name")),
            _num(r.get("quantity")),
            _cell(r.get("unit")),
            _yes_no(r.get("billable")),
            _cell(r.get("notes")),
        ]
        for r in rows
    ]
    return [_data_table(headers, body, widths, styles, right_align=(1,))]


def _paragraph_block(text: Any, styles: dict[str, ParagraphStyle]) -> list[Any]:
    value = _text(text).strip()
    if not value:
        return []
    return [
        Paragraph(_escape(line), styles["body"])
        for line in value.splitlines()
        if line.strip()
    ]


def _job_header_pairs(
    job: dict[str, Any], completion: dict[str, Any], *, audience: str
) -> list[tuple[str, Any]]:
    pairs: list[tuple[str, Any]] = [
        ("Job sheet", job.get("job_sheet_id")),
        ("Job date", job.get("job_date")),
        ("Customer", job.get("customer_name")),
        ("Project", job.get("project_name")),
    ]
    if audience != AUDIENCE_CLIENT:
        pairs.extend(
            [
                ("Completion", completion.get("completion_id")),
                ("Completion status", completion.get("completion_status")),
                ("Approval status", job.get("approval_status")),
                ("Finalised by", completion.get("finalised_by")),
                ("Finalised at", completion.get("finalised_at")),
            ]
        )
    return pairs


def _job_body(
    bundle: dict[str, Any],
    meta: dict[str, Any],
    styles: dict[str, ParagraphStyle],
    *,
    include_header: bool = True,
) -> list[Any]:
    audience = meta.get("audience") or "internal"
    width = _content_width(meta)
    job = bundle.get("job") or {}
    completion = bundle.get("completion") or {}
    story: list[Any] = []

    if include_header:
        story.append(_pair_grid(_job_header_pairs(job, completion, audience=audience), width, styles))
        story.append(Spacer(1, 4 * mm))

    story.extend(_section("Work summary", _paragraph_block(completion.get("work_summary"), styles), styles))
    if audience == AUDIENCE_CLIENT:
        story.extend(
            _section(
                "Description of works",
                _paragraph_block(completion.get("invoice_description"), styles),
                styles,
            )
        )
    story.extend(
        _section("Tasks and variations", _task_lines_table(bundle.get("task_lines") or [], width, styles), styles)
    )
    story.extend(
        _section(
            "Labour",
            _labour_table(bundle.get("labour_entries") or [], completion, width, styles, audience=audience),
            styles,
        )
    )
    story.extend(
        _section(
            "Machinery",
            _machinery_table(bundle.get("machinery_entries") or [], width, styles, audience=audience),
            styles,
        )
    )
    story.extend(
        _section(
            "Materials",
            _materials_table(bundle.get("material_entries") or [], width, styles, audience=audience),
            styles,
        )
    )
    story.extend(
        _section(
            "Recorded hours",
            [_totals_table(bundle.get("totals"), width, styles, audience=audience)],
            styles,
        )
    )

    if audience != AUDIENCE_CLIENT:
        notes = _paragraph_block(completion.get("internal_notes"), styles)
        if notes:
            story.extend(_section("Internal notes", notes, styles))
        warnings = [str(w) for w in (completion.get("warnings") or []) if str(w).strip()]
        if warnings:
            story.extend(
                _section(
                    "Outstanding warnings",
                    [Paragraph(_escape(w), styles["note"]) for w in warnings],
                    styles,
                )
            )
    return story


def render_job_sheet_summary(data: dict[str, Any], meta: dict[str, Any] | None = None) -> bytes:
    meta = normalise_meta(meta, report_type=REPORT_JOB_SHEET_SUMMARY)
    styles = _styles()
    data = data or {}
    # A batch may cover several job sheets; a single job is the common case.
    bundles = data.get("bundles") or ([data] if data.get("job") else [])
    if not meta.get("subtitle") and len(bundles) == 1:
        job = bundles[0].get("job") or {}
        meta["subtitle"] = " \u00b7 ".join(
            part for part in [_text(job.get("job_sheet_id")), _text(job.get("job_date"))] if part
        )

    story: list[Any] = [Paragraph(_escape(meta.get("report_title")), styles["title"])]
    if meta.get("subtitle"):
        story.append(Paragraph(_escape(meta["subtitle"]), styles["subtitle"]))
    story.append(Spacer(1, 3 * mm))

    if not bundles:
        story.append(Paragraph("No completion recorded for this job sheet.", styles["note"]))
        return _build(story, meta)

    for index, bundle in enumerate(bundles):
        if index:
            story.append(PageBreak())
        story.extend(_job_body(bundle, meta, styles))
    return _build(story, meta)


def render_staff_work_report(data: dict[str, Any], meta: dict[str, Any] | None = None) -> bytes:
    meta = normalise_meta(meta, report_type=REPORT_STAFF_WORK_REPORT)
    styles = _styles()
    data = data or {}
    width = _content_width(meta)
    story = _cover(meta, _filter_pairs(data.get("filters")), styles)

    groups = data.get("groups") or []
    if not groups:
        story.append(Paragraph("No confirmed labour matched these filters.", styles["note"]))
        return _build(story, meta)

    headers = ["Date", "Job sheet", "Customer", "Start", "Finish", "Break", "Hours", "Travel", "Billable"]
    # Customer takes whatever the fixed-width columns leave behind.
    fixed = [21 * mm, 26 * mm, 14 * mm, 14 * mm, 13 * mm, 14 * mm, 14 * mm, 16 * mm]
    widths = [fixed[0], fixed[1], width - sum(fixed), *fixed[2:]]

    for group in groups:
        rows = group.get("rows") or []
        body = [
            [
                r.get("work_date"),
                r.get("job_sheet_id"),
                r.get("customer_name"),
                r.get("start_time"),
                r.get("finish_time"),
                _num(r.get("break_minutes"), places=0),
                _num(r.get("labour_hours")),
                _num(r.get("travel_hours")),
                _yes_no(r.get("billable")),
            ]
            for r in rows
        ]
        heading = Paragraph(_escape(group.get("label") or "Staff not recorded"), styles["group"])
        table = _data_table(headers, body, widths, styles, right_align=(5, 6, 7))
        story.append(KeepTogether([heading, table]) if len(body) <= 12 else heading)
        if len(body) > 12:
            story.append(table)
        story.append(Spacer(1, 2 * mm))
        story.append(_totals_table(group.get("totals"), width, styles, audience="internal"))
        story.append(Spacer(1, 6 * mm))

    story.extend(
        _section(
            "Report totals",
            [_totals_table(data.get("totals"), width, styles, audience="internal")],
            styles,
        )
    )
    return _build(story, meta)


def render_client_job_report(data: dict[str, Any], meta: dict[str, Any] | None = None) -> bytes:
    meta = normalise_meta(meta, report_type=REPORT_CLIENT_JOB_REPORT)
    meta["audience"] = AUDIENCE_CLIENT
    styles = _styles()
    data = data or {}
    width = _content_width(meta)
    story = _cover(meta, _filter_pairs(data.get("filters")), styles)

    groups = data.get("groups") or []
    if not groups:
        story.append(Paragraph("No completed work matched these filters.", styles["note"]))
        return _build(story, meta)

    for group_index, group in enumerate(groups):
        if group_index:
            story.append(PageBreak())
        story.append(Paragraph(_escape(group.get("label") or "Customer"), styles["section"]))
        story.append(Spacer(1, 2 * mm))
        for bundle_index, bundle in enumerate(group.get("bundles") or []):
            if bundle_index:
                story.append(Spacer(1, 4 * mm))
            story.extend(_job_body(bundle, meta, styles))
        story.append(
            _totals_table(group.get("totals"), width, styles, audience=AUDIENCE_CLIENT)
        )
        story.append(Spacer(1, 4 * mm))
    return _build(story, meta)


def render_project_activity_report(data: dict[str, Any], meta: dict[str, Any] | None = None) -> bytes:
    meta = normalise_meta(meta, report_type=REPORT_PROJECT_ACTIVITY_REPORT)
    styles = _styles()
    data = data or {}
    width = _content_width(meta)
    story = _cover(meta, _filter_pairs(data.get("filters")), styles)

    groups = data.get("groups") or []
    if not groups:
        story.append(Paragraph("No project activity matched these filters.", styles["note"]))
        return _build(story, meta)

    headers = ["Job date", "Job sheet", "Customer", "Status", "Labour", "Travel", "Machinery"]
    fixed = [22 * mm, 27 * mm, 24 * mm, 18 * mm, 18 * mm, 20 * mm]
    widths = [fixed[0], fixed[1], width - sum(fixed), *fixed[2:]]

    for group in groups:
        bundles = group.get("bundles") or []
        rows = []
        for bundle in bundles:
            job = bundle.get("job") or {}
            completion = bundle.get("completion") or {}
            totals = bundle.get("totals") or {}
            rows.append(
                [
                    job.get("job_date"),
                    job.get("job_sheet_id"),
                    job.get("customer_name"),
                    completion.get("completion_status"),
                    _num(totals.get("labour_hours")),
                    _num(totals.get("travel_hours")),
                    _num(totals.get("machinery_hours")),
                ]
            )
        heading = Paragraph(_escape(group.get("label") or "Project"), styles["group"])
        table = _data_table(headers, rows, widths, styles, right_align=(4, 5, 6))
        story.append(KeepTogether([heading, table]) if len(rows) <= 12 else heading)
        if len(rows) > 12:
            story.append(table)
        story.append(Spacer(1, 2 * mm))

        tasks: list[dict[str, Any]] = []
        for bundle in bundles:
            for line in bundle.get("task_lines") or []:
                tasks.append({**line, "job_sheet_id": (bundle.get("job") or {}).get("job_sheet_id")})
        if tasks:
            task_rows = [
                [_cell(t.get("job_sheet_id")), _cell(t.get("source")), _cell(t.get("text"))]
                for t in tasks
            ]
            story.append(
                _data_table(
                    ["Job sheet", "Source", "Task or variation"],
                    task_rows,
                    [27 * mm, 30 * mm, width - 57 * mm],
                    styles,
                )
            )
            story.append(Spacer(1, 2 * mm))
        story.append(_totals_table(group.get("totals"), width, styles, audience="internal"))
        story.append(Spacer(1, 6 * mm))

    story.extend(
        _section(
            "Report totals",
            [_totals_table(data.get("totals"), width, styles, audience="internal")],
            styles,
        )
    )
    return _build(story, meta)


def render_completion_register(data: dict[str, Any], meta: dict[str, Any] | None = None) -> bytes:
    meta = normalise_meta(meta, report_type=REPORT_COMPLETION_REGISTER)
    if meta.get("landscape") is None:
        meta["landscape"] = REPORT_LANDSCAPE_DEFAULT.get(REPORT_COMPLETION_REGISTER, False)
    styles = _styles()
    data = data or {}
    width = _content_width(meta)
    story = _cover(meta, _filter_pairs(data.get("filters")), styles)

    bundles: list[dict[str, Any]] = []
    for group in data.get("groups") or []:
        bundles.extend(group.get("bundles") or [])

    if not bundles:
        story.append(Paragraph("No completions matched these filters.", styles["note"]))
        return _build(story, meta)

    headers = [
        "Job date",
        "Job sheet",
        "Customer",
        "Project",
        "Completion status",
        "Approval",
        "Labour",
        "Travel",
        "Machinery",
        "Finalised by",
    ]
    # Customer and project split the slack left by the fixed columns.
    fixed = [22 * mm, 26 * mm, 26 * mm, 24 * mm, 15 * mm, 15 * mm, 17 * mm, 32 * mm]
    flexible = max(24 * mm, (width - sum(fixed)) / 2)
    widths = [fixed[0], fixed[1], flexible, flexible, *fixed[2:]]
    rows = []
    for bundle in bundles:
        job = bundle.get("job") or {}
        completion = bundle.get("completion") or {}
        totals = bundle.get("totals") or {}
        rows.append(
            [
                job.get("job_date"),
                job.get("job_sheet_id"),
                job.get("customer_name"),
                job.get("project_name"),
                completion.get("completion_status"),
                job.get("approval_status"),
                _num(totals.get("labour_hours")),
                _num(totals.get("travel_hours")),
                _num(totals.get("machinery_hours")),
                completion.get("finalised_by"),
            ]
        )
    story.append(_data_table(headers, rows, widths, styles, right_align=(6, 7, 8)))
    story.append(Spacer(1, 5 * mm))
    story.extend(
        _section(
            "Register totals",
            [_totals_table(data.get("totals"), width, styles, audience="internal")],
            styles,
        )
    )
    return _build(story, meta)


RENDERERS: dict[str, Callable[[dict[str, Any], dict[str, Any] | None], bytes]] = {
    REPORT_JOB_SHEET_SUMMARY: render_job_sheet_summary,
    REPORT_STAFF_WORK_REPORT: render_staff_work_report,
    REPORT_CLIENT_JOB_REPORT: render_client_job_report,
    REPORT_PROJECT_ACTIVITY_REPORT: render_project_activity_report,
    REPORT_COMPLETION_REGISTER: render_completion_register,
}


def render_report(report_type: str, data: dict[str, Any], meta: dict[str, Any] | None = None) -> bytes:
    try:
        renderer = RENDERERS[str(report_type)]
    except KeyError as exc:
        raise ValueError(f"Unsupported report type: {report_type}") from exc
    return renderer(data, meta)
