"""File-backed staging store for new-job-from-recording drafts."""

from __future__ import annotations

import json
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

from app.services.new_job_dictation_math import (
    ALLOWED_UPLOAD_SOURCES,
    NEW_JOB_DICTATION_SOURCE,
    SOURCE_BROWSER_RECORDING,
    SOURCE_UPLOADED_FILE,
    STATUS_UPLOADED,
    empty_extraction,
    trim_text,
)


class NewJobDictationStore:
    def __init__(self, root: Path):
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)
        (self.root / "audio").mkdir(parents=True, exist_ok=True)
        (self.root / "meta").mkdir(parents=True, exist_ok=True)

    def _meta_path(self, recording_id: str) -> Path:
        return self.root / "meta" / f"{recording_id}.json"

    def audio_path(self, recording_id: str, ext: str = ".webm") -> Path:
        safe = ext if ext.startswith(".") else f".{ext}"
        return self.root / "audio" / f"{recording_id}{safe}"

    def create(
        self,
        *,
        staff_id: str,
        staff_name: str,
        filename: str,
        mime_type: str,
        size: int,
        duration_seconds: float,
        drive_file_id: str = "",
        drive_file_url: str = "",
        audio_relpath: str = "",
        source: str = NEW_JOB_DICTATION_SOURCE,
    ) -> dict[str, Any]:
        recording_id = f"NJR-{uuid.uuid4().hex[:8].upper()}"
        now = datetime.now(timezone.utc).isoformat()
        src = trim_text(source) or NEW_JOB_DICTATION_SOURCE
        if src not in ALLOWED_UPLOAD_SOURCES:
            src = NEW_JOB_DICTATION_SOURCE
        row = {
            "recording_id": recording_id,
            "source": src,
            "status": STATUS_UPLOADED,
            "filename": filename,
            "mime_type": mime_type,
            "byte_size": int(size),
            "duration_seconds": float(duration_seconds or 0),
            "recording_drive_file_id": drive_file_id or "",
            "recording_file_url": drive_file_url or "",
            "audio_path": audio_relpath or "",
            "created_by": staff_id,
            "created_by_name": staff_name,
            "created_at": now,
            "updated_at": now,
            "processing_version": 1,
            "processing_type": "new_job_dictation",
            "transcript": "",
            "extraction": empty_extraction(),
            "match_report": {},
            "job_sheet_id": "",
            "reviewed_by": "",
            "reviewed_at": "",
            "created_job_by": "",
            "created_job_at": "",
            "idempotency_key": "",
            "failure_reason": "",
            "audit": [],
        }
        self.save(row)
        return row

    def get(self, recording_id: str) -> Optional[dict[str, Any]]:
        path = self._meta_path(recording_id)
        if not path.is_file():
            return None
        return json.loads(path.read_text(encoding="utf-8"))

    def save(self, row: dict[str, Any]) -> dict[str, Any]:
        recording_id = str(row["recording_id"])
        row["updated_at"] = datetime.now(timezone.utc).isoformat()
        path = self._meta_path(recording_id)
        path.write_text(json.dumps(row, indent=2, default=str), encoding="utf-8")
        return row

    def append_audit(self, row: dict[str, Any], event: dict[str, Any]) -> dict[str, Any]:
        audit = list(row.get("audit") or [])
        audit.append({**event, "at": datetime.now(timezone.utc).isoformat()})
        row["audit"] = audit
        return self.save(row)

    def find_by_idempotency(self, key: str) -> Optional[dict[str, Any]]:
        key = str(key or "").strip()
        if not key:
            return None
        for path in (self.root / "meta").glob("*.json"):
            try:
                row = json.loads(path.read_text(encoding="utf-8"))
            except Exception:
                continue
            if str(row.get("idempotency_key") or "") == key and row.get("job_sheet_id"):
                return row
        return None

    def find_job_for_recording(self, recording_id: str) -> Optional[str]:
        row = self.get(recording_id)
        if not row:
            return None
        jid = str(row.get("job_sheet_id") or "").strip()
        return jid or None
