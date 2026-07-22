"""Drive upload + register_recording path tests (Google API mocked)."""

from __future__ import annotations

import io
import json
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

from app.core.config import Settings
from app.services.drive_upload import DRIVE_SCOPE, delete_drive_file, upload_recording_to_drive


def _clear_settings():
    from app.core.config import get_settings

    get_settings.cache_clear()


def _settings(tmp_path: Path, *, folder: str = "folder123", creds: Path | None = None) -> Settings:
    if creds is None:
        creds = tmp_path / "sa.json"
        creds.write_text("{}", encoding="utf-8")
    return Settings(
        DATA_MODE="apps_script",
        RECORDINGS_FOLDER_ID=folder,
        GOOGLE_APPLICATION_CREDENTIALS=str(creds),
        JWT_SECRET="test",
    )


def test_drive_scope_is_full_drive() -> None:
    assert DRIVE_SCOPE == "https://www.googleapis.com/auth/drive"
    assert DRIVE_SCOPE.endswith("/drive")
    assert "drive.file" not in DRIVE_SCOPE
    assert "drive.readonly" not in DRIVE_SCOPE


def test_drive_service_uses_full_drive_scope(tmp_path: Path) -> None:
    settings = _settings(tmp_path)
    with patch("google.oauth2.service_account.Credentials.from_service_account_file") as from_file:
        with patch("googleapiclient.discovery.build") as build:
            from_file.return_value = MagicMock()
            build.return_value = MagicMock()
            from app.services.drive_upload import _drive_service

            _drive_service(settings)
    assert from_file.call_args.kwargs["scopes"] == ["https://www.googleapis.com/auth/drive"]
    assert build.call_args.args[0] == "drive"
    assert build.call_args.args[1] == "v3"


def test_upload_missing_folder_id(tmp_path: Path) -> None:
    settings = _settings(tmp_path, folder="")
    with pytest.raises(HTTPException) as exc:
        upload_recording_to_drive(settings, filename="a.webm", data=b"abc", mime_type="audio/webm")
    assert exc.value.status_code == 503


def test_upload_missing_credentials_path(tmp_path: Path) -> None:
    settings = Settings(
        DATA_MODE="apps_script",
        RECORDINGS_FOLDER_ID="folder123",
        GOOGLE_APPLICATION_CREDENTIALS=str(tmp_path / "missing.json"),
        JWT_SECRET="test",
    )
    with pytest.raises(HTTPException) as exc:
        upload_recording_to_drive(settings, filename="a.webm", data=b"abc", mime_type="audio/webm")
    assert exc.value.status_code == 503
    assert "not found" in exc.value.detail.lower()


def _http_error(status_code: int, reason: str) -> Exception:
    """Build a googleapiclient-like HttpError stand-in."""

    class _Resp:
        def __init__(self, status: int):
            self.status = status

    class _HttpError(Exception):
        def __init__(self):
            self.resp = _Resp(status_code)
            self.content = json.dumps(
                {"error": {"code": status_code, "errors": [{"reason": reason}]}}
            ).encode()
            super().__init__(f"<{status_code} when requesting ... returned {reason}>")

    return _HttpError()


def test_shared_drive_upload_success_uses_supports_all_drives(tmp_path: Path) -> None:
    settings = _settings(tmp_path, folder="shared-folder-1")
    mock_service = MagicMock()
    mock_service.files.return_value.get.return_value.execute.return_value = {
        "id": "shared-folder-1",
        "name": "Recordings",
        "mimeType": "application/vnd.google-apps.folder",
        "driveId": "shared-drive-1",
    }
    mock_service.files.return_value.create.return_value.execute.return_value = {
        "id": "drive-file-1",
        "webViewLink": "https://drive.google.com/file/d/drive-file-1/view",
    }
    with patch("app.services.drive_upload._drive_service", return_value=mock_service):
        with patch("googleapiclient.http.MediaInMemoryUpload"):
            out = upload_recording_to_drive(
                settings, filename="note.webm", data=b"audio-bytes", mime_type="audio/webm"
            )
    assert out["recording_drive_file_id"] == "drive-file-1"
    get_kwargs = mock_service.files.return_value.get.call_args.kwargs
    assert get_kwargs["fileId"] == "shared-folder-1"
    assert get_kwargs["supportsAllDrives"] is True
    create_kwargs = mock_service.files.return_value.create.call_args.kwargs
    assert create_kwargs["supportsAllDrives"] is True
    assert create_kwargs["body"]["parents"] == ["shared-folder-1"]
    assert create_kwargs["body"]["name"] == "note.webm"
    # Must never upload to SA My Drive root (empty parents)
    assert create_kwargs["body"]["parents"]


def test_delete_uses_supports_all_drives(tmp_path: Path) -> None:
    settings = _settings(tmp_path)
    mock_service = MagicMock()
    with patch("app.services.drive_upload._drive_service", return_value=mock_service):
        delete_drive_file(settings, "drive-file-1")
    mock_service.files.return_value.delete.assert_called_once_with(
        fileId="drive-file-1", supportsAllDrives=True
    )


def test_delete_falls_back_to_trash_on_not_found(tmp_path: Path) -> None:
    settings = _settings(tmp_path)
    mock_service = MagicMock()
    mock_service.files.return_value.delete.return_value.execute.side_effect = _http_error(
        404, "notFound"
    )
    with patch("app.services.drive_upload._drive_service", return_value=mock_service):
        delete_drive_file(settings, "drive-file-1")
    mock_service.files.return_value.delete.assert_called_once_with(
        fileId="drive-file-1", supportsAllDrives=True
    )
    update_kwargs = mock_service.files.return_value.update.call_args.kwargs
    assert update_kwargs["fileId"] == "drive-file-1"
    assert update_kwargs["supportsAllDrives"] is True
    assert update_kwargs["body"] == {"trashed": True}


def test_storage_quota_exceeded_is_config_error(tmp_path: Path) -> None:
    settings = _settings(tmp_path)
    mock_service = MagicMock()
    mock_service.files.return_value.get.return_value.execute.return_value = {
        "id": "folder123",
        "mimeType": "application/vnd.google-apps.folder",
    }
    mock_service.files.return_value.create.return_value.execute.side_effect = _http_error(
        403, "storageQuotaExceeded"
    )
    with patch("app.services.drive_upload._drive_service", return_value=mock_service):
        with patch("googleapiclient.http.MediaInMemoryUpload"):
            with pytest.raises(HTTPException) as exc:
                upload_recording_to_drive(
                    settings, filename="note.webm", data=b"audio-bytes", mime_type="audio/webm"
                )
    assert exc.value.status_code == 503
    assert "storageQuotaExceeded" in exc.value.detail
    assert "Shared Drive" in exc.value.detail
    assert "private_key" not in exc.value.detail.lower()


def test_folder_not_found(tmp_path: Path) -> None:
    settings = _settings(tmp_path)
    mock_service = MagicMock()
    mock_service.files.return_value.get.return_value.execute.side_effect = _http_error(404, "notFound")
    with patch("app.services.drive_upload._drive_service", return_value=mock_service):
        with pytest.raises(HTTPException) as exc:
            upload_recording_to_drive(
                settings, filename="note.webm", data=b"audio-bytes", mime_type="audio/webm"
            )
    assert exc.value.status_code == 503
    assert "not found" in exc.value.detail.lower()


def test_insufficient_permissions(tmp_path: Path) -> None:
    settings = _settings(tmp_path)
    mock_service = MagicMock()
    mock_service.files.return_value.get.return_value.execute.side_effect = _http_error(
        403, "insufficientFilePermissions"
    )
    with patch("app.services.drive_upload._drive_service", return_value=mock_service):
        with pytest.raises(HTTPException) as exc:
            upload_recording_to_drive(
                settings, filename="note.webm", data=b"audio-bytes", mime_type="audio/webm"
            )
    assert exc.value.status_code == 503
    assert "permission" in exc.value.detail.lower()


def test_upload_permission_failure_mocked(tmp_path: Path) -> None:
    settings = _settings(tmp_path)
    mock_service = MagicMock()
    mock_service.files.return_value.get.return_value.execute.return_value = {"id": "folder123"}
    mock_service.files.return_value.create.return_value.execute.side_effect = RuntimeError(
        "forbidden"
    )
    with patch("app.services.drive_upload._drive_service", return_value=mock_service):
        with patch("googleapiclient.http.MediaInMemoryUpload"):
            with pytest.raises(HTTPException) as exc:
                upload_recording_to_drive(
                    settings, filename="note.webm", data=b"audio-bytes", mime_type="audio/webm"
                )
    assert exc.value.status_code in (502, 503)
    assert "private_key" not in str(exc.value.detail).lower()


def test_delete_drive_file_best_effort(tmp_path: Path) -> None:
    settings = _settings(tmp_path)
    mock_service = MagicMock()
    with patch("app.services.drive_upload._drive_service", return_value=mock_service):
        delete_drive_file(settings, "drive-file-1")
    mock_service.files.return_value.delete.assert_called_once_with(
        fileId="drive-file-1", supportsAllDrives=True
    )

@pytest.fixture()
def apps_script_drive_env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    sa = tmp_path / "sa.json"
    sa.write_text("{}", encoding="utf-8")
    monkeypatch.setenv("DATA_MODE", "apps_script")
    monkeypatch.setenv("JWT_SECRET", "test-secret")
    monkeypatch.setenv("AUTH_USERS_FILE", str(tmp_path / "auth_users.json"))
    monkeypatch.setenv("MOCK_DATA_DIR", str(tmp_path / "mock"))
    monkeypatch.setenv("LOCAL_RECORDINGS_DIR", str(tmp_path / "recordings"))
    monkeypatch.setenv("DEMO_STAFF_EMAIL", "alex@nativegrace.com")
    monkeypatch.setenv("DEMO_STAFF_PASSWORD", "FieldOS-Demo-2026!")
    monkeypatch.setenv("DEMO_STAFF_ID", "STAFF-9012C021")
    monkeypatch.setenv("APPS_SCRIPT_WEBAPP_URL", "https://script.google.com/macros/s/fake/exec")
    monkeypatch.setenv("APPS_SCRIPT_WEBHOOK_SECRET", "test-webhook-secret")
    monkeypatch.setenv("JOB_ASSIGNMENT_COLUMN", "staff_id")
    monkeypatch.setenv("JOB_DATE_COLUMN", "date")
    monkeypatch.setenv("JOB_PROJECT_COLUMN", "project_id")
    monkeypatch.setenv("JOB_CUSTOMER_COLUMN", "customer_name")
    monkeypatch.setenv("RECORDINGS_FOLDER_ID", "folder123")
    monkeypatch.setenv("GOOGLE_APPLICATION_CREDENTIALS", str(sa))
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
    assert resp.status_code == 200
    return resp.json()["access_token"]


def _detail_ok() -> dict:
    return {
        "status": "Success",
        "action": "get_job_detail",
        "message": "OK",
        "data": {
            "job": {
                "job_sheet_id": "21759f5d",
                "job_date": "2026-07-16",
                "project_name": "PROJ-1",
                "customer_name": "",
                "processing_status": "",
                "assigned_staff_id": "STAFF-9012C021",
            },
            "recordings": [],
        },
    }


def test_api_missing_credentials(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("DATA_MODE", "apps_script")
    monkeypatch.setenv("JWT_SECRET", "test-secret")
    monkeypatch.setenv("AUTH_USERS_FILE", str(tmp_path / "auth_users.json"))
    monkeypatch.setenv("MOCK_DATA_DIR", str(tmp_path / "mock"))
    monkeypatch.setenv("LOCAL_RECORDINGS_DIR", str(tmp_path / "recordings"))
    monkeypatch.setenv("DEMO_STAFF_EMAIL", "alex@nativegrace.com")
    monkeypatch.setenv("DEMO_STAFF_PASSWORD", "FieldOS-Demo-2026!")
    monkeypatch.setenv("DEMO_STAFF_ID", "STAFF-9012C021")
    monkeypatch.setenv("APPS_SCRIPT_WEBAPP_URL", "https://script.google.com/macros/s/fake/exec")
    monkeypatch.setenv("APPS_SCRIPT_WEBHOOK_SECRET", "test-webhook-secret")
    monkeypatch.setenv("RECORDINGS_FOLDER_ID", "folder123")
    monkeypatch.setenv("GOOGLE_APPLICATION_CREDENTIALS", "")
    _clear_settings()
    from app.main import app
    from tests.test_api import _mock_response, _patch_async_client

    with TestClient(app) as c:
        token = _login(c)
        with _patch_async_client([_mock_response(_detail_ok())]):
            resp = c.post(
                "/api/v1/jobs/21759f5d/recordings",
                headers={"Authorization": f"Bearer {token}"},
                files={"file": ("note.webm", io.BytesIO(b"abc123"), "audio/webm")},
                data={"duration_seconds": "1", "trigger_processing": "false"},
            )
        assert resp.status_code == 503
        assert "test-webhook-secret" not in resp.text
    _clear_settings()


def test_api_missing_folder_id(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    sa = tmp_path / "sa.json"
    sa.write_text("{}", encoding="utf-8")
    monkeypatch.setenv("DATA_MODE", "apps_script")
    monkeypatch.setenv("JWT_SECRET", "test-secret")
    monkeypatch.setenv("AUTH_USERS_FILE", str(tmp_path / "auth_users.json"))
    monkeypatch.setenv("MOCK_DATA_DIR", str(tmp_path / "mock"))
    monkeypatch.setenv("LOCAL_RECORDINGS_DIR", str(tmp_path / "recordings"))
    monkeypatch.setenv("DEMO_STAFF_EMAIL", "alex@nativegrace.com")
    monkeypatch.setenv("DEMO_STAFF_PASSWORD", "FieldOS-Demo-2026!")
    monkeypatch.setenv("DEMO_STAFF_ID", "STAFF-9012C021")
    monkeypatch.setenv("APPS_SCRIPT_WEBAPP_URL", "https://script.google.com/macros/s/fake/exec")
    monkeypatch.setenv("APPS_SCRIPT_WEBHOOK_SECRET", "test-webhook-secret")
    monkeypatch.setenv("RECORDINGS_FOLDER_ID", "")
    monkeypatch.setenv("GOOGLE_APPLICATION_CREDENTIALS", str(sa))
    _clear_settings()
    from app.main import app
    from tests.test_api import _mock_response, _patch_async_client

    with TestClient(app) as c:
        token = _login(c)
        with _patch_async_client([_mock_response(_detail_ok())]):
            resp = c.post(
                "/api/v1/jobs/21759f5d/recordings",
                headers={"Authorization": f"Bearer {token}"},
                files={"file": ("note.webm", io.BytesIO(b"abc123"), "audio/webm")},
                data={"duration_seconds": "1", "trigger_processing": "false"},
            )
        assert resp.status_code == 503
    _clear_settings()


def test_api_successful_drive_then_register(apps_script_drive_env: TestClient) -> None:
    from tests.test_api import _mock_response, _patch_async_client

    token = _login(apps_script_drive_env)
    register_payload = {
        "status": "Success",
        "action": "register_recording",
        "message": "Recording registered.",
        "record_id": "21759f5d",
        "data": {
            "recording_id": "REC-TEST001",
            "recording_file_url": "https://drive.google.com/file/d/drive-file-1/view",
            "recording_drive_file_id": "drive-file-1",
            "recording_order": 1,
            "status": "Saved",
        },
    }
    with patch(
        "app.services.apps_script_repository.upload_recording_to_drive",
        return_value={
            "recording_drive_file_id": "drive-file-1",
            "recording_file_url": "https://drive.google.com/file/d/drive-file-1/view",
        },
    ) as upload_mock:
        with _patch_async_client([_mock_response(_detail_ok()), _mock_response(register_payload)]):
            resp = apps_script_drive_env.post(
                "/api/v1/jobs/21759f5d/recordings",
                headers={"Authorization": f"Bearer {token}"},
                files={"file": ("note.webm", io.BytesIO(b"abc123"), "audio/webm")},
                data={"duration_seconds": "1.5", "trigger_processing": "false"},
            )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["recording_id"] == "REC-TEST001"
    assert body["recording_drive_file_id"] == "drive-file-1"
    assert "audio_base64" not in resp.text
    assert "test-webhook-secret" not in resp.text
    upload_mock.assert_called_once()
    call_kwargs = upload_mock.call_args.kwargs
    assert call_kwargs["data"] == b"abc123"
    assert call_kwargs["mime_type"] == "audio/webm"


def test_api_drive_permission_failure(apps_script_drive_env: TestClient) -> None:
    from tests.test_api import _mock_response, _patch_async_client

    token = _login(apps_script_drive_env)
    with patch(
        "app.services.apps_script_repository.upload_recording_to_drive",
        side_effect=HTTPException(
            status_code=503,
            detail=(
                "Drive permission denied. Share the Shared Drive (or folder) with the "
                "service account as Content manager or Contributor."
            ),
        ),
    ):
        with _patch_async_client([_mock_response(_detail_ok())]):
            resp = apps_script_drive_env.post(
                "/api/v1/jobs/21759f5d/recordings",
                headers={"Authorization": f"Bearer {token}"},
                files={"file": ("note.webm", io.BytesIO(b"abc123"), "audio/webm")},
                data={"duration_seconds": "1", "trigger_processing": "false"},
            )
    assert resp.status_code == 503
    assert "permission" in resp.json()["detail"].lower()


def test_api_storage_quota_exceeded(apps_script_drive_env: TestClient) -> None:
    from tests.test_api import _mock_response, _patch_async_client

    token = _login(apps_script_drive_env)
    with patch(
        "app.services.apps_script_repository.upload_recording_to_drive",
        side_effect=HTTPException(
            status_code=503,
            detail=(
                "Drive storageQuotaExceeded: the service account cannot use personal "
                "My Drive quota. Set RECORDINGS_FOLDER_ID to a folder inside a Shared Drive."
            ),
        ),
    ):
        with _patch_async_client([_mock_response(_detail_ok())]):
            resp = apps_script_drive_env.post(
                "/api/v1/jobs/21759f5d/recordings",
                headers={"Authorization": f"Bearer {token}"},
                files={"file": ("note.webm", io.BytesIO(b"abc123"), "audio/webm")},
                data={"duration_seconds": "1", "trigger_processing": "false"},
            )
    assert resp.status_code == 503
    assert "storageQuotaExceeded" in resp.json()["detail"]


def test_api_register_recording_failure_deletes_orphan(apps_script_drive_env: TestClient) -> None:
    from tests.test_api import _mock_response, _patch_async_client

    token = _login(apps_script_drive_env)
    fail = {
        "status": "Error",
        "action": "register_recording",
        "message": "Forbidden: Job is not assigned to this staff member.",
        "record_id": "21759f5d",
    }
    with patch(
        "app.services.apps_script_repository.upload_recording_to_drive",
        return_value={
            "recording_drive_file_id": "orphan-file",
            "recording_file_url": "https://drive.google.com/file/d/orphan-file/view",
        },
    ):
        with patch("app.services.apps_script_repository.delete_drive_file") as del_mock:
            with _patch_async_client([_mock_response(_detail_ok()), _mock_response(fail)]):
                resp = apps_script_drive_env.post(
                    "/api/v1/jobs/21759f5d/recordings",
                    headers={"Authorization": f"Bearer {token}"},
                    files={"file": ("note.webm", io.BytesIO(b"abc123"), "audio/webm")},
                    data={"duration_seconds": "1", "trigger_processing": "false"},
                )
    assert resp.status_code == 403
    del_mock.assert_called_once()
    assert del_mock.call_args.args[1] == "orphan-file"


def test_api_mime_rejection(apps_script_drive_env: TestClient) -> None:
    from tests.test_api import _mock_response, _patch_async_client

    token = _login(apps_script_drive_env)
    with _patch_async_client([_mock_response(_detail_ok())]):
        resp = apps_script_drive_env.post(
            "/api/v1/jobs/21759f5d/recordings",
            headers={"Authorization": f"Bearer {token}"},
            files={"file": ("note.txt", io.BytesIO(b"not-audio"), "text/plain")},
            data={"duration_seconds": "1", "trigger_processing": "false"},
        )
    assert resp.status_code == 400


def test_api_size_rejection(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    sa = tmp_path / "sa.json"
    sa.write_text("{}", encoding="utf-8")
    monkeypatch.setenv("DATA_MODE", "apps_script")
    monkeypatch.setenv("JWT_SECRET", "test-secret")
    monkeypatch.setenv("AUTH_USERS_FILE", str(tmp_path / "auth_users.json"))
    monkeypatch.setenv("MOCK_DATA_DIR", str(tmp_path / "mock"))
    monkeypatch.setenv("LOCAL_RECORDINGS_DIR", str(tmp_path / "recordings"))
    monkeypatch.setenv("DEMO_STAFF_EMAIL", "alex@nativegrace.com")
    monkeypatch.setenv("DEMO_STAFF_PASSWORD", "FieldOS-Demo-2026!")
    monkeypatch.setenv("DEMO_STAFF_ID", "STAFF-9012C021")
    monkeypatch.setenv("APPS_SCRIPT_WEBAPP_URL", "https://script.google.com/macros/s/fake/exec")
    monkeypatch.setenv("APPS_SCRIPT_WEBHOOK_SECRET", "test-webhook-secret")
    monkeypatch.setenv("RECORDINGS_FOLDER_ID", "folder123")
    monkeypatch.setenv("GOOGLE_APPLICATION_CREDENTIALS", str(sa))
    monkeypatch.setenv("MAX_UPLOAD_MB", "0")
    _clear_settings()
    from app.main import app
    from tests.test_api import _mock_response, _patch_async_client

    with TestClient(app) as c:
        token = _login(c)
        with _patch_async_client([_mock_response(_detail_ok())]):
            resp = c.post(
                "/api/v1/jobs/21759f5d/recordings",
                headers={"Authorization": f"Bearer {token}"},
                files={"file": ("note.webm", io.BytesIO(b"12345"), "audio/webm")},
                data={"duration_seconds": "1", "trigger_processing": "false"},
            )
        assert resp.status_code == 400
    _clear_settings()
