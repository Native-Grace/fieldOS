"""Phase 3D completion dashboard + export batch API tests (mock mode)."""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.services.export_math import (
    CSV_HEADERS,
    EXPORT_INVOICE_CSV,
    EXPORT_SUMMARY_CSV,
    build_csv,
    compute_export_readiness,
    escape_csv_cell,
)


def _clear_settings():
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
    monkeypatch.setenv("DEMO_STAFF_ID", "STAFF-DEMO001")
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
    return {"Authorization": f"Bearer {_login(client, 'manager@nativegrace.com', 'FieldOS-Manager-2026!')}"}


def _staff_headers(client: TestClient) -> dict[str, str]:
    return {"Authorization": f"Bearer {_login(client, 'alex@nativegrace.com', 'FieldOS-Demo-2026!')}"}


def _prepare_finalised_completion(client: TestClient) -> dict:
    headers = _manager_headers(client)
    job_id = "JS-DEMO001"
    from app.core.config import get_settings
    from app.services.mock_store import MockStore

    store = MockStore(get_settings())
    store.update_job_status(
        job_id,
        {
            "processing_status": "Completed",
            "approval_status": "Approved",
            "ai_summary": "Planted trees and reshaped driveway.",
            "ai_transcript": "SECRET_TRANSCRIPT_SHOULD_NOT_EXPORT",
            "drive_folder_id": "DRIVE_ID_SHOULD_NOT_EXPORT",
            "variations": "Driveway reshape",
            "staff_id": "STAFF-DEMO001",
        },
    )
    generated = client.post(f"/api/v1/jobs/{job_id}/completion/generate", headers=headers, json={})
    assert generated.status_code == 200, generated.text
    body = generated.json()
    completion = body["completion"]
    labour = body["labour_entries"]
    labour[0].update(
        {
            "confirmation_status": "Confirmed",
            "staff_id": "STAFF-DEMO001",
            "staff_name": "Alex Demo",
            "work_date": "2026-07-01",
            "start_time": "07:00",
            "finish_time": "15:00",
            "break_minutes": 30,
            "travel_minutes": 20,
            "billable": True,
        }
    )
    machinery = body.get("machinery_entries") or []
    materials = body.get("material_entries") or []
    for row in machinery:
        row.update({"duration_hours": 1.5, "confirmation_status": "Confirmed"})
    for row in materials:
        row["confirmation_status"] = "Confirmed"
    saved = client.patch(
        f"/api/v1/jobs/{job_id}/completion",
        headers=headers,
        json={
            "expected_version": completion["version"],
            "work_summary": "Planted seven trees.",
            "invoice_description": "Supply and plant trees; reshape driveway.",
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
        f"/api/v1/jobs/{job_id}/completion/finalise",
        headers=headers,
        json={"expected_version": version},
    )
    if finalised.status_code == 422:
        finalised = client.post(
            f"/api/v1/jobs/{job_id}/completion/finalise",
            headers=headers,
            json={"expected_version": version, "override_reason": "Reviewed for export staging."},
        )
    assert finalised.status_code == 200, finalised.text
    return finalised.json()


def test_csv_formula_injection_protection() -> None:
    assert escape_csv_cell("=CMD()") == "'=CMD()"
    assert escape_csv_cell("+1+1") == "'+1+1"
    assert escape_csv_cell("-2+3") == "'-2+3"
    assert escape_csv_cell("@SUM(A1)") == "'@SUM(A1)"
    assert escape_csv_cell('say "hi", please') == '"say ""hi"", please"'
    csv = build_csv(["notes"], [{"notes": "=1+1"}])
    assert csv.startswith("notes\r\n'=1+1\r\n")
    assert "Rates not configured" not in "".join(CSV_HEADERS[EXPORT_SUMMARY_CSV])
    assert "pricing_status" in CSV_HEADERS[EXPORT_INVOICE_CSV]


def test_calendar_date_normalisation() -> None:
    from datetime import datetime, timezone

    from app.services.export_math import date_in_inclusive_range, normalise_calendar_date

    assert (
        normalise_calendar_date(datetime(2026, 7, 15, 14, 0, tzinfo=timezone.utc))
        == "2026-07-16"
    )
    assert (
        normalise_calendar_date(
            "Thu Jul 16 2026 00:00:00 GMT+1000 (Australian Eastern Standard Time)"
        )
        == "2026-07-16"
    )
    assert normalise_calendar_date("2026-07-26T10:25:20.645Z") == "2026-07-26"
    assert normalise_calendar_date("2026-07-16") == "2026-07-16"
    assert date_in_inclusive_range("2026-07-26", "2026-05-01", "2026-07-26") is True
    assert date_in_inclusive_range("2026-07-27", "2026-05-01", "2026-07-26") is False


def test_readiness_blockers_without_finalise() -> None:
    result = compute_export_readiness(
        {
            "completion_status": "Draft",
            "work_summary": "",
            "invoice_description": "",
            "warnings": [],
            "warning_resolutions": [],
        },
        {"approval_status": "Pending"},
        [{"confirmation_status": "Draft", "start_time": "07:00", "finish_time": "15:00"}],
        [],
        [],
    )
    assert result["invoice_ready"] is False
    assert any("Finalised" in b for b in result["invoice_blockers"])
    assert any("Approved" in b for b in result["invoice_blockers"])
    assert result["payroll_ready"] is False


def test_dashboard_includes_locale_and_date_object_job_dates(client: TestClient) -> None:
    headers = _manager_headers(client)
    payload = _prepare_finalised_completion(client)
    from app.core.config import get_settings
    from app.services.mock_store import MockStore

    store = MockStore(get_settings())
    store.update_job_status(
        "JS-DEMO001",
        {
            "date": "Thu Jul 16 2026 00:00:00 GMT+1000 (Australian Eastern Standard Time)",
        },
    )
    dash = client.get(
        "/api/v1/completions/dashboard",
        headers=headers,
        params={"date_from": "2026-05-01", "date_to": "2026-07-26"},
    )
    assert dash.status_code == 200, dash.text
    items = dash.json()["items"]
    assert any(i["completion_id"] == payload["completion"]["completion_id"] for i in items)
    row = next(i for i in items if i["completion_id"] == payload["completion"]["completion_id"])
    assert row["job_date"] == "2026-07-16"
    staff = _staff_headers(client)
    assert client.get("/api/v1/completions/dashboard", headers=staff).status_code == 403
    assert client.get("/api/v1/completions/dashboard/summary", headers=staff).status_code == 403
    assert client.get("/api/v1/exports", headers=staff).status_code == 403
    assert (
        client.post(
            "/api/v1/exports",
            headers=staff,
            json={"export_type": "Completion Summary CSV"},
        ).status_code
        == 403
    )


def test_dashboard_lists_finalised_completion(client: TestClient) -> None:
    payload = _prepare_finalised_completion(client)
    headers = _manager_headers(client)
    completion_id = payload["completion"]["completion_id"]
    dash = client.get(
        "/api/v1/completions/dashboard",
        headers=headers,
        params={"date_from": "2020-01-01", "date_to": "2030-12-31"},
    )
    assert dash.status_code == 200, dash.text
    body = dash.json()
    assert body["summary"]["job_count"] >= 1
    assert any(item["completion_id"] == completion_id for item in body["items"])
    assert "ai_transcript" not in dash.text
    assert "DRIVE_ID" not in dash.text
    summary = client.get(
        "/api/v1/completions/dashboard/summary",
        headers=headers,
        params={"date_from": "2020-01-01", "date_to": "2030-12-31"},
    )
    assert summary.status_code == 200
    assert "total_labour_hours" in summary.json()["summary"]
    ready = client.get(f"/api/v1/completions/{completion_id}/readiness", headers=headers)
    assert ready.status_code == 200
    readiness = ready.json()["readiness"]
    assert "invoice_blockers" in readiness
    assert "payroll_blockers" in readiness


def test_export_batch_lifecycle_and_download(client: TestClient) -> None:
    payload = _prepare_finalised_completion(client)
    headers = _manager_headers(client)
    completion_id = payload["completion"]["completion_id"]
    created = client.post(
        "/api/v1/exports",
        headers=headers,
        json={
            "export_type": "Completion Summary CSV",
            "date_from": "2020-01-01",
            "date_to": "2030-12-31",
            "completion_ids": [completion_id],
        },
    )
    assert created.status_code == 200, created.text
    batch = created.json()["export_batch"]
    batch_id = batch["export_batch_id"]
    assert batch["status"] == "Draft"
    assert len(created.json()["items"]) == 1

    validated = client.post(
        f"/api/v1/exports/{batch_id}/validate",
        headers=headers,
        json={"expected_version": batch["version"]},
    )
    assert validated.status_code == 200, validated.text
    assert validated.json()["export_batch"]["status"] == "Validated"

    generated = client.post(
        f"/api/v1/exports/{batch_id}/generate",
        headers=headers,
        json={"expected_version": validated.json()["export_batch"]["version"]},
    )
    assert generated.status_code == 200, generated.text
    exported = generated.json()["export_batch"]
    assert exported["status"] == "Exported"
    assert exported["file_name"].endswith(".csv")
    assert exported["checksum"]

    download = client.get(f"/api/v1/exports/{batch_id}/download", headers=headers)
    assert download.status_code == 200
    assert "text/csv" in download.headers["content-type"]
    assert "attachment" in download.headers["content-disposition"]
    assert exported["file_name"] in download.headers["content-disposition"]
    text = download.content.decode("utf-8")
    assert "job_sheet_id" in text
    assert "SECRET_TRANSCRIPT" not in text
    assert "DRIVE_ID" not in text
    assert "unit_cost" not in text.lower()
    assert "gst" not in text.lower()
    assert "Authorization" not in text
    assert "Bearer" not in text

    immutable = client.post(
        f"/api/v1/exports/{batch_id}/generate",
        headers=headers,
        json={"expected_version": exported["version"]},
    )
    assert immutable.status_code == 422

    stale = client.post(
        "/api/v1/exports",
        headers=headers,
        json={
            "export_type": "Completion Summary CSV",
            "date_from": "2020-01-01",
            "date_to": "2030-12-31",
            "completion_ids": [completion_id],
        },
    )
    assert stale.status_code == 200
    draft = stale.json()["export_batch"]
    conflict = client.post(
        f"/api/v1/exports/{draft['export_batch_id']}/validate",
        headers=headers,
        json={"expected_version": 999},
    )
    assert conflict.status_code == 409


def test_cancel_draft_batch(client: TestClient) -> None:
    payload = _prepare_finalised_completion(client)
    headers = _manager_headers(client)
    created = client.post(
        "/api/v1/exports",
        headers=headers,
        json={
            "export_type": "Payroll CSV",
            "date_from": "2020-01-01",
            "date_to": "2030-12-31",
            "completion_ids": [payload["completion"]["completion_id"]],
        },
    )
    assert created.status_code == 200
    batch = created.json()["export_batch"]
    cancelled = client.post(
        f"/api/v1/exports/{batch['export_batch_id']}/cancel",
        headers=headers,
        json={"expected_version": batch["version"]},
    )
    assert cancelled.status_code == 200
    assert cancelled.json()["export_batch"]["status"] == "Cancelled"


def test_invoice_csv_has_pricing_placeholder_not_money(client: TestClient) -> None:
    payload = _prepare_finalised_completion(client)
    headers = _manager_headers(client)
    created = client.post(
        "/api/v1/exports",
        headers=headers,
        json={
            "export_type": "Invoice CSV",
            "date_from": "2020-01-01",
            "date_to": "2030-12-31",
            "completion_ids": [payload["completion"]["completion_id"]],
        },
    )
    batch = created.json()["export_batch"]
    validated = client.post(
        f"/api/v1/exports/{batch['export_batch_id']}/validate",
        headers=headers,
        json={"expected_version": batch["version"]},
    )
    assert validated.status_code == 200, validated.text
    generated = client.post(
        f"/api/v1/exports/{batch['export_batch_id']}/generate",
        headers=headers,
        json={"expected_version": validated.json()["export_batch"]["version"]},
    )
    assert generated.status_code == 200, generated.text
    download = client.get(
        f"/api/v1/exports/{batch['export_batch_id']}/download",
        headers=headers,
    )
    text = download.content.decode("utf-8")
    assert "pricing_status" in text
    assert "Rates not configured" in text
    assert "invoice_number" not in text.lower()
    assert "$" not in text
