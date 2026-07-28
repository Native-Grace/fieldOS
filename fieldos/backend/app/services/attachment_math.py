"""Phase 3G job attachment validation helpers (pure — no I/O)."""

from __future__ import annotations

import re
from typing import Any

ATTACHMENT_TYPES = (
    "photo",
    "plan",
    "receipt",
    "signed_document",
    "other",
)

# Executables and scriptable archives are never accepted.
FORBIDDEN_EXTENSIONS = frozenset(
    {
        ".exe",
        ".bat",
        ".cmd",
        ".com",
        ".msi",
        ".scr",
        ".js",
        ".jse",
        ".vbs",
        ".vbe",
        ".wsf",
        ".wsh",
        ".ps1",
        ".sh",
        ".bash",
        ".zsh",
        ".dll",
        ".so",
        ".dylib",
        ".jar",
        ".apk",
        ".app",
        ".dmg",
        ".pkg",
        ".deb",
        ".rpm",
        ".iso",
        ".html",
        ".htm",
        ".svg",  # scriptable; treat as blocked for upload
    }
)

ALLOWED_MIME_PREFIXES = (
    "image/",
    "application/pdf",
    "text/plain",
    "text/csv",
    "application/msword",
    "application/vnd.openxmlformats-officedocument",
    "application/vnd.ms-excel",
    "application/vnd.ms-powerpoint",
    "application/zip",  # plans/zips of photos — still scanned at antivirus boundary
)

ALLOWED_EXTENSIONS = frozenset(
    {
        ".jpg",
        ".jpeg",
        ".png",
        ".gif",
        ".webp",
        ".heic",
        ".pdf",
        ".txt",
        ".csv",
        ".doc",
        ".docx",
        ".xls",
        ".xlsx",
        ".ppt",
        ".pptx",
        ".zip",
    }
)

DEFAULT_MAX_ATTACHMENT_BYTES = 15 * 1024 * 1024
MIN_ATTACHMENT_BYTES = 32

STATUS_UPLOADED = "Uploaded"
STATUS_APPROVED = "Approved"
STATUS_REJECTED = "Rejected"
STATUS_DELETED = "Deleted"


def attachment_extension(filename: Any) -> str:
    name = str(filename or "").strip().lower()
    if "." not in name:
        return ""
    return "." + name.rsplit(".", 1)[-1]


def is_forbidden_executable(filename: Any, mime_type: Any = "") -> bool:
    ext = attachment_extension(filename)
    if ext in FORBIDDEN_EXTENSIONS:
        return True
    mime = str(mime_type or "").strip().lower()
    if mime in {
        "application/x-msdownload",
        "application/x-executable",
        "application/x-sh",
        "application/javascript",
        "text/html",
        "image/svg+xml",
    }:
        return True
    return False


def mime_allowed(mime_type: Any) -> bool:
    mime = str(mime_type or "").strip().lower()
    if not mime:
        return False
    return any(mime == p or mime.startswith(p.rstrip("/")) or mime.startswith(p) for p in ALLOWED_MIME_PREFIXES)


def validate_attachment_upload(
    *,
    filename: Any,
    mime_type: Any,
    byte_size: Any,
    attachment_type: Any = "other",
    max_bytes: int = DEFAULT_MAX_ATTACHMENT_BYTES,
) -> list[str]:
    """Return blocker messages; empty list means the file may be stored."""
    blockers: list[str] = []
    name = str(filename or "").strip()
    if not name:
        blockers.append("Filename is required.")
    ext = attachment_extension(name)
    if is_forbidden_executable(name, mime_type):
        blockers.append("Executable or scriptable file types are not allowed.")
    if ext and ext not in ALLOWED_EXTENSIONS:
        blockers.append(f"File extension {ext} is not allowed.")
    if not mime_allowed(mime_type):
        blockers.append(f"MIME type '{mime_type or '(blank)'}' is not allowed.")
    try:
        size = int(byte_size or 0)
    except (TypeError, ValueError):
        size = 0
    if size < MIN_ATTACHMENT_BYTES:
        blockers.append("File is empty or too small.")
    if size > max_bytes:
        blockers.append(f"File exceeds the {max_bytes} byte limit.")
    kind = str(attachment_type or "other").strip().lower().replace(" ", "_")
    if kind not in ATTACHMENT_TYPES:
        blockers.append(f"Unknown attachment_type '{attachment_type}'.")
    return blockers


def public_attachment_view(row: dict[str, Any] | None, *, include_storage_ref: bool = False) -> dict[str, Any]:
    """Safe API projection — never exposes Drive IDs to client-facing UIs by default."""
    src = row or {}
    out = {
        "attachment_id": str(src.get("attachment_id") or ""),
        "job_sheet_id": str(src.get("job_sheet_id") or ""),
        "completion_id": str(src.get("completion_id") or ""),
        "attachment_type": str(src.get("attachment_type") or "other"),
        "file_name": str(src.get("file_name") or ""),
        "mime_type": str(src.get("mime_type") or ""),
        "byte_size": int(src.get("byte_size") or 0),
        "caption": str(src.get("caption") or ""),
        "uploaded_by": str(src.get("uploaded_by") or ""),
        "uploaded_at": src.get("uploaded_at"),
        "client_visible": bool(src.get("client_visible")),
        "approved_by": str(src.get("approved_by") or ""),
        "approved_at": src.get("approved_at"),
        "checksum": str(src.get("checksum") or ""),
        "status": str(src.get("status") or STATUS_UPLOADED),
        "version": int(src.get("version") or 1),
    }
    if include_storage_ref:
        # Internal managers only — still never a public link.
        out["has_storage_ref"] = bool(src.get("storage_ref") or src.get("drive_file_id"))
    return out


def antivirus_boundary_note() -> str:
    """Documented boundary: FieldOS validates MIME/size; AV scanning is an ops control."""
    return (
        "FieldOS enforces MIME, extension, and size allowlists and rejects executables. "
        "Malware scanning (ClamAV or cloud AV) must run at the storage boundary before "
        "client-visible approval. FieldOS never creates public links for attachments."
    )


def safe_attachment_filename(name: Any) -> str:
    text = re.sub(r"[^\w.\- ]+", "_", str(name or "attachment").strip()) or "attachment"
    return text[:180]
