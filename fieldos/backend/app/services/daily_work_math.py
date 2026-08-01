"""Pure helpers for Daily Work Job Sheet (daily_work_dictation).

Completed-work extraction — separate from new_job_dictation (future work).
"""

from __future__ import annotations

import hashlib
import json
import re
from datetime import date, datetime
from typing import Any, Optional
from zoneinfo import ZoneInfo

FIELDOS_TIMEZONE = "Australia/Sydney"
PROCESSING_TYPE = "daily_work_dictation"

STATUS_RECORDING = "Recording"
STATUS_PROCESSING = "Processing"
STATUS_REVIEW_REQUIRED = "ReviewRequired"
STATUS_JOB_CREATED = "JobCreated"
STATUS_TRANSCRIPTION_FAILED = "TranscriptionFailed"
STATUS_EXTRACTION_FAILED = "ExtractionFailed"
STATUS_CREATE_FAILED = "CreateFailed"

REC_SAVED = "Saved"
REC_PROCESSING = "Processing"
REC_PROCESSED = "Processed"
REC_FAILED = "Failed"

SOURCE_BROWSER = "browser_recording"
SOURCE_UPLOAD = "uploaded_file"

DEFAULT_MAX_RECORDINGS = 40


def sydney_today(now: Optional[datetime] = None) -> date:
    tz = ZoneInfo(FIELDOS_TIMEZONE)
    current = now.astimezone(tz) if now else datetime.now(tz)
    return current.date()


def trim_text(value: Any) -> str:
    return str(value or "").strip()


def empty_job_sheet() -> dict[str, Any]:
    return {
        "customer_name": "",
        "project_name": "",
        "project_id": "",
        "work_date": "",
        "staff_ids": [],
        "staff_names": [],
        "work_completed": [],
        "materials_used": [],
        "equipment_used": [],
        "hours_or_times": [],
        "site_conditions": [],
        "issues_found": [],
        "client_requests": [],
        "follow_up_required": [],
        "safety_notes": [],
        "manager_notes": "",
        "completion_summary": "",
        "site_address": "",
    }


def empty_extraction(work_session_id: str = "", work_date: str = "") -> dict[str, Any]:
    return {
        "work_session_id": work_session_id,
        "work_date": work_date,
        "aggregated_transcript": "",
        "recordings": [],
        "job_sheet": empty_job_sheet(),
        "confidence": {},
        "warnings": [],
        "unresolved": [],
        "source_map": {},
        "provider": "",
        "model": "",
    }


def _as_item_list(raw: Any) -> list[dict[str, Any]]:
    """Normalise list entries to {text, recording_ids}."""
    out: list[dict[str, Any]] = []
    if not isinstance(raw, list):
        return out
    for item in raw:
        if isinstance(item, str):
            text = trim_text(item)
            if text:
                out.append({"text": text, "recording_ids": []})
        elif isinstance(item, dict):
            text = trim_text(item.get("text") or item.get("item") or "")
            if not text:
                continue
            ids = item.get("recording_ids") or item.get("sources") or []
            if isinstance(ids, str):
                ids = [ids] if trim_text(ids) else []
            clean_ids = [trim_text(x) for x in ids if trim_text(x)]
            out.append({"text": text, "recording_ids": clean_ids})
    return out


def coerce_extraction(payload: Any, *, work_session_id: str = "", work_date: str = "") -> dict[str, Any]:
    base = empty_extraction(work_session_id, work_date)
    if not isinstance(payload, dict):
        base["warnings"].append("Extraction payload was not an object.")
        return base

    base["work_session_id"] = trim_text(payload.get("work_session_id")) or work_session_id
    base["work_date"] = trim_text(payload.get("work_date")) or work_date
    base["aggregated_transcript"] = trim_text(payload.get("aggregated_transcript"))
    base["provider"] = trim_text(payload.get("provider"))
    base["model"] = trim_text(payload.get("model"))

    recs = []
    for row in payload.get("recordings") or []:
        if not isinstance(row, dict):
            continue
        recs.append(
            {
                "recording_id": trim_text(row.get("recording_id")),
                "recorded_at": trim_text(row.get("recorded_at")),
                "transcript": trim_text(row.get("transcript")),
            }
        )
    base["recordings"] = recs

    job_in = payload.get("job_sheet") if isinstance(payload.get("job_sheet"), dict) else {}
    job = empty_job_sheet()
    for key in (
        "customer_name",
        "project_name",
        "project_id",
        "work_date",
        "manager_notes",
        "completion_summary",
        "site_address",
    ):
        if key in job_in:
            job[key] = trim_text(job_in.get(key))
    for key in ("staff_ids", "staff_names"):
        raw = job_in.get(key)
        if isinstance(raw, list):
            job[key] = [trim_text(x) for x in raw if trim_text(x)]
        elif isinstance(raw, str) and trim_text(raw):
            job[key] = [trim_text(raw)]
    for key in (
        "work_completed",
        "materials_used",
        "equipment_used",
        "hours_or_times",
        "site_conditions",
        "issues_found",
        "client_requests",
        "follow_up_required",
        "safety_notes",
    ):
        job[key] = _as_item_list(job_in.get(key))
    if not job["work_date"]:
        job["work_date"] = base["work_date"]
    base["job_sheet"] = job

    conf = payload.get("confidence") if isinstance(payload.get("confidence"), dict) else {}
    clean_conf = {}
    for k, v in conf.items():
        try:
            clean_conf[str(k)] = max(0.0, min(1.0, float(v)))
        except (TypeError, ValueError):
            clean_conf[str(k)] = 0.0
    base["confidence"] = clean_conf

    for key in ("warnings", "unresolved"):
        raw = payload.get(key)
        items = []
        if isinstance(raw, list):
            for item in raw:
                t = trim_text(item)
                if t:
                    items.append(t)
        base[key] = items

    sm = payload.get("source_map")
    base["source_map"] = sm if isinstance(sm, dict) else {}
    return base


def sort_recordings(recordings: list[dict[str, Any]]) -> list[dict[str, Any]]:
    def key(r: dict[str, Any]):
        recorded = trim_text(r.get("recorded_at") or r.get("created_at"))
        seq = int(r.get("sequence") or 0)
        created = trim_text(r.get("created_at"))
        return (recorded or "9999", seq, created or "9999", trim_text(r.get("recording_id")))

    return sorted(list(recordings or []), key=key)


def format_recording_label(recording: dict[str, Any], index: int) -> str:
    """[HH:MM — Recording N] using Australia/Sydney clock when possible."""
    raw = trim_text(recording.get("recorded_at") or recording.get("created_at"))
    clock = ""
    if raw:
        try:
            dt = datetime.fromisoformat(raw.replace("Z", "+00:00"))
            local = dt.astimezone(ZoneInfo(FIELDOS_TIMEZONE))
            clock = local.strftime("%H:%M")
        except ValueError:
            clock = ""
    if not clock:
        clock = f"#{index}"
    return f"[{clock} — Recording {index}]"


def aggregate_transcripts(recordings: list[dict[str, Any]]) -> str:
    """Aggregate with source markers; never merge unmarked text."""
    ordered = sort_recordings(recordings)
    parts = []
    n = 0
    for rec in ordered:
        text = trim_text(rec.get("transcript"))
        if not text:
            continue
        n += 1
        label = format_recording_label(rec, n)
        parts.append(f"{label}\n{text}")
    return "\n\n".join(parts)


def format_manager_notes(job: dict[str, Any]) -> str:
    """Deterministic completed-work report for tbl_job_sheets.manager_notes."""

    def bullets(items: list[Any]) -> list[str]:
        lines = []
        for item in items or []:
            if isinstance(item, dict):
                text = trim_text(item.get("text"))
            else:
                text = trim_text(item)
            if text:
                lines.append(f"- {text}")
        return lines

    sections = [
        ("WORK COMPLETED", bullets(job.get("work_completed"))),
        ("MATERIALS USED", bullets(job.get("materials_used"))),
        ("EQUIPMENT USED", bullets(job.get("equipment_used"))),
        ("HOURS / TIMES", bullets(job.get("hours_or_times"))),
        ("SITE CONDITIONS", bullets(job.get("site_conditions"))),
        ("ISSUES FOUND", bullets(job.get("issues_found"))),
        ("CLIENT REQUESTS", bullets(job.get("client_requests"))),
        ("FOLLOW-UP REQUIRED", bullets(job.get("follow_up_required"))),
        ("SAFETY / SITE NOTES", bullets(job.get("safety_notes"))),
    ]
    blocks = []
    for title, lines in sections:
        if not lines:
            continue
        blocks.append(title + "\n" + "\n".join(lines))
    summary = trim_text(job.get("completion_summary"))
    if summary:
        blocks.append("SUMMARY\n" + summary)
    extra = trim_text(job.get("manager_notes"))
    if extra and not extra.startswith("WORK COMPLETED"):
        blocks.append("MANAGER NOTES\n" + extra)
    return "\n\n".join(blocks).strip()


def build_sheet_job_fields(reviewed: dict[str, Any], *, actor_staff_id: str) -> dict[str, Any]:
    staff_ids = [trim_text(x) for x in (reviewed.get("staff_ids") or []) if trim_text(x)]
    staff_id = staff_ids[0] if staff_ids else trim_text(actor_staff_id)
    project = trim_text(reviewed.get("project_id")) or trim_text(reviewed.get("project_name"))
    work_date = trim_text(reviewed.get("work_date"))
    notes = format_manager_notes(reviewed)
    return {
        "staff_id": staff_id,
        "date": work_date,
        "project_id": project,
        "manager_notes": notes,
        "processing_status": "Completed",
        "processing_error": "",
        "approval_status": "Pending Review",
    }


def validate_reviewed_job_sheet(job: dict[str, Any]) -> tuple[bool, str]:
    if not isinstance(job, dict):
        return False, "reviewed_job_sheet is required."
    if not (trim_text(job.get("customer_name")) or trim_text(job.get("project_id")) or trim_text(job.get("project_name"))):
        return False, "customer or project is required."
    if not (trim_text(job.get("project_id")) or trim_text(job.get("project_name"))):
        return False, "project is required."
    work_date = trim_text(job.get("work_date"))
    if not work_date or not re.match(r"^\d{4}-\d{2}-\d{2}$", work_date):
        return False, "work_date must be YYYY-MM-DD."
    staff_ids = job.get("staff_ids") or []
    staff_names = job.get("staff_names") or []
    if not staff_ids and not staff_names:
        return False, "at least one staff member is required."
    completed = job.get("work_completed") or []
    summary = trim_text(job.get("completion_summary"))
    if not completed and not summary:
        return False, "work_completed or completion_summary is required."
    return True, ""


def payload_hash(job: dict[str, Any], work_session_id: str) -> str:
    canonical = {"work_session_id": trim_text(work_session_id), "job": job}
    blob = json.dumps(canonical, sort_keys=True, separators=(",", ":"), default=str)
    return hashlib.sha256(blob.encode("utf-8")).hexdigest()


def move_item(
    job: dict[str, Any],
    *,
    from_field: str,
    to_field: str,
    index: int,
) -> dict[str, Any]:
    """Move a list item between work_completed and follow_up_required (pure)."""
    out = json.loads(json.dumps(job))
    src = list(out.get(from_field) or [])
    if index < 0 or index >= len(src):
        return out
    item = src.pop(index)
    dst = list(out.get(to_field) or [])
    dst.append(item)
    out[from_field] = src
    out[to_field] = dst
    return out


DAILY_WORK_EXTRACTION_SYSTEM_PROMPT = (
    "You extract a completed daily work job sheet from field voice transcripts "
    "for Native Grace landscaping (Australia). Return JSON only with keys: "
    "work_session_id, work_date, aggregated_transcript, recordings "
    "(array of {recording_id, recorded_at, transcript}), "
    "job_sheet (object with customer_name, project_name, project_id, work_date, "
    "staff_ids, staff_names, work_completed, materials_used, equipment_used, "
    "hours_or_times, site_conditions, issues_found, client_requests, "
    "follow_up_required, safety_notes, manager_notes, completion_summary, site_address), "
    "confidence (object of 0-1 scores), warnings (string array), unresolved (string array), "
    "source_map (object). "
    "List fields must be arrays of objects {text, recording_ids}. "
    "Rules: Describe COMPLETED past-tense work only. Future/needed work goes in "
    "follow_up_required. Client asks go in client_requests (and follow_up if action needed). "
    "Do not invent work, materials, quantities, staff, hours, project, customer, or safety events. "
    "If recordings contradict, keep both statements and add a warning. "
    "Attribute each item via recording_ids. Never fabricate recording_ids."
)
