"""Tests for Daily Work Job Sheet (daily_work_dictation) — mock mode."""

from __future__ import annotations

from datetime import date, datetime
from io import BytesIO
from pathlib import Path
from zoneinfo import ZoneInfo

import pytest
from fastapi.testclient import TestClient

from app.services.daily_work_math import (
    aggregate_transcripts,
    build_sheet_job_fields,
    coerce_extraction,
    format_manager_notes,
    move_item,
    payload_hash,
    sort_recordings,
    sydney_today,
    validate_reviewed_job_sheet,
)


def test_sydney_today_relative() -> None:
    now = datetime(2026, 8, 1, 2, 0, tzinfo=ZoneInfo("UTC"))  # 12:00 Sydney AEST
    assert sydney_today(now) == date(2026, 8, 1)


def test_aggregate_transcripts_with_markers() -> None:
    recs = [
        {
            "recording_id": "R2",
            "recorded_at": "2026-08-01T00:46:00+00:00",
            "sequence": 2,
            "created_at": "2026-08-01T00:46:00+00:00",
            "transcript": "Second note",
        },
        {
            "recording_id": "R1",
            "recorded_at": "2026-08-01T00:12:00+00:00",
            "sequence": 1,
            "created_at": "2026-08-01T00:12:00+00:00",
            "transcript": "First note",
        },
    ]
    text = aggregate_transcripts(recs)
    assert "Recording 1" in text
    assert "Recording 2" in text
    assert text.index("First note") < text.index("Second note")
    assert "[10:12 — Recording 1]" in text or "Recording 1" in text


def test_sort_recordings_order() -> None:
    ordered = sort_recordings(
        [
            {"recording_id": "B", "recorded_at": "2026-08-01T12:00:00+00:00", "sequence": 2, "created_at": "b"},
            {"recording_id": "A", "recorded_at": "2026-08-01T11:00:00+00:00", "sequence": 1, "created_at": "a"},
        ]
    )
    assert [r["recording_id"] for r in ordered] == ["A", "B"]


def test_completed_vs_follow_up_in_mock_extraction_shape() -> None:
    out = coerce_extraction(
        {
            "job_sheet": {
                "work_completed": [{"text": "Pruned hedges", "recording_ids": ["R1"]}],
                "follow_up_required": [{"text": "Return to repair tap", "recording_ids": ["R3"]}],
                "issues_found": [{"text": "Rear tap leaking", "recording_ids": ["R3"]}],
            }
        },
        work_session_id="DWS-1",
        work_date="2026-08-01",
    )
    texts = [x["text"].lower() for x in out["job_sheet"]["work_completed"]]
    assert all("return" not in t for t in texts)
    assert out["job_sheet"]["follow_up_required"][0]["recording_ids"] == ["R3"]


def test_manager_notes_deterministic() -> None:
    notes = format_manager_notes(
        {
            "work_completed": [{"text": "Pruned front hedges"}],
            "materials_used": [{"text": "19 mm joiner"}],
            "issues_found": [{"text": "Rear tap leaking"}],
            "follow_up_required": [{"text": "Return to repair rear tap"}],
            "client_requests": [{"text": "Quote planting along fence"}],
            "completion_summary": "Completed garden maintenance.",
        }
    )
    assert notes.startswith("WORK COMPLETED")
    assert "MATERIALS USED" in notes
    assert "FOLLOW-UP REQUIRED" in notes
    assert "SUMMARY" in notes
    assert "customer_name" not in notes.lower()


def test_sheet_fields_create_safe_only() -> None:
    fields = build_sheet_job_fields(
        {
            "customer_name": "Kat and James Dykes",
            "project_id": "PROJ-6002C0A0",
            "work_date": "2026-08-01",
            "staff_ids": ["STAFF-1"],
            "work_completed": [{"text": "Pruned hedges"}],
            "completion_summary": "Done",
        },
        actor_staff_id="STAFF-ACTOR",
    )
    assert set(fields.keys()) == {
        "staff_id",
        "date",
        "project_id",
        "manager_notes",
        "processing_status",
        "processing_error",
        "approval_status",
    }
    assert "customer_name" not in fields
    assert fields["processing_status"] == "Completed"
    assert fields["date"] == "2026-08-01"


def test_move_item_completed_to_follow_up() -> None:
    job = {
        "work_completed": [{"text": "Maybe later", "recording_ids": ["R1"]}],
        "follow_up_required": [],
    }
    out = move_item(job, from_field="work_completed", to_field="follow_up_required", index=0)
    assert out["work_completed"] == []
    assert out["follow_up_required"][0]["text"] == "Maybe later"


def test_validate_reviewed_requires_work_or_summary() -> None:
    ok, _ = validate_reviewed_job_sheet(
        {
            "customer_name": "Kat",
            "project_id": "PROJ-1",
            "work_date": "2026-08-01",
            "staff_ids": ["S1"],
            "work_completed": [{"text": "Weeded"}],
        }
    )
    assert ok is True
    bad, err = validate_reviewed_job_sheet(
        {
            "customer_name": "Kat",
            "project_id": "PROJ-1",
            "work_date": "2026-08-01",
            "staff_ids": ["S1"],
        }
    )
    assert bad is False
    assert "work_completed" in err or "summary" in err


def test_api_create_resume_multi_recording_review_required(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("DATA_MODE", "mock")
    monkeypatch.setenv("DAILY_WORK_SESSIONS_DIR", str(tmp_path / "dws"))
    monkeypatch.setenv("JWT_SECRET", "test-secret-daily-work-xxxxxxxx")
    from app.main import app

    client = TestClient(app)
    login = client.post(
        "/api/v1/auth/login",
        json={"email": "alex@nativegrace.com", "password": "FieldOS-Demo-2026!"},
    )
    assert login.status_code == 200, login.text
    token = login.json()["access_token"]
    headers = {"Authorization": f"Bearer {token}"}

    created = client.post(
        "/api/v1/daily-work-sessions",
        headers=headers,
        json={
            "work_date": "2026-08-01",
            "customer_name": "Kat and James Dykes",
            "project_id": "PROJ-6002C0A0",
            "project_name": "Kat and James Dykes",
            "staff_ids": ["STAFF-DEMO001"],
            "staff_names": ["Alex Technician"],
        },
    )
    assert created.status_code == 200, created.text
    session = created.json()["session"]
    assert session["status"] == "Recording"
    assert session["job_created"] is False
    assert "No job sheet has been created yet" in session["notice"]
    wid = session["work_session_id"]

    # Resume after "refresh"
    got = client.get(f"/api/v1/daily-work-sessions/{wid}", headers=headers)
    assert got.status_code == 200
    assert got.json()["session"]["work_session_id"] == wid

    audio = b"x" * 2048
    for i in range(3):
        up = client.post(
            f"/api/v1/daily-work-sessions/{wid}/recordings",
            headers=headers,
            files={"file": (f"note{i}.webm", BytesIO(audio), "audio/webm")},
            data={"duration_seconds": "3", "source": "uploaded_file"},
        )
        assert up.status_code == 200, up.text

    session = client.get(f"/api/v1/daily-work-sessions/{wid}", headers=headers).json()["session"]
    assert len(session["recordings"]) == 3
    assert session["status"] == "Recording"

    proc = client.post(f"/api/v1/daily-work-sessions/{wid}/process-all", headers=headers)
    assert proc.status_code == 200, proc.text
    # No job yet
    assert proc.json()["session"]["job_created"] is False

    # Individual retry (force) on first recording
    rid0 = proc.json()["session"]["recordings"][0]["recording_id"]
    one = client.post(
        f"/api/v1/daily-work-sessions/{wid}/recordings/{rid0}/process?force=true",
        headers=headers,
    )
    assert one.status_code == 200

    ext = client.post(f"/api/v1/daily-work-sessions/{wid}/extract", headers=headers)
    assert ext.status_code == 200, ext.text
    session = ext.json()["session"]
    assert session["status"] == "ReviewRequired"
    assert session["job_created"] is False
    job = session["extraction"]["job_sheet"]
    completed = [x["text"].lower() for x in job["work_completed"]]
    assert any("hedge" in t for t in completed)
    assert any("green waste" in t for t in completed)
    follow = [x["text"].lower() for x in job["follow_up_required"]]
    assert any("tap" in t for t in follow)
    # Rear tap repair must not be completed
    assert not any("return" in t and "tap" in t for t in completed)
    # Source mapping present
    assert all("recording_ids" in x for x in job["work_completed"])

    # Explicit create
    key = "idem-daily-work-test-001"
    create1 = client.post(
        f"/api/v1/daily-work-sessions/{wid}/create-job-sheet",
        headers=headers,
        json={
            "expected_session_version": session["version"],
            "reviewed_job_sheet": job,
            "idempotency_key": key,
        },
    )
    assert create1.status_code == 200, create1.text
    job_sheet_id = create1.json()["job"]["job_sheet_id"]
    assert job_sheet_id
    assert create1.json()["session"]["status"] == "JobCreated"
    assert len(create1.json()["links"]) == 3

    # Idempotent same payload
    create2 = client.post(
        f"/api/v1/daily-work-sessions/{wid}/create-job-sheet",
        headers=headers,
        json={
            "expected_session_version": session["version"],
            "reviewed_job_sheet": job,
            "idempotency_key": key,
        },
    )
    assert create2.status_code == 200
    assert create2.json()["idempotent"] is True
    assert create2.json()["job"]["job_sheet_id"] == job_sheet_id

    # Same key + changed payload → 409
    changed = {**job, "completion_summary": "Changed"}
    create3 = client.post(
        f"/api/v1/daily-work-sessions/{wid}/create-job-sheet",
        headers=headers,
        json={
            "expected_session_version": create2.json()["session"]["version"],
            "reviewed_job_sheet": changed,
            "idempotency_key": key,
        },
    )
    assert create3.status_code == 409

    # Cannot silently create second job with new key after JobCreated
    create4 = client.post(
        f"/api/v1/daily-work-sessions/{wid}/create-job-sheet",
        headers=headers,
        json={
            "expected_session_version": create2.json()["session"]["version"],
            "reviewed_job_sheet": job,
            "idempotency_key": "idem-daily-work-test-002",
        },
    )
    assert create4.status_code == 409

    # Cannot add recordings after JobCreated
    blocked = client.post(
        f"/api/v1/daily-work-sessions/{wid}/recordings",
        headers=headers,
        files={"file": ("late.webm", BytesIO(audio), "audio/webm")},
        data={"duration_seconds": "1", "source": "uploaded_file"},
    )
    assert blocked.status_code == 409

    # Open list excludes JobCreated when open_only
    listing = client.get("/api/v1/daily-work-sessions?open_only=true", headers=headers)
    assert listing.status_code == 200
    assert all(i["work_session_id"] != wid for i in listing.json()["items"])


def test_payload_hash_stable() -> None:
    job = {"work_date": "2026-08-01", "work_completed": [{"text": "A"}]}
    assert payload_hash(job, "DWS-1") == payload_hash(dict(job), "DWS-1")
    assert payload_hash(job, "DWS-1") != payload_hash({**job, "x": 1}, "DWS-1")


def _login_headers(client: TestClient) -> dict[str, str]:
    login = client.post(
        "/api/v1/auth/login",
        json={"email": "alex@nativegrace.com", "password": "FieldOS-Demo-2026!"},
    )
    assert login.status_code == 200, login.text
    return {"Authorization": f"Bearer {login.json()['access_token']}"}


def _session_ready_for_create(client: TestClient, headers: dict[str, str]) -> dict:
    created = client.post(
        "/api/v1/daily-work-sessions",
        headers=headers,
        json={
            "work_date": "2026-08-01",
            "customer_name": "Kat and James Dykes",
            "project_id": "PROJ-6002C0A0",
            "project_name": "Kat and James Dykes",
            "staff_ids": ["STAFF-DEMO001"],
            "staff_names": ["Alex Technician"],
        },
    )
    assert created.status_code == 200, created.text
    wid = created.json()["session"]["work_session_id"]
    audio = b"x" * 2048
    up = client.post(
        f"/api/v1/daily-work-sessions/{wid}/recordings",
        headers=headers,
        files={"file": ("note.webm", BytesIO(audio), "audio/webm")},
        data={"duration_seconds": "3", "source": "uploaded_file"},
    )
    assert up.status_code == 200, up.text
    assert client.post(f"/api/v1/daily-work-sessions/{wid}/process-all", headers=headers).status_code == 200
    ext = client.post(f"/api/v1/daily-work-sessions/{wid}/extract", headers=headers)
    assert ext.status_code == 200, ext.text
    return ext.json()["session"]


def test_create_failed_return_to_review_preserves_extraction(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("DATA_MODE", "mock")
    monkeypatch.setenv("DAILY_WORK_SESSIONS_DIR", str(tmp_path / "dws"))
    monkeypatch.setenv("JWT_SECRET", "test-secret-daily-work-xxxxxxxx")
    from app.main import app
    from app.services.daily_work import DailyWorkService
    from app.core.config import get_settings

    get_settings.cache_clear()
    client = TestClient(app)
    headers = _login_headers(client)
    session = _session_ready_for_create(client, headers)
    wid = session["work_session_id"]
    job = session["extraction"]["job_sheet"]
    completed_before = list(job.get("work_completed") or [])
    recordings_before = list(session.get("recordings") or [])
    version_before = int(session["version"])

    # Force CreateFailed via service (simulate Apps Script / transport failure).
    settings = get_settings()
    svc = DailyWorkService(settings)
    row = svc.store.get(wid)
    assert row is not None
    row["status"] = "CreateFailed"
    row["failure_reason"] = "Unsupported action: create_completed_job_sheet_from_recordings"
    row["create_failure_reason"] = row["failure_reason"]
    row["create_failure_code"] = "http_400"
    row["last_create_idempotency_key"] = "idem-create-failed-retry-001"
    row["extraction"]["job_sheet"] = job
    row["version"] = version_before + 1
    svc.store.save(row)

    # Create from CreateFailed is rejected (no silent retry).
    blocked = client.post(
        f"/api/v1/daily-work-sessions/{wid}/create-job-sheet",
        headers=headers,
        json={
            "expected_session_version": row["version"],
            "reviewed_job_sheet": job,
            "idempotency_key": "idem-create-failed-retry-001",
        },
    )
    assert blocked.status_code == 409
    assert "ReviewRequired" in blocked.json()["detail"]

    # Wrong version → 409
    bad_ver = client.post(
        f"/api/v1/daily-work-sessions/{wid}/return-to-review",
        headers=headers,
        json={"expected_session_version": 1},
    )
    assert bad_ver.status_code == 409

    # Recovery
    recovered = client.post(
        f"/api/v1/daily-work-sessions/{wid}/return-to-review",
        headers=headers,
        json={"expected_session_version": row["version"]},
    )
    assert recovered.status_code == 200, recovered.text
    out = recovered.json()["session"]
    assert out["status"] == "ReviewRequired"
    assert out["create_failure_reason"] == ""
    assert out["create_failure_code"] == ""
    assert out["failure_reason"] == ""
    assert out["version"] == row["version"] + 1
    assert out["extraction"]["job_sheet"]["work_completed"] == completed_before
    assert len(out["recordings"]) == len(recordings_before)
    assert all(r.get("status") == "Processed" for r in out["recordings"])
    assert out["last_create_idempotency_key"] == "idem-create-failed-retry-001"
    assert "kept" in (out.get("notice") or "").lower() or out["status"] == "ReviewRequired"

    # Non-CreateFailed recovery rejected
    again = client.post(
        f"/api/v1/daily-work-sessions/{wid}/return-to-review",
        headers=headers,
        json={"expected_session_version": out["version"]},
    )
    assert again.status_code == 409

    # Explicit create after recovery — same idempotency key
    created = client.post(
        f"/api/v1/daily-work-sessions/{wid}/create-job-sheet",
        headers=headers,
        json={
            "expected_session_version": out["version"],
            "reviewed_job_sheet": out["extraction"]["job_sheet"],
            "idempotency_key": "idem-create-failed-retry-001",
        },
    )
    assert created.status_code == 200, created.text
    assert created.json()["session"]["status"] == "JobCreated"
    assert created.json()["job"]["job_sheet_id"]
    assert created.json()["idempotent"] is False

    # Idempotent replay returns same job
    replay = client.post(
        f"/api/v1/daily-work-sessions/{wid}/create-job-sheet",
        headers=headers,
        json={
            "expected_session_version": created.json()["session"]["version"],
            "reviewed_job_sheet": out["extraction"]["job_sheet"],
            "idempotency_key": "idem-create-failed-retry-001",
        },
    )
    assert replay.status_code == 200
    assert replay.json()["idempotent"] is True
    assert replay.json()["job"]["job_sheet_id"] == created.json()["job"]["job_sheet_id"]


def test_return_to_review_rejects_non_create_failed(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("DATA_MODE", "mock")
    monkeypatch.setenv("DAILY_WORK_SESSIONS_DIR", str(tmp_path / "dws2"))
    monkeypatch.setenv("JWT_SECRET", "test-secret-daily-work-xxxxxxxx")
    from app.main import app
    from app.core.config import get_settings

    get_settings.cache_clear()
    client = TestClient(app)
    headers = _login_headers(client)
    session = _session_ready_for_create(client, headers)
    resp = client.post(
        f"/api/v1/daily-work-sessions/{session['work_session_id']}/return-to-review",
        headers=headers,
        json={"expected_session_version": session["version"]},
    )
    assert resp.status_code == 409
    assert "CreateFailed" in resp.json()["detail"]
