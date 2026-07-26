"""Phase 3E rates, pricing readiness and financial snapshot tests (mock mode).

No production rates are seeded anywhere. Every rate used here is created by the
test itself against a clearly-marked TEST rate card.
"""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.services.rates_math import (
    SOURCE_CUSTOMER,
    SOURCE_DEFAULT_CARD,
    SOURCE_NON_BILLABLE,
    SOURCE_PROJECT,
    SOURCE_ROLE,
    SOURCE_STAFF,
    SOURCE_UNRESOLVED,
    build_financial_lines,
    cents_to_money_string,
    date_effective,
    find_effective_overlaps,
    line_amount_cents,
    parse_money_to_cents,
    resolve_labour_sell_rate,
    snapshot_transition_allowed,
    sum_cents,
    tax_amount_cents,
)

JOB_ID = "JS-DEMO001"
STAFF_ID = "STAFF-DEMO001"
CUSTOMER_ID = "CUST-TEST1"

XERO_MAPPINGS = [
    {
        "xero_mapping_id": "XM-LAB",
        "entity_type": "labour",
        "local_reference": "labour",
        "account_code": "200",
        "tax_type": "OUTPUT",
        "tax_rate_percent": 10,
        "status": "Active",
    },
    {
        "xero_mapping_id": "XM-MCH",
        "entity_type": "machinery",
        "local_reference": "machinery",
        "account_code": "220",
        "tax_type": "OUTPUT",
        "tax_rate_percent": 10,
        "status": "Active",
    },
    {
        "xero_mapping_id": "XM-MAT",
        "entity_type": "material",
        "local_reference": "material",
        "account_code": "310",
        "tax_type": "OUTPUT",
        "tax_rate_percent": 10,
        "status": "Active",
    },
]


def _clear_settings() -> None:
    from app.core.config import get_settings

    get_settings.cache_clear()


@pytest.fixture()
def client(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> TestClient:
    monkeypatch.setenv("DATA_MODE", "mock")
    monkeypatch.setenv("JWT_SECRET", "test-secret")
    monkeypatch.setenv("AUTH_USERS_FILE", str(tmp_path / "auth_users.json"))
    monkeypatch.setenv("MOCK_DATA_DIR", str(tmp_path / "mock"))
    monkeypatch.setenv("LOCAL_RECORDINGS_DIR", str(tmp_path / "recordings"))
    monkeypatch.setenv("DEMO_STAFF_EMAIL", "alex@nativegrace.com")
    monkeypatch.setenv("DEMO_STAFF_PASSWORD", "FieldOS-Demo-2026!")
    monkeypatch.setenv("DEMO_STAFF_ID", STAFF_ID)
    monkeypatch.setenv("DEMO_MANAGER_ENABLED", "true")
    monkeypatch.setenv("DEMO_MANAGER_EMAIL", "manager@nativegrace.com")
    monkeypatch.setenv("DEMO_MANAGER_PASSWORD", "FieldOS-Manager-2026!")
    monkeypatch.setenv("DEMO_MANAGER_ID", "STAFF-MGR001")
    _clear_settings()
    from app.main import app

    with TestClient(app) as c:
        yield c
    _clear_settings()


def _login(client: TestClient, email: str, password: str) -> str:
    resp = client.post("/api/v1/auth/login", json={"email": email, "password": password})
    assert resp.status_code == 200, resp.text
    return resp.json()["access_token"]


def _manager_headers(client: TestClient) -> dict[str, str]:
    token = _login(client, "manager@nativegrace.com", "FieldOS-Manager-2026!")
    return {"Authorization": f"Bearer {token}"}


def _staff_headers(client: TestClient) -> dict[str, str]:
    token = _login(client, "alex@nativegrace.com", "FieldOS-Demo-2026!")
    return {"Authorization": f"Bearer {token}"}


def _labour_rate(**overrides) -> dict:
    row = {
        "labour_rate_id": "LR-BASE",
        "rate_card_id": "",
        "staff_id": "",
        "customer_id": "",
        "project_id": "",
        "role_code": "",
        "activity_code": "",
        "unit": "hour",
        "sell_rate": "100.00",
        "cost_rate": "50.00",
        "travel_rate": "",
        "overtime_rate": "",
        "status": "Active",
        "effective_from": "2026-01-01",
        "effective_to": "",
    }
    row.update(overrides)
    return row


def _confirmed_labour(**overrides) -> dict:
    row = {
        "labour_id": "LAB-1",
        "staff_id": "STAFF-1",
        "staff_name": "Alex",
        "work_date": "2026-07-16",
        "start_time": "07:00",
        "finish_time": "15:00",
        "break_minutes": 30,
        "labour_hours": 7.5,
        "travel_minutes": 0,
        "role_or_activity": "",
        "billable": True,
        "confirmation_status": "Confirmed",
    }
    row.update(overrides)
    return row


# ---------------------------------------------------------------- pure math


def test_decimal_cents_precision() -> None:
    assert 0.1 + 0.2 != 0.3  # binary float baseline
    assert parse_money_to_cents("0.10") + parse_money_to_cents("0.20") == 30
    assert cents_to_money_string(30) == "0.30"
    assert parse_money_to_cents("1,234.567") == 123457  # half-up on the third decimal
    assert parse_money_to_cents("-5.005") == -501
    assert parse_money_to_cents("") is None
    assert parse_money_to_cents(None) is None
    assert parse_money_to_cents("abc") is None
    assert parse_money_to_cents(85) == 8500

    # 7.5h at 85.00 stays exact, and GST rounds half-up at line level.
    assert line_amount_cents(7.5, 8500) == 63750
    assert cents_to_money_string(line_amount_cents(7.5, 8500)) == "637.50"
    assert tax_amount_cents(30, 10) == 3
    assert tax_amount_cents(63750, 10) == 6375
    assert sum_cents([63750, 22500, None, ""]) == 86250


def test_line_totals_stay_exact_for_repeating_cents() -> None:
    built = build_financial_lines(
        {
            "job_date": "2026-07-16",
            "identity": {},
            "material_entries": [
                {
                    "material_entry_id": "JMT-1",
                    "material_id": "MATC-A",
                    "item_name": "Sand",
                    "quantity": 1,
                    "billable": True,
                    "confirmation_status": "Confirmed",
                },
                {
                    "material_entry_id": "JMT-2",
                    "material_id": "MATC-B",
                    "item_name": "Gravel",
                    "quantity": 1,
                    "billable": True,
                    "confirmation_status": "Confirmed",
                },
            ],
            "tables": {
                "material_catalog": [
                    {"material_id": "MATC-A", "item_name": "Sand", "sell_price": "0.10", "active": "TRUE"},
                    {"material_id": "MATC-B", "item_name": "Gravel", "sell_price": "0.20", "active": "TRUE"},
                ],
                "xero_mappings": XERO_MAPPINGS,
            },
        }
    )
    assert [line["line_amount_ex_tax"] for line in built["lines"]] == ["0.10", "0.20"]
    assert built["subtotal_ex_tax"] == "0.30"
    assert built["tax_amount"] == "0.03"
    assert built["total_inc_tax"] == "0.33"


def test_labour_rate_precedence() -> None:
    context = {
        "staff_id": "STAFF-1",
        "role_code": "LEADING_HAND",
        "activity_code": "LEADING_HAND",
        "customer_id": "CUST-1",
        "project_id": "PROJ-1",
        "on_date": "2026-07-16",
    }
    rows = [
        _labour_rate(labour_rate_id="LR-DEFAULT", sell_rate="80.00"),
        _labour_rate(labour_rate_id="LR-ROLE", role_code="LEADING_HAND", sell_rate="90.00"),
        _labour_rate(labour_rate_id="LR-STAFF", staff_id="STAFF-1", sell_rate="95.00"),
        _labour_rate(labour_rate_id="LR-CUST", customer_id="CUST-1", sell_rate="105.00"),
        _labour_rate(labour_rate_id="LR-PROJ", project_id="PROJ-1", sell_rate="120.00"),
    ]
    expected = [
        ("LR-PROJ", SOURCE_PROJECT, 12000),
        ("LR-CUST", SOURCE_CUSTOMER, 10500),
        ("LR-STAFF", SOURCE_STAFF, 9500),
        ("LR-ROLE", SOURCE_ROLE, 9000),
        ("LR-DEFAULT", SOURCE_DEFAULT_CARD, 8000),
    ]
    candidates = list(rows)
    for rate_id, source_type, cents in expected:
        resolved = resolve_labour_sell_rate(context, candidates, [])
        assert resolved["resolved"] is True
        assert resolved["source_id"] == rate_id
        assert resolved["source_type"] == source_type
        assert resolved["rate_cents"] == cents
        candidates = [row for row in candidates if row["labour_rate_id"] != rate_id]

    exhausted = resolve_labour_sell_rate(context, [], [])
    assert exhausted["resolved"] is False
    assert exhausted["rate_cents"] is None
    assert exhausted["source_type"] == SOURCE_UNRESOLVED


def test_effective_dates_are_inclusive_and_overlaps_detected() -> None:
    window = _labour_rate(
        labour_rate_id="LR-WINDOW",
        effective_from="2026-07-16",
        effective_to="2026-07-16",
        sell_rate="77.00",
    )
    assert date_effective(window, "2026-07-16") is True
    assert date_effective(window, "2026-07-15") is False
    assert date_effective(window, "2026-07-17") is False

    overlaps = find_effective_overlaps(
        [
            _labour_rate(labour_rate_id="LR-A", effective_from="2026-01-01", effective_to="2026-06-30"),
            _labour_rate(labour_rate_id="LR-B", effective_from="2026-06-30", effective_to=""),
            _labour_rate(labour_rate_id="LR-C", effective_from="2026-07-01", status="Inactive"),
        ],
        "labour_rate_id",
        lambda row: f"{row.get('staff_id') or ''}|{row.get('role_code') or ''}",
    )
    assert len(overlaps) == 1
    assert "LR-A" in overlaps[0]["message"] and "LR-B" in overlaps[0]["message"]


def test_unresolved_rates_never_price_as_zero() -> None:
    built = build_financial_lines(
        {
            "job_date": "2026-07-16",
            "identity": {"customer_id": "CUST-1", "project_id": "PROJ-1"},
            "labour_entries": [_confirmed_labour()],
            "machinery_entries": [
                {
                    "machinery_entry_id": "MCH-1",
                    "equipment_name": "Excavator",
                    "duration_hours": 2,
                    "billable": True,
                    "confirmation_status": "Confirmed",
                }
            ],
            "material_entries": [
                {
                    "material_entry_id": "JMT-1",
                    "item_name": "Trees",
                    "quantity": 7,
                    "billable": True,
                    "confirmation_status": "Confirmed",
                }
            ],
            "tables": {"xero_mappings": XERO_MAPPINGS},
        }
    )
    assert len(built["lines"]) == 3
    for line in built["lines"]:
        assert line["unit_sell"] == ""
        assert line["unit_sell_cents"] is None
        assert line["line_amount_ex_tax"] == ""
        assert line["rate_source_type"] == SOURCE_UNRESOLVED
        assert line["blockers"]
    assert built["unresolved_line_count"] == 3
    assert any("No active labour sell rate" in b for b in built["blockers"])
    assert any("No active machinery sell rate" in b for b in built["blockers"])
    assert any("No confirmed material catalog match" in b for b in built["blockers"])

    # Name similarity produces suggestions only — never an auto-applied price.
    suggested = build_financial_lines(
        {
            "job_date": "2026-07-16",
            "identity": {},
            "material_entries": [
                {
                    "material_entry_id": "JMT-1",
                    "item_name": "Trees",
                    "quantity": 7,
                    "billable": True,
                    "confirmation_status": "Confirmed",
                }
            ],
            "tables": {
                "material_catalog": [
                    {
                        "material_id": "MATC-T",
                        "item_code": "TREE",
                        "item_name": "Trees 45L",
                        "sell_price": "120.00",
                        "active": "TRUE",
                    }
                ],
                "xero_mappings": XERO_MAPPINGS,
            },
        }
    )
    assert suggested["lines"][0]["unit_sell"] == ""
    assert suggested["suggestions"][0]["suggested_matches"][0]["material_id"] == "MATC-T"


def test_non_billable_prices_zero_with_reason_and_travel_follows_flag() -> None:
    built = build_financial_lines(
        {
            "job_date": "2026-07-16",
            "identity": {"customer_id": "CUST-1"},
            "labour_entries": [
                _confirmed_labour(labour_id="LAB-NB", billable=False, travel_minutes=30),
                _confirmed_labour(labour_id="LAB-SUGGESTED", confirmation_status="Suggested"),
            ],
            "tables": {"labour_rates": [], "xero_mappings": XERO_MAPPINGS},
        }
    )
    # Suggested rows are never priced.
    assert len(built["lines"]) == 2
    labour, travel = built["lines"]
    assert labour["billable"] is False
    assert labour["unit_sell"] == "0.00"
    assert labour["line_amount_ex_tax"] == "0.00"
    assert labour["tax_amount"] == "0.00"
    assert labour["rate_source_type"] == SOURCE_NON_BILLABLE
    assert "non-billable" in labour["non_billable_reason"]
    assert labour["blockers"] == []
    assert travel["line_type"] == "travel"
    assert travel["quantity"] == 0.5
    assert travel["unit_sell"] == "0.00"
    assert built["subtotal_ex_tax"] == "0.00"

    # Billable travel needs a configured travel_rate; it is never assumed.
    billable_travel = build_financial_lines(
        {
            "job_date": "2026-07-16",
            "identity": {},
            "labour_entries": [_confirmed_labour(travel_minutes=30)],
            "tables": {
                "labour_rates": [
                    _labour_rate(labour_rate_id="LR-NOTRAVEL", staff_id="STAFF-1", travel_rate="")
                ],
                "xero_mappings": XERO_MAPPINGS,
            },
        }
    )
    travel_line = billable_travel["lines"][1]
    assert travel_line["unit_sell"] == ""
    assert any("no travel_rate configured" in b for b in travel_line["blockers"])


def test_snapshot_transition_matrix() -> None:
    assert snapshot_transition_allowed("Draft", "Validated") is True
    assert snapshot_transition_allowed("Validated", "Approved") is True
    assert snapshot_transition_allowed("Draft", "Approved") is False
    assert snapshot_transition_allowed("Approved", "Validated") is False
    assert snapshot_transition_allowed("Approved", "Superseded") is True
    assert snapshot_transition_allowed("Superseded", "Approved") is False


# ------------------------------------------------------------------- API


def _finalise_completion(
    client: TestClient, headers: dict[str, str], extra_materials: list[dict] | None = None
) -> dict:
    from app.core.config import get_settings
    from app.services.mock_store import MockStore

    store = MockStore(get_settings())
    store.update_job_status(
        JOB_ID,
        {
            "processing_status": "Completed",
            "approval_status": "Approved",
            "ai_summary": "Reshaped driveway and tidied beds.",
            "ai_transcript": "SECRET_TRANSCRIPT_SHOULD_NOT_LEAK",
            "drive_folder_id": "DRIVE_ID_SHOULD_NOT_LEAK",
            "customer_id": CUSTOMER_ID,
            "staff_id": STAFF_ID,
        },
    )
    generated = client.post(f"/api/v1/jobs/{JOB_ID}/completion/generate", headers=headers, json={})
    assert generated.status_code == 200, generated.text
    body = generated.json()
    completion = body["completion"]
    labour = body["labour_entries"]
    labour[0].update(
        {
            "confirmation_status": "Confirmed",
            "staff_id": STAFF_ID,
            "staff_name": "Alex Demo",
            "work_date": "2026-07-01",
            "start_time": "07:00",
            "finish_time": "15:00",
            "break_minutes": 30,
            "travel_minutes": 0,
            "billable": True,
        }
    )
    machinery = body.get("machinery_entries") or []
    for row in machinery:
        row.update({"duration_hours": 1.5, "confirmation_status": "Confirmed", "billable": True})
    materials = body.get("material_entries") or []
    for row in materials:
        row["confirmation_status"] = "Excluded"
    materials.extend(extra_materials or [])
    saved = client.patch(
        f"/api/v1/jobs/{JOB_ID}/completion",
        headers=headers,
        json={
            "expected_version": completion["version"],
            "work_summary": "Reshaped driveway.",
            "invoice_description": "Driveway reshape and site tidy.",
            "labour_entries": labour,
            "machinery_entries": machinery,
            "material_entries": materials,
            "warnings": [],
            "warning_resolutions": [],
        },
    )
    assert saved.status_code == 200, saved.text
    version = saved.json()["completion"]["version"]
    finalised = client.post(
        f"/api/v1/jobs/{JOB_ID}/completion/finalise",
        headers=headers,
        json={"expected_version": version, "override_reason": "Reviewed for pricing staging."},
    )
    assert finalised.status_code == 200, finalised.text
    return finalised.json()["completion"]


def _configure_test_rates(client: TestClient, headers: dict[str, str]) -> dict:
    """TEST-ONLY rate card and rates. Nothing here ships as production data."""
    card = client.post(
        "/api/v1/rate-cards",
        headers=headers,
        json={
            "card_name": "TEST RATE CARD — do not use in production",
            "effective_from": "2020-01-01",
        },
    )
    assert card.status_code == 200, card.text
    rate_card_id = card.json()["item"]["rate_card_id"]

    labour = client.post(
        "/api/v1/rates/labour",
        headers=headers,
        json={
            "rate_card_id": rate_card_id,
            "staff_id": STAFF_ID,
            "unit": "hour",
            "sell_rate": "85.00",
            "cost_rate": "45.00",
            "travel_rate": "60.00",
            "effective_from": "2020-01-01",
        },
    )
    assert labour.status_code == 200, labour.text

    machinery = client.post(
        "/api/v1/rates/machinery",
        headers=headers,
        json={
            "rate_card_id": rate_card_id,
            "equipment_name": "Earthmoving equipment",
            "unit": "hour",
            "sell_rate": "150.00",
            "effective_from": "2020-01-01",
        },
    )
    assert machinery.status_code == 200, machinery.text

    pricing = client.post(
        "/api/v1/pricing/customer",
        headers=headers,
        json={
            "customer_id": CUSTOMER_ID,
            "rate_card_id": rate_card_id,
            "effective_from": "2020-01-01",
        },
    )
    assert pricing.status_code == 200, pricing.text

    payroll = client.post(
        "/api/v1/mappings/payroll",
        headers=headers,
        json={
            "staff_id": STAFF_ID,
            "employee_reference": "TEST-EMP-1",
            "ordinary_hours_code": "ORD",
            "cost_centre": "TEST-CC",
            "effective_from": "2020-01-01",
        },
    )
    assert payroll.status_code == 200, payroll.text

    for mapping in (
        {"entity_type": "labour", "local_reference": "labour", "account_code": "200"},
        {"entity_type": "machinery", "local_reference": "machinery", "account_code": "220"},
        {"entity_type": "customer", "local_reference": CUSTOMER_ID, "account_code": "200"},
    ):
        created = client.post(
            "/api/v1/mappings/xero",
            headers=headers,
            json={**mapping, "tax_type": "OUTPUT", "tax_rate_percent": 10},
        )
        assert created.status_code == 200, created.text

    return {"rate_card_id": rate_card_id, "labour_rate_id": labour.json()["item"]["labour_rate_id"]}


def test_staff_cannot_reach_any_rates_endpoint(client: TestClient) -> None:
    staff = _staff_headers(client)
    reads = [
        "/api/v1/rate-cards",
        "/api/v1/rates/labour",
        "/api/v1/rates/machinery",
        "/api/v1/materials/catalog",
        "/api/v1/pricing/customer",
        "/api/v1/mappings/payroll",
        "/api/v1/mappings/xero",
        "/api/v1/completions/CMP-NOPE/pricing/readiness",
        "/api/v1/completions/CMP-NOPE/financial-snapshots",
        "/api/v1/financial-snapshots/CFS-NOPE",
    ]
    for path in reads:
        assert client.get(path, headers=staff).status_code == 403, path

    writes = [
        ("/api/v1/rate-cards", {"card_name": "Nope"}),
        ("/api/v1/rates/labour", {"sell_rate": "1.00"}),
        ("/api/v1/rates/machinery", {"sell_rate": "1.00"}),
        ("/api/v1/materials/catalog", {"item_name": "Nope", "sell_price": "1.00"}),
        ("/api/v1/pricing/customer", {"customer_id": "C", "rate_card_id": "R"}),
        ("/api/v1/mappings/payroll", {"staff_id": "S"}),
        ("/api/v1/mappings/xero", {"entity_type": "labour", "local_reference": "labour"}),
        ("/api/v1/completions/CMP-NOPE/financial-snapshots", {}),
        ("/api/v1/financial-snapshots/CFS-NOPE/validate", {}),
        ("/api/v1/financial-snapshots/CFS-NOPE/approve", {}),
        ("/api/v1/financial-snapshots/CFS-NOPE/supersede", {"reason": "nope"}),
    ]
    for path, payload in writes:
        assert client.post(path, headers=staff, json=payload).status_code == 403, path


def test_rate_crud_version_conflict_and_overlap(client: TestClient) -> None:
    headers = _manager_headers(client)
    configured = _configure_test_rates(client, headers)
    rate_card_id = configured["rate_card_id"]
    labour_rate_id = configured["labour_rate_id"]

    listed = client.get("/api/v1/rates/labour", headers=headers)
    assert listed.status_code == 200, listed.text
    assert listed.json()["overlaps"] == []
    item = listed.json()["items"][0]
    assert item["sell_rate"] == "85.00"
    assert item["status"] == "Active"
    assert item["version"] == 1

    conflict = client.patch(
        f"/api/v1/rates/labour/{labour_rate_id}",
        headers=headers,
        json={"sell_rate": "90.00", "expected_version": 999},
    )
    assert conflict.status_code == 409
    assert "Conflict" in conflict.json()["detail"]

    updated = client.patch(
        f"/api/v1/rates/labour/{labour_rate_id}",
        headers=headers,
        json={"sell_rate": "90.00", "expected_version": 1},
    )
    assert updated.status_code == 200, updated.text
    assert updated.json()["item"]["sell_rate"] == "90.00"
    assert updated.json()["item"]["version"] == 2

    overlap = client.post(
        "/api/v1/rates/labour",
        headers=headers,
        json={
            "rate_card_id": rate_card_id,
            "staff_id": STAFF_ID,
            "sell_rate": "99.00",
            "effective_from": "2021-01-01",
        },
    )
    assert overlap.status_code == 422
    assert "overlaps" in overlap.json()["detail"]

    bad_money = client.post(
        "/api/v1/rates/labour",
        headers=headers,
        json={"rate_card_id": rate_card_id, "staff_id": "STAFF-OTHER", "sell_rate": "eighty"},
    )
    assert bad_money.status_code == 422

    missing = client.patch(
        "/api/v1/rates/labour/LR-DOES-NOT-EXIST", headers=headers, json={"sell_rate": "10.00"}
    )
    assert missing.status_code == 404


def test_pricing_readiness_and_snapshot_lifecycle(client: TestClient) -> None:
    headers = _manager_headers(client)
    completion = _finalise_completion(client, headers)
    completion_id = completion["completion_id"]
    _configure_test_rates(client, headers)

    readiness = client.get(
        f"/api/v1/completions/{completion_id}/pricing/readiness", headers=headers
    )
    assert readiness.status_code == 200, readiness.text
    ready_body = readiness.json()
    assert ready_body["identity"]["customer_id"] == CUSTOMER_ID
    assert ready_body["invoice_pricing_ready"] is True, ready_body["invoice_blockers"]
    assert ready_body["payroll_mapping_ready"] is True, ready_body["payroll_blockers"]
    assert ready_body["pricing_status"] == "Ready"
    assert ready_body["totals_preview"]["subtotal_ex_tax"] == "862.50"
    assert ready_body["payroll_mappings"][0]["resolved"] is True

    created = client.post(
        f"/api/v1/completions/{completion_id}/financial-snapshots", headers=headers, json={}
    )
    assert created.status_code == 200, created.text
    snapshot = created.json()["financial_snapshot"]
    snapshot_id = snapshot["financial_snapshot_id"]
    assert snapshot["snapshot_status"] == "Draft"
    assert snapshot["pricing_status"] == "Ready"
    assert snapshot["subtotal_ex_tax"] == "862.50"
    assert snapshot["tax_amount"] == "86.25"
    assert snapshot["total_inc_tax"] == "948.75"
    assert snapshot["blockers"] == []
    assert snapshot["draft_reference"].startswith(f"DRAFT-INV-{completion_id}-")
    lines = created.json()["lines"]
    assert len(lines) == 2
    assert {line["line_type"] for line in lines} == {"labour", "machinery"}
    assert lines[0]["unit_sell"] == "85.00"
    assert lines[0]["rate_source_type"] == SOURCE_STAFF

    # Draft cannot jump straight to Approved.
    early = client.post(
        f"/api/v1/financial-snapshots/{snapshot_id}/approve", headers=headers, json={}
    )
    assert early.status_code == 422
    assert "cannot move financial snapshot from Draft to Approved" in early.json()["detail"]

    stale = client.post(
        f"/api/v1/financial-snapshots/{snapshot_id}/validate",
        headers=headers,
        json={"expected_version": 999},
    )
    assert stale.status_code == 409

    validated = client.post(
        f"/api/v1/financial-snapshots/{snapshot_id}/validate",
        headers=headers,
        json={"expected_version": snapshot["version"]},
    )
    assert validated.status_code == 200, validated.text
    validated_snapshot = validated.json()["financial_snapshot"]
    assert validated_snapshot["snapshot_status"] == "Validated"
    assert validated_snapshot["pricing_status"] == "Validated"

    approved = client.post(
        f"/api/v1/financial-snapshots/{snapshot_id}/approve",
        headers=headers,
        json={"expected_version": validated_snapshot["version"]},
    )
    assert approved.status_code == 200, approved.text
    approved_snapshot = approved.json()["financial_snapshot"]
    assert approved_snapshot["snapshot_status"] == "Approved"
    assert approved_snapshot["pricing_status"] == "Approved"

    immutable = client.post(
        f"/api/v1/financial-snapshots/{snapshot_id}/validate", headers=headers, json={}
    )
    assert immutable.status_code == 422
    assert "immutable" in immutable.json()["detail"]

    duplicate = client.post(
        f"/api/v1/completions/{completion_id}/financial-snapshots", headers=headers, json={}
    )
    assert duplicate.status_code == 409
    assert "already has an Approved financial snapshot" in duplicate.json()["detail"]

    superseded = client.post(
        f"/api/v1/financial-snapshots/{snapshot_id}/supersede",
        headers=headers,
        json={"reason": "Rate correction"},
    )
    assert superseded.status_code == 200, superseded.text
    assert superseded.json()["financial_snapshot"]["snapshot_status"] == "Superseded"

    recreated = client.post(
        f"/api/v1/completions/{completion_id}/financial-snapshots", headers=headers, json={}
    )
    assert recreated.status_code == 200, recreated.text
    assert recreated.json()["financial_snapshot"]["snapshot_status"] == "Draft"

    listed = client.get(
        f"/api/v1/completions/{completion_id}/financial-snapshots", headers=headers
    )
    assert listed.status_code == 200
    assert len(listed.json()["items"]) == 2

    fetched = client.get(f"/api/v1/financial-snapshots/{snapshot_id}", headers=headers)
    assert fetched.status_code == 200
    assert fetched.json()["financial_snapshot"]["financial_snapshot_id"] == snapshot_id
    assert client.get("/api/v1/financial-snapshots/CFS-MISSING", headers=headers).status_code == 404

    # Supersede requires a reason.
    assert (
        client.post(
            f"/api/v1/financial-snapshots/{snapshot_id}/supersede", headers=headers, json={}
        ).status_code
        == 422
    )


def test_material_prices_only_from_an_explicit_catalog_link(client: TestClient) -> None:
    headers = _manager_headers(client)
    catalog = client.post(
        "/api/v1/materials/catalog",
        headers=headers,
        json={
            "item_code": "TEST-MULCH",
            "item_name": "TEST Mulch 1m3",
            "unit": "m3",
            "sell_price": "62.50",
            "cost_price": "40.00",
        },
    )
    assert catalog.status_code == 200, catalog.text
    material_id = catalog.json()["item"]["material_id"]

    completion = _finalise_completion(
        client,
        headers,
        extra_materials=[
            {
                "item_name": "Mulch",
                "catalog_material_id": material_id,
                "quantity": 4,
                "unit": "m3",
                "billable": True,
                "confirmation_status": "Confirmed",
            },
            {
                "item_name": "Unlinked topsoil",
                "quantity": 2,
                "billable": True,
                "confirmation_status": "Confirmed",
            },
        ],
    )
    _configure_test_rates(client, headers)
    client.post(
        "/api/v1/mappings/xero",
        headers=headers,
        json={
            "entity_type": "material",
            "local_reference": "material",
            "account_code": "310",
            "tax_type": "OUTPUT",
            "tax_rate_percent": 10,
        },
    )

    created = client.post(
        f"/api/v1/completions/{completion['completion_id']}/financial-snapshots",
        headers=headers,
        json={},
    )
    assert created.status_code == 200, created.text
    lines = {line["description"]: line for line in created.json()["lines"]}
    linked = lines["Mulch"]
    assert linked["unit_sell"] == "62.50"
    assert linked["line_amount_ex_tax"] == "250.00"
    assert linked["material_id"] == material_id
    assert linked["rate_source_type"] == "material_catalog"
    assert linked["blockers"] == []

    unlinked = lines["Unlinked topsoil"]
    assert unlinked["unit_sell"] == ""
    assert any("No confirmed material catalog match" in b for b in unlinked["blockers"])
    assert created.json()["financial_snapshot"]["pricing_status"] == "Unresolved"


def test_snapshot_without_rates_stays_draft_and_never_prices_zero(client: TestClient) -> None:
    headers = _manager_headers(client)
    completion = _finalise_completion(client, headers)
    completion_id = completion["completion_id"]

    readiness = client.get(
        f"/api/v1/completions/{completion_id}/pricing/readiness", headers=headers
    )
    assert readiness.status_code == 200, readiness.text
    body = readiness.json()
    assert body["invoice_pricing_ready"] is False
    assert body["payroll_mapping_ready"] is False
    assert any("No active labour sell rate" in b for b in body["invoice_blockers"])
    assert body["pricing_status"] == "Unresolved"
    assert body["totals_preview"]["subtotal_ex_tax"] == "0.00"
    for sample in body["sample_rates"]:
        assert sample["unit_sell"] == ""
        assert sample["resolved"] is False

    created = client.post(
        f"/api/v1/completions/{completion_id}/financial-snapshots", headers=headers, json={}
    )
    assert created.status_code == 200, created.text
    snapshot = created.json()["financial_snapshot"]
    assert snapshot["pricing_status"] == "Unresolved"
    assert snapshot["blockers"]
    for line in created.json()["lines"]:
        # Unresolved is blank, never 0.00.
        assert line["unit_sell"] == ""
        assert line["line_amount_ex_tax"] == ""
        assert line["blockers"]

    validated = client.post(
        f"/api/v1/financial-snapshots/{snapshot['financial_snapshot_id']}/validate",
        headers=headers,
        json={"expected_version": snapshot["version"]},
    )
    assert validated.status_code == 200, validated.text
    assert validated.json()["financial_snapshot"]["snapshot_status"] == "Draft"
    assert validated.json()["financial_snapshot"]["blockers"]


def test_snapshot_payload_has_no_external_posting_markers(client: TestClient) -> None:
    headers = _manager_headers(client)
    completion = _finalise_completion(client, headers)
    completion_id = completion["completion_id"]
    _configure_test_rates(client, headers)

    created = client.post(
        f"/api/v1/completions/{completion_id}/financial-snapshots", headers=headers, json={}
    )
    assert created.status_code == 200, created.text
    text = created.text
    lowered = text.lower()

    # Phase 3E stages pricing only — nothing is posted to Xero or payroll.
    for marker in (
        "invoice_number",
        "invoice_id",
        "xero_invoice",
        "posted_at",
        "posted_by",
        "payment_status",
        "sent_to_xero",
    ):
        assert marker not in lowered, marker
    assert "DRAFT-INV-" in text
    assert created.json()["financial_snapshot"]["xero_reference"] == ""
    assert "SECRET_TRANSCRIPT" not in text
    assert "DRIVE_ID" not in text
    assert "Bearer" not in text
    assert "webhook_secret" not in lowered
    assert "$" not in text
