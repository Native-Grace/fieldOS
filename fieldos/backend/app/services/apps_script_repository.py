"""Apps Script-backed job repository (DATA_MODE=apps_script)."""

from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Any

from fastapi import HTTPException

from app.core.config import Settings
from app.services.apps_script import AppsScriptClient, AppsScriptError
from app.services.drive_upload import delete_drive_file, upload_recording_to_drive

APPS_SCRIPT_ASSUMPTIONS = [
    "DATA_MODE=apps_script reads/writes via Apps Script gateway actions (list/detail/register/process).",
    "tbl_job_sheets.project_id stores legacy text labels; FieldOS resolves project_name (and customer_name when a matching master exists). Unmatched labels fall back to project_name with blank customer_name.",
    "Audio uploads go to Drive from FastAPI, then register_recording; large base64 is never posted to Apps Script.",
    "process_voice_dictation is the confirmed production enqueue action.",
]


def _raise_from_apps(exc: AppsScriptError) -> None:
    code = exc.http_status or 502
    message = str(exc) or "Apps Script error"
    lower = message.lower()
    if code == 403 or "forbidden" in lower:
        raise HTTPException(status_code=403, detail="Job is not assigned to this staff member") from exc
    if code == 404 or "not found" in lower:
        detail = "Recording not found for this job." if "recording" in lower else "Job sheet not found"
        raise HTTPException(status_code=404, detail=detail) from exc
    if code == 409 or "processing" in lower:
        raise HTTPException(
            status_code=409,
            detail="Cannot change recordings while the job is Processing.",
        ) from exc
    if code == 504:
        raise HTTPException(status_code=504, detail="Apps Script request timed out") from exc
    if code == 503:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    # Prefer safe generic message — never leak Drive IDs from Apps Script text.
    safe = message
    if "drive" in lower and ("file" in lower or "cleanup" in lower):
        safe = "Could not delete recording file from Drive. Recording was not removed."
    raise HTTPException(status_code=502, detail=safe) from exc


class AppsScriptJobRepository:
    def __init__(self, settings: Settings, apps_script: AppsScriptClient | None = None):
        self.settings = settings
        self.apps_script = apps_script or AppsScriptClient(settings)

    def assumptions(self) -> list[str]:
        return list(APPS_SCRIPT_ASSUMPTIONS)

    def _job_row(self, job: dict[str, Any]) -> dict[str, Any]:
        """Normalize gateway job objects for FieldOS JobSummary.

        FieldOSGateway._normalizeJob always emits API fields:
        job_date, project_name, customer_name, assigned_staff_id
        (values sourced from live sheet columns staff_id/date/project_id/…).
        customer_name may be blank — that is valid.
        """
        date_val = job.get("job_date")
        if date_val in (None, ""):
            date_val = job.get(self.settings.job_date_column, "")
        project_val = job.get("project_name")
        if project_val in (None, ""):
            project_val = job.get(self.settings.job_project_column, "")
        customer_val = job.get("customer_name")
        if customer_val is None:
            customer_val = job.get(self.settings.job_customer_column, "")
        staff_val = job.get("assigned_staff_id")
        if staff_val in (None, ""):
            staff_val = job.get(self.settings.job_assignment_column, "")

        row = dict(job)
        row["job_date"] = date_val if date_val is not None else ""
        row["project_name"] = "" if project_val is None else str(project_val)
        row["customer_name"] = "" if customer_val is None else str(customer_val)
        row["assigned_staff_id"] = "" if staff_val is None else str(staff_val)
        # Mirror onto configured sheet keys for any remaining readers.
        row[self.settings.job_date_column] = row["job_date"]
        row[self.settings.job_project_column] = row["project_name"]
        row[self.settings.job_customer_column] = row["customer_name"]
        row[self.settings.job_assignment_column] = row["assigned_staff_id"]
        return row

    async def alist_jobs_for_staff(self, staff_id: str, days: int) -> list[dict[str, Any]]:
        try:
            result = await self.apps_script.list_jobs_for_staff(staff_id, days)
        except AppsScriptError as exc:
            _raise_from_apps(exc)
            raise
        data = result.get("data") or {}
        jobs = data.get("jobs")
        if not isinstance(jobs, list):
            raise HTTPException(status_code=502, detail="Apps Script returned no jobs list")
        return [self._job_row(j) for j in jobs if isinstance(j, dict)]

    async def aget_job_for_staff(self, job_sheet_id: str, staff_id: str) -> dict[str, Any]:
        try:
            result = await self.apps_script.get_job_detail(job_sheet_id, staff_id)
        except AppsScriptError as exc:
            _raise_from_apps(exc)
            raise
        data = result.get("data") or {}
        job = data.get("job")
        if not isinstance(job, dict):
            raise HTTPException(status_code=502, detail="Apps Script returned no job")
        return self._job_row(job)

    async def alist_recordings(self, job_sheet_id: str, staff_id: str) -> list[dict[str, Any]]:
        try:
            result = await self.apps_script.get_job_detail(job_sheet_id, staff_id)
        except AppsScriptError as exc:
            _raise_from_apps(exc)
            raise
        data = result.get("data") or {}
        recordings = data.get("recordings") or []
        if not isinstance(recordings, list):
            raise HTTPException(status_code=502, detail="Apps Script returned invalid recordings")
        return [r for r in recordings if isinstance(r, dict)]

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
        drive = upload_recording_to_drive(
            self.settings,
            filename=recording_name,
            data=file_bytes,
            mime_type=content_type,
        )
        recording_id = f"REC-{uuid.uuid4().hex[:8].upper()}"
        try:
            result = await self.apps_script.register_recording(
                {
                    "job_sheet_id": job_sheet_id,
                    "staff_id": staff_id,
                    "recording_id": recording_id,
                    "recording_drive_file_id": drive["recording_drive_file_id"],
                    "recording_file_url": drive["recording_file_url"],
                    "recording_name": recording_name,
                    "duration_seconds": duration_seconds,
                    "created_by": staff_email,
                    "mime_type": content_type,
                }
            )
        except AppsScriptError as exc:
            # Drive succeeded but sheet register failed — remove orphan file best-effort.
            delete_drive_file(self.settings, drive.get("recording_drive_file_id"))
            _raise_from_apps(exc)
            raise

        data = result.get("data") or {}
        return {
            "recording_id": str(data.get("recording_id") or recording_id),
            "job_sheet_id": job_sheet_id,
            "recording_file_url": str(data.get("recording_file_url") or drive["recording_file_url"]),
            "recording_drive_file_id": str(
                data.get("recording_drive_file_id") or drive["recording_drive_file_id"]
            ),
            "recording_name": recording_name,
            "recording_order": int(data.get("recording_order") or 0),
            "duration_seconds": duration_seconds,
            "transcript": "",
            "status": str(data.get("status") or "Saved"),
            "created_by": staff_email,
            "created_at": datetime.now(timezone.utc).isoformat(),
        }

    async def trigger_process(
        self,
        job_sheet_id: str,
        staff_id: str,
        staff_email: str,
        force_reprocess: bool,
    ) -> dict[str, Any]:
        await self.aget_job_for_staff(job_sheet_id, staff_id)
        return await self.apps_script.process_voice_dictation(job_sheet_id, staff_email, force_reprocess)

    async def ainvalidate_recording(
        self,
        *,
        job_sheet_id: str,
        staff_id: str,
        recording_id: str,
        reason: str,
    ) -> dict[str, Any]:
        try:
            result = await self.apps_script.invalidate_recording(
                {
                    "job_sheet_id": job_sheet_id,
                    "staff_id": staff_id,
                    "actor_staff_id": staff_id,
                    "recording_id": recording_id,
                    "reason": reason,
                }
            )
        except AppsScriptError as exc:
            _raise_from_apps(exc)
            raise
        data = result.get("data") if isinstance(result.get("data"), dict) else {}
        return {
            "recording_id": recording_id,
            "job_sheet_id": job_sheet_id,
            "recording_status": str(data.get("recording_status") or "Invalid"),
            "invalid_reason": str(data.get("invalid_reason") or reason),
            "idempotent": bool(data.get("idempotent")),
        }

    async def adelete_recording(
        self,
        *,
        job_sheet_id: str,
        staff_id: str,
        recording_id: str,
    ) -> dict[str, Any]:
        try:
            result = await self.apps_script.delete_recording(
                {
                    "job_sheet_id": job_sheet_id,
                    "staff_id": staff_id,
                    "actor_staff_id": staff_id,
                    "recording_id": recording_id,
                }
            )
        except AppsScriptError as exc:
            _raise_from_apps(exc)
            raise
        data = result.get("data") if isinstance(result.get("data"), dict) else {}
        return {
            "recording_id": recording_id,
            "job_sheet_id": job_sheet_id,
            "recording_status": "Deleted",
            "drive_outcome": str(data.get("drive_outcome") or "deleted"),
        }
