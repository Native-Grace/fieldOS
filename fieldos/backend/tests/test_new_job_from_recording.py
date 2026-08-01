"""Tests for Create Job from Recording math + API (mock mode)."""

from __future__ import annotations

from datetime import date, datetime
from io import BytesIO
from pathlib import Path
from zoneinfo import ZoneInfo

import pytest
from fastapi.testclient import TestClient

from app.services.new_job_dictation_math import (
    apply_relative_dates_to_extraction,
    build_match_report,
    coerce_extraction,
    match_master,
    payload_hash,
    resolve_relative_date_phrase,
    validate_reviewed_job,
)


def test_resolve_tomorrow_and_next_weekday() -> None:
    anchor = date(2026, 7, 31)  # Friday
    tomorrow = resolve_relative_date_phrase("tomorrow", anchor=anchor)
    assert tomorrow["resolved"] is True
    assert tomorrow["resolved_date"] == "2026-08-01"
    nxt = resolve_relative_date_phrase("next Tuesday", anchor=anchor)
    assert nxt["resolved"] is True
    assert nxt["resolved_date"] == "2026-08-04"


def test_no_invented_extraction_fields() -> None:
    out = coerce_extraction({"job": {"customer_name": "Kat"}, "confidence": {"customer_name": 2}})
    assert out["job"]["customer_name"] == "Kat"
    assert out["job"]["project_name"] == ""
    assert out["confidence"]["customer_name"] == 1.0
    assert out["job"]["status"] == "Scheduled"


def test_fuzzy_match_never_auto_selected() -> None:
    masters = [{"customer_id": "C1", "customer_name": "Kat and James Dykes"}]
    hit = match_master("Kat", masters, id_key="customer_id", name_key="customer_name")
    assert hit["status"] == "Possible match"
    assert hit["matched_id"] == ""


def test_exact_and_normalised_match() -> None:
    masters = [{"customer_id": "C1", "customer_name": "Kat and James Dykes"}]
    exact = match_master("Kat and James Dykes", masters, id_key="customer_id", name_key="customer_name")
    assert exact["status"] == "Matched"
    assert exact["matched_id"] == "C1"


def test_validate_reviewed_job_required_fields() -> None:
    ok, _ = validate_reviewed_job(
        {
            "customer_name": "Kat",
            "project_name": "Kat",
            "job_title": "Inspect",
            "scheduled_date": "2026-08-04",
            "assigned_staff_ids": ["STAFF-1"],
        }
    )
    assert ok is True
    bad, err = validate_reviewed_job({"customer_name": "Kat"})
    assert bad is False
    assert "project" in err.lower() or "scheduled" in err.lower() or "staff" in err.lower()


def test_relative_date_applied_to_extraction() -> None:
    extraction = coerce_extraction(
        {
            "transcript": "x",
            "job": {"scheduled_date": "next Tuesday", "status": "Scheduled"},
            "relative_date_phrases": ["next Tuesday"],
        }
    )
    created = datetime(2026, 7, 31, 12, 0, tzinfo=ZoneInfo("Australia/Sydney")).isoformat()
    out = apply_relative_dates_to_extraction(extraction, recording_created_at=created)
    assert out["job"]["scheduled_date"] == "2026-08-04"


def test_idempotency_payload_hash_stable() -> None:
    job = {"customer_name": "A", "project_name": "B", "scheduled_date": "2026-08-01"}
    assert payload_hash(job, "NJR-1") == payload_hash(dict(job), "NJR-1")
    assert payload_hash(job, "NJR-1") != payload_hash({**job, "notes": "x"}, "NJR-1")


def test_match_report_structure() -> None:
    report = build_match_report(
        {"customer_name": "Kat and James Dykes", "project_name": "", "assigned_staff_names": ["Alex"]},
        customers=[{"customer_id": "C1", "customer_name": "Kat and James Dykes"}],
        projects=[],
        staff=[{"staff_id": "S1", "staff_name": "Alex Technician"}],
    )
    assert report["customer"]["status"] == "Matched"
    assert report["project"]["status"] == "Unresolved"
    assert report["staff"][0]["status"] in {"Matched", "Possible match", "New value"}


@pytest.fixture()
def client(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> TestClient:
    monkeypatch.setenv("DATA_MODE", "mock")
    monkeypatch.setenv("JWT_SECRET", "test-secret")
    monkeypatch.setenv("LOCAL_RECORDINGS_DIR", str(tmp_path / "rec"))
    monkeypatch.setenv("NEW_JOB_DICTATIONS_DIR", str(tmp_path / "njr"))
    monkeypatch.setenv("AUTH_USERS_FILE", str(tmp_path / "auth.json"))
    monkeypatch.setenv("MOCK_DATA_DIR", str(tmp_path / "mock"))
    from app.core.config import get_settings

    get_settings.cache_clear()
    from app.main import app

    return TestClient(app)


def _manager_headers(client: TestClient) -> dict:
    login = client.post(
        "/api/v1/auth/login",
        json={"email": "manager@nativegrace.com", "password": "FieldOS-Manager-2026!"},
    )
    assert login.status_code == 200, login.text
    token = login.json()["access_token"]
    return {"Authorization": f"Bearer {token}"}


def _staff_headers(client: TestClient) -> dict:
    login = client.post(
        "/api/v1/auth/login",
        json={"email": "alex@nativegrace.com", "password": "FieldOS-Demo-2026!"},
    )
    assert login.status_code == 200, login.text
    return {"Authorization": f"Bearer {login.json()['access_token']}"}


def test_role_enforcement_staff_forbidden(client: TestClient) -> None:
    headers = _staff_headers(client)
    res = client.post(
        "/api/v1/jobs/from-recording/uploads",
        headers=headers,
        files={"file": ("a.webm", BytesIO(b"x" * 2048), "audio/webm")},
        data={"duration_seconds": "1"},
    )
    assert res.status_code == 403


def test_upload_process_create_idempotency(client: TestClient) -> None:
    headers = _manager_headers(client)
    up = client.post(
        "/api/v1/jobs/from-recording/uploads",
        headers=headers,
        files={"file": ("clip.webm", BytesIO(b"x" * 2048), "audio/webm")},
        data={"duration_seconds": "3"},
    )
    assert up.status_code == 200, up.text
    draft = up.json()["draft"]
    assert draft["status"] == "Uploaded"
    assert draft["source"] == "browser_recording"

    proc = client.post(
        f"/api/v1/jobs/from-recording/{draft['recording_id']}/process",
        headers=headers,
    )
    assert proc.status_code == 200, proc.text
    draft = proc.json()["draft"]
    assert draft["status"] == "ReviewRequired"
    assert draft["transcript"]
    assert "Kat and James" in (draft["extraction"]["job"]["customer_name"] or "")

    job_body = {
        "customer_name": "Kat and James Dykes",
        "customer_id": "CUST-6002C0A0",
        "project_name": "Kat and James Dykes",
        "project_id": "PROJ-6002C0A0",
        "job_title": "Inspect garden beds",
        "job_description": "Prepare a maintenance list",
        "scheduled_date": draft["extraction"]["job"]["scheduled_date"] or "2026-08-04",
        "assigned_staff_ids": ["STAFF-DEMO001"],
        "assigned_staff_names": ["Alex Technician"],
        "notes": "Check irrigation",
        "status": "Scheduled",
    }
    key = "idem-test-key-001234"
    created = client.post(
        "/api/v1/jobs/from-recording",
        headers=headers,
        json={
            "recording_id": draft["recording_id"],
            "expected_processing_version": draft["processing_version"],
            "job": job_body,
            "idempotency_key": key,
        },
    )
    assert created.status_code == 200, created.text
    job_id = created.json()["job"]["job_sheet_id"]
    assert job_id.startswith("JS-")
    assert created.json()["draft"]["status"] == "JobCreated"

    # Same key + same payload → idempotent
    again = client.post(
        "/api/v1/jobs/from-recording",
        headers=headers,
        json={
            "recording_id": draft["recording_id"],
            "expected_processing_version": draft["processing_version"],
            "job": job_body,
            "idempotency_key": key,
        },
    )
    assert again.status_code == 200
    assert again.json()["idempotent"] is True
    assert again.json()["job"]["job_sheet_id"] == job_id

    # Same key + changed payload → 409
    conflict = client.post(
        "/api/v1/jobs/from-recording",
        headers=headers,
        json={
            "recording_id": draft["recording_id"],
            "expected_processing_version": draft["processing_version"],
            "job": {**job_body, "notes": "changed"},
            "idempotency_key": key,
        },
    )
    assert conflict.status_code == 409


def test_upload_accepts_uploaded_file_source(client: TestClient) -> None:
    headers = _manager_headers(client)
    up = client.post(
        "/api/v1/jobs/from-recording/uploads",
        headers=headers,
        files={"file": ("site.mp3", BytesIO(b"z" * 2048), "audio/mpeg")},
        data={"duration_seconds": "0", "source": "uploaded_file"},
    )
    assert up.status_code == 200, up.text
    draft = up.json()["draft"]
    assert draft["source"] == "uploaded_file"
    assert draft["filename"]
    assert draft["mime_type"]


def test_create_requires_review_complete(client: TestClient) -> None:
    headers = _manager_headers(client)
    up = client.post(
        "/api/v1/jobs/from-recording/uploads",
        headers=headers,
        files={"file": ("clip.webm", BytesIO(b"y" * 2048), "audio/webm")},
        data={"duration_seconds": "1"},
    )
    draft = up.json()["draft"]
    res = client.post(
        "/api/v1/jobs/from-recording",
        headers=headers,
        json={
            "recording_id": draft["recording_id"],
            "expected_processing_version": 1,
            "job": {
                "customer_name": "X",
                "project_name": "Y",
                "job_title": "Z",
                "scheduled_date": "2026-08-04",
                "assigned_staff_ids": ["STAFF-DEMO001"],
            },
            "idempotency_key": "idem-early-create-0001",
        },
    )
    assert res.status_code == 409
