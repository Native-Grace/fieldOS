"""Phase 3G PDF delivery profiles, privacy allowlists, and delivery lifecycle helpers.

Pure functions only — no I/O, no email, no Drive. Mirrors Apps Script
DocumentDeliveryHelpers so mock and live modes stay aligned.
"""

from __future__ import annotations

import hashlib
import re
from typing import Any

from app.services.report_math import (
    REPORT_CLIENT_JOB_REPORT,
    REPORT_COMPLETION_REGISTER,
    REPORT_JOB_SHEET_SUMMARY,
    REPORT_STAFF_WORK_REPORT,
    TEMPLATE_VERSION as REPORT_TEMPLATE_VERSION,
    scrub_report_record,
)
from app.core.roles import is_manager_or_admin, normalize_role

# Re-export for callers that imported role helpers from delivery_math.
__all_role_helpers__ = (is_manager_or_admin, normalize_role)

DELIVERY_TEMPLATE_VERSION = "3G.1"

# --------------------------------------------------------------------------
# PDF profiles — each maps to a report type + field allowlist.
# --------------------------------------------------------------------------

PROFILE_INTERNAL_JOB_SHEET = "Internal Job Sheet"
PROFILE_CLIENT_JOB_SUMMARY = "Client Job Summary"
PROFILE_STAFF_WORK_RECORD = "Staff Work Record"
PROFILE_COMPLETION_REGISTER = "Completion Register"

PDF_PROFILES = (
    PROFILE_INTERNAL_JOB_SHEET,
    PROFILE_CLIENT_JOB_SUMMARY,
    PROFILE_STAFF_WORK_RECORD,
    PROFILE_COMPLETION_REGISTER,
)

PROFILE_TO_REPORT_TYPE = {
    PROFILE_INTERNAL_JOB_SHEET: REPORT_JOB_SHEET_SUMMARY,
    PROFILE_CLIENT_JOB_SUMMARY: REPORT_CLIENT_JOB_REPORT,
    PROFILE_STAFF_WORK_RECORD: REPORT_STAFF_WORK_REPORT,
    PROFILE_COMPLETION_REGISTER: REPORT_COMPLETION_REGISTER,
}

PROFILE_AUDIENCE = {
    PROFILE_INTERNAL_JOB_SHEET: "internal",
    PROFILE_CLIENT_JOB_SUMMARY: "client",
    PROFILE_STAFF_WORK_RECORD: "internal",
    PROFILE_COMPLETION_REGISTER: "internal",
}

# Fields permitted on a rendered / delivered client-facing payload.
CLIENT_ALLOWED_FIELDS = frozenset(
    {
        "report_type",
        "template_version",
        "generated_at",
        "date_from",
        "date_to",
        "filters",
        "groups",
        "bundles",
        "jobs",
        "job",
        "completion",
        "tasks",
        "task_lines",
        "labour",
        "labour_entries",
        "machinery",
        "machinery_entries",
        "materials",
        "material_entries",
        "totals",
        "record_count",
        "job_count",
        "line_count",
        "group_by",
        "audience",
        "include_internal_notes",
        "recording_count_only",
        "readiness",
    }
)

CLIENT_ALLOWED_JOB_FIELDS = frozenset(
    {
        "job_sheet_id",
        "job_date",
        "customer_name",
        "project_name",
        "approval_status",
        "processing_status",
    }
)

CLIENT_ALLOWED_COMPLETION_FIELDS = frozenset(
    {
        "completion_id",
        "completion_status",
        "work_summary",
        "invoice_description",
        "variations",
        "finalised_by",
        "finalised_at",
        "version",
    }
)

# Explicit denylist — never appear on a client profile even if nested.
CLIENT_FORBIDDEN_FIELDS = frozenset(
    {
        "internal_notes",
        "warnings",
        "warning_resolutions",
        "warning_count",
        "payroll",
        "payroll_mapping",
        "payroll_code",
        "cost",
        "cost_rate",
        "sell_rate",
        "unit_cost",
        "amount",
        "price",
        "xero",
        "xero_mapping",
        "ai_transcript",
        "transcript",
        "manager_review_items",
        "drive_file_id",
        "recording_drive_file_id",
        "storage_ref",
        "webhook_secret",
        "token",
        "mapping",
        "mappings",
        "notes",  # labour/machinery internal notes stripped for client
    }
)

INTERNAL_EXTRA_FIELDS = frozenset(
    {
        "internal_notes",
        "warnings",
        "warning_resolutions",
        "readiness",
        "assigned_staff_id",
        "confirmation_status",
        "billable",
        "notes",
        "charge_code",
        "operator_staff_id",
    }
)

# --------------------------------------------------------------------------
# Delivery lifecycle
# --------------------------------------------------------------------------

STATUS_DRAFT = "Draft"
STATUS_READY = "Ready"
STATUS_SENT = "Sent"
STATUS_FAILED = "Failed"
STATUS_CANCELLED = "Cancelled"
STATUS_SUPERSEDED = "Superseded"

DELIVERY_STATUSES = (
    STATUS_DRAFT,
    STATUS_READY,
    STATUS_SENT,
    STATUS_FAILED,
    STATUS_CANCELLED,
    STATUS_SUPERSEDED,
)

RECIPIENT_CLIENT = "client"
RECIPIENT_INTERNAL = "internal"
RECIPIENT_STAFF = "staff"
RECIPIENT_TYPES = (RECIPIENT_CLIENT, RECIPIENT_INTERNAL, RECIPIENT_STAFF)

METHOD_EMAIL = "email"
METHOD_DRIVE = "drive"
METHOD_EMAIL_AND_DRIVE = "email_and_drive"
METHOD_DOWNLOAD_ONLY = "download_only"
DELIVERY_METHODS = (METHOD_EMAIL, METHOD_DRIVE, METHOD_EMAIL_AND_DRIVE, METHOD_DOWNLOAD_ONLY)

# Optimistic-concurrency transitions (from → allowed targets).
DELIVERY_TRANSITIONS: dict[str, frozenset[str]] = {
    STATUS_DRAFT: frozenset({STATUS_READY, STATUS_CANCELLED}),
    STATUS_READY: frozenset({STATUS_SENT, STATUS_FAILED, STATUS_CANCELLED}),
    STATUS_FAILED: frozenset({STATUS_READY, STATUS_SENT, STATUS_FAILED, STATUS_CANCELLED, STATUS_SUPERSEDED}),
    STATUS_SENT: frozenset({STATUS_SUPERSEDED}),
    STATUS_CANCELLED: frozenset(),
    STATUS_SUPERSEDED: frozenset(),
}


def normalise_email(value: Any) -> str:
    return str(value or "").strip().lower()


def is_valid_email(value: Any) -> bool:
    text = normalise_email(value)
    if not text or len(text) > 254:
        return False
    return bool(re.match(r"^[^@\s]+@[^@\s]+\.[^@\s]+$", text))


def profile_for_report_type(report_type: Any) -> str:
    mapping = {v: k for k, v in PROFILE_TO_REPORT_TYPE.items()}
    return mapping.get(str(report_type or ""), PROFILE_INTERNAL_JOB_SHEET)


def report_type_for_profile(profile: Any) -> str:
    return PROFILE_TO_REPORT_TYPE.get(str(profile or ""), REPORT_JOB_SHEET_SUMMARY)


def audience_for_profile(profile: Any) -> str:
    return PROFILE_AUDIENCE.get(str(profile or ""), "internal")


def delivery_transition_allowed(current: Any, target: Any) -> bool:
    cur = str(current or "")
    tgt = str(target or "")
    return tgt in DELIVERY_TRANSITIONS.get(cur, frozenset())


def delivery_transition_error(current: Any, target: Any) -> str | None:
    if delivery_transition_allowed(current, target):
        return None
    return (
        f"Validation Error: cannot transition delivery from {current or '(blank)'} "
        f"to {target or '(blank)'}."
    )


def build_idempotency_key(
    *,
    report_batch_id: Any = "",
    job_sheet_id: Any = "",
    document_type: Any = "",
    recipient_email: Any = "",
    checksum: Any = "",
    template_version: Any = "",
) -> str:
    """Stable key preventing duplicate sends of the same PDF to the same recipient."""
    parts = [
        str(report_batch_id or "").strip(),
        str(job_sheet_id or "").strip(),
        str(document_type or "").strip(),
        normalise_email(recipient_email),
        str(checksum or "").strip(),
        str(template_version or DELIVERY_TEMPLATE_VERSION).strip(),
    ]
    raw = "|".join(parts)
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def _strip_forbidden(value: Any, *, client: bool) -> Any:
    if isinstance(value, list):
        return [_strip_forbidden(item, client=client) for item in value]
    if not isinstance(value, dict):
        return value
    out: dict[str, Any] = {}
    for key, child in value.items():
        key_l = str(key)
        if client and key_l in CLIENT_FORBIDDEN_FIELDS:
            continue
        if client and key_l == "completion" and isinstance(child, dict):
            out[key_l] = {
                k: _strip_forbidden(v, client=True)
                for k, v in child.items()
                if k in CLIENT_ALLOWED_COMPLETION_FIELDS
            }
            continue
        if client and key_l == "job" and isinstance(child, dict):
            out[key_l] = {
                k: _strip_forbidden(v, client=True)
                for k, v in child.items()
                if k in CLIENT_ALLOWED_JOB_FIELDS
            }
            continue
        if client and key_l == "readiness" and isinstance(child, dict):
            # Client may see finalised/approved flags only — never payroll readiness detail.
            out[key_l] = {
                "completion_finalised": bool(child.get("completion_finalised")),
                "job_approved": bool(child.get("job_approved")),
            }
            continue
        out[key_l] = _strip_forbidden(child, client=client)
    return out


def apply_pdf_profile(snapshot: Any, profile: Any) -> dict[str, Any]:
    """Return a privacy-filtered copy of a frozen report snapshot for the profile."""
    profile_name = str(profile or PROFILE_INTERNAL_JOB_SHEET)
    audience = audience_for_profile(profile_name)
    base = scrub_report_record(snapshot or {}, audience=audience)
    if not isinstance(base, dict):
        return {}
    client = audience == "client"
    filtered = _strip_forbidden(base, client=client)
    if client and isinstance(filtered, dict):
        filtered = {k: v for k, v in filtered.items() if k in CLIENT_ALLOWED_FIELDS or k in {"job", "completion"}}
    filtered["audience"] = audience
    filtered["document_type"] = profile_name
    filtered["template_version"] = str(filtered.get("template_version") or REPORT_TEMPLATE_VERSION)
    filtered["report_type"] = report_type_for_profile(profile_name)
    return filtered


def client_payload_is_clean(payload: Any) -> list[str]:
    """Return forbidden keys found in a client-bound payload (empty = clean)."""
    found: list[str] = []

    def walk(node: Any, path: str = "") -> None:
        if isinstance(node, list):
            for idx, item in enumerate(node):
                walk(item, f"{path}[{idx}]")
            return
        if not isinstance(node, dict):
            return
        for key, child in node.items():
            key_s = str(key)
            here = f"{path}.{key_s}" if path else key_s
            if key_s in CLIENT_FORBIDDEN_FIELDS:
                found.append(here)
            walk(child, here)

    walk(payload)
    return found


def preview_email(
    *,
    document_type: Any,
    recipient_email: Any,
    job_sheet_id: Any = "",
    customer_name: Any = "",
    project_name: Any = "",
    sent_by_name: Any = "",
) -> dict[str, str]:
    """Build a send-preview subject/body. Never includes secrets or Drive IDs."""
    job = str(job_sheet_id or "").strip() or "job"
    customer = str(customer_name or "").strip() or "Client"
    project = str(project_name or "").strip() or "Project"
    doc = str(document_type or PROFILE_CLIENT_JOB_SUMMARY)
    subject = f"Native Grace — {doc} for {job}"
    body = (
        f"Hello,\n\n"
        f"Please find attached the {doc} for {customer} / {project} "
        f"(job sheet {job}).\n\n"
        f"This message was prepared by {sent_by_name or 'Native Grace'}.\n"
        f"No automatic follow-up is sent from FieldOS.\n\n"
        f"Regards,\nNative Grace\n"
    )
    return {
        "to": normalise_email(recipient_email),
        "subject": subject,
        "body": body,
    }


def delivery_audit_payload(meta: dict[str, Any] | None) -> dict[str, Any]:
    """Whitelist-only audit fields — never PDF bytes, transcripts, or Drive URLs."""
    src = meta or {}
    allowed = (
        "action",
        "delivery_id",
        "report_batch_id",
        "job_sheet_id",
        "completion_id",
        "document_type",
        "recipient_type",
        "recipient_email",
        "delivery_method",
        "status",
        "previous_status",
        "new_status",
        "sent_by",
        "checksum",
        "template_version",
        "idempotency_key",
        "supersedes_delivery_id",
        "drive_filed",
        "failure_reason",
        "attachment_id",
        "client_visible",
        "actor_staff_id",
        "actor_role",
        "version",
    )
    out: dict[str, Any] = {}
    for key in allowed:
        if key in src and src[key] not in (None, ""):
            out[key] = src[key]
    # Never persist full Drive file IDs in audit response_payload-facing shapes.
    if "drive_file_id" in src:
        out["drive_filed"] = True
    return out


def email_send_allowed(*, data_mode: str, email_enabled: bool, fieldos_env: str) -> tuple[bool, str]:
    """Gate real SMTP/API sends. Mock, tests, and local always refuse."""
    mode = str(data_mode or "").strip().lower()
    env = str(fieldos_env or "").strip().lower()
    if mode == "mock":
        return False, "Email delivery is disabled in DATA_MODE=mock."
    if env in {"test", "testing", "development", "local", "dev"}:
        return False, f"Email delivery is disabled in FIELDOS_ENV={fieldos_env}."
    if not email_enabled:
        return False, "DOCUMENT_EMAIL_ENABLED is false."
    return True, ""


def drive_filing_allowed(*, data_mode: str, drive_enabled: bool, fieldos_env: str) -> tuple[bool, str]:
    mode = str(data_mode or "").strip().lower()
    env = str(fieldos_env or "").strip().lower()
    if mode == "mock":
        return False, "Drive filing is disabled in DATA_MODE=mock."
    if env in {"test", "testing"}:
        return False, "Drive filing is disabled in test environments."
    if not drive_enabled:
        return False, "DOCUMENT_DRIVE_FILING_ENABLED is false (default)."
    return True, ""
