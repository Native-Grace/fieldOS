"""Mock-mode Phase 3E rates, financial mappings and completion pricing snapshots."""

from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Any, Callable

from fastapi import HTTPException

from app.core.roles import is_manager_or_admin, normalize_role
from app.services.completion_math import STATUS_FINALISED, unique_messages
from app.services.export_math import is_confirmed, normalise_calendar_date
from app.services.rates_math import (
    CURRENCY_DEFAULT,
    PRICING_APPROVED,
    PRICING_READY,
    PRICING_UNRESOLVED,
    PRICING_VALIDATED,
    RATE_STATUS_ACTIVE,
    RATE_STATUS_INACTIVE,
    SNAPSHOT_APPROVED,
    SNAPSHOT_DRAFT,
    SNAPSHOT_SUPERSEDED,
    SNAPSHOT_VALIDATED,
    build_financial_lines,
    date_effective,
    financial_audit_payload,
    find_effective_overlaps,
    is_active_status,
    is_catalog_active,
    parse_money_to_cents,
    resolve_payroll_mapping,
    resolve_xero_mapping,
    snapshot_transition_error,
)

RATE_CARD_HEADERS = [
    "rate_card_id",
    "card_name",
    "description",
    "currency",
    "status",
    "effective_from",
    "effective_to",
    "notes",
    "created_by",
    "created_at",
    "updated_by",
    "updated_at",
    "version",
]

LABOUR_RATE_HEADERS = [
    "labour_rate_id",
    "rate_card_id",
    "staff_id",
    "customer_id",
    "project_id",
    "role_code",
    "activity_code",
    "unit",
    "sell_rate",
    "cost_rate",
    "travel_rate",
    "overtime_rate",
    "status",
    "effective_from",
    "effective_to",
    "notes",
    "created_by",
    "created_at",
    "updated_by",
    "updated_at",
    "version",
]

MACHINERY_RATE_HEADERS = [
    "machinery_rate_id",
    "rate_card_id",
    "equipment_id",
    "equipment_name",
    "charge_code",
    "unit",
    "sell_rate",
    "cost_rate",
    "minimum_charge",
    "status",
    "effective_from",
    "effective_to",
    "notes",
    "created_by",
    "created_at",
    "updated_by",
    "updated_at",
    "version",
]

MATERIAL_CATALOG_HEADERS = [
    "material_id",
    "item_code",
    "item_name",
    "description",
    "unit",
    "cost_price",
    "sell_price",
    "tax_code",
    "account_code",
    "supplier",
    "active",
    "notes",
    "created_by",
    "created_at",
    "updated_by",
    "updated_at",
    "version",
]

CUSTOMER_PRICING_HEADERS = [
    "customer_pricing_id",
    "customer_id",
    "project_id",
    "rate_card_id",
    "price_notes",
    "status",
    "effective_from",
    "effective_to",
    "notes",
    "created_by",
    "created_at",
    "updated_by",
    "updated_at",
    "version",
]

PAYROLL_MAPPING_HEADERS = [
    "payroll_mapping_id",
    "staff_id",
    "employee_reference",
    "ordinary_hours_code",
    "overtime_hours_code",
    "travel_hours_code",
    "allowance_code",
    "cost_centre",
    "pay_calendar",
    "status",
    "effective_from",
    "effective_to",
    "notes",
    "created_by",
    "created_at",
    "updated_by",
    "updated_at",
    "version",
]

XERO_MAPPING_HEADERS = [
    "xero_mapping_id",
    "entity_type",
    "local_reference",
    "xero_reference",
    "account_code",
    "tax_type",
    "tax_rate_percent",
    "tracking_category",
    "tracking_option",
    "status",
    "notes",
    "created_by",
    "created_at",
    "updated_by",
    "updated_at",
    "version",
]


class RateResource:
    def __init__(
        self,
        *,
        collection: str,
        id_field: str,
        prefix: str,
        label: str,
        headers: list[str],
        required: list[str],
        money: list[str],
        dated: bool,
        overlap_key: Callable[[dict[str, Any]], str],
        active_field: str | None = None,
    ):
        self.collection = collection
        self.id_field = id_field
        self.prefix = prefix
        self.label = label
        self.headers = headers
        self.required = required
        self.money = money
        self.dated = dated
        self.overlap_key = overlap_key
        self.active_field = active_field


RATE_RESOURCES: dict[str, RateResource] = {
    "rate_cards": RateResource(
        collection="rate_cards",
        id_field="rate_card_id",
        prefix="RC",
        label="rate card",
        headers=RATE_CARD_HEADERS,
        required=["card_name"],
        money=[],
        dated=True,
        overlap_key=lambda row: str(row.get("card_name") or "").strip().lower(),
    ),
    "labour_rates": RateResource(
        collection="labour_rates",
        id_field="labour_rate_id",
        prefix="LR",
        label="labour rate",
        headers=LABOUR_RATE_HEADERS,
        required=["sell_rate"],
        money=["sell_rate", "cost_rate", "travel_rate", "overtime_rate"],
        dated=True,
        overlap_key=lambda row: "|".join(
            str(row.get(field) or "")
            for field in (
                "rate_card_id",
                "staff_id",
                "customer_id",
                "project_id",
                "role_code",
                "activity_code",
            )
        ),
    ),
    "machinery_rates": RateResource(
        collection="machinery_rates",
        id_field="machinery_rate_id",
        prefix="MR",
        label="machinery rate",
        headers=MACHINERY_RATE_HEADERS,
        required=["sell_rate"],
        money=["sell_rate", "cost_rate", "minimum_charge"],
        dated=True,
        overlap_key=lambda row: "|".join(
            [
                str(row.get("rate_card_id") or ""),
                str(row.get("equipment_id") or ""),
                str(row.get("equipment_name") or "").strip().lower(),
                str(row.get("charge_code") or ""),
            ]
        ),
    ),
    "material_catalog": RateResource(
        collection="material_catalog",
        id_field="material_id",
        prefix="MATC",
        label="material catalog item",
        headers=MATERIAL_CATALOG_HEADERS,
        required=["item_name", "sell_price"],
        money=["cost_price", "sell_price"],
        dated=False,
        active_field="active",
        overlap_key=lambda row: str(row.get("item_code") or "").strip().lower(),
    ),
    "customer_pricing": RateResource(
        collection="customer_pricing",
        id_field="customer_pricing_id",
        prefix="CP",
        label="customer pricing rule",
        headers=CUSTOMER_PRICING_HEADERS,
        required=["customer_id", "rate_card_id"],
        money=[],
        dated=True,
        overlap_key=lambda row: f"{row.get('customer_id') or ''}|{row.get('project_id') or ''}",
    ),
    "payroll_mappings": RateResource(
        collection="payroll_mappings",
        id_field="payroll_mapping_id",
        prefix="PM",
        label="payroll mapping",
        headers=PAYROLL_MAPPING_HEADERS,
        required=["staff_id", "employee_reference", "ordinary_hours_code", "cost_centre"],
        money=[],
        dated=True,
        overlap_key=lambda row: str(row.get("staff_id") or ""),
    ),
    "xero_mappings": RateResource(
        collection="xero_mappings",
        id_field="xero_mapping_id",
        prefix="XM",
        label="Xero mapping",
        headers=XERO_MAPPING_HEADERS,
        required=["entity_type", "local_reference", "account_code", "tax_type"],
        money=[],
        dated=False,
        overlap_key=lambda row: f"{row.get('entity_type') or ''}|{row.get('local_reference') or ''}",
    ),
}

RATE_ACTIONS: dict[str, tuple[str, str]] = {
    "list_rate_cards": ("rate_cards", "list"),
    "create_rate_card": ("rate_cards", "create"),
    "update_rate_card": ("rate_cards", "update"),
    "list_labour_rates": ("labour_rates", "list"),
    "create_labour_rate": ("labour_rates", "create"),
    "update_labour_rate": ("labour_rates", "update"),
    "list_machinery_rates": ("machinery_rates", "list"),
    "create_machinery_rate": ("machinery_rates", "create"),
    "update_machinery_rate": ("machinery_rates", "update"),
    "list_material_catalog": ("material_catalog", "list"),
    "create_material_catalog_item": ("material_catalog", "create"),
    "update_material_catalog_item": ("material_catalog", "update"),
    "list_customer_pricing": ("customer_pricing", "list"),
    "create_customer_pricing": ("customer_pricing", "create"),
    "update_customer_pricing": ("customer_pricing", "update"),
    "list_payroll_mappings": ("payroll_mappings", "list"),
    "create_payroll_mapping": ("payroll_mappings", "create"),
    "update_payroll_mapping": ("payroll_mappings", "update"),
    "list_xero_mappings": ("xero_mappings", "list"),
    "create_xero_mapping": ("xero_mappings", "create"),
    "update_xero_mapping": ("xero_mappings", "update"),
}

FINANCIAL_SNAPSHOT_ACTIONS = (
    "create_financial_snapshot",
    "list_financial_snapshots",
    "get_financial_snapshot",
    "validate_financial_snapshot",
    "approve_financial_snapshot",
    "supersede_financial_snapshot",
)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _new_id(prefix: str) -> str:
    return f"{prefix}-{uuid.uuid4().hex[:8].upper()}"


def _is_row_active(resource: RateResource, row: dict[str, Any]) -> bool:
    if resource.active_field:
        return is_catalog_active(row)
    status = row.get("status")
    if status in (None, ""):
        return True
    return is_active_status(status)


class MockRatesMixin:
    """Phase 3E mixin for MockJobRepository. Requires self.settings and self.store."""

    def _assert_rates_manager(self, actor_role: Any) -> None:
        if not is_manager_or_admin(actor_role):
            raise HTTPException(status_code=403, detail="Manager or admin role required.")

    def _audit_rates(self, meta: dict[str, Any]) -> None:
        self.store.append_sync_log(
            {
                "record_id": meta.get("resource_id") or meta.get("completion_id") or "FIELDOS_RATES",
                "target_system": "FieldOS_Rates",
                "status": "Success",
                "request_payload": financial_audit_payload(meta),
                "response_payload": str(meta.get("new_status") or ""),
            }
        )

    # ------------------------------------------------------------------ CRUD

    def _rates_resource(self, name: str) -> RateResource:
        resource = RATE_RESOURCES.get(name)
        if not resource:
            raise HTTPException(
                status_code=422, detail=f"Validation Error: unknown rates resource '{name}'."
            )
        return resource

    def _rates_to_api(self, resource: RateResource, row: dict[str, Any]) -> dict[str, Any]:
        out = {header: ("" if row.get(header) is None else row.get(header)) for header in resource.headers}
        try:
            out["version"] = int(row.get("version") or 1)
        except (TypeError, ValueError):
            out["version"] = 1
        return out

    def _rates_record_from_payload(
        self, resource: RateResource, source: dict[str, Any], base: dict[str, Any]
    ) -> dict[str, Any]:
        record = dict(base)
        for header in resource.headers:
            if header == resource.id_field:
                continue
            if header in source:
                value = source[header]
                record[header] = "" if value is None else value
        return record

    def _validate_rates_record(self, resource: RateResource, record: dict[str, Any]) -> None:
        for field in resource.required:
            value = record.get(field)
            if value is None or str(value).strip() == "":
                raise HTTPException(
                    status_code=422,
                    detail=f"Validation Error: {field} is required for a {resource.label}.",
                )
        for field in resource.money:
            value = record.get(field)
            if value is None or value == "":
                continue
            if parse_money_to_cents(value) is None:
                raise HTTPException(
                    status_code=422,
                    detail=(
                        f"Validation Error: {field} must be a decimal amount "
                        f"(received '{value}')."
                    ),
                )
        if resource.dated:
            for field in ("effective_from", "effective_to"):
                value = record.get(field)
                if value is None or value == "":
                    continue
                if not normalise_calendar_date(value):
                    raise HTTPException(
                        status_code=422,
                        detail=f"Validation Error: {field} must be a valid calendar date.",
                    )
            start = normalise_calendar_date(record.get("effective_from"))
            end = normalise_calendar_date(record.get("effective_to"))
            if start and end and end < start:
                raise HTTPException(
                    status_code=422,
                    detail="Validation Error: effective_to cannot be before effective_from.",
                )
        if "status" in resource.headers:
            status = str(record.get("status") or "").strip()
            if status and status not in (RATE_STATUS_ACTIVE, RATE_STATUS_INACTIVE):
                raise HTTPException(
                    status_code=422, detail="Validation Error: status must be Active or Inactive."
                )

    def _assert_no_rates_overlap(
        self,
        resource: RateResource,
        candidate: dict[str, Any],
        existing_rows: list[dict[str, Any]],
        exclude_id: str | None,
    ) -> None:
        if not _is_row_active(resource, candidate):
            return
        others = [
            row
            for row in existing_rows
            if not (exclude_id and str(row.get(resource.id_field) or "") == str(exclude_id))
            and _is_row_active(resource, row)
        ]

        if not resource.dated:
            key = resource.overlap_key(candidate)
            if not key or key.replace("|", "") == "":
                return
            clash = [row for row in others if resource.overlap_key(row) == key]
            if clash:
                raise HTTPException(
                    status_code=422,
                    detail=(
                        f"Validation Error: an active {resource.label} already exists for this "
                        f"key ({clash[0].get(resource.id_field) or ''})."
                    ),
                )
            return

        normalised = {header: candidate.get(header) for header in resource.headers}
        normalised[resource.id_field] = candidate.get(resource.id_field) or "(new)"
        issues = find_effective_overlaps(
            others + [normalised], resource.id_field, resource.overlap_key
        )
        candidate_id = str(normalised[resource.id_field])
        relevant = [
            issue for issue in issues if candidate_id in (issue["a_id"], issue["b_id"])
        ]
        if relevant:
            raise HTTPException(
                status_code=422,
                detail=(
                    f"Validation Error: effective date range overlaps an existing active "
                    f"{resource.label} — {relevant[0]['message']}."
                ),
            )

    def _rates_list(self, name: str, action: str, body: dict[str, Any]) -> dict[str, Any]:
        resource = self._rates_resource(name)
        rows = self.store.list_rates_rows(resource.collection)
        on_date = normalise_calendar_date(body.get("on_date"))
        include_inactive = body.get("include_inactive") in (True, "true", "TRUE")

        def _keep(row: dict[str, Any]) -> bool:
            if not include_inactive and not _is_row_active(resource, row):
                return False
            if on_date and resource.dated and not date_effective(row, on_date):
                return False
            for key, field in (
                ("rate_card_id", "rate_card_id"),
                ("staff_id_filter", "staff_id"),
                ("customer_id", "customer_id"),
                ("entity_type", "entity_type"),
            ):
                wanted = body.get(key)
                if wanted and str(row.get(field) or "") != str(wanted):
                    return False
            return True

        filtered = sorted(
            (row for row in rows if _keep(row)),
            key=lambda row: str(row.get(resource.id_field) or ""),
        )
        return {
            "action": action,
            "items": [self._rates_to_api(resource, row) for row in filtered],
            "overlaps": (
                find_effective_overlaps(rows, resource.id_field, resource.overlap_key)
                if resource.dated
                else []
            ),
        }

    def _rates_create(self, name: str, action: str, body: dict[str, Any]) -> dict[str, Any]:
        resource = self._rates_resource(name)
        actor = str(body.get("actor_identity") or body.get("staff_id") or "")
        now = _now()
        source = body["record"] if isinstance(body.get("record"), dict) else body
        record = self._rates_record_from_payload(resource, source, {})
        record[resource.id_field] = _new_id(resource.prefix)
        if "status" in resource.headers and not str(record.get("status") or "").strip():
            record["status"] = RATE_STATUS_ACTIVE
        if resource.active_field and record.get(resource.active_field) in (None, ""):
            record[resource.active_field] = "TRUE"
        if "currency" in resource.headers and not str(record.get("currency") or "").strip():
            record["currency"] = CURRENCY_DEFAULT
        record.update(
            {
                "created_by": actor,
                "created_at": now,
                "updated_by": actor,
                "updated_at": now,
                "version": 1,
            }
        )
        self._validate_rates_record(resource, record)
        self._assert_no_rates_overlap(
            resource, record, self.store.list_rates_rows(resource.collection), None
        )
        self.store.upsert_rates_row(resource.collection, resource.id_field, record)
        self._audit_rates(
            {
                "action": action,
                "actor_staff_id": body.get("staff_id"),
                "actor_role": normalize_role(str(body.get("actor_role") or "")),
                "resource_type": resource.collection,
                "resource_id": record[resource.id_field],
                "new_status": str(record.get("status") or record.get(resource.active_field or "") or ""),
                "version": 1,
                "changed_fields": sorted(record.keys()),
            }
        )
        return {"action": action, "item": self._rates_to_api(resource, record)}

    def _rates_update(self, name: str, action: str, body: dict[str, Any]) -> dict[str, Any]:
        resource = self._rates_resource(name)
        source = body["record"] if isinstance(body.get("record"), dict) else body
        record_id = str(body.get(resource.id_field) or source.get(resource.id_field) or "")
        if not record_id:
            raise HTTPException(
                status_code=422,
                detail=f"Validation Error: {resource.id_field} is required.",
            )
        existing = self.store.get_rates_row(resource.collection, resource.id_field, record_id)
        if not existing:
            raise HTTPException(
                status_code=404, detail=f"Not Found: {resource.label} {record_id} does not exist."
            )
        self._check_rates_version(existing, body.get("expected_version"), resource.label)

        actor = str(body.get("actor_identity") or body.get("staff_id") or "")
        merged = self._rates_record_from_payload(
            resource, source, self._rates_to_api(resource, existing)
        )
        merged[resource.id_field] = record_id
        merged["created_by"] = existing.get("created_by") or ""
        merged["created_at"] = existing.get("created_at") or ""
        merged["updated_by"] = actor
        merged["updated_at"] = _now()
        merged["version"] = int(existing.get("version") or 1) + 1
        self._validate_rates_record(resource, merged)
        self._assert_no_rates_overlap(
            resource, merged, self.store.list_rates_rows(resource.collection), record_id
        )
        self.store.upsert_rates_row(resource.collection, resource.id_field, merged)
        self._audit_rates(
            {
                "action": action,
                "actor_staff_id": body.get("staff_id"),
                "actor_role": normalize_role(str(body.get("actor_role") or "")),
                "resource_type": resource.collection,
                "resource_id": record_id,
                "previous_status": str(existing.get("status") or ""),
                "new_status": str(merged.get("status") or merged.get(resource.active_field or "") or ""),
                "version": merged["version"],
                "changed_fields": sorted(
                    header for header in resource.headers if header != resource.id_field
                ),
            }
        )
        return {"action": action, "item": self._rates_to_api(resource, merged)}

    def _check_rates_version(self, row: dict[str, Any], expected: Any, label: str) -> None:
        if expected in (None, ""):
            return
        if int(row.get("version") or 0) != int(expected):
            raise HTTPException(
                status_code=409,
                detail=f"Conflict: {label} changed since you loaded this record.",
            )

    async def arates_action(self, action: str, body: dict[str, Any]) -> dict[str, Any]:
        self._assert_rates_manager(body.get("actor_role"))
        mapping = RATE_ACTIONS.get(action)
        if not mapping:
            raise HTTPException(status_code=400, detail=f"Unsupported rates action: {action}")
        name, verb = mapping
        if verb == "list":
            return self._rates_list(name, action, body)
        if verb == "create":
            return self._rates_create(name, action, body)
        return self._rates_update(name, action, body)

    # -------------------------------------------------------------- pricing

    def _load_rate_tables(self) -> dict[str, list[dict[str, Any]]]:
        return {
            name: self.store.list_rates_rows(name)
            for name in self.store.RATES_COLLECTIONS
        }

    def _completion_row(self, completion_id: str) -> dict[str, Any]:
        if not str(completion_id or ""):
            raise HTTPException(status_code=422, detail="Validation Error: completion_id is required.")
        for row in self.store.list_completions():
            if str(row.get("completion_id")) == str(completion_id):
                return row
        raise HTTPException(status_code=404, detail=f"Completion {completion_id} not found.")

    def _pricing_identity(
        self, job: dict[str, Any], tables: dict[str, list[dict[str, Any]]]
    ) -> dict[str, Any]:
        """IDs come from real job columns only — display names are never used as identifiers."""
        settings = self.settings
        job_date = (
            normalise_calendar_date(
                job.get(settings.job_date_column) or job.get("job_date") or job.get("date")
            )
            or ""
        )
        customer_id = str(job.get("customer_id") or "").strip()
        project_id = str(job.get("project_id") or "").strip()
        identity = {
            "job_sheet_id": str(job.get("job_sheet_id") or ""),
            "customer_id": customer_id,
            "project_id": project_id,
            "customer_name": str(
                job.get("customer_name") or job.get(settings.job_customer_column) or ""
            ),
            "project_name": str(
                job.get("project_name") or job.get(settings.job_project_column) or ""
            ),
            "job_date": job_date,
            "rate_card_id": "",
            "match": "job_row" if customer_id else "none",
        }
        pricing = [
            row
            for row in tables.get("customer_pricing") or []
            if is_active_status(row.get("status"))
            and (not job_date or date_effective(row, job_date))
            and customer_id
            and str(row.get("customer_id") or "") == customer_id
            and (
                not str(row.get("project_id") or "").strip()
                or str(row.get("project_id") or "") == project_id
            )
        ]
        pricing.sort(
            key=lambda row: 0
            if project_id and str(row.get("project_id") or "") == project_id
            else 1
        )
        if pricing:
            identity["rate_card_id"] = str(pricing[0].get("rate_card_id") or "")
        return identity

    @staticmethod
    def _identity_blockers(identity: dict[str, Any]) -> list[str]:
        blockers = []
        if not identity.get("customer_id"):
            blockers.append("Customer identity unresolved")
        if not identity.get("job_date"):
            blockers.append("Job date unresolved")
        return blockers

    def _payroll_readiness(
        self,
        completion: dict[str, Any],
        identity: dict[str, Any],
        tables: dict[str, list[dict[str, Any]]],
    ) -> dict[str, Any]:
        blockers: list[str] = []
        mappings: list[dict[str, Any]] = []
        seen: set[str] = set()
        for entry in completion.get("labour_entries") or []:
            if not is_confirmed(entry):
                continue
            staff_id = str(entry.get("staff_id") or "")
            if not staff_id:
                message = f"Labour {entry.get('labour_id') or ''} is missing staff_id."
                if message not in blockers:
                    blockers.append(message)
                continue
            if staff_id in seen:
                continue
            seen.add(staff_id)
            work_date = normalise_calendar_date(entry.get("work_date")) or identity["job_date"]
            mapping = resolve_payroll_mapping(
                staff_id, tables.get("payroll_mappings"), work_date
            )
            mappings.append(
                {
                    "staff_id": staff_id,
                    "work_date": work_date,
                    "resolved": bool(mapping.get("resolved")),
                    "source_id": str(mapping.get("source_id") or ""),
                    "blockers": list(mapping.get("blockers") or []),
                }
            )
            for message in mapping.get("blockers") or []:
                text = f"{staff_id}: {message}"
                if text not in blockers:
                    blockers.append(text)
        return {"mappings": mappings, "blockers": blockers}

    def _price_completion(self, completion: dict[str, Any]) -> dict[str, Any]:
        tables = self._load_rate_tables()
        job = self.store.get_job(str(completion.get("job_sheet_id") or "")) or {
            "job_sheet_id": completion.get("job_sheet_id")
        }
        identity = self._pricing_identity(job, tables)
        built = build_financial_lines(
            {
                "completion_id": completion.get("completion_id"),
                "job_date": identity["job_date"],
                "identity": identity,
                "labour_entries": completion.get("labour_entries") or [],
                "machinery_entries": completion.get("machinery_entries") or [],
                "material_entries": completion.get("material_entries") or [],
                "tables": tables,
            }
        )
        customer_mapping = (
            resolve_xero_mapping("customer", identity["customer_id"], tables.get("xero_mappings"))
            if identity["customer_id"]
            else {"resolved": False, "blockers": ["Customer identity unresolved"]}
        )
        return {
            "tables": tables,
            "job": job,
            "identity": identity,
            "built": built,
            "customer_mapping": customer_mapping,
            "payroll": self._payroll_readiness(completion, identity, tables),
        }

    async def apricing_readiness(self, actor_role: str, completion_id: str) -> dict[str, Any]:
        self._assert_rates_manager(actor_role)
        completion = self._completion_row(completion_id)
        priced = self._price_completion(completion)
        invoice_blockers = self._identity_blockers(priced["identity"]) + list(
            priced["built"]["blockers"]
        )
        if str(completion.get("completion_status") or "") != STATUS_FINALISED:
            invoice_blockers.append("Completion is not Finalised.")
        if not priced["built"]["lines"]:
            invoice_blockers.append(
                "No confirmed labour, machinery or material rows to price."
            )
        payroll_blockers = list(priced["payroll"]["blockers"])
        if not priced["identity"]["job_date"]:
            payroll_blockers.append("Job date unresolved")

        invoice_blockers = unique_messages(invoice_blockers)
        payroll_blockers = unique_messages(payroll_blockers)
        return {
            "completion_id": str(completion.get("completion_id") or ""),
            "job_sheet_id": str(completion.get("job_sheet_id") or ""),
            "identity": {
                "customer_id": priced["identity"]["customer_id"],
                "project_id": priced["identity"]["project_id"],
                "customer_name": priced["identity"]["customer_name"],
                "project_name": priced["identity"]["project_name"],
                "job_date": priced["identity"]["job_date"],
                "rate_card_id": priced["identity"]["rate_card_id"],
                "match": priced["identity"]["match"],
            },
            "invoice_pricing_ready": not invoice_blockers,
            "payroll_mapping_ready": not payroll_blockers,
            "invoice_blockers": invoice_blockers,
            "payroll_blockers": payroll_blockers,
            "blockers": unique_messages(invoice_blockers + payroll_blockers),
            "pricing_status": PRICING_READY if not invoice_blockers else PRICING_UNRESOLVED,
            "xero_customer_reference": (
                str(priced["customer_mapping"]["mapping"].get("xero_reference") or "")
                if priced["customer_mapping"].get("resolved")
                else ""
            ),
            "payroll_mappings": priced["payroll"]["mappings"],
            "material_suggestions": priced["built"]["suggestions"],
            "sample_rates": [
                {
                    "line_type": line["line_type"],
                    "description": line["description"],
                    "source_row_id": line["source_row_id"],
                    "quantity": line["quantity"],
                    "unit": line["unit"],
                    "unit_sell": line["unit_sell"],
                    "resolved": not line["blockers"],
                    "rate_source_type": line["rate_source_type"],
                    "rate_source_id": line["rate_source_id"],
                    "non_billable_reason": line["non_billable_reason"],
                    "blockers": line["blockers"],
                }
                for line in priced["built"]["lines"]
            ],
            "totals_preview": {
                "subtotal_ex_tax": priced["built"]["subtotal_ex_tax"],
                "tax_amount": priced["built"]["tax_amount"],
                "total_inc_tax": priced["built"]["total_inc_tax"],
                "tax_type": priced["built"]["tax_type"],
                "currency": CURRENCY_DEFAULT,
            },
        }

    # ------------------------------------------------------------ snapshots

    @staticmethod
    def _draft_reference(completion_id: str, snapshot_id: str) -> str:
        tail = str(snapshot_id or "").split("-")[-1]
        short = "".join(ch for ch in tail if ch.isalnum())[:6].upper()
        return f"DRAFT-INV-{completion_id or ''}-{short}"

    def _snapshot_out(self, snapshot: dict[str, Any]) -> dict[str, Any]:
        return {
            "financial_snapshot_id": str(snapshot.get("financial_snapshot_id") or ""),
            "completion_id": str(snapshot.get("completion_id") or ""),
            "job_sheet_id": str(snapshot.get("job_sheet_id") or ""),
            "customer_id": str(snapshot.get("customer_id") or ""),
            "project_id": str(snapshot.get("project_id") or ""),
            "job_date": str(snapshot.get("job_date") or ""),
            "currency": str(snapshot.get("currency") or CURRENCY_DEFAULT),
            "snapshot_status": str(snapshot.get("snapshot_status") or ""),
            "pricing_status": str(snapshot.get("pricing_status") or ""),
            "rate_card_id": str(snapshot.get("rate_card_id") or ""),
            "line_count": int(snapshot.get("line_count") or 0),
            "subtotal_ex_tax": str(snapshot.get("subtotal_ex_tax") or ""),
            "tax_amount": str(snapshot.get("tax_amount") or ""),
            "total_inc_tax": str(snapshot.get("total_inc_tax") or ""),
            "tax_type": str(snapshot.get("tax_type") or ""),
            "tax_rate_percent": snapshot.get("tax_rate_percent"),
            "account_code": str(snapshot.get("account_code") or ""),
            "draft_reference": str(snapshot.get("draft_reference") or ""),
            "xero_reference": str(snapshot.get("xero_reference") or ""),
            "blockers": list(snapshot.get("blockers") or []),
            "notes": str(snapshot.get("notes") or ""),
            "created_by": str(snapshot.get("created_by") or ""),
            "created_at": snapshot.get("created_at"),
            "validated_by": str(snapshot.get("validated_by") or ""),
            "validated_at": snapshot.get("validated_at"),
            "approved_by": str(snapshot.get("approved_by") or ""),
            "approved_at": snapshot.get("approved_at"),
            "superseded_by": str(snapshot.get("superseded_by") or ""),
            "superseded_at": snapshot.get("superseded_at"),
            "version": int(snapshot.get("version") or 1),
        }

    def _assemble_snapshot(self, snapshot: dict[str, Any]) -> dict[str, Any]:
        lines = sorted(
            self.store.list_financial_snapshot_lines(snapshot.get("financial_snapshot_id")),
            key=lambda row: int(row.get("line_number") or 0),
        )
        return {"financial_snapshot": self._snapshot_out(snapshot), "lines": lines}

    def _get_snapshot(self, snapshot_id: str) -> dict[str, Any]:
        if not str(snapshot_id or ""):
            raise HTTPException(
                status_code=422, detail="Validation Error: financial_snapshot_id is required."
            )
        snapshot = self.store.get_financial_snapshot(snapshot_id)
        if not snapshot:
            raise HTTPException(
                status_code=404, detail=f"Financial snapshot {snapshot_id} not found."
            )
        return snapshot

    def _assert_snapshot_transition(self, current: Any, target: str) -> None:
        message = snapshot_transition_error(current, target)
        if message:
            raise HTTPException(status_code=422, detail=message)

    def _create_financial_snapshot(self, body: dict[str, Any]) -> dict[str, Any]:
        completion = self._completion_row(str(body.get("completion_id") or ""))
        completion_id = str(completion.get("completion_id") or "")
        priced = self._price_completion(completion)
        approved = [
            row
            for row in self.store.list_financial_snapshots()
            if str(row.get("completion_id")) == completion_id
            and str(row.get("snapshot_status") or "") == SNAPSHOT_APPROVED
        ]
        if approved:
            raise HTTPException(
                status_code=409,
                detail=(
                    f"Conflict: completion {completion_id} already has an Approved financial "
                    f"snapshot ({approved[0].get('financial_snapshot_id') or ''}) — supersede it "
                    "before creating a new one."
                ),
            )

        actor = str(body.get("actor_identity") or body.get("staff_id") or "")
        now = _now()
        snapshot_id = _new_id("CFS")
        identity = priced["identity"]
        built = priced["built"]
        blockers = unique_messages(self._identity_blockers(identity) + list(built["blockers"]))
        snapshot = {
            "financial_snapshot_id": snapshot_id,
            "completion_id": completion_id,
            "job_sheet_id": str(completion.get("job_sheet_id") or ""),
            "customer_id": identity["customer_id"],
            "project_id": identity["project_id"],
            "job_date": identity["job_date"],
            "currency": CURRENCY_DEFAULT,
            "snapshot_status": SNAPSHOT_DRAFT,
            "pricing_status": PRICING_UNRESOLVED if blockers else PRICING_READY,
            "rate_card_id": identity["rate_card_id"],
            "line_count": len(built["lines"]),
            "subtotal_ex_tax": built["subtotal_ex_tax"],
            "tax_amount": built["tax_amount"],
            "total_inc_tax": built["total_inc_tax"],
            "tax_type": built["tax_type"],
            "tax_rate_percent": built["tax_rate_percent"],
            "account_code": built["account_code"],
            "draft_reference": self._draft_reference(completion_id, snapshot_id),
            "xero_reference": (
                str(priced["customer_mapping"]["mapping"].get("xero_reference") or "")
                if priced["customer_mapping"].get("resolved")
                else ""
            ),
            "blockers": blockers,
            "notes": str(body.get("notes") or ""),
            "created_by": actor,
            "created_at": now,
            "validated_by": "",
            "validated_at": None,
            "approved_by": "",
            "approved_at": None,
            "superseded_by": "",
            "superseded_at": None,
            "version": 1,
        }
        self.store.upsert_financial_snapshot(snapshot)
        self.store.append_financial_snapshot_lines(
            [
                {
                    "financial_line_id": _new_id("CFL"),
                    "financial_snapshot_id": snapshot_id,
                    "completion_id": completion_id,
                    "line_number": line["line_number"],
                    "line_type": line["line_type"],
                    "source_row_id": line["source_row_id"],
                    "description": line["description"],
                    "staff_id": line["staff_id"],
                    "equipment_id": line["equipment_id"],
                    "material_id": line["material_id"],
                    "quantity": line["quantity"],
                    "unit": line["unit"],
                    "unit_sell": line["unit_sell"],
                    "line_amount_ex_tax": line["line_amount_ex_tax"],
                    "tax_type": line["tax_type"],
                    "tax_rate_percent": line["tax_rate_percent"],
                    "tax_amount": line["tax_amount"],
                    "line_total_inc_tax": line["line_total_inc_tax"],
                    "account_code": line["account_code"],
                    "rate_source_type": line["rate_source_type"],
                    "rate_source_id": line["rate_source_id"],
                    "billable": line["billable"],
                    "non_billable_reason": line["non_billable_reason"],
                    "blockers": line["blockers"],
                    "created_at": now,
                }
                for line in built["lines"]
            ]
        )
        self._audit_rates(
            {
                "action": "create_financial_snapshot",
                "actor_staff_id": body.get("staff_id"),
                "actor_role": normalize_role(str(body.get("actor_role") or "")),
                "resource_type": "financial_snapshots",
                "resource_id": snapshot_id,
                "completion_id": completion_id,
                "new_status": SNAPSHOT_DRAFT,
                "version": 1,
                "source_ids": [line["rate_source_id"] for line in built["lines"]],
            }
        )
        return self._assemble_snapshot(snapshot)

    def _list_financial_snapshots(self, body: dict[str, Any]) -> dict[str, Any]:
        completion_id = str(body.get("completion_id") or "")
        status = str(body.get("snapshot_status") or "")
        rows = [
            row
            for row in self.store.list_financial_snapshots()
            if (not completion_id or str(row.get("completion_id")) == completion_id)
            and (not status or str(row.get("snapshot_status") or "") == status)
        ]
        rows.sort(key=lambda row: str(row.get("created_at") or ""), reverse=True)
        return {
            "items": [
                {
                    "financial_snapshot_id": str(row.get("financial_snapshot_id") or ""),
                    "completion_id": str(row.get("completion_id") or ""),
                    "job_sheet_id": str(row.get("job_sheet_id") or ""),
                    "customer_id": str(row.get("customer_id") or ""),
                    "project_id": str(row.get("project_id") or ""),
                    "job_date": str(row.get("job_date") or ""),
                    "snapshot_status": str(row.get("snapshot_status") or ""),
                    "pricing_status": str(row.get("pricing_status") or ""),
                    "line_count": int(row.get("line_count") or 0),
                    "subtotal_ex_tax": str(row.get("subtotal_ex_tax") or ""),
                    "tax_amount": str(row.get("tax_amount") or ""),
                    "total_inc_tax": str(row.get("total_inc_tax") or ""),
                    "draft_reference": str(row.get("draft_reference") or ""),
                    "xero_reference": str(row.get("xero_reference") or ""),
                    "created_at": row.get("created_at"),
                    "version": int(row.get("version") or 1),
                }
                for row in rows
            ]
        }

    def _validate_financial_snapshot(self, body: dict[str, Any]) -> dict[str, Any]:
        snapshot_id = str(body.get("financial_snapshot_id") or "")
        actor = str(body.get("actor_identity") or body.get("staff_id") or "")
        snapshot = self._get_snapshot(snapshot_id)
        self._check_rates_version(snapshot, body.get("expected_version"), "financial snapshot")
        previous = str(snapshot.get("snapshot_status") or "")
        self._assert_snapshot_transition(previous, SNAPSHOT_VALIDATED)

        assembled = self._assemble_snapshot(snapshot)
        blockers: list[str] = []
        for line in assembled["lines"]:
            for message in line.get("blockers") or []:
                blockers.append(f"Line {line.get('line_number')}: {message}")
        if not str(snapshot.get("customer_id") or "").strip():
            blockers.append("Customer identity unresolved")
        if not str(snapshot.get("job_date") or "").strip():
            blockers.append("Job date unresolved")
        if not assembled["lines"]:
            blockers.append("Snapshot has no priced lines.")
        for line in assembled["lines"]:
            if not line.get("billable"):
                continue
            number = line.get("line_number")
            if not line.get("tax_type"):
                blockers.append(f"Line {number}: tax_type unresolved.")
            if not line.get("account_code"):
                blockers.append(f"Line {number}: account_code unresolved.")
            if line.get("unit_sell") == "":
                blockers.append(f"Line {number}: sell rate unresolved.")
        blockers = unique_messages(blockers)

        next_status = SNAPSHOT_DRAFT if blockers else SNAPSHOT_VALIDATED
        snapshot.update(
            {
                "snapshot_status": next_status,
                "pricing_status": PRICING_UNRESOLVED if blockers else PRICING_VALIDATED,
                "blockers": blockers,
                "validated_by": "" if blockers else actor,
                "validated_at": None if blockers else _now(),
                "version": int(snapshot.get("version") or 1) + 1,
            }
        )
        self.store.upsert_financial_snapshot(snapshot)
        self._audit_rates(
            {
                "action": "validate_financial_snapshot",
                "actor_staff_id": body.get("staff_id"),
                "actor_role": normalize_role(str(body.get("actor_role") or "")),
                "resource_type": "financial_snapshots",
                "resource_id": snapshot_id,
                "completion_id": snapshot.get("completion_id"),
                "previous_status": previous,
                "new_status": next_status,
                "version": snapshot["version"],
            }
        )
        return self._assemble_snapshot(snapshot)

    def _approve_financial_snapshot(self, body: dict[str, Any]) -> dict[str, Any]:
        snapshot_id = str(body.get("financial_snapshot_id") or "")
        actor = str(body.get("actor_identity") or body.get("staff_id") or "")
        snapshot = self._get_snapshot(snapshot_id)
        self._check_rates_version(snapshot, body.get("expected_version"), "financial snapshot")
        previous = str(snapshot.get("snapshot_status") or "")
        self._assert_snapshot_transition(previous, SNAPSHOT_APPROVED)
        if list(snapshot.get("blockers") or []):
            raise HTTPException(
                status_code=422,
                detail="Validation Error: resolve snapshot blockers before approving.",
            )
        snapshot.update(
            {
                "snapshot_status": SNAPSHOT_APPROVED,
                "pricing_status": PRICING_APPROVED,
                "approved_by": actor,
                "approved_at": _now(),
                "version": int(snapshot.get("version") or 1) + 1,
            }
        )
        self.store.upsert_financial_snapshot(snapshot)
        self._audit_rates(
            {
                "action": "approve_financial_snapshot",
                "actor_staff_id": body.get("staff_id"),
                "actor_role": normalize_role(str(body.get("actor_role") or "")),
                "resource_type": "financial_snapshots",
                "resource_id": snapshot_id,
                "completion_id": snapshot.get("completion_id"),
                "previous_status": previous,
                "new_status": SNAPSHOT_APPROVED,
                "version": snapshot["version"],
            }
        )
        return self._assemble_snapshot(snapshot)

    def _supersede_financial_snapshot(self, body: dict[str, Any]) -> dict[str, Any]:
        snapshot_id = str(body.get("financial_snapshot_id") or "")
        actor = str(body.get("actor_identity") or body.get("staff_id") or "")
        reason = str(body.get("reason") or "").strip()
        if not reason:
            raise HTTPException(
                status_code=422,
                detail="Validation Error: reason is required to supersede an approved snapshot.",
            )
        snapshot = self._get_snapshot(snapshot_id)
        self._check_rates_version(snapshot, body.get("expected_version"), "financial snapshot")
        previous = str(snapshot.get("snapshot_status") or "")
        self._assert_snapshot_transition(previous, SNAPSHOT_SUPERSEDED)
        existing_notes = str(snapshot.get("notes") or "")
        snapshot.update(
            {
                "snapshot_status": SNAPSHOT_SUPERSEDED,
                "superseded_by": actor,
                "superseded_at": _now(),
                "notes": (
                    f"{existing_notes} | Superseded: {reason}"
                    if existing_notes
                    else f"Superseded: {reason}"
                ),
                "version": int(snapshot.get("version") or 1) + 1,
            }
        )
        self.store.upsert_financial_snapshot(snapshot)
        self._audit_rates(
            {
                "action": "supersede_financial_snapshot",
                "actor_staff_id": body.get("staff_id"),
                "actor_role": normalize_role(str(body.get("actor_role") or "")),
                "resource_type": "financial_snapshots",
                "resource_id": snapshot_id,
                "completion_id": snapshot.get("completion_id"),
                "previous_status": previous,
                "new_status": SNAPSHOT_SUPERSEDED,
                "version": snapshot["version"],
            }
        )
        return self._assemble_snapshot(snapshot)

    async def afinancial_snapshot_action(
        self, action: str, body: dict[str, Any]
    ) -> dict[str, Any]:
        self._assert_rates_manager(body.get("actor_role"))
        if action == "create_financial_snapshot":
            return self._create_financial_snapshot(body)
        if action == "list_financial_snapshots":
            return self._list_financial_snapshots(body)
        if action == "get_financial_snapshot":
            return self._assemble_snapshot(
                self._get_snapshot(str(body.get("financial_snapshot_id") or ""))
            )
        if action == "validate_financial_snapshot":
            return self._validate_financial_snapshot(body)
        if action == "approve_financial_snapshot":
            return self._approve_financial_snapshot(body)
        if action == "supersede_financial_snapshot":
            return self._supersede_financial_snapshot(body)
        raise HTTPException(status_code=400, detail=f"Unsupported snapshot action: {action}")
