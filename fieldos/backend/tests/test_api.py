"""Phase 1 mock + Phase 2 Apps Script mode API tests (HTTP mocked)."""

from __future__ import annotations

import io
from pathlib import Path
from unittest.mock import AsyncMock, patch

import httpx
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


EXEC_URL = "https://script.google.com/macros/s/fake/exec"
USERCONTENT_URL = "https://script.googleusercontent.com/macros/echo?user_content_key=abc"
_RealAsyncClient = httpx.AsyncClient


def _mock_response(payload: dict, status_code: int = 200) -> httpx.Response:
    return httpx.Response(
        status_code,
        json=payload,
        request=httpx.Request("POST", EXEC_URL),
    )


def _patch_async_client(return_values):
    """Patch httpx.AsyncClient used inside AppsScriptClient._post."""
    values = list(return_values) if isinstance(return_values, (list, tuple)) else [return_values]
    mock_instance = AsyncMock()
    mock_instance.__aenter__.return_value = mock_instance
    mock_instance.__aexit__.return_value = False

    async def _post(*_args, **_kwargs):
        item = values.pop(0)
        if isinstance(item, Exception):
            raise item
        return item

    mock_instance.post = AsyncMock(side_effect=_post)

    def _factory(*_args, **kwargs):
        assert kwargs.get("follow_redirects") is True
        return mock_instance

    return patch("app.services.apps_script.httpx.AsyncClient", side_effect=_factory)


def _patch_async_client_transport(handler):
    """Use real httpx.AsyncClient + MockTransport so redirects are followed."""

    def _factory(*args, **kwargs):
        assert kwargs.get("follow_redirects") is True
        kwargs = {**kwargs, "transport": httpx.MockTransport(handler)}
        return _RealAsyncClient(*args, **kwargs)

    return patch("app.services.apps_script.httpx.AsyncClient", side_effect=_factory)


def _list_jobs_success_payload(
    job_sheet_id: str = "JS-REAL001",
    *,
    customer_name: str | None = "Acme",
    include_optional: bool = True,
) -> dict:
    job: dict = {
        "job_sheet_id": job_sheet_id,
        "job_date": "2026-07-17",
        "project_name": "PROJ-001",
        "processing_status": "Queued",
        "assigned_staff_id": "STAFF-9012C021",
    }
    if customer_name is not None:
        job["customer_name"] = customer_name
    if include_optional:
        job["approval_status"] = ""
        job["processing_error"] = ""
    return {
        "status": "Success",
        "action": "list_jobs_for_staff",
        "message": "OK",
        "record_id": None,
        "timestamp": "2026-07-18T00:00:00Z",
        "data": {"jobs": [job], "days": 7},
    }


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
    ids = {j["job_sheet_id"] for j in body["items"]}
    assert "JS-DEMO5" not in ids


def test_job_detail_forbidden_for_other_staff(client: TestClient) -> None:
    token = _login(client)
    resp = client.get("/api/v1/jobs/JS-DEMO5", headers={"Authorization": f"Bearer {token}"})
    assert resp.status_code in (403, 404)


def test_upload_recording_and_process(client: TestClient) -> None:
    token = _login(client)
    jobs = client.get("/api/v1/jobs/mine", headers={"Authorization": f"Bearer {token}"}).json()["items"]
    job_id = jobs[0]["job_sheet_id"]

    audio = io.BytesIO(b"x" * 2048)
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


def test_reject_tiny_webm_stub_upload(client: TestClient) -> None:
    """18-byte EBML shells must not reach Drive / tbl_recordings."""
    token = _login(client)
    jobs = client.get("/api/v1/jobs/mine", headers={"Authorization": f"Bearer {token}"}).json()["items"]
    job_id = jobs[0]["job_sheet_id"]
    resp = client.post(
        f"/api/v1/jobs/{job_id}/recordings",
        headers={"Authorization": f"Bearer {token}"},
        files={"file": ("tiny.webm", io.BytesIO(b"x" * 18), "audio/webm")},
        data={"duration_seconds": "1"},
    )
    assert resp.status_code == 422
    assert "no audio" in str(resp.json()["detail"]).lower() or "too small" in str(resp.json()["detail"]).lower()


def test_reject_bad_mime(client: TestClient) -> None:
    token = _login(client)
    jobs = client.get("/api/v1/jobs/mine", headers={"Authorization": f"Bearer {token}"}).json()["items"]
    job_id = jobs[0]["job_sheet_id"]
    resp = client.post(
        f"/api/v1/jobs/{job_id}/recordings",
        headers={"Authorization": f"Bearer {token}"},
        files={"file": ("note.txt", io.BytesIO(b"not-audio"), "text/plain")},
        data={"duration_seconds": "1"},
    )
    assert resp.status_code == 400


def test_reject_oversized_upload(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("DATA_MODE", "mock")
    monkeypatch.setenv("JWT_SECRET", "test-secret")
    monkeypatch.setenv("AUTH_USERS_FILE", str(tmp_path / "auth_users.json"))
    monkeypatch.setenv("MOCK_DATA_DIR", str(tmp_path / "mock"))
    monkeypatch.setenv("LOCAL_RECORDINGS_DIR", str(tmp_path / "recordings"))
    monkeypatch.setenv("DEMO_STAFF_EMAIL", "alex@nativegrace.com")
    monkeypatch.setenv("DEMO_STAFF_PASSWORD", "FieldOS-Demo-2026!")
    monkeypatch.setenv("DEMO_STAFF_ID", "STAFF-DEMO001")
    monkeypatch.setenv("MAX_UPLOAD_MB", "0")
    monkeypatch.setenv("APPS_SCRIPT_WEBAPP_URL", "")
    monkeypatch.setenv("APPS_SCRIPT_WEBHOOK_SECRET", "")
    _clear_settings()

    from app.main import app

    with TestClient(app) as c:
        token = _login(c)
        jobs = c.get("/api/v1/jobs/mine", headers={"Authorization": f"Bearer {token}"}).json()["items"]
        job_id = jobs[0]["job_sheet_id"]
        resp = c.post(
            f"/api/v1/jobs/{job_id}/recordings",
            headers={"Authorization": f"Bearer {token}"},
            files={"file": ("note.webm", io.BytesIO(b"x" * 2048), "audio/webm")},
            data={"duration_seconds": "1"},
        )
        assert resp.status_code == 400
    _clear_settings()


def test_login_failure(client: TestClient) -> None:
    resp = client.post("/api/v1/auth/login", json={"email": "alex@nativegrace.com", "password": "wrong"})
    assert resp.status_code == 401


@pytest.fixture()
def apps_script_env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("DATA_MODE", "apps_script")
    monkeypatch.setenv("JWT_SECRET", "test-secret")
    monkeypatch.setenv("AUTH_USERS_FILE", str(tmp_path / "auth_users.json"))
    monkeypatch.setenv("MOCK_DATA_DIR", str(tmp_path / "mock"))
    monkeypatch.setenv("LOCAL_RECORDINGS_DIR", str(tmp_path / "recordings"))
    monkeypatch.setenv("DEMO_STAFF_EMAIL", "alex@nativegrace.com")
    monkeypatch.setenv("DEMO_STAFF_PASSWORD", "FieldOS-Demo-2026!")
    monkeypatch.setenv("DEMO_STAFF_ID", "STAFF-9012C021")
    monkeypatch.setenv("APPS_SCRIPT_WEBAPP_URL", EXEC_URL)
    monkeypatch.setenv("APPS_SCRIPT_WEBHOOK_SECRET", "test-webhook-secret")
    monkeypatch.setenv("APPS_SCRIPT_TIMEOUT_SECONDS", "5")
    monkeypatch.setenv("JOB_ASSIGNMENT_COLUMN", "staff_id")
    monkeypatch.setenv("JOB_DATE_COLUMN", "date")
    monkeypatch.setenv("JOB_PROJECT_COLUMN", "project_id")
    monkeypatch.setenv("JOB_CUSTOMER_COLUMN", "customer_name")
    monkeypatch.setenv("JOBS_DEFAULT_DAYS", "7")
    monkeypatch.setenv("RECORDINGS_FOLDER_ID", "folder123")
    sa = tmp_path / "sa.json"
    sa.write_text("{}", encoding="utf-8")
    monkeypatch.setenv("GOOGLE_APPLICATION_CREDENTIALS", str(sa))
    monkeypatch.setenv("MAX_UPLOAD_MB", "25")
    _clear_settings()
    from app.main import app

    with TestClient(app) as c:
        yield c
    _clear_settings()


def test_apps_script_list_jobs_success(apps_script_env: TestClient) -> None:
    token = _login(apps_script_env)
    payload = _list_jobs_success_payload()
    with _patch_async_client([_mock_response(payload)]):
        resp = apps_script_env.get(
            "/api/v1/jobs/mine",
            headers={"Authorization": f"Bearer {token}"},
        )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["data_mode"] == "apps_script"
    assert body["items"][0]["job_sheet_id"] == "JS-REAL001"
    assert body["items"][0]["customer_name"] == "Acme"
    assert "test-webhook-secret" not in resp.text


def test_apps_script_list_jobs_mapping_payload(apps_script_env: TestClient) -> None:
    """Backend must send live sheet column names and authenticated staff_id."""
    token = _login(apps_script_env)
    captured: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        if request.method == "POST" and request.url.host == "script.google.com":
            import json as _json

            captured.update(_json.loads(request.content.decode("utf-8")))
            return httpx.Response(
                302,
                headers={"Location": USERCONTENT_URL},
                request=request,
            )
        return httpx.Response(
            200,
            json=_list_jobs_success_payload("21759f5d", customer_name=""),
            request=request,
        )

    with _patch_async_client_transport(handler):
        resp = apps_script_env.get(
            "/api/v1/jobs/mine",
            headers={"Authorization": f"Bearer {token}"},
        )
    assert resp.status_code == 200, resp.text
    assert captured["action"] == "list_jobs_for_staff"
    assert captured["staff_id"] == "STAFF-9012C021"
    assert captured["days"] == 7
    assert captured["assignment_column"] == "staff_id"
    assert captured["date_column"] == "date"
    assert captured["project_column"] == "project_id"
    assert captured["customer_column"] == "customer_name"
    assert captured["webhook_secret"] == "test-webhook-secret"
    assert "test-webhook-secret" not in resp.text
    item = resp.json()["items"][0]
    assert item["job_sheet_id"] == "21759f5d"
    assert item["customer_name"] == ""
    assert item["project_name"] == "PROJ-001"
    assert item["job_date"] == "2026-07-17"


def test_apps_script_list_jobs_blank_customer_and_missing_optional(apps_script_env: TestClient) -> None:
    token = _login(apps_script_env)
    payload = _list_jobs_success_payload("21759f5d", customer_name=None, include_optional=False)
    with _patch_async_client([_mock_response(payload)]):
        resp = apps_script_env.get(
            "/api/v1/jobs/mine",
            headers={"Authorization": f"Bearer {token}"},
        )
    assert resp.status_code == 200, resp.text
    item = resp.json()["items"][0]
    assert item["job_sheet_id"] == "21759f5d"
    assert item["customer_name"] == ""
    assert item["approval_status"] == ""
    assert item["processing_error"] == ""


def test_apps_script_follows_usercontent_redirect(apps_script_env: TestClient) -> None:
    """Google ContentService: script.google.com 302 → googleusercontent JSON 200."""
    token = _login(apps_script_env)
    payload = _list_jobs_success_payload("JS-REDIR001")
    seen_hosts: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen_hosts.append(request.url.host)
        if request.url.host == "script.google.com":
            body = request.content.decode("utf-8", errors="replace")
            assert "test-webhook-secret" in body  # secret sent on initial POST only
            assert request.method == "POST"
            return httpx.Response(
                302,
                headers={"Location": USERCONTENT_URL},
                request=request,
            )
        if request.url.host == "script.googleusercontent.com":
            return httpx.Response(200, json=payload, request=request)
        return httpx.Response(404, text="unexpected host", request=request)

    with _patch_async_client_transport(handler):
        resp = apps_script_env.get(
            "/api/v1/jobs/mine",
            headers={"Authorization": f"Bearer {token}"},
        )
    assert resp.status_code == 200, resp.text
    assert resp.json()["items"][0]["job_sheet_id"] == "JS-REDIR001"
    assert seen_hosts == ["script.google.com", "script.googleusercontent.com"]
    assert "test-webhook-secret" not in resp.text


def test_apps_script_final_200_json(apps_script_env: TestClient) -> None:
    token = _login(apps_script_env)
    payload = _list_jobs_success_payload("JS-DIRECT200")

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=payload, request=request)

    with _patch_async_client_transport(handler):
        resp = apps_script_env.get(
            "/api/v1/jobs/mine",
            headers={"Authorization": f"Bearer {token}"},
        )
    assert resp.status_code == 200
    assert resp.json()["items"][0]["job_sheet_id"] == "JS-DIRECT200"


def test_apps_script_redirect_loop(apps_script_env: TestClient) -> None:
    token = _login(apps_script_env)

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            302,
            headers={"Location": str(request.url)},
            request=request,
        )

    with _patch_async_client_transport(handler):
        resp = apps_script_env.get(
            "/api/v1/jobs/mine",
            headers={"Authorization": f"Bearer {token}"},
        )
    assert resp.status_code == 502
    assert "redirect" in resp.json()["detail"].lower()
    assert "test-webhook-secret" not in resp.text


def test_apps_script_redirect_to_non_json(apps_script_env: TestClient) -> None:
    token = _login(apps_script_env)

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.host == "script.google.com":
            return httpx.Response(
                302,
                headers={"Location": USERCONTENT_URL},
                request=request,
            )
        return httpx.Response(200, text="<html>oops</html>", request=request)

    with _patch_async_client_transport(handler):
        resp = apps_script_env.get(
            "/api/v1/jobs/mine",
            headers={"Authorization": f"Bearer {token}"},
        )
    assert resp.status_code == 502
    assert "Invalid Apps Script response" in resp.json()["detail"]
    assert "test-webhook-secret" not in resp.text


def test_apps_script_invalid_response(apps_script_env: TestClient) -> None:
    token = _login(apps_script_env)
    bad = httpx.Response(200, text="not-json", request=httpx.Request("POST", EXEC_URL))
    with _patch_async_client([bad]):
        resp = apps_script_env.get(
            "/api/v1/jobs/mine",
            headers={"Authorization": f"Bearer {token}"},
        )
    assert resp.status_code == 502
    assert "test-webhook-secret" not in resp.text


def test_apps_script_timeout(apps_script_env: TestClient) -> None:
    token = _login(apps_script_env)
    with _patch_async_client([httpx.TimeoutException("timeout")]):
        resp = apps_script_env.get(
            "/api/v1/jobs/mine",
            headers={"Authorization": f"Bearer {token}"},
        )
    assert resp.status_code == 504
    assert "test-webhook-secret" not in resp.text


def test_apps_script_auth_failure(apps_script_env: TestClient) -> None:
    token = _login(apps_script_env)
    payload = {
        "status": "Error",
        "action": "list_jobs_for_staff",
        "message": "Unauthorized: Invalid or missing webhook_secret.",
        "record_id": None,
        "timestamp": "2026-07-18T00:00:00Z",
    }
    with _patch_async_client([_mock_response(payload)]):
        resp = apps_script_env.get(
            "/api/v1/jobs/mine",
            headers={"Authorization": f"Bearer {token}"},
        )
    assert resp.status_code == 502
    assert "test-webhook-secret" not in resp.text
    assert "webhook_secret" in resp.json()["detail"].lower()  # Apps Script error text only


def test_apps_script_unauthorised_job(apps_script_env: TestClient) -> None:
    token = _login(apps_script_env)
    payload = {
        "status": "Error",
        "action": "get_job_detail",
        "message": "Forbidden: Job is not assigned to this staff member.",
        "record_id": "JS-OTHER",
        "timestamp": "2026-07-18T00:00:00Z",
    }
    with _patch_async_client([_mock_response(payload)]):
        resp = apps_script_env.get(
            "/api/v1/jobs/JS-OTHER",
            headers={"Authorization": f"Bearer {token}"},
        )
    assert resp.status_code == 403


def test_apps_script_process_success(apps_script_env: TestClient) -> None:
    token = _login(apps_script_env)
    detail_payload = {
        "status": "Success",
        "action": "get_job_detail",
        "message": "OK",
        "record_id": "JS-REAL001",
        "data": {
            "job": {
                "job_sheet_id": "JS-REAL001",
                "job_date": "2026-07-17",
                "project_name": "Site A",
                "customer_name": "Acme",
                "processing_status": "",
                "assigned_staff_id": "STAFF-DEMO001",
            },
            "recordings": [],
        },
    }
    process_payload = {
        "status": "Success",
        "action": "process_voice_dictation",
        "message": "Job successfully queued.",
        "record_id": "JS-REAL001",
        "timestamp": "2026-07-18T00:00:00Z",
    }
    with _patch_async_client([_mock_response(detail_payload), _mock_response(process_payload)]):
        resp = apps_script_env.post(
            "/api/v1/jobs/JS-REAL001/process",
            headers={"Authorization": f"Bearer {token}"},
            json={"force_reprocess": False},
        )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["status"] == "Success"
    assert "queued" in body["message"].lower()


def test_apps_script_process_failure(apps_script_env: TestClient) -> None:
    token = _login(apps_script_env)
    detail_payload = {
        "status": "Success",
        "action": "get_job_detail",
        "message": "OK",
        "data": {
            "job": {
                "job_sheet_id": "JS-REAL001",
                "job_date": "2026-07-17",
                "project_name": "Site A",
                "customer_name": "Acme",
                "processing_status": "Completed",
                "assigned_staff_id": "STAFF-DEMO001",
            },
            "recordings": [],
        },
    }
    process_payload = {
        "status": "Error",
        "action": "process_voice_dictation",
        "message": "Error: something failed",
        "record_id": "JS-REAL001",
    }
    with _patch_async_client([_mock_response(detail_payload), _mock_response(process_payload)]):
        resp = apps_script_env.post(
            "/api/v1/jobs/JS-REAL001/process",
            headers={"Authorization": f"Bearer {token}"},
            json={"force_reprocess": False},
        )
    assert resp.status_code == 200
    assert resp.json()["status"] == "Error"


def test_apps_script_recording_requires_drive(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("DATA_MODE", "apps_script")
    monkeypatch.setenv("JWT_SECRET", "test-secret")
    monkeypatch.setenv("AUTH_USERS_FILE", str(tmp_path / "auth_users.json"))
    monkeypatch.setenv("MOCK_DATA_DIR", str(tmp_path / "mock"))
    monkeypatch.setenv("LOCAL_RECORDINGS_DIR", str(tmp_path / "recordings"))
    monkeypatch.setenv("DEMO_STAFF_EMAIL", "alex@nativegrace.com")
    monkeypatch.setenv("DEMO_STAFF_PASSWORD", "FieldOS-Demo-2026!")
    monkeypatch.setenv("DEMO_STAFF_ID", "STAFF-DEMO001")
    monkeypatch.setenv("APPS_SCRIPT_WEBAPP_URL", EXEC_URL)
    monkeypatch.setenv("APPS_SCRIPT_WEBHOOK_SECRET", "test-webhook-secret")
    monkeypatch.setenv("RECORDINGS_FOLDER_ID", "")
    monkeypatch.setenv("GOOGLE_APPLICATION_CREDENTIALS", "")
    _clear_settings()

    detail_payload = {
        "status": "Success",
        "action": "get_job_detail",
        "message": "OK",
        "data": {
            "job": {
                "job_sheet_id": "JS-REAL001",
                "job_date": "2026-07-17",
                "project_name": "Site A",
                "customer_name": "Acme",
                "processing_status": "",
                "assigned_staff_id": "STAFF-DEMO001",
            },
            "recordings": [],
        },
    }

    from app.main import app

    with TestClient(app) as c:
        token = _login(c)
        with _patch_async_client([_mock_response(detail_payload)]):
            resp = c.post(
                "/api/v1/jobs/JS-REAL001/recordings",
                headers={"Authorization": f"Bearer {token}"},
                files={"file": ("note.webm", io.BytesIO(b"x" * 2048), "audio/webm")},
                data={"duration_seconds": "1", "trigger_processing": "false"},
            )
        assert resp.status_code == 503
    _clear_settings()
