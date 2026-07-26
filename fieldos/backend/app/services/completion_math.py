"""Phase 3C deterministic labour / machinery calculations (server-side)."""

from __future__ import annotations

import re
from typing import Any

MAX_SHIFT_HOURS = 12
ROW_SUGGESTED = "Suggested"
ROW_CONFIRMED = "Confirmed"
ROW_EXCLUDED = "Excluded"
STATUS_DRAFT = "Draft"
STATUS_READY = "Ready for Final Review"
STATUS_FINALISED = "Finalised"
STATUS_REOPENED = "Reopened"

_TIME_RE = re.compile(r"^([01]?\d|2[0-3]):([0-5]\d)$")


def parse_time_to_minutes(value: Any) -> int | None:
    if value is None or value == "":
        return None
    match = _TIME_RE.match(str(value).strip())
    if not match:
        return None
    return int(match.group(1)) * 60 + int(match.group(2))


def unique_messages(messages: list[str] | None) -> list[str]:
    seen: set[str] = set()
    out: list[str] = []
    for raw in messages or []:
        text = str(raw or "").strip()
        if not text or text in seen:
            continue
        seen.add(text)
        out.append(text)
    return out


def is_excluded(row: dict[str, Any]) -> bool:
    return str(row.get("confirmation_status") or "").strip() == ROW_EXCLUDED


def is_suggested(row: dict[str, Any]) -> bool:
    status = str(row.get("confirmation_status") or "").strip()
    return not status or status == ROW_SUGGESTED


def warning_key(text: Any) -> str:
    t = str(text or "").lower()
    if re.search(r"contradictory lunch|confirm unpaid break", t):
        return "contradictory_lunch"
    if re.search(r"multiple lunch/break|confirm break_minutes", t):
        return "break_minutes_confirm"
    if re.search(r"incomplete sentence|incomplete|fragment", t):
        return "incomplete_fragments"
    if re.search(r"all day", t):
        return "all_day_unconfirmed"
    compact = re.sub(r"\s+", " ", t).strip()[:80]
    return f"warning:{compact}"


def is_resolvable_break_warning(text: Any) -> bool:
    key = warning_key(text)
    return key in ("contradictory_lunch", "break_minutes_confirm")


def is_non_critical_ack_warning(text: Any) -> bool:
    if is_resolvable_break_warning(text):
        return False
    return warning_key(text) in ("incomplete_fragments", "all_day_unconfirmed")


def find_warning_resolution(resolutions: list[dict[str, Any]] | None, warning_text: Any) -> dict[str, Any] | None:
    key = warning_key(warning_text)
    for row in resolutions or []:
        row_key = str(row.get("warning_key") or "").strip() or warning_key(row.get("warning_text"))
        if row_key == key:
            return row
    return None


def is_break_warning_resolved(resolutions: list[dict[str, Any]] | None, warning_text: Any) -> bool:
    row = find_warning_resolution(resolutions, warning_text)
    if not row or not row.get("resolved"):
        return False
    raw = row.get("break_minutes")
    if raw is None or raw == "":
        return False
    try:
        minutes = float(raw)
    except (TypeError, ValueError):
        return False
    return minutes >= 0


def compute_labour_entry(entry: dict[str, Any], *, max_shift_hours: float = MAX_SHIFT_HOURS) -> dict[str, Any]:
    errors: list[str] = []
    warnings: list[str] = []
    start = parse_time_to_minutes(entry.get("start_time"))
    finish = parse_time_to_minutes(entry.get("finish_time"))
    try:
        break_minutes = float(entry.get("break_minutes") or 0)
    except (TypeError, ValueError):
        errors.append("Break minutes must be a number.")
        break_minutes = 0.0
    try:
        travel_minutes = float(entry.get("travel_minutes") or 0)
    except (TypeError, ValueError):
        errors.append("travel_minutes must be a number.")
        travel_minutes = 0.0

    if break_minutes < 0:
        errors.append("Break minutes cannot be negative.")
    if travel_minutes < 0:
        errors.append("travel_minutes cannot be negative.")

    start_raw = str(entry.get("start_time") or "").strip()
    finish_raw = str(entry.get("finish_time") or "").strip()
    # Blank → required only. Non-empty invalid → format only. Never both for one field.
    if start is None:
        errors.append("Start time is required." if start_raw == "" else "Start time must use HH:MM.")
    if finish is None:
        errors.append("Finish time is required." if finish_raw == "" else "Finish time must use HH:MM.")

    travel_hours = round(max(0.0, travel_minutes) / 60.0, 2)
    if start is None or finish is None:
        return {
            "ok": False,
            "gross_minutes": None,
            "net_labour_minutes": None,
            "labour_hours": None,
            "travel_hours": travel_hours,
            "errors": unique_messages(errors),
            "warnings": unique_messages(warnings),
        }

    if finish <= start:
        errors.append("finish_time must be after start_time (overnight shifts are not supported).")
        return {
            "ok": False,
            "gross_minutes": None,
            "net_labour_minutes": None,
            "labour_hours": None,
            "travel_hours": travel_hours,
            "errors": unique_messages(errors),
            "warnings": unique_messages(warnings),
        }

    gross = finish - start
    if break_minutes > gross:
        errors.append("Break minutes cannot exceed gross shift duration.")
    net = max(0.0, gross - max(0.0, break_minutes))
    labour_hours = round(net / 60.0, 2)
    if gross / 60.0 > max_shift_hours:
        warnings.append(f"Shift exceeds {max_shift_hours} hours.")
    return {
        "ok": len(errors) == 0,
        "gross_minutes": int(gross),
        "net_labour_minutes": int(net),
        "labour_hours": labour_hours,
        "travel_hours": travel_hours,
        "errors": unique_messages(errors),
        "warnings": unique_messages(warnings),
    }


def compute_machinery_duration_hours(entry: dict[str, Any]) -> dict[str, Any]:
    errors: list[str] = []
    warnings: list[str] = []
    raw = entry.get("duration_hours")
    if raw not in (None, ""):
        try:
            hours = float(raw)
        except (TypeError, ValueError):
            return {
                "ok": False,
                "duration_hours": None,
                "errors": ["duration_hours must be a non-negative number."],
                "warnings": warnings,
            }
        if hours < 0:
            return {
                "ok": False,
                "duration_hours": None,
                "errors": ["duration_hours must be a non-negative number."],
                "warnings": warnings,
            }
        return {"ok": True, "duration_hours": round(hours, 2), "errors": errors, "warnings": warnings}

    start = parse_time_to_minutes(entry.get("start_time"))
    finish = parse_time_to_minutes(entry.get("finish_time"))
    if start is None or finish is None:
        warnings.append("Machinery duration incomplete (need duration_hours or start/finish).")
        return {"ok": True, "duration_hours": None, "errors": errors, "warnings": warnings}
    if finish <= start:
        errors.append("Machinery finish_time must be after start_time.")
        return {"ok": False, "duration_hours": None, "errors": errors, "warnings": warnings}
    return {
        "ok": True,
        "duration_hours": round((finish - start) / 60.0, 2),
        "errors": errors,
        "warnings": warnings,
    }


def compute_completion_totals(
    labour_entries: list[dict[str, Any]] | None,
    machinery_entries: list[dict[str, Any]] | None,
) -> dict[str, Any]:
    total_labour_minutes = 0
    total_travel_minutes = 0.0
    billable_labour_minutes = 0
    non_billable_labour_minutes = 0
    total_machinery_hours = 0.0
    errors: list[str] = []
    warnings: list[str] = []

    for idx, row in enumerate(labour_entries or []):
        if is_excluded(row):
            continue
        calc = compute_labour_entry(row)
        errors.extend(f"labour[{idx}]: {e}" for e in calc["errors"])
        warnings.extend(f"labour[{idx}]: {w}" for w in calc["warnings"])
        if calc["net_labour_minutes"] is None:
            continue
        total_labour_minutes += int(calc["net_labour_minutes"])
        travel = float(row.get("travel_minutes") or 0)
        if travel > 0:
            total_travel_minutes += travel
        if row.get("billable") in (True, "TRUE", "true"):
            billable_labour_minutes += int(calc["net_labour_minutes"])
        else:
            non_billable_labour_minutes += int(calc["net_labour_minutes"])

    for idx, row in enumerate(machinery_entries or []):
        if is_excluded(row):
            continue
        calc = compute_machinery_duration_hours(row)
        errors.extend(f"machinery[{idx}]: {e}" for e in calc["errors"])
        warnings.extend(f"machinery[{idx}]: {w}" for w in calc["warnings"])
        if calc["duration_hours"] is not None:
            total_machinery_hours += float(calc["duration_hours"])

    def hours(minutes: float) -> float:
        return round(minutes / 60.0, 2)

    return {
        "ok": len(errors) == 0,
        "total_labour_hours": hours(total_labour_minutes),
        "total_travel_hours": hours(total_travel_minutes),
        "total_machinery_hours": round(total_machinery_hours, 2),
        "billable_labour_hours": hours(billable_labour_minutes),
        "non_billable_labour_hours": hours(non_billable_labour_minutes),
        "errors": unique_messages(errors),
        "warnings": unique_messages(warnings),
    }


def source_warnings(job: dict[str, Any]) -> list[str]:
    warnings: list[str] = []
    transcript = str(job.get("ai_transcript") or "")
    review_items = str(job.get("manager_review_items") or "")
    summary = str(job.get("ai_summary") or "")
    blob = f"{transcript}\n{review_items}\n{summary}".lower()
    lunch_mentions = len(re.findall(r"lunch", blob))
    if lunch_mentions >= 2:
        has_no = bool(re.search(r"no\s+lunch|didn't\s+have\s+lunch|did\s+not\s+have\s+lunch|skipped\s+lunch", blob))
        has_had = bool(re.search(r"had\s+(a\s+)?lunch|took\s+(a\s+)?lunch|lunch\s+break", blob))
        if has_no and has_had:
            warnings.append("Contradictory lunch information in source text — confirm unpaid break manually.")
        elif lunch_mentions >= 2 and "break" in blob:
            warnings.append("Multiple lunch/break references — confirm break_minutes manually.")
    if re.search(r"incomplete|fragment|unclear|\[cut\]|\.\.\.", review_items, re.I) or re.search(
        r"incomplete sentence", blob, re.I
    ):
        warnings.append("Incomplete sentence fragments flagged in manager review items.")
    if re.search(r"\ball\s+day\b", blob, re.I) and not re.search(r"\d{1,2}:\d{2}", blob):
        warnings.append('"All day" mentioned without confirmed clock times — do not invent duration.')
    return unique_messages(warnings)


def build_completion_draft_from_job(job: dict[str, Any], *, staff_name: str = "") -> dict[str, Any]:
    warnings = source_warnings(job)
    staff_id = str(job.get("assigned_staff_id") or job.get("staff_id") or "").strip()
    work_date = str(job.get("job_date") or job.get("date") or "").strip()[:10]
    summary = str(job.get("ai_summary") or "").strip()
    variations_raw = str(job.get("variations") or "").strip()
    travel_raw = str(job.get("travel_time") or "").strip()

    labour_entries: list[dict[str, Any]] = []
    if staff_id or staff_name or summary:
        labour_entries.append(
            {
                "staff_name": staff_name.strip(),
                "staff_id": staff_id,
                "work_date": work_date,
                "start_time": "",
                "finish_time": "",
                "break_minutes": 0,
                "labour_hours": None,
                "travel_minutes": 0,
                "travel_hours": 0,
                "role_or_activity": "",
                "billable": False,
                "confirmation_status": ROW_SUGGESTED,
                "notes": "",
                "source": "ai_draft",
                "confidence": 0.4 if staff_id else 0.2,
            }
        )
        warnings.append("Labour times are unconfirmed — enter start/finish and break before finalising.")

    if travel_raw:
        warnings.append(
            f"Job travel_time text present ('{travel_raw[:80]}') — enter travel_minutes explicitly; do not assume billable."
        )

    blob = "\n".join(
        [
            summary,
            str(job.get("client_requests") or ""),
            variations_raw,
            str(job.get("ai_transcript") or ""),
        ]
    )
    machinery_entries: list[dict[str, Any]] = []
    material_entries: list[dict[str, Any]] = []

    tree_match = re.search(r"(\d+|seven|six|five|four|three|two|one)\s+trees?\b", blob, re.I)
    if tree_match:
        word_map = {"one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6, "seven": 7}
        raw_qty = tree_match.group(1).lower()
        qty = word_map.get(raw_qty)
        if qty is None:
            try:
                qty = int(raw_qty)
            except ValueError:
                qty = None
        if qty and qty > 0:
            material_entries.append(
                {
                    "item_name": "Trees (supply and planting)",
                    "quantity": float(qty),
                    "unit": "each",
                    "billable": False,
                    "confirmation_status": ROW_SUGGESTED,
                    "notes": "Suggested from approved job text — confirm before finalising.",
                    "source": "ai_draft",
                    "confidence": 0.55,
                }
            )

    if re.search(r"earthworks|driveway|reshape|excavator|bobcat|skid\s*steer", blob, re.I):
        if re.search(r"excavator", blob, re.I):
            name = "Excavator"
        elif re.search(r"bobcat|skid\s*steer", blob, re.I):
            name = "Skid steer"
        else:
            name = "Earthmoving equipment"
        machinery_entries.append(
            {
                "equipment_name": name,
                "operator_staff_id": staff_id,
                "start_time": "",
                "finish_time": "",
                "duration_hours": None,
                "billable": False,
                "charge_code": "",
                "confirmation_status": ROW_SUGGESTED,
                "notes": "Suggested from approved job text — confirm duration and billable flag.",
                "source": "ai_draft",
                "confidence": 0.45,
            }
        )

    variations = [line.strip() for line in variations_raw.splitlines() if line.strip()] if variations_raw else []
    invoice = re.sub(r"\s+", " ", summary).strip()
    if len(invoice) > 280:
        invoice = invoice[:277] + "..."

    return {
        "work_summary": summary,
        "invoice_description": invoice,
        "internal_notes": "",
        "labour_entries": labour_entries,
        "machinery_entries": machinery_entries,
        "material_entries": material_entries,
        "variations": variations,
        "warnings": unique_messages(warnings),
        "warning_resolutions": [],
        "overall_confidence": 0.5 if material_entries or machinery_entries else 0.35,
    }


def validate_for_finalise(
    completion: dict[str, Any],
    job: dict[str, Any],
    *,
    override_reason: str = "",
    warning_resolutions: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    critical: list[str] = []
    non_critical: list[str] = []
    resolutions = (
        warning_resolutions
        if warning_resolutions is not None
        else list(completion.get("warning_resolutions") or [])
    )

    if str(job.get("approval_status") or "").strip() != "Approved":
        critical.append("Job approval_status must be Approved to finalise.")
    if str(job.get("processing_status") or "").strip() != "Completed":
        critical.append("Job processing_status must be Completed to finalise.")
    if str(completion.get("completion_status") or "").strip() == STATUS_FINALISED:
        critical.append("Completion is already Finalised.")
    if not str(completion.get("work_summary") or "").strip():
        critical.append("work_summary is required.")
    if not str(completion.get("invoice_description") or "").strip():
        critical.append("invoice_description is required.")

    labour = list(completion.get("labour_entries") or [])
    machinery = list(completion.get("machinery_entries") or [])
    materials = list(completion.get("material_entries") or [])

    for idx, row in enumerate(labour):
        if is_excluded(row):
            continue
        if is_suggested(row):
            critical.append(f"labour[{idx}] is still Suggested — confirm or exclude before finalising.")
        calc = compute_labour_entry(row)
        # One message per field/rule — do not add a second combined required error.
        critical.extend(f"labour[{idx}]: {e}" for e in calc["errors"])
        non_critical.extend(f"labour[{idx}]: {w}" for w in calc["warnings"])

    for idx, row in enumerate(machinery):
        if is_excluded(row):
            continue
        if is_suggested(row):
            critical.append(f"machinery[{idx}] is still Suggested — confirm or exclude before finalising.")
        calc = compute_machinery_duration_hours(row)
        critical.extend(f"machinery[{idx}]: {e}" for e in calc["errors"])

    for idx, row in enumerate(materials):
        if is_excluded(row):
            continue
        if is_suggested(row):
            critical.append(f"material[{idx}] is still Suggested — confirm or exclude before finalising.")
        if not str(row.get("item_name") or "").strip():
            critical.append(f"material[{idx}]: item_name is required.")

    # Totals for derived hours only — do not re-merge the same labour field errors.
    totals = compute_completion_totals(labour, machinery)

    existing_warnings = [str(w or "").strip() for w in (completion.get("warnings") or []) if str(w or "").strip()]
    non_critical.extend(existing_warnings)

    unresolved_break = [
        text
        for text in existing_warnings
        if is_resolvable_break_warning(text) and not is_break_warning_resolved(resolutions, text)
    ]
    if unresolved_break:
        critical.append(
            "Resolve lunch/break contradiction by confirming break minutes: " + "; ".join(unresolved_break)
        )

    needs_ack = [text for text in existing_warnings if is_non_critical_ack_warning(text)]
    if needs_ack and not str(override_reason or "").strip():
        critical.append("Unresolved non-critical warnings require override_reason: " + "; ".join(needs_ack))

    critical = unique_messages(critical)
    return {
        "ok": len(critical) == 0,
        "critical_errors": critical,
        "non_critical_warnings": unique_messages(non_critical),
        "totals": totals,
    }
