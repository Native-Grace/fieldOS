"""Apps Script webhook client — secrets never leave the server or appear in logs."""

from __future__ import annotations

from typing import Any, Optional

import httpx

from app.core.config import Settings
from app.core.logging import get_logger, log_extra
from app.services.drive_upload import redact_secrets, safe_json_preview

logger = get_logger(__name__)

# Phase 3E gateway actions (see FieldOSGateway.js).
RATES_ACTIONS = (
    "list_rate_cards",
    "create_rate_card",
    "update_rate_card",
    "list_labour_rates",
    "create_labour_rate",
    "update_labour_rate",
    "list_machinery_rates",
    "create_machinery_rate",
    "update_machinery_rate",
    "list_material_catalog",
    "create_material_catalog_item",
    "update_material_catalog_item",
    "list_customer_pricing",
    "create_customer_pricing",
    "update_customer_pricing",
    "list_payroll_mappings",
    "create_payroll_mapping",
    "update_payroll_mapping",
    "list_xero_mappings",
    "create_xero_mapping",
    "update_xero_mapping",
)

FINANCIAL_SNAPSHOT_ACTIONS = (
    "create_financial_snapshot",
    "list_financial_snapshots",
    "get_financial_snapshot",
    "validate_financial_snapshot",
    "approve_financial_snapshot",
    "supersede_financial_snapshot",
)

# Phase 3F report actions. Apps Script only ever returns report *data*; the PDF
# itself is always rendered in FastAPI so no binary crosses the gateway.
REPORT_ACTIONS = (
    "report_options",
    "report_preview",
    "create_report_batch",
    "list_report_batches",
    "get_report_batch",
    "validate_report_batch",
    "generate_report_batch",
    "cancel_report_batch",
    "get_report_batch_pdf_data",
)

# Phase 3G document delivery + attachment metadata actions.
DELIVERY_ACTIONS = (
    "delivery_options",
    "list_deliveries",
    "get_delivery",
    "create_delivery_draft",
    "update_delivery_draft",
    "preview_delivery",
    "validate_delivery",
    "send_delivery",
    "retry_delivery",
    "cancel_delivery",
    "supersede_delivery",
    "record_delivery_outcome",
)

ATTACHMENT_ACTIONS = (
    "list_attachments",
    "upload_attachment",
    "delete_attachment",
    "set_attachment_client_visible",
)


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
        # Business body must never already carry transport secrets.
        from app.services.apps_script_payload import assert_no_forbidden_apps_script_keys

        assert_no_forbidden_apps_script_keys(body, action=action)
        # Safe diagnostics — never log webhook_secret or raw payloads.
        log_extra(
            logger,
            20,
            "Apps Script request",
            action=action,
            staff_id=body.get("staff_id"),
            days=body.get("days"),
            job_sheet_id=body.get("job_sheet_id"),
            assignment_column=body.get("assignment_column"),
            date_column=body.get("date_column"),
            project_column=body.get("project_column"),
            customer_column=body.get("customer_column"),
            payload_key_count=len(body),
            payload_keys=sorted(str(k) for k in body.keys()),
        )
        # Transport envelope only: webhook_secret authenticates the gateway and
        # must be stripped before business handlers (see Router.doPost).
        payload = {
            **body,
            "action": action,
            "webhook_secret": self.settings.apps_script_webhook_secret,
        }
        try:
            # ContentService JSON responses redirect (302) to script.googleusercontent.com;
            # httpx must follow redirects — do not re-POST the Location manually.
            async with httpx.AsyncClient(
                timeout=self.settings.apps_script_timeout_seconds,
                follow_redirects=True,
            ) as client:
                response = await client.post(
                    self.settings.apps_script_webapp_url,
                    json=payload,
                    headers={"Content-Type": "application/json"},
                )
        except httpx.TimeoutException as exc:
            log_extra(logger, 40, "Apps Script timeout", action=action)
            raise AppsScriptError("Apps Script request timed out.", http_status=504) from exc
        except httpx.TooManyRedirects as exc:
            log_extra(logger, 40, "Apps Script redirect limit exceeded", action=action)
            raise AppsScriptError("Apps Script redirect limit exceeded.", http_status=502) from exc
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
        data_block = data.get("data") if isinstance(data.get("data"), dict) else {}
        jobs = data_block.get("jobs") if isinstance(data_block, dict) else None
        job_count = len(jobs) if isinstance(jobs, list) else None
        log_extra(
            logger,
            20 if apps_status.lower() == "success" else 40,
            "Apps Script response",
            action=action,
            http_status=response.status_code,
            apps_status=apps_status,
            apps_message=str(data.get("message", ""))[:200],
            job_count=job_count,
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
            if "conflict" in lower or "changed since you loaded" in lower:
                code = 409
            if "validation error" in lower:
                code = 422
            if "processing" in lower and ("cannot" in lower or "while" in lower or "blocked" in lower):
                code = 409
            if "drive cleanup" in lower or "could not delete recording file" in lower:
                code = 502
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

    async def list_jobs_for_review(
        self,
        *,
        staff_id: str,
        actor_role: str,
        days: int,
        processing_status: str | None = None,
        approval_status: str | None = None,
        search: str | None = None,
    ) -> dict[str, Any]:
        return await self._post(
            "list_jobs_for_review",
            {
                "staff_id": staff_id,
                "actor_role": actor_role,
                "days": days,
                "processing_status": processing_status or "",
                "approval_status": approval_status or "",
                "search": search or "",
                **self._column_payload(),
            },
        )

    async def get_job_detail(
        self,
        job_sheet_id: str,
        staff_id: str,
        *,
        actor_role: str = "staff",
        include_transcript: bool = False,
    ) -> dict[str, Any]:
        return await self._post(
            "get_job_detail",
            {
                "job_sheet_id": job_sheet_id,
                "staff_id": staff_id,
                "actor_role": actor_role,
                "include_transcript": include_transcript,
                **self._column_payload(),
            },
        )

    async def update_job_review(self, body: dict[str, Any]) -> dict[str, Any]:
        safe_body = redact_secrets(body)
        return await self._post("update_job_review", {**safe_body, **self._column_payload()})

    async def approve_job_sheet(self, body: dict[str, Any]) -> dict[str, Any]:
        safe_body = redact_secrets(body)
        return await self._post("approve_job_sheet", {**safe_body, **self._column_payload()})

    async def return_job_sheet(self, body: dict[str, Any]) -> dict[str, Any]:
        safe_body = redact_secrets(body)
        return await self._post("return_job_sheet", {**safe_body, **self._column_payload()})

    async def reopen_job_sheet(self, body: dict[str, Any]) -> dict[str, Any]:
        safe_body = redact_secrets(body)
        return await self._post("reopen_job_sheet", {**safe_body, **self._column_payload()})

    async def get_job_completion(self, body: dict[str, Any]) -> dict[str, Any]:
        safe_body = redact_secrets(body)
        return await self._post("get_job_completion", {**safe_body, **self._column_payload()})

    async def create_job_completion_draft(self, body: dict[str, Any]) -> dict[str, Any]:
        safe_body = redact_secrets(body)
        return await self._post("create_job_completion_draft", {**safe_body, **self._column_payload()})

    async def generate_job_completion_draft(self, body: dict[str, Any]) -> dict[str, Any]:
        safe_body = redact_secrets(body)
        return await self._post("generate_job_completion_draft", {**safe_body, **self._column_payload()})

    async def update_job_completion(self, body: dict[str, Any]) -> dict[str, Any]:
        safe_body = redact_secrets(body)
        return await self._post("update_job_completion", {**safe_body, **self._column_payload()})

    async def finalise_job_completion(self, body: dict[str, Any]) -> dict[str, Any]:
        safe_body = redact_secrets(body)
        return await self._post("finalise_job_completion", {**safe_body, **self._column_payload()})

    async def reopen_job_completion(self, body: dict[str, Any]) -> dict[str, Any]:
        safe_body = redact_secrets(body)
        return await self._post("reopen_job_completion", {**safe_body, **self._column_payload()})

    async def list_job_completions(self, body: dict[str, Any]) -> dict[str, Any]:
        safe_body = redact_secrets(body)
        return await self._post("list_job_completions", {**safe_body, **self._column_payload()})

    async def list_completion_dashboard(self, body: dict[str, Any]) -> dict[str, Any]:
        safe_body = redact_secrets(body)
        return await self._post("list_completion_dashboard", {**safe_body, **self._column_payload()})

    async def get_completion_dashboard_summary(self, body: dict[str, Any]) -> dict[str, Any]:
        safe_body = redact_secrets(body)
        return await self._post("get_completion_dashboard_summary", {**safe_body, **self._column_payload()})

    async def get_completion_export_readiness(self, body: dict[str, Any]) -> dict[str, Any]:
        safe_body = redact_secrets(body)
        return await self._post("get_completion_export_readiness", {**safe_body, **self._column_payload()})

    async def export_batch_action(self, action: str, body: dict[str, Any]) -> dict[str, Any]:
        safe_body = redact_secrets(body)
        return await self._post(action, {**safe_body, **self._column_payload()})

    async def rates_action(self, action: str, body: dict[str, Any]) -> dict[str, Any]:
        """Phase 3E rate card / rate / mapping CRUD actions."""
        if action not in RATES_ACTIONS:
            raise AppsScriptError(f"Unsupported rates action: {action}", http_status=400)
        safe_body = redact_secrets(body)
        return await self._post(action, {**safe_body, **self._column_payload()})

    async def get_completion_pricing_readiness(self, body: dict[str, Any]) -> dict[str, Any]:
        safe_body = redact_secrets(body)
        return await self._post(
            "get_completion_pricing_readiness", {**safe_body, **self._column_payload()}
        )

    async def financial_snapshot_action(self, action: str, body: dict[str, Any]) -> dict[str, Any]:
        if action not in FINANCIAL_SNAPSHOT_ACTIONS:
            raise AppsScriptError(f"Unsupported snapshot action: {action}", http_status=400)
        safe_body = redact_secrets(body)
        return await self._post(action, {**safe_body, **self._column_payload()})

    async def report_action(self, action: str, body: dict[str, Any]) -> dict[str, Any]:
        """Phase 3F report batch actions — returns report data, never PDF bytes."""
        if action not in REPORT_ACTIONS:
            raise AppsScriptError(f"Unsupported report action: {action}", http_status=400)
        safe_body = redact_secrets(body)
        return await self._post(action, {**safe_body, **self._column_payload()})

    async def delivery_action(self, action: str, body: dict[str, Any]) -> dict[str, Any]:
        if action not in DELIVERY_ACTIONS:
            raise AppsScriptError(f"Unsupported delivery action: {action}", http_status=400)
        from app.services.apps_script_payload import build_apps_script_delivery_payload

        # Allowlist business fields only — transport attaches webhook_secret separately.
        safe_body = build_apps_script_delivery_payload(action, body)
        return await self._post(action, {**safe_body, **self._column_payload()})

    async def attachment_action(self, action: str, body: dict[str, Any]) -> dict[str, Any]:
        if action not in ATTACHMENT_ACTIONS:
            raise AppsScriptError(f"Unsupported attachment action: {action}", http_status=400)
        from app.services.apps_script_payload import build_apps_script_delivery_payload

        safe_body = build_apps_script_delivery_payload(action, body)
        return await self._post(action, {**safe_body, **self._column_payload()})

    async def get_job_pdf_data(self, body: dict[str, Any]) -> dict[str, Any]:
        safe_body = redact_secrets(body)
        return await self._post("get_job_pdf_data", {**safe_body, **self._column_payload()})

    async def register_recording(self, body: dict[str, Any]) -> dict[str, Any]:
        safe_body = redact_secrets(body)
        return await self._post("register_recording", {**safe_body, **self._column_payload()})

    async def invalidate_recording(self, body: dict[str, Any]) -> dict[str, Any]:
        safe_body = redact_secrets(body)
        return await self._post("invalidate_recording", {**safe_body, **self._column_payload()})

    async def delete_recording(self, body: dict[str, Any]) -> dict[str, Any]:
        safe_body = redact_secrets(body)
        return await self._post("delete_recording", {**safe_body, **self._column_payload()})
