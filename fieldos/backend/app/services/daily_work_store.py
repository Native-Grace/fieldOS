"""File-backed staging store for Daily Work sessions and recordings.

Ownership: FastAPI owns full staging state (sessions, audio, transcripts,
extraction). Apps Script / Sheets receive job + link rows only on create.
"""

from __future__ import annotations

import json
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

from app.services.daily_work_math import (
    PROCESSING_TYPE,
    REC_SAVED,
    STATUS_RECORDING,
    empty_extraction,
    sort_recordings,
    sydney_today,
    trim_text,
)


class DailyWorkStore:
    def __init__(self, root: Path):
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)
        (self.root / "sessions").mkdir(parents=True, exist_ok=True)
        (self.root / "audio").mkdir(parents=True, exist_ok=True)

    def _session_path(self, work_session_id: str) -> Path:
        return self.root / "sessions" / f"{work_session_id}.json"

    def audio_path(self, recording_id: str, ext: str = ".webm") -> Path:
        safe = ext if str(ext).startswith(".") else f".{ext}"
        return self.root / "audio" / f"{recording_id}{safe}"

    def create_session(
        self,
        *,
        created_by: str,
        created_by_name: str = "",
        work_date: str = "",
        staff_ids: Optional[list[str]] = None,
        staff_names: Optional[list[str]] = None,
        project_id: str = "",
        project_name: str = "",
        customer_name: str = "",
        site_address: str = "",
        starting_note: str = "",
    ) -> dict[str, Any]:
        work_session_id = f"DWS-{uuid.uuid4().hex[:8].upper()}"
        now = datetime.now(timezone.utc).isoformat()
        day = trim_text(work_date) or sydney_today().isoformat()
        row = {
            "work_session_id": work_session_id,
            "work_date": day,
            "staff_ids": [trim_text(x) for x in (staff_ids or []) if trim_text(x)],
            "staff_names": [trim_text(x) for x in (staff_names or []) if trim_text(x)],
            "project_id": trim_text(project_id),
            "project_name": trim_text(project_name),
            "customer_name": trim_text(customer_name),
            "site_address": trim_text(site_address),
            "starting_note": trim_text(starting_note),
            "status": STATUS_RECORDING,
            "recording_ids": [],
            "recordings": [],
            "created_by": created_by,
            "created_by_name": created_by_name,
            "created_at": now,
            "updated_at": now,
            "version": 1,
            "processing_type": PROCESSING_TYPE,
            "extraction": empty_extraction(work_session_id, day),
            "created_job_sheet_id": "",
            "idempotency_key": "",
            "idempotency_payload_hash": "",
            "failure_reason": "",
            "create_failure_reason": "",
            "create_failure_code": "",
            "last_create_idempotency_key": "",
            "audit": [],
        }
        return self.save(row)

    def get(self, work_session_id: str) -> Optional[dict[str, Any]]:
        path = self._session_path(work_session_id)
        if not path.is_file():
            return None
        return json.loads(path.read_text(encoding="utf-8"))

    def save(self, row: dict[str, Any]) -> dict[str, Any]:
        row["updated_at"] = datetime.now(timezone.utc).isoformat()
        # Keep recording_ids in sync with recordings list order
        ordered = sort_recordings(row.get("recordings") or [])
        row["recordings"] = ordered
        row["recording_ids"] = [r.get("recording_id") for r in ordered]
        path = self._session_path(str(row["work_session_id"]))
        path.write_text(json.dumps(row, indent=2, default=str), encoding="utf-8")
        return row

    def list_sessions(
        self,
        *,
        created_by: Optional[str] = None,
        open_only: bool = False,
        actor_is_manager: bool = False,
    ) -> list[dict[str, Any]]:
        items = []
        for path in sorted((self.root / "sessions").glob("*.json"), reverse=True):
            try:
                row = json.loads(path.read_text(encoding="utf-8"))
            except Exception:
                continue
            if created_by and not actor_is_manager:
                if trim_text(row.get("created_by")) != trim_text(created_by):
                    # Staff may also see sessions they are assigned to
                    if trim_text(created_by) not in (row.get("staff_ids") or []):
                        continue
            if open_only and row.get("status") == "JobCreated":
                continue
            items.append(row)
        return items

    def append_audit(self, row: dict[str, Any], event: dict[str, Any]) -> dict[str, Any]:
        audit = list(row.get("audit") or [])
        audit.append({**event, "at": datetime.now(timezone.utc).isoformat()})
        row["audit"] = audit
        return self.save(row)

    def add_recording(self, session: dict[str, Any], recording: dict[str, Any]) -> dict[str, Any]:
        recs = list(session.get("recordings") or [])
        seq = max([int(r.get("sequence") or 0) for r in recs] + [0]) + 1
        recording["sequence"] = seq
        if not recording.get("status"):
            recording["status"] = REC_SAVED
        recs.append(recording)
        session["recordings"] = recs
        session["version"] = int(session.get("version") or 1) + 1
        return self.save(session)

    def remove_recording(self, session: dict[str, Any], recording_id: str) -> dict[str, Any]:
        rid = trim_text(recording_id)
        session["recordings"] = [
            r for r in (session.get("recordings") or []) if trim_text(r.get("recording_id")) != rid
        ]
        session["version"] = int(session.get("version") or 1) + 1
        return self.save(session)

    def update_recording(
        self, session: dict[str, Any], recording_id: str, patch: dict[str, Any]
    ) -> dict[str, Any]:
        rid = trim_text(recording_id)
        recs = []
        for r in session.get("recordings") or []:
            if trim_text(r.get("recording_id")) == rid:
                recs.append({**r, **patch})
            else:
                recs.append(r)
        session["recordings"] = recs
        session["version"] = int(session.get("version") or 1) + 1
        return self.save(session)

    def find_by_idempotency(self, key: str) -> Optional[dict[str, Any]]:
        key = trim_text(key)
        if not key:
            return None
        for path in (self.root / "sessions").glob("*.json"):
            try:
                row = json.loads(path.read_text(encoding="utf-8"))
            except Exception:
                continue
            if trim_text(row.get("idempotency_key")) == key and row.get("created_job_sheet_id"):
                return row
        return None
