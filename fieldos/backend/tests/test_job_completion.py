"""Phase 3C job completion API tests (mock mode)."""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient


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


def _approve_demo_job(client: TestClient) -> str:
    headers = _manager_headers(client)
    job_id = "JS-DEMO001"
    # Enrich approved job content for draft extraction.
    from app.core.config import get_settings
    from app.services.mock_store import MockStore

    store = MockStore(get_settings())
    store.update_job_status(
        job_id,
        {
            "processing_status": "Completed",
            "approval_status": "Approved",
            "ai_summary": "Supply and planting of seven trees with earthworks to reshape the driveway.",
            "ai_transcript": "Planted seven trees. Had lunch. Actually no lunch today.",
            "manager_review_items": "Incomplete fragment about lunch.",
            "variations": "Driveway reshape",
            "staff_id": "STAFF-DEMO001",
        },
    )
    return job_id


def test_staff_cannot_generate_completion(client: TestClient) -> None:
    job_id = _approve_demo_job(client)
    response = client.post(
        f"/api/v1/jobs/{job_id}/completion/generate",
        headers=_staff_headers(client),
        json={},
    )
    assert response.status_code == 403


def test_manager_generate_save_finalise_reopen(client: TestClient) -> None:
    job_id = _approve_demo_job(client)
    headers = _manager_headers(client)

    generated = client.post(
        f"/api/v1/jobs/{job_id}/completion/generate",
        headers=headers,
        json={},
    )
    assert generated.status_code == 200, generated.text
    body = generated.json()
    assert body["completion"]["completion_status"] == "Draft"
    assert body["labour_entries"]
    assert any(m["quantity"] == 7 for m in body["material_entries"])
    # Client totals ignored — server recomputes.
    version = body["completion"]["version"]

    labour = body["labour_entries"]
    labour[0].update(
        {
            "start_time": "07:00",
            "finish_time": "15:00",
            "break_minutes": 30,
            "confirmation_status": "Confirmed",
            "billable": True,
            "travel_minutes": 20,
        }
    )
    machinery = body["machinery_entries"]
    for row in machinery:
        row.update({"duration_hours": 1.5, "confirmation_status": "Confirmed"})
    materials = body["material_entries"]
    for row in materials:
        row.update({"confirmation_status": "Confirmed"})

    patched = client.patch(
        f"/api/v1/jobs/{job_id}/completion",
        headers=headers,
        json={
            "expected_version": version,
            "work_summary": body["completion"]["work_summary"],
            "invoice_description": body["completion"]["invoice_description"],
            "labour_entries": labour,
            "machinery_entries": machinery,
            "material_entries": materials,
            "warnings": [],
            "total_labour_hours": 999,
        },
    )
    assert patched.status_code == 200, patched.text
    assert patched.json()["completion"]["total_labour_hours"] == 7.5
    assert patched.json()["completion"]["total_travel_hours"] == round(20 / 60, 2)
    version = patched.json()["completion"]["version"]

    stale = client.patch(
        f"/api/v1/jobs/{job_id}/completion",
        headers=headers,
        json={"expected_version": 1, "work_summary": "stale"},
    )
    assert stale.status_code == 409

    blocked = client.post(
        f"/api/v1/jobs/{job_id}/completion/finalise",
        headers=headers,
        json={"expected_version": version},
    )
    # May still need override for contradictory lunch warning depending on draft warnings retained.
    if blocked.status_code == 422:
        finalised = client.post(
            f"/api/v1/jobs/{job_id}/completion/finalise",
            headers=headers,
            json={"expected_version": version, "override_reason": "Reviewed lunch notes."},
        )
    else:
        finalised = blocked
    assert finalised.status_code == 200, finalised.text
    assert finalised.json()["completion"]["completion_status"] == "Finalised"
    version = finalised.json()["completion"]["version"]

    reopened = client.post(
        f"/api/v1/jobs/{job_id}/completion/reopen",
        headers=headers,
        json={"expected_version": version, "reopen_reason": "Adjust travel"},
    )
    assert reopened.status_code == 200, reopened.text
    assert reopened.json()["completion"]["completion_status"] == "Reopened"


def test_finalise_blocked_when_job_not_approved(client: TestClient) -> None:
    job_id = _approve_demo_job(client)
    headers = _manager_headers(client)
    generated = client.post(
        f"/api/v1/jobs/{job_id}/completion/generate",
        headers=headers,
        json={},
    ).json()
    from app.core.config import get_settings
    from app.services.mock_store import MockStore

    MockStore(get_settings()).update_job_status(job_id, {"approval_status": "Pending Review"})
    response = client.post(
        f"/api/v1/jobs/{job_id}/completion/finalise",
        headers=headers,
        json={"expected_version": generated["completion"]["version"]},
    )
    assert response.status_code == 422


def test_job_detail_is_independent_of_completion(client: TestClient) -> None:
    """Opening the job (GET /jobs/{id}) must not require or return completion data."""
    job_id = _approve_demo_job(client)
    headers = _manager_headers(client)

    detail = client.get(f"/api/v1/jobs/{job_id}", headers=headers)
    assert detail.status_code == 200, detail.text
    body = detail.json()
    assert "completion" not in body
    assert body["job"]["job_sheet_id"] == job_id

    # Completion lives behind its own endpoint and returns gracefully with no draft.
    completion = client.get(f"/api/v1/jobs/{job_id}/completion", headers=headers)
    assert completion.status_code == 200, completion.text
    assert completion.json()["completion"] is None


def test_completion_endpoint_returns_when_no_tables(client: TestClient) -> None:
    """Missing completion data must not error — returns an empty, fast response."""
    job_id = _approve_demo_job(client)
    response = client.get(f"/api/v1/jobs/{job_id}/completion", headers=_manager_headers(client))
    assert response.status_code == 200
    data = response.json()
    assert data["completion"] is None
    assert data["labour_entries"] == []
    assert data["can_generate"] is True


def test_staff_read_filters_labour(client: TestClient) -> None:
    job_id = _approve_demo_job(client)
    headers = _manager_headers(client)
    generated = client.post(
        f"/api/v1/jobs/{job_id}/completion/generate",
        headers=headers,
        json={},
    ).json()
    # Add another labour row for a different staff id.
    labour = generated["labour_entries"]
    labour.append(
        {
            "staff_id": "STAFF-OTHER",
            "staff_name": "Other",
            "work_date": "2026-07-22",
            "start_time": "08:00",
            "finish_time": "10:00",
            "break_minutes": 0,
            "travel_minutes": 0,
            "billable": False,
            "confirmation_status": "Confirmed",
        }
    )
    labour[0].update(
        {
            "start_time": "07:00",
            "finish_time": "15:00",
            "break_minutes": 0,
            "confirmation_status": "Confirmed",
        }
    )
    client.patch(
        f"/api/v1/jobs/{job_id}/completion",
        headers=headers,
        json={
            "expected_version": generated["completion"]["version"],
            "work_summary": "ok",
            "invoice_description": "ok",
            "labour_entries": labour,
            "machinery_entries": [],
            "material_entries": [],
            "warnings": [],
        },
    )
    staff_view = client.get(
        f"/api/v1/jobs/{job_id}/completion",
        headers=_staff_headers(client),
    )
    assert staff_view.status_code == 200, staff_view.text
    data = staff_view.json()
    assert all(row["staff_id"] == "STAFF-DEMO001" for row in data["labour_entries"])
    assert data["machinery_entries"] == []
    assert data["material_entries"] == []
    assert data["completion"]["internal_notes"] == ""
    assert data["can_edit"] is False


def test_blank_and_malformed_labour_errors_are_unique() -> None:
    from app.services.completion_math import compute_labour_entry, unique_messages, validate_for_finalise

    blank = compute_labour_entry({"start_time": "", "finish_time": "", "break_minutes": 0})
    assert blank["errors"] == ["Start time is required.", "Finish time is required."]
    assert blank["warnings"] == []

    malformed = compute_labour_entry({"start_time": "25:99", "finish_time": "noon", "break_minutes": 0})
    assert malformed["errors"] == [
        "Start time must use HH:MM.",
        "Finish time must use HH:MM.",
    ]
    assert not any("required" in e.lower() for e in malformed["errors"])

    job = {
        "approval_status": "Approved",
        "processing_status": "Completed",
    }
    gate = validate_for_finalise(
        {
            "completion_status": "Draft",
            "work_summary": "Work",
            "invoice_description": "Invoice",
            "warnings": [],
            "warning_resolutions": [],
            "labour_entries": [
                {
                    "start_time": "",
                    "finish_time": "",
                    "break_minutes": 0,
                    "confirmation_status": "Confirmed",
                }
            ],
            "machinery_entries": [],
            "material_entries": [],
        },
        job,
    )
    assert gate["ok"] is False
    assert len(gate["critical_errors"]) == len(unique_messages(gate["critical_errors"]))
    assert sum("Start time is required" in e for e in gate["critical_errors"]) == 1
    assert sum("Finish time is required" in e for e in gate["critical_errors"]) == 1
    assert not any("start_time and finish_time are required" in e for e in gate["critical_errors"])


def test_resolved_lunch_allows_finalise_unresolved_blocks() -> None:
    from app.services.completion_math import validate_for_finalise

    lunch = "Contradictory lunch information in source text — confirm unpaid break manually."
    job = {"approval_status": "Approved", "processing_status": "Completed"}
    base = {
        "completion_status": "Draft",
        "work_summary": "Planted trees",
        "invoice_description": "Seven trees",
        "warnings": [lunch],
        "labour_entries": [
            {
                "start_time": "07:00",
                "finish_time": "15:00",
                "break_minutes": 30,
                "confirmation_status": "Confirmed",
            }
        ],
        "machinery_entries": [],
        "material_entries": [],
    }
    blocked = validate_for_finalise({**base, "warning_resolutions": []}, job, override_reason="ignore")
    assert blocked["ok"] is False
    assert any("Resolve lunch/break contradiction" in e for e in blocked["critical_errors"])

    allowed = validate_for_finalise(
        {
            **base,
            "warning_resolutions": [
                {
                    "warning_key": "contradictory_lunch",
                    "warning_text": lunch,
                    "resolved": True,
                    "break_minutes": 30,
                    "resolution_note": "Confirmed unpaid break",
                }
            ],
        },
        job,
        override_reason="",
    )
    assert allowed["ok"] is True, allowed["critical_errors"]
    assert allowed["totals"]["total_labour_hours"] == 7.5


def test_invalid_arithmetic_cannot_be_overridden() -> None:
    from app.services.completion_math import validate_for_finalise

    gate = validate_for_finalise(
        {
            "completion_status": "Draft",
            "work_summary": "Planted trees",
            "invoice_description": "Seven trees",
            "warnings": [],
            "warning_resolutions": [],
            "labour_entries": [
                {
                    "start_time": "08:00",
                    "finish_time": "09:00",
                    "break_minutes": 90,
                    "confirmation_status": "Confirmed",
                }
            ],
            "machinery_entries": [],
            "material_entries": [],
        },
        {"approval_status": "Approved", "processing_status": "Completed"},
        override_reason="Please allow this",
    )
    assert gate["ok"] is False
    assert any("Break minutes cannot exceed" in e for e in gate["critical_errors"])
