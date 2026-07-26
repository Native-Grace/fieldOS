"""Phase 3E decimal-safe money + rate resolution (server-side mirror of RatesFinancialHelpers.js).

Money policy:
- Store/compute in integer cents (AUD); quantities go through micro-units.
- Round half-up at line level, then sum rounded line cents.
- Never use binary float for currency totals.
- Never silently fall back to zero. Zero only ever comes from an explicit
  non-billable flag and always carries a reason.
"""

from __future__ import annotations

import math
import re
from decimal import Decimal, InvalidOperation, ROUND_DOWN, ROUND_HALF_UP
from typing import Any, Callable, Iterable

from app.services.completion_math import compute_labour_entry, unique_messages
from app.services.export_math import is_confirmed, normalise_calendar_date

CURRENCY_DEFAULT = "AUD"

RATE_STATUS_ACTIVE = "Active"
RATE_STATUS_INACTIVE = "Inactive"

SNAPSHOT_DRAFT = "Draft"
SNAPSHOT_VALIDATED = "Validated"
SNAPSHOT_APPROVED = "Approved"
SNAPSHOT_SUPERSEDED = "Superseded"
SNAPSHOT_CANCELLED = "Cancelled"

PRICING_UNRESOLVED = "Unresolved"
PRICING_READY = "Ready"
PRICING_VALIDATED = "Validated"
PRICING_APPROVED = "Approved"

LINE_TYPE_LABOUR = "labour"
LINE_TYPE_TRAVEL = "travel"
LINE_TYPE_MACHINERY = "machinery"
LINE_TYPE_MATERIAL = "material"

SOURCE_PROJECT = "customer_project_override"
SOURCE_CUSTOMER = "customer_override"
SOURCE_STAFF = "staff_specific"
SOURCE_ROLE = "role_activity"
SOURCE_DEFAULT_CARD = "default_rate_card"
SOURCE_UNRESOLVED = "unresolved"
SOURCE_NON_BILLABLE = "non_billable"
SOURCE_MACHINERY_RATE = "machinery_rate"
SOURCE_MATERIAL_CATALOG = "material_catalog"

NON_BILLABLE_REASON = "Marked non-billable on the completion — zero sell value recorded."
NON_BILLABLE_TRAVEL_REASON = "Travel attached to non-billable labour — zero sell value recorded."

SNAPSHOT_TRANSITIONS: dict[str, list[str]] = {
    SNAPSHOT_DRAFT: [SNAPSHOT_DRAFT, SNAPSHOT_VALIDATED, SNAPSHOT_CANCELLED],
    SNAPSHOT_VALIDATED: [SNAPSHOT_DRAFT, SNAPSHOT_VALIDATED, SNAPSHOT_APPROVED, SNAPSHOT_CANCELLED],
    SNAPSHOT_APPROVED: [SNAPSHOT_SUPERSEDED],
    SNAPSHOT_SUPERSEDED: [],
    SNAPSHOT_CANCELLED: [],
}

_MONEY_RE = re.compile(r"^-?\d+(\.\d+)?$")
_MICRO = Decimal(1_000_000)


def _is_blank(value: Any) -> bool:
    return value is None or value == ""


def round_half_up(value: Decimal) -> int:
    """Half away from zero, matching the Apps Script helper."""
    return int(value.quantize(Decimal(1), rounding=ROUND_HALF_UP))


def _decimal_or_none(value: Any, *, strict_text: bool) -> Decimal | None:
    if _is_blank(value) or isinstance(value, bool):
        return None
    if isinstance(value, Decimal):
        return value if value.is_finite() else None
    if isinstance(value, int):
        return Decimal(value)
    if isinstance(value, float):
        return Decimal(str(value)) if math.isfinite(value) else None
    text = str(value).strip().replace(",", "")
    if not text:
        return None
    if strict_text and not _MONEY_RE.match(text):
        return None
    try:
        parsed = Decimal(text)
    except InvalidOperation:
        return None
    return parsed if parsed.is_finite() else None


def parse_money_to_cents(value: Any) -> int | None:
    """Money-like input → integer cents. Blank / non-numeric input returns None, never zero."""
    amount = _decimal_or_none(value, strict_text=True)
    if amount is None:
        return None
    return round_half_up(amount * 100)


def cents_to_money_string(cents: Any) -> str | None:
    amount = _decimal_or_none(cents, strict_text=False)
    if amount is None:
        return None
    whole_cents = int(amount.to_integral_value(rounding=ROUND_DOWN))
    sign = "-" if whole_cents < 0 else ""
    absolute = abs(whole_cents)
    return f"{sign}{absolute // 100}.{absolute % 100:02d}"


def finite_number(value: Any) -> float | None:
    """Numeric coercion for quantities/percentages (never used for currency totals)."""
    amount = _decimal_or_none(value, strict_text=False)
    return None if amount is None else float(amount)


def line_amount_cents(quantity: Any, unit_rate_cents: Any) -> int | None:
    rate = _decimal_or_none(unit_rate_cents, strict_text=False)
    qty = _decimal_or_none(quantity, strict_text=False)
    if rate is None or qty is None:
        return None
    quantity_micro = Decimal(round_half_up(qty * _MICRO))
    return round_half_up(quantity_micro * rate / _MICRO)


def tax_amount_cents(subtotal_ex_tax_cents: Any, tax_rate_percent: Any) -> int | None:
    subtotal = _decimal_or_none(subtotal_ex_tax_cents, strict_text=False)
    percent = _decimal_or_none(tax_rate_percent, strict_text=False)
    if subtotal is None or percent is None:
        return None
    return round_half_up(subtotal * percent / 100)


def sum_cents(values: Iterable[Any] | None) -> int:
    total = 0
    for value in values or []:
        amount = _decimal_or_none(value, strict_text=False)
        if amount is None:
            continue
        total += int(amount.to_integral_value(rounding=ROUND_DOWN))
    return total


def round_quantity(value: Any) -> float | None:
    amount = _decimal_or_none(value, strict_text=False)
    if amount is None:
        return None
    return float(amount.quantize(Decimal("0.0001"), rounding=ROUND_HALF_UP))


def is_active_status(status: Any) -> bool:
    return str(status or "").strip() == RATE_STATUS_ACTIVE


def is_catalog_active(row: dict[str, Any]) -> bool:
    value = row.get("active")
    if value is False:
        return False
    return str(value).strip().upper() != "FALSE"


def date_effective(row: dict[str, Any] | None, on_date: Any) -> bool:
    """Inclusive on both ends; blank bounds are open-ended."""
    on = normalise_calendar_date(on_date)
    if not on:
        return False
    row = row or {}
    start = normalise_calendar_date(row.get("effective_from"))
    end = normalise_calendar_date(row.get("effective_to"))
    if start and on < start:
        return False
    if end and on > end:
        return False
    return True


def find_effective_overlaps(
    rows: list[dict[str, Any]] | None,
    id_field: str,
    key_fn: Callable[[dict[str, Any]], str],
) -> list[dict[str, str]]:
    active = [row for row in (rows or []) if is_active_status(row.get("status"))]
    issues: list[dict[str, str]] = []
    for index, first in enumerate(active):
        for second in active[index + 1 :]:
            if key_fn(first) != key_fn(second):
                continue
            a_from = normalise_calendar_date(first.get("effective_from")) or "0000-01-01"
            a_to = normalise_calendar_date(first.get("effective_to")) or "9999-12-31"
            b_from = normalise_calendar_date(second.get("effective_from")) or "0000-01-01"
            b_to = normalise_calendar_date(second.get("effective_to")) or "9999-12-31"
            if a_from <= b_to and b_from <= a_to:
                a_id = str(first.get(id_field) or "")
                b_id = str(second.get(id_field) or "")
                issues.append(
                    {
                        "a_id": a_id,
                        "b_id": b_id,
                        "message": f"Overlapping active records {a_id} and {b_id}",
                    }
                )
    return issues


def unresolved_rate(blockers: list[str] | None = None) -> dict[str, Any]:
    return {
        "resolved": False,
        "rate": None,
        "rate_cents": None,
        "unit": "",
        "source_type": SOURCE_UNRESOLVED,
        "source_id": "",
        "effective_date": "",
        "blockers": list(blockers or []),
    }


def resolved_rate(
    *,
    rate_cents: int,
    unit: str = "hour",
    source_type: str,
    source_id: str = "",
    effective_date: str = "",
    **extra: Any,
) -> dict[str, Any]:
    payload = {
        "resolved": True,
        "rate": cents_to_money_string(rate_cents),
        "rate_cents": rate_cents,
        "unit": unit or "hour",
        "source_type": source_type,
        "source_id": source_id or "",
        "effective_date": effective_date or "",
        "blockers": [],
    }
    payload.update(extra)
    return payload


def _preferred_rate_card(
    context: dict[str, Any],
    customer_pricing: list[dict[str, Any]] | None,
    on_date: str,
) -> str:
    preferred = str(context.get("rate_card_id") or "").strip()
    customer_id = str(context.get("customer_id") or "").strip()
    project_id = str(context.get("project_id") or "").strip()
    if preferred or not customer_id:
        return preferred
    pricing = [
        row
        for row in (customer_pricing or [])
        if is_active_status(row.get("status"))
        and date_effective(row, on_date)
        and str(row.get("customer_id") or "") == customer_id
        and (not project_id or not row.get("project_id") or str(row.get("project_id")) == project_id)
    ]
    # Project-specific pricing wins over customer-wide pricing.
    pricing.sort(key=lambda row: 0 if str(row.get("project_id") or "") == project_id else 1)
    return str(pricing[0].get("rate_card_id") or "").strip() if pricing else ""


def resolve_labour_sell_rate(
    context: dict[str, Any] | None,
    labour_rates: list[dict[str, Any]] | None,
    customer_pricing: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    context = context or {}
    on_date = normalise_calendar_date(context.get("on_date"))
    if not on_date:
        return unresolved_rate(["Job date required for labour rate resolution."])

    staff_id = str(context.get("staff_id") or "").strip()
    role_code = str(context.get("role_code") or "").strip()
    activity_code = str(context.get("activity_code") or "").strip()
    customer_id = str(context.get("customer_id") or "").strip()
    project_id = str(context.get("project_id") or "").strip()
    preferred_card = _preferred_rate_card(context, customer_pricing, on_date)

    candidates = [
        row
        for row in (labour_rates or [])
        if is_active_status(row.get("status")) and date_effective(row, on_date)
    ]
    if preferred_card:
        scoped = [row for row in candidates if str(row.get("rate_card_id") or "") == preferred_card]
        if scoped:
            candidates = scoped

    def _blank(row: dict[str, Any], field: str) -> bool:
        return not str(row.get(field) or "").strip()

    tiers: list[tuple[str, Callable[[dict[str, Any]], bool]]] = [
        (
            SOURCE_PROJECT,
            lambda row: bool(project_id)
            and str(row.get("project_id") or "") == project_id
            and (not row.get("staff_id") or str(row.get("staff_id")) == staff_id)
            and (not row.get("customer_id") or str(row.get("customer_id")) == customer_id),
        ),
        (
            SOURCE_CUSTOMER,
            lambda row: bool(customer_id)
            and str(row.get("customer_id") or "") == customer_id
            and _blank(row, "project_id")
            and (not row.get("staff_id") or str(row.get("staff_id")) == staff_id),
        ),
        (
            SOURCE_STAFF,
            lambda row: bool(staff_id)
            and str(row.get("staff_id") or "") == staff_id
            and _blank(row, "customer_id")
            and _blank(row, "project_id"),
        ),
        (
            SOURCE_ROLE,
            lambda row: bool(role_code or activity_code)
            and _blank(row, "staff_id")
            and _blank(row, "customer_id")
            and _blank(row, "project_id")
            and (
                (bool(role_code) and str(row.get("role_code") or "") == role_code)
                or (bool(activity_code) and str(row.get("activity_code") or "") == activity_code)
            ),
        ),
        (
            SOURCE_DEFAULT_CARD,
            lambda row: _blank(row, "staff_id")
            and _blank(row, "customer_id")
            and _blank(row, "project_id")
            and _blank(row, "role_code")
            and _blank(row, "activity_code"),
        ),
    ]

    for source_type, predicate in tiers:
        hits = sorted(
            (row for row in candidates if predicate(row)),
            key=lambda row: str(row.get("labour_rate_id") or ""),
        )
        if not hits:
            continue
        chosen = hits[0]
        sell_cents = parse_money_to_cents(chosen.get("sell_rate"))
        if sell_cents is None:
            return unresolved_rate(
                [f"Labour rate {chosen.get('labour_rate_id') or ''} has invalid sell_rate."]
            )
        return resolved_rate(
            rate_cents=sell_cents,
            unit=str(chosen.get("unit") or "hour"),
            source_type=source_type,
            source_id=str(chosen.get("labour_rate_id") or ""),
            effective_date=on_date,
        )

    who = staff_id or "(no staff_id)"
    return unresolved_rate([f"No active labour sell rate for {who} on {on_date}"])


def _labour_rate_row(
    labour_rates: list[dict[str, Any]] | None, rate_id: str
) -> dict[str, Any] | None:
    for row in labour_rates or []:
        if str(row.get("labour_rate_id") or "") == str(rate_id or ""):
            return row
    return None


def resolve_labour_cost_rate(
    context: dict[str, Any] | None,
    labour_rates: list[dict[str, Any]] | None,
    customer_pricing: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    sell = resolve_labour_sell_rate(context, labour_rates, customer_pricing)
    if not sell["resolved"]:
        return sell
    row = _labour_rate_row(labour_rates, sell["source_id"])
    if not row:
        return unresolved_rate(["Labour rate row missing for cost lookup."])
    cost_cents = parse_money_to_cents(row.get("cost_rate"))
    if cost_cents is None:
        return unresolved_rate([f"Labour rate {sell['source_id']} has invalid cost_rate."])
    return resolved_rate(
        rate_cents=cost_cents,
        unit=str(row.get("unit") or "hour"),
        source_type=sell["source_type"],
        source_id=sell["source_id"],
        effective_date=sell["effective_date"],
    )


def resolve_labour_travel_rate(
    context: dict[str, Any] | None,
    labour_rates: list[dict[str, Any]] | None,
    customer_pricing: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    sell = resolve_labour_sell_rate(context, labour_rates, customer_pricing)
    if not sell["resolved"]:
        return sell
    row = _labour_rate_row(labour_rates, sell["source_id"])
    if not row:
        return unresolved_rate(["Labour rate row missing for travel lookup."])
    if _is_blank(row.get("travel_rate")):
        return unresolved_rate(
            [f"Labour rate {sell['source_id']} has no travel_rate configured."]
        )
    travel_cents = parse_money_to_cents(row.get("travel_rate"))
    if travel_cents is None:
        return unresolved_rate([f"Labour rate {sell['source_id']} has invalid travel_rate."])
    return resolved_rate(
        rate_cents=travel_cents,
        unit=str(row.get("unit") or "hour"),
        source_type=sell["source_type"],
        source_id=sell["source_id"],
        effective_date=sell["effective_date"],
    )


def resolve_machinery_sell_rate(
    context: dict[str, Any] | None,
    machinery_rates: list[dict[str, Any]] | None,
) -> dict[str, Any]:
    context = context or {}
    on_date = normalise_calendar_date(context.get("on_date"))
    if not on_date:
        return unresolved_rate(["Job date required for machinery rate resolution."])
    equipment_id = str(context.get("equipment_id") or "").strip()
    equipment_name = str(context.get("equipment_name") or "").strip()
    charge_code = str(context.get("charge_code") or "").strip()
    if not equipment_id and not equipment_name:
        return unresolved_rate(["Unknown equipment — equipment_id or equipment_name required."])

    def _matches(row: dict[str, Any]) -> bool:
        if not is_active_status(row.get("status")) or not date_effective(row, on_date):
            return False
        if equipment_id and str(row.get("equipment_id") or "") == equipment_id:
            return True
        if (
            not equipment_id
            and equipment_name
            and str(row.get("equipment_name") or "").lower() == equipment_name.lower()
        ):
            return True
        if charge_code and str(row.get("charge_code") or "") == charge_code:
            return True
        return False

    hits = sorted(
        (row for row in (machinery_rates or []) if _matches(row)),
        key=lambda row: str(row.get("machinery_rate_id") or ""),
    )
    if not hits:
        target = equipment_id or equipment_name
        return unresolved_rate([f"No active machinery sell rate for {target} on {on_date}"])
    chosen = hits[0]
    sell_cents = parse_money_to_cents(chosen.get("sell_rate"))
    if sell_cents is None:
        return unresolved_rate(
            [f"Machinery rate {chosen.get('machinery_rate_id') or ''} has invalid sell_rate."]
        )
    return resolved_rate(
        rate_cents=sell_cents,
        unit=str(chosen.get("unit") or "hour"),
        source_type=SOURCE_MACHINERY_RATE,
        source_id=str(chosen.get("machinery_rate_id") or ""),
        effective_date=on_date,
        minimum_charge_cents=parse_money_to_cents(chosen.get("minimum_charge")),
    )


def resolve_material_price(
    context: dict[str, Any] | None,
    catalog: list[dict[str, Any]] | None,
) -> dict[str, Any]:
    """Catalog match by material_id / item_code only. Name similarity is a suggestion, never a price."""
    context = context or {}
    material_id = str(context.get("material_id") or "").strip()
    item_code = str(context.get("item_code") or "").strip()
    item_name = str(context.get("item_name") or "").strip()

    def _matches(row: dict[str, Any]) -> bool:
        if not is_catalog_active(row):
            return False
        if material_id and str(row.get("material_id") or "") == material_id:
            return True
        if item_code and str(row.get("item_code") or "") == item_code:
            return True
        return False

    hits = sorted(
        (row for row in (catalog or []) if _matches(row)),
        key=lambda row: str(row.get("material_id") or ""),
    )
    if not hits:
        suggestions: list[dict[str, Any]] = []
        if item_name:
            suggestions = [
                {
                    "material_id": str(row.get("material_id") or ""),
                    "item_code": str(row.get("item_code") or ""),
                    "item_name": str(row.get("item_name") or ""),
                }
                for row in (catalog or [])
                if is_catalog_active(row)
                and item_name.lower() in str(row.get("item_name") or "").lower()
            ][:5]
        target = material_id or item_code or item_name or "(blank)"
        payload = unresolved_rate([f"No confirmed material catalog match for {target}"])
        payload["suggested_matches"] = suggestions
        return payload

    chosen = hits[0]
    sell_cents = parse_money_to_cents(chosen.get("sell_price"))
    if sell_cents is None:
        payload = unresolved_rate(
            [f"Material {chosen.get('material_id') or ''} has invalid sell_price."]
        )
        payload["suggested_matches"] = []
        return payload
    return resolved_rate(
        rate_cents=sell_cents,
        unit=str(chosen.get("unit") or ""),
        source_type=SOURCE_MATERIAL_CATALOG,
        source_id=str(chosen.get("material_id") or ""),
        effective_date=normalise_calendar_date(context.get("on_date")) or "",
        cost_cents=parse_money_to_cents(chosen.get("cost_price")),
        tax_code=str(chosen.get("tax_code") or ""),
        account_code=str(chosen.get("account_code") or ""),
        suggested_matches=[],
    )


def resolve_payroll_mapping(
    staff_id: Any,
    mappings: list[dict[str, Any]] | None,
    on_date: Any,
) -> dict[str, Any]:
    sid = str(staff_id or "").strip()
    on = normalise_calendar_date(on_date)
    if not sid:
        return {"resolved": False, "blockers": ["staff_id required for payroll mapping."]}
    if not on:
        return {"resolved": False, "blockers": ["work_date required for payroll mapping."]}
    hits = sorted(
        (
            row
            for row in (mappings or [])
            if is_active_status(row.get("status"))
            and date_effective(row, on)
            and str(row.get("staff_id") or "") == sid
        ),
        key=lambda row: str(row.get("payroll_mapping_id") or ""),
    )
    if not hits:
        return {"resolved": False, "blockers": [f"No active payroll mapping for {sid} on {on}"]}
    mapping = hits[0]
    blockers: list[str] = []
    if not str(mapping.get("employee_reference") or "").strip():
        blockers.append("employee_reference missing")
    if not str(mapping.get("ordinary_hours_code") or "").strip():
        blockers.append("ordinary_hours_code missing")
    if not str(mapping.get("cost_centre") or "").strip():
        blockers.append("cost_centre missing")
    if blockers:
        return {"resolved": False, "blockers": blockers, "mapping": mapping}
    return {
        "resolved": True,
        "blockers": [],
        "mapping": mapping,
        "source_id": str(mapping.get("payroll_mapping_id") or ""),
    }


def resolve_xero_mapping(
    entity_type: Any,
    local_reference: Any,
    mappings: list[dict[str, Any]] | None,
) -> dict[str, Any]:
    entity = str(entity_type or "").strip()
    local = str(local_reference or "").strip()
    hits = sorted(
        (
            row
            for row in (mappings or [])
            if is_active_status(row.get("status"))
            and str(row.get("entity_type") or "") == entity
            and str(row.get("local_reference") or "") == local
        ),
        key=lambda row: str(row.get("xero_mapping_id") or ""),
    )
    if not hits:
        return {
            "resolved": False,
            "blockers": [f"No active Xero mapping for {entity} / {local or '(blank)'}"],
        }
    mapping = hits[0]
    blockers: list[str] = []
    if not str(mapping.get("account_code") or "").strip():
        blockers.append("account_code missing")
    if not str(mapping.get("tax_type") or "").strip():
        blockers.append("tax_type missing")
    if _is_blank(mapping.get("tax_rate_percent")) and mapping.get("tax_rate_percent") != 0:
        blockers.append(
            f"tax_rate_percent not configured for tax_type {mapping.get('tax_type') or ''}"
        )
    if blockers:
        return {"resolved": False, "blockers": blockers, "mapping": mapping}
    return {
        "resolved": True,
        "blockers": [],
        "mapping": mapping,
        "source_id": str(mapping.get("xero_mapping_id") or ""),
    }


def resolve_line_tax_mapping(
    line_type: str,
    local_references: list[Any] | None,
    xero_mappings: list[dict[str, Any]] | None,
) -> dict[str, Any]:
    entity_type = LINE_TYPE_LABOUR if str(line_type) == LINE_TYPE_TRAVEL else str(line_type)
    refs: list[str] = []
    for raw in local_references or []:
        value = str("" if raw is None else raw).strip()
        if value and value not in refs:
            refs.append(value)
    if entity_type not in refs:
        refs.append(entity_type)
    last_blockers: list[str] = []
    for ref in refs:
        result = resolve_xero_mapping(entity_type, ref, xero_mappings)
        if result["resolved"]:
            return {
                "resolved": True,
                "entity_type": entity_type,
                "local_reference": ref,
                "mapping": result["mapping"],
                "blockers": [],
            }
        last_blockers = list(result.get("blockers") or [])
    return {
        "resolved": False,
        "entity_type": entity_type,
        "local_reference": refs[-1] if refs else entity_type,
        "mapping": None,
        "blockers": last_blockers or [f"No active Xero mapping for {entity_type}."],
    }


def financial_audit_payload(meta: dict[str, Any]) -> dict[str, Any]:
    """Allow-list audit fields — no money, names, transcripts or secrets."""
    return {
        "action": meta.get("action") or "",
        "actor_staff_id": meta.get("actor_staff_id") or "",
        "actor_role": meta.get("actor_role") or "",
        "resource_type": meta.get("resource_type") or "",
        "resource_id": meta.get("resource_id") or "",
        "completion_id": meta.get("completion_id") or "",
        "previous_status": meta.get("previous_status") or "",
        "new_status": meta.get("new_status") or "",
        "version": meta.get("version") if meta.get("version") is not None else None,
        "changed_fields": list(meta.get("changed_fields") or []),
        "source_ids": list(meta.get("source_ids") or []),
        "correlation_id": meta.get("correlation_id") or "",
    }


def snapshot_transition_allowed(current_status: Any, target_status: Any) -> bool:
    allowed = SNAPSHOT_TRANSITIONS.get(str(current_status or "").strip())
    if allowed is None:
        return False
    return str(target_status or "").strip() in allowed


def snapshot_transition_error(current_status: Any, target_status: Any) -> str | None:
    """Validation message for a disallowed transition, or None when allowed."""
    if snapshot_transition_allowed(current_status, target_status):
        return None
    current = str(current_status or "").strip()
    target = str(target_status or "").strip()
    if current == SNAPSHOT_APPROVED:
        return (
            "Validation Error: Approved financial snapshots are immutable — "
            "supersede the snapshot to reprice."
        )
    if current in (SNAPSHOT_SUPERSEDED, SNAPSHOT_CANCELLED):
        return f"Validation Error: {current} financial snapshots cannot be changed."
    return (
        f"Validation Error: cannot move financial snapshot from {current or '(blank)'} "
        f"to {target or '(blank)'}."
    )


def is_truthy_flag(value: Any) -> bool:
    return value in (True, "TRUE", "true", 1, "1")


def labour_hours_for_entry(entry: dict[str, Any] | None) -> float | None:
    """Confirmed stored hours, else recomputed from clock times. Never invented."""
    entry = entry or {}
    stored = finite_number(entry.get("labour_hours"))
    if stored is not None and stored >= 0:
        return stored
    calc = compute_labour_entry(entry)
    return calc.get("labour_hours")


def travel_hours_for_entry(entry: dict[str, Any] | None) -> float:
    minutes = finite_number((entry or {}).get("travel_minutes"))
    if minutes is None or minutes <= 0:
        return 0.0
    return float(
        (Decimal(str(minutes)) / 60).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
    )


def build_financial_lines(payload: dict[str, Any] | None = None) -> dict[str, Any]:
    """Pure snapshot line builder.

    job_date (the job sheet calendar date) selects effective rates — never finalised_at.
    Only Confirmed rows are priced. Unresolved rates leave unit_sell blank with blockers.
    """
    options = payload or {}
    job_date = normalise_calendar_date(options.get("job_date")) or ""
    identity = options.get("identity") or {}
    tables = options.get("tables") or {}
    labour_rates = tables.get("labour_rates") or []
    machinery_rates = tables.get("machinery_rates") or []
    catalog = tables.get("material_catalog") or []
    customer_pricing = tables.get("customer_pricing") or []
    xero_mappings = tables.get("xero_mappings") or []

    lines: list[dict[str, Any]] = []
    blockers: list[str] = []
    suggestions: list[dict[str, Any]] = []
    counter = {"line_number": 0}

    if not job_date:
        blockers.append("Job date unresolved — rates cannot be selected for this completion.")

    def add_blockers(messages: list[str] | None) -> None:
        for message in messages or []:
            text = str(message or "").strip()
            if text and text not in blockers:
                blockers.append(text)

    def build_line(spec: dict[str, Any]) -> dict[str, Any]:
        counter["line_number"] += 1
        line_number = counter["line_number"]
        line_blockers = list(spec.get("blockers") or [])
        billable = spec.get("billable") is not False
        quantity = spec.get("quantity")
        unit_sell_cents = spec.get("unit_sell_cents")

        amount_cents = None
        if unit_sell_cents is not None and quantity is not None:
            amount_cents = line_amount_cents(quantity, unit_sell_cents)
            if amount_cents is None:
                line_blockers.append(
                    f"Line amount could not be calculated for line {line_number}."
                )

        tax = spec.get("tax") or {"resolved": False, "mapping": None, "blockers": []}
        tax_type = ""
        account_code = ""
        tax_rate_percent = None
        if tax.get("resolved") and tax.get("mapping"):
            mapping = tax["mapping"]
            tax_type = str(mapping.get("tax_type") or "")
            account_code = str(mapping.get("account_code") or "")
            tax_rate_percent = finite_number(mapping.get("tax_rate_percent"))
        elif billable:
            line_blockers = line_blockers + list(tax.get("blockers") or [])

        line_tax_cents = None
        if amount_cents is not None and tax_rate_percent is not None:
            line_tax_cents = tax_amount_cents(amount_cents, tax_rate_percent)
        elif amount_cents == 0:
            line_tax_cents = 0

        total_cents = (
            amount_cents + line_tax_cents
            if amount_cents is not None and line_tax_cents is not None
            else None
        )

        line = {
            "line_number": line_number,
            "line_type": spec.get("line_type"),
            "source_row_id": str(spec.get("source_row_id") or ""),
            "description": str(spec.get("description") or ""),
            "staff_id": str(spec.get("staff_id") or ""),
            "equipment_id": str(spec.get("equipment_id") or ""),
            "material_id": str(spec.get("material_id") or ""),
            "quantity": round_quantity(quantity),
            "unit": str(spec.get("unit") or ""),
            "unit_sell_cents": unit_sell_cents,
            "unit_sell": "" if unit_sell_cents is None else cents_to_money_string(unit_sell_cents),
            "line_amount_cents": amount_cents,
            "line_amount_ex_tax": "" if amount_cents is None else cents_to_money_string(amount_cents),
            "tax_type": tax_type,
            "tax_rate_percent": tax_rate_percent,
            "tax_amount_cents": line_tax_cents,
            "tax_amount": "" if line_tax_cents is None else cents_to_money_string(line_tax_cents),
            "line_total_cents": total_cents,
            "line_total_inc_tax": "" if total_cents is None else cents_to_money_string(total_cents),
            "account_code": account_code,
            "rate_source_type": str(spec.get("rate_source_type") or SOURCE_UNRESOLVED),
            "rate_source_id": str(spec.get("rate_source_id") or ""),
            "billable": billable,
            "non_billable_reason": str(spec.get("non_billable_reason") or ""),
            "blockers": unique_messages(line_blockers),
        }
        lines.append(line)
        add_blockers(line["blockers"])
        return line

    for entry in options.get("labour_entries") or []:
        if not is_confirmed(entry):
            continue
        source_id = str(entry.get("labour_id") or "")
        staff_id = str(entry.get("staff_id") or "")
        staff_label = str(entry.get("staff_name") or "") or staff_id or "(unnamed staff)"
        role = str(entry.get("role_or_activity") or "")
        billable = is_truthy_flag(entry.get("billable"))
        hours = labour_hours_for_entry(entry)
        entry_blockers: list[str] = []
        if hours is None:
            entry_blockers.append(f"Labour {source_id or staff_label} has no computable hours.")
        if not staff_id:
            entry_blockers.append(f"Labour {source_id or staff_label} is missing staff_id.")

        rate_context = {
            "staff_id": staff_id,
            "role_code": role,
            "activity_code": role,
            "customer_id": identity.get("customer_id"),
            "project_id": identity.get("project_id"),
            "rate_card_id": identity.get("rate_card_id"),
            "on_date": job_date,
        }

        sell_cents: int | None = None
        source_type = SOURCE_UNRESOLVED
        rate_source_id = ""
        unit = "hour"
        non_billable_reason = ""
        rate: dict[str, Any] | None = None
        if billable:
            rate = resolve_labour_sell_rate(rate_context, labour_rates, customer_pricing)
            if rate["resolved"]:
                sell_cents = rate["rate_cents"]
                source_type = rate["source_type"]
                rate_source_id = rate["source_id"]
                unit = rate["unit"] or "hour"
            else:
                entry_blockers = entry_blockers + list(rate.get("blockers") or [])
        else:
            sell_cents = 0
            source_type = SOURCE_NON_BILLABLE
            non_billable_reason = NON_BILLABLE_REASON

        build_line(
            {
                "line_type": LINE_TYPE_LABOUR,
                "source_row_id": source_id,
                "description": f"Labour — {staff_label}" + (f" ({role})" if role else ""),
                "staff_id": staff_id,
                "quantity": hours,
                "unit": unit,
                "unit_sell_cents": sell_cents,
                "billable": billable,
                "non_billable_reason": non_billable_reason,
                "rate_source_type": source_type,
                "rate_source_id": rate_source_id,
                "tax": resolve_line_tax_mapping(LINE_TYPE_LABOUR, [role, staff_id], xero_mappings),
                "blockers": entry_blockers,
            }
        )

        # Overtime is never inferred from shift length; it is priced only when supplied.
        overtime_hours = finite_number(entry.get("overtime_hours"))
        if billable and overtime_hours is not None and overtime_hours > 0:
            overtime_blockers: list[str] = []
            overtime_cents = None
            overtime_row = (
                _labour_rate_row(labour_rates, rate["source_id"])
                if rate and rate["resolved"]
                else None
            )
            if not overtime_row:
                overtime_blockers.append(
                    f"Overtime hours recorded for {staff_label} but no labour rate row resolved."
                )
            else:
                overtime_cents = parse_money_to_cents(overtime_row.get("overtime_rate"))
                if overtime_cents is None:
                    overtime_blockers.append(
                        f"Labour rate {overtime_row.get('labour_rate_id') or ''} has no "
                        "overtime_rate configured but overtime hours were recorded."
                    )
            build_line(
                {
                    "line_type": LINE_TYPE_LABOUR,
                    "source_row_id": source_id,
                    "description": f"Overtime — {staff_label}",
                    "staff_id": staff_id,
                    "quantity": overtime_hours,
                    "unit": "hour",
                    "unit_sell_cents": overtime_cents,
                    "billable": True,
                    "rate_source_type": SOURCE_UNRESOLVED if overtime_cents is None else source_type,
                    "rate_source_id": str(overtime_row.get("labour_rate_id") or "")
                    if overtime_row
                    else "",
                    "tax": resolve_line_tax_mapping(
                        LINE_TYPE_LABOUR, [role, staff_id], xero_mappings
                    ),
                    "blockers": overtime_blockers,
                }
            )

        travel_hours = travel_hours_for_entry(entry)
        if travel_hours > 0:
            travel_blockers: list[str] = []
            travel_cents: int | None = None
            travel_source_type = SOURCE_UNRESOLVED
            travel_source_id = ""
            travel_reason = ""
            if billable:
                travel_rate = resolve_labour_travel_rate(
                    rate_context, labour_rates, customer_pricing
                )
                if travel_rate["resolved"]:
                    travel_cents = travel_rate["rate_cents"]
                    travel_source_type = travel_rate["source_type"]
                    travel_source_id = travel_rate["source_id"]
                else:
                    travel_blockers = travel_blockers + list(travel_rate.get("blockers") or [])
            else:
                travel_cents = 0
                travel_source_type = SOURCE_NON_BILLABLE
                travel_reason = NON_BILLABLE_TRAVEL_REASON
            build_line(
                {
                    "line_type": LINE_TYPE_TRAVEL,
                    "source_row_id": source_id,
                    "description": f"Travel — {staff_label}",
                    "staff_id": staff_id,
                    "quantity": travel_hours,
                    "unit": "hour",
                    "unit_sell_cents": travel_cents,
                    "billable": billable,
                    "non_billable_reason": travel_reason,
                    "rate_source_type": travel_source_type,
                    "rate_source_id": travel_source_id,
                    "tax": resolve_line_tax_mapping(
                        LINE_TYPE_TRAVEL, [role, staff_id], xero_mappings
                    ),
                    "blockers": travel_blockers,
                }
            )

    for entry in options.get("machinery_entries") or []:
        if not is_confirmed(entry):
            continue
        source_id = str(entry.get("machinery_entry_id") or "")
        equipment_name = str(entry.get("equipment_name") or "")
        equipment_id = str(entry.get("equipment_id") or "")
        charge_code = str(entry.get("charge_code") or "")
        billable = is_truthy_flag(entry.get("billable"))
        hours = finite_number(entry.get("duration_hours"))
        entry_blockers = []
        if hours is None:
            entry_blockers.append(
                f"Machinery {source_id or equipment_name or '(unknown)'} has no duration_hours."
            )

        sell_cents = None
        source_type = SOURCE_UNRESOLVED
        rate_source_id = ""
        unit = "hour"
        non_billable_reason = ""
        if billable:
            machinery_rate = resolve_machinery_sell_rate(
                {
                    "equipment_id": equipment_id,
                    "equipment_name": equipment_name,
                    "charge_code": charge_code,
                    "on_date": job_date,
                },
                machinery_rates,
            )
            if machinery_rate["resolved"]:
                sell_cents = machinery_rate["rate_cents"]
                source_type = machinery_rate["source_type"]
                rate_source_id = machinery_rate["source_id"]
                unit = machinery_rate["unit"] or "hour"
            else:
                entry_blockers = entry_blockers + list(machinery_rate.get("blockers") or [])
        else:
            sell_cents = 0
            source_type = SOURCE_NON_BILLABLE
            non_billable_reason = NON_BILLABLE_REASON

        build_line(
            {
                "line_type": LINE_TYPE_MACHINERY,
                "source_row_id": source_id,
                "description": "Machinery — "
                + (equipment_name or equipment_id or "(unknown equipment)"),
                "equipment_id": equipment_id,
                "quantity": hours,
                "unit": unit,
                "unit_sell_cents": sell_cents,
                "billable": billable,
                "non_billable_reason": non_billable_reason,
                "rate_source_type": source_type,
                "rate_source_id": rate_source_id,
                "tax": resolve_line_tax_mapping(
                    LINE_TYPE_MACHINERY, [charge_code, equipment_id], xero_mappings
                ),
                "blockers": entry_blockers,
            }
        )

    for entry in options.get("material_entries") or []:
        if not is_confirmed(entry):
            continue
        source_id = str(entry.get("material_entry_id") or "")
        item_name = str(entry.get("item_name") or "")
        billable = is_truthy_flag(entry.get("billable"))
        quantity = finite_number(entry.get("quantity"))
        entry_blockers = []
        if quantity is None:
            entry_blockers.append(
                f"Material {source_id or item_name or '(unknown)'} has no quantity."
            )

        price = resolve_material_price(
            {
                "material_id": entry.get("catalog_material_id") or entry.get("material_id"),
                "item_code": entry.get("item_code"),
                "item_name": item_name,
                "on_date": job_date,
            },
            catalog,
        )
        if not price["resolved"] and price.get("suggested_matches"):
            suggestions.append(
                {
                    "source_row_id": source_id,
                    "item_name": item_name,
                    "suggested_matches": price["suggested_matches"],
                }
            )

        sell_cents = None
        source_type = SOURCE_UNRESOLVED
        rate_source_id = ""
        unit = str(entry.get("unit") or "")
        non_billable_reason = ""
        if not price["resolved"]:
            entry_blockers = entry_blockers + list(price.get("blockers") or [])
        else:
            rate_source_id = price["source_id"]
            source_type = price["source_type"]
            unit = price["unit"] or unit
        if not billable:
            sell_cents = 0
            source_type = SOURCE_NON_BILLABLE
            non_billable_reason = NON_BILLABLE_REASON
        elif price["resolved"]:
            sell_cents = price["rate_cents"]

        build_line(
            {
                "line_type": LINE_TYPE_MATERIAL,
                "source_row_id": source_id,
                "description": item_name or "(unnamed material)",
                "material_id": price["source_id"] if price["resolved"] else "",
                "quantity": quantity,
                "unit": unit,
                "unit_sell_cents": sell_cents,
                "billable": billable,
                "non_billable_reason": non_billable_reason,
                "rate_source_type": source_type,
                "rate_source_id": rate_source_id,
                "tax": resolve_line_tax_mapping(
                    LINE_TYPE_MATERIAL,
                    [
                        price["source_id"] if price["resolved"] else "",
                        entry.get("item_code"),
                        price.get("tax_code"),
                    ],
                    xero_mappings,
                ),
                "blockers": entry_blockers,
            }
        )

    subtotal_cents = sum_cents(line["line_amount_cents"] for line in lines)
    total_tax_cents = sum_cents(line["tax_amount_cents"] for line in lines)

    tax_types: list[str] = []
    account_codes: list[str] = []
    tax_rates: list[float] = []
    for line in lines:
        if line["tax_type"] and line["tax_type"] not in tax_types:
            tax_types.append(line["tax_type"])
        if line["account_code"] and line["account_code"] not in account_codes:
            account_codes.append(line["account_code"])
        if line["tax_rate_percent"] is not None and line["tax_rate_percent"] not in tax_rates:
            tax_rates.append(line["tax_rate_percent"])

    return {
        "job_date": job_date,
        "lines": lines,
        "blockers": unique_messages(blockers),
        "suggestions": suggestions,
        "unresolved_line_count": len([line for line in lines if line["blockers"]]),
        "subtotal_ex_tax_cents": subtotal_cents,
        "tax_amount_cents": total_tax_cents,
        "total_inc_tax_cents": subtotal_cents + total_tax_cents,
        "subtotal_ex_tax": cents_to_money_string(subtotal_cents),
        "tax_amount": cents_to_money_string(total_tax_cents),
        "total_inc_tax": cents_to_money_string(subtotal_cents + total_tax_cents),
        "tax_type": tax_types[0] if len(tax_types) == 1 else ("Mixed" if tax_types else ""),
        "tax_rate_percent": tax_rates[0] if len(tax_rates) == 1 else None,
        "account_code": account_codes[0]
        if len(account_codes) == 1
        else ("Mixed" if account_codes else ""),
    }
