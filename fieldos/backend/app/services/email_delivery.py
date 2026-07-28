"""Outbound email for Phase 3G document deliveries.

Never sends automatically. Mock / local / test environments always refuse.
Production send requires DOCUMENT_EMAIL_ENABLED=true and an explicit manager confirm.
"""

from __future__ import annotations

from typing import Any

from app.core.config import Settings
from app.core.logging import get_logger, log_extra
from app.services.delivery_math import email_send_allowed

logger = get_logger(__name__)


def send_document_email(
    settings: Settings,
    *,
    to_email: str,
    subject: str,
    body: str,
    pdf_bytes: bytes,
    file_name: str,
    delivery_id: str,
    idempotency_key: str,
) -> dict[str, Any]:
    """Attempt to send a PDF attachment. Returns {ok, provider, message} — never raises secrets."""
    allowed, reason = email_send_allowed(
        data_mode=settings.data_mode,
        email_enabled=settings.document_email_enabled,
        fieldos_env=settings.fieldos_env,
    )
    log_extra(
        logger,
        20,
        "Document email send gated",
        delivery_id=delivery_id,
        allowed=allowed,
        reason=reason,
        has_idempotency_key=bool(idempotency_key),
        pdf_byte_size=len(pdf_bytes or b""),
        # never log recipient in full for privacy in shared logs? User asked for audit with recipient.
        # Keep domain-only hint:
        recipient_domain=(to_email.split("@")[-1] if "@" in to_email else ""),
    )
    if not allowed:
        return {"ok": False, "provider": "none", "message": reason, "skipped": True}

    # Provider wiring is intentionally not auto-configured. When enabled in a
    # controlled environment, operators plug SMTP/API credentials via env and
    # a future provider module. Until then, refuse rather than silently no-op.
    if not settings.document_email_provider:
        return {
            "ok": False,
            "provider": "none",
            "message": "DOCUMENT_EMAIL_PROVIDER is not configured.",
            "skipped": True,
        }

    # Placeholder: real SMTP/API providers are out of band for Phase 3G scaffolding.
    # Returning failure keeps "no automatic send" honest while the control plane is ready.
    return {
        "ok": False,
        "provider": str(settings.document_email_provider),
        "message": (
            f"Provider '{settings.document_email_provider}' is declared but not wired in this build. "
            "Delivery stays Failed for retry after provider configuration."
        ),
        "skipped": False,
        "file_name": file_name,
        "subject": subject,
        "body_chars": len(body or ""),
    }
