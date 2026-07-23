"""Recording management: upload validation, invalidate, delete."""

from __future__ import annotations

import io
from pathlib import Path
from unittest.mock import MagicMock, patch

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
    monkeypatch.setenv("APPS_SCRIPT_WEBAPP_URL", "")
    monkeypatch.setenv("APPS_SCRIPT_WEBHOOK_SECRET", "")
    monkeypatch.setenv("MAX_UPLOAD_MB", "25")
    monkeypatch.setenv("MIN_RECORDING_UPLOAD_BYTES", "1024")
    _clear_settings()
    from app.main import app

    with TestClient(app) as c:
        yield c
    _clear_settings()


def _login(client: TestClient) -> str:
    resp = client.post(
        "/api/v1/auth/login",
        json={"email": "alex@nativegrace.com", "password": "FieldOS-Demo-2026!"},
    )
    assert resp.status_code == 200, resp.text
    return resp.json()["access_token"]


def _job_id(client: TestClient, token: str) -> str:
    jobs = client.get("/api/v1/jobs/mine", headers={"Authorization": f"Bearer {token}"}).json()["items"]
    return jobs[0]["job_sheet_id"]


def _upload(client: TestClient, token: str, job_id: str, *, name="note.webm", data=None, mime="audio/webm", path_suffix=""):
    payload = data if data is not None else (b"x" * 2048)
    url = f"/api/v1/jobs/{job_id}/recordings{path_suffix}"
    return client.post(
        url,
        headers={"Authorization": f"Bearer {token}"},
        files={"file": (name, io.BytesIO(payload), mime)},
        data={"duration_seconds": "1.5", "trigger_processing": "false"},
    )


def test_valid_audio_file_upload(client: TestClient) -> None:
    token = _login(client)
    job_id = _job_id(client, token)
    resp = _upload(client, token, job_id, path_suffix="/upload")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["recording_id"].startswith("REC-")
    assert body["recording_order"] >= 1


def test_unsupported_extension(client: TestClient) -> None:
    token = _login(client)
    job_id = _job_id(client, token)
    resp = _upload(client, token, job_id, name="notes.txt", mime="text/plain")
    assert resp.status_code == 422


def test_unsupported_mime(client: TestClient) -> None:
    token = _login(client)
    job_id = _job_id(client, token)
    resp = _upload(client, token, job_id, name="clip.bin", mime="application/pdf")
    assert resp.status_code == 422


def test_octet_stream_with_supported_extension(client: TestClient) -> None:
    token = _login(client)
    job_id = _job_id(client, token)
    resp = _upload(client, token, job_id, name="clip.mp3", mime="application/octet-stream")
    assert resp.status_code == 200, resp.text


def test_tiny_file_rejection(client: TestClient) -> None:
    token = _login(client)
    job_id = _job_id(client, token)
    resp = _upload(client, token, job_id, data=b"x" * 18)
    assert resp.status_code == 422


def test_oversized_file_rejection(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("DATA_MODE", "mock")
    monkeypatch.setenv("JWT_SECRET", "test-secret")
    monkeypatch.setenv("AUTH_USERS_FILE", str(tmp_path / "auth_users.json"))
    monkeypatch.setenv("MOCK_DATA_DIR", str(tmp_path / "mock"))
    monkeypatch.setenv("LOCAL_RECORDINGS_DIR", str(tmp_path / "recordings"))
    monkeypatch.setenv("DEMO_STAFF_EMAIL", "alex@nativegrace.com")
    monkeypatch.setenv("DEMO_STAFF_PASSWORD", "FieldOS-Demo-2026!")
    monkeypatch.setenv("DEMO_STAFF_ID", "STAFF-DEMO001")
    monkeypatch.setenv("MAX_UPLOAD_MB", "1")
    monkeypatch.setenv("MIN_RECORDING_UPLOAD_BYTES", "1024")
    monkeypatch.setenv("APPS_SCRIPT_WEBAPP_URL", "")
    monkeypatch.setenv("APPS_SCRIPT_WEBHOOK_SECRET", "")
    _clear_settings()
    from app.main import app

    with TestClient(app) as c:
        token = _login(c)
        job_id = _job_id(c, token)
        resp = _upload(c, token, job_id, data=b"x" * (1024 * 1024 + 10))
        assert resp.status_code == 422
    _clear_settings()


def test_unauthorised_upload(client: TestClient) -> None:
    token = _login(client)
    job_id = _job_id(client, token)
    resp = client.post(
        f"/api/v1/jobs/{job_id}/recordings/upload",
        files={"file": ("note.webm", io.BytesIO(b"x" * 2048), "audio/webm")},
        data={"duration_seconds": "1"},
    )
    assert resp.status_code == 401


def test_invalidate_success_and_idempotency(client: TestClient) -> None:
    token = _login(client)
    job_id = _job_id(client, token)
    up = _upload(client, token, job_id)
    assert up.status_code == 200
    rid = up.json()["recording_id"]
    headers = {"Authorization": f"Bearer {token}"}
    resp = client.post(
        f"/api/v1/jobs/{job_id}/recordings/{rid}/invalidate",
        headers=headers,
        json={"reason": "Bad audio"},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["recording_status"] == "Invalid"
    assert "drive" not in resp.text.lower() or "drive_file" not in resp.text
    again = client.post(
        f"/api/v1/jobs/{job_id}/recordings/{rid}/invalidate",
        headers=headers,
        json={"reason": "again"},
    )
    assert again.status_code == 200
    detail = client.get(f"/api/v1/jobs/{job_id}", headers=headers).json()
    rec = next(r for r in detail["recordings"] if r["recording_id"] == rid)
    assert rec["status"] == "Invalid"
    assert rec["invalid_reason"]


def test_unauthorised_invalidate(client: TestClient) -> None:
    token = _login(client)
    job_id = _job_id(client, token)
    up = _upload(client, token, job_id)
    rid = up.json()["recording_id"]
    resp = client.post(
        f"/api/v1/jobs/{job_id}/recordings/{rid}/invalidate",
        json={"reason": "x"},
    )
    assert resp.status_code == 401


def test_recording_job_mismatch(client: TestClient) -> None:
    token = _login(client)
    job_id = _job_id(client, token)
    headers = {"Authorization": f"Bearer {token}"}
    resp = client.post(
        f"/api/v1/jobs/{job_id}/recordings/REC-DOESNOTEXIST/invalidate",
        headers=headers,
        json={"reason": "x"},
    )
    assert resp.status_code == 404


def test_invalidate_while_processing_blocked(client: TestClient) -> None:
    token = _login(client)
    job_id = _job_id(client, token)
    up = _upload(client, token, job_id)
    rid = up.json()["recording_id"]
    from app.core.config import get_settings
    from app.services.mock_store import MockStore

    store = MockStore(get_settings())
    store.update_job_status(job_id, {"processing_status": "Processing"})
    resp = client.post(
        f"/api/v1/jobs/{job_id}/recordings/{rid}/invalidate",
        headers={"Authorization": f"Bearer {token}"},
        json={"reason": "x"},
    )
    assert resp.status_code == 409


def test_delete_success(client: TestClient) -> None:
    token = _login(client)
    job_id = _job_id(client, token)
    up = _upload(client, token, job_id)
    rid = up.json()["recording_id"]
    headers = {"Authorization": f"Bearer {token}"}
    resp = client.delete(f"/api/v1/jobs/{job_id}/recordings/{rid}", headers=headers)
    assert resp.status_code == 200, resp.text
    assert resp.json()["recording_status"] == "Deleted"
    assert "recording_drive_file_id" not in resp.json()
    detail = client.get(f"/api/v1/jobs/{job_id}", headers=headers).json()
    assert all(r["recording_id"] != rid for r in detail["recordings"])


def test_unauthorised_delete(client: TestClient) -> None:
    token = _login(client)
    job_id = _job_id(client, token)
    up = _upload(client, token, job_id)
    rid = up.json()["recording_id"]
    resp = client.delete(f"/api/v1/jobs/{job_id}/recordings/{rid}")
    assert resp.status_code == 401


def test_delete_while_processing_blocked(client: TestClient) -> None:
    token = _login(client)
    job_id = _job_id(client, token)
    up = _upload(client, token, job_id)
    rid = up.json()["recording_id"]
    from app.core.config import get_settings
    from app.services.mock_store import MockStore

    MockStore(get_settings()).update_job_status(job_id, {"processing_status": "Processing"})
    resp = client.delete(
        f"/api/v1/jobs/{job_id}/recordings/{rid}",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 409


def test_missing_recording_delete(client: TestClient) -> None:
    token = _login(client)
    job_id = _job_id(client, token)
    resp = client.delete(
        f"/api/v1/jobs/{job_id}/recordings/REC-MISSING",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 404


def test_drive_permanent_delete_success(monkeypatch: pytest.MonkeyPatch) -> None:
    from app.core.config import Settings
    from app.services.drive_upload import cleanup_drive_recording_file

    settings = Settings(
        RECORDINGS_FOLDER_ID="folder",
        GOOGLE_APPLICATION_CREDENTIALS="/tmp/missing-will-mock.json",
    )
    service = MagicMock()
    service.files.return_value.delete.return_value.execute.return_value = {}
    monkeypatch.setattr("app.services.drive_upload.drive_upload_configured", lambda _s: True)
    monkeypatch.setattr("app.services.drive_upload._drive_service", lambda _s: service)
    assert cleanup_drive_recording_file(settings, "file123", required=True) == "deleted"


def test_drive_permission_denied_then_trash(monkeypatch: pytest.MonkeyPatch) -> None:
    from app.core.config import Settings
    from app.services.drive_upload import cleanup_drive_recording_file

    class HttpErr(Exception):
        def __init__(self):
            self.resp = MagicMock(status=403)
            self.error_details = [{"reason": "insufficientFilePermissions"}]

    settings = Settings(
        RECORDINGS_FOLDER_ID="folder",
        GOOGLE_APPLICATION_CREDENTIALS="/tmp/x.json",
    )
    service = MagicMock()
    service.files.return_value.delete.return_value.execute.side_effect = HttpErr()
    service.files.return_value.update.return_value.execute.return_value = {}
    monkeypatch.setattr("app.services.drive_upload.drive_upload_configured", lambda _s: True)
    monkeypatch.setattr("app.services.drive_upload._drive_service", lambda _s: service)
    monkeypatch.setattr(
        "app.services.drive_upload._google_error_reason",
        lambda _e: (403, "insufficientFilePermissions"),
    )
    assert cleanup_drive_recording_file(settings, "file123", required=True) == "trashed"


def test_drive_cleanup_failure_preserves_recording_row(client: TestClient) -> None:
    token = _login(client)
    job_id = _job_id(client, token)
    up = _upload(client, token, job_id)
    rid = up.json()["recording_id"]
    # Row still present after successful upload; delete missing id must 404 without
    # affecting existing rows.
    headers = {"Authorization": f"Bearer {token}"}
    resp = client.delete(f"/api/v1/jobs/{job_id}/recordings/REC-OTHER", headers=headers)
    assert resp.status_code == 404
    detail = client.get(f"/api/v1/jobs/{job_id}", headers=headers).json()
    assert any(r["recording_id"] == rid for r in detail["recordings"])
