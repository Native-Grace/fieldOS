"""Audio file validation for FieldOS recording uploads (MIME + extension)."""

from __future__ import annotations

import os
import re
from typing import Optional

from fastapi import HTTPException, UploadFile

# Extensions accepted for file upload / MediaRecorder blobs.
SUPPORTED_EXTENSIONS = frozenset(
    {"webm", "wav", "mp3", "m4a", "mp4", "ogg", "oga", "mpeg", "mpga", "flac"}
)

# MIME allow-list (lowercase, no parameters).
SUPPORTED_MIMES = frozenset(
    {
        "audio/webm",
        "video/webm",
        "audio/wav",
        "audio/x-wav",
        "audio/mpeg",
        "audio/mp3",
        "audio/mp4",
        "video/mp4",
        "audio/x-m4a",
        "audio/ogg",
        "application/ogg",
        "audio/flac",
        "audio/x-flac",
    }
)

MIME_TO_EXT = {
    "audio/webm": "webm",
    "video/webm": "webm",
    "audio/wav": "wav",
    "audio/x-wav": "wav",
    "audio/mpeg": "mp3",
    "audio/mp3": "mp3",
    "audio/mp4": "m4a",
    "video/mp4": "mp4",
    "audio/x-m4a": "m4a",
    "audio/ogg": "ogg",
    "application/ogg": "ogg",
    "audio/flac": "flac",
    "audio/x-flac": "flac",
}

EXT_TO_MIME = {
    "webm": "audio/webm",
    "wav": "audio/wav",
    "mp3": "audio/mpeg",
    "mpeg": "audio/mpeg",
    "mpga": "audio/mpeg",
    "m4a": "audio/mp4",
    "mp4": "video/mp4",
    "ogg": "audio/ogg",
    "oga": "audio/ogg",
    "flac": "audio/flac",
}

_SAFE_NAME_RE = re.compile(r"[^A-Za-z0-9._\-]+")


def extension_of(filename: Optional[str]) -> str:
    name = str(filename or "").strip()
    if not name or "." not in name:
        return ""
    return name.rsplit(".", 1)[-1].lower().strip()


def sanitize_recording_filename(filename: Optional[str], fallback_ext: str = "webm") -> str:
    raw = str(filename or "").strip()
    base = os.path.basename(raw.replace("\\", "/"))
    if not base or base in {".", ".."}:
        return f"recording.{fallback_ext}"
    cleaned = _SAFE_NAME_RE.sub("_", base).strip("._")
    if not cleaned:
        return f"recording.{fallback_ext}"
    ext = extension_of(cleaned)
    if ext and ext not in SUPPORTED_EXTENSIONS:
        cleaned = cleaned.rsplit(".", 1)[0] + f".{fallback_ext}"
    elif not ext:
        cleaned = f"{cleaned}.{fallback_ext}"
    if len(cleaned) > 180:
        stem, dot, e = cleaned.rpartition(".")
        cleaned = (stem[:160] + ("." + e if dot else "")) if stem else cleaned[:180]
    return cleaned


def resolve_upload_mime_and_ext(
    *,
    filename: Optional[str],
    content_type: Optional[str],
) -> tuple[str, str]:
    """Return (mime, ext). Raises HTTP 422 on unsupported combinations."""
    mime = (content_type or "").split(";")[0].strip().lower()
    ext = extension_of(filename)
    name = str(filename or "").strip()

    if not name:
        raise HTTPException(status_code=422, detail="Invalid filename. Please choose an audio file.")

    if mime == "application/octet-stream" or not mime:
        if ext in SUPPORTED_EXTENSIONS:
            mime = EXT_TO_MIME[ext]
        else:
            raise HTTPException(
                status_code=422,
                detail="Unsupported audio format. Use webm, wav, mp3, m4a, mp4, ogg, or flac.",
            )
    elif mime not in SUPPORTED_MIMES:
        raise HTTPException(
            status_code=422,
            detail="Unsupported audio format. Use webm, wav, mp3, m4a, mp4, ogg, or flac.",
        )

    if ext and ext not in SUPPORTED_EXTENSIONS:
        raise HTTPException(
            status_code=422,
            detail="Unsupported file extension. Use webm, wav, mp3, m4a, mp4, ogg, or flac.",
        )

    if not ext:
        ext = MIME_TO_EXT.get(mime, "webm")
    elif ext in EXT_TO_MIME and mime in MIME_TO_EXT:
        # Allow common aliases (e.g. audio/mpeg + .mp3, video/webm + .webm).
        pass

    return mime, ext


def validate_upload_bytes(
    *,
    data: bytes,
    min_bytes: int,
    max_bytes: int,
    max_mb: int,
) -> None:
    if not data:
        raise HTTPException(status_code=422, detail="Empty upload rejected.")
    if len(data) < int(min_bytes or 1024):
        raise HTTPException(
            status_code=422,
            detail=(
                "Recording contains no audio (file too small). "
                f"Received {len(data)} bytes; minimum is {min_bytes} bytes."
            ),
        )
    if len(data) > int(max_bytes):
        raise HTTPException(
            status_code=422,
            detail=f"File exceeds max size of {max_mb} MB.",
        )


def validate_upload_file(
    file: UploadFile,
    data: bytes,
    *,
    min_bytes: int,
    max_bytes: int,
    max_mb: int,
) -> tuple[str, str, str]:
    """Validate UploadFile + bytes. Returns (mime, ext, sanitised_filename)."""
    mime, ext = resolve_upload_mime_and_ext(filename=file.filename, content_type=file.content_type)
    validate_upload_bytes(data=data, min_bytes=min_bytes, max_bytes=max_bytes, max_mb=max_mb)
    safe_name = sanitize_recording_filename(file.filename, fallback_ext=ext)
    return mime, ext, safe_name


def sanitize_invalid_reason(reason: Optional[str], *, max_len: int = 200) -> str:
    text = " ".join(str(reason or "").split())
    if not text:
        text = "Marked invalid by user."
    if len(text) > max_len:
        text = text[:max_len].rstrip()
    # Strip control chars
    text = "".join(ch for ch in text if ch.isprintable() or ch in " \t")
    return text or "Marked invalid by user."


def is_job_processing(status: Optional[str]) -> bool:
    return "process" in str(status or "").strip().lower() and "complete" not in str(status or "").strip().lower()
