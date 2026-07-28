"""Phase 3G.1 delivery orchestration for DATA_MODE=apps_script.

FastAPI owns PDF render + provider gates. Apps Script owns durable delivery
metadata via get/create/list/record_delivery_outcome. PDF bytes never cross
the Apps Script boundary.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from fastapi import HTTPException

from app.core.config import Settings
from app.core.logging import get_logger, log_extra
from app.services.delivery_math import (
    DELIVERY_TEMPLATE_VERSION,
    METHOD_DOWNLOAD_ONLY,
    METHOD_DRIVE,
    METHOD_EMAIL,
    METHOD_EMAIL_AND_DRIVE,
    PDF_PROFILES,
    PROFILE_CLIENT_JOB_SUMMARY,
    STATUS_CANCELLED,
    STATUS_DRAFT,
    STATUS_FAILED,
    STATUS_READY,
    STATUS_SENT,
    STATUS_SUPERSEDED,
    apply_pdf_profile,
    build_idempotency_key,
    client_payload_is_clean,
    delivery_transition_error,
    is_manager_or_admin,
    is_valid_email,
    preview_email,
    report_type_for_profile,
)
from app.services.drive_filing import file_document_pdf
from app.services.email_delivery import send_document_email
from app.services.pdf_reports import render_report
from app.services.report_math import (
    ReportSnapshotError,
    normalise_report_pdf_snapshot,
    prepare_report_snapshot_for_render,
    sha256_hex,
    validate_pdf_bytes,
)

logger = get_logger(__name__)

ORCHESTRATED_DELIVERY_ACTIONS = frozenset(
    {
        "preview_delivery",
        "validate_delivery",
        "send_delivery",
        "retry_delivery",
        "cancel_delivery",
        "supersede_delivery",
        "update_delivery_draft",
    }
)


def _now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _require_manager(actor_role: str) -> None:
    if not is_manager_or_admin(actor_role):
        raise HTTPException(status_code=403, detail="Forbidden: manager or admin role required.")


class DeliveryOrchestrator:
    """Live apps_script delivery lifecycle — PDF in FastAPI, metadata in Apps Script."""

    def __init__(self, settings: Settings, repo: Any):
        self.settings = settings
        self.repo = repo

    async def execute(self, action: str, body: dict[str, Any]) -> dict[str, Any]:
        actor_role = str(body.get("actor_role") or "staff")
        staff_id = str(body.get("staff_id") or body.get("actor_staff_id") or "")
        _require_manager(actor_role)

        if action == "preview_delivery":
            return await self._preview(body, staff_id=staff_id, actor_role=actor_role)
        if action == "update_delivery_draft":
            return await self._update_draft(body, staff_id=staff_id, actor_role=actor_role)
        if action == "validate_delivery":
            return await self._validate(body, staff_id=staff_id, actor_role=actor_role)
        if action in {"send_delivery", "retry_delivery"}:
            return await self._send(body, staff_id=staff_id, actor_role=actor_role, retry=action == "retry_delivery")
        if action == "cancel_delivery":
            return await self._cancel(body, staff_id=staff_id, actor_role=actor_role)
        if action == "supersede_delivery":
            return await self._supersede(body, staff_id=staff_id, actor_role=actor_role)
        raise HTTPException(status_code=400, detail=f"Unsupported orchestrated delivery action: {action}")

    async def _as(self, action: str, body: dict[str, Any]) -> dict[str, Any]:
        # Strip anything that must never reach Sheets.
        safe = dict(body)
        for key in (
            "pdf_bytes",
            "pdf_base64",
            "Authorization",
            "authorization",
            "webhook_secret",
            "token",
            "access_token",
            "body",
            "email_body",
            "content_base64",
            "drive_url",
            "public_url",
            "public_link",
        ):
            safe.pop(key, None)
        return await self.repo.adelivery_action(action, safe)

    async def _get(self, delivery_id: str, *, staff_id: str, actor_role: str) -> dict[str, Any]:
        if not delivery_id:
            raise HTTPException(status_code=422, detail="Missing required attribute: delivery_id.")
        result = await self._as(
            "get_delivery",
            {
                "delivery_id": delivery_id,
                "staff_id": staff_id,
                "actor_staff_id": staff_id,
                "actor_role": actor_role,
            },
        )
        delivery = result.get("delivery") if isinstance(result, dict) else None
        if not isinstance(delivery, dict) or not delivery.get("delivery_id"):
            raise HTTPException(status_code=404, detail="Delivery not found.")
        return delivery

    def _check_version(self, delivery: dict[str, Any], expected: Any) -> None:
        if expected in (None, ""):
            return
        if int(delivery.get("version") or 0) != int(expected):
            raise HTTPException(
                status_code=409,
                detail="Conflict: delivery version changed since you loaded this record.",
            )

    async def _list_items(self, *, staff_id: str, actor_role: str, **filters: str) -> list[dict[str, Any]]:
        body = {"staff_id": staff_id, "actor_staff_id": staff_id, "actor_role": actor_role, **filters}
        result = await self._as("list_deliveries", body)
        items = result.get("items") if isinstance(result, dict) else []
        return [row for row in (items or []) if isinstance(row, dict)]

    async def _load_snapshot(self, delivery: dict[str, Any], *, staff_id: str, actor_role: str) -> dict[str, Any]:
        profile = str(delivery.get("document_type") or PROFILE_CLIENT_JOB_SUMMARY)
        if profile not in PDF_PROFILES:
            raise HTTPException(status_code=422, detail=f"Unknown document_type '{profile}'.")
        batch_id = str(delivery.get("report_batch_id") or "").strip()
        job_id = str(delivery.get("job_sheet_id") or "").strip()
        raw: dict[str, Any]
        if batch_id:
            raw = await self.repo.areport_action(
                "get_report_batch_pdf_data",
                {
                    "report_batch_id": batch_id,
                    "staff_id": staff_id,
                    "actor_staff_id": staff_id,
                    "actor_role": actor_role,
                },
            )
        elif job_id:
            raw = await self.repo.aget_job_pdf_data(
                job_id, staff_id, actor_role, actor_identity=staff_id
            )
        else:
            raise HTTPException(
                status_code=422,
                detail="Delivery requires report_batch_id or job_sheet_id.",
            )
        try:
            normalised = normalise_report_pdf_snapshot(raw)
        except ReportSnapshotError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        snapshot = apply_pdf_profile(normalised["snapshot"], profile)
        if snapshot.get("audience") == "client":
            leaks = client_payload_is_clean(snapshot)
            if leaks:
                raise HTTPException(
                    status_code=422,
                    detail=f"Client profile still contains forbidden fields: {', '.join(leaks[:8])}",
                )
        return snapshot

    def _source_token(self, delivery: dict[str, Any], snapshot: dict[str, Any]) -> str:
        batch_id = str(delivery.get("report_batch_id") or "").strip()
        if batch_id:
            return str(delivery.get("checksum") or batch_id)
        return (
            f"{delivery.get('job_sheet_id') or ''}:"
            f"{delivery.get('completion_id') or ''}:"
            f"{delivery.get('document_type') or ''}:"
            f"{snapshot.get('template_version') or DELIVERY_TEMPLATE_VERSION}"
        )

    def _render(self, delivery: dict[str, Any], snapshot: dict[str, Any]) -> dict[str, Any]:
        profile = str(delivery.get("document_type") or PROFILE_CLIENT_JOB_SUMMARY)
        report_type = report_type_for_profile(profile)
        prepared = prepare_report_snapshot_for_render(snapshot, report_type=report_type)
        meta = {
            "report_type": report_type,
            "report_title": profile,
            "template_version": DELIVERY_TEMPLATE_VERSION,
            "audience": snapshot.get("audience") or "internal",
            "internal_ref": delivery.get("delivery_id"),
        }
        pdf = render_report(report_type, prepared, meta)
        byte_size = validate_pdf_bytes(pdf)
        checksum = sha256_hex(pdf)
        slug = profile.lower().replace(" ", "_")
        ref = delivery.get("job_sheet_id") or delivery.get("report_batch_id") or "doc"
        return {
            "pdf_bytes": pdf,
            "byte_size": byte_size,
            "checksum": checksum,
            "file_name": f"nativegrace_{slug}_{ref}.pdf",
            "report_type": report_type,
            "profile": profile,
        }

    async def _record(
        self,
        *,
        delivery_id: str,
        staff_id: str,
        actor_role: str,
        expected_version: Any,
        status: str,
        audit_action: str,
        checksum: str = "",
        idempotency_key: str = "",
        failure_reason: str = "",
        sent_by: str = "",
        sent_at: str | None = None,
        failed_at: str | None = None,
        drive_file_id: str = "",
        template_version: str = DELIVERY_TEMPLATE_VERSION,
        clear_failure: bool = False,
    ) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "delivery_id": delivery_id,
            "staff_id": staff_id,
            "actor_staff_id": staff_id,
            "actor_role": actor_role,
            "expected_version": expected_version,
            "status": status,
            "audit_action": audit_action,
            "template_version": template_version,
            "checksum": checksum,
            "idempotency_key": idempotency_key,
            "failure_reason": failure_reason,
        }
        if sent_by:
            payload["sent_by"] = sent_by
        if sent_at:
            payload["sent_at"] = sent_at
        if failed_at:
            payload["failed_at"] = failed_at
        if clear_failure:
            payload["clear_failure"] = True
        if drive_file_id:
            payload["drive_file_id"] = drive_file_id
        result = await self._as("record_delivery_outcome", payload)
        delivery = result.get("delivery") if isinstance(result, dict) else None
        if not isinstance(delivery, dict):
            raise HTTPException(status_code=502, detail="Apps Script did not persist delivery outcome.")
        return delivery

    def _log(
        self,
        *,
        delivery_id: str,
        method: str,
        profile: str,
        actor_role: str,
        outcome: str,
        checksum_present: bool,
    ) -> None:
        log_extra(
            logger,
            20,
            "Delivery orchestration",
            delivery_id=delivery_id,
            method=method,
            profile=profile,
            actor_role=actor_role,
            provider_enabled=bool(
                self.settings.document_email_enabled or self.settings.document_drive_filing_enabled
            ),
            email_enabled=bool(self.settings.document_email_enabled),
            drive_enabled=bool(self.settings.document_drive_filing_enabled),
            outcome=outcome,
            checksum_present=checksum_present,
        )

    async def _preview(self, body: dict[str, Any], *, staff_id: str, actor_role: str) -> dict[str, Any]:
        delivery = await self._get(str(body.get("delivery_id") or ""), staff_id=staff_id, actor_role=actor_role)
        preview = preview_email(
            document_type=delivery.get("document_type"),
            recipient_email=delivery.get("recipient_email") or "recipient@example.com",
            job_sheet_id=delivery.get("job_sheet_id"),
            customer_name=body.get("customer_name"),
            project_name=body.get("project_name"),
            sent_by_name=str(body.get("actor_identity") or staff_id),
        )
        self._log(
            delivery_id=str(delivery.get("delivery_id")),
            method=str(delivery.get("delivery_method") or ""),
            profile=str(delivery.get("document_type") or ""),
            actor_role=actor_role,
            outcome="preview",
            checksum_present=bool(delivery.get("checksum")),
        )
        return {
            "delivery": delivery,
            "email_preview": preview,
            "confirm_required": True,
            "auto_send": False,
        }

    async def _update_draft(self, body: dict[str, Any], *, staff_id: str, actor_role: str) -> dict[str, Any]:
        # Delegate metadata edit to Apps Script; orchestrator still enforces manager role.
        result = await self._as(
            "update_delivery_draft",
            {
                **body,
                "staff_id": staff_id,
                "actor_staff_id": staff_id,
                "actor_role": actor_role,
            },
        )
        if not isinstance(result.get("delivery"), dict):
            raise HTTPException(status_code=502, detail="Apps Script did not update delivery draft.")
        return result

    async def _validate(self, body: dict[str, Any], *, staff_id: str, actor_role: str) -> dict[str, Any]:
        delivery = await self._get(str(body.get("delivery_id") or ""), staff_id=staff_id, actor_role=actor_role)
        self._check_version(delivery, body.get("expected_version"))
        err = delivery_transition_error(delivery.get("status"), STATUS_READY)
        if err:
            raise HTTPException(status_code=422, detail=err)
        method = str(delivery.get("delivery_method") or METHOD_EMAIL)
        if method in {METHOD_EMAIL, METHOD_EMAIL_AND_DRIVE} and not is_valid_email(
            delivery.get("recipient_email")
        ):
            raise HTTPException(status_code=422, detail="recipient_email is required for email delivery.")

        snapshot = await self._load_snapshot(delivery, staff_id=staff_id, actor_role=actor_role)
        rendered = self._render(delivery, snapshot)
        source_token = self._source_token(delivery, snapshot)
        idem = build_idempotency_key(
            report_batch_id=delivery.get("report_batch_id"),
            job_sheet_id=delivery.get("job_sheet_id"),
            document_type=delivery.get("document_type"),
            recipient_email=delivery.get("recipient_email"),
            checksum=source_token,
            template_version=DELIVERY_TEMPLATE_VERSION,
        )
        # Conflict if another Sent delivery already used this key.
        for other in await self._list_items(staff_id=staff_id, actor_role=actor_role):
            if other.get("delivery_id") == delivery.get("delivery_id"):
                continue
            if str(other.get("status")) == STATUS_SENT and str(other.get("idempotency_key") or "") == idem:
                raise HTTPException(
                    status_code=409,
                    detail="Conflict: an identical delivery was already Sent (idempotency key match).",
                )

        updated = await self._record(
            delivery_id=str(delivery["delivery_id"]),
            staff_id=staff_id,
            actor_role=actor_role,
            expected_version=delivery.get("version"),
            status=STATUS_READY,
            audit_action="validate_delivery",
            checksum=rendered["checksum"],
            idempotency_key=idem,
            clear_failure=True,
        )
        self._log(
            delivery_id=str(delivery.get("delivery_id")),
            method=method,
            profile=str(delivery.get("document_type") or ""),
            actor_role=actor_role,
            outcome="validated",
            checksum_present=True,
        )
        # Never return pdf_bytes to the client.
        return {"delivery": updated}

    async def _send(
        self, body: dict[str, Any], *, staff_id: str, actor_role: str, retry: bool
    ) -> dict[str, Any]:
        if not body.get("confirm_send"):
            raise HTTPException(
                status_code=422,
                detail="Validation Error: confirm_send=true is required. FieldOS never auto-sends.",
            )
        delivery = await self._get(str(body.get("delivery_id") or ""), staff_id=staff_id, actor_role=actor_role)
        self._check_version(delivery, body.get("expected_version"))

        # Idempotent success: same delivery already Sent with a key.
        if str(delivery.get("status")) == STATUS_SENT and delivery.get("idempotency_key"):
            self._log(
                delivery_id=str(delivery.get("delivery_id")),
                method=str(delivery.get("delivery_method") or ""),
                profile=str(delivery.get("document_type") or ""),
                actor_role=actor_role,
                outcome="idempotent_sent",
                checksum_present=bool(delivery.get("checksum")),
            )
            return {"delivery": delivery, "sent": True, "idempotent": True}

        allowed_from = {STATUS_READY, STATUS_FAILED} if retry else {STATUS_READY}
        if str(delivery.get("status")) not in allowed_from:
            raise HTTPException(
                status_code=422,
                detail=(
                    f"Delivery must be Ready{' or Failed' if retry else ''} before send."
                ),
            )

        snapshot = await self._load_snapshot(delivery, staff_id=staff_id, actor_role=actor_role)
        rendered = self._render(delivery, snapshot)
        source_token = self._source_token(delivery, snapshot)
        # Retries get a new key so Failed→Sent is allowed after provider changes.
        if retry:
            source_token = f"{source_token}:retry:{_now()}"
        idem = str(delivery.get("idempotency_key") or "") or build_idempotency_key(
            report_batch_id=delivery.get("report_batch_id"),
            job_sheet_id=delivery.get("job_sheet_id"),
            document_type=delivery.get("document_type"),
            recipient_email=delivery.get("recipient_email"),
            checksum=source_token,
            template_version=DELIVERY_TEMPLATE_VERSION,
        )
        if retry:
            idem = build_idempotency_key(
                report_batch_id=delivery.get("report_batch_id"),
                job_sheet_id=delivery.get("job_sheet_id"),
                document_type=delivery.get("document_type"),
                recipient_email=delivery.get("recipient_email"),
                checksum=source_token,
                template_version=DELIVERY_TEMPLATE_VERSION,
            )

        for other in await self._list_items(staff_id=staff_id, actor_role=actor_role):
            if other.get("delivery_id") == delivery.get("delivery_id"):
                continue
            if str(other.get("status")) == STATUS_SENT and str(other.get("idempotency_key") or "") == idem:
                raise HTTPException(
                    status_code=409,
                    detail="Conflict: duplicate send blocked by idempotency key.",
                )

        method = str(delivery.get("delivery_method") or METHOD_EMAIL)
        failure = ""
        drive_file_id = ""

        if method in {METHOD_EMAIL, METHOD_EMAIL_AND_DRIVE}:
            result = send_document_email(
                self.settings,
                to_email=str(delivery.get("recipient_email") or ""),
                subject=str(delivery.get("subject") or ""),
                body=str(delivery.get("body_preview") or ""),
                pdf_bytes=rendered["pdf_bytes"],
                file_name=rendered["file_name"],
                delivery_id=str(delivery.get("delivery_id")),
                idempotency_key=idem,
            )
            if not result.get("ok"):
                failure = str(result.get("message") or "Email send failed.")

        if not failure and method in {METHOD_DRIVE, METHOD_EMAIL_AND_DRIVE}:
            filed = file_document_pdf(
                self.settings,
                pdf_bytes=rendered["pdf_bytes"],
                file_name=rendered["file_name"],
                customer_name=str(body.get("customer_name") or ""),
                project_name=str(body.get("project_name") or ""),
                year=str(body.get("year") or _now()[:4]),
                job_sheet_id=str(delivery.get("job_sheet_id") or ""),
                delivery_id=str(delivery.get("delivery_id")),
            )
            if filed.get("ok") and filed.get("drive_file_id"):
                drive_file_id = str(filed["drive_file_id"])
            elif method == METHOD_DRIVE and filed.get("skipped"):
                failure = str(filed.get("message") or "Drive filing disabled.")
            elif not filed.get("ok") and not filed.get("skipped"):
                failure = str(filed.get("message") or "Drive filing failed.")
            elif method == METHOD_EMAIL_AND_DRIVE and filed.get("skipped") and not failure:
                # Email already succeeded path — filing skipped is a soft failure for combo.
                failure = str(filed.get("message") or "Drive filing disabled.")

        if method == METHOD_DOWNLOAD_ONLY:
            failure = ""

        if failure:
            updated = await self._record(
                delivery_id=str(delivery["delivery_id"]),
                staff_id=staff_id,
                actor_role=actor_role,
                expected_version=delivery.get("version"),
                status=STATUS_FAILED,
                audit_action="retried" if retry else "failed",
                checksum=rendered["checksum"],
                idempotency_key=idem,
                failure_reason=failure,
                failed_at=_now(),
            )
            self._log(
                delivery_id=str(delivery.get("delivery_id")),
                method=method,
                profile=str(delivery.get("document_type") or ""),
                actor_role=actor_role,
                outcome="failed",
                checksum_present=True,
            )
            return {"delivery": updated, "sent": False}

        updated = await self._record(
            delivery_id=str(delivery["delivery_id"]),
            staff_id=staff_id,
            actor_role=actor_role,
            expected_version=delivery.get("version"),
            status=STATUS_SENT,
            audit_action="retried" if retry else "sent",
            checksum=rendered["checksum"],
            idempotency_key=idem,
            sent_by=staff_id,
            sent_at=_now(),
            drive_file_id=drive_file_id,
            clear_failure=True,
        )
        self._log(
            delivery_id=str(delivery.get("delivery_id")),
            method=method,
            profile=str(delivery.get("document_type") or ""),
            actor_role=actor_role,
            outcome="sent",
            checksum_present=True,
        )
        return {"delivery": updated, "sent": True}

    async def _cancel(self, body: dict[str, Any], *, staff_id: str, actor_role: str) -> dict[str, Any]:
        delivery = await self._get(str(body.get("delivery_id") or ""), staff_id=staff_id, actor_role=actor_role)
        self._check_version(delivery, body.get("expected_version"))
        err = delivery_transition_error(delivery.get("status"), STATUS_CANCELLED)
        if err:
            raise HTTPException(status_code=422, detail=err)
        updated = await self._record(
            delivery_id=str(delivery["delivery_id"]),
            staff_id=staff_id,
            actor_role=actor_role,
            expected_version=delivery.get("version"),
            status=STATUS_CANCELLED,
            audit_action="cancelled",
            checksum=str(delivery.get("checksum") or ""),
            idempotency_key=str(delivery.get("idempotency_key") or ""),
        )
        self._log(
            delivery_id=str(delivery.get("delivery_id")),
            method=str(delivery.get("delivery_method") or ""),
            profile=str(delivery.get("document_type") or ""),
            actor_role=actor_role,
            outcome="cancelled",
            checksum_present=bool(delivery.get("checksum")),
        )
        return {"delivery": updated}

    async def _supersede(self, body: dict[str, Any], *, staff_id: str, actor_role: str) -> dict[str, Any]:
        delivery = await self._get(str(body.get("delivery_id") or ""), staff_id=staff_id, actor_role=actor_role)
        self._check_version(delivery, body.get("expected_version"))
        if str(delivery.get("status")) not in {STATUS_SENT, STATUS_FAILED}:
            raise HTTPException(status_code=422, detail="Only Sent or Failed deliveries can be superseded.")
        superseded = await self._record(
            delivery_id=str(delivery["delivery_id"]),
            staff_id=staff_id,
            actor_role=actor_role,
            expected_version=delivery.get("version"),
            status=STATUS_SUPERSEDED,
            audit_action="superseded",
            checksum=str(delivery.get("checksum") or ""),
            idempotency_key=str(delivery.get("idempotency_key") or ""),
        )
        created = await self._as(
            "create_delivery_draft",
            {
                "staff_id": staff_id,
                "actor_staff_id": staff_id,
                "actor_role": actor_role,
                "document_type": delivery.get("document_type"),
                "recipient_email": delivery.get("recipient_email"),
                "recipient_type": delivery.get("recipient_type"),
                "delivery_method": delivery.get("delivery_method"),
                "report_batch_id": delivery.get("report_batch_id") or None,
                "job_sheet_id": delivery.get("job_sheet_id") or None,
                "completion_id": delivery.get("completion_id") or None,
                "attachment_ids": delivery.get("attachment_ids") or [],
                "supersedes_delivery_id": delivery.get("delivery_id"),
                "customer_name": body.get("customer_name"),
                "project_name": body.get("project_name"),
            },
        )
        replacement = created.get("delivery") if isinstance(created, dict) else None
        if not isinstance(replacement, dict):
            raise HTTPException(status_code=502, detail="Apps Script did not create superseding draft.")
        self._log(
            delivery_id=str(delivery.get("delivery_id")),
            method=str(delivery.get("delivery_method") or ""),
            profile=str(delivery.get("document_type") or ""),
            actor_role=actor_role,
            outcome="superseded",
            checksum_present=bool(delivery.get("checksum")),
        )
        return {
            "delivery": superseded,
            "replacement": replacement,
            "email_preview": created.get("email_preview"),
        }
