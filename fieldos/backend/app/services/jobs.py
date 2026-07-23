"""Job and recording orchestration — mock and apps_script modes."""

from __future__ import annotations

import uuid
from datetime import date, datetime, timedelta, timezone
from typing import Any, Union

from fastapi import HTTPException, UploadFile, status

from app.core.config import Settings
from app.core.logging import get_logger, log_extra
from app.services.apps_script import AppsScriptClient
from app.services.apps_script_repository import AppsScriptJobRepository
from app.services.mock_repository import MockJobRepository
from app.services.recording_files import (
    sanitize_invalid_reason,
    sanitize_recording_filename,
    validate_upload_file,
)

logger = get_logger(__name__)

Repo = Union[MockJobRepository, AppsScriptJobRepository]


def build_repository(settings: Settings) -> Repo:
    client = AppsScriptClient(settings)
    mode = (settings.data_mode or "mock").strip().lower()
    if mode == "mock":
        return MockJobRepository(settings, client)
    if mode == "apps_script":
        if not client.configured:
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail=(
                    "DATA_MODE=apps_script requires APPS_SCRIPT_WEBAPP_URL and "
                    "APPS_SCRIPT_WEBHOOK_SECRET."
                ),
            )
        return AppsScriptJobRepository(settings, client)
    raise HTTPException(
        status_code=status.HTTP_501_NOT_IMPLEMENTED,
        detail=f"Unsupported DATA_MODE='{settings.data_mode}'. Use mock or apps_script.",
    )


class JobService:
    def __init__(self, settings: Settings):
        self.settings = settings
        self.repo = build_repository(settings)

    def assumptions(self) -> list[str]:
        return self.repo.assumptions()

    def _day_count(self, days: int | None) -> int:
        return days if days is not None else self.settings.jobs_default_days

    def _since(self, days: int) -> date:
        return date.today() - timedelta(days=days)

    def _validate_upload(self, file: UploadFile, data: bytes) -> tuple[str, str, str]:
        min_bytes = int(getattr(self.settings, "min_recording_upload_bytes", 1024) or 1024)
        return validate_upload_file(
            file,
            data,
            min_bytes=min_bytes,
            max_bytes=self.settings.max_upload_bytes,
            max_mb=self.settings.max_upload_mb,
        )

    def _assert_not_processing(self, job: dict[str, Any]) -> None:
        if str(job.get("processing_status") or "").strip().lower() == "processing":
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="Cannot change recordings while the job is Processing.",
            )

    def _audit(self, action: str, *, staff_id: str, job_sheet_id: str, recording_id: str, **extra: Any) -> None:
        log_extra(
            logger,
            20,
            "Recording management audit",
            action=action,
            staff_id=staff_id,
            job_sheet_id=job_sheet_id,
            recording_id=recording_id,
            timestamp=datetime.now(timezone.utc).isoformat(),
            **extra,
        )

    async def list_mine(self, staff_id: str, days: int | None = None) -> tuple[list[dict[str, Any]], int]:
        day_count = self._day_count(days)
        if isinstance(self.repo, AppsScriptJobRepository):
            jobs = await self.repo.alist_jobs_for_staff(staff_id, day_count)
        else:
            jobs = self.repo.list_jobs_for_staff(staff_id, self._since(day_count), day_count)
        return jobs, day_count

    async def get_job_for_staff(self, job_sheet_id: str, staff_id: str) -> dict[str, Any]:
        if isinstance(self.repo, AppsScriptJobRepository):
            return await self.repo.aget_job_for_staff(job_sheet_id, staff_id)
        return self.repo.get_job_for_staff(job_sheet_id, staff_id)

    async def list_recordings(self, job_sheet_id: str, staff_id: str) -> list[dict[str, Any]]:
        if isinstance(self.repo, AppsScriptJobRepository):
            return await self.repo.alist_recordings(job_sheet_id, staff_id)
        return self.repo.list_recordings(job_sheet_id, staff_id)

    async def save_recording(
        self,
        job_sheet_id: str,
        staff_id: str,
        staff_email: str,
        file: UploadFile,
        duration_seconds: float,
        trigger_processing: bool,
    ) -> dict[str, Any]:
        await self.get_job_for_staff(job_sheet_id, staff_id)
        data = await file.read()
        content_type, ext, safe_original = self._validate_upload(file, data)

        stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        # Prefer job-scoped Drive name; keep sanitised original extension.
        recording_name = sanitize_recording_filename(
            f"{job_sheet_id}-REC-{stamp}.{ext}",
            fallback_ext=ext,
        )
        # If client supplied a meaningful original name, append stem hint in metadata only via name.
        if safe_original and safe_original.lower() != recording_name.lower():
            # Keep deterministic Drive/object name; original is reflected when extension differs only.
            recording_name = f"{job_sheet_id}-REC-{stamp}.{ext}"

        if isinstance(self.repo, MockJobRepository):
            order = self.repo.next_recording_order(job_sheet_id)
            recording_id = f"REC-{uuid.uuid4().hex[:8].upper()}"
            recording_name = f"{job_sheet_id}-REC-{order}-{stamp}.{ext}"
            row = {
                "recording_id": recording_id,
                "job_sheet_id": job_sheet_id,
                "recording_name": recording_name,
                "original_filename": safe_original,
                "recording_order": order,
                "duration_seconds": duration_seconds,
                "transcript": "",
                "status": "Saved",
                "created_by": staff_email,
                "created_at": datetime.now(timezone.utc).isoformat(),
            }
            saved = self.repo.create_recording_local(row, data, content_type)
        else:
            saved = await self.repo.register_recording_remote(
                job_sheet_id=job_sheet_id,
                staff_id=staff_id,
                staff_email=staff_email,
                file_bytes=data,
                content_type=content_type,
                duration_seconds=duration_seconds,
                recording_name=recording_name,
            )

        processing_triggered = False
        processing_message = "Processing not requested."
        if trigger_processing:
            result = await self.repo.trigger_process(job_sheet_id, staff_id, staff_email, False)
            processing_triggered = str(result.get("status", "")).lower() == "success"
            processing_message = str(result.get("message", ""))

        self._audit(
            "upload_recording",
            staff_id=staff_id,
            job_sheet_id=job_sheet_id,
            recording_id=str(saved.get("recording_id") or ""),
            bytes=len(data),
            mime=content_type,
            processing_triggered=processing_triggered,
            data_mode=self.settings.data_mode,
        )

        return {
            "status": "Success",
            "message": "Recording saved.",
            "recording_id": saved["recording_id"],
            "recording_file_url": saved.get("recording_file_url", ""),
            "recording_drive_file_id": saved.get("recording_drive_file_id", ""),
            "recording_order": int(saved.get("recording_order") or 0),
            "processing_triggered": processing_triggered,
            "processing_message": processing_message,
        }

    async def invalidate_recording(
        self,
        job_sheet_id: str,
        recording_id: str,
        staff_id: str,
        reason: str | None,
    ) -> dict[str, Any]:
        safe_reason = sanitize_invalid_reason(reason)
        job = await self.get_job_for_staff(job_sheet_id, staff_id)
        self._assert_not_processing(job)

        if isinstance(self.repo, MockJobRepository):
            result = self.repo.invalidate_recording_local(
                job_sheet_id, staff_id, recording_id, safe_reason
            )
        else:
            result = await self.repo.ainvalidate_recording(
                job_sheet_id=job_sheet_id,
                staff_id=staff_id,
                recording_id=recording_id,
                reason=safe_reason,
            )

        self._audit(
            "invalidate_recording",
            staff_id=staff_id,
            job_sheet_id=job_sheet_id,
            recording_id=recording_id,
            outcome="success",
            idempotent=bool(result.get("idempotent")),
        )
        return {
            "status": "success",
            "job_sheet_id": job_sheet_id,
            "recording_id": recording_id,
            "recording_status": "Invalid",
            "invalid_reason": str(result.get("invalid_reason") or safe_reason),
            "message": "Recording marked Invalid.",
        }

    async def delete_recording(
        self,
        job_sheet_id: str,
        recording_id: str,
        staff_id: str,
    ) -> dict[str, Any]:
        job = await self.get_job_for_staff(job_sheet_id, staff_id)
        self._assert_not_processing(job)

        if isinstance(self.repo, MockJobRepository):
            result = self.repo.delete_recording_local(job_sheet_id, staff_id, recording_id)
            outcome = str(result.get("drive_outcome") or "deleted")
        else:
            result = await self.repo.adelete_recording(
                job_sheet_id=job_sheet_id,
                staff_id=staff_id,
                recording_id=recording_id,
            )
            outcome = str(result.get("drive_outcome") or "deleted")

        self._audit(
            "delete_recording",
            staff_id=staff_id,
            job_sheet_id=job_sheet_id,
            recording_id=recording_id,
            outcome=outcome,
        )
        return {
            "status": "success",
            "job_sheet_id": job_sheet_id,
            "recording_id": recording_id,
            "recording_status": "Deleted",
            "message": "Recording deleted.",
        }

    async def trigger_process(
        self,
        job_sheet_id: str,
        staff_id: str,
        staff_email: str,
        force: bool,
    ) -> dict[str, Any]:
        return await self.repo.trigger_process(job_sheet_id, staff_id, staff_email, force)
