"""Job and recording orchestration."""

from __future__ import annotations

import uuid
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from fastapi import HTTPException, UploadFile, status

from app.core.config import Settings
from app.core.logging import get_logger, log_extra
from app.services.apps_script import AppsScriptClient
from app.services.mock_store import MockStore

logger = get_logger(__name__)

ASSUMPTIONS = [
    "Assignment filter uses JOB_ASSIGNMENT_COLUMN (default assigned_staff_id) — not confirmed in Apps Script export.",
    "Date filter uses JOB_DATE_COLUMN (default job_date).",
    "Display fields project_name / customer_name are assumptions for Phase 1 mock/local.",
    "DATA_MODE=mock stores jobs/recordings on local disk; set DATA_MODE=sheets when Google credentials are available.",
]


class JobService:
    def __init__(self, settings: Settings):
        self.settings = settings
        self.store = MockStore(settings)
        self.apps_script = AppsScriptClient(settings)
        Path(settings.local_recordings_dir).mkdir(parents=True, exist_ok=True)

    def assumptions(self) -> list[str]:
        return list(ASSUMPTIONS)

    def _since(self, days: int | None) -> date:
        d = days if days is not None else self.settings.jobs_default_days
        return date.today() - timedelta(days=d)

    def list_mine(self, staff_id: str, days: int | None = None) -> tuple[list[dict[str, Any]], int]:
        if self.settings.data_mode != "mock":
            # Sheets adapter not wired in Phase 1 local MVP — fail clearly.
            raise HTTPException(
                status_code=status.HTTP_501_NOT_IMPLEMENTED,
                detail="DATA_MODE=sheets is not enabled in this Phase 1 local build. Use DATA_MODE=mock.",
            )
        day_count = days if days is not None else self.settings.jobs_default_days
        jobs = self.store.list_jobs_for_staff(staff_id, self._since(day_count))
        return jobs, day_count

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

    async def save_recording(
        self,
        job_sheet_id: str,
        staff_id: str,
        staff_email: str,
        file: UploadFile,
        duration_seconds: float,
        trigger_processing: bool,
    ) -> dict[str, Any]:
        self.get_job_for_staff(job_sheet_id, staff_id)

        content_type = (file.content_type or "").split(";")[0].strip().lower()
        if content_type not in self.settings.allowed_mimes:
            raise HTTPException(
                status_code=400,
                detail=f"Unsupported MIME type '{content_type}'. Allowed: {sorted(self.settings.allowed_mimes)}",
            )

        data = await file.read()
        if not data:
            raise HTTPException(status_code=400, detail="Empty upload rejected")
        if len(data) > self.settings.max_upload_bytes:
            raise HTTPException(
                status_code=400,
                detail=f"File exceeds max size of {self.settings.max_upload_mb} MB",
            )

        order = self.store.next_recording_order(job_sheet_id)
        stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        ext = "webm"
        if "mp4" in content_type:
            ext = "mp4"
        elif "mpeg" in content_type or content_type == "audio/mp3":
            ext = "mp3"
        elif "ogg" in content_type:
            ext = "ogg"
        elif "wav" in content_type:
            ext = "wav"

        recording_id = f"REC-{uuid.uuid4().hex[:8].upper()}"
        recording_name = f"{job_sheet_id}-REC-{order}-{stamp}.{ext}"
        dest_dir = Path(self.settings.local_recordings_dir) / job_sheet_id
        dest_dir.mkdir(parents=True, exist_ok=True)
        dest_path = dest_dir / recording_name
        dest_path.write_bytes(data)

        # Local mock Drive fields — same column names as RecorderWebApp.js
        file_url = f"file://{dest_path}"
        drive_id = f"LOCAL-{recording_id}"

        row = {
            "recording_id": recording_id,
            "job_sheet_id": job_sheet_id,
            "recording_file_url": file_url,
            "recording_drive_file_id": drive_id,
            "recording_name": recording_name,
            "recording_order": order,
            "duration_seconds": duration_seconds,
            "transcript": "",
            "status": "Saved",
            "created_by": staff_email,
            "created_at": datetime.now(timezone.utc).isoformat(),
        }
        self.store.create_recording(row)
        self.store.append_sync_log(
            {
                "record_id": job_sheet_id,
                "target_system": "FieldOS_API",
                "status": "Success",
                "request_payload": {
                    "job_sheet_id": job_sheet_id,
                    "duration_seconds": duration_seconds,
                    "content_type": content_type,
                    "bytes": len(data),
                },
                "response_payload": {"recording_id": recording_id, "recording_order": order},
            }
        )

        processing_triggered = False
        processing_message = "Processing not requested."
        if trigger_processing:
            result = await self.apps_script.process_voice_dictation(job_sheet_id, staff_email, False)
            processing_triggered = str(result.get("status", "")).lower() == "success"
            processing_message = str(result.get("message", ""))
            if processing_triggered and self.settings.data_mode == "mock":
                self.store.update_job_status(
                    job_sheet_id,
                    {"processing_status": "Queued", "processing_error": ""},
                )

        log_extra(
            logger,
            20,
            "Recording saved",
            job_sheet_id=job_sheet_id,
            recording_id=recording_id,
            bytes=len(data),
            processing_triggered=processing_triggered,
        )

        return {
            "status": "Success",
            "message": "Recording saved.",
            "recording_id": recording_id,
            "recording_file_url": file_url,
            "recording_drive_file_id": drive_id,
            "recording_order": order,
            "processing_triggered": processing_triggered,
            "processing_message": processing_message,
        }

    async def trigger_process(self, job_sheet_id: str, staff_id: str, staff_email: str, force: bool) -> dict[str, Any]:
        self.get_job_for_staff(job_sheet_id, staff_id)
        result = await self.apps_script.process_voice_dictation(job_sheet_id, staff_email, force)
        if str(result.get("status", "")).lower() == "success" and self.settings.data_mode == "mock":
            self.store.update_job_status(job_sheet_id, {"processing_status": "Queued", "processing_error": ""})
        return result
