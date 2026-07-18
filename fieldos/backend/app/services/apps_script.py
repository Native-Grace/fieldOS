"""Apps Script webhook client — secrets never leave the server or appear in logs."""

from __future__ import annotations

from typing import Any, Optional

import httpx

from app.core.config import Settings
from app.core.logging import get_logger, log_extra
from app.services.drive_upload import redact_secrets, safe_json_preview

logger = get_logger(__name__)


class AppsScriptError(Exception):
    """Normalized Apps Script / transport failure for repository layer."""

    def __init__(self, message: str, *, http_status: Optional[int] = None, apps_status: Optional[str] = None):
        super().__init__(message)
        self.http_status = http_status
        self.apps_status = apps_status


class AppsScriptClient:
    def __init__(self, settings: Settings):
        self.settings = settings

    @property
    def configured(self) -> bool:
        return bool(self.settings.apps_script_webapp_url and self.settings.apps_script_webhook_secret)

    def _require_configured(self) -> None:
        if not self.configured:
            raise AppsScriptError(
                "Apps Script is not configured (APPS_SCRIPT_WEBAPP_URL / APPS_SCRIPT_WEBHOOK_SECRET).",
                http_status=503,
            )

    def _column_payload(self) -> dict[str, str]:
        return {
            "assignment_column": self.settings.job_assignment_column,
            "date_column": self.settings.job_date_column,
            "project_column": self.settings.job_project_column,
            "customer_column": self.settings.job_customer_column,
        }

    async def _post(self, action: str, body: dict[str, Any]) -> dict[str, Any]:
        self._require_configured()
        payload = {
            **body,
            "action": action,
            "webhook_secret": self.settings.apps_script_webhook_secret,
        }
        try:
            async with httpx.AsyncClient(timeout=self.settings.apps_script_timeout_seconds) as client:
                response = await client.post(
                    self.settings.apps_script_webapp_url,
                    json=payload,
                    headers={"Content-Type": "application/json"},
                )
        except httpx.TimeoutException as exc:
            log_extra(logger, 40, "Apps Script timeout", action=action)
            raise AppsScriptError("Apps Script request timed out.", http_status=504) from exc
        except httpx.HTTPError as exc:
            log_extra(logger, 40, "Apps Script transport error", action=action, error=type(exc).__name__)
            raise AppsScriptError("Apps Script unreachable.", http_status=502) from exc

        try:
            data = response.json()
        except Exception as exc:
            preview = (response.text or "")[:300]
            log_extra(
                logger,
                40,
                "Apps Script non-JSON response",
                action=action,
                http_status=response.status_code,
                preview=preview,
            )
            raise AppsScriptError(
                f"Invalid Apps Script response ({response.status_code}).",
                http_status=502,
            ) from exc

        if not isinstance(data, dict) or "status" not in data:
            log_extra(
                logger,
                40,
                "Apps Script invalid payload shape",
                action=action,
                preview=safe_json_preview(data),
            )
            raise AppsScriptError("Invalid Apps Script response shape.", http_status=502)

        apps_status = str(data.get("status", ""))
        log_extra(
            logger,
            20 if apps_status.lower() == "success" else 40,
            "Apps Script response",
            action=action,
            http_status=response.status_code,
            apps_status=apps_status,
            apps_message=str(data.get("message", ""))[:200],
        )

        if apps_status.lower() != "success":
            message = str(data.get("message") or "Apps Script returned Error")
            # Map auth failures
            lower = message.lower()
            code = 502
            if "unauthorized" in lower or "webhook_secret" in lower:
                code = 502  # misconfiguration between FieldOS and Apps Script
            if "forbidden" in lower:
                code = 403
            if "not found" in lower:
                code = 404
            raise AppsScriptError(message, http_status=code, apps_status=apps_status)

        data["proxied"] = True
        return data

    async def process_voice_dictation(
        self,
        job_sheet_id: str,
        user_identity: str,
        force_reprocess: bool = False,
    ) -> dict[str, Any]:
        """Confirmed production action. Simulates Success when not configured (mock-friendly)."""
        if not self.configured:
            log_extra(
                logger,
                20,
                "Apps Script not configured; returning simulated Success",
                job_sheet_id=job_sheet_id,
            )
            return {
                "status": "Success",
                "action": "process_voice_dictation",
                "message": "Simulated queue (APPS_SCRIPT_WEBAPP_URL not set).",
                "record_id": job_sheet_id,
                "timestamp": None,
                "proxied": False,
            }

        try:
            return await self._post(
                "process_voice_dictation",
                {
                    "job_sheet_id": job_sheet_id,
                    "user_identity": user_identity,
                    "force_reprocess": force_reprocess,
                },
            )
        except AppsScriptError as exc:
            return {
                "status": "Error",
                "action": "process_voice_dictation",
                "message": str(exc),
                "record_id": job_sheet_id,
                "proxied": True,
            }

    async def list_jobs_for_staff(self, staff_id: str, days: int) -> dict[str, Any]:
        return await self._post(
            "list_jobs_for_staff",
            {"staff_id": staff_id, "days": days, **self._column_payload()},
        )

    async def get_job_detail(self, job_sheet_id: str, staff_id: str) -> dict[str, Any]:
        return await self._post(
            "get_job_detail",
            {
                "job_sheet_id": job_sheet_id,
                "staff_id": staff_id,
                **self._column_payload(),
            },
        )

    async def register_recording(self, body: dict[str, Any]) -> dict[str, Any]:
        safe_body = redact_secrets(body)
        return await self._post("register_recording", {**safe_body, **self._column_payload()})
