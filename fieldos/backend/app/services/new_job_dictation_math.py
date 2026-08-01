"""Pure helpers for Create Job from Recording (new_job_dictation).

No I/O. Australia/Sydney date resolution. Master-data matching never silently
selects fuzzy hits.
"""

from __future__ import annotations

import hashlib
import json
import re
import unicodedata
from datetime import date, datetime, timedelta, timezone
from typing import Any, Optional
from zoneinfo import ZoneInfo

FIELDOS_TIMEZONE = "Australia/Sydney"
NEW_JOB_DICTATION_SOURCE = "new_job_recording"
SOURCE_UPLOADED_FILE = "uploaded_file"
SOURCE_BROWSER_RECORDING = "browser_recording"
ALLOWED_UPLOAD_SOURCES = frozenset({SOURCE_UPLOADED_FILE, SOURCE_BROWSER_RECORDING, NEW_JOB_DICTATION_SOURCE})

STATUS_UPLOADED = "Uploaded"
STATUS_PROCESSING = "Processing"
STATUS_REVIEW_REQUIRED = "ReviewRequired"
STATUS_JOB_CREATED = "JobCreated"
STATUS_TRANSCRIPTION_FAILED = "TranscriptionFailed"
STATUS_EXTRACTION_FAILED = "ExtractionFailed"
STATUS_CREATE_FAILED = "CreateFailed"

MATCH_MATCHED = "Matched"
MATCH_POSSIBLE = "Possible match"
MATCH_NEW = "New value"
MATCH_UNRESOLVED = "Unresolved"

JOB_EXTRACTION_KEYS = (
    "customer_name",
    "project_name",
    "job_title",
    "job_description",
    "scheduled_date",
    "scheduled_time",
    "assigned_staff_names",
    "site_address",
    "contact_name",
    "contact_phone",
    "priority",
    "status",
    "notes",
)

CONFIDENCE_KEYS = (
    "customer_name",
    "project_name",
    "scheduled_date",
    "assigned_staff_names",
    "site_address",
)

EMPTY_JOB_FIELDS = {
    "customer_name": "",
    "project_name": "",
    "job_title": "",
    "job_description": "",
    "scheduled_date": "",
    "scheduled_time": "",
    "assigned_staff_names": [],
    "site_address": "",
    "contact_name": "",
    "contact_phone": "",
    "priority": "",
    "status": "Scheduled",
    "notes": "",
}


def sydney_today(now: Optional[datetime] = None) -> date:
    tz = ZoneInfo(FIELDOS_TIMEZONE)
    current = now.astimezone(tz) if now else datetime.now(tz)
    return current.date()


def normalise_text(value: Any) -> str:
    text = str(value or "").strip().lower()
    text = unicodedata.normalize("NFKD", text)
    text = "".join(ch for ch in text if not unicodedata.combining(ch))
    text = re.sub(r"[^a-z0-9\s]+", " ", text)
    return re.sub(r"\s+", " ", text).strip()


def trim_text(value: Any) -> str:
    return str(value or "").strip()


def empty_extraction() -> dict[str, Any]:
    return {
        "transcript": "",
        "job": dict(EMPTY_JOB_FIELDS),
        "confidence": {k: 0.0 for k in CONFIDENCE_KEYS},
        "warnings": [],
        "unresolved": [],
        "relative_date_phrases": [],
        "model": "",
        "provider": "",
    }


def coerce_extraction(payload: Any) -> dict[str, Any]:
    """Parse model JSON into the fixed extraction schema. Never invent fields."""
    base = empty_extraction()
    if not isinstance(payload, dict):
        base["warnings"].append("Extraction payload was not an object.")
        return base

    base["transcript"] = trim_text(payload.get("transcript"))
    job_in = payload.get("job") if isinstance(payload.get("job"), dict) else {}
    job_out = dict(EMPTY_JOB_FIELDS)
    for key in JOB_EXTRACTION_KEYS:
        if key not in job_in:
            continue
        if key == "assigned_staff_names":
            raw = job_in.get(key)
            names: list[str] = []
            if isinstance(raw, list):
                for item in raw:
                    name = trim_text(item)
                    if name:
                        names.append(name)
            elif isinstance(raw, str) and trim_text(raw):
                names = [trim_text(raw)]
            job_out[key] = names
        else:
            job_out[key] = trim_text(job_in.get(key))
    if not job_out["status"]:
        job_out["status"] = "Scheduled"
    base["job"] = job_out

    conf_in = payload.get("confidence") if isinstance(payload.get("confidence"), dict) else {}
    for key in CONFIDENCE_KEYS:
        try:
            score = float(conf_in.get(key, 0) or 0)
        except (TypeError, ValueError):
            score = 0.0
        base["confidence"][key] = max(0.0, min(1.0, score))

    for key in ("warnings", "unresolved"):
        raw = payload.get(key)
        items: list[str] = []
        if isinstance(raw, list):
            for item in raw:
                text = trim_text(item)
                if text:
                    items.append(text)
        base[key] = items

    base["model"] = trim_text(payload.get("model"))
    base["provider"] = trim_text(payload.get("provider"))
    return base


_WEEKDAYS = {
    "monday": 0,
    "tuesday": 1,
    "wednesday": 2,
    "thursday": 3,
    "friday": 4,
    "saturday": 5,
    "sunday": 6,
}


def _next_weekday(anchor: date, weekday: int, *, week_offset: int = 0) -> date:
    days_ahead = (weekday - anchor.weekday() + 7) % 7
    if days_ahead == 0:
        days_ahead = 7
    days_ahead += 7 * week_offset
    return anchor + timedelta(days=days_ahead)


def resolve_relative_date_phrase(
    phrase: str,
    *,
    anchor: Optional[date] = None,
    now: Optional[datetime] = None,
) -> dict[str, Any]:
    """Resolve a relative date phrase against Australia/Sydney calendar.

    Returns {phrase, resolved_date, resolved_time, note} or unresolved.
    Does not invent dates for ambiguous phrases.
    """
    original = trim_text(phrase)
    text = normalise_text(original)
    day = anchor or sydney_today(now)
    if not text:
        return {
            "phrase": original,
            "resolved_date": "",
            "resolved_time": "",
            "note": "empty phrase",
            "resolved": False,
        }

    if text in {"today"}:
        return {
            "phrase": original,
            "resolved_date": day.isoformat(),
            "resolved_time": "",
            "note": "today",
            "resolved": True,
        }
    if text in {"tomorrow"}:
        resolved = day + timedelta(days=1)
        return {
            "phrase": original,
            "resolved_date": resolved.isoformat(),
            "resolved_time": "",
            "note": "tomorrow",
            "resolved": True,
        }
    if text in {"this afternoon", "this evening"}:
        return {
            "phrase": original,
            "resolved_date": day.isoformat(),
            "resolved_time": "15:00" if "afternoon" in text else "18:00",
            "note": text,
            "resolved": True,
        }

    m = re.match(r"^(next|this)\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)$", text)
    if m:
        kind, name = m.group(1), m.group(2)
        weekday = _WEEKDAYS[name]
        if kind == "this":
            days_ahead = (weekday - day.weekday()) % 7
            resolved = day + timedelta(days=days_ahead)
        else:
            # Strictly the next occurrence after today.
            resolved = _next_weekday(day, weekday, week_offset=0)
        return {
            "phrase": original,
            "resolved_date": resolved.isoformat(),
            "resolved_time": "",
            "note": f"{kind} {name}",
            "resolved": True,
        }

    # ISO date already absolute
    if re.match(r"^\d{4}-\d{2}-\d{2}$", text):
        return {
            "phrase": original,
            "resolved_date": text,
            "resolved_time": "",
            "note": "absolute",
            "resolved": True,
        }

    return {
        "phrase": original,
        "resolved_date": "",
        "resolved_time": "",
        "note": "unresolved relative phrase",
        "resolved": False,
    }


def apply_relative_dates_to_extraction(
    extraction: dict[str, Any],
    *,
    recording_created_at: Optional[str] = None,
) -> dict[str, Any]:
    """Fill scheduled_date from relative phrases when model left date blank or relative."""
    out = json.loads(json.dumps(extraction))
    anchor = sydney_today()
    if recording_created_at:
        try:
            parsed = datetime.fromisoformat(str(recording_created_at).replace("Z", "+00:00"))
            anchor = sydney_today(parsed)
        except ValueError:
            pass

    job = out.get("job") or {}
    scheduled = trim_text(job.get("scheduled_date"))
    phrases = list(out.get("relative_date_phrases") or [])
    candidates = phrases[:]
    if scheduled and not re.match(r"^\d{4}-\d{2}-\d{2}$", scheduled):
        candidates.append(scheduled)

    resolved_rows = []
    for phrase in candidates:
        row = resolve_relative_date_phrase(phrase, anchor=anchor)
        resolved_rows.append(row)
        if row["resolved"] and row["resolved_date"]:
            job["scheduled_date"] = row["resolved_date"]
            if row.get("resolved_time") and not trim_text(job.get("scheduled_time")):
                job["scheduled_time"] = row["resolved_time"]
            break
    out["job"] = job
    out["relative_date_phrases"] = resolved_rows
    if resolved_rows and not any(r.get("resolved") for r in resolved_rows):
        out.setdefault("unresolved", []).append("Could not resolve scheduled date phrase.")
    return out


def match_master(
    value: str,
    masters: list[dict[str, Any]],
    *,
    id_key: str,
    name_key: str,
) -> dict[str, Any]:
    """Exact → normalised. Fuzzy only as possible_matches — never auto-select."""
    raw = trim_text(value)
    if not raw:
        return {
            "input": raw,
            "status": MATCH_UNRESOLVED,
            "matched_id": "",
            "matched_name": "",
            "possible_matches": [],
        }

    exact_id = None
    exact_name = None
    normalised_hits: list[dict[str, str]] = []
    fuzzy: list[dict[str, str]] = []
    needle = normalise_text(raw)

    for row in masters or []:
        rid = trim_text(row.get(id_key))
        name = trim_text(row.get(name_key) or row.get("name"))
        if not rid and not name:
            continue
        if raw == rid or raw == name:
            exact_id = rid
            exact_name = name
            break
        if needle and needle == normalise_text(name):
            normalised_hits.append({"id": rid, "name": name})
        elif needle and name and (needle in normalise_text(name) or normalise_text(name) in needle):
            fuzzy.append({"id": rid, "name": name})

    if exact_id or exact_name:
        return {
            "input": raw,
            "status": MATCH_MATCHED,
            "matched_id": exact_id or "",
            "matched_name": exact_name or "",
            "possible_matches": [],
        }
    if len(normalised_hits) == 1:
        hit = normalised_hits[0]
        return {
            "input": raw,
            "status": MATCH_MATCHED,
            "matched_id": hit["id"],
            "matched_name": hit["name"],
            "possible_matches": [],
        }
    if normalised_hits or fuzzy:
        possibles = normalised_hits + [f for f in fuzzy if f not in normalised_hits]
        return {
            "input": raw,
            "status": MATCH_POSSIBLE,
            "matched_id": "",
            "matched_name": "",
            "possible_matches": possibles[:5],
        }
    return {
        "input": raw,
        "status": MATCH_NEW,
        "matched_id": "",
        "matched_name": "",
        "possible_matches": [],
    }


def build_match_report(
    job: dict[str, Any],
    *,
    customers: list[dict[str, Any]],
    projects: list[dict[str, Any]],
    staff: list[dict[str, Any]],
) -> dict[str, Any]:
    customer = match_master(job.get("customer_name") or "", customers, id_key="customer_id", name_key="customer_name")
    project = match_master(job.get("project_name") or "", projects, id_key="project_id", name_key="project_name")
    staff_matches = [
        match_master(name, staff, id_key="staff_id", name_key="staff_name")
        for name in (job.get("assigned_staff_names") or [])
    ]
    return {
        "customer": customer,
        "project": project,
        "staff": staff_matches,
    }


def validate_reviewed_job(job: dict[str, Any]) -> tuple[bool, str]:
    if not isinstance(job, dict):
        return False, "job payload is required."
    customer_id = trim_text(job.get("customer_id"))
    customer_name = trim_text(job.get("customer_name"))
    project_id = trim_text(job.get("project_id"))
    project_name = trim_text(job.get("project_name"))
    if not (customer_id or customer_name):
        return False, "customer is required."
    if not (project_id or project_name):
        return False, "project is required."
    title = trim_text(job.get("job_title"))
    description = trim_text(job.get("job_description"))
    if not (title or description):
        return False, "job title or description is required."
    scheduled = trim_text(job.get("scheduled_date"))
    if not scheduled or not re.match(r"^\d{4}-\d{2}-\d{2}$", scheduled):
        return False, "scheduled_date must be YYYY-MM-DD."
    staff_ids = job.get("assigned_staff_ids") or []
    staff_names = job.get("assigned_staff_names") or []
    if not staff_ids and not staff_names:
        return False, "at least one assigned staff member is required."
    return True, ""


def payload_hash(job: dict[str, Any], recording_id: str) -> str:
    canonical = {
        "recording_id": trim_text(recording_id),
        "job": {
            k: job.get(k)
            for k in sorted(
                {
                    "customer_id",
                    "customer_name",
                    "project_id",
                    "project_name",
                    "job_title",
                    "job_description",
                    "scheduled_date",
                    "scheduled_time",
                    "assigned_staff_ids",
                    "assigned_staff_names",
                    "site_address",
                    "contact_name",
                    "contact_phone",
                    "priority",
                    "status",
                    "notes",
                }
            )
        },
    }
    blob = json.dumps(canonical, sort_keys=True, separators=(",", ":"), default=str)
    return hashlib.sha256(blob.encode("utf-8")).hexdigest()


def changed_fields(proposed: dict[str, Any], final: dict[str, Any]) -> list[dict[str, Any]]:
    keys = set(proposed or {}) | set(final or {})
    changes = []
    for key in sorted(keys):
        left = proposed.get(key) if isinstance(proposed, dict) else None
        right = final.get(key) if isinstance(final, dict) else None
        if json.dumps(left, sort_keys=True, default=str) != json.dumps(right, sort_keys=True, default=str):
            changes.append({"field": key, "from": left, "to": right})
    return changes


def build_sheet_job_fields(reviewed: dict[str, Any], *, created_by_staff_id: str) -> dict[str, Any]:
    """Map reviewed form → writable tbl_job_sheets fields only (no invented columns)."""
    staff_ids = [trim_text(x) for x in (reviewed.get("assigned_staff_ids") or []) if trim_text(x)]
    staff_id = staff_ids[0] if staff_ids else trim_text(created_by_staff_id)
    project_label = trim_text(reviewed.get("project_id")) or trim_text(reviewed.get("project_name"))
    title = trim_text(reviewed.get("job_title"))
    description = trim_text(reviewed.get("job_description"))
    notes = trim_text(reviewed.get("notes"))
    site = trim_text(reviewed.get("site_address"))
    contact = trim_text(reviewed.get("contact_name"))
    phone = trim_text(reviewed.get("contact_phone"))
    note_parts = []
    if title:
        note_parts.append(f"Title: {title}")
    if description:
        note_parts.append(description)
    if site:
        note_parts.append(f"Site: {site}")
    if contact or phone:
        note_parts.append(f"Contact: {contact} {phone}".strip())
    if notes:
        note_parts.append(notes)
    return {
        "staff_id": staff_id,
        "date": trim_text(reviewed.get("scheduled_date")),
        "project_id": project_label,
        "manager_notes": "\n".join(note_parts),
        "processing_status": "",
        "processing_error": "",
        "approval_status": "Pending Review",
    }


NEW_JOB_EXTRACTION_SYSTEM_PROMPT = (
    "You extract structured job-sheet details from a field voice dictation for "
    "Native Grace landscaping (Australia). Return a single JSON object only with keys: "
    "transcript (string — copy the provided transcript), "
    "job (object with customer_name, project_name, job_title, job_description, "
    "scheduled_date, scheduled_time, assigned_staff_names (array of strings), "
    "site_address, contact_name, contact_phone, priority, status, notes), "
    "confidence (object with customer_name, project_name, scheduled_date, "
    "assigned_staff_names, site_address as numbers 0-1), "
    "warnings (array of strings), unresolved (array of strings), "
    "relative_date_phrases (array of original relative date phrases found). "
    "Rules: Extract ONLY facts clearly stated. Do not invent customer, project, "
    "address, date, staff, or contact details. If unknown, use empty string, empty "
    "array, or confidence 0. status default Scheduled. scheduled_date may be a "
    "relative phrase (e.g. next Tuesday) if that is what was said."
)
