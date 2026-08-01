"""Apps Script webhook client — secrets never leave the server or appear in logs."""

from __future__ import annotations

import time
from typing import Any, Optional
from urllib.parse import urljoin, urlparse

import httpx

from app.core.config import Settings
from app.core.logging import get_logger, log_extra
from app.services.drive_upload import redact_secrets, safe_json_preview

logger = get_logger(__name__)

# ContentService returns 302 → script.googleusercontent.com/macros/echo?...
_REDIRECT_STATUSES = frozenset({301, 302, 303, 307, 308})
# First hop from /exec + up to 2 further redirects (never re-POST /exec).
_MAX_CONTENTSERVICE_REDIRECTS = 3
_ALLOWED_REDIRECT_HOSTS = frozenset({"script.googleusercontent.com"})

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

    def __init__(
        self,
        message: str,
        *,
        http_status: Optional[int] = None,
        apps_status: Optional[str] = None,
        code: Optional[str] = None,
    ):
        super().__init__(message)
        self.http_status = http_status
        self.apps_status = apps_status
        self.code = code


def _redirect_hostname(url: str) -> str:
    try:
        return (urlparse(url).hostname or "").lower()
    except Exception:
        return ""


def _is_allowed_contentservice_redirect_host(hostname: str) -> bool:
    host = (hostname or "").lower().strip(".")
    if not host:
        return False
    if host in _ALLOWED_REDIRECT_HOSTS:
        return True
    # Explicitly approved sibling hosts for signed echo responses.
    if host.endswith(".googleusercontent.com"):
        return True
    return False


def _looks_like_html(response: httpx.Response) -> bool:
    ctype = (response.headers.get("content-type") or "").lower()
    if "text/html" in ctype or "application/xhtml" in ctype:
        return True
    text = (response.text or "").lstrip()[:64].lower()
    return text.startswith("<!doctype html") or text.startswith("<html")


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

    def _post_timeout(self) -> httpx.Timeout:
        read = float(getattr(self.settings, "apps_script_timeout_seconds", 90.0) or 90.0)
        return httpx.Timeout(connect=15.0, read=read, write=30.0, pool=15.0)

    def _redirect_get_timeout(self) -> httpx.Timeout:
        read = float(
            getattr(self.settings, "apps_script_redirect_get_timeout_seconds", 15.0) or 15.0
        )
        return httpx.Timeout(connect=10.0, read=read, write=15.0, pool=10.0)

    async def _follow_contentservice_redirects(
        self,
        client: httpx.AsyncClient,
        response: httpx.Response,
        *,
        action: str,
        post_elapsed_ms: int,
        post_finished_at: float,
    ) -> httpx.Response:
        """POST /exec may return ContentService 302; fetch Location with GET only.

        Never re-POSTs the webhook payload. Never follows back to script.google.com/exec.
        """
        seen: set[str] = set()
        redirect_num = 0
        current = response

        while current.status_code in _REDIRECT_STATUSES:
            location = (current.headers.get("location") or "").strip()
            if not location:
                log_extra(
                    logger,
                    40,
                    "Apps Script redirect missing Location",
                    action=action,
                    initial_http_status=response.status_code,
                    redirect_number=redirect_num,
                    final_http_status=current.status_code,
                    post_elapsed_ms=post_elapsed_ms,
                )
                raise AppsScriptError(
                    "Apps Script redirect missing Location header.",
                    http_status=502,
                    code="apps_script_missing_location",
                )

            absolute = urljoin(str(current.url), location)
            host = _redirect_hostname(absolute)
            wait_ms = int((time.monotonic() - post_finished_at) * 1000)
            log_extra(
                logger,
                20,
                "Apps Script ContentService redirect",
                action=action,
                initial_http_status=response.status_code,
                redirect_number=redirect_num + 1,
                redirect_hostname=host,
                post_elapsed_ms=post_elapsed_ms,
                redirect_get_wait_ms=wait_ms,
            )

            if not _is_allowed_contentservice_redirect_host(host):
                log_extra(
                    logger,
                    40,
                    "Apps Script redirect host rejected",
                    action=action,
                    redirect_number=redirect_num + 1,
                    redirect_hostname=host,
                    post_elapsed_ms=post_elapsed_ms,
                )
                raise AppsScriptError(
                    f"Apps Script redirect host rejected ({host or 'unknown'}).",
                    http_status=502,
                    code="apps_script_redirect_host_rejected",
                )

            if absolute in seen:
                raise AppsScriptError(
                    "Apps Script redirect loop detected.",
                    http_status=502,
                    code="apps_script_redirect_loop",
                )
            seen.add(absolute)

            redirect_num += 1
            if redirect_num > _MAX_CONTENTSERVICE_REDIRECTS:
                raise AppsScriptError(
                    "Apps Script redirect limit exceeded.",
                    http_status=502,
                    code="apps_script_redirect_loop",
                )

            get_started = time.monotonic()
            try:
                # Exact Location URL — do not alter signed query parameters.
                current = await client.get(
                    absolute,
                    timeout=self._redirect_get_timeout(),
                    follow_redirects=False,
                )
            except httpx.TimeoutException as exc:
                log_extra(
                    logger,
                    40,
                    "Apps Script redirect GET timeout",
                    action=action,
                    redirect_number=redirect_num,
                    redirect_hostname=host,
                    post_elapsed_ms=post_elapsed_ms,
                    redirect_get_elapsed_ms=int((time.monotonic() - get_started) * 1000),
                )
                raise AppsScriptError(
                    "Apps Script redirect GET timed out.",
                    http_status=504,
                    code="apps_script_timeout",
                ) from exc
            except httpx.HTTPError as exc:
                log_extra(
                    logger,
                    40,
                    "Apps Script redirect GET transport error",
                    action=action,
                    redirect_number=redirect_num,
                    redirect_hostname=host,
                    error=type(exc).__name__,
                )
                raise AppsScriptError(
                    "Apps Script redirect GET unreachable.",
                    http_status=502,
                    code="apps_script_redirect_expired",
                ) from exc

            log_extra(
                logger,
                20,
                "Apps Script redirect GET completed",
                action=action,
                redirect_number=redirect_num,
                redirect_hostname=host,
                final_http_status=current.status_code,
                final_content_type=(current.headers.get("content-type") or "")[:80],
                final_body_length=len(current.content or b""),
                post_elapsed_ms=post_elapsed_ms,
                redirect_get_elapsed_ms=int((time.monotonic() - get_started) * 1000),
                redirect_get_wait_ms=wait_ms,
            )

            if current.status_code == 404:
                raise AppsScriptError(
                    "Apps Script ContentService redirect expired (404).",
                    http_status=502,
                    code="apps_script_redirect_expired",
                )

        return current

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

        # Explicit ContentService handling — do NOT use follow_redirects=True.
        # Generic redirect following can re-POST or chase back to /exec HTML.
        # Contract: POST JSON once to /exec, then GET the exact Location.
        # Never automatically retry the original POST (critical for creates).
        started = time.monotonic()
        try:
            async with httpx.AsyncClient(follow_redirects=False) as client:
                try:
                    response = await client.post(
                        self.settings.apps_script_webapp_url,
                        json=payload,
                        headers={"Content-Type": "application/json"},
                        timeout=self._post_timeout(),
                    )
                except httpx.TimeoutException as exc:
                    log_extra(
                        logger,
                        40,
                        "Apps Script timeout",
                        action=action,
                        post_elapsed_ms=int((time.monotonic() - started) * 1000),
                    )
                    raise AppsScriptError(
                        "Apps Script request timed out.",
                        http_status=504,
                        code="apps_script_timeout",
                    ) from exc
                except httpx.HTTPError as exc:
                    log_extra(
                        logger,
                        40,
                        "Apps Script transport error",
                        action=action,
                        error=type(exc).__name__,
                    )
                    raise AppsScriptError(
                        "Apps Script unreachable.",
                        http_status=502,
                    ) from exc

                post_finished_at = time.monotonic()
                post_elapsed_ms = int((post_finished_at - started) * 1000)
                log_extra(
                    logger,
                    20,
                    "Apps Script initial response",
                    action=action,
                    initial_http_status=response.status_code,
                    post_elapsed_ms=post_elapsed_ms,
                    content_type=(response.headers.get("content-type") or "")[:80],
                    body_length=len(response.content or b""),
                )

                response = await self._follow_contentservice_redirects(
                    client,
                    response,
                    action=action,
                    post_elapsed_ms=post_elapsed_ms,
                    post_finished_at=post_finished_at,
                )
        except AppsScriptError:
            raise

        if _looks_like_html(response):
            log_extra(
                logger,
                40,
                "Apps Script HTML response",
                action=action,
                final_http_status=response.status_code,
                final_content_type=(response.headers.get("content-type") or "")[:80],
                final_body_length=len(response.content or b""),
            )
            raise AppsScriptError(
                "Apps Script returned HTML instead of JSON.",
                http_status=502,
                code="apps_script_response_html",
            )

        try:
            data = response.json()
        except Exception as exc:
            preview = (response.text or "")[:120]
            log_extra(
                logger,
                40,
                "Apps Script non-JSON response",
                action=action,
                http_status=response.status_code,
                final_content_type=(response.headers.get("content-type") or "")[:80],
                final_body_length=len(response.content or b""),
                preview=preview,
            )
            raise AppsScriptError(
                f"Invalid Apps Script response ({response.status_code}).",
                http_status=502,
                code="apps_script_response_invalid_json",
            ) from exc

        if not isinstance(data, dict) or "status" not in data:
            log_extra(
                logger,
                40,
                "Apps Script invalid payload shape",
                action=action,
                preview=safe_json_preview(data),
            )
            raise AppsScriptError(
                "Invalid Apps Script response shape.",
                http_status=502,
                code="apps_script_response_invalid_json",
            )

        apps_status = str(data.get("status", ""))
        data_block = data.get("data") if isinstance(data.get("data"), dict) else {}
        jobs = data_block.get("jobs") if isinstance(data_block, dict) else None
        job_count = len(jobs) if isinstance(jobs, list) else None
        job_block = data.get("job") if isinstance(data.get("job"), dict) else {}
        if not job_block and isinstance(data_block.get("job"), dict):
            job_block = data_block.get("job") or {}
        log_extra(
            logger,
            20 if apps_status.lower() == "success" else 40,
            "Apps Script response",
            action=action,
            http_status=response.status_code,
            apps_status=apps_status,
            apps_message=str(data.get("message", ""))[:200],
            job_count=job_count,
            top_level_keys=sorted(str(k) for k in data.keys()),
            data_keys=sorted(str(k) for k in data_block.keys()) if data_block else [],
            job_keys=sorted(str(k) for k in job_block.keys()) if job_block else [],
            has_record_id=bool(str(data.get("record_id") or "").strip()),
            has_job_sheet_id=bool(
                str(data.get("job_sheet_id") or "").strip()
                or str(job_block.get("job_sheet_id") or "").strip()
                or str(data_block.get("job_sheet_id") or "").strip()
            ),
            final_content_type=(response.headers.get("content-type") or "")[:80],
            final_body_length=len(response.content or b""),
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

    async def list_job_create_masters(self, body: dict[str, Any]) -> dict[str, Any]:
        safe_body = redact_secrets(body)
        return await self._post("list_job_create_masters", {**safe_body, **self._column_payload()})

    async def create_job_sheet_from_recording(self, body: dict[str, Any]) -> dict[str, Any]:
        from app.services.apps_script_payload import build_apps_script_create_job_from_recording_payload

        safe_body = build_apps_script_create_job_from_recording_payload(body)
        return await self._post(
            "create_job_sheet_from_recording", {**safe_body, **self._column_payload()}
        )

    async def create_completed_job_sheet_from_recordings(self, body: dict[str, Any]) -> dict[str, Any]:
        from app.services.apps_script_payload import build_apps_script_create_completed_job_sheet_payload

        safe_body = build_apps_script_create_completed_job_sheet_payload(body)
        return await self._post(
            "create_completed_job_sheet_from_recordings",
            {**safe_body, **self._column_payload()},
        )

    async def get_completed_job_sheet_create_result(self, body: dict[str, Any]) -> dict[str, Any]:
        """Reconcile prior create via tbl_daily_work_create_keys — never creates."""
        safe_body = redact_secrets(body)
        return await self._post(
            "get_completed_job_sheet_create_result",
            {**safe_body, **self._column_payload()},
        )

    async def invalidate_recording(self, body: dict[str, Any]) -> dict[str, Any]:
        safe_body = redact_secrets(body)
        return await self._post("invalidate_recording", {**safe_body, **self._column_payload()})

    async def delete_recording(self, body: dict[str, Any]) -> dict[str, Any]:
        safe_body = redact_secrets(body)
        return await self._post("delete_recording", {**safe_body, **self._column_payload()})
