"""Apps Script-backed job repository (DATA_MODE=apps_script)."""

from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Any

from fastapi import HTTPException

from app.core.config import Settings
from app.core.logging import get_logger, log_extra
from app.services.apps_script import AppsScriptClient, AppsScriptError
from app.services.drive_upload import delete_drive_file, upload_recording_to_drive

logger = get_logger(__name__)

APPS_SCRIPT_ASSUMPTIONS = [
    "DATA_MODE=apps_script reads/writes via Apps Script gateway actions (list/detail/register/process).",
    "tbl_job_sheets.project_id stores legacy text labels; FieldOS resolves project_name (and customer_name when a matching master exists). Unmatched labels fall back to project_name with blank customer_name.",
    "Audio uploads go to Drive from FastAPI, then register_recording; large base64 is never posted to Apps Script.",
    "process_voice_dictation is the confirmed production enqueue action.",
    "Report actions return JSON report data only; FastAPI renders every PDF so no binary crosses the gateway.",
]


def _raise_from_apps(exc: AppsScriptError) -> None:
    code = exc.http_status or 502
    message = str(exc) or "Apps Script error"
    lower = message.lower()
    if code == 403 or "forbidden" in lower:
        if "manager" in lower or "admin" in lower:
            raise HTTPException(status_code=403, detail="Manager or admin role required.") from exc
        raise HTTPException(status_code=403, detail="Job is not assigned to this staff member") from exc
    if code == 404 or "not found" in lower:
        detail = "Recording not found for this job." if "recording" in lower else "Job sheet not found"
        raise HTTPException(status_code=404, detail=detail) from exc
    if "conflict" in lower or "changed since you loaded" in lower:
        raise HTTPException(status_code=409, detail=message) from exc
    if "validation error" in lower:
        raise HTTPException(status_code=422, detail=message) from exc
    if code == 422:
        raise HTTPException(status_code=422, detail=message) from exc
    if code == 409 or ("processing" in lower and "cannot change recordings" in lower):
        raise HTTPException(
            status_code=409,
            detail="Cannot change recordings while the job is Processing.",
        ) from exc
    if "return_reason" in lower or "requires processing_status" in lower or "explicit reopen" in lower:
        raise HTTPException(status_code=400, detail=message) from exc
    if code == 504:
        raise HTTPException(status_code=504, detail="Apps Script request timed out") from exc
    if code == 503:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    # Prefer safe generic message — never leak Drive IDs from Apps Script text.
    safe = message
    if "drive" in lower and ("file" in lower or "cleanup" in lower):
        safe = "Could not delete recording file from Drive. Recording was not removed."
    if "transcript" in lower:
        safe = "Upstream review request failed."
    raise HTTPException(status_code=502, detail=safe) from exc


def _raise_from_rates_apps(exc: AppsScriptError) -> None:
    """Phase 3E/3G mapping: Forbidden→403 with preserved detail when not a role gate."""
    code = exc.http_status or 502
    message = str(exc) or "Apps Script error"
    lower = message.lower()
    if code == 403 or "forbidden" in lower:
        if "manager" in lower or "admin" in lower:
            raise HTTPException(status_code=403, detail="Manager or admin role required.") from exc
        # Preserve non-role Forbidden reasons (assignment, report scope, etc.).
        raise HTTPException(status_code=403, detail=message) from exc
    if code == 404 or "not found" in lower:
        raise HTTPException(status_code=404, detail=message) from exc
    if code == 409 or "conflict" in lower or "changed since you loaded" in lower:
        raise HTTPException(status_code=409, detail=message) from exc
    if code == 422 or "validation error" in lower or "missing required attribute" in lower:
        raise HTTPException(status_code=422, detail=message) from exc
    if code == 400:
        raise HTTPException(status_code=400, detail=message) from exc
    if code == 504:
        raise HTTPException(status_code=504, detail="Apps Script request timed out") from exc
    if code == 503:
        raise HTTPException(status_code=503, detail=message) from exc
    raise HTTPException(status_code=502, detail=message) from exc


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

    async def alist_jobs_for_review(
        self,
        *,
        staff_id: str,
        actor_role: str,
        days: int,
        processing_status: str | None = None,
        approval_status: str | None = None,
        search: str | None = None,
    ) -> list[dict[str, Any]]:
        try:
            result = await self.apps_script.list_jobs_for_review(
                staff_id=staff_id,
                actor_role=actor_role,
                days=days,
                processing_status=processing_status,
                approval_status=approval_status,
                search=search,
            )
        except AppsScriptError as exc:
            _raise_from_apps(exc)
            raise
        data = result.get("data") or {}
        jobs = data.get("jobs")
        if not isinstance(jobs, list):
            raise HTTPException(status_code=502, detail="Apps Script returned no review jobs list")
        return [self._job_row(j) for j in jobs if isinstance(j, dict)]

    async def aget_job_for_staff(
        self,
        job_sheet_id: str,
        staff_id: str,
        *,
        actor_role: str = "staff",
        include_transcript: bool = False,
    ) -> dict[str, Any]:
        try:
            result = await self.apps_script.get_job_detail(
                job_sheet_id,
                staff_id,
                actor_role=actor_role,
                include_transcript=include_transcript,
            )
        except AppsScriptError as exc:
            _raise_from_apps(exc)
            raise
        data = result.get("data") or {}
        job = data.get("job")
        if not isinstance(job, dict):
            raise HTTPException(status_code=502, detail="Apps Script returned no job")
        return self._job_row(job)

    async def alist_recordings(
        self,
        job_sheet_id: str,
        staff_id: str,
        *,
        actor_role: str = "staff",
    ) -> list[dict[str, Any]]:
        try:
            result = await self.apps_script.get_job_detail(
                job_sheet_id,
                staff_id,
                actor_role=actor_role,
                include_transcript=False,
            )
        except AppsScriptError as exc:
            _raise_from_apps(exc)
            raise
        data = result.get("data") or {}
        recordings = data.get("recordings") or []
        if not isinstance(recordings, list):
            raise HTTPException(status_code=502, detail="Apps Script returned invalid recordings")
        return [r for r in recordings if isinstance(r, dict)]

    async def areview_action(self, action: str, body: dict[str, Any]) -> dict[str, Any]:
        try:
            if action == "update_job_review":
                result = await self.apps_script.update_job_review(body)
            elif action == "approve_job_sheet":
                result = await self.apps_script.approve_job_sheet(body)
            elif action == "return_job_sheet":
                result = await self.apps_script.return_job_sheet(body)
            elif action == "reopen_job_sheet":
                result = await self.apps_script.reopen_job_sheet(body)
            else:
                raise HTTPException(status_code=400, detail=f"Unknown review action: {action}")
        except AppsScriptError as exc:
            _raise_from_apps(exc)
            raise
        data = result.get("data") or {}
        job = data.get("job")
        if not isinstance(job, dict):
            raise HTTPException(status_code=502, detail="Apps Script returned no job")
        warnings = data.get("warnings") if isinstance(data.get("warnings"), list) else []
        return {"job": self._job_row(job), "warnings": [str(w) for w in warnings]}

    def _completion_payload(self, data: dict[str, Any]) -> dict[str, Any]:
        return {
            "completion": data.get("completion"),
            "labour_entries": data.get("labour_entries") or [],
            "machinery_entries": data.get("machinery_entries") or [],
            "material_entries": data.get("material_entries") or [],
            "can_edit": bool(data.get("can_edit")),
            "can_finalise": bool(data.get("can_finalise")),
            "can_reopen": bool(data.get("can_reopen")),
            "can_generate": bool(data.get("can_generate")),
        }

    @staticmethod
    def _resolve_generate_completion_id(result: dict[str, Any]) -> str:
        """Parse completion_id from minimal generate envelope (no full completion required)."""
        data = result.get("data") if isinstance(result.get("data"), dict) else {}
        for candidate in (
            data.get("completion_id"),
            result.get("completion_id"),
            result.get("record_id"),
        ):
            value = str(candidate or "").strip()
            if value:
                return value
        completion = data.get("completion") if isinstance(data.get("completion"), dict) else {}
        return str(completion.get("completion_id") or "").strip()

    async def _load_completion_after_generate(
        self, body: dict[str, Any], *, generate_result: dict[str, Any] | None = None
    ) -> dict[str, Any]:
        job_sheet_id = str(body.get("job_sheet_id") or "").strip()
        staff_id = str(body.get("staff_id") or body.get("actor_staff_id") or "").strip()
        actor_role = str(body.get("actor_role") or "staff").strip()
        if not job_sheet_id:
            raise HTTPException(status_code=422, detail="job_sheet_id is required.")
        # Prefer full get — generate response is intentionally minimal.
        loaded = await self.aget_job_completion(job_sheet_id, staff_id, actor_role)
        if isinstance(loaded.get("completion"), dict) and loaded["completion"].get("completion_id"):
            return loaded
        # Legacy generate that still returns a full assemble payload.
        if generate_result:
            data = (
                generate_result.get("data")
                if isinstance(generate_result.get("data"), dict)
                else {}
            )
            if isinstance(data.get("completion"), dict) and data["completion"].get("completion_id"):
                return self._completion_payload(data)
        raise HTTPException(
            status_code=502,
            detail="Generate succeeded but completion draft could not be loaded.",
        )

    async def _reconcile_generate_completion(
        self, body: dict[str, Any], *, error: AppsScriptError
    ) -> dict[str, Any] | None:
        """If generate POST may have persisted, load via get — never re-POST generate."""
        code = str(getattr(error, "code", "") or "")
        message = str(error).lower()
        transportish = code.startswith("apps_script_") or any(
            token in message
            for token in (
                "redirect",
                "html instead of json",
                "invalid apps script",
                "timed out",
                "unreachable",
                "expired",
            )
        )
        if not transportish:
            return None
        job_sheet_id = str(body.get("job_sheet_id") or "").strip()
        staff_id = str(body.get("staff_id") or body.get("actor_staff_id") or "").strip()
        actor_role = str(body.get("actor_role") or "staff").strip()
        if not job_sheet_id:
            return None
        try:
            loaded = await self.aget_job_completion(job_sheet_id, staff_id, actor_role)
        except Exception:
            return None
        completion = loaded.get("completion") if isinstance(loaded.get("completion"), dict) else None
        if completion and str(completion.get("completion_id") or "").strip():
            log_extra(
                logger,
                20,
                "Job completion generate reconciled via get",
                job_sheet_id=job_sheet_id,
                completion_id=str(completion.get("completion_id") or ""),
                apps_error_code=code or None,
            )
            return loaded
        return None

    @staticmethod
    def _is_apps_transport_error(error: AppsScriptError) -> bool:
        code = str(getattr(error, "code", "") or "")
        message = str(error).lower()
        return code.startswith("apps_script_") or any(
            token in message
            for token in (
                "redirect",
                "html instead of json",
                "invalid apps script",
                "timed out",
                "unreachable",
                "expired",
            )
        )

    @staticmethod
    def _is_completion_conflict(error: AppsScriptError) -> bool:
        message = str(error).lower()
        code = int(getattr(error, "http_status", 0) or 0)
        return code == 409 or "conflict" in message or "changed since you loaded" in message

    @staticmethod
    def _update_fields_appear_applied(body: dict[str, Any], loaded: dict[str, Any]) -> bool:
        completion = loaded.get("completion") if isinstance(loaded.get("completion"), dict) else {}
        if not completion:
            return False
        expected = body.get("expected_version")
        if expected is not None and expected != "":
            try:
                if int(completion.get("version") or 0) != int(expected) + 1:
                    return False
            except (TypeError, ValueError):
                return False
        checks: list[tuple[str, Any]] = [
            ("work_summary", body.get("work_summary")),
            ("invoice_description", body.get("invoice_description")),
            ("internal_notes", body.get("internal_notes")),
            ("completion_status", body.get("completion_status")),
        ]
        for key, value in checks:
            if value is None:
                continue
            if str(completion.get(key) or "") != str(value):
                return False
        if body.get("material_entries") is not None:
            if len(loaded.get("material_entries") or []) != len(body.get("material_entries") or []):
                return False
        if body.get("labour_entries") is not None:
            if len(loaded.get("labour_entries") or []) != len(body.get("labour_entries") or []):
                return False
        if body.get("machinery_entries") is not None:
            if len(loaded.get("machinery_entries") or []) != len(body.get("machinery_entries") or []):
                return False
        return True

    async def _load_completion_after_update(
        self, body: dict[str, Any], *, update_result: dict[str, Any] | None = None
    ) -> dict[str, Any]:
        job_sheet_id = str(body.get("job_sheet_id") or "").strip()
        staff_id = str(body.get("staff_id") or body.get("actor_staff_id") or "").strip()
        actor_role = str(body.get("actor_role") or "staff").strip()
        if not job_sheet_id:
            raise HTTPException(status_code=422, detail="job_sheet_id is required.")
        loaded = await self.aget_job_completion(job_sheet_id, staff_id, actor_role)
        if isinstance(loaded.get("completion"), dict) and loaded["completion"].get("completion_id"):
            return loaded
        if update_result:
            data = (
                update_result.get("data") if isinstance(update_result.get("data"), dict) else {}
            )
            if isinstance(data.get("completion"), dict) and data["completion"].get("completion_id"):
                return self._completion_payload(data)
        raise HTTPException(
            status_code=502,
            detail="Update succeeded but completion could not be loaded.",
        )

    async def _reconcile_update_completion(
        self, body: dict[str, Any], *, error: AppsScriptError
    ) -> dict[str, Any] | None:
        """If update POST may have persisted, load via get — never re-POST update."""
        if not self._is_apps_transport_error(error):
            return None
        job_sheet_id = str(body.get("job_sheet_id") or "").strip()
        staff_id = str(body.get("staff_id") or body.get("actor_staff_id") or "").strip()
        actor_role = str(body.get("actor_role") or "staff").strip()
        if not job_sheet_id:
            return None
        try:
            loaded = await self.aget_job_completion(job_sheet_id, staff_id, actor_role)
        except Exception:
            return None
        if not self._update_fields_appear_applied(body, loaded):
            return None
        completion = loaded.get("completion") if isinstance(loaded.get("completion"), dict) else {}
        log_extra(
            logger,
            20,
            "Job completion update reconciled via get",
            job_sheet_id=job_sheet_id,
            completion_id=str(completion.get("completion_id") or ""),
            version=completion.get("version"),
            apps_error_code=str(getattr(error, "code", "") or "") or None,
        )
        return loaded

    async def _raise_update_conflict(self, body: dict[str, Any], error: AppsScriptError) -> None:
        """409: return current version via safe get — never auto-retry with a new version."""
        job_sheet_id = str(body.get("job_sheet_id") or "").strip()
        staff_id = str(body.get("staff_id") or body.get("actor_staff_id") or "").strip()
        actor_role = str(body.get("actor_role") or "staff").strip()
        detail: dict[str, Any] = {
            "message": "Conflict: completion version changed since you loaded this record.",
            "job_sheet_id": job_sheet_id,
        }
        if job_sheet_id:
            try:
                loaded = await self.aget_job_completion(job_sheet_id, staff_id, actor_role)
                completion = (
                    loaded.get("completion") if isinstance(loaded.get("completion"), dict) else {}
                )
                if completion:
                    detail.update(
                        {
                            "completion_id": str(completion.get("completion_id") or ""),
                            "version": int(completion.get("version") or 0),
                            "completion_status": str(completion.get("completion_status") or ""),
                        }
                    )
            except Exception:
                pass
        raise HTTPException(status_code=409, detail=detail) from error

    async def aget_job_completion(
        self, job_sheet_id: str, staff_id: str, actor_role: str
    ) -> dict[str, Any]:
        try:
            result = await self.apps_script.get_job_completion(
                {
                    "job_sheet_id": job_sheet_id,
                    "staff_id": staff_id,
                    "actor_staff_id": staff_id,
                    "actor_role": actor_role,
                }
            )
        except AppsScriptError as exc:
            _raise_from_apps(exc)
            raise
        data = result.get("data") if isinstance(result.get("data"), dict) else {}
        return self._completion_payload(data)

    async def alist_job_completions(self, actor_role: str, staff_id: str) -> dict[str, Any]:
        try:
            result = await self.apps_script.list_job_completions(
                {"actor_role": actor_role, "staff_id": staff_id, "actor_staff_id": staff_id}
            )
        except AppsScriptError as exc:
            _raise_from_apps(exc)
            raise
        data = result.get("data") if isinstance(result.get("data"), dict) else {}
        items = data.get("items") if isinstance(data.get("items"), list) else []
        return {"items": [item for item in items if isinstance(item, dict)]}

    async def acompletion_dashboard(self, actor_role: str, staff_id: str, filters: dict[str, Any]) -> dict[str, Any]:
        try:
            result = await self.apps_script.list_completion_dashboard(
                {"actor_role": actor_role, "staff_id": staff_id, "actor_staff_id": staff_id, **filters}
            )
        except AppsScriptError as exc:
            _raise_from_apps(exc)
            raise
        data = result.get("data") if isinstance(result.get("data"), dict) else {}
        return data

    async def acompletion_dashboard_summary(
        self, actor_role: str, staff_id: str, filters: dict[str, Any]
    ) -> dict[str, Any]:
        try:
            result = await self.apps_script.get_completion_dashboard_summary(
                {"actor_role": actor_role, "staff_id": staff_id, "actor_staff_id": staff_id, **filters}
            )
        except AppsScriptError as exc:
            _raise_from_apps(exc)
            raise
        data = result.get("data") if isinstance(result.get("data"), dict) else {}
        return data

    async def acompletion_export_readiness(
        self, actor_role: str, staff_id: str, completion_id: str
    ) -> dict[str, Any]:
        try:
            result = await self.apps_script.get_completion_export_readiness(
                {
                    "actor_role": actor_role,
                    "staff_id": staff_id,
                    "actor_staff_id": staff_id,
                    "completion_id": completion_id,
                }
            )
        except AppsScriptError as exc:
            _raise_from_apps(exc)
            raise
        data = result.get("data") if isinstance(result.get("data"), dict) else {}
        return data

    async def aexport_action(self, action: str, body: dict[str, Any]) -> dict[str, Any]:
        try:
            result = await self.apps_script.export_batch_action(action, body)
        except AppsScriptError as exc:
            _raise_from_apps(exc)
            raise
        data = result.get("data") if isinstance(result.get("data"), dict) else {}
        return data

    async def areport_action(self, action: str, body: dict[str, Any]) -> dict[str, Any]:
        try:
            result = await self.apps_script.report_action(action, body)
        except AppsScriptError as exc:
            _raise_from_rates_apps(exc)
            raise
        data = result.get("data") if isinstance(result.get("data"), dict) else {}
        # PDF download needs the Success envelope so nested/legacy snapshot aliases
        # (report_data, snapshot_json) still normalise. Other report actions keep
        # the unwrapped data block expected by route assemblers.
        if action == "get_report_batch_pdf_data" and isinstance(result, dict) and isinstance(
            result.get("data"), dict
        ):
            return result
        return data

    async def adelivery_action(self, action: str, body: dict[str, Any]) -> dict[str, Any]:
        try:
            result = await self.apps_script.delivery_action(action, body)
        except AppsScriptError as exc:
            _raise_from_rates_apps(exc)
            raise
        return result.get("data") if isinstance(result.get("data"), dict) else {}

    async def aattachment_action(self, action: str, body: dict[str, Any]) -> dict[str, Any]:
        try:
            result = await self.apps_script.attachment_action(action, body)
        except AppsScriptError as exc:
            _raise_from_rates_apps(exc)
            raise
        return result.get("data") if isinstance(result.get("data"), dict) else {}

    async def aget_job_pdf_data(
        self, job_sheet_id: str, staff_id: str, actor_role: str, *, actor_identity: str = ""
    ) -> dict[str, Any]:
        try:
            result = await self.apps_script.get_job_pdf_data(
                {
                    "job_sheet_id": job_sheet_id,
                    "staff_id": staff_id,
                    "actor_staff_id": staff_id,
                    "actor_role": actor_role,
                    "actor_identity": actor_identity,
                }
            )
        except AppsScriptError as exc:
            _raise_from_apps(exc)
            raise
        # Return the full Success envelope so pdf_data / snapshot aliases normalise.
        if isinstance(result, dict) and (
            result.get("data") is not None or result.get("snapshot") is not None
        ):
            return result
        data = result.get("data") if isinstance(result, dict) and isinstance(result.get("data"), dict) else {}
        if not isinstance(data, dict) or not data:
            raise HTTPException(status_code=502, detail="Apps Script returned no report snapshot.")
        return data

    async def arates_action(self, action: str, body: dict[str, Any]) -> dict[str, Any]:
        try:
            result = await self.apps_script.rates_action(action, body)
        except AppsScriptError as exc:
            _raise_from_rates_apps(exc)
            raise
        data = result.get("data") if isinstance(result.get("data"), dict) else {}
        payload: dict[str, Any] = {"action": action}
        if isinstance(data.get("items"), list):
            payload["items"] = [item for item in data["items"] if isinstance(item, dict)]
            payload["overlaps"] = [
                row for row in (data.get("overlaps") or []) if isinstance(row, dict)
            ]
        if isinstance(data.get("item"), dict):
            payload["item"] = data["item"]
        return payload

    async def apricing_readiness(
        self, actor_role: str, staff_id: str, completion_id: str
    ) -> dict[str, Any]:
        try:
            result = await self.apps_script.get_completion_pricing_readiness(
                {
                    "actor_role": actor_role,
                    "staff_id": staff_id,
                    "actor_staff_id": staff_id,
                    "completion_id": completion_id,
                }
            )
        except AppsScriptError as exc:
            _raise_from_rates_apps(exc)
            raise
        return result.get("data") if isinstance(result.get("data"), dict) else {}

    async def afinancial_snapshot_action(
        self, action: str, body: dict[str, Any]
    ) -> dict[str, Any]:
        try:
            result = await self.apps_script.financial_snapshot_action(action, body)
        except AppsScriptError as exc:
            _raise_from_rates_apps(exc)
            raise
        return result.get("data") if isinstance(result.get("data"), dict) else {}

    async def acompletion_action(self, action: str, body: dict[str, Any]) -> dict[str, Any]:
        try:
            if action == "create_job_completion_draft":
                result = await self.apps_script.create_job_completion_draft(body)
            elif action == "generate_job_completion_draft":
                result = await self.apps_script.generate_job_completion_draft(body)
                # Minimal generate envelope — always reload via get (never re-POST generate).
                return await self._load_completion_after_generate(
                    body, generate_result=result
                )
            elif action == "update_job_completion":
                result = await self.apps_script.update_job_completion(body)
                # Minimal update envelope — always reload via get (never re-POST update).
                return await self._load_completion_after_update(body, update_result=result)
            elif action == "finalise_job_completion":
                result = await self.apps_script.finalise_job_completion(body)
            elif action == "reopen_job_completion":
                result = await self.apps_script.reopen_job_completion(body)
            else:
                raise HTTPException(status_code=400, detail=f"Unknown completion action: {action}")
        except AppsScriptError as exc:
            if action == "generate_job_completion_draft":
                reconciled = await self._reconcile_generate_completion(body, error=exc)
                if reconciled is not None:
                    return reconciled
            if action == "update_job_completion":
                if self._is_completion_conflict(exc):
                    await self._raise_update_conflict(body, exc)
                reconciled = await self._reconcile_update_completion(body, error=exc)
                if reconciled is not None:
                    return reconciled
                if self._is_apps_transport_error(exc):
                    raise HTTPException(
                        status_code=502,
                        detail=(
                            "Completion update could not be confirmed. "
                            "Reload the latest version before saving again."
                        ),
                    ) from exc
            _raise_from_apps(exc)
            raise
        data = result.get("data") if isinstance(result.get("data"), dict) else {}
        return self._completion_payload(data)

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
