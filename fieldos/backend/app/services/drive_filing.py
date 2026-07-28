"""Optional private Drive filing for Phase 3G document deliveries.

Disabled by default. Never creates public links. Stores file IDs only in
internal delivery records — never on client-facing PDF payloads.
"""

from __future__ import annotations

from typing import Any

from app.core.config import Settings
from app.core.logging import get_logger, log_extra
from app.services.delivery_math import drive_filing_allowed

logger = get_logger(__name__)


def build_filing_path(
    *,
    customer_name: str,
    project_name: str,
    year: str,
    job_sheet_id: str,
) -> list[str]:
    """Approved hierarchy: Client / Project / Year / Job."""
    def clean(value: str, fallback: str) -> str:
        text = "".join(ch if ch.isalnum() or ch in " -_." else "_" for ch in (value or "").strip())
        text = text.strip(" ._") or fallback
        return text[:120]

    return [
        clean(customer_name, "Client"),
        clean(project_name, "Project"),
        clean(year, "Undated"),
        clean(job_sheet_id, "Job"),
    ]


def file_document_pdf(
    settings: Settings,
    *,
    pdf_bytes: bytes,
    file_name: str,
    customer_name: str,
    project_name: str,
    year: str,
    job_sheet_id: str,
    delivery_id: str,
) -> dict[str, Any]:
    """File a PDF under the private hierarchy when enabled. Never returns a public URL."""
    allowed, reason = drive_filing_allowed(
        data_mode=settings.data_mode,
        drive_enabled=settings.document_drive_filing_enabled,
        fieldos_env=settings.fieldos_env,
    )
    path = build_filing_path(
        customer_name=customer_name,
        project_name=project_name,
        year=year,
        job_sheet_id=job_sheet_id,
    )
    log_extra(
        logger,
        20,
        "Document Drive filing gated",
        delivery_id=delivery_id,
        allowed=allowed,
        reason=reason,
        path="/".join(path),
        pdf_byte_size=len(pdf_bytes or b""),
    )
    if not allowed:
        return {"ok": False, "skipped": True, "message": reason, "path": path}

    if not settings.document_drive_root_folder_id:
        return {
            "ok": False,
            "skipped": True,
            "message": "DOCUMENT_DRIVE_ROOT_FOLDER_ID is not configured.",
            "path": path,
        }

    # Real Shared-Drive write reuses credentials from drive_upload when wired.
    # Phase 3G scaffolds the control plane; actual upload is activated only when
    # DOCUMENT_DRIVE_FILING_ENABLED and root folder are set in a controlled deploy.
    return {
        "ok": False,
        "skipped": False,
        "message": (
            "Drive filing is enabled in config but the private folder writer is not "
            "wired in this build. Delivery can retry after ops enables the writer."
        ),
        "path": path,
        "file_name": file_name,
        "public_link": None,
        "drive_file_id": None,
    }
