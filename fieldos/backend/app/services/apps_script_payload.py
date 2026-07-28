"""Allowlisted Apps Script payloads for Phase 3G delivery / attachments.

Business payloads never include transport or provider secrets. The HTTP
transport layer may attach webhook_secret only for gateway auth; the gateway
must strip it before business handlers run.
"""

from __future__ import annotations

from typing import Any

from fastapi import HTTPException

from app.core.logging import get_logger, log_extra
from app.core.roles import normalize_role

logger = get_logger(__name__)

# Keys that must never appear on a business payload destined for Apps Script.
FORBIDDEN_APPS_SCRIPT_KEYS = frozenset(
    {
        "webhook_secret",
        "apps_script_webhook_secret",
        "smtp_password",
        "smtp_username",
        "api_key",
        "access_token",
        "refresh_token",
        "auth_header",
        "authorization",
        "Authorization",
        "bearer_token",
        "provider_secret",
        "client_secret",
        "private_key",
        "token",
        "pdf_bytes",
        "pdf_base64",
        "content_base64",
        "email_body",
        "body",
        "drive_url",
        "public_url",
        "public_link",
        "settings",
        "provider_config",
        "smtp",
        "credentials",
    }
)

# Shared identity / filter fields accepted on most delivery actions.
_DELIVERY_COMMON = frozenset(
    {
        "staff_id",
        "actor_staff_id",
        "actor_role",
        "actor_identity",
        "actor_email",
        "assignment_column",
        "date_column",
        "project_column",
        "customer_column",
    }
)

_DELIVERY_SOURCE = frozenset(
    {
        "delivery_id",
        "report_batch_id",
        "job_sheet_id",
        "completion_id",
        "document_type",
        "profile",
        "recipient_type",
        "recipient_email",
        "delivery_method",
        "attachment_ids",
        "supersedes_delivery_id",
        "customer_name",
        "project_name",
        "expected_version",
    }
)

_DELIVERY_OUTCOME = frozenset(
    {
        "delivery_id",
        "status",
        "checksum",
        "template_version",
        "idempotency_key",
        "expected_version",
        "failure_reason",
        "sent_at",
        "sent_by",
        "failed_at",
        "drive_file_id",
        "audit_action",
        "clear_failure",
    }
)

DELIVERY_ACTION_ALLOWLISTS: dict[str, frozenset[str]] = {
    "delivery_options": _DELIVERY_COMMON,
    "list_deliveries": _DELIVERY_COMMON | {"job_sheet_id", "report_batch_id"},
    "get_delivery": _DELIVERY_COMMON | {"delivery_id"},
    "create_delivery_draft": _DELIVERY_COMMON | _DELIVERY_SOURCE,
    "update_delivery_draft": _DELIVERY_COMMON | _DELIVERY_SOURCE,
    "preview_delivery": _DELIVERY_COMMON | {"delivery_id", "customer_name", "project_name"},
    "validate_delivery": _DELIVERY_COMMON | {"delivery_id", "expected_version"},
    "send_delivery": _DELIVERY_COMMON
    | {"delivery_id", "expected_version", "confirm_send", "customer_name", "project_name", "year"},
    "retry_delivery": _DELIVERY_COMMON
    | {"delivery_id", "expected_version", "confirm_send", "customer_name", "project_name", "year"},
    "cancel_delivery": _DELIVERY_COMMON | {"delivery_id", "expected_version"},
    "supersede_delivery": _DELIVERY_COMMON
    | {"delivery_id", "expected_version", "customer_name", "project_name"},
    "record_delivery_outcome": _DELIVERY_COMMON | _DELIVERY_OUTCOME,
}

ATTACHMENT_ACTION_ALLOWLISTS: dict[str, frozenset[str]] = {
    "list_attachments": _DELIVERY_COMMON | {"job_sheet_id"},
    "upload_attachment": _DELIVERY_COMMON
    | {
        "job_sheet_id",
        "completion_id",
        "attachment_type",
        "file_name",
        "mime_type",
        "byte_size",
        "caption",
        "storage_ref",
        "checksum",
    },
    "delete_attachment": _DELIVERY_COMMON | {"attachment_id", "expected_version"},
    "set_attachment_client_visible": _DELIVERY_COMMON
    | {"attachment_id", "client_visible", "expected_version"},
}


def rejected_forbidden_key_names(source: dict[str, Any] | None) -> list[str]:
    """Return forbidden key names present on source (values never inspected for logging)."""
    src = source or {}
    found: list[str] = []
    for key in src.keys():
        lowered = str(key).lower()
        if key in FORBIDDEN_APPS_SCRIPT_KEYS or lowered in {k.lower() for k in FORBIDDEN_APPS_SCRIPT_KEYS}:
            found.append(str(key))
            continue
        # Nested provider/settings blobs are never forwarded.
        if lowered in {"settings", "provider_config", "smtp", "credentials", "provider"}:
            found.append(str(key))
    return sorted(set(found))


def assert_no_forbidden_apps_script_keys(payload: dict[str, Any], *, action: str) -> None:
    """Preflight: raise before HTTP if a sensitive key slipped into the business payload."""
    rejected = rejected_forbidden_key_names(payload)
    if rejected:
        log_extra(
            logger,
            40,
            "Apps Script payload rejected before transport",
            action=action,
            rejected_key_names=rejected,
            payload_key_count=len(payload),
        )
        raise HTTPException(
            status_code=500,
            detail=(
                "Internal configuration error: sensitive fields were blocked before "
                f"Apps Script transport ({', '.join(rejected)})."
            ),
        )


def build_apps_script_delivery_payload(action: str, source: dict[str, Any] | None) -> dict[str, Any]:
    """Build a new allowlisted dict for a delivery/attachment Apps Script action.

    Never mutates or passes through ``source``. Normalises actor_role. Drops Nones.
    """
    src = dict(source or {})
    allowlists = {**DELIVERY_ACTION_ALLOWLISTS, **ATTACHMENT_ACTION_ALLOWLISTS}
    allowed = allowlists.get(action)
    if allowed is None:
        raise HTTPException(status_code=400, detail=f"Unsupported delivery transport action: {action}")

    rejected = rejected_forbidden_key_names(src)
    out: dict[str, Any] = {}
    for key in sorted(allowed):
        if key not in src:
            continue
        value = src[key]
        if value is None:
            continue
        if key == "actor_role":
            out[key] = normalize_role(str(value))
            continue
        if key == "drive_file_id":
            # Only forward when a real private provider supplied a non-empty id.
            text = str(value).strip()
            if text:
                out[key] = text
            continue
        out[key] = value

    log_extra(
        logger,
        20,
        "Apps Script delivery payload built",
        action=action,
        allowed_keys=sorted(out.keys()),
        rejected_key_names=rejected,
        payload_key_count=len(out),
    )
    assert_no_forbidden_apps_script_keys(out, action=action)
    return out
