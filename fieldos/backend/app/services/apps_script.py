"""Apps Script webhook proxy — secrets never leave the server."""

from __future__ import annotations

from typing import Any

import httpx

from app.core.config import Settings
from app.core.logging import get_logger, log_extra

logger = get_logger(__name__)


class AppsScriptClient:
    def __init__(self, settings: Settings):
        self.settings = settings

    @property
    def configured(self) -> bool:
        return bool(self.settings.apps_script_webapp_url and self.settings.apps_script_webhook_secret)

    async def process_voice_dictation(
        self,
        job_sheet_id: str,
        user_identity: str,
        force_reprocess: bool = False,
    ) -> dict[str, Any]:
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

        payload = {
            "action": "process_voice_dictation",
            "job_sheet_id": job_sheet_id,
            "user_identity": user_identity,
            "force_reprocess": force_reprocess,
            "webhook_secret": self.settings.apps_script_webhook_secret,
        }

        try:
            async with httpx.AsyncClient(timeout=self.settings.apps_script_timeout_seconds) as client:
                response = await client.post(
                    self.settings.apps_script_webapp_url,
                    json=payload,
                    headers={"Content-Type": "application/json"},
                )
            text = response.text
            try:
                data = response.json()
            except Exception:
                data = {
                    "status": "Error",
                    "action": "process_voice_dictation",
                    "message": f"Non-JSON Apps Script response ({response.status_code}): {text[:500]}",
                    "record_id": job_sheet_id,
                }
            data["proxied"] = True
            log_extra(
                logger,
                20 if str(data.get("status")).lower() == "success" else 40,
                "Apps Script process_voice_dictation response",
                job_sheet_id=job_sheet_id,
                http_status=response.status_code,
                apps_status=data.get("status"),
                # never log webhook_secret
            )
            return data
        except httpx.HTTPError as exc:
            log_extra(logger, 40, "Apps Script request failed", job_sheet_id=job_sheet_id, error=str(exc))
            return {
                "status": "Error",
                "action": "process_voice_dictation",
                "message": f"Apps Script unreachable: {exc}",
                "record_id": job_sheet_id,
                "proxied": True,
            }
