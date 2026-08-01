"""Minimal OpenAI HTTP client for Whisper + JSON chat (FastAPI side).

Audio bytes never go through Apps Script. Uses OPENAI_API_KEY from settings.
"""

from __future__ import annotations

import json
from typing import Any, Optional

import httpx

from app.core.config import Settings


class OpenAIHttpError(RuntimeError):
    pass


def openai_configured(settings: Settings) -> bool:
    return bool(str(getattr(settings, "openai_api_key", "") or "").strip())


async def whisper_transcribe(
    settings: Settings,
    *,
    filename: str,
    mime_type: str,
    data: bytes,
) -> str:
    api_key = str(getattr(settings, "openai_api_key", "") or "").strip()
    if not api_key:
        raise OpenAIHttpError("OPENAI_API_KEY is not configured on the FieldOS API.")
    if not data:
        raise OpenAIHttpError("Cannot transcribe empty audio.")

    files = {
        "file": (filename or "recording.webm", data, mime_type or "application/octet-stream"),
    }
    form = {"model": "whisper-1", "language": "en"}
    headers = {"Authorization": f"Bearer {api_key}"}
    async with httpx.AsyncClient(timeout=120.0) as client:
        resp = await client.post(
            "https://api.openai.com/v1/audio/transcriptions",
            headers=headers,
            data=form,
            files=files,
        )
    if resp.status_code != 200:
        raise OpenAIHttpError(f"Whisper API Error ({resp.status_code})")
    payload = resp.json()
    return str(payload.get("text") or "").strip()


async def chat_json(
    settings: Settings,
    *,
    system_prompt: str,
    user_prompt: str,
    model: str = "gpt-4o",
) -> tuple[dict[str, Any], str]:
    api_key = str(getattr(settings, "openai_api_key", "") or "").strip()
    if not api_key:
        raise OpenAIHttpError("OPENAI_API_KEY is not configured on the FieldOS API.")
    body = {
        "model": model,
        "temperature": 0.1,
        "response_format": {"type": "json_object"},
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ],
    }
    headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}
    async with httpx.AsyncClient(timeout=120.0) as client:
        resp = await client.post(
            "https://api.openai.com/v1/chat/completions",
            headers=headers,
            content=json.dumps(body),
        )
    if resp.status_code != 200:
        raise OpenAIHttpError(f"OpenAI chat Error ({resp.status_code})")
    payload = resp.json()
    content = (
        ((payload.get("choices") or [{}])[0].get("message") or {}).get("content")
        if isinstance(payload, dict)
        else ""
    )
    text = str(content or "").strip()
    try:
        parsed = json.loads(text)
    except json.JSONDecodeError as exc:
        raise OpenAIHttpError("OpenAI chat returned non-JSON content.") from exc
    if not isinstance(parsed, dict):
        raise OpenAIHttpError("OpenAI chat JSON was not an object.")
    used_model = str((payload.get("model") if isinstance(payload, dict) else None) or model)
    return parsed, used_model
