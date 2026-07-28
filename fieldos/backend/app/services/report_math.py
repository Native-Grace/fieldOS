"""Phase 3F job report helpers (server-side).

Pure functions only — no ReportLab, no I/O. Mirrors the Apps Script
JobReportHelpers contract so report content is identical in both data modes.
"""

from __future__ import annotations

import hashlib
import json
import re
from typing import Any

from app.services.completion_math import (
    ROW_CONFIRMED,
    ROW_EXCLUDED,
    STATUS_FINALISED,
    compute_labour_entry,
)
from app.services.export_math import (
    date_in_inclusive_range,
    normalise_calendar_date,
    unresolved_warning_count,
)

TEMPLATE_VERSION = "3F.1"

REPORT_JOB_SHEET_SUMMARY = "Job Sheet Summary"
REPORT_STAFF_WORK_REPORT = "Staff Work Report"
REPORT_CLIENT_JOB_REPORT = "Client Job Report"
REPORT_PROJECT_ACTIVITY_REPORT = "Project Activity Report"
REPORT_COMPLETION_REGISTER = "Completion Register"

REPORT_TYPES = (
    REPORT_JOB_SHEET_SUMMARY,
    REPORT_STAFF_WORK_REPORT,
    REPORT_CLIENT_JOB_REPORT,
    REPORT_PROJECT_ACTIVITY_REPORT,
    REPORT_COMPLETION_REGISTER,
)

STATUS_REPORT_DRAFT = "Draft"
STATUS_REPORT_VALIDATED = "Validated"
STATUS_REPORT_GENERATED = "Generated"
STATUS_REPORT_CANCELLED = "Cancelled"

REPORT_STATUSES = (
    STATUS_REPORT_DRAFT,
    STATUS_REPORT_VALIDATED,
    STATUS_REPORT_GENERATED,
    STATUS_REPORT_CANCELLED,
)

ITEM_PENDING = "Pending"
ITEM_READY = "Ready"
ITEM_BLOCKED = "Blocked"

AUDIENCE_INTERNAL = "internal"
AUDIENCE_CLIENT = "client"

# Client-facing reports never carry internal commentary; everything else is internal.
REPORT_AUDIENCE = {
    REPORT_JOB_SHEET_SUMMARY: AUDIENCE_INTERNAL,
    REPORT_STAFF_WORK_REPORT: AUDIENCE_INTERNAL,
    REPORT_CLIENT_JOB_REPORT: AUDIENCE_CLIENT,
    REPORT_PROJECT_ACTIVITY_REPORT: AUDIENCE_INTERNAL,
    REPORT_COMPLETION_REGISTER: AUDIENCE_INTERNAL,
}

# Staff may only ever pull their own labour back out of FieldOS.
STAFF_ALLOWED_REPORT_TYPES = (REPORT_STAFF_WORK_REPORT,)

REPORT_LANDSCAPE_DEFAULT = {REPORT_COMPLETION_REGISTER: True}

# Mirrors Apps Script FIELDOS_REPORT_GROUPINGS_ — used by options + normalisers.
REPORT_GROUPINGS: dict[str, dict[str, Any]] = {
    REPORT_JOB_SHEET_SUMMARY: {
        "default_group": "job_sheet_id",
        "allowed": ["job_sheet_id"],
    },
    REPORT_STAFF_WORK_REPORT: {
        "default_group": "staff_id",
        "allowed": ["staff_id", "job_sheet_id"],
    },
    REPORT_CLIENT_JOB_REPORT: {
        "default_group": "customer",
        "allowed": ["customer", "project", "job_sheet_id"],
    },
    REPORT_PROJECT_ACTIVITY_REPORT: {
        "default_group": "project",
        "allowed": ["project", "customer", "job_month"],
    },
    REPORT_COMPLETION_REGISTER: {
        "default_group": "job_month",
        "allowed": ["job_month", "customer", "project", "none"],
    },
}


def report_type_option(report_type: str) -> dict[str, Any]:
    """Build the rich report-type option object Apps Script returns."""
    name = str(report_type or "").strip()
    spec = REPORT_GROUPINGS.get(name) or {"default_group": "job_sheet_id", "allowed": ["job_sheet_id"]}
    allowed = list(spec.get("allowed") or [])
    default_group = str(spec.get("default_group") or (allowed[0] if allowed else ""))
    return {
        "report_type": name,
        "label": name,
        "default_group_by": default_group,
        "allowed_group_by": allowed,
        "group_by": allowed,
        "supports_landscape": bool(REPORT_LANDSCAPE_DEFAULT.get(name)),
    }


def normalise_report_type_option(raw: Any) -> dict[str, Any]:
    """Accept a string or rich object; always return ReportTypeOption-shaped dict."""
    if isinstance(raw, str):
        return report_type_option(raw) if raw.strip() in REPORT_GROUPINGS else {
            "report_type": raw.strip(),
            "label": raw.strip(),
            "default_group_by": "",
            "allowed_group_by": [],
            "group_by": [],
            "supports_landscape": False,
        }
    if not isinstance(raw, dict):
        return report_type_option("")
    name = str(raw.get("report_type") or raw.get("type") or "").strip()
    base = report_type_option(name) if name else {
        "report_type": "",
        "label": "",
        "default_group_by": "",
        "allowed_group_by": [],
        "group_by": [],
        "supports_landscape": False,
    }
    allowed = raw.get("allowed_group_by")
    if allowed is None:
        allowed = raw.get("group_by")
    if isinstance(allowed, str):
        allowed = [allowed] if allowed.strip() else []
    if allowed is None:
        allowed = list(base["allowed_group_by"])
    if not isinstance(allowed, list):
        allowed = list(base["allowed_group_by"])
    allowed = [str(item).strip() for item in allowed if str(item).strip()]
    default_group = str(raw.get("default_group_by") or "").strip()
    if not default_group:
        # Explicit empty allowed_group_by stays empty; otherwise fall back to catalogue default.
        if "allowed_group_by" in raw or "group_by" in raw:
            default_group = allowed[0] if allowed else ""
        else:
            default_group = allowed[0] if allowed else str(base["default_group_by"] or "")
    landscape = raw.get("supports_landscape")
    if landscape is None:
        landscape = base.get("supports_landscape")
    return {
        "report_type": name or str(base["report_type"]),
        "label": str(raw.get("label") or name or base["label"] or ""),
        "description": raw.get("description"),
        "default_group_by": default_group,
        "allowed_group_by": allowed,
        "group_by": allowed,
        "supports_landscape": bool(landscape) if landscape is not None else None,
    }


MAX_REPORT_PDF_BYTES = 15 * 1024 * 1024
PDF_MAGIC = b"%PDF"

TASK_SOURCE_REVIEW = "Manager review"
TASK_SOURCE_VARIATION = "Variation"

# Raw dictation, Drive handles and credentials must never reach a rendered page.
FORBIDDEN_REPORT_KEYS = frozenset(
    {
        "ai_transcript",
        "ai_transcript_character_count",
        "transcript",
        "transcript_text",
        "raw_transcript",
        "recording_file_url",
        "recording_drive_file_id",
        "drive_file_id",
        "drive_folder_id",
        "recordings_folder_id",
        "webhook_secret",
        "apps_script_webhook_secret",
        "jwt_secret",
        "access_token",
        "refresh_token",
        "id_token",
        "authorization",
        "password",
        "password_hash",
        "api_key",
        "openai_api_key",
        "google_application_credentials",
    }
)

_FORBIDDEN_KEY_PATTERN = re.compile(
    r"(transcript|drive_file_id|drive_folder_id|_secret$|^secret|token|password|api_key|credentials)",
    re.I,
)

# Stripped from client reports: internal commentary, payroll handles and any cost/margin figure.
CLIENT_FORBIDDEN_KEYS = frozenset(
    {
        "internal_notes",
        "manager_notes",
        "manager_review_items",
        "warnings",
        "warning_resolutions",
        "unresolved_warning_count",
        "cost_rate",
        "cost_price",
        "unit_cost",
        "overtime_rate",
        "margin",
        "margin_percent",
        "payroll_mapping_id",
        "payroll_mappings",
        "employee_reference",
        "pay_calendar",
        "cost_centre",
        "award_reference",
        "employment_classification",
        "ordinary_hours_code",
        "overtime_hours_code",
        "travel_hours_code",
        "non_billable_labour_hours",
        "return_reason",
        "override_reason",
        "reopen_reason",
    }
)

_CLIENT_KEY_PATTERN = re.compile(r"(cost_rate|cost_price|unit_cost|payroll|margin)", re.I)


def is_forbidden_report_key(key: Any) -> bool:
    name = str(key or "").strip().lower()
    if not name:
        return False
    if name in FORBIDDEN_REPORT_KEYS:
        return True
    return bool(_FORBIDDEN_KEY_PATTERN.search(name))


def is_client_forbidden_key(key: Any) -> bool:
    name = str(key or "").strip().lower()
    if not name:
        return False
    if name in CLIENT_FORBIDDEN_KEYS:
        return True
    return bool(_CLIENT_KEY_PATTERN.search(name))


def scrub_report_record(record: Any, *, audience: str = AUDIENCE_INTERNAL) -> Any:
    """Recursively drop forbidden keys before a payload is frozen or rendered."""
    client = str(audience or "").strip().lower() == AUDIENCE_CLIENT
    if isinstance(record, dict):
        out: dict[str, Any] = {}
        for key, value in record.items():
            if is_forbidden_report_key(key):
                continue
            if client and is_client_forbidden_key(key):
                continue
            out[str(key)] = scrub_report_record(value, audience=audience)
        return out
    if isinstance(record, (list, tuple)):
        return [scrub_report_record(row, audience=audience) for row in record]
    return record


def _split_text_lines(value: Any) -> list[str]:
    if value is None or value == "":
        return []
    if isinstance(value, (list, tuple)):
        raw: list[str] = []
        for row in value:
            raw.extend(_split_text_lines(row))
        return raw
    text = str(value).strip()
    if not text:
        return []
    parts = re.split(r"[\r\n]+|(?<=[.;])\s*;\s*|\s*;\s*", text)
    return [re.sub(r"^\s*[-*\u2022]\s*", "", part).strip() for part in parts if part and part.strip()]


def extract_task_lines(
    job: dict[str, Any] | None,
    completion: dict[str, Any] | None = None,
) -> list[dict[str, str]]:
    """Task lines come only from approved manager review items plus recorded variations.

    Nothing is inferred from raw dictation: an unapproved job contributes no review items.
    """
    job = job or {}
    completion = completion or {}
    lines: list[dict[str, str]] = []
    seen: set[tuple[str, str]] = set()

    approved = str(job.get("approval_status") or "").strip() == "Approved"
    if approved:
        for text in _split_text_lines(job.get("manager_review_items")):
            key = (TASK_SOURCE_REVIEW, text.lower())
            if key in seen:
                continue
            seen.add(key)
            lines.append({"source": TASK_SOURCE_REVIEW, "text": text})

    variations = completion.get("variations")
    if variations in (None, "", []):
        variations = job.get("variations")
    for text in _split_text_lines(variations):
        key = (TASK_SOURCE_VARIATION, text.lower())
        if key in seen:
            continue
        seen.add(key)
        lines.append({"source": TASK_SOURCE_VARIATION, "text": text})

    return lines


def is_confirmed(row: dict[str, Any]) -> bool:
    return str(row.get("confirmation_status") or "").strip() == ROW_CONFIRMED


def is_excluded_row(row: dict[str, Any]) -> bool:
    return str(row.get("confirmation_status") or "").strip() == ROW_EXCLUDED


def _billable(row: dict[str, Any]) -> bool:
    return row.get("billable") in (True, "TRUE", "true")


def reportable_rows(rows: list[dict[str, Any]] | None) -> list[dict[str, Any]]:
    """Reports show confirmed work only — suggested and excluded rows are never printed."""
    return [row for row in (rows or []) if is_confirmed(row)]


def matches_report_filters(bundle: dict[str, Any], filters: dict[str, Any] | None) -> bool:
    filters = filters or {}
    job = bundle.get("job") or {}
    completion = bundle.get("completion") or {}

    job_date = normalise_calendar_date(job.get("job_date"))
    if not date_in_inclusive_range(job_date, filters.get("date_from"), filters.get("date_to")):
        return False
    if filters.get("completion_status") and str(completion.get("completion_status") or "") != str(
        filters["completion_status"]
    ):
        return False
    if filters.get("approval_status") and str(job.get("approval_status") or "") != str(
        filters["approval_status"]
    ):
        return False
    if filters.get("job_sheet_ids"):
        wanted = {str(x) for x in filters["job_sheet_ids"]}
        if str(job.get("job_sheet_id") or "") not in wanted:
            return False
    if filters.get("customer"):
        if str(filters["customer"]).lower() not in str(job.get("customer_name") or "").lower():
            return False
    if filters.get("project"):
        if str(filters["project"]).lower() not in str(job.get("project_name") or "").lower():
            return False
    if filters.get("assigned_staff_id") and str(job.get("assigned_staff_id") or "") != str(
        filters["assigned_staff_id"]
    ):
        return False
    if filters.get("staff_id"):
        wanted_staff = str(filters["staff_id"])
        staff_ids = {
            str(row.get("staff_id") or "")
            for row in reportable_rows(bundle.get("labour_entries"))
        }
        if str(job.get("assigned_staff_id") or "") == wanted_staff:
            staff_ids.add(wanted_staff)
        if wanted_staff not in staff_ids:
            return False
    if filters.get("finalised_only") in (True, "true", "TRUE"):
        if str(completion.get("completion_status") or "") != STATUS_FINALISED:
            return False
    if filters.get("billable") in (True, "true", "TRUE"):
        hours = float(completion.get("billable_labour_hours") or 0)
        has_billable_row = any(_billable(row) for row in reportable_rows(bundle.get("labour_entries")))
        if hours <= 0 and not has_billable_row:
            return False
    if filters.get("billable") in (False, "false", "FALSE"):
        hours = float(completion.get("billable_labour_hours") or 0)
        has_billable_row = any(_billable(row) for row in reportable_rows(bundle.get("labour_entries")))
        if hours > 0 or has_billable_row:
            return False
    if filters.get("q"):
        blob = " ".join(
            [
                str(job.get("job_sheet_id") or ""),
                str(job.get("customer_name") or ""),
                str(job.get("project_name") or ""),
                str(completion.get("work_summary") or ""),
                str(completion.get("invoice_description") or ""),
            ]
        ).lower()
        if str(filters["q"]).lower() not in blob:
            return False
    return True


def labour_row_view(row: dict[str, Any], completion: dict[str, Any] | None = None) -> dict[str, Any]:
    calc = compute_labour_entry(row)
    completion = completion or {}
    return {
        "job_sheet_id": str(row.get("job_sheet_id") or completion.get("job_sheet_id") or ""),
        "work_date": normalise_calendar_date(row.get("work_date")) or "",
        "staff_id": str(row.get("staff_id") or ""),
        "staff_name": str(row.get("staff_name") or ""),
        "start_time": calc.get("start_time") or "",
        "finish_time": calc.get("finish_time") or "",
        "break_minutes": float(row.get("break_minutes") or 0),
        "labour_hours": calc.get("labour_hours"),
        "travel_hours": calc.get("travel_hours") or 0,
        "role_or_activity": str(row.get("role_or_activity") or ""),
        "billable": _billable(row),
        "notes": str(row.get("notes") or ""),
    }


def bundle_totals(bundle: dict[str, Any]) -> dict[str, float]:
    labour = reportable_rows(bundle.get("labour_entries"))
    machinery = reportable_rows(bundle.get("machinery_entries"))
    materials = reportable_rows(bundle.get("material_entries"))
    labour_hours = 0.0
    travel_hours = 0.0
    billable_hours = 0.0
    for row in labour:
        view = labour_row_view(row, bundle.get("completion"))
        hours = float(view["labour_hours"] or 0)
        labour_hours += hours
        travel_hours += float(view["travel_hours"] or 0)
        if view["billable"]:
            billable_hours += hours
    machinery_hours = sum(float(row.get("duration_hours") or 0) for row in machinery)
    return {
        "labour_hours": round(labour_hours, 2),
        "travel_hours": round(travel_hours, 2),
        "billable_labour_hours": round(billable_hours, 2),
        "machinery_hours": round(machinery_hours, 2),
        "material_items": len(materials),
        "job_count": 1,
    }


def sum_totals(rows: list[dict[str, Any]]) -> dict[str, float]:
    out = {
        "labour_hours": 0.0,
        "travel_hours": 0.0,
        "billable_labour_hours": 0.0,
        "machinery_hours": 0.0,
        "material_items": 0.0,
        "job_count": 0.0,
    }
    for row in rows:
        for key in out:
            out[key] += float(row.get(key) or 0)
    for key in ("labour_hours", "travel_hours", "billable_labour_hours", "machinery_hours"):
        out[key] = round(out[key], 2)
    out["material_items"] = int(out["material_items"])
    out["job_count"] = int(out["job_count"])
    return out


def _group_key(report_type: str, bundle: dict[str, Any]) -> tuple[str, str]:
    job = bundle.get("job") or {}
    if report_type == REPORT_CLIENT_JOB_REPORT:
        name = str(job.get("customer_name") or "").strip()
        return (name.lower() or "zz", name or "Customer not recorded")
    if report_type == REPORT_PROJECT_ACTIVITY_REPORT:
        name = str(job.get("project_name") or "").strip()
        return (name.lower() or "zz", name or "Project not recorded")
    if report_type == REPORT_STAFF_WORK_REPORT:
        return ("", "")
    return ("all", "All completions")


def group_bundles(bundles: list[dict[str, Any]], report_type: str) -> list[dict[str, Any]]:
    """Group report bundles into the sections a renderer prints, in stable order."""
    groups: dict[str, dict[str, Any]] = {}

    if report_type == REPORT_STAFF_WORK_REPORT:
        for bundle in bundles:
            completion = bundle.get("completion") or {}
            job = bundle.get("job") or {}
            for row in reportable_rows(bundle.get("labour_entries")):
                view = labour_row_view(row, completion)
                view["customer_name"] = str(job.get("customer_name") or "")
                view["project_name"] = str(job.get("project_name") or "")
                view["job_sheet_id"] = view["job_sheet_id"] or str(job.get("job_sheet_id") or "")
                staff_id = view["staff_id"] or "unassigned"
                label = view["staff_name"] or view["staff_id"] or "Staff not recorded"
                group = groups.setdefault(
                    staff_id,
                    {"key": staff_id, "label": label, "rows": [], "jobs": set()},
                )
                if not group["label"] and label:
                    group["label"] = label
                group["rows"].append(view)
                group["jobs"].add(view["job_sheet_id"])
        ordered = []
        for key in sorted(groups):
            group = groups[key]
            rows = sorted(group["rows"], key=lambda r: (r["work_date"], r["job_sheet_id"]))
            totals = sum_totals(
                [
                    {
                        "labour_hours": r["labour_hours"] or 0,
                        "travel_hours": r["travel_hours"] or 0,
                        "billable_labour_hours": (r["labour_hours"] or 0) if r["billable"] else 0,
                    }
                    for r in rows
                ]
            )
            totals["job_count"] = len({r["job_sheet_id"] for r in rows if r["job_sheet_id"]})
            ordered.append(
                {
                    "key": group["key"],
                    "label": group["label"],
                    "rows": rows,
                    "bundles": [],
                    "totals": totals,
                }
            )
        return ordered

    for bundle in bundles:
        key, label = _group_key(report_type, bundle)
        group = groups.setdefault(key, {"key": key, "label": label, "bundles": []})
        group["bundles"].append(bundle)

    ordered = []
    for key in sorted(groups):
        group = groups[key]
        group["bundles"].sort(
            key=lambda b: (
                normalise_calendar_date((b.get("job") or {}).get("job_date")) or "",
                str((b.get("job") or {}).get("job_sheet_id") or ""),
            )
        )
        group["rows"] = []
        group["totals"] = sum_totals([bundle_totals(b) for b in group["bundles"]])
        ordered.append(group)
    return ordered


def estimate_pages(data: dict[str, Any] | None, report_type: str) -> int:
    """Rough deterministic page estimate used for preview only."""
    data = data or {}
    if report_type == REPORT_JOB_SHEET_SUMMARY:
        rows = (
            len(data.get("labour_entries") or [])
            + len(data.get("machinery_entries") or [])
            + len(data.get("material_entries") or [])
            + len(data.get("task_lines") or [])
        )
        return max(1, 1 + rows // 28)

    groups = data.get("groups") or []
    if report_type == REPORT_STAFF_WORK_REPORT:
        rows = sum(len(group.get("rows") or []) for group in groups)
        return max(1, (len(groups) + rows + 24) // 25)
    if report_type == REPORT_COMPLETION_REGISTER:
        rows = sum(len(group.get("bundles") or []) for group in groups)
        return max(1, (rows + 21) // 22)
    rows = sum(len(group.get("bundles") or []) for group in groups)
    return max(1, (len(groups) * 2 + rows * 3 + 17) // 18)


def report_slug(report_type: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", str(report_type or "report").lower()).strip("_")


def safe_report_filename(
    report_type: str,
    date_from: Any = "",
    date_to: Any = "",
    *,
    job_sheet_id: Any = None,
) -> str:
    slug = report_slug(report_type)
    if job_sheet_id:
        job_slug = re.sub(r"[^A-Za-z0-9._-]+", "_", str(job_sheet_id)).strip("_") or "job"
        return f"nativegrace_{slug}_{job_slug}.pdf"
    start = re.sub(r"[^0-9-]", "", str(date_from or "")) or "from"
    end = re.sub(r"[^0-9-]", "", str(date_to or "")) or "to"
    return f"nativegrace_{slug}_{start}_to_{end}.pdf"


def sha256_hex(data: bytes | str) -> str:
    payload = data.encode("utf-8") if isinstance(data, str) else bytes(data or b"")
    return hashlib.sha256(payload).hexdigest()


def validate_pdf_bytes(data: Any, *, max_bytes: int = MAX_REPORT_PDF_BYTES) -> int:
    """Return the byte length of a usable PDF, or raise ValueError.

    Callers must run this before any download response so an empty or truncated
    render is never handed to a browser as application/pdf.
    """
    if data is None:
        raise ValueError("Report PDF is empty.")
    if isinstance(data, bytearray):
        data = bytes(data)
    if not isinstance(data, bytes):
        raise ValueError("Report PDF must be raw bytes.")
    if len(data) == 0:
        raise ValueError("Report PDF is empty.")
    if not data.startswith(PDF_MAGIC):
        raise ValueError("Report PDF is missing the %PDF header.")
    if len(data) > max_bytes:
        raise ValueError(f"Report PDF exceeds the {max_bytes} byte limit.")
    return len(data)


# Snapshot field aliases seen across Apps Script, mock, and older payloads.
_SNAPSHOT_FIELD_CANDIDATES = (
    "snapshot",
    "report_data",
    "snapshot_json",
    "report_snapshot_json",
    "pdf_data",
    "report_snapshot",
)


class ReportSnapshotError(ValueError):
    """Structured failure while extracting a frozen report snapshot for PDF render."""


def _parse_snapshot_candidate(raw: Any) -> tuple[Any, str]:
    """Return (parsed_value, type_label). Raises ReportSnapshotError on invalid JSON."""
    if raw is None:
        raise ReportSnapshotError("Report snapshot is missing or empty.")
    if isinstance(raw, (dict, list)):
        return raw, "list" if isinstance(raw, list) else "dict"
    if isinstance(raw, str):
        text = raw.strip()
        if not text:
            raise ReportSnapshotError("Report snapshot is missing or empty.")
        try:
            parsed = json.loads(text)
        except json.JSONDecodeError as exc:
            raise ReportSnapshotError("Report snapshot JSON is invalid.") from exc
        if isinstance(parsed, dict):
            return parsed, "json_string"
        if isinstance(parsed, list):
            return parsed, "json_string"
        raise ReportSnapshotError("Report snapshot is missing or empty.")
    raise ReportSnapshotError("Report snapshot is missing or empty.")


def _unwrap_report_container(value: Any) -> Any:
    """Accept {report: ...} wrappers without discarding the inner payload."""
    if not isinstance(value, dict):
        return value
    if "report" in value and len(value) == 1:
        return value.get("report")
    inner = value.get("report")
    if isinstance(inner, (dict, list)) and not any(
        key in value for key in ("jobs", "bundles", "job", "groups", "record_count", "job_count")
    ):
        return inner
    return value


def _extract_raw_snapshot(result: Any) -> tuple[Any, str, Any]:
    """Locate the first non-empty snapshot candidate.

    Returns (raw_value, field_name, container_dict_used_for_metadata).
    """
    if result is None:
        raise ReportSnapshotError("Report snapshot is missing or empty.")

    # Bare snapshot payloads (dict/list/JSON string).
    if isinstance(result, list) or (
        isinstance(result, dict)
        and not any(
            key in result
            for key in (
                "data",
                "batch",
                "items",
                "report_batch",
                *_SNAPSHOT_FIELD_CANDIDATES,
            )
        )
        and any(key in result for key in ("jobs", "bundles", "job", "groups", "report_type"))
    ):
        return result, "snapshot", result if isinstance(result, dict) else {}

    if isinstance(result, str):
        return result, "snapshot", {}

    if not isinstance(result, dict):
        raise ReportSnapshotError("Report snapshot is missing or empty.")

    containers: list[tuple[str, dict[str, Any]]] = [("", result)]
    data = result.get("data")
    if isinstance(data, dict):
        containers.append(("data", data))

    for _label, container in containers:
        for field in _SNAPSHOT_FIELD_CANDIDATES:
            if field not in container:
                continue
            raw = container.get(field)
            if raw is None:
                continue
            if isinstance(raw, str) and not raw.strip():
                continue
            if isinstance(raw, (dict, list)) and not raw:
                continue
            return raw, field, container

        # Nested aliases under data already covered; also accept batch.snapshot*.
        batch = container.get("batch") or container.get("report_batch")
        if isinstance(batch, dict):
            for field in _SNAPSHOT_FIELD_CANDIDATES:
                if field not in batch:
                    continue
                raw = batch.get(field)
                if raw is None or (isinstance(raw, str) and not raw.strip()):
                    continue
                if isinstance(raw, (dict, list)) and not raw:
                    continue
                return raw, f"batch.{field}", container

    raise ReportSnapshotError("Report snapshot is missing or empty.")


def snapshot_included_record_count(snapshot: Any) -> int:
    """Count jobs/bundles included in a frozen snapshot (never live-filter)."""
    if isinstance(snapshot, list):
        return len(snapshot)
    if not isinstance(snapshot, dict):
        return 0
    for key in ("jobs", "bundles"):
        rows = snapshot.get(key)
        if isinstance(rows, list):
            return len(rows)
    if isinstance(snapshot.get("job_index"), list) and snapshot.get("omitted_job_data"):
        return len(snapshot["job_index"])
    if snapshot.get("job"):
        return 1
    for key in ("record_count", "job_count"):
        try:
            count = int(snapshot.get(key) or 0)
        except (TypeError, ValueError):
            count = 0
        if count > 0:
            return count
    return 0


def _adapt_task_lines(rows: Any) -> list[dict[str, Any]]:
    adapted: list[dict[str, Any]] = []
    for row in rows or []:
        if not isinstance(row, dict):
            continue
        if "source" in row or "text" in row:
            adapted.append(
                {
                    "source": str(row.get("source") or row.get("category") or row.get("source_type") or ""),
                    "text": str(row.get("text") or row.get("description") or ""),
                }
            )
            continue
        adapted.append(
            {
                "source": str(row.get("category") or row.get("source_type") or ""),
                "text": str(row.get("description") or ""),
            }
        )
    return adapted


def _adapt_totals(totals: Any) -> dict[str, Any]:
    src = dict(totals or {}) if isinstance(totals, dict) else {}
    out = dict(src)
    aliases = (
        ("labour_hours", ("labour_hours", "total_labour_hours")),
        ("travel_hours", ("travel_hours", "total_travel_hours")),
        ("machinery_hours", ("machinery_hours", "total_machinery_hours")),
        ("billable_labour_hours", ("billable_labour_hours",)),
        ("material_items", ("material_items", "material_row_count")),
        ("job_count", ("job_count", "record_count")),
    )
    for dest, keys in aliases:
        if dest in out and out[dest] not in (None, ""):
            continue
        for key in keys:
            if key in src and src[key] not in (None, ""):
                out[dest] = src[key]
                break
    return out


def adapt_frozen_job_bundle(job_or_bundle: dict[str, Any] | None) -> dict[str, Any]:
    """Map Apps Script fieldosBuildJobPdfData_ rows onto the PDF renderer bundle shape."""
    src = dict(job_or_bundle or {})
    completion = dict(src.get("completion") or {})
    if src.get("internal_notes") and not completion.get("internal_notes"):
        completion["internal_notes"] = src.get("internal_notes")
    labour = src.get("labour_entries")
    if labour is None:
        labour = src.get("labour") or []
    machinery = src.get("machinery_entries")
    if machinery is None:
        machinery = src.get("machinery") or []
    materials = src.get("material_entries")
    if materials is None:
        materials = src.get("materials") or []
    tasks = src.get("task_lines")
    if tasks is None:
        tasks = src.get("tasks") or []
    return {
        "job": dict(src.get("job") or {}),
        "completion": completion,
        "labour_entries": list(labour or []),
        "machinery_entries": list(machinery or []),
        "material_entries": list(materials or []),
        "task_lines": _adapt_task_lines(tasks),
        "totals": _adapt_totals(src.get("totals") or {}),
    }


def prepare_report_snapshot_for_render(
    snapshot: dict[str, Any] | list[Any],
    *,
    report_type: str = "",
) -> dict[str, Any]:
    """Adapt a frozen snapshot for ReportLab without re-running live filters.

    Apps Script freezes `jobs` + summary `groups`; the mock freezes renderer-ready
    `bundles` / `groups`. Both shapes are accepted here.
    """
    if isinstance(snapshot, list):
        bundles = [adapt_frozen_job_bundle(row) for row in snapshot if isinstance(row, dict)]
        resolved_type = report_type or REPORT_JOB_SHEET_SUMMARY
        out: dict[str, Any] = {
            "report_type": resolved_type,
            "template_version": TEMPLATE_VERSION,
            "jobs": bundles,
            "bundles": bundles,
            "record_count": len(bundles),
            "job_count": len(bundles),
            "groups": group_bundles(bundles, resolved_type) if resolved_type != REPORT_JOB_SHEET_SUMMARY else [],
            "totals": _adapt_totals(sum_totals([b.get("totals") or {} for b in bundles])),
        }
        if len(bundles) == 1:
            out.update(bundles[0])
        return out

    snap = dict(snapshot or {})
    resolved_type = str(report_type or snap.get("report_type") or "")
    raw_rows = snap.get("bundles")
    if not isinstance(raw_rows, list):
        raw_rows = snap.get("jobs")
    bundles: list[dict[str, Any]] = []
    if isinstance(raw_rows, list):
        bundles = [adapt_frozen_job_bundle(row) for row in raw_rows if isinstance(row, dict)]
    elif snap.get("job"):
        bundles = [adapt_frozen_job_bundle(snap)]

    out = dict(snap)
    out["totals"] = _adapt_totals(snap.get("totals") or {})
    if bundles:
        out["bundles"] = bundles
        out["jobs"] = bundles
        out.setdefault("record_count", len(bundles))
        out.setdefault("job_count", len(bundles))

    groups = out.get("groups") if isinstance(out.get("groups"), list) else []
    needs_rebuild = False
    if resolved_type and resolved_type != REPORT_JOB_SHEET_SUMMARY:
        if not groups:
            needs_rebuild = True
        else:
            sample = groups[0] if isinstance(groups[0], dict) else {}
            has_rows = bool(sample.get("rows"))
            has_bundles = bool(sample.get("bundles"))
            # Apps Script summary groups only carry labels / job_sheet_ids.
            if not has_rows and not has_bundles:
                needs_rebuild = True
            elif has_bundles:
                rebuilt = []
                for group in groups:
                    if not isinstance(group, dict):
                        continue
                    g = dict(group)
                    g["label"] = g.get("label") or g.get("group_label") or g.get("key") or g.get("group_key")
                    g["key"] = g.get("key") or g.get("group_key") or g.get("label") or ""
                    g["bundles"] = [
                        adapt_frozen_job_bundle(b) for b in (g.get("bundles") or []) if isinstance(b, dict)
                    ]
                    g["totals"] = _adapt_totals(g.get("totals") or sum_totals([b.get("totals") or {} for b in g["bundles"]]))
                    rebuilt.append(g)
                groups = rebuilt
    if needs_rebuild and bundles and resolved_type:
        groups = group_bundles(bundles, resolved_type)
    elif groups:
        # Normalise label/key aliases for already-ready mock groups.
        normalised_groups = []
        for group in groups:
            if not isinstance(group, dict):
                continue
            g = dict(group)
            g["label"] = g.get("label") or g.get("group_label") or g.get("key") or g.get("group_key")
            g["key"] = g.get("key") or g.get("group_key") or g.get("label") or ""
            normalised_groups.append(g)
        groups = normalised_groups

    if resolved_type != REPORT_JOB_SHEET_SUMMARY:
        out["groups"] = groups
    if resolved_type == REPORT_JOB_SHEET_SUMMARY and len(bundles) == 1:
        for key, value in bundles[0].items():
            out.setdefault(key, value)
    if resolved_type:
        out["report_type"] = resolved_type
    return out


def normalise_report_pdf_snapshot(result: Any) -> dict[str, Any]:
    """Canonicalise get_report_batch_pdf_data / get_job_pdf_data payloads.

    Accepts nested Apps Script envelopes, JSON strings, legacy aliases
    (`report_data`, `snapshot_json`, `pdf_data`), and mock `{snapshot: ...}`.
    Rejects null, blank, {}, [], invalid JSON, and zero included records.
    """
    raw, field, container = _extract_raw_snapshot(result)
    parsed, snapshot_type = _parse_snapshot_candidate(raw)
    parsed = _unwrap_report_container(parsed)

    if parsed is None:
        raise ReportSnapshotError("Report snapshot is missing or empty.")
    if isinstance(parsed, dict) and not parsed:
        raise ReportSnapshotError("Report snapshot is missing or empty.")
    if isinstance(parsed, list) and not parsed:
        raise ReportSnapshotError("Report snapshot is missing or empty.")
    if not isinstance(parsed, (dict, list)):
        raise ReportSnapshotError("Report snapshot is missing or empty.")

    included = snapshot_included_record_count(parsed)
    if included <= 0:
        raise ReportSnapshotError("Report snapshot has no included records.")

    batch: dict[str, Any] = {}
    items: list[dict[str, Any]] = []
    if isinstance(result, dict):
        for key in ("batch", "report_batch"):
            candidate = result.get(key)
            if isinstance(candidate, dict) and candidate:
                batch = dict(candidate)
                break
        if not batch and isinstance(result.get("data"), dict):
            nested = result["data"]
            for key in ("batch", "report_batch"):
                candidate = nested.get(key)
                if isinstance(candidate, dict) and candidate:
                    batch = dict(candidate)
                    break
        for source in (result, result.get("data") if isinstance(result.get("data"), dict) else {}):
            if isinstance(source, dict) and isinstance(source.get("items"), list):
                items = [row for row in source["items"] if isinstance(row, dict)]
                if items:
                    break

    report_type = ""
    if isinstance(parsed, dict):
        report_type = str(parsed.get("report_type") or "")
    report_type = str(
        report_type
        or batch.get("report_type")
        or (container.get("report_type") if isinstance(container, dict) else "")
        or ""
    )

    meta: dict[str, Any] = {}
    if isinstance(container, dict) and isinstance(container.get("meta"), dict):
        meta = dict(container["meta"])
    elif isinstance(result, dict) and isinstance(result.get("meta"), dict):
        meta = dict(result["meta"])
    if batch:
        meta.setdefault("report_type", str(batch.get("report_type") or report_type))
        meta.setdefault("report_title", str(batch.get("report_type") or report_type))
        meta.setdefault("template_version", str(batch.get("template_version") or TEMPLATE_VERSION))
        meta.setdefault("internal_ref", str(batch.get("report_batch_id") or ""))
        meta.setdefault("generated_at", str(batch.get("completed_at") or batch.get("created_at") or ""))
        meta.setdefault("generated_by", str(batch.get("generated_by") or batch.get("created_by") or ""))
        if batch.get("landscape") is not None:
            meta.setdefault("landscape", batch.get("landscape"))

    file_name = ""
    checksum = ""
    template_version = TEMPLATE_VERSION
    report_batch_id = ""
    if isinstance(container, dict):
        file_name = str(container.get("file_name") or "")
        checksum = str(container.get("checksum") or "")
        template_version = str(container.get("template_version") or template_version)
        report_batch_id = str(container.get("report_batch_id") or "")
    if batch:
        file_name = file_name or str(batch.get("file_name") or "")
        checksum = checksum or str(batch.get("checksum") or "")
        template_version = str(batch.get("template_version") or template_version)
        report_batch_id = report_batch_id or str(batch.get("report_batch_id") or "")

    return {
        "batch": batch,
        "snapshot": parsed,
        "items": items,
        "snapshot_field": field,
        "snapshot_type": snapshot_type,
        "snapshot_present": True,
        "included_record_count": included,
        "report_type": report_type,
        "template_version": template_version,
        "file_name": file_name,
        "checksum": checksum,
        "report_batch_id": report_batch_id,
        "meta": meta,
        "batch_status": str(batch.get("status") or ""),
    }


def report_readiness(bundle: dict[str, Any], report_type: str) -> list[str]:
    """Blockers that stop one job appearing in a report of this type."""
    completion = bundle.get("completion") or {}
    job = bundle.get("job") or {}
    blockers: list[str] = []
    status = str(completion.get("completion_status") or "").strip()

    if report_type in (REPORT_CLIENT_JOB_REPORT, REPORT_JOB_SHEET_SUMMARY):
        if status != STATUS_FINALISED:
            blockers.append("Completion is not Finalised.")
    if report_type == REPORT_CLIENT_JOB_REPORT:
        if str(job.get("approval_status") or "").strip() != "Approved":
            blockers.append("Job approval_status must be Approved for a client report.")
        if not str(completion.get("invoice_description") or "").strip():
            blockers.append("Invoice description is blank.")
        if unresolved_warning_count(completion):
            blockers.append("Unresolved warnings must be cleared before a client report.")
    if report_type == REPORT_STAFF_WORK_REPORT:
        if not reportable_rows(bundle.get("labour_entries")):
            blockers.append("No confirmed labour entries for this job.")
    return blockers
