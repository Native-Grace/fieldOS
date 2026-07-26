"""Mock-mode Phase 3C job completion operations."""

from __future__ import annotations

import re
import uuid
from datetime import datetime, timezone
from typing import Any

from fastapi import HTTPException

from app.core.roles import is_manager_or_admin
from app.services.completion_math import (
    STATUS_DRAFT,
    STATUS_FINALISED,
    STATUS_READY,
    STATUS_REOPENED,
    build_completion_draft_from_job,
    compute_completion_totals,
    compute_labour_entry,
    compute_machinery_duration_hours,
    validate_for_finalise,
)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _bool(value: Any) -> bool:
    return value in (True, "TRUE", "true")


def _normalise_labour(row: dict[str, Any], completion_id: str, job_sheet_id: str, now: str) -> dict[str, Any]:
    calc = compute_labour_entry(row)
    # Drafts may keep blank start/finish. Finalise still requires times.
    blocking = [
        err
        for err in calc["errors"]
        if not re.search(r"Start time is required\.|Finish time is required\.", err)
    ]
    if blocking:
        raise HTTPException(status_code=422, detail="Validation Error: " + " ".join(blocking))
    return {
        "labour_id": str(row.get("labour_id") or f"LAB-{uuid.uuid4().hex[:8].upper()}"),
        "completion_id": completion_id,
        "job_sheet_id": job_sheet_id,
        "staff_id": str(row.get("staff_id") or ""),
        "staff_name": str(row.get("staff_name") or ""),
        "work_date": str(row.get("work_date") or "")[:10],
        "start_time": str(row.get("start_time") or ""),
        "finish_time": str(row.get("finish_time") or ""),
        "break_minutes": float(row.get("break_minutes") or 0),
        "labour_hours": calc["labour_hours"],
        "travel_minutes": float(row.get("travel_minutes") or 0),
        "travel_hours": calc["travel_hours"],
        "role_or_activity": str(row.get("role_or_activity") or ""),
        "billable": _bool(row.get("billable")),
        "confirmation_status": str(row.get("confirmation_status") or "Suggested"),
        "notes": str(row.get("notes") or ""),
        "source": str(row.get("source") or "manual"),
        "created_at": str(row.get("created_at") or now),
        "updated_at": now,
    }


def _normalise_machinery(row: dict[str, Any], completion_id: str, job_sheet_id: str, now: str) -> dict[str, Any]:
    calc = compute_machinery_duration_hours(row)
    if calc["errors"]:
        raise HTTPException(status_code=422, detail="Validation Error: " + " ".join(calc["errors"]))
    return {
        "machinery_entry_id": str(row.get("machinery_entry_id") or f"MCH-{uuid.uuid4().hex[:8].upper()}"),
        "completion_id": completion_id,
        "job_sheet_id": job_sheet_id,
        "equipment_name": str(row.get("equipment_name") or ""),
        "operator_staff_id": str(row.get("operator_staff_id") or ""),
        "start_time": str(row.get("start_time") or ""),
        "finish_time": str(row.get("finish_time") or ""),
        "duration_hours": calc["duration_hours"],
        "billable": _bool(row.get("billable")),
        "confirmation_status": str(row.get("confirmation_status") or "Suggested"),
        "charge_code": str(row.get("charge_code") or ""),
        "notes": str(row.get("notes") or ""),
        "source": str(row.get("source") or "manual"),
        "created_at": str(row.get("created_at") or now),
        "updated_at": now,
    }


def _normalise_material(row: dict[str, Any], completion_id: str, job_sheet_id: str, now: str) -> dict[str, Any]:
    qty = row.get("quantity")
    if qty not in (None, ""):
        try:
            qty = float(qty)
        except (TypeError, ValueError) as exc:
            raise HTTPException(status_code=422, detail="Validation Error: material quantity must be numeric.") from exc
    else:
        qty = None
    return {
        "material_entry_id": str(row.get("material_entry_id") or f"JMT-{uuid.uuid4().hex[:8].upper()}"),
        "completion_id": completion_id,
        "job_sheet_id": job_sheet_id,
        "item_name": str(row.get("item_name") or ""),
        "quantity": qty,
        "unit": str(row.get("unit") or ""),
        "billable": _bool(row.get("billable")),
        "confirmation_status": str(row.get("confirmation_status") or "Suggested"),
        "notes": str(row.get("notes") or ""),
        "source": str(row.get("source") or "manual"),
        "created_at": str(row.get("created_at") or now),
        "updated_at": now,
    }


class MockCompletionMixin:
    """Mixin methods for MockJobRepository."""

    def _job_eligible(self, job: dict[str, Any]) -> bool:
        return (
            str(job.get("processing_status") or "").strip() == "Completed"
            and str(job.get("approval_status") or "").strip() == "Approved"
        )

    def _completion_blocked(self, job: dict[str, Any], completion: dict[str, Any]) -> bool:
        if str(completion.get("completion_status") or "") == STATUS_FINALISED:
            return False
        return not self._job_eligible(job)

    def _audit_completion(self, meta: dict[str, Any]) -> None:
        self.store.append_sync_log(
            {
                "record_id": meta.get("completion_id") or meta.get("job_sheet_id") or "COMPLETION",
                "target_system": "FieldOS_Completion",
                "status": "Success",
                "request_payload": {
                    "action": meta.get("action"),
                    "job_sheet_id": meta.get("job_sheet_id"),
                    "completion_id": meta.get("completion_id"),
                    "actor_staff_id": meta.get("actor_staff_id"),
                    "actor_role": meta.get("actor_role"),
                    "previous_completion_status": meta.get("previous_completion_status"),
                    "new_completion_status": meta.get("new_completion_status"),
                    "fields_changed": meta.get("fields_changed") or [],
                    "version": meta.get("version"),
                    "reopen_reason_present": bool(meta.get("reopen_reason_present")),
                    "override_reason_present": bool(meta.get("override_reason_present")),
                },
                "response_payload": meta.get("new_completion_status") or "",
            }
        )

    def _assemble_completion(
        self,
        completion: dict[str, Any],
        job: dict[str, Any],
        *,
        actor_role: str,
        staff_id: str,
    ) -> dict[str, Any]:
        manager = is_manager_or_admin(actor_role)
        labour = list(completion.get("labour_entries") or [])
        machinery = list(completion.get("machinery_entries") or [])
        materials = list(completion.get("material_entries") or [])
        internal_notes = str(completion.get("internal_notes") or "")
        if not manager:
            labour = [row for row in labour if str(row.get("staff_id") or "") == str(staff_id)]
            machinery = []
            materials = []
            internal_notes = ""
        blocked = self._completion_blocked(job, completion)
        status = str(completion.get("completion_status") or "")
        can_edit = manager and not blocked and status != STATUS_FINALISED
        can_finalise = manager and not blocked and status in (STATUS_DRAFT, STATUS_READY, STATUS_REOPENED)
        can_reopen = manager and status == STATUS_FINALISED
        payload = {
            **completion,
            "internal_notes": internal_notes,
            "blocked": blocked,
            "job_approval_status": str(job.get("approval_status") or ""),
            "job_processing_status": str(job.get("processing_status") or ""),
        }
        return {
            "completion": payload,
            "labour_entries": labour,
            "machinery_entries": machinery,
            "material_entries": materials,
            "can_edit": can_edit,
            "can_finalise": can_finalise,
            "can_reopen": can_reopen,
            "can_generate": manager and self._job_eligible(job),
        }

    def _check_completion_version(self, completion: dict[str, Any], expected: Any) -> None:
        if expected in (None, ""):
            return
        if int(completion.get("version") or 0) != int(expected):
            raise HTTPException(
                status_code=409,
                detail="Conflict: completion version changed since you loaded this record.",
            )

    async def aget_job_completion(
        self, job_sheet_id: str, staff_id: str, actor_role: str
    ) -> dict[str, Any]:
        job = self.get_job_for_review(job_sheet_id, staff_id, actor_role)
        completion = self.store.get_completion_for_job(job_sheet_id)
        if not completion:
            return {
                "completion": None,
                "labour_entries": [],
                "machinery_entries": [],
                "material_entries": [],
                "can_edit": False,
                "can_finalise": False,
                "can_reopen": False,
                "can_generate": is_manager_or_admin(actor_role) and self._job_eligible(job),
            }
        return self._assemble_completion(completion, job, actor_role=actor_role, staff_id=staff_id)

    async def alist_job_completions(self, actor_role: str) -> dict[str, Any]:
        if not is_manager_or_admin(actor_role):
            raise HTTPException(status_code=403, detail="Manager or admin role required.")
        items = [
            {
                "completion_id": str(row.get("completion_id") or ""),
                "job_sheet_id": str(row.get("job_sheet_id") or ""),
                "completion_status": str(row.get("completion_status") or ""),
                "updated_at": row.get("updated_at"),
                "finalised_at": row.get("finalised_at"),
                "version": int(row.get("version") or 1),
            }
            for row in self.store.list_completions()
        ]
        return {"items": items}

    async def acompletion_action(self, action: str, body: dict[str, Any]) -> dict[str, Any]:
        actor_role = str(body.get("actor_role") or "staff")
        if not is_manager_or_admin(actor_role):
            raise HTTPException(status_code=403, detail="Manager or admin role required.")
        job_sheet_id = str(body.get("job_sheet_id") or "")
        staff_id = str(body.get("staff_id") or body.get("actor_staff_id") or "")
        actor = str(body.get("actor_identity") or staff_id)
        job = self.get_job_for_review(job_sheet_id, staff_id, actor_role)
        now = _now()

        if action == "create_job_completion_draft":
            if not self._job_eligible(job):
                raise HTTPException(
                    status_code=422,
                    detail="Validation Error: completion requires processing_status=Completed and approval_status=Approved.",
                )
            if self.store.get_completion_for_job(job_sheet_id):
                raise HTTPException(
                    status_code=422,
                    detail="Validation Error: an active completion already exists for this job.",
                )
            completion = {
                "completion_id": f"CMP-{uuid.uuid4().hex[:8].upper()}",
                "job_sheet_id": job_sheet_id,
                "completion_status": STATUS_DRAFT,
                "work_summary": "",
                "invoice_description": "",
                "internal_notes": "",
                "total_labour_hours": 0,
                "total_travel_hours": 0,
                "total_machinery_hours": 0,
                "billable_labour_hours": 0,
                "non_billable_labour_hours": 0,
                "variations": [],
                "warnings": [],
                "warning_resolutions": [],
                "labour_entries": [],
                "machinery_entries": [],
                "material_entries": [],
                "created_by": actor,
                "created_at": now,
                "updated_by": actor,
                "updated_at": now,
                "finalised_by": "",
                "finalised_at": None,
                "reopened_by": "",
                "reopened_at": None,
                "reopen_reason": "",
                "version": 1,
            }
            self.store.upsert_completion(completion)
            self._audit_completion(
                {
                    "action": action,
                    "job_sheet_id": job_sheet_id,
                    "completion_id": completion["completion_id"],
                    "actor_staff_id": staff_id,
                    "actor_role": actor_role,
                    "new_completion_status": STATUS_DRAFT,
                    "version": 1,
                }
            )
            return self._assemble_completion(completion, job, actor_role=actor_role, staff_id=staff_id)

        completion = self.store.get_completion_for_job(job_sheet_id)

        if action == "generate_job_completion_draft":
            if not self._job_eligible(job):
                raise HTTPException(
                    status_code=422,
                    detail="Validation Error: completion requires processing_status=Completed and approval_status=Approved.",
                )
            draft = build_completion_draft_from_job(job, staff_name=str(body.get("staff_name") or ""))
            if completion and str(completion.get("completion_status")) == STATUS_FINALISED:
                raise HTTPException(
                    status_code=422,
                    detail="Validation Error: Finalised completions require explicit reopen before regenerate.",
                )
            if completion:
                self._check_completion_version(completion, body.get("expected_version"))
                completion_id = str(completion["completion_id"])
                version = int(completion.get("version") or 1) + 1
                previous = str(completion.get("completion_status") or "")
                created_by = str(completion.get("created_by") or actor)
                created_at = completion.get("created_at") or now
            else:
                completion_id = f"CMP-{uuid.uuid4().hex[:8].upper()}"
                version = 1
                previous = ""
                created_by = actor
                created_at = now
            labour = [
                _normalise_labour(row, completion_id, job_sheet_id, now) for row in draft["labour_entries"]
            ]
            machinery = [
                _normalise_machinery(row, completion_id, job_sheet_id, now)
                for row in draft["machinery_entries"]
            ]
            materials = [
                _normalise_material(row, completion_id, job_sheet_id, now)
                for row in draft["material_entries"]
            ]
            totals = compute_completion_totals(labour, machinery)
            completion = {
                "completion_id": completion_id,
                "job_sheet_id": job_sheet_id,
                "completion_status": STATUS_DRAFT,
                "work_summary": draft["work_summary"],
                "invoice_description": draft["invoice_description"],
                "internal_notes": "",
                **{k: totals[k] for k in (
                    "total_labour_hours",
                    "total_travel_hours",
                    "total_machinery_hours",
                    "billable_labour_hours",
                    "non_billable_labour_hours",
                )},
                "variations": draft["variations"],
                "warnings": draft["warnings"],
                "warning_resolutions": [],
                "labour_entries": labour,
                "machinery_entries": machinery,
                "material_entries": materials,
                "created_by": created_by,
                "created_at": created_at,
                "updated_by": actor,
                "updated_at": now,
                "finalised_by": "",
                "finalised_at": None,
                "reopened_by": "",
                "reopened_at": None,
                "reopen_reason": "",
                "version": version,
            }
            self.store.upsert_completion(completion)
            self._audit_completion(
                {
                    "action": action,
                    "job_sheet_id": job_sheet_id,
                    "completion_id": completion_id,
                    "actor_staff_id": staff_id,
                    "actor_role": actor_role,
                    "previous_completion_status": previous,
                    "new_completion_status": STATUS_DRAFT,
                    "version": version,
                }
            )
            return self._assemble_completion(completion, job, actor_role=actor_role, staff_id=staff_id)

        if not completion:
            raise HTTPException(status_code=404, detail="Completion not found for job.")

        if action == "update_job_completion":
            if str(completion.get("completion_status")) == STATUS_FINALISED:
                raise HTTPException(
                    status_code=422,
                    detail="Validation Error: Finalised completions require explicit reopen before edits.",
                )
            if self._completion_blocked(job, completion):
                raise HTTPException(
                    status_code=422,
                    detail="Validation Error: completion is blocked because the job is no longer Approved/Completed.",
                )
            self._check_completion_version(completion, body.get("expected_version"))
            previous = str(completion.get("completion_status") or "")
            next_status = previous
            if body.get("completion_status") not in (None, ""):
                requested = str(body.get("completion_status")).strip()
                if requested not in (STATUS_DRAFT, STATUS_READY):
                    raise HTTPException(
                        status_code=422,
                        detail="Validation Error: use finalise/reopen actions for Finalised/Reopened.",
                    )
                next_status = requested
            labour_src = body.get("labour_entries")
            machinery_src = body.get("machinery_entries")
            materials_src = body.get("material_entries")
            labour = [
                _normalise_labour(row, completion["completion_id"], job_sheet_id, now)
                for row in (labour_src if labour_src is not None else completion.get("labour_entries") or [])
            ]
            machinery = [
                _normalise_machinery(row, completion["completion_id"], job_sheet_id, now)
                for row in (
                    machinery_src if machinery_src is not None else completion.get("machinery_entries") or []
                )
            ]
            materials = [
                _normalise_material(row, completion["completion_id"], job_sheet_id, now)
                for row in (
                    materials_src if materials_src is not None else completion.get("material_entries") or []
                )
            ]
            # Drop client-supplied totals if present.
            body.pop("total_labour_hours", None)
            body.pop("total_travel_hours", None)
            body.pop("total_machinery_hours", None)
            body.pop("billable_labour_hours", None)
            body.pop("non_billable_labour_hours", None)
            totals = compute_completion_totals(labour, machinery)
            if not totals["ok"]:
                raise HTTPException(status_code=422, detail="Validation Error: " + " ".join(totals["errors"]))
            completion.update(
                {
                    "work_summary": (
                        str(body["work_summary"])
                        if body.get("work_summary") is not None
                        else completion.get("work_summary")
                    ),
                    "invoice_description": (
                        str(body["invoice_description"])
                        if body.get("invoice_description") is not None
                        else completion.get("invoice_description")
                    ),
                    "internal_notes": (
                        str(body["internal_notes"])
                        if body.get("internal_notes") is not None
                        else completion.get("internal_notes")
                    ),
                    "variations": (
                        list(body["variations"])
                        if body.get("variations") is not None
                        else completion.get("variations") or []
                    ),
                    "warnings": (
                        list(body["warnings"])
                        if body.get("warnings") is not None
                        else completion.get("warnings") or []
                    ),
                    "warning_resolutions": (
                        list(body["warning_resolutions"])
                        if body.get("warning_resolutions") is not None
                        else completion.get("warning_resolutions") or []
                    ),
                    "completion_status": next_status,
                    "labour_entries": labour,
                    "machinery_entries": machinery,
                    "material_entries": materials,
                    "updated_by": actor,
                    "updated_at": now,
                    "version": int(completion.get("version") or 1) + 1,
                    **{k: totals[k] for k in (
                        "total_labour_hours",
                        "total_travel_hours",
                        "total_machinery_hours",
                        "billable_labour_hours",
                        "non_billable_labour_hours",
                    )},
                }
            )
            self.store.upsert_completion(completion)
            self._audit_completion(
                {
                    "action": action,
                    "job_sheet_id": job_sheet_id,
                    "completion_id": completion["completion_id"],
                    "actor_staff_id": staff_id,
                    "actor_role": actor_role,
                    "previous_completion_status": previous,
                    "new_completion_status": next_status,
                    "version": completion["version"],
                }
            )
            return self._assemble_completion(completion, job, actor_role=actor_role, staff_id=staff_id)

        if action == "finalise_job_completion":
            self._check_completion_version(completion, body.get("expected_version"))
            gate = validate_for_finalise(
                completion,
                job,
                override_reason=str(body.get("override_reason") or ""),
            )
            if not gate["ok"]:
                raise HTTPException(
                    status_code=422,
                    detail="Validation Error: " + " ".join(gate["critical_errors"]),
                )
            previous = str(completion.get("completion_status") or "")
            totals = gate["totals"]
            completion.update(
                {
                    "completion_status": STATUS_FINALISED,
                    "finalised_by": actor,
                    "finalised_at": now,
                    "updated_by": actor,
                    "updated_at": now,
                    "version": int(completion.get("version") or 1) + 1,
                    **{k: totals[k] for k in (
                        "total_labour_hours",
                        "total_travel_hours",
                        "total_machinery_hours",
                        "billable_labour_hours",
                        "non_billable_labour_hours",
                    )},
                }
            )
            self.store.upsert_completion(completion)
            self._audit_completion(
                {
                    "action": action,
                    "job_sheet_id": job_sheet_id,
                    "completion_id": completion["completion_id"],
                    "actor_staff_id": staff_id,
                    "actor_role": actor_role,
                    "previous_completion_status": previous,
                    "new_completion_status": STATUS_FINALISED,
                    "version": completion["version"],
                    "override_reason_present": bool(str(body.get("override_reason") or "").strip()),
                }
            )
            return self._assemble_completion(completion, job, actor_role=actor_role, staff_id=staff_id)

        if action == "reopen_job_completion":
            reason = str(body.get("reopen_reason") or "").strip()
            if not reason:
                raise HTTPException(status_code=422, detail="Validation Error: reopen_reason is required.")
            if str(completion.get("completion_status")) != STATUS_FINALISED:
                raise HTTPException(
                    status_code=422,
                    detail="Validation Error: only Finalised completions can be reopened.",
                )
            self._check_completion_version(completion, body.get("expected_version"))
            previous = str(completion.get("completion_status") or "")
            completion.update(
                {
                    "completion_status": STATUS_REOPENED,
                    "reopened_by": actor,
                    "reopened_at": now,
                    "reopen_reason": reason,
                    "updated_by": actor,
                    "updated_at": now,
                    "version": int(completion.get("version") or 1) + 1,
                }
            )
            self.store.upsert_completion(completion)
            self._audit_completion(
                {
                    "action": action,
                    "job_sheet_id": job_sheet_id,
                    "completion_id": completion["completion_id"],
                    "actor_staff_id": staff_id,
                    "actor_role": actor_role,
                    "previous_completion_status": previous,
                    "new_completion_status": STATUS_REOPENED,
                    "version": completion["version"],
                    "reopen_reason_present": True,
                }
            )
            return self._assemble_completion(completion, job, actor_role=actor_role, staff_id=staff_id)

        raise HTTPException(status_code=400, detail=f"Unknown completion action: {action}")
