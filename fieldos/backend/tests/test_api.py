"""Basic API tests for Phase 1 (mock mode)."""

from __future__ import annotations

import io
from pathlib import Path

import pytest
from fastapi.testclient import TestClient


@pytest.fixture()
def client(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> TestClient:
    monkeypatch.setenv("DATA_MODE", "mock")
    monkeypatch.setenv("JWT_SECRET", "test-secret")
    monkeypatch.setenv("AUTH_USERS_FILE", str(tmp_path / "auth_users.json"))
    monkeypatch.setenv("MOCK_DATA_DIR", str(tmp_path / "mock"))
    monkeypatch.setenv("LOCAL_RECORDINGS_DIR", str(tmp_path / "recordings"))
    monkeypatch.setenv("DEMO_STAFF_EMAIL", "alex@nativegrace.com")
    monkeypatch.setenv("DEMO_STAFF_PASSWORD", "FieldOS-Demo-2026!")
    monkeypatch.setenv("APPS_SCRIPT_WEBAPP_URL", "")
    monkeypatch.setenv("APPS_SCRIPT_WEBHOOK_SECRET", "")

    from app.core.config import get_settings

    get_settings.cache_clear()

    from app.main import app

    with TestClient(app) as c:
        yield c

    get_settings.cache_clear()


def _login(client: TestClient) -> str:
    resp = client.post(
        "/api/v1/auth/login",
        json={"email": "alex@nativegrace.com", "password": "FieldOS-Demo-2026!"},
    )
    assert resp.status_code == 200, resp.text
    return resp.json()["access_token"]


def test_health(client: TestClient) -> None:
    resp = client.get("/api/v1/health")
    assert resp.status_code == 200
    assert resp.json()["status"] == "ok"


def test_ready(client: TestClient) -> None:
    resp = client.get("/api/v1/ready")
    assert resp.status_code == 200
    assert resp.json()["data_mode"] == "mock"


def test_login_and_my_jobs(client: TestClient) -> None:
    token = _login(client)
    resp = client.get("/api/v1/jobs/mine", headers={"Authorization": f"Bearer {token}"})
    assert resp.status_code == 200
    body = resp.json()
    assert body["days"] == 7
    assert len(body["items"]) >= 1
    # Jobs older than 7 days or other staff should be excluded from seed (JS-DEMO5 is day 10)
    ids = {j["job_sheet_id"] for j in body["items"]}
    assert "JS-DEMO5" not in ids


def test_job_detail_forbidden_for_other_staff(client: TestClient) -> None:
    token = _login(client)
    # JS-DEMO5 assigned to STAFF-OTHER in seed
    resp = client.get("/api/v1/jobs/JS-DEMO5", headers={"Authorization": f"Bearer {token}"})
    assert resp.status_code in (403, 404)


def test_upload_recording_and_process(client: TestClient) -> None:
    token = _login(client)
    jobs = client.get("/api/v1/jobs/mine", headers={"Authorization": f"Bearer {token}"}).json()["items"]
    job_id = jobs[0]["job_sheet_id"]

    audio = io.BytesIO(b"fake-webm-bytes-not-empty")
    resp = client.post(
        f"/api/v1/jobs/{job_id}/recordings",
        headers={"Authorization": f"Bearer {token}"},
        files={"file": ("note.webm", audio, "audio/webm")},
        data={"duration_seconds": "3.5", "trigger_processing": "true"},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["status"] == "Success"
    assert body["recording_id"]
    assert body["processing_triggered"] is True

    detail = client.get(f"/api/v1/jobs/{job_id}", headers={"Authorization": f"Bearer {token}"})
    assert detail.status_code == 200
    assert len(detail.json()["recordings"]) >= 1


def test_reject_empty_upload(client: TestClient) -> None:
    token = _login(client)
    jobs = client.get("/api/v1/jobs/mine", headers={"Authorization": f"Bearer {token}"}).json()["items"]
    job_id = jobs[0]["job_sheet_id"]
    resp = client.post(
        f"/api/v1/jobs/{job_id}/recordings",
        headers={"Authorization": f"Bearer {token}"},
        files={"file": ("empty.webm", io.BytesIO(b""), "audio/webm")},
        data={"duration_seconds": "0"},
    )
    assert resp.status_code == 400


def test_login_failure(client: TestClient) -> None:
    resp = client.post("/api/v1/auth/login", json={"email": "alex@nativegrace.com", "password": "wrong"})
    assert resp.status_code == 401
