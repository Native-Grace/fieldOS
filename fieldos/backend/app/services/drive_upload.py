"""Optional Google Drive upload for DATA_MODE=apps_script (bytes never go through Apps Script).

Uploads always target RECORDINGS_FOLDER_ID (Shared Drive folder). Service accounts have
no personal My Drive quota — Shared Drive + supportsAllDrives is required.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Optional

from fastapi import HTTPException, status

from app.core.config import Settings
from app.core.logging import get_logger, log_extra

logger = get_logger(__name__)

# Full Drive scope required for existing Shared Drive folders (drive.file is insufficient).
DRIVE_SCOPE = "https://www.googleapis.com/auth/drive"


def drive_upload_configured(settings: Settings) -> bool:
    return bool(settings.recordings_folder_id and settings.google_application_credentials)


def _drive_service(settings: Settings):
    from google.oauth2 import service_account
    from googleapiclient.discovery import build

    creds_path = Path(settings.google_application_credentials)
    if not creds_path.is_file():
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="GOOGLE_APPLICATION_CREDENTIALS file not found on server.",
        )
    credentials = service_account.Credentials.from_service_account_file(
        str(creds_path),
        scopes=[DRIVE_SCOPE],
    )
    return build("drive", "v3", credentials=credentials, cache_discovery=False)


def _google_error_reason(exc: BaseException) -> tuple[Optional[int], Optional[str]]:
    """Extract HTTP status + reason from googleapiclient HttpError without leaking bodies."""
    http_status = getattr(exc, "status_code", None) or getattr(exc, "resp", None)
    if http_status is not None and not isinstance(http_status, int):
        http_status = getattr(http_status, "status", None)
    reason = None
    content = getattr(exc, "content", None)
    raw = ""
    if isinstance(content, (bytes, bytearray)):
        raw = bytes(content).decode("utf-8", errors="replace")
    elif isinstance(content, str):
        raw = content
    else:
        raw = str(exc)
    try:
        payload = json.loads(raw) if raw.strip().startswith("{") else {}
        err = payload.get("error") if isinstance(payload, dict) else None
        if isinstance(err, dict):
            if http_status is None:
                http_status = err.get("code")
            errors = err.get("errors") or []
            if errors and isinstance(errors[0], dict):
                reason = errors[0].get("reason")
            if not reason:
                # newer API shape
                details = err.get("details") or []
                for d in details:
                    if isinstance(d, dict) and d.get("reason"):
                        reason = d.get("reason")
                        break
            if not reason and isinstance(err.get("status"), str):
                reason = err.get("status")
    except Exception:
        pass
    # Fallback string scan (sanitised — reason tokens only)
    lower = raw.lower()
    if not reason:
        for token in (
            "storagequotaexceeded",
            "notfound",
            "forbidden",
            "insufficientpermissions",
            "insufficientfilepermissions",
        ):
            if token in lower.replace("_", "").replace(" ", ""):
                reason = token
                break
    if isinstance(reason, str):
        reason = reason.strip()
    return (int(http_status) if http_status else None, reason)


def _map_drive_exception(exc: BaseException) -> HTTPException:
    """Map Drive API failures to clear config errors; never include credential JSON."""
    http_status, reason = _google_error_reason(exc)
    reason_l = (reason or "").lower().replace("_", "")

    if "storagequotaexceeded" in reason_l:
        return HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=(
                "Drive storageQuotaExceeded: the service account cannot use personal "
                "My Drive quota. Set RECORDINGS_FOLDER_ID to a folder inside a Shared "
                "Drive and add the service account as Content manager (or Contributor) "
                "on that Shared Drive."
            ),
        )
    if reason_l in {"notfound", "404"} or http_status == 404:
        return HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=(
                "Drive folder not found. Check RECORDINGS_FOLDER_ID is a Shared Drive "
                "folder ID visible to the service account."
            ),
        )
    if reason_l in {
        "forbidden",
        "insufficientpermissions",
        "insufficientfilepermissions",
        "filepermissiondenied",
    } or http_status == 403:
        return HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=(
                "Drive permission denied. Share the Shared Drive (or folder) with the "
                "service account as Content manager or Contributor."
            ),
        )

    log_extra(
        logger,
        40,
        "Drive upload failed",
        error=type(exc).__name__,
        http_status=http_status,
        reason=reason,
    )
    return HTTPException(
        status_code=status.HTTP_502_BAD_GATEWAY,
        detail="Failed to upload recording to Google Drive.",
    )


def upload_recording_to_drive(
    settings: Settings,
    *,
    filename: str,
    data: bytes,
    mime_type: str,
) -> dict[str, str]:
    """Upload audio into RECORDINGS_FOLDER_ID on a Shared Drive (never SA My Drive root)."""
    if not drive_upload_configured(settings):
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=(
                "DATA_MODE=apps_script requires GOOGLE_APPLICATION_CREDENTIALS and "
                "RECORDINGS_FOLDER_ID so audio can upload to Drive without posting "
                "large payloads through Apps Script."
            ),
        )

    folder_id = str(settings.recordings_folder_id).strip()
    if not folder_id:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="RECORDINGS_FOLDER_ID is required for Drive uploads.",
        )

    try:
        from googleapiclient.http import MediaInMemoryUpload
    except ImportError as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Google API client libraries are not installed in this image.",
        ) from exc

    try:
        service = _drive_service(settings)
        # Confirm parent folder is reachable on Shared Drives before create.
        service.files().get(
            fileId=folder_id,
            fields="id,name,mimeType,driveId",
            supportsAllDrives=True,
        ).execute()

        media = MediaInMemoryUpload(data, mimetype=mime_type, resumable=False)
        meta: dict[str, Any] = {
            "name": filename,
            "parents": [folder_id],
        }
        created = (
            service.files()
            .create(
                body=meta,
                media_body=media,
                fields="id,webViewLink,webContentLink",
                supportsAllDrives=True,
            )
            .execute()
        )
        file_id = created.get("id") or ""
        url = (
            created.get("webViewLink")
            or created.get("webContentLink")
            or f"https://drive.google.com/file/d/{file_id}/view"
        )
        log_extra(logger, 20, "Uploaded recording to Drive", drive_file_id=file_id, bytes=len(data))
        return {
            "recording_drive_file_id": file_id,
            "recording_file_url": url,
        }
    except HTTPException:
        raise
    except Exception as exc:
        raise _map_drive_exception(exc) from exc


def _should_trash_after_delete_failure(http_status: Optional[int], reason: Optional[str]) -> bool:
    """Trash fallback only for Shared Drive delete edge cases (notFound / permission)."""
    reason_l = (reason or "").lower().replace("_", "")
    if http_status == 404 or reason_l in {"notfound", "404"}:
        return True
    if http_status == 403 or reason_l in {
        "insufficientfilepermissions",
        "insufficientpermissions",
        "filepermissions",
        "forbidden",
    }:
        return True
    return False


def delete_drive_file(settings: Settings, file_id: Optional[str]) -> None:
    """Best-effort delete after a failed register_recording (orphan cleanup).

    Attempts permanent delete first. On Shared Drives, delete can return notFound or
    permission errors even when the file exists; only then fall back to trash.
    """
    _cleanup_drive_recording_file(settings, file_id, required=False)


def cleanup_drive_recording_file(
    settings: Settings,
    file_id: Optional[str],
    *,
    required: bool = True,
) -> str:
    """Delete or trash a Drive recording. Returns outcome: deleted|trashed|skipped|failed.

    When required=True, raises HTTP 502 if cleanup cannot complete.
    """
    return _cleanup_drive_recording_file(settings, file_id, required=required)


def _cleanup_drive_recording_file(
    settings: Settings,
    file_id: Optional[str],
    *,
    required: bool,
) -> str:
    if not file_id:
        return "skipped"
    if not drive_upload_configured(settings):
        if required:
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="Drive is not configured; cannot clean up recording file.",
            )
        return "skipped"
    try:
        service = _drive_service(settings)
        try:
            service.files().delete(fileId=file_id, supportsAllDrives=True).execute()
            log_extra(logger, 20, "Deleted Drive recording file", outcome="deleted")
            return "deleted"
        except Exception as delete_exc:
            http_status, reason = _google_error_reason(delete_exc)
            if not _should_trash_after_delete_failure(http_status, reason):
                log_extra(
                    logger,
                    40,
                    "Failed to delete Drive recording (no trash fallback)",
                    error=type(delete_exc).__name__,
                    http_status=http_status,
                    reason=reason,
                )
                if required:
                    raise HTTPException(
                        status_code=status.HTTP_502_BAD_GATEWAY,
                        detail="Could not delete recording file from Drive. Recording was not removed.",
                    ) from delete_exc
                return "failed"
            service.files().update(
                fileId=file_id,
                body={"trashed": True},
                supportsAllDrives=True,
            ).execute()
            log_extra(
                logger,
                20,
                "Trashed Drive recording after delete fallback",
                outcome="trashed",
                delete_http_status=http_status,
                delete_reason=reason,
            )
            return "trashed"
    except HTTPException:
        raise
    except Exception as exc:
        http_status, reason = _google_error_reason(exc)
        log_extra(
            logger,
            40,
            "Failed to clean up Drive recording",
            error=type(exc).__name__,
            http_status=http_status,
            reason=reason,
        )
        if required:
            raise HTTPException(
                status_code=status.HTTP_502_BAD_GATEWAY,
                detail="Could not delete recording file from Drive. Recording was not removed.",
            ) from exc
        return "failed"


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
