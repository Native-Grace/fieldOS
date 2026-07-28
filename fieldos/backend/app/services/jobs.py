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
from app.services.pdf_reports import render_report
from app.services.recording_files import (
    sanitize_invalid_reason,
    sanitize_recording_filename,
    validate_upload_file,
)
from app.services.report_math import (
    REPORT_JOB_SHEET_SUMMARY,
    TEMPLATE_VERSION,
    ReportSnapshotError,
    normalise_report_pdf_snapshot,
    prepare_report_snapshot_for_render,
    safe_report_filename,
    sha256_hex,
    validate_pdf_bytes,
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

    async def list_reviewable(
        self,
        *,
        staff_id: str,
        actor_role: str,
        days: int | None = None,
        processing_status: str | None = None,
        approval_status: str | None = None,
        search: str | None = None,
    ) -> tuple[list[dict[str, Any]], int]:
        from app.core.roles import is_manager_or_admin

        if not is_manager_or_admin(actor_role):
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Manager or admin role required.",
            )
        day_count = self._day_count(days)
        if isinstance(self.repo, AppsScriptJobRepository):
            jobs = await self.repo.alist_jobs_for_review(
                staff_id=staff_id,
                actor_role=actor_role,
                days=day_count,
                processing_status=processing_status,
                approval_status=approval_status,
                search=search,
            )
        else:
            jobs = self.repo.list_jobs_for_review(
                self._since(day_count),
                processing_status=processing_status,
                approval_status=approval_status,
                search=search,
            )
        return jobs, day_count

    async def get_job_for_staff(
        self,
        job_sheet_id: str,
        staff_id: str,
        *,
        actor_role: str = "staff",
        include_transcript: bool = False,
    ) -> dict[str, Any]:
        if isinstance(self.repo, AppsScriptJobRepository):
            return await self.repo.aget_job_for_staff(
                job_sheet_id,
                staff_id,
                actor_role=actor_role,
                include_transcript=include_transcript,
            )
        if hasattr(self.repo, "get_job_for_review"):
            return self.repo.get_job_for_review(job_sheet_id, staff_id, actor_role)
        return self.repo.get_job_for_staff(job_sheet_id, staff_id)

    async def list_recordings(
        self,
        job_sheet_id: str,
        staff_id: str,
        *,
        actor_role: str = "staff",
    ) -> list[dict[str, Any]]:
        if isinstance(self.repo, AppsScriptJobRepository):
            return await self.repo.alist_recordings(job_sheet_id, staff_id, actor_role=actor_role)
        if hasattr(self.repo, "get_job_for_review"):
            self.repo.get_job_for_review(job_sheet_id, staff_id, actor_role)
            return self.repo.store.list_recordings(job_sheet_id)
        return self.repo.list_recordings(job_sheet_id, staff_id)

    async def review_action(
        self,
        action: str,
        *,
        job_sheet_id: str,
        staff_id: str,
        actor_role: str,
        actor_identity: str,
        body: dict[str, Any],
    ) -> dict[str, Any]:
        payload = {
            **body,
            "job_sheet_id": job_sheet_id,
            "staff_id": staff_id,
            "actor_staff_id": staff_id,
            "actor_role": actor_role,
            "actor_identity": actor_identity,
        }
        # Never forward raw transcript through review mutations.
        payload.pop("ai_transcript", None)
        result = await self.repo.areview_action(action, payload)
        log_extra(
            logger,
            20,
            "Job review action",
            action=action,
            job_sheet_id=job_sheet_id,
            staff_id=staff_id,
            actor_role=actor_role,
            return_reason_present=bool(str(body.get("return_reason") or "").strip()),
        )
        return result

    async def get_completion(
        self, job_sheet_id: str, staff_id: str, actor_role: str
    ) -> dict[str, Any]:
        if isinstance(self.repo, AppsScriptJobRepository):
            return await self.repo.aget_job_completion(job_sheet_id, staff_id, actor_role)
        return await self.repo.aget_job_completion(job_sheet_id, staff_id, actor_role)

    async def list_completions(self, staff_id: str, actor_role: str) -> dict[str, Any]:
        if isinstance(self.repo, AppsScriptJobRepository):
            return await self.repo.alist_job_completions(actor_role, staff_id)
        return await self.repo.alist_job_completions(actor_role)

    async def completion_action(
        self,
        action: str,
        *,
        job_sheet_id: str,
        staff_id: str,
        actor_role: str,
        actor_identity: str,
        body: dict[str, Any],
    ) -> dict[str, Any]:
        payload = {
            **body,
            "job_sheet_id": job_sheet_id,
            "staff_id": staff_id,
            "actor_staff_id": staff_id,
            "actor_role": actor_role,
            "actor_identity": actor_identity,
        }
        # Never trust client totals.
        for key in (
            "total_labour_hours",
            "total_travel_hours",
            "total_machinery_hours",
            "billable_labour_hours",
            "non_billable_labour_hours",
        ):
            payload.pop(key, None)
        payload.pop("ai_transcript", None)
        result = await self.repo.acompletion_action(action, payload)
        log_extra(
            logger,
            20,
            "Job completion action",
            action=action,
            job_sheet_id=job_sheet_id,
            staff_id=staff_id,
            actor_role=actor_role,
            reopen_reason_present=bool(str(body.get("reopen_reason") or "").strip()),
            override_reason_present=bool(str(body.get("override_reason") or "").strip()),
        )
        return result

    async def completion_dashboard(self, staff_id: str, actor_role: str, filters: dict[str, Any]) -> dict[str, Any]:
        if isinstance(self.repo, AppsScriptJobRepository):
            return await self.repo.acompletion_dashboard(actor_role, staff_id, filters)
        return await self.repo.acompletion_dashboard(actor_role, filters)

    async def completion_dashboard_summary(
        self, staff_id: str, actor_role: str, filters: dict[str, Any]
    ) -> dict[str, Any]:
        if isinstance(self.repo, AppsScriptJobRepository):
            return await self.repo.acompletion_dashboard_summary(actor_role, staff_id, filters)
        return await self.repo.acompletion_dashboard_summary(actor_role, filters)

    async def completion_export_readiness(
        self, staff_id: str, actor_role: str, completion_id: str
    ) -> dict[str, Any]:
        if isinstance(self.repo, AppsScriptJobRepository):
            return await self.repo.acompletion_export_readiness(actor_role, staff_id, completion_id)
        return await self.repo.acompletion_export_readiness(actor_role, completion_id)

    async def export_action(
        self,
        action: str,
        *,
        staff_id: str,
        actor_role: str,
        actor_identity: str,
        body: dict[str, Any],
    ) -> dict[str, Any]:
        payload = {
            **body,
            "staff_id": staff_id,
            "actor_staff_id": staff_id,
            "actor_role": actor_role,
            "actor_identity": actor_identity,
        }
        result = await self.repo.aexport_action(action, payload)
        log_extra(
            logger,
            20,
            "Export batch action",
            action=action,
            staff_id=staff_id,
            actor_role=actor_role,
            export_batch_id=str(body.get("export_batch_id") or ""),
            export_type=str(body.get("export_type") or ""),
        )
        return result

    async def report_action(
        self,
        action: str,
        *,
        staff_id: str,
        actor_role: str,
        actor_identity: str,
        body: dict[str, Any],
    ) -> dict[str, Any]:
        payload = {
            **body,
            "staff_id": staff_id,
            "actor_staff_id": staff_id,
            "actor_role": actor_role,
            "actor_identity": actor_identity,
        }
        # Reports are read models — clients never supply snapshots or checksums.
        for key in ("snapshot", "checksum", "byte_size", "pdf_bytes"):
            payload.pop(key, None)
        result = await self.repo.areport_action(action, payload)
        log_extra(
            logger,
            20,
            "Report batch action",
            action=action,
            staff_id=staff_id,
            actor_role=actor_role,
            report_batch_id=str(body.get("report_batch_id") or ""),
            report_type=str(body.get("report_type") or ""),
            template_version=TEMPLATE_VERSION,
        )
        return result

    async def delivery_action(
        self,
        action: str,
        *,
        staff_id: str,
        actor_role: str,
        actor_identity: str,
        body: dict[str, Any],
    ) -> dict[str, Any]:
        payload = {
            **body,
            "staff_id": staff_id,
            "actor_staff_id": staff_id,
            "actor_role": actor_role,
            "actor_identity": actor_identity,
        }
        for key in ("pdf_bytes", "pdf_base64", "drive_url", "public_url", "public_link"):
            payload.pop(key, None)
        if action != "upload_attachment":
            for key in ("drive_file_id", "storage_ref", "content_base64"):
                # drive_file_id may be set only by orchestrator → record_delivery_outcome
                if action == "record_delivery_outcome" and key == "drive_file_id":
                    continue
                payload.pop(key, None)

        mode = (self.settings.data_mode or "mock").strip().lower()
        from app.services.delivery_orchestrator import ORCHESTRATED_DELIVERY_ACTIONS, DeliveryOrchestrator

        if mode == "apps_script" and action in ORCHESTRATED_DELIVERY_ACTIONS:
            result = await DeliveryOrchestrator(self.settings, self.repo).execute(action, payload)
        else:
            result = await self.repo.adelivery_action(action, payload)

        if action == "delivery_options" and isinstance(result, dict):
            from app.services.attachment_math import antivirus_boundary_note
            from app.services.delivery_math import drive_filing_allowed, email_send_allowed

            email_ok, email_reason = email_send_allowed(
                data_mode=self.settings.data_mode,
                email_enabled=self.settings.document_email_enabled,
                fieldos_env=self.settings.fieldos_env,
            )
            drive_ok, drive_reason = drive_filing_allowed(
                data_mode=self.settings.data_mode,
                drive_enabled=self.settings.document_drive_filing_enabled,
                fieldos_env=self.settings.fieldos_env,
            )
            result = {
                **result,
                "email_enabled": bool(email_ok),
                "drive_filing_enabled": bool(drive_ok),
                "email_gate_reason": email_reason or result.get("email_gate_reason") or "",
                "drive_gate_reason": drive_reason or result.get("drive_gate_reason") or "",
                "antivirus_boundary": result.get("antivirus_boundary") or antivirus_boundary_note(),
                "auto_send": False,
            }

        log_extra(
            logger,
            20,
            "Document delivery action",
            action=action,
            staff_id=staff_id,
            actor_role=actor_role,
            delivery_id=str(body.get("delivery_id") or ""),
            document_type=str(body.get("document_type") or ""),
            confirm_send=bool(body.get("confirm_send")),
            method=str((result.get("delivery") or {}).get("delivery_method") or body.get("delivery_method") or ""),
            outcome=str((result.get("delivery") or {}).get("status") or ""),
            checksum_present=bool((result.get("delivery") or {}).get("checksum")),
            provider_enabled=bool(
                self.settings.document_email_enabled or self.settings.document_drive_filing_enabled
            ),
        )
        return result

    async def attachment_action(
        self,
        action: str,
        *,
        staff_id: str,
        actor_role: str,
        actor_identity: str,
        body: dict[str, Any],
    ) -> dict[str, Any]:
        payload = {
            **body,
            "staff_id": staff_id,
            "actor_staff_id": staff_id,
            "actor_role": actor_role,
            "actor_identity": actor_identity,
        }
        if action == "upload_attachment":
            from app.services.attachment_math import validate_attachment_upload
            from app.services.attachment_storage import decode_content_base64, store_attachment_bytes

            blockers = validate_attachment_upload(
                filename=payload.get("file_name"),
                mime_type=payload.get("mime_type"),
                byte_size=payload.get("byte_size"),
                attachment_type=payload.get("attachment_type") or "other",
                max_bytes=self.settings.max_attachment_bytes,
            )
            if blockers:
                raise HTTPException(status_code=422, detail="; ".join(blockers))
            raw = decode_content_base64(payload.pop("content_base64", None))
            if raw is not None:
                stored = store_attachment_bytes(
                    self.settings,
                    job_sheet_id=str(payload.get("job_sheet_id") or ""),
                    file_name=str(payload.get("file_name") or "attachment.bin"),
                    raw=raw,
                )
                payload["storage_ref"] = stored["storage_ref"]
                payload["checksum"] = stored["checksum"]
                payload["byte_size"] = stored["byte_size"]
            # Never forward raw bytes / public URLs to Apps Script.
            payload.pop("content_base64", None)
            payload.pop("public_url", None)
            payload.pop("drive_url", None)

        result = await self.repo.aattachment_action(action, payload)
        log_extra(
            logger,
            20,
            "Job attachment action",
            action=action,
            staff_id=staff_id,
            actor_role=actor_role,
            job_sheet_id=str(body.get("job_sheet_id") or ""),
            attachment_id=str(body.get("attachment_id") or (result.get("attachment") or {}).get("attachment_id") or ""),
        )
        return result

    def _render_pdf(self, data: dict[str, Any], *, report_type: str = "") -> dict[str, Any]:
        """Render + validate a PDF from returned report data. Never returns invalid bytes."""
        try:
            normalised = normalise_report_pdf_snapshot(data)
        except ReportSnapshotError as exc:
            log_extra(
                logger,
                30,
                "Report PDF snapshot rejected",
                report_batch_id=str(data.get("report_batch_id") or ""),
                batch_status=str((data.get("batch") or {}).get("status") or ""),
                snapshot_field="",
                snapshot_type="",
                snapshot_present=False,
                included_record_count=0,
                renderer_outcome="rejected",
                detail=str(exc),
            )
            raise HTTPException(status_code=422, detail=str(exc)) from exc

        resolved_type = str(normalised.get("report_type") or report_type or "")
        frozen = normalised["snapshot"]
        prepared = prepare_report_snapshot_for_render(frozen, report_type=resolved_type)
        if not resolved_type:
            resolved_type = str(prepared.get("report_type") or report_type or "")
        meta = dict(normalised.get("meta") or data.get("meta") or {})
        meta.setdefault("report_type", resolved_type)
        meta.setdefault("report_title", resolved_type)
        meta.setdefault(
            "template_version",
            str(normalised.get("template_version") or data.get("template_version") or TEMPLATE_VERSION),
        )

        report_batch_id = str(
            normalised.get("report_batch_id")
            or data.get("report_batch_id")
            or (normalised.get("batch") or {}).get("report_batch_id")
            or ""
        )
        log_extra(
            logger,
            20,
            "Report PDF snapshot ready",
            report_batch_id=report_batch_id,
            batch_status=str(normalised.get("batch_status") or ""),
            snapshot_field=str(normalised.get("snapshot_field") or ""),
            snapshot_type=str(normalised.get("snapshot_type") or ""),
            snapshot_present=bool(normalised.get("snapshot_present")),
            included_record_count=int(normalised.get("included_record_count") or 0),
            renderer_outcome="pending",
        )

        try:
            pdf = render_report(resolved_type, prepared, meta)
        except ValueError as exc:
            log_extra(
                logger,
                30,
                "Report PDF render failed",
                report_batch_id=report_batch_id,
                batch_status=str(normalised.get("batch_status") or ""),
                snapshot_field=str(normalised.get("snapshot_field") or ""),
                snapshot_type=str(normalised.get("snapshot_type") or ""),
                snapshot_present=True,
                included_record_count=int(normalised.get("included_record_count") or 0),
                renderer_outcome="render_error",
            )
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        try:
            byte_size = validate_pdf_bytes(pdf)
        except ValueError as exc:
            log_extra(
                logger,
                40,
                "Report PDF validation failed",
                report_batch_id=report_batch_id,
                batch_status=str(normalised.get("batch_status") or ""),
                snapshot_field=str(normalised.get("snapshot_field") or ""),
                snapshot_type=str(normalised.get("snapshot_type") or ""),
                snapshot_present=True,
                included_record_count=int(normalised.get("included_record_count") or 0),
                renderer_outcome="invalid_pdf",
            )
            raise HTTPException(
                status_code=500, detail=f"Report PDF failed validation: {exc}"
            ) from exc
        checksum = sha256_hex(pdf)
        stored = str(normalised.get("checksum") or data.get("checksum") or "")
        if stored and stored != checksum:
            log_extra(
                logger,
                30,
                "Report checksum drift between generate and download",
                report_type=resolved_type,
                report_batch_id=report_batch_id,
                stored_checksum=stored,
                rendered_checksum=checksum,
            )
        log_extra(
            logger,
            20,
            "Report PDF rendered",
            report_batch_id=report_batch_id,
            batch_status=str(normalised.get("batch_status") or ""),
            snapshot_field=str(normalised.get("snapshot_field") or ""),
            snapshot_type=str(normalised.get("snapshot_type") or ""),
            snapshot_present=True,
            included_record_count=int(normalised.get("included_record_count") or 0),
            renderer_outcome="ok",
            report_type=resolved_type,
            byte_size=byte_size,
        )
        return {
            "pdf_bytes": pdf,
            "byte_size": byte_size,
            "checksum": checksum,
            "stored_checksum": stored,
            "report_type": resolved_type,
            "content_type": "application/pdf",
            "file_name": str(
                normalised.get("file_name")
                or data.get("file_name")
                or safe_report_filename(resolved_type)
            ),
        }

    async def report_pdf(
        self,
        report_batch_id: str,
        *,
        staff_id: str,
        actor_role: str,
        actor_identity: str,
    ) -> dict[str, Any]:
        data = await self.report_action(
            "get_report_batch_pdf_data",
            staff_id=staff_id,
            actor_role=actor_role,
            actor_identity=actor_identity,
            body={"report_batch_id": report_batch_id},
        )
        if isinstance(data, dict) and not data.get("report_batch_id"):
            data = {**data, "report_batch_id": report_batch_id}
        rendered = self._render_pdf(data)
        return rendered

    async def job_summary_pdf(
        self,
        job_sheet_id: str,
        *,
        staff_id: str,
        actor_role: str,
        actor_identity: str,
    ) -> dict[str, Any]:
        data = await self.repo.aget_job_pdf_data(
            job_sheet_id,
            staff_id,
            actor_role,
            actor_identity=actor_identity,
        )
        rendered = self._render_pdf(data, report_type=REPORT_JOB_SHEET_SUMMARY)
        rendered.setdefault("job_sheet_id", job_sheet_id)
        return rendered

    async def rates_action(
        self,
        action: str,
        *,
        staff_id: str,
        actor_role: str,
        actor_identity: str,
        body: dict[str, Any],
    ) -> dict[str, Any]:
        payload = {
            **body,
            "staff_id": staff_id,
            "actor_staff_id": staff_id,
            "actor_role": actor_role,
            "actor_identity": actor_identity,
        }
        result = await self.repo.arates_action(action, payload)
        log_extra(
            logger,
            20,
            "Rates configuration action",
            action=action,
            staff_id=staff_id,
            actor_role=actor_role,
            record_version=str((result.get("item") or {}).get("version") or ""),
        )
        return result

    async def pricing_readiness(
        self, *, staff_id: str, actor_role: str, completion_id: str
    ) -> dict[str, Any]:
        if isinstance(self.repo, AppsScriptJobRepository):
            return await self.repo.apricing_readiness(actor_role, staff_id, completion_id)
        return await self.repo.apricing_readiness(actor_role, completion_id)

    async def financial_snapshot_action(
        self,
        action: str,
        *,
        staff_id: str,
        actor_role: str,
        actor_identity: str,
        body: dict[str, Any],
    ) -> dict[str, Any]:
        payload = {
            **body,
            "staff_id": staff_id,
            "actor_staff_id": staff_id,
            "actor_role": actor_role,
            "actor_identity": actor_identity,
        }
        # Money is always recomputed server-side from stored rates.
        for key in ("subtotal_ex_tax", "tax_amount", "total_inc_tax", "lines"):
            payload.pop(key, None)
        result = await self.repo.afinancial_snapshot_action(action, payload)
        log_extra(
            logger,
            20,
            "Financial snapshot action",
            action=action,
            staff_id=staff_id,
            actor_role=actor_role,
            completion_id=str(body.get("completion_id") or ""),
            financial_snapshot_id=str(body.get("financial_snapshot_id") or ""),
        )
        return result

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
