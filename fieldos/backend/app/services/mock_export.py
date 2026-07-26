"""Mock-mode Phase 3D completion dashboard + export batches."""

from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Any

from fastapi import HTTPException

from app.core.roles import is_manager_or_admin
from app.services.completion_math import STATUS_DRAFT, STATUS_FINALISED, STATUS_REOPENED
from app.services.export_math import (
    EXPORT_SUMMARY_CSV,
    EXPORT_TYPES,
    STATUS_BATCH_CANCELLED,
    STATUS_BATCH_DRAFT,
    STATUS_BATCH_EXPORTED,
    STATUS_BATCH_VALIDATED,
    build_csv_for_type,
    compute_export_readiness,
    date_in_inclusive_range,
    default_dashboard_range,
    normalise_calendar_date,
    safe_export_filename,
)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


class MockExportMixin:
    """Requires self.store and get_job_for_review / list completions helpers."""

    def _audit_export(self, meta: dict[str, Any]) -> None:
        self.store.append_sync_log(
            {
                "record_id": meta.get("export_batch_id") or "EXPORT",
                "target_system": "FieldOS_Export",
                "status": "Success",
                "request_payload": {
                    "action": meta.get("action"),
                    "export_batch_id": meta.get("export_batch_id"),
                    "export_type": meta.get("export_type"),
                    "actor_staff_id": meta.get("actor_staff_id"),
                    "actor_role": meta.get("actor_role"),
                    "previous_status": meta.get("previous_status"),
                    "new_status": meta.get("new_status"),
                    "record_count": meta.get("record_count"),
                    "checksum": meta.get("checksum"),
                    "date_from": meta.get("date_from"),
                    "date_to": meta.get("date_to"),
                },
                "response_payload": meta.get("new_status") or "",
            }
        )

    def _job_display(self, job: dict[str, Any]) -> dict[str, Any]:
        settings = self.settings
        return {
            "job_sheet_id": str(job.get("job_sheet_id") or ""),
            "job_date": normalise_calendar_date(
                job.get(settings.job_date_column) or job.get("date") or job.get("job_date")
            )
            or "",
            "customer_name": str(job.get(settings.job_customer_column) or job.get("customer_name") or ""),
            "project_name": str(job.get(settings.job_project_column) or job.get("project_name") or ""),
            "approval_status": str(job.get("approval_status") or ""),
            "processing_status": str(job.get("processing_status") or ""),
            "assigned_staff_id": str(job.get(settings.job_assignment_column) or job.get("staff_id") or ""),
        }

    def _completion_bundle(self, completion: dict[str, Any]) -> dict[str, Any]:
        job = self.store.get_job(str(completion.get("job_sheet_id") or "")) or {
            "job_sheet_id": completion.get("job_sheet_id")
        }
        labour = list(completion.get("labour_entries") or [])
        machinery = list(completion.get("machinery_entries") or [])
        materials = list(completion.get("material_entries") or [])
        readiness = compute_export_readiness(completion, job, labour, machinery, materials)
        return {
            "completion": completion,
            "job": self._job_display(job),
            "labour_entries": labour,
            "machinery_entries": machinery,
            "material_entries": materials,
            "readiness": readiness,
        }

    def _matches_filters(self, bundle: dict[str, Any], filters: dict[str, Any]) -> bool:
        completion = bundle["completion"]
        job = bundle["job"]
        job_date = normalise_calendar_date(job.get("job_date"))
        if not date_in_inclusive_range(job_date, filters.get("date_from"), filters.get("date_to")):
            return False
        if filters.get("finalised_from") or filters.get("finalised_to"):
            fin = normalise_calendar_date(completion.get("finalised_at"))
            if not date_in_inclusive_range(
                fin, filters.get("finalised_from"), filters.get("finalised_to")
            ):
                return False
        if filters.get("completion_status") and str(completion.get("completion_status")) != str(
            filters["completion_status"]
        ):
            return False
        if filters.get("approval_status") and str(job.get("approval_status")) != str(filters["approval_status"]):
            return False
        if filters.get("customer"):
            if str(filters["customer"]).lower() not in str(job.get("customer_name") or "").lower():
                return False
        if filters.get("project"):
            if str(filters["project"]).lower() not in str(job.get("project_name") or "").lower():
                return False
        if filters.get("assigned_staff_id") and str(job.get("assigned_staff_id")) != str(
            filters["assigned_staff_id"]
        ):
            return False
        if filters.get("billable") in (True, "true", "TRUE") and not (
            float(completion.get("billable_labour_hours") or 0) > 0
        ):
            return False
        if filters.get("billable") in (False, "false", "FALSE") and float(
            completion.get("billable_labour_hours") or 0
        ) > 0:
            return False
        if filters.get("q"):
            blob = " ".join(
                [
                    str(completion.get("job_sheet_id") or ""),
                    str(completion.get("work_summary") or ""),
                    str(completion.get("invoice_description") or ""),
                    str(job.get("customer_name") or ""),
                    str(job.get("project_name") or ""),
                ]
            ).lower()
            if str(filters["q"]).lower() not in blob:
                return False
        return True

    def _dashboard_items(self, filters: dict[str, Any]) -> list[dict[str, Any]]:
        items: list[dict[str, Any]] = []
        for completion in self.store.list_completions():
            bundle = self._completion_bundle(completion)
            if not self._matches_filters(bundle, filters):
                continue
            readiness = bundle["readiness"]
            items.append(
                {
                    "job_date": bundle["job"]["job_date"],
                    "job_sheet_id": completion.get("job_sheet_id"),
                    "completion_id": completion.get("completion_id"),
                    "customer_name": bundle["job"]["customer_name"],
                    "project_name": bundle["job"]["project_name"],
                    "completion_status": completion.get("completion_status"),
                    "approval_status": bundle["job"]["approval_status"],
                    "finalised_by": completion.get("finalised_by") or "",
                    "finalised_at": completion.get("finalised_at"),
                    "total_labour_hours": completion.get("total_labour_hours") or 0,
                    "total_travel_hours": completion.get("total_travel_hours") or 0,
                    "total_machinery_hours": completion.get("total_machinery_hours") or 0,
                    "billable_labour_hours": completion.get("billable_labour_hours") or 0,
                    "non_billable_labour_hours": completion.get("non_billable_labour_hours") or 0,
                    "unresolved_warning_count": readiness["warning_count"],
                    "invoice_ready": readiness["invoice_ready"],
                    "payroll_ready": readiness["payroll_ready"],
                    "export_status": (
                        "Ready"
                        if str(completion.get("completion_status")) == STATUS_FINALISED
                        and (readiness["invoice_ready"] or readiness["payroll_ready"])
                        else (
                            "Blocked"
                            if str(completion.get("completion_status")) == STATUS_FINALISED
                            else "Not finalised"
                        )
                    ),
                    "version": int(completion.get("version") or 1),
                }
            )
        items.sort(key=lambda row: (str(row.get("job_date") or ""), str(row.get("job_sheet_id") or "")), reverse=True)
        return items

    def _summarise(self, items: list[dict[str, Any]]) -> dict[str, Any]:
        summary = {
            "job_count": len(items),
            "finalised_jobs": 0,
            "draft_or_reopened_jobs": 0,
            "total_labour_hours": 0.0,
            "total_travel_hours": 0.0,
            "total_machinery_hours": 0.0,
            "billable_labour_hours": 0.0,
            "non_billable_labour_hours": 0.0,
            "unresolved_warnings": 0,
            "jobs_ready_for_invoice_export": 0,
            "jobs_ready_for_payroll_export": 0,
        }
        for row in items:
            if row.get("completion_status") == STATUS_FINALISED:
                summary["finalised_jobs"] += 1
            if row.get("completion_status") in (STATUS_DRAFT, STATUS_REOPENED):
                summary["draft_or_reopened_jobs"] += 1
            for key in (
                "total_labour_hours",
                "total_travel_hours",
                "total_machinery_hours",
                "billable_labour_hours",
                "non_billable_labour_hours",
            ):
                summary[key] += float(row.get(key) or 0)
            summary["unresolved_warnings"] += int(row.get("unresolved_warning_count") or 0)
            if row.get("invoice_ready"):
                summary["jobs_ready_for_invoice_export"] += 1
            if row.get("payroll_ready"):
                summary["jobs_ready_for_payroll_export"] += 1
        for key in (
            "total_labour_hours",
            "total_travel_hours",
            "total_machinery_hours",
            "billable_labour_hours",
            "non_billable_labour_hours",
        ):
            summary[key] = round(summary[key], 2)
        return summary

    def _assemble_batch(self, batch: dict[str, Any]) -> dict[str, Any]:
        items = list(batch.get("items") or [])
        items.sort(key=lambda row: str(row.get("job_sheet_id") or ""))
        return {
            "export_batch": {
                "export_batch_id": batch.get("export_batch_id"),
                "export_type": batch.get("export_type"),
                "date_from": batch.get("date_from"),
                "date_to": batch.get("date_to"),
                "filter_json": batch.get("filter_json") or {},
                "status": batch.get("status"),
                "record_count": batch.get("record_count") or 0,
                "created_by": batch.get("created_by") or "",
                "created_at": batch.get("created_at"),
                "completed_at": batch.get("completed_at"),
                "file_name": batch.get("file_name") or "",
                "checksum": batch.get("checksum") or "",
                "notes": batch.get("notes") or "",
                "version": int(batch.get("version") or 1),
            },
            "items": items,
        }

    def _check_batch_version(self, batch: dict[str, Any], expected: Any) -> None:
        if expected in (None, ""):
            return
        if int(batch.get("version") or 0) != int(expected):
            raise HTTPException(
                status_code=409,
                detail="Conflict: export batch version changed since you loaded this record.",
            )

    async def acompletion_dashboard(self, actor_role: str, filters: dict[str, Any]) -> dict[str, Any]:
        if not is_manager_or_admin(actor_role):
            raise HTTPException(status_code=403, detail="Manager or admin role required.")
        range_defaults = default_dashboard_range()
        resolved = {
            "date_from": filters.get("date_from") or range_defaults["date_from"],
            "date_to": filters.get("date_to") or range_defaults["date_to"],
            "completion_status": filters.get("completion_status") or "",
            "approval_status": filters.get("approval_status") or "",
            "customer": filters.get("customer") or "",
            "project": filters.get("project") or "",
            "assigned_staff_id": filters.get("assigned_staff_id") or "",
            "billable": filters.get("billable"),
            "q": filters.get("q") or "",
        }
        items = self._dashboard_items(resolved)
        return {"items": items, "filters": resolved, "summary": self._summarise(items)}

    async def acompletion_dashboard_summary(self, actor_role: str, filters: dict[str, Any]) -> dict[str, Any]:
        data = await self.acompletion_dashboard(actor_role, filters)
        return {"summary": data["summary"], "filters": data["filters"]}

    async def acompletion_export_readiness(
        self, actor_role: str, completion_id: str
    ) -> dict[str, Any]:
        if not is_manager_or_admin(actor_role):
            raise HTTPException(status_code=403, detail="Manager or admin role required.")
        completion = None
        for row in self.store.list_completions():
            if str(row.get("completion_id")) == str(completion_id):
                completion = row
                break
        if not completion:
            raise HTTPException(status_code=404, detail="Completion not found.")
        bundle = self._completion_bundle(completion)
        return {
            "completion_id": completion_id,
            "job_sheet_id": completion.get("job_sheet_id"),
            "readiness": bundle["readiness"],
        }

    async def aexport_action(self, action: str, body: dict[str, Any]) -> dict[str, Any]:
        actor_role = str(body.get("actor_role") or "staff")
        if not is_manager_or_admin(actor_role):
            raise HTTPException(status_code=403, detail="Manager or admin role required.")
        staff_id = str(body.get("staff_id") or body.get("actor_staff_id") or "")
        actor = str(body.get("actor_identity") or staff_id)

        if action == "list_export_batches":
            rows = sorted(
                self.store.list_export_batches(),
                key=lambda row: str(row.get("created_at") or ""),
                reverse=True,
            )
            return {
                "items": [
                    {
                        "export_batch_id": row.get("export_batch_id"),
                        "export_type": row.get("export_type"),
                        "status": row.get("status"),
                        "record_count": row.get("record_count") or 0,
                        "date_from": row.get("date_from"),
                        "date_to": row.get("date_to"),
                        "created_at": row.get("created_at"),
                        "file_name": row.get("file_name") or "",
                        "version": int(row.get("version") or 1),
                    }
                    for row in rows
                ]
            }

        if action == "create_export_batch":
            export_type = str(body.get("export_type") or EXPORT_SUMMARY_CSV)
            if export_type not in EXPORT_TYPES:
                raise HTTPException(status_code=422, detail="Validation Error: unsupported export_type.")
            range_defaults = default_dashboard_range()
            filters = body.get("filters") or {
                "date_from": body.get("date_from") or range_defaults["date_from"],
                "date_to": body.get("date_to") or range_defaults["date_to"],
            }
            dashboard = self._dashboard_items(filters)
            selected_ids = body.get("completion_ids")
            if selected_ids is not None:
                selected_ids = {str(x) for x in selected_ids}
                dashboard = [row for row in dashboard if str(row.get("completion_id")) in selected_ids]
            if not dashboard:
                raise HTTPException(
                    status_code=422, detail="Validation Error: no completions match the export filters."
                )
            now = _now()
            batch_id = f"EXP-{uuid.uuid4().hex[:8].upper()}"
            items = [
                {
                    "export_batch_item_id": f"EXI-{uuid.uuid4().hex[:8].upper()}",
                    "export_batch_id": batch_id,
                    "job_sheet_id": row.get("job_sheet_id"),
                    "completion_id": row.get("completion_id"),
                    "item_status": "Pending",
                    "blocker_summary": "",
                    "created_at": now,
                }
                for row in dashboard
            ]
            batch = {
                "export_batch_id": batch_id,
                "export_type": export_type,
                "date_from": str(filters.get("date_from") or range_defaults["date_from"]),
                "date_to": str(filters.get("date_to") or range_defaults["date_to"]),
                "filter_json": filters,
                "status": STATUS_BATCH_DRAFT,
                "record_count": len(items),
                "created_by": actor,
                "created_at": now,
                "completed_at": None,
                "file_name": "",
                "checksum": "",
                "notes": str(body.get("notes") or ""),
                "snapshot": None,
                "items": items,
                "version": 1,
            }
            self.store.upsert_export_batch(batch)
            self._audit_export(
                {
                    "action": action,
                    "export_batch_id": batch_id,
                    "export_type": export_type,
                    "actor_staff_id": staff_id,
                    "actor_role": actor_role,
                    "new_status": STATUS_BATCH_DRAFT,
                    "record_count": len(items),
                    "date_from": batch["date_from"],
                    "date_to": batch["date_to"],
                }
            )
            return self._assemble_batch(batch)

        batch_id = str(body.get("export_batch_id") or "")
        batch = self.store.get_export_batch(batch_id)
        if not batch:
            raise HTTPException(status_code=404, detail="Export batch not found.")

        if action == "get_export_batch":
            return self._assemble_batch(batch)

        if action == "validate_export_batch":
            self._check_batch_version(batch, body.get("expected_version"))
            if batch.get("status") == STATUS_BATCH_EXPORTED:
                raise HTTPException(status_code=422, detail="Validation Error: Exported batches are immutable.")
            if batch.get("status") == STATUS_BATCH_CANCELLED:
                raise HTTPException(
                    status_code=422, detail="Validation Error: Cancelled batches cannot be validated."
                )
            all_ok = True
            for item in batch.get("items") or []:
                completion = None
                for row in self.store.list_completions():
                    if str(row.get("completion_id")) == str(item.get("completion_id")):
                        completion = row
                        break
                if not completion:
                    item["item_status"] = "Blocked"
                    item["blocker_summary"] = "Completion not found."
                    all_ok = False
                    continue
                readiness = self._completion_bundle(completion)["readiness"]
                export_type = str(batch.get("export_type") or "")
                if export_type == "Invoice CSV":
                    blockers = readiness["invoice_blockers"]
                elif export_type == "Payroll CSV":
                    blockers = readiness["payroll_blockers"]
                elif export_type in ("Machinery CSV", "Materials CSV"):
                    blockers = (
                        ["Completion is not Finalised."]
                        if str(completion.get("completion_status")) != STATUS_FINALISED
                        else []
                    )
                else:
                    blockers = []
                item["item_status"] = "Blocked" if blockers else "Ready"
                item["blocker_summary"] = "; ".join(blockers)
                if blockers:
                    all_ok = False
            previous = str(batch.get("status") or "")
            next_status = (
                STATUS_BATCH_VALIDATED
                if str(batch.get("export_type")) == EXPORT_SUMMARY_CSV or all_ok
                else STATUS_BATCH_DRAFT
            )
            batch["status"] = next_status
            batch["version"] = int(batch.get("version") or 1) + 1
            self.store.upsert_export_batch(batch)
            self._audit_export(
                {
                    "action": action,
                    "export_batch_id": batch_id,
                    "export_type": batch.get("export_type"),
                    "actor_staff_id": staff_id,
                    "actor_role": actor_role,
                    "previous_status": previous,
                    "new_status": next_status,
                    "record_count": len(batch.get("items") or []),
                }
            )
            return self._assemble_batch(batch)

        if action == "generate_export_batch":
            self._check_batch_version(batch, body.get("expected_version"))
            if batch.get("status") == STATUS_BATCH_EXPORTED:
                raise HTTPException(
                    status_code=422,
                    detail="Validation Error: Exported batches are immutable — create a new batch to regenerate.",
                )
            if batch.get("status") == STATUS_BATCH_CANCELLED:
                raise HTTPException(
                    status_code=422, detail="Validation Error: Cancelled batches cannot be generated."
                )
            if batch.get("status") != STATUS_BATCH_VALIDATED:
                raise HTTPException(
                    status_code=422, detail="Validation Error: validate the batch before generating."
                )
            bundles = []
            for item in batch.get("items") or []:
                if (
                    item.get("item_status") == "Blocked"
                    and str(batch.get("export_type")) != EXPORT_SUMMARY_CSV
                ):
                    raise HTTPException(
                        status_code=422, detail="Validation Error: batch still has blocked items."
                    )
                completion = None
                for row in self.store.list_completions():
                    if str(row.get("completion_id")) == str(item.get("completion_id")):
                        completion = row
                        break
                if not completion:
                    raise HTTPException(status_code=422, detail="Validation Error: completion missing.")
                bundles.append(self._completion_bundle(completion))
            built = build_csv_for_type(str(batch.get("export_type")), bundles)
            file_name = safe_export_filename(
                str(batch.get("export_type")),
                str(batch.get("date_from") or ""),
                str(batch.get("date_to") or ""),
            )
            previous = str(batch.get("status") or "")
            batch.update(
                {
                    "status": STATUS_BATCH_EXPORTED,
                    "completed_at": _now(),
                    "file_name": file_name,
                    "checksum": built["checksum"],
                    "snapshot": {"headers": built["headers"], "rows": built["rows"]},
                    "record_count": len(built["rows"]),
                    "version": int(batch.get("version") or 1) + 1,
                }
            )
            self.store.upsert_export_batch(batch)
            self._audit_export(
                {
                    "action": action,
                    "export_batch_id": batch_id,
                    "export_type": batch.get("export_type"),
                    "actor_staff_id": staff_id,
                    "actor_role": actor_role,
                    "previous_status": previous,
                    "new_status": STATUS_BATCH_EXPORTED,
                    "record_count": len(built["rows"]),
                    "checksum": built["checksum"],
                    "date_from": batch.get("date_from"),
                    "date_to": batch.get("date_to"),
                }
            )
            return self._assemble_batch(batch)

        if action == "get_export_batch_csv":
            if batch.get("status") != STATUS_BATCH_EXPORTED:
                raise HTTPException(status_code=422, detail="Validation Error: batch has not been generated.")
            snapshot = batch.get("snapshot") or {}
            if not snapshot.get("headers"):
                raise HTTPException(status_code=422, detail="Validation Error: export snapshot missing.")
            from app.services.export_math import build_csv

            csv_text = build_csv(snapshot["headers"], snapshot.get("rows") or [])
            self._audit_export(
                {
                    "action": "download_export_batch",
                    "export_batch_id": batch_id,
                    "export_type": batch.get("export_type"),
                    "actor_staff_id": staff_id,
                    "actor_role": actor_role,
                    "new_status": batch.get("status"),
                    "record_count": batch.get("record_count") or 0,
                    "checksum": batch.get("checksum") or "",
                }
            )
            return {
                "export_batch_id": batch_id,
                "file_name": batch.get("file_name") or "export.csv",
                "content_type": "text/csv; charset=utf-8",
                "checksum": batch.get("checksum") or "",
                "csv_text": csv_text,
            }

        if action == "cancel_export_batch":
            self._check_batch_version(batch, body.get("expected_version"))
            if batch.get("status") == STATUS_BATCH_EXPORTED:
                raise HTTPException(
                    status_code=422, detail="Validation Error: Exported batches cannot be cancelled."
                )
            previous = str(batch.get("status") or "")
            batch["status"] = STATUS_BATCH_CANCELLED
            batch["version"] = int(batch.get("version") or 1) + 1
            self.store.upsert_export_batch(batch)
            self._audit_export(
                {
                    "action": action,
                    "export_batch_id": batch_id,
                    "export_type": batch.get("export_type"),
                    "actor_staff_id": staff_id,
                    "actor_role": actor_role,
                    "previous_status": previous,
                    "new_status": STATUS_BATCH_CANCELLED,
                    "record_count": batch.get("record_count") or 0,
                }
            )
            return self._assemble_batch(batch)

        raise HTTPException(status_code=400, detail=f"Unsupported export action: {action}")
