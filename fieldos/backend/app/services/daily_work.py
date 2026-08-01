"""Daily Work Job Sheet — multi-recording completed-work sessions."""

from __future__ import annotations

import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

from fastapi import HTTPException, UploadFile, status

from app.core.config import Settings
from app.core.logging import get_logger, log_extra
from app.core.roles import is_manager_or_admin, normalize_role
from app.services import openai_http
from app.services.daily_work_math import (
    CREATE_COMPLETED_JOB_ACTION,
    DAILY_WORK_EXTRACTION_SYSTEM_PROMPT,
    DEFAULT_MAX_RECORDINGS,
    PROCESSING_TYPE,
    REC_FAILED,
    REC_PROCESSED,
    REC_PROCESSING,
    REC_SAVED,
    SOURCE_BROWSER,
    SOURCE_UPLOAD,
    STATUS_CREATE_FAILED,
    STATUS_EXTRACTION_FAILED,
    STATUS_JOB_CREATED,
    STATUS_PROCESSING,
    STATUS_RECORDING,
    STATUS_REVIEW_REQUIRED,
    STATUS_TRANSCRIPTION_FAILED,
    aggregate_transcripts,
    build_sheet_job_fields,
    coerce_extraction,
    dict_keys,
    empty_extraction,
    empty_job_sheet,
    extract_completed_create_idempotent,
    extract_completed_create_links,
    extract_completed_job_payload,
    parse_completed_job_create_lookup,
    payload_hash,
    resolve_completed_job_sheet_id,
    sort_recordings,
    sydney_today,
    trim_text,
    validate_reviewed_job_sheet,
)
from app.services.apps_script import AppsScriptError
from app.services.daily_work_store import DailyWorkStore
from app.services.drive_upload import drive_upload_configured, upload_recording_to_drive
from app.services.recording_files import validate_upload_file

logger = get_logger(__name__)

_MOCK_SEGMENTS = {
    1: "We arrived at nine and pruned the front hedges and weeded the entry garden.",
    2: "We found a broken irrigation joiner near the driveway and replaced it with a nineteen mil joiner.",
    3: (
        "Removed the green waste. The rear tap is still leaking, so we need to return and "
        "repair that. The client also wants a quote for planting along the fence."
    ),
}


class DailyWorkService:
    def __init__(self, settings: Settings, repo: Any = None, apps_script: Any = None):
        self.settings = settings
        self.repo = repo
        self.apps_script = apps_script
        root = Path(getattr(settings, "daily_work_sessions_dir", "") or "").expanduser()
        if not str(getattr(settings, "daily_work_sessions_dir", "") or "").strip():
            root = Path(getattr(settings, "new_job_dictations_dir", "./data/new_job_dictations"))
            root = Path(str(root)).expanduser() / "daily_work"
        if not root.is_absolute():
            root = Path.cwd() / root
        self.store = DailyWorkStore(root)
        self.max_recordings = int(
            getattr(settings, "daily_work_max_recordings", DEFAULT_MAX_RECORDINGS) or DEFAULT_MAX_RECORDINGS
        )

    def _role(self, actor_role: str) -> str:
        return normalize_role(actor_role)

    def _require_auth_access(self, session: dict[str, Any], staff_id: str, actor_role: str) -> None:
        role = self._role(actor_role)
        if is_manager_or_admin(role):
            return
        if trim_text(session.get("created_by")) == trim_text(staff_id):
            return
        if trim_text(staff_id) in (session.get("staff_ids") or []):
            return
        raise HTTPException(status_code=403, detail="Forbidden: not your daily work session.")

    def _require_create_role(self, actor_role: str) -> str:
        # Staff may submit completed sheets (Pending Review); managers/admins too.
        return self._role(actor_role)

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
                {
                    "staff_id": self.settings.demo_manager_id,
                    "staff_name": self.settings.demo_manager_name,
                },
            ],
        }

    def create_session(
        self,
        *,
        staff_id: str,
        staff_name: str,
        actor_role: str,
        body: dict[str, Any],
    ) -> dict[str, Any]:
        self._require_create_role(actor_role)
        staff_ids = body.get("staff_ids") or [staff_id]
        if not is_manager_or_admin(self._role(actor_role)):
            # Staff cannot create sessions on behalf of unrelated staff.
            staff_ids = [staff_id]
        row = self.store.create_session(
            created_by=staff_id,
            created_by_name=staff_name,
            work_date=trim_text(body.get("work_date")) or sydney_today().isoformat(),
            staff_ids=staff_ids,
            staff_names=body.get("staff_names") or ([staff_name] if staff_name else []),
            project_id=trim_text(body.get("project_id")),
            project_name=trim_text(body.get("project_name")),
            customer_name=trim_text(body.get("customer_name")),
            site_address=trim_text(body.get("site_address")),
            starting_note=trim_text(body.get("starting_note")),
        )
        self.store.append_audit(row, {"event": "session_created", "by": staff_id})
        return self._public(row)

    def list_sessions(
        self, *, staff_id: str, actor_role: str, open_only: bool = True
    ) -> list[dict[str, Any]]:
        role = self._role(actor_role)
        rows = self.store.list_sessions(
            created_by=staff_id,
            open_only=open_only,
            actor_is_manager=is_manager_or_admin(role),
        )
        return [self._public_summary(r) for r in rows]

    def get_session(self, work_session_id: str, *, staff_id: str, actor_role: str) -> dict[str, Any]:
        row = self.store.get(work_session_id)
        if not row:
            raise HTTPException(status_code=404, detail="Daily work session not found.")
        self._require_auth_access(row, staff_id, actor_role)
        return self._public(row)

    def patch_session(
        self,
        work_session_id: str,
        *,
        staff_id: str,
        actor_role: str,
        body: dict[str, Any],
        expected_version: Optional[int] = None,
    ) -> dict[str, Any]:
        row = self.store.get(work_session_id)
        if not row:
            raise HTTPException(status_code=404, detail="Daily work session not found.")
        self._require_auth_access(row, staff_id, actor_role)
        if row.get("status") == STATUS_JOB_CREATED:
            raise HTTPException(status_code=409, detail="Session already created a job sheet.")
        if expected_version is not None and int(row.get("version") or 0) != int(expected_version):
            raise HTTPException(status_code=409, detail="Conflict: session version changed.")
        for key in (
            "work_date",
            "project_id",
            "project_name",
            "customer_name",
            "site_address",
            "starting_note",
        ):
            if key in body:
                row[key] = trim_text(body.get(key))
        if "staff_ids" in body and is_manager_or_admin(self._role(actor_role)):
            row["staff_ids"] = [trim_text(x) for x in (body.get("staff_ids") or []) if trim_text(x)]
        if "staff_names" in body:
            row["staff_names"] = [trim_text(x) for x in (body.get("staff_names") or []) if trim_text(x)]
        if "reviewed_job_sheet" in body and isinstance(body.get("reviewed_job_sheet"), dict):
            extraction = row.get("extraction") or empty_extraction(
                row.get("work_session_id") or "", row.get("work_date") or ""
            )
            extraction["job_sheet"] = body["reviewed_job_sheet"]
            row["extraction"] = extraction
            if row.get("status") not in (STATUS_JOB_CREATED,):
                row["status"] = STATUS_REVIEW_REQUIRED
        row["version"] = int(row.get("version") or 1) + 1
        self.store.save(row)
        return self._public(row)

    def get_recording_audio(
        self, work_session_id: str, recording_id: str, *, staff_id: str, actor_role: str
    ) -> tuple[Path, str, str]:
        """Return (path, mime_type, filename) for playback after refresh/resume."""
        row = self.store.get(work_session_id)
        if not row:
            raise HTTPException(status_code=404, detail="Daily work session not found.")
        self._require_auth_access(row, staff_id, actor_role)
        rec = next(
            (
                r
                for r in (row.get("recordings") or [])
                if trim_text(r.get("recording_id")) == trim_text(recording_id)
            ),
            None,
        )
        if not rec:
            raise HTTPException(status_code=404, detail="Recording not found on session.")
        path = Path(str(rec.get("audio_path") or ""))
        if not path.is_file():
            # Fallback by id under audio dir
            matches = list((self.store.root / "audio").glob(f"{recording_id}.*"))
            if not matches:
                raise HTTPException(status_code=404, detail="Audio file not found.")
            path = matches[0]
        mime = trim_text(rec.get("mime_type")) or "application/octet-stream"
        name = trim_text(rec.get("recording_name")) or path.name
        return path, mime, name

    async def upload_recording(
        self,
        work_session_id: str,
        *,
        file: UploadFile,
        staff_id: str,
        actor_role: str,
        duration_seconds: float = 0,
        source: str = SOURCE_BROWSER,
        recorded_at: str = "",
    ) -> dict[str, Any]:
        row = self.store.get(work_session_id)
        if not row:
            raise HTTPException(status_code=404, detail="Daily work session not found.")
        self._require_auth_access(row, staff_id, actor_role)
        if row.get("status") == STATUS_JOB_CREATED:
            raise HTTPException(
                status_code=409,
                detail="Cannot add recordings after JobCreated without an amendment workflow.",
            )
        if len(row.get("recordings") or []) >= self.max_recordings:
            raise HTTPException(
                status_code=422,
                detail=f"Maximum {self.max_recordings} recordings per session.",
            )

        data = await file.read()
        min_bytes = int(getattr(self.settings, "min_recording_upload_bytes", 1024) or 1024)
        max_mb = int(getattr(self.settings, "max_upload_mb", 25) or 25)
        content_type, _ext, recording_name = validate_upload_file(
            file,
            data,
            min_bytes=min_bytes,
            max_bytes=max_mb * 1024 * 1024,
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

        recording_id = f"DWR-{uuid.uuid4().hex[:8].upper()}"
        now = datetime.now(timezone.utc).isoformat()
        src = trim_text(source)
        if src not in (SOURCE_UPLOAD, SOURCE_BROWSER):
            src = SOURCE_BROWSER
        recording = {
            "recording_id": recording_id,
            "work_session_id": work_session_id,
            "recorded_at": trim_text(recorded_at) or now,
            "sequence": 0,
            "source": src,
            "recording_drive_file_id": drive_file_id,
            "recording_file_url": drive_file_url,
            "recording_name": recording_name,
            "mime_type": content_type,
            "size_bytes": len(data),
            "duration_seconds": float(duration_seconds or 0) or None,
            "status": REC_SAVED,
            "transcript": "",
            "failure_reason": "",
            "created_at": now,
            "created_by": staff_id,
        }
        ext = Path(recording_name).suffix or ".webm"
        path = self.store.audio_path(recording_id, ext)
        path.write_bytes(data)
        recording["audio_path"] = str(path)

        if row.get("status") not in (STATUS_RECORDING, STATUS_TRANSCRIPTION_FAILED, STATUS_EXTRACTION_FAILED):
            row["status"] = STATUS_RECORDING
        row = self.store.add_recording(row, recording)
        self.store.append_audit(
            row, {"event": "recording_added", "by": staff_id, "recording_id": recording_id}
        )
        return self._public(row)

    def delete_recording(
        self,
        work_session_id: str,
        recording_id: str,
        *,
        staff_id: str,
        actor_role: str,
    ) -> dict[str, Any]:
        row = self.store.get(work_session_id)
        if not row:
            raise HTTPException(status_code=404, detail="Daily work session not found.")
        self._require_auth_access(row, staff_id, actor_role)
        if row.get("status") == STATUS_JOB_CREATED:
            raise HTTPException(status_code=409, detail="Cannot remove recordings after JobCreated.")
        # Find audio path before remove
        target = next(
            (
                r
                for r in (row.get("recordings") or [])
                if trim_text(r.get("recording_id")) == trim_text(recording_id)
            ),
            None,
        )
        if not target:
            raise HTTPException(status_code=404, detail="Recording not found on session.")
        audio = Path(str(target.get("audio_path") or ""))
        row = self.store.remove_recording(row, recording_id)
        if audio.is_file():
            try:
                audio.unlink()
            except OSError:
                pass
        self.store.append_audit(
            row, {"event": "recording_removed", "by": staff_id, "recording_id": recording_id}
        )
        return self._public(row)

    async def process_recording(
        self,
        work_session_id: str,
        recording_id: str,
        *,
        staff_id: str,
        actor_role: str,
        force: bool = False,
    ) -> dict[str, Any]:
        row = self.store.get(work_session_id)
        if not row:
            raise HTTPException(status_code=404, detail="Daily work session not found.")
        self._require_auth_access(row, staff_id, actor_role)
        rec = next(
            (
                r
                for r in (row.get("recordings") or [])
                if trim_text(r.get("recording_id")) == trim_text(recording_id)
            ),
            None,
        )
        if not rec:
            raise HTTPException(status_code=404, detail="Recording not found on session.")
        if rec.get("status") == REC_PROCESSED and trim_text(rec.get("transcript")) and not force:
            return self._public(row)

        row = self.store.update_recording(
            row, recording_id, {"status": REC_PROCESSING, "failure_reason": ""}
        )
        row["status"] = STATUS_PROCESSING
        self.store.save(row)
        try:
            transcript = await self._transcribe(rec)
            row = self.store.update_recording(
                row,
                recording_id,
                {"status": REC_PROCESSED, "transcript": transcript, "failure_reason": ""},
            )
            self.store.append_audit(
                row, {"event": "recording_processed", "by": staff_id, "recording_id": recording_id}
            )
        except Exception as exc:
            row = self.store.update_recording(
                row,
                recording_id,
                {"status": REC_FAILED, "failure_reason": str(exc)},
            )
            row["status"] = STATUS_TRANSCRIPTION_FAILED
            row["failure_reason"] = str(exc)
            self.store.save(row)
            raise HTTPException(status_code=502, detail=f"Transcription failed: {exc}") from exc

        # If all recordings processed, leave status Processing until extract
        if all(
            r.get("status") == REC_PROCESSED and trim_text(r.get("transcript"))
            for r in (row.get("recordings") or [])
        ):
            row["status"] = STATUS_PROCESSING
            row["failure_reason"] = ""
            self.store.save(row)
        return self._public(row)

    async def process_all(
        self, work_session_id: str, *, staff_id: str, actor_role: str
    ) -> dict[str, Any]:
        row = self.store.get(work_session_id)
        if not row:
            raise HTTPException(status_code=404, detail="Daily work session not found.")
        self._require_auth_access(row, staff_id, actor_role)
        if not (row.get("recordings") or []):
            raise HTTPException(status_code=422, detail="Add at least one recording first.")
        for rec in sort_recordings(row.get("recordings") or []):
            if rec.get("status") == REC_PROCESSED and trim_text(rec.get("transcript")):
                continue
            await self.process_recording(
                work_session_id,
                rec["recording_id"],
                staff_id=staff_id,
                actor_role=actor_role,
                force=False,
            )
        return self.get_session(work_session_id, staff_id=staff_id, actor_role=actor_role)

    async def extract(
        self, work_session_id: str, *, staff_id: str, actor_role: str
    ) -> dict[str, Any]:
        row = self.store.get(work_session_id)
        if not row:
            raise HTTPException(status_code=404, detail="Daily work session not found.")
        self._require_auth_access(row, staff_id, actor_role)
        if row.get("status") == STATUS_JOB_CREATED:
            raise HTTPException(status_code=409, detail="Job already created for this session.")
        recs = sort_recordings(row.get("recordings") or [])
        if not recs:
            raise HTTPException(status_code=422, detail="No recordings to extract.")
        incomplete = [
            r for r in recs if r.get("status") != REC_PROCESSED or not trim_text(r.get("transcript"))
        ]
        if incomplete:
            raise HTTPException(
                status_code=409,
                detail="All recordings must be Processed before extraction. Process or retry failures first.",
            )

        row["status"] = STATUS_PROCESSING
        self.store.save(row)
        aggregated = aggregate_transcripts(recs)
        try:
            extraction = await self._extract(row, aggregated, recs)
            # Seed known session fields into job_sheet when model left blank
            job = extraction.get("job_sheet") or empty_job_sheet()
            if not job.get("customer_name"):
                job["customer_name"] = row.get("customer_name") or ""
            if not job.get("project_id"):
                job["project_id"] = row.get("project_id") or ""
            if not job.get("project_name"):
                job["project_name"] = row.get("project_name") or ""
            if not job.get("work_date"):
                job["work_date"] = row.get("work_date") or ""
            if not job.get("staff_ids"):
                job["staff_ids"] = list(row.get("staff_ids") or [])
            if not job.get("staff_names"):
                job["staff_names"] = list(row.get("staff_names") or [])
            if not job.get("site_address"):
                job["site_address"] = row.get("site_address") or ""
            extraction["job_sheet"] = job
            extraction["aggregated_transcript"] = aggregated
            extraction["recordings"] = [
                {
                    "recording_id": r.get("recording_id"),
                    "recorded_at": r.get("recorded_at"),
                    "transcript": r.get("transcript"),
                }
                for r in recs
            ]
            row["extraction"] = extraction
            row["status"] = STATUS_REVIEW_REQUIRED
            row["failure_reason"] = ""
            row["version"] = int(row.get("version") or 1) + 1
            self.store.save(row)
            self.store.append_audit(row, {"event": "extracted", "by": staff_id})
        except Exception as exc:
            row["status"] = STATUS_EXTRACTION_FAILED
            row["failure_reason"] = str(exc)
            self.store.save(row)
            raise HTTPException(status_code=502, detail=f"Extraction failed: {exc}") from exc
        return self._public(row)

    async def create_job_sheet(
        self,
        work_session_id: str,
        *,
        staff_id: str,
        staff_name: str,
        actor_role: str,
        expected_session_version: int,
        reviewed_job_sheet: dict[str, Any],
        idempotency_key: str,
    ) -> dict[str, Any]:
        self._require_create_role(actor_role)
        key = trim_text(idempotency_key)
        if not key:
            raise HTTPException(status_code=422, detail="idempotency_key is required.")

        existing = self.store.find_by_idempotency(key)
        hash_now = payload_hash(reviewed_job_sheet, work_session_id)
        if existing:
            prev = trim_text(existing.get("idempotency_payload_hash"))
            if prev and prev != hash_now:
                raise HTTPException(
                    status_code=409,
                    detail="Conflict: idempotency key reused with a different reviewed payload.",
                )
            return await self._load_created(existing)

        row = self.store.get(work_session_id)
        if not row:
            raise HTTPException(status_code=404, detail="Daily work session not found.")
        self._require_auth_access(row, staff_id, actor_role)
        if row.get("status") == STATUS_JOB_CREATED and row.get("created_job_sheet_id"):
            raise HTTPException(
                status_code=409,
                detail="This session already created a job sheet.",
            )
        if row.get("status") != STATUS_REVIEW_REQUIRED:
            raise HTTPException(
                status_code=409,
                detail=f"Session must be ReviewRequired (status={row.get('status')}).",
            )
        if int(row.get("version") or 0) != int(expected_session_version):
            raise HTTPException(status_code=409, detail="Conflict: session version changed.")

        recs = sort_recordings(row.get("recordings") or [])
        if not recs or any(r.get("status") != REC_PROCESSED for r in recs):
            raise HTTPException(status_code=409, detail="All recordings must be Processed.")

        ok, err = validate_reviewed_job_sheet(reviewed_job_sheet)
        if not ok:
            raise HTTPException(status_code=422, detail=err)

        sheet_fields = build_sheet_job_fields(reviewed_job_sheet, actor_staff_id=staff_id)
        if is_manager_or_admin(self._role(actor_role)):
            # Managers creating completed work still pending review unless policy changes
            sheet_fields["approval_status"] = "Pending Review"

        body = {
            "work_session_id": work_session_id,
            "idempotency_key": key,
            "payload_hash": hash_now,
            "staff_id": staff_id,
            "actor_staff_id": staff_id,
            "actor_role": self._role(actor_role),
            "created_by": staff_id,
            "created_by_name": staff_name,
            "job_fields": sheet_fields,
            "reviewed_job_sheet": reviewed_job_sheet,
            "recordings": [
                {
                    "recording_id": r.get("recording_id"),
                    "recording_drive_file_id": r.get("recording_drive_file_id") or "",
                    "recording_file_url": r.get("recording_file_url") or "",
                    "recording_name": r.get("recording_name") or "",
                    "duration_seconds": r.get("duration_seconds") or 0,
                    "mime_type": r.get("mime_type") or "",
                    "transcript": r.get("transcript") or "",
                    "sequence": r.get("sequence") or 0,
                    "recorded_at": r.get("recorded_at") or "",
                    "source": r.get("source") or "",
                }
                for r in recs
            ],
            "aggregated_transcript": (row.get("extraction") or {}).get("aggregated_transcript") or "",
            "processing_type": PROCESSING_TYPE,
        }

        mode = (self.settings.data_mode or "mock").strip().lower()
        # Remember key for retry after CreateFailed → return-to-review (same idempotency key).
        row["last_create_idempotency_key"] = key
        self.store.save(row)
        try:
            if mode == "apps_script" and self.apps_script is not None:
                result = await self.apps_script.create_completed_job_sheet_from_recordings(body)
            else:
                result = self._mock_create(body)
        except AppsScriptError as exc:
            # Create POST may already have inserted job + create-key. Never re-POST.
            # Reconcile with the same idempotency key first.
            reconciled = await self._reconcile_missing_job_sheet_id(
                row,
                staff_id=staff_id,
                idempotency_key=key,
                payload_hash_value=hash_now,
                reviewed_job_sheet=reviewed_job_sheet,
            )
            if reconciled is not None:
                return reconciled
            detail = str(exc) or "Create job failed."
            fail_code = getattr(exc, "code", None) or "apps_script_error"
            row["status"] = STATUS_CREATE_FAILED
            row["failure_reason"] = detail
            row["create_failure_reason"] = detail
            row["create_failure_code"] = str(fail_code)
            extraction = row.get("extraction") or empty_extraction(
                work_session_id, row.get("work_date") or ""
            )
            extraction["job_sheet"] = reviewed_job_sheet
            row["extraction"] = extraction
            row["version"] = int(row.get("version") or 1) + 1
            self.store.save(row)
            self.store.append_audit(
                row,
                {
                    "event": "create_failed",
                    "by": staff_id,
                    "code": row["create_failure_code"],
                    "reconcile": "not_found",
                },
            )
            raise HTTPException(
                status_code=int(getattr(exc, "http_status", None) or 502),
                detail=detail,
            ) from exc
        except HTTPException as exc:
            # Preserve extraction / reviewed data / recordings — only mark create failed.
            detail = exc.detail
            if isinstance(detail, dict):
                detail = str(detail.get("message") or detail)
            row["status"] = STATUS_CREATE_FAILED
            row["failure_reason"] = str(detail or "Create job failed.")
            row["create_failure_reason"] = str(detail or "Create job failed.")
            row["create_failure_code"] = f"http_{exc.status_code}"
            # Keep reviewed payload in extraction for recovery.
            extraction = row.get("extraction") or empty_extraction(
                work_session_id, row.get("work_date") or ""
            )
            extraction["job_sheet"] = reviewed_job_sheet
            row["extraction"] = extraction
            row["version"] = int(row.get("version") or 1) + 1
            self.store.save(row)
            self.store.append_audit(
                row,
                {
                    "event": "create_failed",
                    "by": staff_id,
                    "code": row["create_failure_code"],
                },
            )
            raise
        except Exception as exc:
            reconciled = await self._reconcile_missing_job_sheet_id(
                row,
                staff_id=staff_id,
                idempotency_key=key,
                payload_hash_value=hash_now,
                reviewed_job_sheet=reviewed_job_sheet,
            )
            if reconciled is not None:
                return reconciled
            row["status"] = STATUS_CREATE_FAILED
            row["failure_reason"] = str(exc)
            row["create_failure_reason"] = str(exc)
            row["create_failure_code"] = "create_exception"
            extraction = row.get("extraction") or empty_extraction(
                work_session_id, row.get("work_date") or ""
            )
            extraction["job_sheet"] = reviewed_job_sheet
            row["extraction"] = extraction
            row["version"] = int(row.get("version") or 1) + 1
            self.store.save(row)
            self.store.append_audit(
                row, {"event": "create_failed", "by": staff_id, "code": "create_exception"}
            )
            raise HTTPException(status_code=502, detail=f"Create job failed: {exc}") from exc

        self._log_create_response_shape(result)
        job_sheet_id = resolve_completed_job_sheet_id(
            result, action=CREATE_COMPLETED_JOB_ACTION
        )
        job = extract_completed_job_payload(result)
        links = extract_completed_create_links(result)
        idempotent = extract_completed_create_idempotent(result)
        data_block = result.get("data") if isinstance(result.get("data"), dict) else {}
        link_count = data_block.get("link_count")
        if link_count is None:
            link_count = result.get("link_count")
        if link_count is None:
            link_count = len(links)

        if not job_sheet_id:
            # Never auto-issue a second create — reconcile create-key table only.
            reconciled = await self._reconcile_missing_job_sheet_id(
                row,
                staff_id=staff_id,
                idempotency_key=key,
                payload_hash_value=hash_now,
                reviewed_job_sheet=reviewed_job_sheet,
            )
            if reconciled is not None:
                return reconciled
            row["status"] = STATUS_CREATE_FAILED
            row["failure_reason"] = "Create did not return job_sheet_id."
            row["create_failure_reason"] = row["failure_reason"]
            row["create_failure_code"] = "missing_job_sheet_id"
            extraction = row.get("extraction") or empty_extraction(
                work_session_id, row.get("work_date") or ""
            )
            extraction["job_sheet"] = reviewed_job_sheet
            row["extraction"] = extraction
            row["version"] = int(row.get("version") or 1) + 1
            self.store.save(row)
            self.store.append_audit(
                row,
                {
                    "event": "create_failed",
                    "by": staff_id,
                    "code": "missing_job_sheet_id",
                    "reconcile": "not_found",
                },
            )
            raise HTTPException(status_code=502, detail="Create did not return job_sheet_id.")

        return self._mark_job_created(
            row,
            staff_id=staff_id,
            job_sheet_id=job_sheet_id,
            job=job or {"job_sheet_id": job_sheet_id},
            links=links,
            link_count=int(link_count or 0),
            idempotent=idempotent,
            idempotency_key=key,
            payload_hash_value=hash_now,
            reviewed_job_sheet=reviewed_job_sheet,
        )

    def return_to_review(
        self,
        work_session_id: str,
        *,
        staff_id: str,
        actor_role: str,
        expected_session_version: int,
    ) -> dict[str, Any]:
        """CreateFailed → ReviewRequired without clearing extraction or recordings."""
        row = self.store.get(work_session_id)
        if not row:
            raise HTTPException(status_code=404, detail="Daily work session not found.")
        self._require_auth_access(row, staff_id, actor_role)
        if row.get("status") != STATUS_CREATE_FAILED:
            raise HTTPException(
                status_code=409,
                detail=f"Only CreateFailed sessions can return to review (status={row.get('status')}).",
            )
        if int(row.get("version") or 0) != int(expected_session_version):
            raise HTTPException(status_code=409, detail="Conflict: session version changed.")

        # Preserve extraction / reviewed_job_sheet / recordings / transcripts.
        row["status"] = STATUS_REVIEW_REQUIRED
        row["failure_reason"] = ""
        row["create_failure_reason"] = ""
        row["create_failure_code"] = ""
        row["version"] = int(row.get("version") or 1) + 1
        self.store.save(row)
        self.store.append_audit(
            row, {"event": "returned_to_review", "by": staff_id, "from": STATUS_CREATE_FAILED}
        )
        return self._public(row)

    async def _load_created(self, row: dict[str, Any]) -> dict[str, Any]:
        jid = trim_text(row.get("created_job_sheet_id"))
        # If FastAPI already knows the job, promote any lingering CreateFailed/ReviewRequired.
        if jid and row.get("status") != STATUS_JOB_CREATED:
            row["status"] = STATUS_JOB_CREATED
            row["failure_reason"] = ""
            row["create_failure_reason"] = ""
            row["create_failure_code"] = ""
            self.store.save(row)
        job = {"job_sheet_id": jid}
        return {
            "job": job,
            "session": self._public(row),
            "links": [],
            "link_count": 0,
            "idempotent": True,
        }

    def _log_create_response_shape(self, result: Any) -> None:
        """Log key names only — never transcripts or reviewed job content."""
        if not isinstance(result, dict):
            log_extra(logger, 30, "Daily Work create response non-dict", result_type=type(result).__name__)
            return
        data = result.get("data") if isinstance(result.get("data"), dict) else {}
        job = result.get("job") if isinstance(result.get("job"), dict) else {}
        if not job and isinstance(data.get("job"), dict):
            job = data.get("job") or {}
        log_extra(
            logger,
            20,
            "Daily Work create response keys",
            action=CREATE_COMPLETED_JOB_ACTION,
            top_level_keys=dict_keys(result),
            data_keys=dict_keys(data),
            job_keys=dict_keys(job),
            has_record_id=bool(trim_text(result.get("record_id"))),
            has_job_sheet_id=bool(
                trim_text(result.get("job_sheet_id"))
                or trim_text(job.get("job_sheet_id"))
                or trim_text(data.get("job_sheet_id"))
            ),
            apps_status=trim_text(result.get("status")),
            apps_message=trim_text(result.get("message"))[:120],
        )

    def _mark_job_created(
        self,
        row: dict[str, Any],
        *,
        staff_id: str,
        job_sheet_id: str,
        job: dict[str, Any],
        links: list[Any],
        idempotent: bool,
        idempotency_key: str,
        payload_hash_value: str,
        reviewed_job_sheet: dict[str, Any],
        link_count: int = 0,
    ) -> dict[str, Any]:
        now = datetime.now(timezone.utc).isoformat()
        work_session_id = trim_text(row.get("work_session_id"))
        row["created_job_sheet_id"] = job_sheet_id
        row["status"] = STATUS_JOB_CREATED
        row["idempotency_key"] = idempotency_key
        row["idempotency_payload_hash"] = payload_hash_value
        row["failure_reason"] = ""
        row["create_failure_reason"] = ""
        row["create_failure_code"] = ""
        row["version"] = int(row.get("version") or 1) + 1
        extraction = row.get("extraction") or empty_extraction(
            work_session_id, row.get("work_date") or ""
        )
        extraction["job_sheet"] = reviewed_job_sheet
        row["extraction"] = extraction
        self.store.save(row)
        self.store.append_audit(
            row,
            {
                "event": "job_created",
                "by": staff_id,
                "job_sheet_id": job_sheet_id,
                "at": now,
                "idempotent": bool(idempotent),
            },
        )
        out_job = dict(job) if isinstance(job, dict) else {}
        if not trim_text(out_job.get("job_sheet_id")):
            out_job["job_sheet_id"] = job_sheet_id
        out_links = links if isinstance(links, list) else []
        count = int(link_count or 0) or len(out_links)
        return {
            "job": out_job,
            "session": self._public(row),
            "links": out_links,
            "link_count": count,
            "idempotent": bool(idempotent),
        }

    async def _reconcile_missing_job_sheet_id(
        self,
        row: dict[str, Any],
        *,
        staff_id: str,
        idempotency_key: str,
        payload_hash_value: str,
        reviewed_job_sheet: dict[str, Any],
    ) -> Optional[dict[str, Any]]:
        """Look up tbl_daily_work_create_keys after a success response without an ID.

        Never issues a second create automatically.
        """
        mode = (self.settings.data_mode or "mock").strip().lower()
        if mode != "apps_script" or self.apps_script is None:
            return None
        work_session_id = trim_text(row.get("work_session_id"))
        try:
            lookup_raw = await self.apps_script.get_completed_job_sheet_create_result(
                {
                    "work_session_id": work_session_id,
                    "idempotency_key": idempotency_key,
                    "staff_id": staff_id,
                    "actor_staff_id": staff_id,
                    "actor_role": "staff",
                }
            )
        except Exception as exc:
            log_extra(
                logger,
                40,
                "Daily Work create reconcile failed",
                work_session_id=work_session_id,
                error=type(exc).__name__,
            )
            return None

        data = lookup_raw.get("data") if isinstance(lookup_raw, dict) else {}
        log_extra(
            logger,
            20,
            "Daily Work create reconcile keys",
            top_level_keys=dict_keys(lookup_raw),
            data_keys=dict_keys(data),
            has_job_sheet_id=bool(
                trim_text((lookup_raw or {}).get("job_sheet_id"))
                if isinstance(lookup_raw, dict)
                else False
            ),
            has_record_id=bool(
                trim_text((lookup_raw or {}).get("record_id"))
                if isinstance(lookup_raw, dict)
                else False
            ),
        )
        parsed = parse_completed_job_create_lookup(lookup_raw)
        if not parsed.get("found") or not parsed.get("job_sheet_id"):
            return None

        prior_hash = trim_text(parsed.get("payload_hash"))
        if prior_hash and prior_hash != payload_hash_value:
            row["status"] = STATUS_CREATE_FAILED
            row["failure_reason"] = (
                "Create response missing job_sheet_id; reconcile found conflicting payload_hash."
            )
            row["create_failure_reason"] = row["failure_reason"]
            row["create_failure_code"] = "reconcile_hash_conflict"
            row["version"] = int(row.get("version") or 1) + 1
            self.store.save(row)
            self.store.append_audit(
                row,
                {
                    "event": "create_failed",
                    "by": staff_id,
                    "code": "reconcile_hash_conflict",
                },
            )
            raise HTTPException(
                status_code=409,
                detail="Conflict: idempotency key reused with a different reviewed payload.",
            )

        self.store.append_audit(
            row,
            {
                "event": "create_reconciled",
                "by": staff_id,
                "job_sheet_id": parsed["job_sheet_id"],
            },
        )
        return self._mark_job_created(
            row,
            staff_id=staff_id,
            job_sheet_id=parsed["job_sheet_id"],
            job=parsed.get("job") or {"job_sheet_id": parsed["job_sheet_id"]},
            links=[],
            link_count=0,
            idempotent=True,
            idempotency_key=idempotency_key,
            payload_hash_value=payload_hash_value,
            reviewed_job_sheet=reviewed_job_sheet,
        )

    def _mock_create(self, body: dict[str, Any]) -> dict[str, Any]:
        job_sheet_id = f"JS-{uuid.uuid4().hex[:8].upper()}"
        link_count = len(body.get("recordings") or [])
        # Mirror Apps Script minimal success contract (no full job / transcripts).
        return {
            "status": "Success",
            "action": CREATE_COMPLETED_JOB_ACTION,
            "message": "Completed job sheet created",
            "job_sheet_id": job_sheet_id,
            "record_id": job_sheet_id,
            "idempotent": False,
            "data": {
                "job_sheet_id": job_sheet_id,
                "record_id": job_sheet_id,
                "work_session_id": body.get("work_session_id") or "",
                "idempotent": False,
                "link_count": link_count,
            },
        }

    async def _transcribe(self, recording: dict[str, Any]) -> str:
        mode = (self.settings.data_mode or "mock").strip().lower()
        audio_path = Path(str(recording.get("audio_path") or ""))
        data = audio_path.read_bytes() if audio_path.is_file() else b""
        if mode != "apps_script" or not openai_http.openai_configured(self.settings):
            seq = int(recording.get("sequence") or 1)
            return _MOCK_SEGMENTS.get(seq) or _MOCK_SEGMENTS.get(((seq - 1) % 3) + 1) or "Completed site work."
        return await openai_http.whisper_transcribe(
            self.settings,
            filename=str(recording.get("recording_name") or "recording.webm"),
            mime_type=str(recording.get("mime_type") or "audio/webm"),
            data=data,
        )

    async def _extract(
        self, session: dict[str, Any], aggregated: str, recordings: list[dict[str, Any]]
    ) -> dict[str, Any]:
        mode = (self.settings.data_mode or "mock").strip().lower()
        if mode != "apps_script" or not openai_http.openai_configured(self.settings):
            return coerce_extraction(
                {
                    "work_session_id": session.get("work_session_id"),
                    "work_date": session.get("work_date"),
                    "aggregated_transcript": aggregated,
                    "job_sheet": {
                        "customer_name": session.get("customer_name") or "Kat and James Dykes",
                        "project_name": session.get("project_name") or "Kat and James Dykes",
                        "project_id": session.get("project_id") or "PROJ-6002C0A0",
                        "work_date": session.get("work_date"),
                        "staff_ids": session.get("staff_ids") or [],
                        "staff_names": session.get("staff_names") or [],
                        "work_completed": [
                            {
                                "text": "Pruned front hedges",
                                "recording_ids": [recordings[0]["recording_id"]] if recordings else [],
                            },
                            {
                                "text": "Weeded entry garden",
                                "recording_ids": [recordings[0]["recording_id"]] if recordings else [],
                            },
                            {
                                "text": "Replaced broken 19 mm irrigation joiner near driveway",
                                "recording_ids": [recordings[1]["recording_id"]]
                                if len(recordings) > 1
                                else [],
                            },
                            {
                                "text": "Removed green waste",
                                "recording_ids": [recordings[2]["recording_id"]]
                                if len(recordings) > 2
                                else [],
                            },
                        ],
                        "materials_used": [
                            {
                                "text": "19 mm irrigation joiner",
                                "recording_ids": [recordings[1]["recording_id"]]
                                if len(recordings) > 1
                                else [],
                            }
                        ],
                        "issues_found": [
                            {
                                "text": "Rear tap leaking",
                                "recording_ids": [recordings[2]["recording_id"]]
                                if len(recordings) > 2
                                else [],
                            }
                        ],
                        "follow_up_required": [
                            {
                                "text": "Return to repair rear tap",
                                "recording_ids": [recordings[2]["recording_id"]]
                                if len(recordings) > 2
                                else [],
                            }
                        ],
                        "client_requests": [
                            {
                                "text": "Quote planting along the fence",
                                "recording_ids": [recordings[2]["recording_id"]]
                                if len(recordings) > 2
                                else [],
                            }
                        ],
                        "completion_summary": (
                            "Completed garden maintenance and irrigation repair; follow-up needed for rear tap."
                        ),
                    },
                    "warnings": [],
                    "unresolved": [],
                    "provider": "mock",
                    "model": "mock-daily-work",
                },
                work_session_id=session.get("work_session_id") or "",
                work_date=session.get("work_date") or "",
            )

        user_prompt = (
            f"work_session_id={session.get('work_session_id')}\n"
            f"work_date={session.get('work_date')}\n"
            f"customer_name={session.get('customer_name')}\n"
            f"project_name={session.get('project_name')}\n\n"
            f"Aggregated transcript:\n{aggregated}"
        )
        parsed, model = await openai_http.chat_json(
            self.settings,
            system_prompt=DAILY_WORK_EXTRACTION_SYSTEM_PROMPT,
            user_prompt=user_prompt,
        )
        extraction = coerce_extraction(
            parsed,
            work_session_id=session.get("work_session_id") or "",
            work_date=session.get("work_date") or "",
        )
        extraction["provider"] = "openai"
        extraction["model"] = model
        return extraction

    def _public_summary(self, row: dict[str, Any]) -> dict[str, Any]:
        return {
            "work_session_id": row.get("work_session_id"),
            "work_date": row.get("work_date"),
            "project_id": row.get("project_id"),
            "project_name": row.get("project_name"),
            "customer_name": row.get("customer_name"),
            "staff_ids": row.get("staff_ids") or [],
            "staff_names": row.get("staff_names") or [],
            "status": row.get("status"),
            "recording_count": len(row.get("recordings") or []),
            "created_by": row.get("created_by"),
            "created_at": row.get("created_at"),
            "updated_at": row.get("updated_at"),
            "version": row.get("version"),
            "created_job_sheet_id": row.get("created_job_sheet_id") or "",
        }

    def _public(self, row: dict[str, Any]) -> dict[str, Any]:
        recordings = []
        for r in sort_recordings(row.get("recordings") or []):
            recordings.append(
                {
                    "recording_id": r.get("recording_id"),
                    "work_session_id": r.get("work_session_id"),
                    "recorded_at": r.get("recorded_at"),
                    "sequence": r.get("sequence"),
                    "source": r.get("source"),
                    "recording_drive_file_id": r.get("recording_drive_file_id") or "",
                    "recording_file_url": r.get("recording_file_url") or "",
                    "recording_name": r.get("recording_name"),
                    "mime_type": r.get("mime_type"),
                    "size_bytes": r.get("size_bytes") or 0,
                    "duration_seconds": r.get("duration_seconds"),
                    "status": r.get("status"),
                    "transcript": r.get("transcript") or "",
                    "failure_reason": r.get("failure_reason") or "",
                    "created_at": r.get("created_at"),
                }
            )
        return {
            **self._public_summary(row),
            "site_address": row.get("site_address") or "",
            "starting_note": row.get("starting_note") or "",
            "recordings": recordings,
            "extraction": row.get("extraction") or empty_extraction(
                row.get("work_session_id") or "", row.get("work_date") or ""
            ),
            "failure_reason": row.get("failure_reason") or "",
            "create_failure_reason": row.get("create_failure_reason")
            or row.get("failure_reason")
            or "",
            "create_failure_code": row.get("create_failure_code") or "",
            "last_create_idempotency_key": row.get("last_create_idempotency_key") or "",
            "processing_type": row.get("processing_type") or PROCESSING_TYPE,
            "job_created": bool(row.get("created_job_sheet_id")),
            "notice": (
                (
                    "Job-sheet creation failed. Your recordings and reviewed work have been kept."
                    if row.get("status") == STATUS_CREATE_FAILED
                    else "No job sheet has been created yet."
                )
                if not row.get("created_job_sheet_id")
                else f"Job sheet {row.get('created_job_sheet_id')} created."
            ),
        }
