"""Mock Phase 3G document deliveries and job attachments (DATA_MODE=mock)."""

from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Any

from fastapi import HTTPException

from app.services.attachment_math import (
    STATUS_APPROVED,
    STATUS_DELETED,
    STATUS_UPLOADED,
    antivirus_boundary_note,
    public_attachment_view,
    safe_attachment_filename,
    validate_attachment_upload,
)
from app.services.delivery_math import (
    DELIVERY_TEMPLATE_VERSION,
    METHOD_DOWNLOAD_ONLY,
    METHOD_DRIVE,
    METHOD_EMAIL,
    METHOD_EMAIL_AND_DRIVE,
    PDF_PROFILES,
    PROFILE_CLIENT_JOB_SUMMARY,
    RECIPIENT_CLIENT,
    STATUS_CANCELLED,
    STATUS_DRAFT,
    STATUS_FAILED,
    STATUS_READY,
    STATUS_SENT,
    STATUS_SUPERSEDED,
    apply_pdf_profile,
    build_idempotency_key,
    client_payload_is_clean,
    delivery_audit_payload,
    delivery_transition_error,
    email_send_allowed,
    drive_filing_allowed,
    is_manager_or_admin,
    is_valid_email,
    normalise_email,
    preview_email,
    report_type_for_profile,
)
from app.services.drive_filing import file_document_pdf
from app.services.email_delivery import send_document_email
from app.services.pdf_reports import render_report
from app.services.report_math import sha256_hex, validate_pdf_bytes


def _now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _id(prefix: str) -> str:
    return f"{prefix}-{uuid.uuid4().hex[:8].upper()}"


class MockDeliveryMixin:
    """Requires self.settings, self.store, and report helpers from MockReportsMixin."""

    def _audit_delivery(self, meta: dict[str, Any]) -> None:
        try:
            self.store.append_sync_log(
                {
                    "record_id": meta.get("delivery_id")
                    or meta.get("attachment_id")
                    or meta.get("job_sheet_id")
                    or "DELIVERY",
                    "target_system": "FieldOS_Deliveries",
                    "status": "Success",
                    "request_payload": delivery_audit_payload(meta),
                    "response_payload": str(meta.get("new_status") or meta.get("status") or ""),
                    "timestamp": _now(),
                }
            )
        except Exception:
            pass

    def _require_manager(self, actor_role: str) -> None:
        if not is_manager_or_admin(actor_role):
            raise HTTPException(status_code=403, detail="Forbidden: manager or admin role required.")

    def _get_delivery(self, delivery_id: str) -> dict[str, Any]:
        row = self.store.get_document_delivery(delivery_id)
        if not row:
            raise HTTPException(status_code=404, detail="Delivery not found.")
        return row

    def _check_delivery_version(self, row: dict[str, Any], expected: Any) -> None:
        if expected in (None, ""):
            return
        if int(row.get("version") or 0) != int(expected):
            raise HTTPException(
                status_code=409,
                detail="Conflict: delivery version changed since you loaded this record.",
            )

    def _public_delivery(self, row: dict[str, Any]) -> dict[str, Any]:
        return {
            "delivery_id": row.get("delivery_id"),
            "report_batch_id": row.get("report_batch_id") or "",
            "job_sheet_id": row.get("job_sheet_id") or "",
            "completion_id": row.get("completion_id") or "",
            "document_type": row.get("document_type"),
            "recipient_type": row.get("recipient_type"),
            "recipient_email": row.get("recipient_email") or "",
            "delivery_method": row.get("delivery_method"),
            "status": row.get("status"),
            "sent_by": row.get("sent_by") or "",
            "sent_at": row.get("sent_at"),
            "failed_at": row.get("failed_at"),
            "failure_reason": row.get("failure_reason") or "",
            "checksum": row.get("checksum") or "",
            "template_version": row.get("template_version") or DELIVERY_TEMPLATE_VERSION,
            "supersedes_delivery_id": row.get("supersedes_delivery_id") or "",
            "idempotency_key": row.get("idempotency_key") or "",
            "file_drive": bool(row.get("drive_file_id")),
            "attachment_ids": list(row.get("attachment_ids") or []),
            "subject": row.get("subject") or "",
            "body_preview": row.get("body_preview") or "",
            "version": int(row.get("version") or 1),
            "created_at": row.get("created_at"),
            "created_by": row.get("created_by") or "",
        }

    def _render_delivery_pdf(self, delivery: dict[str, Any]) -> dict[str, Any]:
        profile = str(delivery.get("document_type") or PROFILE_CLIENT_JOB_SUMMARY)
        report_type = report_type_for_profile(profile)
        snapshot = None
        batch_id = str(delivery.get("report_batch_id") or "")
        if batch_id:
            batch = self.store.get_report_batch(batch_id)
            if not batch or not batch.get("snapshot"):
                raise HTTPException(status_code=422, detail="Report batch snapshot missing for delivery.")
            snapshot = apply_pdf_profile(batch.get("snapshot"), profile)
        else:
            job_id = str(delivery.get("job_sheet_id") or "")
            if not job_id:
                raise HTTPException(status_code=422, detail="Delivery requires report_batch_id or job_sheet_id.")
            payload = self._job_pdf_payload(job_id, delivery.get("created_by") or "system", "manager")
            snapshot = apply_pdf_profile(payload.get("snapshot"), profile)

        leaks = client_payload_is_clean(snapshot) if snapshot.get("audience") == "client" else []
        if leaks:
            raise HTTPException(
                status_code=422,
                detail=f"Client profile still contains forbidden fields: {', '.join(leaks[:8])}",
            )
        meta = {
            "report_type": report_type,
            "report_title": profile,
            "template_version": DELIVERY_TEMPLATE_VERSION,
            "audience": snapshot.get("audience") or "internal",
            "internal_ref": delivery.get("delivery_id"),
        }
        pdf = render_report(report_type, snapshot, meta)
        byte_size = validate_pdf_bytes(pdf)
        checksum = sha256_hex(pdf)
        return {
            "pdf_bytes": pdf,
            "byte_size": byte_size,
            "checksum": checksum,
            "snapshot": snapshot,
            "report_type": report_type,
            "file_name": f"nativegrace_{profile.lower().replace(' ', '_')}_{delivery.get('job_sheet_id') or delivery.get('report_batch_id') or 'doc'}.pdf",
        }

    async def adelivery_action(self, action: str, body: dict[str, Any]) -> dict[str, Any]:
        actor_role = str(body.get("actor_role") or "staff")
        staff_id = str(body.get("staff_id") or body.get("actor_staff_id") or "")
        actor = str(body.get("actor_identity") or staff_id)
        self._require_manager(actor_role)

        if action == "delivery_options":
            return {
                "profiles": list(PDF_PROFILES),
                "statuses": [
                    STATUS_DRAFT,
                    STATUS_READY,
                    STATUS_SENT,
                    STATUS_FAILED,
                    STATUS_CANCELLED,
                    STATUS_SUPERSEDED,
                ],
                "delivery_methods": [
                    METHOD_EMAIL,
                    METHOD_DRIVE,
                    METHOD_EMAIL_AND_DRIVE,
                    METHOD_DOWNLOAD_ONLY,
                ],
                "template_version": DELIVERY_TEMPLATE_VERSION,
                "email_enabled": False,
                "drive_filing_enabled": False,
                "email_gate_reason": email_send_allowed(
                    data_mode=self.settings.data_mode,
                    email_enabled=self.settings.document_email_enabled,
                    fieldos_env=self.settings.fieldos_env,
                )[1],
                "drive_gate_reason": drive_filing_allowed(
                    data_mode=self.settings.data_mode,
                    drive_enabled=self.settings.document_drive_filing_enabled,
                    fieldos_env=self.settings.fieldos_env,
                )[1],
                "antivirus_boundary": antivirus_boundary_note(),
                "auto_send": False,
            }

        if action == "list_deliveries":
            rows = self.store.list_document_deliveries()
            job_filter = str(body.get("job_sheet_id") or "").strip()
            batch_filter = str(body.get("report_batch_id") or "").strip()
            items = []
            for row in rows:
                if job_filter and str(row.get("job_sheet_id") or "") != job_filter:
                    continue
                if batch_filter and str(row.get("report_batch_id") or "") != batch_filter:
                    continue
                items.append(self._public_delivery(row))
            items.sort(key=lambda r: str(r.get("created_at") or ""), reverse=True)
            return {"items": items}

        if action == "get_delivery":
            row = self._get_delivery(str(body.get("delivery_id") or ""))
            return {"delivery": self._public_delivery(row)}

        if action == "create_delivery_draft":
            profile = str(body.get("document_type") or PROFILE_CLIENT_JOB_SUMMARY)
            if profile not in PDF_PROFILES:
                raise HTTPException(status_code=422, detail=f"Unknown document_type '{profile}'.")
            job_sheet_id = str(body.get("job_sheet_id") or "").strip()
            report_batch_id = str(body.get("report_batch_id") or "").strip()
            if not job_sheet_id and not report_batch_id:
                raise HTTPException(
                    status_code=422,
                    detail="Delivery requires report_batch_id or job_sheet_id.",
                )
            recipient_email = normalise_email(body.get("recipient_email"))
            if recipient_email and not is_valid_email(recipient_email):
                raise HTTPException(status_code=422, detail="recipient_email is invalid.")
            method = str(body.get("delivery_method") or METHOD_EMAIL)
            preview = preview_email(
                document_type=profile,
                recipient_email=recipient_email or "recipient@example.com",
                job_sheet_id=job_sheet_id or body.get("job_sheet_id"),
                customer_name=body.get("customer_name"),
                project_name=body.get("project_name"),
                sent_by_name=actor,
            )
            delivery = {
                "delivery_id": _id("DLV"),
                "report_batch_id": report_batch_id,
                "job_sheet_id": job_sheet_id,
                "completion_id": str(body.get("completion_id") or ""),
                "document_type": profile,
                "recipient_type": str(body.get("recipient_type") or RECIPIENT_CLIENT),
                "recipient_email": recipient_email,
                "delivery_method": method,
                "status": STATUS_DRAFT,
                "sent_by": "",
                "sent_at": None,
                "failed_at": None,
                "failure_reason": "",
                "checksum": "",
                "template_version": DELIVERY_TEMPLATE_VERSION,
                "supersedes_delivery_id": str(body.get("supersedes_delivery_id") or ""),
                "idempotency_key": "",
                "drive_file_id": "",
                "attachment_ids": [
                    str(x) for x in (body.get("attachment_ids") or []) if str(x).strip()
                ],
                "subject": preview["subject"],
                "body_preview": preview["body"],
                "confirm_required": True,
                "auto_send": False,
                "created_by": staff_id,
                "created_at": _now(),
                "version": 1,
            }
            self.store.upsert_document_delivery(delivery)
            self._audit_delivery(
                {
                    "action": "create_delivery_draft",
                    "delivery_id": delivery["delivery_id"],
                    "document_type": profile,
                    "recipient_email": recipient_email,
                    "status": STATUS_DRAFT,
                    "new_status": STATUS_DRAFT,
                    "actor_staff_id": staff_id,
                    "actor_role": actor_role,
                }
            )
            return {"delivery": self._public_delivery(delivery), "email_preview": preview}

        if action == "update_delivery_draft":
            row = self._get_delivery(str(body.get("delivery_id") or ""))
            self._check_delivery_version(row, body.get("expected_version"))
            if str(row.get("status")) not in {STATUS_DRAFT, STATUS_FAILED}:
                raise HTTPException(status_code=422, detail="Only Draft or Failed deliveries can be edited.")
            if "recipient_email" in body:
                email = normalise_email(body.get("recipient_email"))
                if email and not is_valid_email(email):
                    raise HTTPException(status_code=422, detail="recipient_email is invalid.")
                row["recipient_email"] = email
            if body.get("document_type"):
                profile = str(body.get("document_type"))
                if profile not in PDF_PROFILES:
                    raise HTTPException(status_code=422, detail=f"Unknown document_type '{profile}'.")
                row["document_type"] = profile
            if body.get("delivery_method"):
                row["delivery_method"] = str(body.get("delivery_method"))
            if body.get("recipient_type"):
                row["recipient_type"] = str(body.get("recipient_type"))
            if "attachment_ids" in body:
                row["attachment_ids"] = [str(x) for x in (body.get("attachment_ids") or []) if str(x).strip()]
            preview = preview_email(
                document_type=row.get("document_type"),
                recipient_email=row.get("recipient_email") or "recipient@example.com",
                job_sheet_id=row.get("job_sheet_id"),
                customer_name=body.get("customer_name"),
                project_name=body.get("project_name"),
                sent_by_name=actor,
            )
            row["subject"] = preview["subject"]
            row["body_preview"] = preview["body"]
            row["version"] = int(row.get("version") or 1) + 1
            self.store.upsert_document_delivery(row)
            self._audit_delivery(
                {
                    "action": "recipient_changed",
                    "delivery_id": row["delivery_id"],
                    "recipient_email": row.get("recipient_email"),
                    "status": row.get("status"),
                    "actor_staff_id": staff_id,
                    "actor_role": actor_role,
                    "version": row["version"],
                }
            )
            return {"delivery": self._public_delivery(row), "email_preview": preview}

        if action == "preview_delivery":
            row = self._get_delivery(str(body.get("delivery_id") or ""))
            preview = preview_email(
                document_type=row.get("document_type"),
                recipient_email=row.get("recipient_email") or "recipient@example.com",
                job_sheet_id=row.get("job_sheet_id"),
                customer_name=body.get("customer_name"),
                project_name=body.get("project_name"),
                sent_by_name=actor,
            )
            return {
                "delivery": self._public_delivery(row),
                "email_preview": preview,
                "confirm_required": True,
                "auto_send": False,
            }

        if action == "validate_delivery":
            row = self._get_delivery(str(body.get("delivery_id") or ""))
            self._check_delivery_version(row, body.get("expected_version"))
            err = delivery_transition_error(row.get("status"), STATUS_READY)
            if err:
                raise HTTPException(status_code=422, detail=err)
            if str(row.get("status")) not in {STATUS_DRAFT, STATUS_FAILED}:
                raise HTTPException(status_code=422, detail="Delivery cannot be validated from this status.")
            if not is_valid_email(row.get("recipient_email")) and str(row.get("delivery_method")) in {
                METHOD_EMAIL,
                METHOD_EMAIL_AND_DRIVE,
            }:
                raise HTTPException(status_code=422, detail="recipient_email is required for email delivery.")
            # Render once so Ready means a PDF can be produced.
            rendered = self._render_delivery_pdf(row)
            row["checksum"] = rendered["checksum"]
            source_token = ""
            batch_id = str(row.get("report_batch_id") or "")
            if batch_id:
                batch = self.store.get_report_batch(batch_id) or {}
                source_token = str(batch.get("checksum") or batch_id)
            else:
                source_token = (
                    f"{row.get('job_sheet_id') or ''}:{row.get('completion_id') or ''}:"
                    f"{row.get('document_type') or ''}"
                )
            row["idempotency_key"] = build_idempotency_key(
                report_batch_id=row.get("report_batch_id"),
                job_sheet_id=row.get("job_sheet_id"),
                document_type=row.get("document_type"),
                recipient_email=row.get("recipient_email"),
                checksum=source_token,
                template_version=row.get("template_version"),
            )
            # Duplicate Sent prevention.
            for other in self.store.list_document_deliveries():
                if other.get("delivery_id") == row.get("delivery_id"):
                    continue
                if (
                    str(other.get("status")) == STATUS_SENT
                    and str(other.get("idempotency_key") or "") == row["idempotency_key"]
                ):
                    raise HTTPException(
                        status_code=409,
                        detail="Conflict: an identical delivery was already Sent (idempotency key match).",
                    )
            previous = row.get("status")
            row["status"] = STATUS_READY
            row["failure_reason"] = ""
            row["version"] = int(row.get("version") or 1) + 1
            self.store.upsert_document_delivery(row)
            self._audit_delivery(
                {
                    "action": "validate_delivery",
                    "delivery_id": row["delivery_id"],
                    "previous_status": previous,
                    "new_status": STATUS_READY,
                    "checksum": row["checksum"],
                    "idempotency_key": row["idempotency_key"],
                    "actor_staff_id": staff_id,
                    "actor_role": actor_role,
                }
            )
            return {"delivery": self._public_delivery(row)}

        if action in {"send_delivery", "retry_delivery"}:
            row = self._get_delivery(str(body.get("delivery_id") or ""))
            self._check_delivery_version(row, body.get("expected_version"))
            if not body.get("confirm_send"):
                raise HTTPException(
                    status_code=422,
                    detail="Validation Error: confirm_send=true is required. FieldOS never auto-sends.",
                )
            allowed_from = {STATUS_READY, STATUS_FAILED} if action == "retry_delivery" else {STATUS_READY}
            if str(row.get("status")) not in allowed_from:
                raise HTTPException(
                    status_code=422,
                    detail=f"Delivery must be Ready{' or Failed' if action == 'retry_delivery' else ''} before send.",
                )
            # Idempotent: if already Sent with same key, return existing.
            for other in self.store.list_document_deliveries():
                if (
                    str(other.get("status")) == STATUS_SENT
                    and str(other.get("idempotency_key") or "")
                    and str(other.get("idempotency_key")) == str(row.get("idempotency_key") or "")
                    and other.get("delivery_id") != row.get("delivery_id")
                ):
                    raise HTTPException(
                        status_code=409,
                        detail="Conflict: duplicate send blocked by idempotency key.",
                    )
            if str(row.get("status")) == STATUS_SENT:
                return {"delivery": self._public_delivery(row), "idempotent": True}

            rendered = self._render_delivery_pdf(row)
            method = str(row.get("delivery_method") or METHOD_EMAIL)
            failure = ""
            drive_file_id = ""

            if method in {METHOD_EMAIL, METHOD_EMAIL_AND_DRIVE}:
                result = send_document_email(
                    self.settings,
                    to_email=str(row.get("recipient_email") or ""),
                    subject=str(row.get("subject") or ""),
                    body=str(row.get("body_preview") or ""),
                    pdf_bytes=rendered["pdf_bytes"],
                    file_name=rendered["file_name"],
                    delivery_id=str(row.get("delivery_id")),
                    idempotency_key=str(row.get("idempotency_key") or ""),
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
                    job_sheet_id=str(row.get("job_sheet_id") or ""),
                    delivery_id=str(row.get("delivery_id")),
                )
                if filed.get("ok") and filed.get("drive_file_id"):
                    drive_file_id = str(filed["drive_file_id"])
                    self._audit_delivery(
                        {
                            "action": "drive_filed",
                            "delivery_id": row["delivery_id"],
                            "drive_filed": True,
                            "actor_staff_id": staff_id,
                            "actor_role": actor_role,
                        }
                    )
                elif not filed.get("skipped"):
                    failure = str(filed.get("message") or "Drive filing failed.")
                elif method == METHOD_DRIVE and filed.get("skipped"):
                    failure = str(filed.get("message") or "Drive filing disabled.")

            if method == METHOD_DOWNLOAD_ONLY:
                # Explicit download path — mark Sent only after manager confirms the control action.
                failure = ""

            previous = row.get("status")
            if failure:
                row["status"] = STATUS_FAILED
                row["failed_at"] = _now()
                row["failure_reason"] = failure
                row["version"] = int(row.get("version") or 1) + 1
                self.store.upsert_document_delivery(row)
                self._audit_delivery(
                    {
                        "action": "failed" if action == "send_delivery" else "retried",
                        "delivery_id": row["delivery_id"],
                        "previous_status": previous,
                        "new_status": STATUS_FAILED,
                        "failure_reason": failure,
                        "actor_staff_id": staff_id,
                        "actor_role": actor_role,
                    }
                )
                return {"delivery": self._public_delivery(row), "sent": False}

            row["status"] = STATUS_SENT
            row["sent_by"] = staff_id
            row["sent_at"] = _now()
            row["failed_at"] = None
            row["failure_reason"] = ""
            row["checksum"] = rendered["checksum"]
            if drive_file_id:
                row["drive_file_id"] = drive_file_id
            row["version"] = int(row.get("version") or 1) + 1
            self.store.upsert_document_delivery(row)
            self._audit_delivery(
                {
                    "action": "sent" if action == "send_delivery" else "retried",
                    "delivery_id": row["delivery_id"],
                    "previous_status": previous,
                    "new_status": STATUS_SENT,
                    "checksum": row["checksum"],
                    "idempotency_key": row.get("idempotency_key"),
                    "actor_staff_id": staff_id,
                    "actor_role": actor_role,
                    "drive_filed": bool(drive_file_id),
                }
            )
            return {"delivery": self._public_delivery(row), "sent": True}

        if action == "cancel_delivery":
            row = self._get_delivery(str(body.get("delivery_id") or ""))
            self._check_delivery_version(row, body.get("expected_version"))
            err = delivery_transition_error(row.get("status"), STATUS_CANCELLED)
            if err:
                raise HTTPException(status_code=422, detail=err)
            previous = row.get("status")
            row["status"] = STATUS_CANCELLED
            row["version"] = int(row.get("version") or 1) + 1
            self.store.upsert_document_delivery(row)
            self._audit_delivery(
                {
                    "action": "cancelled",
                    "delivery_id": row["delivery_id"],
                    "previous_status": previous,
                    "new_status": STATUS_CANCELLED,
                    "actor_staff_id": staff_id,
                    "actor_role": actor_role,
                }
            )
            return {"delivery": self._public_delivery(row)}

        if action == "supersede_delivery":
            row = self._get_delivery(str(body.get("delivery_id") or ""))
            self._check_delivery_version(row, body.get("expected_version"))
            if str(row.get("status")) not in {STATUS_SENT, STATUS_FAILED}:
                raise HTTPException(status_code=422, detail="Only Sent or Failed deliveries can be superseded.")
            previous = row.get("status")
            row["status"] = STATUS_SUPERSEDED
            row["version"] = int(row.get("version") or 1) + 1
            self.store.upsert_document_delivery(row)
            # New draft pointing at same source, new Drive file on next send.
            draft = {
                **{k: v for k, v in row.items() if k not in {"delivery_id", "sent_at", "sent_by", "drive_file_id"}},
                "delivery_id": _id("DLV"),
                "status": STATUS_DRAFT,
                "supersedes_delivery_id": row["delivery_id"],
                "sent_at": None,
                "sent_by": "",
                "failed_at": None,
                "failure_reason": "",
                "drive_file_id": "",
                "checksum": "",
                "idempotency_key": "",
                "created_at": _now(),
                "created_by": staff_id,
                "version": 1,
            }
            self.store.upsert_document_delivery(draft)
            self._audit_delivery(
                {
                    "action": "superseded",
                    "delivery_id": row["delivery_id"],
                    "previous_status": previous,
                    "new_status": STATUS_SUPERSEDED,
                    "supersedes_delivery_id": row["delivery_id"],
                    "actor_staff_id": staff_id,
                    "actor_role": actor_role,
                }
            )
            return {
                "delivery": self._public_delivery(row),
                "replacement": self._public_delivery(draft),
            }

        raise HTTPException(status_code=400, detail=f"Unsupported delivery action: {action}")

    async def aattachment_action(self, action: str, body: dict[str, Any]) -> dict[str, Any]:
        actor_role = str(body.get("actor_role") or "staff")
        staff_id = str(body.get("staff_id") or body.get("actor_staff_id") or "")

        if action == "list_attachments":
            job_id = str(body.get("job_sheet_id") or "").strip()
            if not job_id:
                raise HTTPException(status_code=422, detail="job_sheet_id is required.")
            # Staff may list attachments for jobs they can access via existing job gates.
            rows = [
                public_attachment_view(row, include_storage_ref=is_manager_or_admin(actor_role))
                for row in self.store.list_job_attachments(job_id)
                if str(row.get("status")) != STATUS_DELETED
            ]
            return {"items": rows, "antivirus_boundary": antivirus_boundary_note()}

        if action == "upload_attachment":
            job_id = str(body.get("job_sheet_id") or "").strip()
            if not job_id:
                raise HTTPException(status_code=422, detail="job_sheet_id is required.")
            filename = safe_attachment_filename(body.get("file_name"))
            mime_type = str(body.get("mime_type") or "")
            byte_size = int(body.get("byte_size") or 0)
            attachment_type = str(body.get("attachment_type") or "other")
            blockers = validate_attachment_upload(
                filename=filename,
                mime_type=mime_type,
                byte_size=byte_size,
                attachment_type=attachment_type,
                max_bytes=self.settings.max_attachment_bytes,
            )
            if blockers:
                raise HTTPException(status_code=422, detail="; ".join(blockers))
            # Bytes themselves stay in local recordings-style dir or are omitted in mock metadata mode.
            content_b64 = body.get("content_base64")
            checksum = str(body.get("checksum") or "")
            if content_b64 and not checksum:
                import base64

                raw = base64.b64decode(content_b64)
                checksum = sha256_hex(raw)
                byte_size = len(raw)
            row = {
                "attachment_id": _id("ATT"),
                "job_sheet_id": job_id,
                "completion_id": str(body.get("completion_id") or ""),
                "attachment_type": attachment_type,
                "file_name": filename,
                "mime_type": mime_type,
                "byte_size": byte_size,
                "caption": str(body.get("caption") or "")[:500],
                "uploaded_by": staff_id,
                "uploaded_at": _now(),
                "client_visible": False,
                "approved_by": "",
                "approved_at": None,
                "storage_ref": f"mock://attachments/{job_id}/{filename}",
                "drive_file_id": "",
                "checksum": checksum,
                "status": STATUS_UPLOADED,
                "version": 1,
            }
            self.store.upsert_job_attachment(row)
            self._audit_delivery(
                {
                    "action": "attachment_uploaded",
                    "attachment_id": row["attachment_id"],
                    "job_sheet_id": job_id,
                    "actor_staff_id": staff_id,
                    "actor_role": actor_role,
                }
            )
            return {
                "attachment": public_attachment_view(row, include_storage_ref=is_manager_or_admin(actor_role)),
                "antivirus_boundary": antivirus_boundary_note(),
            }

        if action == "delete_attachment":
            self._require_manager(actor_role)
            row = self.store.get_job_attachment(str(body.get("attachment_id") or ""))
            if not row:
                raise HTTPException(status_code=404, detail="Attachment not found.")
            row["status"] = STATUS_DELETED
            row["client_visible"] = False
            row["version"] = int(row.get("version") or 1) + 1
            self.store.upsert_job_attachment(row)
            self._audit_delivery(
                {
                    "action": "attachment_removed",
                    "attachment_id": row["attachment_id"],
                    "job_sheet_id": row.get("job_sheet_id"),
                    "actor_staff_id": staff_id,
                    "actor_role": actor_role,
                }
            )
            return {"attachment": public_attachment_view(row)}

        if action == "set_attachment_client_visible":
            self._require_manager(actor_role)
            row = self.store.get_job_attachment(str(body.get("attachment_id") or ""))
            if not row:
                raise HTTPException(status_code=404, detail="Attachment not found.")
            visible = bool(body.get("client_visible"))
            if visible and str(row.get("status")) == STATUS_DELETED:
                raise HTTPException(status_code=422, detail="Deleted attachments cannot be client-visible.")
            row["client_visible"] = visible
            if visible:
                row["status"] = STATUS_APPROVED
                row["approved_by"] = staff_id
                row["approved_at"] = _now()
            else:
                row["approved_by"] = ""
                row["approved_at"] = None
                if str(row.get("status")) == STATUS_APPROVED:
                    row["status"] = STATUS_UPLOADED
            row["version"] = int(row.get("version") or 1) + 1
            self.store.upsert_job_attachment(row)
            self._audit_delivery(
                {
                    "action": "attachment_visibility_changed",
                    "attachment_id": row["attachment_id"],
                    "job_sheet_id": row.get("job_sheet_id"),
                    "client_visible": visible,
                    "actor_staff_id": staff_id,
                    "actor_role": actor_role,
                }
            )
            return {"attachment": public_attachment_view(row, include_storage_ref=True)}

        raise HTTPException(status_code=400, detail=f"Unsupported attachment action: {action}")
