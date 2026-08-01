"""Create Job from Recording — upload, extract, review, create."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Optional

from fastapi import HTTPException, UploadFile, status

from app.core.config import Settings
from app.core.logging import get_logger, log_extra
from app.core.roles import is_manager_or_admin, normalize_role
from app.services import openai_http
from app.services.drive_upload import drive_upload_configured, upload_recording_to_drive
from app.services.new_job_dictation_math import (
    NEW_JOB_EXTRACTION_SYSTEM_PROMPT,
    SOURCE_BROWSER_RECORDING,
    SOURCE_UPLOADED_FILE,
    STATUS_CREATE_FAILED,
    STATUS_EXTRACTION_FAILED,
    STATUS_JOB_CREATED,
    STATUS_PROCESSING,
    STATUS_REVIEW_REQUIRED,
    STATUS_TRANSCRIPTION_FAILED,
    STATUS_UPLOADED,
    apply_relative_dates_to_extraction,
    build_match_report,
    build_sheet_job_fields,
    changed_fields,
    coerce_extraction,
    empty_extraction,
    payload_hash,
    trim_text,
    validate_reviewed_job,
)
from app.services.new_job_dictation_store import NewJobDictationStore
from app.services.recording_files import validate_upload_file

logger = get_logger(__name__)

# Staging fixture used when OpenAI is unavailable in mock / tests.
_MOCK_TRANSCRIPT = (
    "Create a job for Kat and James Dykes at their existing project. "
    "Schedule it for next Tuesday. Assign Alex. The job is to inspect the garden "
    "beds and prepare a maintenance list. Add a note to check irrigation."
)


class NewJobDictationService:
    def __init__(self, settings: Settings, repo: Any = None, apps_script: Any = None):
        self.settings = settings
        self.repo = repo
        self.apps_script = apps_script
        root = Path(getattr(settings, "new_job_dictations_dir", "") or "").expanduser()
        if not root.is_absolute():
            root = Path.cwd() / root
        self.store = NewJobDictationStore(root)

    def _require_manager(self, actor_role: str) -> str:
        role = normalize_role(actor_role)
        if not is_manager_or_admin(role):
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Forbidden: manager or admin role required.",
            )
        return role

    async def list_masters(self) -> dict[str, Any]:
        mode = (self.settings.data_mode or "mock").strip().lower()
        if mode == "apps_script" and self.apps_script is not None:
            try:
                return await self.apps_script.list_job_create_masters({})
            except Exception as exc:
                log_extra(logger, 30, "list_job_create_masters failed", error=type(exc).__name__)
        return {
            "customers": [
                {"customer_id": "CUST-6002C0A0", "customer_name": "Kat and James Dykes"},
                {"customer_id": "CUST-8BC1502B", "customer_name": "Babidge"},
            ],
            "projects": [
                {
                    "project_id": "PROJ-6002C0A0",
                    "project_name": "Kat and James Dykes",
                    "customer_id": "CUST-6002C0A0",
                },
                {
                    "project_id": "PROJ-8BC1502B",
                    "project_name": "Babidge",
                    "customer_id": "CUST-8BC1502B",
                },
            ],
            "staff": [
                {"staff_id": "STAFF-DEMO001", "staff_name": "Alex Technician"},
                {"staff_id": self.settings.demo_manager_id, "staff_name": self.settings.demo_manager_name},
            ],
        }

    async def upload(
        self,
        *,
        file: UploadFile,
        staff_id: str,
        staff_name: str,
        actor_role: str,
        duration_seconds: float = 0,
        source: str = SOURCE_BROWSER_RECORDING,
    ) -> dict[str, Any]:
        self._require_manager(actor_role)
        data = await file.read()
        min_bytes = int(getattr(self.settings, "min_recording_upload_bytes", 1024) or 1024)
        max_mb = int(getattr(self.settings, "max_upload_mb", 25) or 25)
        max_bytes = max_mb * 1024 * 1024
        content_type, _ext, recording_name = validate_upload_file(
            file,
            data,
            min_bytes=min_bytes,
            max_bytes=max_bytes,
            max_mb=max_mb,
        )

        drive_file_id = ""
        drive_file_url = ""
        mode = (self.settings.data_mode or "mock").strip().lower()
        if mode == "apps_script" and drive_upload_configured(self.settings):
            drive = upload_recording_to_drive(
                self.settings,
                filename=recording_name,
                data=data,
                mime_type=content_type,
            )
            drive_file_id = str(drive.get("file_id") or "")
            drive_file_url = str(drive.get("web_view_link") or drive.get("file_url") or "")

        src = trim_text(source)
        if src not in (SOURCE_UPLOADED_FILE, SOURCE_BROWSER_RECORDING):
            src = SOURCE_BROWSER_RECORDING

        row = self.store.create(
            staff_id=staff_id,
            staff_name=staff_name,
            filename=recording_name,
            mime_type=content_type,
            size=len(data),
            duration_seconds=duration_seconds,
            drive_file_id=drive_file_id,
            drive_file_url=drive_file_url,
            source=src,
        )
        ext = Path(recording_name).suffix or ".webm"
        audio_path = self.store.audio_path(row["recording_id"], ext)
        audio_path.write_bytes(data)
        row["audio_path"] = str(audio_path)
        self.store.save(row)
        self.store.append_audit(
            row,
            {
                "event": "uploaded",
                "by": staff_id,
                "byte_size": len(data),
                "drive_file_id": drive_file_id,
            },
        )
        log_extra(
            logger,
            20,
            "New job recording uploaded",
            recording_id=row["recording_id"],
            staff_id=staff_id,
            byte_size=len(data),
            has_drive=bool(drive_file_id),
        )
        return self._public(row)

    def get(self, recording_id: str, *, actor_role: str) -> dict[str, Any]:
        self._require_manager(actor_role)
        row = self.store.get(recording_id)
        if not row:
            raise HTTPException(status_code=404, detail="New-job recording not found.")
        return self._public(row)

    async def process(self, recording_id: str, *, staff_id: str, actor_role: str) -> dict[str, Any]:
        self._require_manager(actor_role)
        row = self.store.get(recording_id)
        if not row:
            raise HTTPException(status_code=404, detail="New-job recording not found.")
        if row.get("job_sheet_id"):
            raise HTTPException(
                status_code=409,
                detail="Recording already created a job. Use Create Another Job explicitly.",
            )

        row["status"] = STATUS_PROCESSING
        row["failure_reason"] = ""
        row["processing_version"] = int(row.get("processing_version") or 1) + 1
        self.store.save(row)

        try:
            transcript = await self._transcribe(row)
            extraction = await self._extract(row, transcript)
            extraction = apply_relative_dates_to_extraction(
                extraction, recording_created_at=row.get("created_at")
            )
            masters = await self.list_masters()
            match_report = build_match_report(
                extraction.get("job") or {},
                customers=masters.get("customers") or [],
                projects=masters.get("projects") or [],
                staff=masters.get("staff") or [],
            )
            row["transcript"] = extraction.get("transcript") or transcript
            row["extraction"] = extraction
            row["match_report"] = match_report
            row["status"] = STATUS_REVIEW_REQUIRED
            self.store.save(row)
            self.store.append_audit(
                row,
                {
                    "event": "processed",
                    "by": staff_id,
                    "processing_version": row["processing_version"],
                    "provider": extraction.get("provider"),
                    "model": extraction.get("model"),
                },
            )
        except openai_http.OpenAIHttpError as exc:
            row["status"] = STATUS_TRANSCRIPTION_FAILED
            row["failure_reason"] = str(exc)
            self.store.save(row)
            self.store.append_audit(row, {"event": "transcription_failed", "by": staff_id, "error": str(exc)})
            raise HTTPException(status_code=502, detail=str(exc)) from exc
        except HTTPException:
            raise
        except Exception as exc:
            row["status"] = STATUS_EXTRACTION_FAILED
            row["failure_reason"] = str(exc)
            self.store.save(row)
            self.store.append_audit(row, {"event": "extraction_failed", "by": staff_id, "error": type(exc).__name__})
            raise HTTPException(status_code=502, detail=f"Extraction failed: {exc}") from exc

        return self._public(row)

    async def create_job(
        self,
        *,
        recording_id: str,
        expected_processing_version: int,
        job: dict[str, Any],
        idempotency_key: str,
        staff_id: str,
        staff_name: str,
        actor_role: str,
        create_another: bool = False,
    ) -> dict[str, Any]:
        self._require_manager(actor_role)
        key = trim_text(idempotency_key)
        if not key:
            raise HTTPException(status_code=422, detail="idempotency_key is required.")

        existing = self.store.find_by_idempotency(key)
        hash_now = payload_hash(job, recording_id)
        if existing:
            prev_hash = trim_text((existing.get("idempotency_payload_hash") or ""))
            if prev_hash and prev_hash != hash_now:
                raise HTTPException(
                    status_code=409,
                    detail="Conflict: idempotency key reused with a different reviewed payload.",
                )
            # Same key + same payload → return existing job
            return await self._load_created_job(existing)

        row = self.store.get(recording_id)
        if not row:
            raise HTTPException(status_code=404, detail="New-job recording not found.")
        if row.get("status") != STATUS_REVIEW_REQUIRED and not (
            create_another and row.get("status") == STATUS_JOB_CREATED
        ):
            raise HTTPException(
                status_code=409,
                detail=f"Recording must be in ReviewRequired (status={row.get('status')}).",
            )
        if int(row.get("processing_version") or 0) != int(expected_processing_version):
            raise HTTPException(
                status_code=409,
                detail="Conflict: processing version changed. Reload review and try again.",
            )
        if row.get("job_sheet_id") and not create_another:
            raise HTTPException(
                status_code=409,
                detail="Recording already created a job. Pass create_another=true to create another.",
            )

        ok, err = validate_reviewed_job(job)
        if not ok:
            raise HTTPException(status_code=422, detail=err)

        sheet_fields = build_sheet_job_fields(job, created_by_staff_id=staff_id)
        proposed = (row.get("extraction") or {}).get("job") or {}
        audit_changes = changed_fields(proposed, job)

        body = {
            "recording_id": recording_id,
            "idempotency_key": key,
            "payload_hash": hash_now,
            "staff_id": staff_id,
            "actor_staff_id": staff_id,
            "created_by": staff_id,
            "created_by_name": staff_name,
            "job_fields": sheet_fields,
            "reviewed_job": job,
            "transcript": row.get("transcript") or "",
            "recording_drive_file_id": row.get("recording_drive_file_id") or "",
            "recording_file_url": row.get("recording_file_url") or "",
            "recording_name": row.get("filename") or "",
            "duration_seconds": row.get("duration_seconds") or 0,
            "mime_type": row.get("mime_type") or "",
            "source": row.get("source") or "",
            "extraction_confidence": (row.get("extraction") or {}).get("confidence") or {},
            "changed_fields": audit_changes,
            "model": (row.get("extraction") or {}).get("model") or "",
            "provider": (row.get("extraction") or {}).get("provider") or "",
        }

        mode = (self.settings.data_mode or "mock").strip().lower()
        try:
            if mode == "apps_script" and self.apps_script is not None:
                result = await self.apps_script.create_job_sheet_from_recording(body)
            else:
                result = self._mock_create(body)
        except HTTPException as exc:
            row["status"] = STATUS_CREATE_FAILED
            row["failure_reason"] = str(exc.detail)
            self.store.save(row)
            raise
        except Exception as exc:
            row["status"] = STATUS_CREATE_FAILED
            row["failure_reason"] = str(exc)
            self.store.save(row)
            self.store.append_audit(row, {"event": "create_failed", "by": staff_id, "error": type(exc).__name__})
            raise HTTPException(status_code=502, detail=f"Create job failed: {exc}") from exc

        delivery = result.get("job") or result.get("delivery") or result
        job_sheet_id = trim_text((delivery or {}).get("job_sheet_id"))
        if not job_sheet_id:
            raise HTTPException(status_code=502, detail="Create job did not return job_sheet_id.")

        from datetime import datetime, timezone

        row["job_sheet_id"] = job_sheet_id
        row["status"] = STATUS_JOB_CREATED
        row["idempotency_key"] = key
        row["idempotency_payload_hash"] = hash_now
        row["created_job_by"] = staff_id
        row["created_job_at"] = datetime.now(timezone.utc).isoformat()
        row["reviewed_by"] = staff_id
        row["reviewed_at"] = row["created_job_at"]
        row["failure_reason"] = ""
        self.store.save(row)
        self.store.append_audit(
            row,
            {
                "event": "job_created",
                "by": staff_id,
                "job_sheet_id": job_sheet_id,
                "changed_fields": audit_changes,
            },
        )
        return {
            "job": delivery,
            "recording_id": recording_id,
            "link": result.get("link"),
            "idempotent": bool(result.get("idempotent")),
            "draft": self._public(row),
        }

    async def _load_created_job(self, row: dict[str, Any]) -> dict[str, Any]:
        job_sheet_id = trim_text(row.get("job_sheet_id"))
        mode = (self.settings.data_mode or "mock").strip().lower()
        job = {"job_sheet_id": job_sheet_id}
        if mode == "apps_script" and self.repo is not None and hasattr(self.repo, "aget_job_detail"):
            try:
                detail = await self.repo.aget_job_detail(
                    job_sheet_id, row.get("created_job_by") or row.get("created_by"), "manager"
                )
                job = detail.get("job") or job
            except Exception:
                pass
        elif self.repo is not None and hasattr(self.repo, "get_job"):
            try:
                job = self.repo.get_job(job_sheet_id) or job
            except Exception:
                pass
        return {
            "job": job,
            "recording_id": row.get("recording_id"),
            "link": {"job_sheet_id": job_sheet_id, "recording_id": row.get("recording_id")},
            "idempotent": True,
            "draft": self._public(row),
        }

    def _mock_create(self, body: dict[str, Any]) -> dict[str, Any]:
        import uuid
        from datetime import datetime, timezone

        job_sheet_id = f"JS-{uuid.uuid4().hex[:8].upper()}"
        fields = body.get("job_fields") or {}
        job = {
            "job_sheet_id": job_sheet_id,
            "staff_id": fields.get("staff_id"),
            "date": fields.get("date"),
            "project_id": fields.get("project_id"),
            "project_name": fields.get("project_id"),
            "customer_name": (body.get("reviewed_job") or {}).get("customer_name") or "",
            "manager_notes": fields.get("manager_notes"),
            "processing_status": "",
            "approval_status": fields.get("approval_status") or "Pending Review",
            "created_at": datetime.now(timezone.utc).isoformat(),
        }
        if self.repo is not None and hasattr(self.repo, "store"):
            store = getattr(self.repo, "store", None)
            if store is not None and hasattr(store, "jobs"):
                store.jobs[job_sheet_id] = dict(job)
        link = {
            "link_id": f"JRL-{uuid.uuid4().hex[:8].upper()}",
            "job_sheet_id": job_sheet_id,
            "recording_id": body.get("recording_id"),
            "transcript_id": "",
            "created_at": job["created_at"],
            "created_by": body.get("created_by"),
        }
        return {"job": job, "link": link, "idempotent": False}

    async def _transcribe(self, row: dict[str, Any]) -> str:
        mode = (self.settings.data_mode or "mock").strip().lower()
        audio_path = Path(str(row.get("audio_path") or ""))
        data = audio_path.read_bytes() if audio_path.is_file() else b""
        if mode != "apps_script" or not openai_http.openai_configured(self.settings):
            return _MOCK_TRANSCRIPT
        return await openai_http.whisper_transcribe(
            self.settings,
            filename=str(row.get("filename") or "recording.webm"),
            mime_type=str(row.get("mime_type") or "audio/webm"),
            data=data,
        )

    async def _extract(self, row: dict[str, Any], transcript: str) -> dict[str, Any]:
        mode = (self.settings.data_mode or "mock").strip().lower()
        if mode != "apps_script" or not openai_http.openai_configured(self.settings):
            extraction = coerce_extraction(
                {
                    "transcript": transcript,
                    "job": {
                        "customer_name": "Kat and James Dykes",
                        "project_name": "Kat and James Dykes",
                        "job_title": "Garden bed inspection",
                        "job_description": "Inspect the garden beds and prepare a maintenance list.",
                        "scheduled_date": "next Tuesday",
                        "scheduled_time": "",
                        "assigned_staff_names": ["Alex"],
                        "site_address": "",
                        "contact_name": "",
                        "contact_phone": "",
                        "priority": "",
                        "status": "Scheduled",
                        "notes": "Check irrigation.",
                    },
                    "confidence": {
                        "customer_name": 0.9,
                        "project_name": 0.85,
                        "scheduled_date": 0.8,
                        "assigned_staff_names": 0.7,
                        "site_address": 0.0,
                    },
                    "warnings": [],
                    "unresolved": [],
                    "relative_date_phrases": ["next Tuesday"],
                    "provider": "mock",
                    "model": "mock-extractor",
                }
            )
            return extraction

        parsed, model = await openai_http.chat_json(
            self.settings,
            system_prompt=NEW_JOB_EXTRACTION_SYSTEM_PROMPT,
            user_prompt=f"Transcript:\n{transcript}",
        )
        extraction = coerce_extraction(parsed)
        extraction["transcript"] = extraction.get("transcript") or transcript
        extraction["provider"] = "openai"
        extraction["model"] = model
        return extraction

    def _public(self, row: dict[str, Any]) -> dict[str, Any]:
        # Never expose local filesystem paths to the client.
        return {
            "recording_id": row.get("recording_id"),
            "source": row.get("source"),
            "status": row.get("status"),
            "filename": row.get("filename"),
            "mime_type": row.get("mime_type"),
            "byte_size": row.get("byte_size"),
            "duration_seconds": row.get("duration_seconds"),
            "recording_drive_file_id": row.get("recording_drive_file_id"),
            "recording_file_url": row.get("recording_file_url"),
            "created_by": row.get("created_by"),
            "created_by_name": row.get("created_by_name"),
            "created_at": row.get("created_at"),
            "updated_at": row.get("updated_at"),
            "processing_version": row.get("processing_version"),
            "processing_type": row.get("processing_type"),
            "transcript": row.get("transcript") or "",
            "extraction": row.get("extraction") or empty_extraction(),
            "match_report": row.get("match_report") or {},
            "job_sheet_id": row.get("job_sheet_id") or "",
            "failure_reason": row.get("failure_reason") or "",
            "reviewed_by": row.get("reviewed_by") or "",
            "created_job_by": row.get("created_job_by") or "",
        }
