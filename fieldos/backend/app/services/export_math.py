"""Phase 3D export readiness + CSV helpers (server-side)."""

from __future__ import annotations

import re
from datetime import date, datetime, timedelta, timezone
from typing import Any
from zoneinfo import ZoneInfo

from app.services.completion_math import (
    ROW_CONFIRMED,
    STATUS_FINALISED,
    compute_labour_entry,
    is_break_warning_resolved,
    is_excluded,
    is_non_critical_ack_warning,
    is_resolvable_break_warning,
    normalise_clock_time,
    unique_messages,
)


EXPORT_INVOICE_CSV = "Invoice CSV"
EXPORT_PAYROLL_CSV = "Payroll CSV"
EXPORT_MACHINERY_CSV = "Machinery CSV"
EXPORT_MATERIALS_CSV = "Materials CSV"
EXPORT_SUMMARY_CSV = "Completion Summary CSV"

EXPORT_TYPES = (
    EXPORT_INVOICE_CSV,
    EXPORT_PAYROLL_CSV,
    EXPORT_MACHINERY_CSV,
    EXPORT_MATERIALS_CSV,
    EXPORT_SUMMARY_CSV,
)

STATUS_BATCH_DRAFT = "Draft"
STATUS_BATCH_VALIDATED = "Validated"
STATUS_BATCH_EXPORTED = "Exported"
STATUS_BATCH_CANCELLED = "Cancelled"

DEFAULT_TIMEZONE = "Australia/Sydney"
_LOCALE_DATE_RE = re.compile(
    r"^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+"
    r"(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+"
    r"(\d{1,2})\s+(\d{4})\b",
    re.I,
)
_MONTHS = {
    "jan": 1,
    "feb": 2,
    "mar": 3,
    "apr": 4,
    "may": 5,
    "jun": 6,
    "jul": 7,
    "aug": 8,
    "sep": 9,
    "oct": 10,
    "nov": 11,
    "dec": 12,
}


def _tz(name: str | None = None) -> ZoneInfo:
    try:
        return ZoneInfo(name or DEFAULT_TIMEZONE)
    except Exception:
        return ZoneInfo(DEFAULT_TIMEZONE)


def normalise_calendar_date(value: Any, *, timezone_name: str | None = None) -> str:
    """Canonical calendar date → YYYY-MM-DD in spreadsheet timezone."""
    if value is None or value == "":
        return ""
    tz = _tz(timezone_name)

    if isinstance(value, datetime):
        dt = value if value.tzinfo else value.replace(tzinfo=timezone.utc)
        return dt.astimezone(tz).date().isoformat()
    if isinstance(value, date):
        return value.isoformat()

    if isinstance(value, (int, float)) and not isinstance(value, bool):
        # Sheets serial day number (days since 1899-12-30).
        if 1 <= float(value) < 100000:
            excel_epoch = datetime(1899, 12, 30, tzinfo=timezone.utc)
            day = excel_epoch + timedelta(days=int(round(float(value))))
            return day.date().isoformat()
        return ""

    text = str(value).strip()
    if not text:
        return ""

    if re.fullmatch(r"\d{4}-\d{2}-\d{2}", text):
        return text

    if re.match(r"^\d{4}-\d{2}-\d{2}T", text):
        try:
            parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
            if parsed.tzinfo is None:
                parsed = parsed.replace(tzinfo=timezone.utc)
            return parsed.astimezone(tz).date().isoformat()
        except ValueError:
            pass

    locale = _LOCALE_DATE_RE.match(text)
    if locale:
        month = _MONTHS.get(locale.group(1).lower()[:3])
        day = int(locale.group(2))
        year = int(locale.group(3))
        if month:
            # Prefer explicit wall date from locale string over offset shifting.
            return date(year, month, day).isoformat()

    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return parsed.astimezone(tz).date().isoformat()
    except ValueError:
        pass

    # Fallback: leading YYYY-MM-DD when followed by space/T.
    leading = re.match(r"^(\d{4}-\d{2}-\d{2})[\sT]", text)
    if leading:
        return leading.group(1)

    return ""


def date_in_inclusive_range(ymd: Any, date_from: Any, date_to: Any) -> bool:
    normalised = normalise_calendar_date(ymd)
    if not normalised:
        return True
    start = normalise_calendar_date(date_from)
    end = normalise_calendar_date(date_to)
    if start and normalised < start:
        return False
    if end and normalised > end:
        return False
    return True


EXPORT_INVOICE_CSV = "Invoice CSV"
EXPORT_PAYROLL_CSV = "Payroll CSV"
EXPORT_MACHINERY_CSV = "Machinery CSV"
EXPORT_MATERIALS_CSV = "Materials CSV"
EXPORT_SUMMARY_CSV = "Completion Summary CSV"

EXPORT_TYPES = (
    EXPORT_INVOICE_CSV,
    EXPORT_PAYROLL_CSV,
    EXPORT_MACHINERY_CSV,
    EXPORT_MATERIALS_CSV,
    EXPORT_SUMMARY_CSV,
)

STATUS_BATCH_DRAFT = "Draft"
STATUS_BATCH_VALIDATED = "Validated"
STATUS_BATCH_EXPORTED = "Exported"
STATUS_BATCH_CANCELLED = "Cancelled"


def is_confirmed(row: dict[str, Any]) -> bool:
    return str(row.get("confirmation_status") or "").strip() == ROW_CONFIRMED


def escape_csv_cell(value: Any) -> str:
    if value is None:
        return ""
    text = str(value)
    if re.match(r"^[=+\-@]", text):
        text = "'" + text
    if re.search(r'[",\r\n]', text):
        return '"' + text.replace('"', '""') + '"'
    return text


def build_csv(headers: list[str], rows: list[dict[str, Any]]) -> str:
    lines = [",".join(escape_csv_cell(h) for h in headers)]
    for row in rows:
        lines.append(",".join(escape_csv_cell(row.get(h)) for h in headers))
    return "\r\n".join(lines) + "\r\n"


def simple_checksum(text: str) -> str:
    hash_value = 2166136261
    for ch in text:
        hash_value ^= ord(ch)
        hash_value = (hash_value * 16777619) & 0xFFFFFFFF
    return f"{hash_value:08x}"


def unresolved_warning_count(completion: dict[str, Any]) -> int:
    warnings = list(completion.get("warnings") or [])
    resolutions = list(completion.get("warning_resolutions") or [])
    count = 0
    for warning in warnings:
        if is_resolvable_break_warning(warning) and not is_break_warning_resolved(resolutions, warning):
            count += 1
        elif is_non_critical_ack_warning(warning):
            count += 1
    return count


def compute_export_readiness(
    completion: dict[str, Any],
    job: dict[str, Any],
    labour: list[dict[str, Any]] | None = None,
    machinery: list[dict[str, Any]] | None = None,
    materials: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    invoice_blockers: list[str] = []
    payroll_blockers: list[str] = []
    labour_rows = list(labour or [])
    machinery_rows = list(machinery or [])
    material_rows = list(materials or [])
    status = str(completion.get("completion_status") or "").strip()
    approval = str(job.get("approval_status") or completion.get("job_approval_status") or "").strip()
    warning_count = unresolved_warning_count(completion)

    if status != STATUS_FINALISED:
        invoice_blockers.append("Completion is not Finalised.")
        payroll_blockers.append("Completion is not Finalised.")
    if approval != "Approved":
        invoice_blockers.append("Job approval_status must be Approved.")
    if not str(completion.get("work_summary") or "").strip():
        invoice_blockers.append("Work summary is blank.")
    if not str(completion.get("invoice_description") or "").strip():
        invoice_blockers.append("Invoice description is blank.")
    if warning_count:
        invoice_blockers.append(
            f"{warning_count} unresolved critical warning{'s' if warning_count != 1 else ''}"
        )

    for idx, row in enumerate(labour_rows):
        if is_excluded(row):
            continue
        confirmed = is_confirmed(row)
        if not confirmed:
            invoice_blockers.append(f"labour[{idx}] is not Confirmed or Excluded.")
            payroll_blockers.append(f"labour[{idx}] is not Confirmed.")
        calc = compute_labour_entry(row)
        for err in calc["errors"]:
            invoice_blockers.append(f"labour[{idx}]: {err}")
            payroll_blockers.append(f"labour[{idx}]: {err}")
        if confirmed:
            if not str(row.get("staff_id") or "").strip():
                payroll_blockers.append(f"labour[{idx}] missing staff_id.")
            if not normalise_calendar_date(row.get("work_date")):
                payroll_blockers.append(f"labour[{idx}] missing work_date.")
            if not normalise_clock_time(row.get("start_time")):
                payroll_blockers.append(f"labour[{idx}] missing start_time.")
            if not normalise_clock_time(row.get("finish_time")):
                payroll_blockers.append(f"labour[{idx}] missing finish_time.")
            if calc["net_labour_minutes"] is None:
                payroll_blockers.append(f"labour[{idx}] labour hours not derived.")

    for idx, row in enumerate(machinery_rows):
        if is_excluded(row):
            continue
        if not is_confirmed(row):
            invoice_blockers.append(f"machinery[{idx}] is not Confirmed or Excluded.")
    for idx, row in enumerate(material_rows):
        if is_excluded(row):
            continue
        if not is_confirmed(row):
            invoice_blockers.append(f"material[{idx}] is not Confirmed or Excluded.")

    invoice_blockers = unique_messages(invoice_blockers)
    payroll_blockers = unique_messages(payroll_blockers)
    return {
        "invoice_ready": len(invoice_blockers) == 0,
        "invoice_blockers": invoice_blockers,
        "payroll_ready": len(payroll_blockers) == 0,
        "payroll_blockers": payroll_blockers,
        "warning_count": warning_count,
    }


def default_dashboard_range() -> dict[str, str]:
    today = date.today()
    start = today - timedelta(days=29)
    return {"date_from": start.isoformat(), "date_to": today.isoformat()}


def safe_export_filename(export_type: str, date_from: str, date_to: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "_", str(export_type or "export").lower()).strip("_")
    return f"nativegrace_{slug}_{date_from or 'from'}_to_{date_to or 'to'}.csv"


def _billable(row: dict[str, Any]) -> bool:
    return row.get("billable") in (True, "TRUE", "true")


def build_invoice_rows(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for item in items:
        completion = item.get("completion") or {}
        job = item.get("job") or {}
        machinery = item.get("machinery_entries") or []
        materials = item.get("material_entries") or []
        billable_machinery = 0.0
        for row in machinery:
            if is_excluded(row) or not is_confirmed(row):
                continue
            if _billable(row):
                billable_machinery += float(row.get("duration_hours") or 0)
        billable_materials = sum(
            1
            for row in materials
            if not is_excluded(row) and is_confirmed(row) and _billable(row)
        )
        variations = completion.get("variations") or []
        if isinstance(variations, list):
            variation_summary = "; ".join(str(v) for v in variations)
        else:
            variation_summary = str(variations)
        rows.append(
            {
                "job_sheet_id": completion.get("job_sheet_id") or job.get("job_sheet_id") or "",
                "job_date": normalise_calendar_date(job.get("job_date") or job.get("date")) or "",
                "customer_name": job.get("customer_name") or "",
                "project_name": job.get("project_name") or "",
                "invoice_description": completion.get("invoice_description") or "",
                "work_summary": completion.get("work_summary") or "",
                "variation_summary": variation_summary,
                "billable_labour_hours": completion.get("billable_labour_hours") or 0,
                "billable_machinery_hours": round(billable_machinery, 2),
                "billable_material_items": billable_materials,
                "pricing_status": "Rates not configured",
                "finalised_by": completion.get("finalised_by") or "",
                "finalised_at": completion.get("finalised_at") or "",
            }
        )
    return rows


def build_payroll_rows(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for item in items:
        completion = item.get("completion") or {}
        for row in item.get("labour_entries") or []:
            if is_excluded(row) or not is_confirmed(row):
                continue
            calc = compute_labour_entry(row)
            rows.append(
                {
                    "job_sheet_id": completion.get("job_sheet_id") or "",
                    "completion_id": completion.get("completion_id") or "",
                    "work_date": normalise_calendar_date(row.get("work_date")) or "",
                    "staff_id": row.get("staff_id") or "",
                    "staff_name": row.get("staff_name") or "",
                    "start_time": normalise_clock_time(row.get("start_time")) or "",
                    "finish_time": normalise_clock_time(row.get("finish_time")) or "",
                    "break_minutes": float(row.get("break_minutes") or 0),
                    "net_labour_minutes": "" if calc["net_labour_minutes"] is None else calc["net_labour_minutes"],
                    "labour_hours": "" if calc["labour_hours"] is None else calc["labour_hours"],
                    "travel_minutes": float(row.get("travel_minutes") or 0),
                    "travel_hours": calc.get("travel_hours") or 0,
                    "role_or_activity": row.get("role_or_activity") or "",
                    "billable": "TRUE" if _billable(row) else "FALSE",
                    "notes": row.get("notes") or "",
                    "finalised_by": completion.get("finalised_by") or "",
                    "finalised_at": completion.get("finalised_at") or "",
                }
            )
    return rows


def build_machinery_rows(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for item in items:
        completion = item.get("completion") or {}
        job = item.get("job") or {}
        for row in item.get("machinery_entries") or []:
            if is_excluded(row) or not is_confirmed(row):
                continue
            rows.append(
                {
                    "job_sheet_id": completion.get("job_sheet_id") or "",
                    "completion_id": completion.get("completion_id") or "",
                    "job_date": normalise_calendar_date(job.get("job_date") or job.get("date")) or "",
                    "equipment_name": row.get("equipment_name") or "",
                    "operator_staff_id": row.get("operator_staff_id") or "",
                    "duration_hours": "" if row.get("duration_hours") is None else row.get("duration_hours"),
                    "billable": "TRUE" if _billable(row) else "FALSE",
                    "charge_code": row.get("charge_code") or "",
                    "notes": row.get("notes") or "",
                    "finalised_by": completion.get("finalised_by") or "",
                    "finalised_at": completion.get("finalised_at") or "",
                }
            )
    return rows


def build_materials_rows(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for item in items:
        completion = item.get("completion") or {}
        job = item.get("job") or {}
        for row in item.get("material_entries") or []:
            if is_excluded(row) or not is_confirmed(row):
                continue
            rows.append(
                {
                    "job_sheet_id": completion.get("job_sheet_id") or "",
                    "completion_id": completion.get("completion_id") or "",
                    "job_date": normalise_calendar_date(job.get("job_date") or job.get("date")) or "",
                    "item_name": row.get("item_name") or "",
                    "quantity": "" if row.get("quantity") is None else row.get("quantity"),
                    "unit": row.get("unit") or "",
                    "billable": "TRUE" if _billable(row) else "FALSE",
                    "notes": row.get("notes") or "",
                    "finalised_by": completion.get("finalised_by") or "",
                    "finalised_at": completion.get("finalised_at") or "",
                }
            )
    return rows


def build_summary_rows(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for item in items:
        completion = item.get("completion") or {}
        job = item.get("job") or {}
        readiness = item.get("readiness") or compute_export_readiness(
            completion,
            job,
            item.get("labour_entries"),
            item.get("machinery_entries"),
            item.get("material_entries"),
        )
        rows.append(
            {
                "job_sheet_id": completion.get("job_sheet_id") or "",
                "completion_id": completion.get("completion_id") or "",
                "customer_name": job.get("customer_name") or "",
                "project_name": job.get("project_name") or "",
                "job_date": normalise_calendar_date(job.get("job_date") or job.get("date")) or "",
                "completion_status": completion.get("completion_status") or "",
                "approval_status": job.get("approval_status") or completion.get("job_approval_status") or "",
                "total_labour_hours": completion.get("total_labour_hours") or 0,
                "total_travel_hours": completion.get("total_travel_hours") or 0,
                "total_machinery_hours": completion.get("total_machinery_hours") or 0,
                "billable_labour_hours": completion.get("billable_labour_hours") or 0,
                "non_billable_labour_hours": completion.get("non_billable_labour_hours") or 0,
                "invoice_ready": "TRUE" if readiness.get("invoice_ready") else "FALSE",
                "payroll_ready": "TRUE" if readiness.get("payroll_ready") else "FALSE",
                "warning_count": readiness.get("warning_count") or 0,
                "finalised_by": completion.get("finalised_by") or "",
                "finalised_at": completion.get("finalised_at") or "",
            }
        )
    return rows


CSV_HEADERS: dict[str, list[str]] = {
    EXPORT_INVOICE_CSV: [
        "job_sheet_id",
        "job_date",
        "customer_name",
        "project_name",
        "invoice_description",
        "work_summary",
        "variation_summary",
        "billable_labour_hours",
        "billable_machinery_hours",
        "billable_material_items",
        "pricing_status",
        "finalised_by",
        "finalised_at",
    ],
    EXPORT_PAYROLL_CSV: [
        "job_sheet_id",
        "completion_id",
        "work_date",
        "staff_id",
        "staff_name",
        "start_time",
        "finish_time",
        "break_minutes",
        "net_labour_minutes",
        "labour_hours",
        "travel_minutes",
        "travel_hours",
        "role_or_activity",
        "billable",
        "notes",
        "finalised_by",
        "finalised_at",
    ],
    EXPORT_MACHINERY_CSV: [
        "job_sheet_id",
        "completion_id",
        "job_date",
        "equipment_name",
        "operator_staff_id",
        "duration_hours",
        "billable",
        "charge_code",
        "notes",
        "finalised_by",
        "finalised_at",
    ],
    EXPORT_MATERIALS_CSV: [
        "job_sheet_id",
        "completion_id",
        "job_date",
        "item_name",
        "quantity",
        "unit",
        "billable",
        "notes",
        "finalised_by",
        "finalised_at",
    ],
    EXPORT_SUMMARY_CSV: [
        "job_sheet_id",
        "completion_id",
        "customer_name",
        "project_name",
        "job_date",
        "completion_status",
        "approval_status",
        "total_labour_hours",
        "total_travel_hours",
        "total_machinery_hours",
        "billable_labour_hours",
        "non_billable_labour_hours",
        "invoice_ready",
        "payroll_ready",
        "warning_count",
        "finalised_by",
        "finalised_at",
    ],
}


def build_csv_for_type(export_type: str, items: list[dict[str, Any]]) -> dict[str, Any]:
    if export_type == EXPORT_INVOICE_CSV:
        rows = build_invoice_rows(items)
    elif export_type == EXPORT_PAYROLL_CSV:
        rows = build_payroll_rows(items)
    elif export_type == EXPORT_MACHINERY_CSV:
        rows = build_machinery_rows(items)
    elif export_type == EXPORT_MATERIALS_CSV:
        rows = build_materials_rows(items)
    else:
        rows = build_summary_rows(items)
        export_type = EXPORT_SUMMARY_CSV
    headers = CSV_HEADERS[export_type]
    rows.sort(
        key=lambda r: (
            str(r.get("job_sheet_id") or ""),
            str(r.get("completion_id") or ""),
            str(r.get("staff_id") or r.get("equipment_name") or r.get("item_name") or ""),
        )
    )
    csv_text = build_csv(headers, rows)
    return {"headers": headers, "rows": rows, "csv": csv_text, "checksum": simple_checksum(csv_text)}
