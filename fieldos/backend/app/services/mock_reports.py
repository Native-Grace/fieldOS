"""Mock-mode Phase 3F report batches and single-job PDF data.

Batch lifecycle mirrors mock_export.py: Draft → Validated → Generated, with
Cancelled available until a batch has been generated. Generating freezes a
scrubbed JSON snapshot; downloads re-render that snapshot so the store never
holds PDF bytes and the checksum stays reproducible.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Any

from fastapi import HTTPException

from app.core.roles import is_manager_or_admin
from app.services.export_math import default_dashboard_range, normalise_calendar_date
from app.services.pdf_reports import render_report
from app.services.report_math import (
    ITEM_BLOCKED,
    ITEM_PENDING,
    ITEM_READY,
    REPORT_AUDIENCE,
    REPORT_COMPLETION_REGISTER,
    REPORT_JOB_SHEET_SUMMARY,
    REPORT_LANDSCAPE_DEFAULT,
    REPORT_TYPES,
    STAFF_ALLOWED_REPORT_TYPES,
    STATUS_REPORT_CANCELLED,
    STATUS_REPORT_DRAFT,
    STATUS_REPORT_GENERATED,
    STATUS_REPORT_VALIDATED,
    TEMPLATE_VERSION,
    bundle_totals,
    estimate_pages,
    extract_task_lines,
    group_bundles,
    matches_report_filters,
    report_readiness,
    report_type_option,
    reportable_rows,
    safe_report_filename,
    scrub_report_record,
    sha256_hex,
    sum_totals,
    validate_pdf_bytes,
)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


class MockReportsMixin:
    """Requires self.store, self.settings and the mock completion helpers."""

    def _audit_report(self, meta: dict[str, Any]) -> None:
        self.store.append_sync_log(
            {
                "record_id": meta.get("report_batch_id") or meta.get("job_sheet_id") or "REPORT",
                "target_system": "FieldOS_Report",
                "status": "Success",
                "request_payload": {
                    "action": meta.get("action"),
                    "report_batch_id": meta.get("report_batch_id"),
                    "report_type": meta.get("report_type"),
                    "job_sheet_id": meta.get("job_sheet_id"),
                    "actor_staff_id": meta.get("actor_staff_id"),
                    "actor_role": meta.get("actor_role"),
                    "previous_status": meta.get("previous_status"),
                    "new_status": meta.get("new_status"),
                    "record_count": meta.get("record_count"),
                    "checksum": meta.get("checksum"),
                    "template_version": TEMPLATE_VERSION,
                },
                "response_payload": meta.get("new_status") or "",
            }
        )

    # ----------------------------------------------------------------- access

    def _report_type(self, value: Any) -> str:
        report_type = str(value or REPORT_COMPLETION_REGISTER)
        if report_type not in REPORT_TYPES:
            raise HTTPException(status_code=422, detail="Validation Error: unsupported report_type.")
        return report_type

    def _authorise_report(
        self, actor_role: str, report_type: str, staff_id: str, filters: dict[str, Any] | None
    ) -> dict[str, Any]:
        """Managers see everything; staff get their own labour on the staff report only."""
        resolved = dict(filters or {})
        if is_manager_or_admin(actor_role):
            return resolved
        if report_type not in STAFF_ALLOWED_REPORT_TYPES:
            raise HTTPException(
                status_code=403,
                detail=f"Manager or admin role required for {report_type}.",
            )
        if not staff_id:
            raise HTTPException(status_code=403, detail="Staff reports require a staff identity.")
        resolved["staff_id"] = staff_id
        return resolved

    # ---------------------------------------------------------------- bundles

    def _report_job_display(self, job: dict[str, Any]) -> dict[str, Any]:
        settings = self.settings
        return {
            "job_sheet_id": str(job.get("job_sheet_id") or ""),
            "job_date": normalise_calendar_date(
                job.get(settings.job_date_column) or job.get("job_date") or job.get("date")
            )
            or "",
            "customer_name": str(
                job.get("customer_name") or job.get(settings.job_customer_column) or ""
            ),
            "project_name": str(job.get("project_name") or job.get(settings.job_project_column) or ""),
            "approval_status": str(job.get("approval_status") or ""),
            "processing_status": str(job.get("processing_status") or ""),
            "assigned_staff_id": str(
                job.get("assigned_staff_id") or job.get(settings.job_assignment_column) or ""
            ),
            "manager_review_items": str(job.get("manager_review_items") or ""),
            "variations": str(job.get("variations") or ""),
        }

    def _report_completion_view(self, completion: dict[str, Any]) -> dict[str, Any]:
        return {
            "completion_id": str(completion.get("completion_id") or ""),
            "job_sheet_id": str(completion.get("job_sheet_id") or ""),
            "completion_status": str(completion.get("completion_status") or ""),
            "work_summary": str(completion.get("work_summary") or ""),
            "invoice_description": str(completion.get("invoice_description") or ""),
            "internal_notes": str(completion.get("internal_notes") or ""),
            "variations": list(completion.get("variations") or []),
            "warnings": [str(w) for w in (completion.get("warnings") or [])],
            "warning_resolutions": list(completion.get("warning_resolutions") or []),
            "finalised_by": str(completion.get("finalised_by") or ""),
            "finalised_at": completion.get("finalised_at"),
            "version": int(completion.get("version") or 1),
        }

    def _report_bundle(self, completion: dict[str, Any]) -> dict[str, Any]:
        job_sheet_id = str(completion.get("job_sheet_id") or "")
        raw_job = self.store.get_job(job_sheet_id) or {"job_sheet_id": job_sheet_id}
        job = self._report_job_display(raw_job)
        view = self._report_completion_view(completion)
        bundle = {
            "job": job,
            "completion": view,
            # Reports print confirmed work only — suggested rows are never published.
            "labour_entries": reportable_rows(completion.get("labour_entries")),
            "machinery_entries": reportable_rows(completion.get("machinery_entries")),
            "material_entries": reportable_rows(completion.get("material_entries")),
            "task_lines": extract_task_lines(job, view),
        }
        bundle["totals"] = bundle_totals(bundle)
        return bundle

    def _report_bundles(self, filters: dict[str, Any]) -> list[dict[str, Any]]:
        bundles: list[dict[str, Any]] = []
        for completion in self.store.list_completions():
            bundle = self._report_bundle(completion)
            if matches_report_filters(bundle, filters):
                bundles.append(bundle)
        bundles.sort(
            key=lambda b: (
                str((b.get("job") or {}).get("job_date") or ""),
                str((b.get("job") or {}).get("job_sheet_id") or ""),
            )
        )
        return bundles

    def _resolve_filters(self, body: dict[str, Any]) -> dict[str, Any]:
        defaults = default_dashboard_range()
        filters = dict(body.get("filters") or {})
        filters.setdefault("date_from", body.get("date_from") or defaults["date_from"])
        filters.setdefault("date_to", body.get("date_to") or defaults["date_to"])
        for key in ("customer", "project", "assigned_staff_id", "completion_status", "approval_status", "q"):
            if body.get(key) and not filters.get(key):
                filters[key] = body[key]
        if body.get("job_sheet_ids"):
            filters["job_sheet_ids"] = [str(x) for x in body["job_sheet_ids"]]
        return {key: value for key, value in filters.items() if value not in (None, "")}

    def _build_snapshot(
        self, report_type: str, filters: dict[str, Any], bundles: list[dict[str, Any]]
    ) -> dict[str, Any]:
        audience = REPORT_AUDIENCE.get(report_type, "internal")
        scrubbed = [scrub_report_record(bundle, audience=audience) for bundle in bundles]
        groups = group_bundles(scrubbed, report_type)
        snapshot: dict[str, Any] = {
            "report_type": report_type,
            "template_version": TEMPLATE_VERSION,
            "audience": audience,
            "filters": scrub_report_record(filters, audience=audience),
            "groups": groups,
            "totals": sum_totals([group.get("totals") or {} for group in groups]),
            "job_count": len(scrubbed),
        }
        if report_type == REPORT_JOB_SHEET_SUMMARY:
            snapshot["bundles"] = scrubbed
            if len(scrubbed) == 1:
                snapshot.update(scrubbed[0])
        return snapshot

    def _snapshot_meta(self, batch: dict[str, Any]) -> dict[str, Any]:
        report_type = str(batch.get("report_type") or "")
        return {
            "report_type": report_type,
            "report_title": report_type,
            "generated_at": str(batch.get("completed_at") or batch.get("created_at") or ""),
            "generated_by": str(batch.get("generated_by") or batch.get("created_by") or ""),
            "internal_ref": str(batch.get("report_batch_id") or ""),
            "template_version": str(batch.get("template_version") or TEMPLATE_VERSION),
            "audience": REPORT_AUDIENCE.get(report_type, "internal"),
            "landscape": batch.get("landscape"),
        }

    # --------------------------------------------------------------- assembly

    def _assemble_report_batch(self, batch: dict[str, Any]) -> dict[str, Any]:
        items = sorted(
            self.store.list_report_batch_items(str(batch.get("report_batch_id") or "")),
            key=lambda row: str(row.get("job_sheet_id") or ""),
        )
        return {
            "report_batch": {
                "report_batch_id": batch.get("report_batch_id"),
                "report_type": batch.get("report_type"),
                "date_from": batch.get("date_from") or "",
                "date_to": batch.get("date_to") or "",
                "filter_json": batch.get("filter_json") or {},
                "status": batch.get("status"),
                "record_count": int(batch.get("record_count") or 0),
                "page_estimate": int(batch.get("page_estimate") or 0),
                "audience": batch.get("audience") or "internal",
                "landscape": bool(batch.get("landscape")),
                "template_version": batch.get("template_version") or TEMPLATE_VERSION,
                "created_by": batch.get("created_by") or "",
                "created_at": batch.get("created_at"),
                "generated_by": batch.get("generated_by") or "",
                "completed_at": batch.get("completed_at"),
                "file_name": batch.get("file_name") or "",
                "checksum": batch.get("checksum") or "",
                "byte_size": int(batch.get("byte_size") or 0),
                "notes": batch.get("notes") or "",
                "version": int(batch.get("version") or 1),
            },
            "items": items,
        }

    def _check_report_version(self, batch: dict[str, Any], expected: Any) -> None:
        if expected in (None, ""):
            return
        if int(batch.get("version") or 0) != int(expected):
            raise HTTPException(
                status_code=409,
                detail="Conflict: report batch version changed since you loaded this record.",
            )

    def _require_report_batch(self, report_batch_id: str, actor_role: str, staff_id: str) -> dict[str, Any]:
        batch = self.store.get_report_batch(report_batch_id)
        if not batch:
            raise HTTPException(status_code=404, detail="Report batch not found.")
        self._authorise_report(
            actor_role, str(batch.get("report_type") or ""), staff_id, batch.get("filter_json")
        )
        if not is_manager_or_admin(actor_role):
            owned = str((batch.get("filter_json") or {}).get("staff_id") or "")
            if owned and owned != staff_id:
                raise HTTPException(status_code=403, detail="Report batch belongs to another staff member.")
        return batch

    # --------------------------------------------------------------- renderer

    def render_report_pdf(self, report_batch_id: str) -> bytes:
        """Re-render a generated batch from its frozen snapshot."""
        batch = self.store.get_report_batch(report_batch_id)
        if not batch:
            raise HTTPException(status_code=404, detail="Report batch not found.")
        if str(batch.get("status")) != STATUS_REPORT_GENERATED:
            raise HTTPException(
                status_code=422, detail="Validation Error: report has not been generated."
            )
        snapshot = batch.get("snapshot") or {}
        if not snapshot:
            raise HTTPException(status_code=422, detail="Validation Error: report snapshot missing.")
        return render_report(str(batch.get("report_type")), snapshot, self._snapshot_meta(batch))

    def render_job_summary_pdf(
        self, job_sheet_id: str, staff_id: str, actor_role: str, *, actor_identity: str = ""
    ) -> tuple[bytes, str]:
        data = self._job_pdf_payload(job_sheet_id, staff_id, actor_role, actor_identity=actor_identity)
        pdf = render_report(REPORT_JOB_SHEET_SUMMARY, data["snapshot"], data["meta"])
        return pdf, str(data["file_name"])

    def _job_pdf_payload(
        self, job_sheet_id: str, staff_id: str, actor_role: str, *, actor_identity: str = ""
    ) -> dict[str, Any]:
        # Reuses review access control: staff only reach their own assigned jobs.
        self.get_job_for_review(job_sheet_id, staff_id, actor_role)
        completion = self.store.get_completion_for_job(job_sheet_id)
        if not completion:
            raise HTTPException(status_code=404, detail="No completion recorded for this job sheet.")
        snapshot = scrub_report_record(self._report_bundle(completion), audience="internal")
        snapshot["report_type"] = REPORT_JOB_SHEET_SUMMARY
        snapshot["template_version"] = TEMPLATE_VERSION
        return {
            "job_sheet_id": job_sheet_id,
            "report_type": REPORT_JOB_SHEET_SUMMARY,
            "template_version": TEMPLATE_VERSION,
            "file_name": safe_report_filename(REPORT_JOB_SHEET_SUMMARY, job_sheet_id=job_sheet_id),
            "snapshot": snapshot,
            "meta": {
                "report_type": REPORT_JOB_SHEET_SUMMARY,
                "report_title": REPORT_JOB_SHEET_SUMMARY,
                "generated_at": _now(),
                "generated_by": actor_identity or staff_id,
                "internal_ref": job_sheet_id,
                "template_version": TEMPLATE_VERSION,
                "audience": "internal",
                "landscape": False,
            },
        }

    async def aget_job_pdf_data(
        self, job_sheet_id: str, staff_id: str, actor_role: str, *, actor_identity: str = ""
    ) -> dict[str, Any]:
        payload = self._job_pdf_payload(
            job_sheet_id, staff_id, actor_role, actor_identity=actor_identity
        )
        self._audit_report(
            {
                "action": "get_job_pdf_data",
                "job_sheet_id": job_sheet_id,
                "report_type": REPORT_JOB_SHEET_SUMMARY,
                "actor_staff_id": staff_id,
                "actor_role": actor_role,
                "new_status": "Rendered",
            }
        )
        return payload

    def get_job_pdf(
        self, job_sheet_id: str, staff_id: str, actor_role: str, *, actor_identity: str = ""
    ) -> dict[str, Any]:
        """PDF bytes plus checksum for a single job sheet."""
        pdf, file_name = self.render_job_summary_pdf(
            job_sheet_id, staff_id, actor_role, actor_identity=actor_identity
        )
        byte_size = validate_pdf_bytes(pdf)
        return {
            "job_sheet_id": job_sheet_id,
            "file_name": file_name,
            "content_type": "application/pdf",
            "checksum": sha256_hex(pdf),
            "byte_size": byte_size,
            "pdf_bytes": pdf,
        }

    # ---------------------------------------------------------------- actions

    async def areport_action(self, action: str, body: dict[str, Any]) -> dict[str, Any]:
        actor_role = str(body.get("actor_role") or "staff")
        staff_id = str(body.get("staff_id") or body.get("actor_staff_id") or "")
        actor = str(body.get("actor_identity") or staff_id)

        if action == "report_options":
            allowed = (
                list(REPORT_TYPES)
                if is_manager_or_admin(actor_role)
                else list(STAFF_ALLOWED_REPORT_TYPES)
            )
            defaults = default_dashboard_range()
            return {
                "report_types": [report_type_option(name) for name in allowed],
                "statuses": [
                    STATUS_REPORT_DRAFT,
                    STATUS_REPORT_VALIDATED,
                    STATUS_REPORT_GENERATED,
                    STATUS_REPORT_CANCELLED,
                ],
                "report_statuses": [
                    STATUS_REPORT_DRAFT,
                    STATUS_REPORT_VALIDATED,
                    STATUS_REPORT_GENERATED,
                    STATUS_REPORT_CANCELLED,
                ],
                "template_version": TEMPLATE_VERSION,
                "default_filters": defaults,
                "landscape_defaults": {
                    key: bool(value) for key, value in REPORT_LANDSCAPE_DEFAULT.items()
                },
                "audiences": {key: REPORT_AUDIENCE[key] for key in allowed},
                "filter_keys": [
                    "date_from",
                    "date_to",
                    "staff",
                    "customer",
                    "project",
                    "completion_status",
                    "approval_status",
                    "billable",
                    "job_sheet_id",
                    "completion_id",
                ],
                "scoped_to_staff_id": "" if is_manager_or_admin(actor_role) else staff_id,
                "actor_role": actor_role,
            }

        if action == "report_preview":
            report_type = self._report_type(body.get("report_type"))
            filters = self._authorise_report(
                actor_role, report_type, staff_id, self._resolve_filters(body)
            )
            bundles = self._report_bundles(filters)
            snapshot = self._build_snapshot(report_type, filters, bundles)
            blockers: list[str] = []
            for bundle in bundles:
                blockers.extend(report_readiness(bundle, report_type))
            return {
                "report_type": report_type,
                "filters": filters,
                "template_version": TEMPLATE_VERSION,
                "job_count": len(bundles),
                "group_count": len(snapshot.get("groups") or []),
                "page_estimate": estimate_pages(snapshot, report_type),
                "totals": snapshot.get("totals") or {},
                "blockers": sorted(set(blockers)),
                "items": [
                    {
                        "job_sheet_id": (bundle.get("job") or {}).get("job_sheet_id") or "",
                        "completion_id": (bundle.get("completion") or {}).get("completion_id") or "",
                        "job_date": (bundle.get("job") or {}).get("job_date") or "",
                        "customer_name": (bundle.get("job") or {}).get("customer_name") or "",
                        "project_name": (bundle.get("job") or {}).get("project_name") or "",
                        "blocker_summary": "; ".join(report_readiness(bundle, report_type)),
                    }
                    for bundle in bundles
                ],
            }

        if action == "list_report_batches":
            rows = sorted(
                self.store.list_report_batches(),
                key=lambda row: str(row.get("created_at") or ""),
                reverse=True,
            )
            if not is_manager_or_admin(actor_role):
                rows = [
                    row
                    for row in rows
                    if str(row.get("report_type")) in STAFF_ALLOWED_REPORT_TYPES
                    and str((row.get("filter_json") or {}).get("staff_id") or "") == staff_id
                ]
            return {
                "items": [
                    {
                        "report_batch_id": row.get("report_batch_id"),
                        "report_type": row.get("report_type"),
                        "status": row.get("status"),
                        "record_count": int(row.get("record_count") or 0),
                        "page_estimate": int(row.get("page_estimate") or 0),
                        "date_from": row.get("date_from") or "",
                        "date_to": row.get("date_to") or "",
                        "created_at": row.get("created_at"),
                        "file_name": row.get("file_name") or "",
                        "checksum": row.get("checksum") or "",
                        "version": int(row.get("version") or 1),
                    }
                    for row in rows
                ]
            }

        if action == "create_report_batch":
            report_type = self._report_type(body.get("report_type"))
            filters = self._authorise_report(
                actor_role, report_type, staff_id, self._resolve_filters(body)
            )
            bundles = self._report_bundles(filters)
            if not bundles:
                raise HTTPException(
                    status_code=422,
                    detail="Validation Error: no completions match the report filters.",
                )
            now = _now()
            batch_id = f"RPT-{uuid.uuid4().hex[:8].upper()}"
            landscape = body.get("landscape")
            if landscape is None:
                landscape = REPORT_LANDSCAPE_DEFAULT.get(report_type, False)
            items = [
                {
                    "report_batch_item_id": f"RPI-{uuid.uuid4().hex[:8].upper()}",
                    "report_batch_id": batch_id,
                    "job_sheet_id": (bundle.get("job") or {}).get("job_sheet_id") or "",
                    "completion_id": (bundle.get("completion") or {}).get("completion_id") or "",
                    "item_status": ITEM_PENDING,
                    "blocker_summary": "",
                    "created_at": now,
                }
                for bundle in bundles
            ]
            snapshot_preview = self._build_snapshot(report_type, filters, bundles)
            batch = {
                "report_batch_id": batch_id,
                "report_type": report_type,
                "date_from": str(filters.get("date_from") or ""),
                "date_to": str(filters.get("date_to") or ""),
                "filter_json": filters,
                "status": STATUS_REPORT_DRAFT,
                "record_count": len(items),
                "page_estimate": estimate_pages(snapshot_preview, report_type),
                "audience": REPORT_AUDIENCE.get(report_type, "internal"),
                "landscape": bool(landscape),
                "template_version": TEMPLATE_VERSION,
                "created_by": actor,
                "created_at": now,
                "generated_by": "",
                "completed_at": None,
                "file_name": "",
                "checksum": "",
                "byte_size": 0,
                "notes": str(body.get("notes") or ""),
                "snapshot": None,
                "version": 1,
            }
            self.store.upsert_report_batch(batch)
            self.store.replace_report_batch_items(batch_id, items)
            self._audit_report(
                {
                    "action": action,
                    "report_batch_id": batch_id,
                    "report_type": report_type,
                    "actor_staff_id": staff_id,
                    "actor_role": actor_role,
                    "new_status": STATUS_REPORT_DRAFT,
                    "record_count": len(items),
                }
            )
            return self._assemble_report_batch(batch)

        batch_id = str(body.get("report_batch_id") or "")
        batch = self._require_report_batch(batch_id, actor_role, staff_id)
        report_type = str(batch.get("report_type") or "")

        if action == "get_report_batch":
            return self._assemble_report_batch(batch)

        if action == "validate_report_batch":
            self._check_report_version(batch, body.get("expected_version"))
            if str(batch.get("status")) == STATUS_REPORT_GENERATED:
                raise HTTPException(
                    status_code=422, detail="Validation Error: Generated reports are immutable."
                )
            if str(batch.get("status")) == STATUS_REPORT_CANCELLED:
                raise HTTPException(
                    status_code=422, detail="Validation Error: Cancelled reports cannot be validated."
                )
            bundles = self._report_bundles(batch.get("filter_json") or {})
            by_job = {
                str((bundle.get("job") or {}).get("job_sheet_id") or ""): bundle for bundle in bundles
            }
            items = self.store.list_report_batch_items(batch_id)
            all_ok = bool(items)
            for item in items:
                bundle = by_job.get(str(item.get("job_sheet_id") or ""))
                if not bundle:
                    item["item_status"] = ITEM_BLOCKED
                    item["blocker_summary"] = "Job no longer matches the report filters."
                    all_ok = False
                    continue
                blockers = report_readiness(bundle, report_type)
                item["item_status"] = ITEM_BLOCKED if blockers else ITEM_READY
                item["blocker_summary"] = "; ".join(blockers)
                if blockers:
                    all_ok = False
            self.store.replace_report_batch_items(batch_id, items)
            previous = str(batch.get("status") or "")
            batch["status"] = STATUS_REPORT_VALIDATED if all_ok else STATUS_REPORT_DRAFT
            batch["version"] = int(batch.get("version") or 1) + 1
            self.store.upsert_report_batch(batch)
            self._audit_report(
                {
                    "action": action,
                    "report_batch_id": batch_id,
                    "report_type": report_type,
                    "actor_staff_id": staff_id,
                    "actor_role": actor_role,
                    "previous_status": previous,
                    "new_status": batch["status"],
                    "record_count": len(items),
                }
            )
            return self._assemble_report_batch(batch)

        if action == "generate_report_batch":
            self._check_report_version(batch, body.get("expected_version"))
            if str(batch.get("status")) == STATUS_REPORT_GENERATED:
                raise HTTPException(
                    status_code=422,
                    detail=(
                        "Validation Error: Generated reports are immutable — create a new report "
                        "to regenerate."
                    ),
                )
            if str(batch.get("status")) == STATUS_REPORT_CANCELLED:
                raise HTTPException(
                    status_code=422, detail="Validation Error: Cancelled reports cannot be generated."
                )
            if str(batch.get("status")) != STATUS_REPORT_VALIDATED:
                raise HTTPException(
                    status_code=422, detail="Validation Error: validate the report before generating."
                )
            items = self.store.list_report_batch_items(batch_id)
            if any(str(item.get("item_status")) == ITEM_BLOCKED for item in items):
                raise HTTPException(
                    status_code=422, detail="Validation Error: report still has blocked items."
                )
            filters = batch.get("filter_json") or {}
            bundles = self._report_bundles(filters)
            if not bundles:
                raise HTTPException(
                    status_code=422, detail="Validation Error: no completions left to report."
                )
            snapshot = self._build_snapshot(report_type, filters, bundles)
            completed_at = _now()
            previous = str(batch.get("status") or "")
            batch.update(
                {
                    "status": STATUS_REPORT_GENERATED,
                    "completed_at": completed_at,
                    "generated_by": actor,
                    "snapshot": snapshot,
                    "record_count": len(bundles),
                    "page_estimate": estimate_pages(snapshot, report_type),
                    "file_name": safe_report_filename(
                        report_type,
                        batch.get("date_from"),
                        batch.get("date_to"),
                    ),
                    "version": int(batch.get("version") or 1) + 1,
                }
            )
            # Render once now so a broken snapshot fails here rather than at download.
            pdf = render_report(report_type, snapshot, self._snapshot_meta(batch))
            try:
                byte_size = validate_pdf_bytes(pdf)
            except ValueError as exc:
                raise HTTPException(
                    status_code=422, detail=f"Validation Error: {exc}"
                ) from exc
            batch["checksum"] = sha256_hex(pdf)
            batch["byte_size"] = byte_size
            self.store.upsert_report_batch(batch)
            self._audit_report(
                {
                    "action": action,
                    "report_batch_id": batch_id,
                    "report_type": report_type,
                    "actor_staff_id": staff_id,
                    "actor_role": actor_role,
                    "previous_status": previous,
                    "new_status": STATUS_REPORT_GENERATED,
                    "record_count": len(bundles),
                    "checksum": batch["checksum"],
                }
            )
            return self._assemble_report_batch(batch)

        if action == "cancel_report_batch":
            self._check_report_version(batch, body.get("expected_version"))
            if str(batch.get("status")) == STATUS_REPORT_GENERATED:
                raise HTTPException(
                    status_code=422, detail="Validation Error: Generated reports cannot be cancelled."
                )
            previous = str(batch.get("status") or "")
            batch["status"] = STATUS_REPORT_CANCELLED
            batch["version"] = int(batch.get("version") or 1) + 1
            self.store.upsert_report_batch(batch)
            self._audit_report(
                {
                    "action": action,
                    "report_batch_id": batch_id,
                    "report_type": report_type,
                    "actor_staff_id": staff_id,
                    "actor_role": actor_role,
                    "previous_status": previous,
                    "new_status": STATUS_REPORT_CANCELLED,
                    "record_count": int(batch.get("record_count") or 0),
                }
            )
            return self._assemble_report_batch(batch)

        if action == "get_report_batch_pdf_data":
            if str(batch.get("status")) != STATUS_REPORT_GENERATED:
                raise HTTPException(
                    status_code=422, detail="Validation Error: report has not been generated."
                )
            snapshot = batch.get("snapshot") or {}
            if not snapshot:
                raise HTTPException(status_code=422, detail="Validation Error: report snapshot missing.")
            self._audit_report(
                {
                    "action": "download_report_batch",
                    "report_batch_id": batch_id,
                    "report_type": report_type,
                    "actor_staff_id": staff_id,
                    "actor_role": actor_role,
                    "new_status": batch.get("status"),
                    "record_count": int(batch.get("record_count") or 0),
                    "checksum": batch.get("checksum") or "",
                }
            )
            assembled = self._assemble_report_batch(batch)
            return {
                "batch": assembled["report_batch"],
                "snapshot": snapshot,
                "items": assembled["items"],
                # Legacy flat aliases kept for older callers / diagnostics.
                "report_batch_id": batch_id,
                "report_type": report_type,
                "template_version": str(batch.get("template_version") or TEMPLATE_VERSION),
                "file_name": str(batch.get("file_name") or safe_report_filename(report_type)),
                "content_type": "application/pdf",
                "checksum": str(batch.get("checksum") or ""),
                "audience": REPORT_AUDIENCE.get(report_type, "internal"),
                "meta": self._snapshot_meta(batch),
            }

        raise HTTPException(status_code=400, detail=f"Unsupported report action: {action}")
