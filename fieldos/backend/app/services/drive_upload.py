"""Optional Google Drive upload for DATA_MODE=apps_script (bytes never go through Apps Script)."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from fastapi import HTTPException, status

from app.core.config import Settings
from app.core.logging import get_logger, log_extra

logger = get_logger(__name__)


def drive_upload_configured(settings: Settings) -> bool:
    return bool(settings.recordings_folder_id and settings.google_application_credentials)


def upload_recording_to_drive(
    settings: Settings,
    *,
    filename: str,
    data: bytes,
    mime_type: str,
) -> dict[str, str]:
    """Upload audio to RECORDINGS_FOLDER_ID. Raises HTTPException on misconfig/failure."""
    if not drive_upload_configured(settings):
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=(
                "DATA_MODE=apps_script requires GOOGLE_APPLICATION_CREDENTIALS and "
                "RECORDINGS_FOLDER_ID so audio can upload to Drive without posting "
                "large payloads through Apps Script."
            ),
        )

    creds_path = Path(settings.google_application_credentials)
    if not creds_path.is_file():
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="GOOGLE_APPLICATION_CREDENTIALS file not found on server.",
        )

    try:
        from google.oauth2 import service_account
        from googleapiclient.discovery import build
        from googleapiclient.http import MediaInMemoryUpload
    except ImportError as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Google API client libraries are not installed in this image.",
        ) from exc

    try:
        scopes = ["https://www.googleapis.com/auth/drive.file"]
        credentials = service_account.Credentials.from_service_account_file(
            str(creds_path),
            scopes=scopes,
        )
        service = build("drive", "v3", credentials=credentials, cache_discovery=False)
        media = MediaInMemoryUpload(data, mimetype=mime_type, resumable=False)
        meta: dict[str, Any] = {
            "name": filename,
            "parents": [settings.recordings_folder_id],
        }
        created = (
            service.files()
            .create(body=meta, media_body=media, fields="id,webViewLink,webContentLink")
            .execute()
        )
        file_id = created.get("id") or ""
        url = created.get("webViewLink") or created.get("webContentLink") or f"https://drive.google.com/file/d/{file_id}/view"
        log_extra(logger, 20, "Uploaded recording to Drive", drive_file_id=file_id, bytes=len(data))
        return {
            "recording_drive_file_id": file_id,
            "recording_file_url": url,
        }
    except HTTPException:
        raise
    except Exception as exc:
        # Never include credential JSON in error messages
        log_extra(logger, 40, "Drive upload failed", error=type(exc).__name__)
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="Failed to upload recording to Google Drive.",
        ) from exc


def redact_secrets(obj: Any) -> Any:
    """Recursively scrub webhook_secret from structures before logging."""
    if isinstance(obj, dict):
        out = {}
        for k, v in obj.items():
            if str(k).lower() in {"webhook_secret", "apps_script_webhook_secret", "authorization"}:
                out[k] = "REDACTED"
            else:
                out[k] = redact_secrets(v)
        return out
    if isinstance(obj, list):
        return [redact_secrets(x) for x in obj]
    return obj


def safe_json_preview(obj: Any, limit: int = 500) -> str:
    try:
        text = json.dumps(redact_secrets(obj), default=str)
    except Exception:
        text = str(obj)
    return text[:limit]
