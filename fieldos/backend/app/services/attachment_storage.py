"""Local attachment byte storage for Phase 3G (never public URLs)."""

from __future__ import annotations

import base64
import re
from pathlib import Path
from typing import Any

from app.core.config import Settings
from app.services.attachment_math import safe_attachment_filename
from app.services.report_math import sha256_hex


def store_attachment_bytes(
    settings: Settings,
    *,
    job_sheet_id: str,
    file_name: str,
    raw: bytes,
) -> dict[str, Any]:
    """Persist bytes under LOCAL_RECORDINGS_DIR/attachments/{job}/ — private path only."""
    job = re.sub(r"[^A-Za-z0-9._-]+", "_", str(job_sheet_id or "job")).strip("_") or "job"
    safe = safe_attachment_filename(file_name)
    root = Path(settings.local_recordings_dir) / "attachments" / job
    root.mkdir(parents=True, exist_ok=True)
    path = root / safe
    # Avoid clobbering: append short checksum prefix when file exists.
    if path.exists():
        path = root / f"{sha256_hex(raw)[:8]}_{safe}"
    path.write_bytes(raw)
    rel = f"attachments/{job}/{path.name}"
    return {
        "storage_ref": f"local://{rel}",
        "checksum": sha256_hex(raw),
        "byte_size": len(raw),
        "path": str(path),
    }


def decode_content_base64(value: Any) -> bytes | None:
    text = str(value or "").strip()
    if not text:
        return None
    try:
        return base64.b64decode(text, validate=False)
    except Exception:
        return None
