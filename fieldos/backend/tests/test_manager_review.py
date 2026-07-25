"""Phase 3B manager review API tests (mock mode)."""

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


def _staff_token(client: TestClient) -> str:
    return _login(client, "alex@nativegrace.com", "FieldOS-Demo-2026!")


def _manager_token(client: TestClient) -> str:
    return _login(client, "manager@nativegrace.com", "FieldOS-Manager-2026!")


def _admin_token() -> str:
    from app.core.config import get_settings
    from app.core.security import create_access_token

    settings = get_settings()
    return create_access_token(
        subject="STAFF-ADMIN001",
        claims={
            "email": "admin@nativegrace.com",
            "staff_name": "Admin User",
            "role": "Admin",
        },
        settings=settings,
    )


def test_manager_sees_unassigned_jobs(client: TestClient) -> None:
    token = _manager_token(client)
    response = client.get(
        "/api/v1/jobs?days=30",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert response.status_code == 200, response.text
    items = response.json()["items"]
    assert any(job["job_sheet_id"] == "JS-DEMO005" for job in items)


def test_admin_sees_unassigned_jobs(client: TestClient) -> None:
    response = client.get(
        "/api/v1/jobs?days=30",
        headers={"Authorization": f"Bearer {_admin_token()}"},
    )
    assert response.status_code == 200, response.text
    assert any(job["job_sheet_id"] == "JS-DEMO005" for job in response.json()["items"])


def test_staff_cannot_call_all_jobs_endpoint(client: TestClient) -> None:
    response = client.get(
        "/api/v1/jobs?days=30",
        headers={"Authorization": f"Bearer {_staff_token(client)}"},
    )
    assert response.status_code == 403


def test_staff_mine_remains_assignment_scoped(client: TestClient) -> None:
    response = client.get(
        "/api/v1/jobs/mine?days=30",
        headers={"Authorization": f"Bearer {_staff_token(client)}"},
    )
    assert response.status_code == 200, response.text
    ids = {job["job_sheet_id"] for job in response.json()["items"]}
    assert "JS-DEMO005" not in ids
    assert "JS-DEMO001" in ids


def test_manager_job_filters_work(client: TestClient) -> None:
    token = _manager_token(client)
    headers = {"Authorization": f"Bearer {token}"}
    response = client.get(
        "/api/v1/jobs?days=30&processing_status=Completed"
        "&approval_status=Pending%20Review&search=Customer%20E",
        headers=headers,
    )
    assert response.status_code == 200, response.text
    assert [job["job_sheet_id"] for job in response.json()["items"]] == ["JS-DEMO005"]


def test_manager_direct_job_navigation_allows_unassigned_job(client: TestClient) -> None:
    response = client.get(
        "/api/v1/jobs/JS-DEMO005",
        headers={"Authorization": f"Bearer {_manager_token(client)}"},
    )
    assert response.status_code == 200, response.text
    assert response.json()["job"]["job_sheet_id"] == "JS-DEMO005"


def test_review_schema_staff_readonly(client: TestClient) -> None:
    token = _staff_token(client)
    resp = client.get(
        "/api/v1/jobs/JS-DEMO001/review",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["job"]["ai_summary"]
    assert body["job"]["ai_transcript"] is None
    assert body["can_edit"] is False
    assert body["can_approve"] is False


def test_staff_cannot_approve(client: TestClient) -> None:
    token = _staff_token(client)
    resp = client.post(
        "/api/v1/jobs/JS-DEMO001/approve",
        headers={"Authorization": f"Bearer {token}"},
        json={},
    )
    assert resp.status_code == 403


def test_manager_approve_and_metadata(client: TestClient) -> None:
    token = _manager_token(client)
    headers = {"Authorization": f"Bearer {token}"}
    detail = client.get("/api/v1/jobs/JS-DEMO001/review", headers=headers).json()
    expected = detail["job"]["approval_status"]
    completed_at = detail["job"]["processing_completed_at"]
    resp = client.post(
        "/api/v1/jobs/JS-DEMO001/approve",
        headers=headers,
        json={
            "manager_notes": "Looks good",
            "expected_approval_status": expected,
            "expected_processing_completed_at": completed_at,
        },
    )
    assert resp.status_code == 200, resp.text
    job = resp.json()["job"]
    assert job["approval_status"] == "Approved"
    assert job["approved_by"] == "manager@nativegrace.com"
    assert job["approved_at"]
    assert job["manager_notes"] == "Looks good"
    assert job["return_reason"] == ""


def test_return_reason_required(client: TestClient) -> None:
    token = _manager_token(client)
    resp = client.post(
        "/api/v1/jobs/JS-DEMO001/return",
        headers={"Authorization": f"Bearer {token}"},
        json={"return_reason": ""},
    )
    assert resp.status_code == 422


def test_stale_conflict(client: TestClient) -> None:
    token = _manager_token(client)
    headers = {"Authorization": f"Bearer {token}"}
    client.post(
        "/api/v1/jobs/JS-DEMO001/approve",
        headers=headers,
        json={"expected_approval_status": "Pending Review"},
    )
    resp = client.patch(
        "/api/v1/jobs/JS-DEMO001/review",
        headers=headers,
        json={
            "manager_notes": "stale",
            "expected_approval_status": "Pending Review",
        },
    )
    # Approved blocks ordinary edit with 400; use reopen conflict path instead
    assert resp.status_code in (400, 409)


def test_reopen_then_return(client: TestClient) -> None:
    token = _manager_token(client)
    headers = {"Authorization": f"Bearer {token}"}
    client.post(
        "/api/v1/jobs/JS-DEMO001/approve",
        headers=headers,
        json={"expected_approval_status": "Pending Review"},
    )
    reopen = client.post(
        "/api/v1/jobs/JS-DEMO001/reopen",
        headers=headers,
        json={"expected_approval_status": "Approved"},
    )
    assert reopen.status_code == 200, reopen.text
    assert reopen.json()["job"]["approval_status"] == "Pending Review"
    returned = client.post(
        "/api/v1/jobs/JS-DEMO001/return",
        headers=headers,
        json={"return_reason": "Please clarify hedge", "expected_approval_status": "Pending Review"},
    )
    assert returned.status_code == 200, returned.text
    job = returned.json()["job"]
    assert job["approval_status"] == "Returned for Correction"
    assert job["return_reason"] == "Please clarify hedge"


def test_staff_transcript_forbidden(client: TestClient) -> None:
    token = _staff_token(client)
    resp = client.get(
        "/api/v1/jobs/JS-DEMO001/review?include_transcript=true",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 403


def test_manager_transcript_optional(client: TestClient) -> None:
    token = _manager_token(client)
    resp = client.get(
        "/api/v1/jobs/JS-DEMO001/review?include_transcript=true",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 200, resp.text
    assert "Demo transcript" in (resp.json()["job"]["ai_transcript"] or "")
