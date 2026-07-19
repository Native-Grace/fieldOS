"""In-memory / file-backed mock store for local development."""

from __future__ import annotations

import json
import uuid
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from app.core.config import Settings
from app.core.logging import get_logger, log_extra

logger = get_logger(__name__)


class MockStore:
    def __init__(self, settings: Settings):
        self.settings = settings
        self.root = Path(settings.mock_data_dir)
        self.root.mkdir(parents=True, exist_ok=True)
        self.jobs_path = self.root / "jobs.json"
        self.recordings_path = self.root / "recordings.json"
        self._ensure_seed()

    def _ensure_seed(self) -> None:
        if not self.jobs_path.exists():
            today = date.today()
            staff_id = self.settings.demo_staff_id
            assign_col = self.settings.job_assignment_column
            date_col = self.settings.job_date_column
            project_col = self.settings.job_project_column
            customer_col = self.settings.job_customer_column
            jobs = []
            for i, offset in enumerate([0, 1, 3, 6, 10]):
                d = today - timedelta(days=offset)
                jobs.append(
                    {
                        "job_sheet_id": f"JS-DEMO{i+1:03d}",
                        assign_col: staff_id if offset <= 6 else "STAFF-OTHER",
                        date_col: d.isoformat(),
                        project_col: f"PROJ-DEMO{i+1:03d}",
                        customer_col: f"Customer {chr(65+i)}",
                        "processing_status": ["", "Queued", "Processing", "Failed", "Completed"][i % 5],
                        "approval_status": "Pending Review" if i == 3 else "",
                        "processing_error": "Simulated pipeline error for demo." if i == 3 else "",
                        "processing_started_at": None,
                        "processing_completed_at": None,
                    }
                )
            self._write(self.jobs_path, jobs)
            log_extra(logger, 20, "Seeded mock jobs", count=len(jobs))

        if not self.recordings_path.exists():
            self._write(self.recordings_path, [])

    @staticmethod
    def _read(path: Path) -> list[dict[str, Any]]:
        if not path.exists():
            return []
        return json.loads(path.read_text(encoding="utf-8"))

    @staticmethod
    def _write(path: Path, data: list[dict[str, Any]]) -> None:
        path.write_text(json.dumps(data, indent=2, default=str), encoding="utf-8")

    def list_jobs_for_staff(self, staff_id: str, since: date) -> list[dict[str, Any]]:
        assign_col = self.settings.job_assignment_column
        date_col = self.settings.job_date_column
        out = []
        for job in self._read(self.jobs_path):
            if str(job.get(assign_col, "")) != str(staff_id):
                continue
            raw_date = job.get(date_col)
            if not raw_date:
                continue
            job_date = date.fromisoformat(str(raw_date)[:10])
            if job_date < since:
                continue
            out.append(job)
        out.sort(key=lambda j: str(j.get(date_col, "")), reverse=True)
        return out

    def get_job(self, job_sheet_id: str) -> dict[str, Any] | None:
        for job in self._read(self.jobs_path):
            if str(job.get("job_sheet_id")) == str(job_sheet_id):
                return job
        return None

    def list_recordings(self, job_sheet_id: str) -> list[dict[str, Any]]:
        rows = [r for r in self._read(self.recordings_path) if str(r.get("job_sheet_id")) == str(job_sheet_id)]
        rows.sort(key=lambda r: int(r.get("recording_order") or 0))
        return rows

    def next_recording_order(self, job_sheet_id: str) -> int:
        return len(self.list_recordings(job_sheet_id)) + 1

    def create_recording(self, row: dict[str, Any]) -> dict[str, Any]:
        rows = self._read(self.recordings_path)
        if not row.get("recording_id"):
            row["recording_id"] = f"REC-{uuid.uuid4().hex[:8].upper()}"
        rows.append(row)
        self._write(self.recordings_path, rows)
        return row

    def update_job_status(self, job_sheet_id: str, updates: dict[str, Any]) -> None:
        jobs = self._read(self.jobs_path)
        for job in jobs:
            if str(job.get("job_sheet_id")) == str(job_sheet_id):
                job.update(updates)
                break
        self._write(self.jobs_path, jobs)

    def append_sync_log(self, entry: dict[str, Any]) -> None:
        path = self.root / "sync_logs.json"
        rows = self._read(path) if path.exists() else []
        entry.setdefault("log_id", f"LOG-{uuid.uuid4().hex[:8].upper()}")
        entry.setdefault("timestamp", datetime.now(timezone.utc).isoformat())
        rows.append(entry)
        self._write(path, rows)
