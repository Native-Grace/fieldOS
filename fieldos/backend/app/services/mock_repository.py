"""Mock job repository (DATA_MODE=mock)."""

from __future__ import annotations

import uuid
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Any

from fastapi import HTTPException, status

from app.core.config import Settings
from app.services.apps_script import AppsScriptClient
from app.services.mock_store import MockStore

MOCK_ASSUMPTIONS = [
    "DATA_MODE=mock uses local JSON demo jobs — not live Sheets.",
    "Assignment filter uses JOB_ASSIGNMENT_COLUMN (default staff_id — live tbl_job_sheets).",
    "Date filter uses JOB_DATE_COLUMN (default date).",
    "Display: JOB_PROJECT_COLUMN defaults to project_id (ID until project lookup); JOB_CUSTOMER_COLUMN defaults to customer_name (not on job sheet).",
]


class MockJobRepository:
    def __init__(self, settings: Settings, apps_script: AppsScriptClient | None = None):
        self.settings = settings
        self.store = MockStore(settings)
        self.apps_script = apps_script or AppsScriptClient(settings)
        Path(settings.local_recordings_dir).mkdir(parents=True, exist_ok=True)

    def assumptions(self) -> list[str]:
        return list(MOCK_ASSUMPTIONS)

    def list_jobs_for_staff(self, staff_id: str, since: date, days: int | None = None) -> list[dict[str, Any]]:
        _ = days
        return self.store.list_jobs_for_staff(staff_id, since)

    def get_job_for_staff(self, job_sheet_id: str, staff_id: str) -> dict[str, Any]:
        job = self.store.get_job(job_sheet_id)
        if not job:
            raise HTTPException(status_code=404, detail="Job sheet not found")
        if str(job.get(self.settings.job_assignment_column, "")) != str(staff_id):
            raise HTTPException(status_code=403, detail="Job is not assigned to this staff member")
        return job

    def list_recordings(self, job_sheet_id: str, staff_id: str) -> list[dict[str, Any]]:
        self.get_job_for_staff(job_sheet_id, staff_id)
        return self.store.list_recordings(job_sheet_id)

    def create_recording_local(
        self,
        row: dict[str, Any],
        file_bytes: bytes,
        content_type: str,
    ) -> dict[str, Any]:
        job_sheet_id = row["job_sheet_id"]
        dest_dir = Path(self.settings.local_recordings_dir) / job_sheet_id
        dest_dir.mkdir(parents=True, exist_ok=True)
        dest_path = dest_dir / row["recording_name"]
        dest_path.write_bytes(file_bytes)
        row["recording_file_url"] = f"file://{dest_path}"
        row["recording_drive_file_id"] = f"LOCAL-{row['recording_id']}"
        self.store.create_recording(row)
        self.store.append_sync_log(
            {
                "record_id": job_sheet_id,
                "target_system": "FieldOS_API",
                "status": "Success",
                "request_payload": {
                    "job_sheet_id": job_sheet_id,
                    "duration_seconds": row.get("duration_seconds"),
                    "content_type": content_type,
                    "bytes": len(file_bytes),
                },
                "response_payload": {
                    "recording_id": row["recording_id"],
                    "recording_order": row["recording_order"],
                },
            }
        )
        return row

    async def register_recording_remote(
        self,
        job_sheet_id: str,
        staff_id: str,
        staff_email: str,
        file_bytes: bytes,
        content_type: str,
        duration_seconds: float,
        recording_name: str,
    ) -> dict[str, Any]:
        # Mock path never calls remote register — local create only
        order = self.store.next_recording_order(job_sheet_id)
        recording_id = f"REC-{uuid.uuid4().hex[:8].upper()}"
        row = {
            "recording_id": recording_id,
            "job_sheet_id": job_sheet_id,
            "recording_name": recording_name or f"{job_sheet_id}-REC-{order}.webm",
            "recording_order": order,
            "duration_seconds": duration_seconds,
            "transcript": "",
            "status": "Saved",
            "created_by": staff_email,
            "created_at": datetime.now(timezone.utc).isoformat(),
        }
        return self.create_recording_local(row, file_bytes, content_type)

    async def trigger_process(
        self,
        job_sheet_id: str,
        staff_id: str,
        staff_email: str,
        force_reprocess: bool,
    ) -> dict[str, Any]:
        self.get_job_for_staff(job_sheet_id, staff_id)
        result = await self.apps_script.process_voice_dictation(job_sheet_id, staff_email, force_reprocess)
        if str(result.get("status", "")).lower() == "success":
            self.store.update_job_status(
                job_sheet_id,
                {"processing_status": "Queued", "processing_error": ""},
            )
        return result

    def update_job_status_local(self, job_sheet_id: str, updates: dict[str, Any]) -> None:
        self.store.update_job_status(job_sheet_id, updates)

    def next_recording_order(self, job_sheet_id: str) -> int:
        return self.store.next_recording_order(job_sheet_id)

    def invalidate_recording_local(
        self,
        job_sheet_id: str,
        staff_id: str,
        recording_id: str,
        reason: str,
    ) -> dict[str, Any]:
        job = self.get_job_for_staff(job_sheet_id, staff_id)
        if str(job.get("processing_status") or "").strip().lower() == "processing":
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="Cannot change recordings while the job is Processing.",
            )
        row = self.store.get_recording(recording_id)
        if not row or str(row.get("job_sheet_id")) != str(job_sheet_id):
            raise HTTPException(status_code=404, detail="Recording not found for this job.")
        if str(row.get("status") or "").strip() == "Invalid":
            return {
                "recording_id": recording_id,
                "job_sheet_id": job_sheet_id,
                "recording_status": "Invalid",
                "invalid_reason": str(row.get("invalid_reason") or reason),
                "idempotent": True,
            }
        updated = self.store.update_recording(
            recording_id,
            {
                "status": "Invalid",
                "invalid_reason": reason,
                "updated_at": datetime.now(timezone.utc).isoformat(),
            },
        )
        return {
            "recording_id": recording_id,
            "job_sheet_id": job_sheet_id,
            "recording_status": "Invalid",
            "invalid_reason": str((updated or {}).get("invalid_reason") or reason),
            "idempotent": False,
        }

    def delete_recording_local(
        self,
        job_sheet_id: str,
        staff_id: str,
        recording_id: str,
    ) -> dict[str, Any]:
        job = self.get_job_for_staff(job_sheet_id, staff_id)
        if str(job.get("processing_status") or "").strip().lower() == "processing":
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="Cannot delete recordings while the job is Processing.",
            )
        row = self.store.get_recording(recording_id)
        if not row or str(row.get("job_sheet_id")) != str(job_sheet_id):
            raise HTTPException(status_code=404, detail="Recording not found for this job.")
        # Local file cleanup (Drive IDs are LOCAL-* in mock).
        url = str(row.get("recording_file_url") or "")
        if url.startswith("file://"):
            path = Path(url[7:])
            if path.is_file():
                path.unlink()
        if not self.store.delete_recording(recording_id):
            raise HTTPException(status_code=404, detail="Recording not found for this job.")
        return {
            "recording_id": recording_id,
            "job_sheet_id": job_sheet_id,
            "recording_status": "Deleted",
            "drive_outcome": "deleted",
        }
